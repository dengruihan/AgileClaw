/**
 * Human takeover routes.
 *
 * These routes own the tab-scoped control lease, the revalidated handback, and
 * the sensitive-input channel that keeps manually typed passwords and codes out
 * of agent-visible requests, tool results, transcripts, and logs.
 */
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import type { ResolvedBrowserProfile } from "../config.js";
import {
  humanControlLeaseKey,
  humanControlRegistry,
  readHumanControlToken,
  type HumanControlOrigin,
  type HumanControlSnapshot,
} from "../human-control.js";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getPageForTargetId } from "../pw-session-connection.js";
import type { BrowserRouteContext } from "../server-context.js";
import { documentIdentity } from "../vault-fill-document.js";
import {
  clearVaultFillSessionIfDocumentChanged,
  registerVaultFillSecret,
} from "../vault-fill-scrub.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  withRouteTabContext,
} from "./agent.shared.js";
import { readVaultOrigin } from "./agent.vault.js";
import type { BrowserRequest, BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

const MAX_HUMAN_INPUT_BYTES = 4096;
const HUMAN_CONTROL_REASONS = new Set([
  "agent_needs_human",
  "captcha",
  "two_factor",
  "login_challenge",
  "human_control",
  "user_request",
]);

export function supportsHumanControl(profile: ResolvedBrowserProfile): boolean {
  if (getBrowserProfileCapabilities(profile).usesChromeMcp) {
    return false;
  }
  if (profile.driver === "extension") {
    return false;
  }
  try {
    const parsed = new URL(profile.cdpUrl);
    return (
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1" ||
      parsed.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

function unsupported(res: Parameters<typeof jsonError>[0]): void {
  res.status(501).json({
    error:
      "Human takeover is available only for a local managed browser profile; remote, extension-relay, and existing-session profiles stay out of this trust boundary.",
    code: "HUMAN_CONTROL_UNSUPPORTED",
  });
}

function leaseTarget(tab: { targetId: string; tabId?: string }) {
  return { targetId: tab.targetId, ...(tab.tabId ? { tabId: tab.tabId } : {}) };
}

function sameOrigin(
  left: HumanControlOrigin | undefined,
  right: HumanControlOrigin | undefined,
): boolean {
  return (
    Boolean(left && right) &&
    left!.scheme === right!.scheme &&
    left!.host === right!.host &&
    left!.port === right!.port
  );
}

/** Cookie names and scope, never values, provide a coarse login-state fingerprint. */
async function loginStateFingerprint(
  page: Page,
  origin: HumanControlOrigin,
): Promise<string | undefined> {
  try {
    const cookies = await page.context().cookies();
    const scoped = cookies
      .filter((cookie) => {
        const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
        return domain === origin.host || origin.host.endsWith(`.${domain}`);
      })
      .map((cookie) => `${cookie.name}|${cookie.domain}|${cookie.path}|${cookie.expires}`)
      .toSorted();
    return createHash("sha256").update(JSON.stringify(scoped)).digest("hex");
  } catch {
    return undefined;
  }
}

async function currentDocument(page: Page) {
  const identity = await documentIdentity(page);
  const origin = readVaultOrigin(page.url());
  const cookieFingerprint = origin ? await loginStateFingerprint(page, origin) : undefined;
  return { identity, origin, cookieFingerprint, url: page.url() };
}

function controlJson(control: HumanControlSnapshot | null) {
  return control ? { ...control } : null;
}

function rejectControl(
  res: Parameters<typeof jsonError>[0],
  status: number,
  code: string,
  message: string,
  control: HumanControlSnapshot | null,
): void {
  res.status(status).json({ error: message, code, control: controlJson(control) });
}

/** Wire one Gateway connection's lease cleanup exactly once. */
const wiredSignals = new WeakSet<AbortSignal>();
function wireConnectionCleanup(req: BrowserRequest, connId: string | undefined): void {
  const signal = req.requester?.signal;
  if (!connId || !signal || signal.aborted || wiredSignals.has(signal)) {
    return;
  }
  wiredSignals.add(signal);
  signal.addEventListener(
    "abort",
    () => {
      humanControlRegistry.revokeConnection(connId);
    },
    { once: true },
  );
}

function parseReason(value: unknown): string {
  const reason = toStringOrEmpty(value);
  return HUMAN_CONTROL_REASONS.has(reason) ? reason : "agent_needs_human";
}

export function registerBrowserHumanControlRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
): void {
  app.get("/human-control", async (req, res) => {
    const targetId = toStringOrEmpty(req.query.targetId) || undefined;
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      humanControl: "allow",
      run: async ({ profileCtx, tab }) => {
        const control = humanControlRegistry.status({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
        });
        res.json({
          ok: true,
          targetId: tab.targetId,
          ...(tab.tabId ? { tabId: tab.tabId } : {}),
          supported: supportsHumanControl(profileCtx.profile),
          control: controlJson(control),
        });
      },
    });
  });

  app.post("/human-control/request", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const reason = parseReason(body.reason);
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      humanControl: "allow",
      run: async ({ profileCtx, tab, cdpUrl, signal }) => {
        if (!supportsHumanControl(profileCtx.profile)) {
          return unsupported(res);
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const page = await getPageForTargetId({
          cdpUrl,
          targetId: tab.targetId,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        signal.throwIfAborted();
        const current = await currentDocument(page);
        const result = humanControlRegistry.claim({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
          reason,
          requestedBy: "agent",
          ...(current.origin ? { origin: current.origin } : {}),
          ...(current.identity ? { documentId: current.identity.documentId } : {}),
          ...(current.cookieFingerprint ? { cookieFingerprint: current.cookieFingerprint } : {}),
        });
        // Never return a token here: an agent request only pauses the tab.
        res.json({
          ok: true,
          targetId: tab.targetId,
          ...(tab.tabId ? { tabId: tab.tabId } : {}),
          control: controlJson(result.control),
        });
      },
    });
  });

  app.post("/human-control/claim", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const reason = parseReason(body.reason ?? "user_request");
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      humanControl: "allow",
      run: async ({ profileCtx, tab, cdpUrl, signal }) => {
        if (!supportsHumanControl(profileCtx.profile)) {
          return unsupported(res);
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const page = await getPageForTargetId({
          cdpUrl,
          targetId: tab.targetId,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        signal.throwIfAborted();
        const current = await currentDocument(page);
        // The page/document/cookie reads can outlive the request. Recheck live
        // authority synchronously before any abort listener or lease is created;
        // an already-fired abort cannot be replayed by adding a listener later.
        if (
          req.signal?.aborted ||
          req.requester?.signal.aborted ||
          req.requester?.isCurrent() === false
        ) {
          res.status(409).json({
            error: "The Gateway connection that requested human takeover has ended.",
            code: "HUMAN_CONTROL_REQUESTER_GONE",
          });
          return;
        }
        const connId = req.requester?.connId;
        wireConnectionCleanup(req, connId);
        const result = humanControlRegistry.claim({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
          reason,
          requestedBy: "human",
          ...(connId ? { connId } : {}),
          ...(current.origin ? { origin: current.origin } : {}),
          ...(current.identity ? { documentId: current.identity.documentId } : {}),
          ...(current.cookieFingerprint ? { cookieFingerprint: current.cookieFingerprint } : {}),
        });
        res.json({
          ok: true,
          targetId: tab.targetId,
          ...(tab.tabId ? { tabId: tab.tabId } : {}),
          control: controlJson(result.control),
          humanControlToken: result.token,
        });
      },
    });
  });

  app.post("/human-control/release", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const token = readHumanControlToken(body) ?? "";
    if (!token) {
      return rejectControl(
        res,
        409,
        "HUMAN_CONTROL_TOKEN_REQUIRED",
        "Human control token required.",
        null,
      );
    }
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      humanControl: "allow",
      run: async ({ profileCtx, tab, cdpUrl, signal }) => {
        if (!supportsHumanControl(profileCtx.profile)) {
          return unsupported(res);
        }
        const key = humanControlLeaseKey({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
        });
        const baseline = humanControlRegistry.baseline({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
        });
        if (!baseline || baseline.control.status !== "active") {
          return rejectControl(
            res,
            409,
            "HUMAN_CONTROL_NOT_ACTIVE",
            "No active human control lease matches this tab.",
            baseline?.control ?? null,
          );
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const page = await getPageForTargetId({
          cdpUrl,
          targetId: tab.targetId,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        signal.throwIfAborted();
        const current = await currentDocument(page);
        if (!current.identity || !current.origin) {
          return rejectControl(
            res,
            409,
            "HUMAN_CONTROL_REVALIDATION_FAILED",
            "The current document could not be revalidated; human control stays active. Retry, or cancel the takeover.",
            baseline.control,
          );
        }
        if (!baseline.origin || !baseline.documentId) {
          res.status(409).json({
            error:
              "The claim-time document or origin could not be verified; human control stays active. Retry with a fresh takeover, or cancel it.",
            code: "HUMAN_CONTROL_REVALIDATION_FAILED",
            reasonCode: "baseline_unavailable",
            control: controlJson(baseline.control),
          });
          return;
        }
        if (!baseline.cookieFingerprint || !current.cookieFingerprint) {
          // Login state is part of the handback contract. A missing before or
          // after fingerprint is uncertain, never a clean revalidation.
          res.status(409).json({
            error:
              "Login state could not be verified; human control stays active. Retry, or cancel the takeover.",
            code: "HUMAN_CONTROL_REVALIDATION_FAILED",
            reasonCode: "login_state_unavailable",
            control: controlJson(baseline.control),
          });
          return;
        }
        // Authorize before mutating so a wrong token cannot release another
        // connection's lease during this revalidation window.
        const authorized = humanControlRegistry.authorizeHuman({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
          token,
          origin: current.origin,
          documentId: current.identity.documentId,
          ...(current.cookieFingerprint ? { cookieFingerprint: current.cookieFingerprint } : {}),
        });
        if (!authorized) {
          return rejectControl(
            res,
            409,
            "HUMAN_CONTROL_TOKEN_REJECTED",
            "Human control token was rejected.",
            humanControlRegistry.status({
              profile: profileCtx.profile.name,
              ...leaseTarget(tab),
            }),
          );
        }
        const released = humanControlRegistry.release({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
          token,
        });
        if (!released) {
          return rejectControl(
            res,
            409,
            "HUMAN_CONTROL_RELEASE_RACED",
            "Human control changed.",
            null,
          );
        }
        if (baseline.documentId && baseline.documentId !== current.identity.documentId) {
          clearVaultFillSessionIfDocumentChanged(tab.targetId, current.identity.documentId);
        }
        res.json({
          ok: true,
          targetId: tab.targetId,
          ...(tab.tabId ? { tabId: tab.tabId } : {}),
          control: null,
          key,
          handback: {
            url: current.url,
            origin: current.origin,
            documentId: current.identity.documentId,
            originChanged: !sameOrigin(baseline.origin, current.origin),
            loginStateChanged: baseline.cookieFingerprint !== current.cookieFingerprint,
            revalidated: true,
          } satisfies {
            url: string;
            origin: HumanControlOrigin;
            documentId: string;
            originChanged: boolean;
            loginStateChanged: boolean;
            revalidated: true;
          },
        });
      },
    });
  });

  app.post("/human-control/cancel", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const token = readHumanControlToken(body) ?? "";
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      humanControl: "allow",
      run: async ({ profileCtx, tab }) => {
        const released = token
          ? humanControlRegistry.release({
              profile: profileCtx.profile.name,
              ...leaseTarget(tab),
              token,
            })
          : null;
        if (!released) {
          return rejectControl(
            res,
            409,
            "HUMAN_CONTROL_TOKEN_REJECTED",
            "Human control token was rejected.",
            humanControlRegistry.status({
              profile: profileCtx.profile.name,
              ...leaseTarget(tab),
            }),
          );
        }
        res.json({
          ok: true,
          targetId: tab.targetId,
          ...(tab.tabId ? { tabId: tab.tabId } : {}),
          control: null,
          cancelled: true,
        });
      },
    });
  });

  /** Sensitive manual input: the only route that accepts a human-typed secret. */
  app.post("/human-input", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const token = readHumanControlToken(body) ?? "";
    const text = body.text;
    if (
      !token ||
      typeof text !== "string" ||
      text.length === 0 ||
      Buffer.byteLength(text, "utf8") > MAX_HUMAN_INPUT_BYTES
    ) {
      // Never echo the request: it carries the secret.
      return jsonError(res, 400, "Invalid sensitive input request.");
    }
    await withRouteTabContext({
      req,
      res,
      ctx,
      targetId,
      humanControl: "allow",
      enforceCurrentUrlAllowed: false,
      run: async ({ profileCtx, tab, cdpUrl, signal, assertCurrent }) => {
        if (!supportsHumanControl(profileCtx.profile)) {
          return unsupported(res);
        }
        const requesterCurrent = () =>
          !req.signal?.aborted &&
          !req.requester?.signal.aborted &&
          req.requester?.isCurrent() !== false;
        const authorized = humanControlRegistry.authorizeHuman({
          profile: profileCtx.profile.name,
          ...leaseTarget(tab),
          token,
        });
        if (!authorized) {
          return rejectControl(
            res,
            409,
            "HUMAN_CONTROL_TOKEN_REJECTED",
            "Human control token was rejected.",
            humanControlRegistry.status({
              profile: profileCtx.profile.name,
              ...leaseTarget(tab),
            }),
          );
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        let inserted = false;
        try {
          const page = await getPageForTargetId({
            cdpUrl,
            targetId: tab.targetId,
            ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
          });
          signal.throwIfAborted();
          const identity = await documentIdentity(page);
          const origin = readVaultOrigin(page.url());
          const focused = await page.evaluate(() => {
            const active = document.activeElement;
            if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
              return !active.disabled && !active.readOnly;
            }
            return active instanceof HTMLElement && active.isContentEditable;
          });
          if (!focused) {
            res.json({ ok: false, reasonCode: "no_focused_field" });
            return;
          }
          // The page, document, and focus reads can yield long enough for a
          // disconnect, expiry, cancel, or competing re-claim. Revalidate live
          // authority synchronously after the final await and immediately
          // before the side effect.
          await assertCurrent?.();
          const reauthorized = humanControlRegistry.authorizeHuman({
            profile: profileCtx.profile.name,
            ...leaseTarget(tab),
            token,
            ...(origin ? { origin } : {}),
            ...(identity ? { documentId: identity.documentId } : {}),
          });
          if (!reauthorized || !requesterCurrent()) {
            res.status(409).json({
              ok: false,
              reasonCode: "human_control_revoked",
              control: humanControlRegistry.status({
                profile: profileCtx.profile.name,
                ...leaseTarget(tab),
              }),
            });
            return;
          }
          // Arm read masking before insertion. The scrub registry keeps the
          // value in process memory only to mask tool/UI results, and drops it
          // when the document is replaced or the tab closes.
          registerVaultFillSecret(
            tab.targetId,
            text,
            identity?.documentId,
            profileCtx.profile.name,
          );
          await page.keyboard.insertText(text);
          inserted = true;
          res.json({
            ok: true,
            targetId: tab.targetId,
            ...(identity ? { documentId: identity.documentId } : {}),
          });
        } catch {
          // Deliberately opaque: a transport error can echo request data.
          res.json({
            ok: false,
            reasonCode: inserted ? "input_may_have_failed" : "sensitive_input_failed",
          });
        }
      },
    });
  });
}
