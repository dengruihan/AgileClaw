import { createHash } from "node:crypto";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { Page } from "playwright-core";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getPageForTargetId } from "../pw-session-connection.js";
import type { BrowserRouteContext } from "../server-context.js";
import { documentIdentity } from "../vault-fill-document.js";
import { clearVaultFillSession, registerVaultFillSecret } from "../vault-fill-scrub.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  withHumanControlRouteContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";
import {
  fillInputByBackendNode,
  isNavigationRaceError,
  resolveInputBackendNodeId,
} from "./vault-fill-cdp.js";

type ObservedOrigin = { scheme: "https" | "http"; host: string; port: number };

type FieldObservation = {
  passwordIndex: number;
  usernameIndex: number;
  passwordName: string;
  passwordAutocomplete: string;
  usernameName: string;
  usernameAutocomplete: string;
};

type VaultTargetObservation = {
  targetId: string;
  origin: ObservedOrigin;
  documentId: string;
  frameId: string;
  fieldSignature: string;
  fields: FieldObservation;
};

type ObserveResult =
  | { ok: true; observation: VaultTargetObservation }
  | { ok: false; status: "iframe_denied" | "needs_human"; reasonCode: string };

const MAX_PASSWORD_LENGTH = 4096;
const MAX_USERNAME_LENGTH = 512;
const FILL_ACTION_TIMEOUT_MS = 5_000;

export function readVaultOrigin(url: string): ObservedOrigin | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return undefined;
  }
  return {
    scheme: parsed.protocol === "https:" ? "https" : "http",
    host: parsed.hostname.toLowerCase().replace(/\.$/u, ""),
    port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
  };
}

/**
 * Reviewed page script. It reports only field shape and position, never values.
 * The function is serialized by Playwright, so it must stay self-contained.
 */
async function observeFields(page: Page): Promise<FieldObservation> {
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    const isVisible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none"
      );
    };
    const passwordIndex = inputs.findIndex(
      (input) => input.type === "password" && isVisible(input),
    );
    const usernamePattern = /user|email|login|account|identifier/i;
    const usernameIndex = inputs.findIndex(
      (input) =>
        (input.type === "text" || input.type === "email" || input.type === "tel") &&
        isVisible(input) &&
        (input.autocomplete === "username" ||
          usernamePattern.test(input.name) ||
          usernamePattern.test(input.id)),
    );
    const password = passwordIndex >= 0 ? inputs[passwordIndex] : undefined;
    const username = usernameIndex >= 0 ? inputs[usernameIndex] : undefined;
    return {
      passwordIndex,
      usernameIndex,
      passwordName: password?.name ?? "",
      passwordAutocomplete: password?.autocomplete ?? "",
      usernameName: username?.name ?? "",
      usernameAutocomplete: username?.autocomplete ?? "",
    };
  });
}

async function crossOriginPasswordFrameCount(page: Page, mainOrigin: string): Promise<number> {
  let count = 0;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) {
      continue;
    }
    let frameOrigin: string;
    try {
      frameOrigin = new URL(frame.url()).origin;
    } catch {
      continue;
    }
    if (frameOrigin === mainOrigin) {
      continue;
    }
    const passwordInputs = await frame
      .locator('input[type="password"]')
      .count()
      .catch(() => 0);
    if (passwordInputs > 0) {
      count += 1;
    }
  }
  return count;
}

function fieldSignature(observation: FieldObservation): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        observation.passwordIndex,
        observation.passwordName,
        observation.passwordAutocomplete,
        observation.usernameIndex,
        observation.usernameName,
        observation.usernameAutocomplete,
      ]),
    )
    .digest("hex");
}

async function observeVaultTarget(params: {
  cdpUrl: string;
  targetId: string;
  signal?: AbortSignal;
  ssrfPolicy?: SsrFPolicy;
}): Promise<ObserveResult> {
  const page = await getPageForTargetId({
    cdpUrl: params.cdpUrl,
    targetId: params.targetId,
    ...(params.ssrfPolicy ? { ssrfPolicy: params.ssrfPolicy } : {}),
  });
  params.signal?.throwIfAborted();
  const url = page.url();
  const origin = readVaultOrigin(url);
  if (!origin) {
    return { ok: false, status: "needs_human", reasonCode: "unsupported_page" };
  }
  const crossOriginPasswordFrames = await crossOriginPasswordFrameCount(page, new URL(url).origin);
  if (crossOriginPasswordFrames > 0) {
    return { ok: false, status: "iframe_denied", reasonCode: "cross_origin_iframe" };
  }
  const fields = await observeFields(page);
  if (fields.passwordIndex < 0) {
    return { ok: false, status: "needs_human", reasonCode: "no_password_field" };
  }
  const identity = await documentIdentity(page);
  if (!identity) {
    return { ok: false, status: "needs_human", reasonCode: "document_identity_unavailable" };
  }
  return {
    ok: true,
    observation: {
      targetId: params.targetId,
      origin,
      documentId: identity.documentId,
      frameId: identity.frameId,
      fieldSignature: fieldSignature(fields),
      fields,
    },
  };
}

function sameOrigin(left: ObservedOrigin, right: ObservedOrigin): boolean {
  return left.scheme === right.scheme && left.host === right.host && left.port === right.port;
}

function isLocalCdpUrl(cdpUrl: string): boolean {
  try {
    const parsed = new URL(cdpUrl);
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

function readExpectedOrigin(value: unknown): ObservedOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const scheme = record.scheme;
  const host = record.host;
  const port = record.port;
  if (
    (scheme !== "https" && scheme !== "http") ||
    typeof host !== "string" ||
    host.length === 0 ||
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    return undefined;
  }
  return { scheme, host: host.toLowerCase(), port };
}

export function registerBrowserVaultRoutes(
  app: BrowserRouteRegistrar,
  ctx: BrowserRouteContext,
): void {
  app.post("/vault/observe", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    await withHumanControlRouteContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, cdpUrl, tab, signal }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(
            res,
            501,
            "Password fill is not available for existing-session browser profiles; use a managed profile.",
          );
        }
        if (profileCtx.profile.driver === "extension") {
          return jsonError(
            res,
            501,
            "Password fill is not available for extension-relay browser profiles; use a managed profile.",
          );
        }
        if (!isLocalCdpUrl(profileCtx.profile.cdpUrl)) {
          res.json({
            ok: false,
            status: "needs_human",
            reasonCode: "remote_browser_unsupported",
          });
          return;
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const result = await observeVaultTarget({
          cdpUrl,
          targetId: tab.targetId,
          signal,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        if (!result.ok) {
          res.json({ ok: false, status: result.status, reasonCode: result.reasonCode });
          return;
        }
        res.json({ ok: true, ...result.observation });
      },
    });
  });

  app.post("/vault/identity", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    await withHumanControlRouteContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, cdpUrl, tab }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(
            res,
            501,
            "Password fill identity is not available for existing-session browser profiles; use a managed profile.",
          );
        }
        if (
          profileCtx.profile.driver === "extension" ||
          !isLocalCdpUrl(profileCtx.profile.cdpUrl)
        ) {
          res.json({ ok: false, reasonCode: "remote_browser_unsupported" });
          return;
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const page = await getPageForTargetId({
          cdpUrl,
          targetId: tab.targetId,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        const identity = await documentIdentity(page);
        const origin = readVaultOrigin(page.url());
        if (!identity || !origin) {
          res.json({ ok: false, reasonCode: "document_identity_unavailable" });
          return;
        }
        res.json({
          ok: true,
          targetId: tab.targetId,
          documentId: identity.documentId,
          frameId: identity.frameId,
          origin,
        });
      },
    });
  });

  app.post("/vault/fill", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const password = body.password;
    const username = typeof body.username === "string" ? body.username : undefined;
    const expected = body.expected;
    if (
      typeof password !== "string" ||
      password.length === 0 ||
      password.length > MAX_PASSWORD_LENGTH ||
      (username !== undefined && username.length > MAX_USERNAME_LENGTH) ||
      !expected ||
      typeof expected !== "object"
    ) {
      // Never echo the body: the request carries the fill material.
      return jsonError(res, 400, "Invalid password fill request.");
    }
    const expectedRecord = expected as Record<string, unknown>;
    const expectedOrigin = readExpectedOrigin(expectedRecord.origin);
    const expectedDocumentId = toStringOrEmpty(expectedRecord.documentId);
    const expectedFrameId = toStringOrEmpty(expectedRecord.frameId);
    const expectedFieldSignature = toStringOrEmpty(expectedRecord.fieldSignature);
    if (!expectedOrigin || !expectedDocumentId || !expectedFrameId || !expectedFieldSignature) {
      return jsonError(res, 400, "Invalid password fill request.");
    }
    await withHumanControlRouteContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, cdpUrl, tab, signal }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(
            res,
            501,
            "Password fill is not available for existing-session browser profiles; use a managed profile.",
          );
        }
        if (profileCtx.profile.driver === "extension") {
          return jsonError(
            res,
            501,
            "Password fill is not available for extension-relay browser profiles; use a managed profile.",
          );
        }
        if (!isLocalCdpUrl(profileCtx.profile.cdpUrl)) {
          res.json({
            ok: false,
            status: "needs_human",
            reasonCode: "remote_browser_unsupported",
          });
          return;
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const observeNow = () =>
          observeVaultTarget({
            cdpUrl,
            targetId: tab.targetId,
            signal,
            ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
          });
        const revalidate = async (): Promise<
          { ok: true } | { ok: false; status: string; reasonCode: string }
        > => {
          let current: Awaited<ReturnType<typeof observeVaultTarget>>;
          try {
            current = await observeNow();
          } catch {
            return {
              ok: false,
              status: "document_changed",
              reasonCode: "page_changed_after_approval",
            };
          }
          if (!current.ok) {
            return { ok: false, status: current.status, reasonCode: current.reasonCode };
          }
          const currentObservation = current.observation;
          if (
            !sameOrigin(currentObservation.origin, expectedOrigin) ||
            currentObservation.documentId !== expectedDocumentId ||
            currentObservation.frameId !== expectedFrameId ||
            currentObservation.fieldSignature !== expectedFieldSignature
          ) {
            return {
              ok: false,
              status: "document_changed",
              reasonCode: "page_changed_after_approval",
            };
          }
          return { ok: true };
        };
        const observed = await observeNow().catch(() => undefined);
        if (!observed) {
          res.json({ ok: false, status: "unavailable", reasonCode: "observe_failed" });
          return;
        }
        if (!observed.ok) {
          res.json({ ok: false, status: observed.status, reasonCode: observed.reasonCode });
          return;
        }
        const observation = observed.observation;
        if (
          !sameOrigin(observation.origin, expectedOrigin) ||
          observation.documentId !== expectedDocumentId ||
          observation.frameId !== expectedFrameId ||
          observation.fieldSignature !== expectedFieldSignature
        ) {
          res.json({
            ok: false,
            status: "document_changed",
            reasonCode: "page_changed_after_approval",
          });
          return;
        }
        const pageForFill = () =>
          getPageForTargetId({
            cdpUrl,
            targetId: tab.targetId,
            ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
          });
        // Arm masking before insertion so a transport failure, partial fill, or
        // timeout cannot leave plaintext in the DOM unprotected. Bind the
        // document id so a later navigation can prove replacement.
        registerVaultFillSecret(
          tab.targetId,
          password,
          observation.documentId,
          profileCtx.profile.name,
        );

        if (username !== undefined && observation.fields.usernameIndex >= 0) {
          const usernamePage = await pageForFill();
          try {
            await usernamePage
              .locator("input")
              .nth(observation.fields.usernameIndex)
              .fill(username, { timeout: FILL_ACTION_TIMEOUT_MS });
          } catch (error) {
            res.json(
              isNavigationRaceError(error)
                ? {
                    ok: false,
                    status: "document_changed",
                    reasonCode: "page_changed_after_approval",
                  }
                : { ok: false, status: "unavailable", reasonCode: "fill_failed" },
            );
            return;
          }
          // A username input event can start a navigation. Let the new document
          // settle before revalidating the approved origin/document/fields.
          await usernamePage
            .waitForLoadState("domcontentloaded", { timeout: 2_000 })
            .catch(() => undefined);
          const afterUsername = await revalidate();
          if (!afterUsername.ok) {
            res.json(afterUsername);
            return;
          }
        }

        const beforePassword = await revalidate();
        if (!beforePassword.ok) {
          res.json(beforePassword);
          return;
        }
        // Insert into the exact node of the approved document. A locator
        // re-resolves by index against whatever document is current, so a
        // delayed A->B navigation could put the password into origin B.
        const passwordPage = await pageForFill();
        let navigatedDuringFill = false;
        const onFrameNavigated = () => {
          navigatedDuringFill = true;
        };
        passwordPage.on("framenavigated", onFrameNavigated);
        try {
          const passwordBackendNodeId = await resolveInputBackendNodeId(
            passwordPage,
            observation.fields.passwordIndex,
            observation.documentId,
          );
          if (passwordBackendNodeId === undefined) {
            res.json({
              ok: false,
              status: "document_changed",
              reasonCode: "page_changed_after_approval",
            });
            return;
          }
          const fillResult = await fillInputByBackendNode(
            passwordPage,
            passwordBackendNodeId,
            password,
          );
          if (fillResult === "stale") {
            res.json({
              ok: false,
              status: "document_changed",
              reasonCode: "page_changed_after_approval",
            });
            return;
          }
          if (fillResult === "error") {
            res.json({ ok: false, status: "unavailable", reasonCode: "fill_failed" });
            return;
          }
          await passwordPage
            .waitForLoadState("domcontentloaded", { timeout: 2_000 })
            .catch(() => undefined);
        } finally {
          passwordPage.off("framenavigated", onFrameNavigated);
        }
        const afterPassword = await revalidate();
        if (!afterPassword.ok) {
          res.json(afterPassword);
          return;
        }
        if (navigatedDuringFill) {
          res.json({
            ok: false,
            status: "document_changed",
            reasonCode: "page_changed_during_fill",
          });
          return;
        }
        res.json({ ok: true, status: "filled", targetId: tab.targetId });
      },
    });
  });

  app.post("/vault/submit", async (req, res) => {
    const body = readBody(req);
    const targetId = toStringOrEmpty(body.targetId) || undefined;
    const expected = body.expected;
    if (!expected || typeof expected !== "object") {
      return jsonError(res, 400, "Invalid password submit request.");
    }
    const expectedRecord = expected as Record<string, unknown>;
    const expectedOrigin = readExpectedOrigin(expectedRecord.origin);
    const expectedDocumentId = toStringOrEmpty(expectedRecord.documentId);
    const expectedFrameId = toStringOrEmpty(expectedRecord.frameId);
    const expectedFieldSignature = toStringOrEmpty(expectedRecord.fieldSignature);
    if (!expectedOrigin || !expectedDocumentId || !expectedFrameId || !expectedFieldSignature) {
      return jsonError(res, 400, "Invalid password submit request.");
    }
    await withHumanControlRouteContext({
      req,
      res,
      ctx,
      targetId,
      enforceCurrentUrlAllowed: true,
      run: async ({ profileCtx, cdpUrl, tab, signal }) => {
        if (getBrowserProfileCapabilities(profileCtx.profile).usesChromeMcp) {
          return jsonError(
            res,
            501,
            "Password submit is not available for existing-session browser profiles; use a managed profile.",
          );
        }
        if (
          profileCtx.profile.driver === "extension" ||
          !isLocalCdpUrl(profileCtx.profile.cdpUrl)
        ) {
          res.json({
            ok: false,
            status: "needs_human",
            reasonCode: "remote_browser_unsupported",
          });
          return;
        }
        const navigationPolicy = browserNavigationPolicyForProfile(ctx, profileCtx);
        const observed = await observeVaultTarget({
          cdpUrl,
          targetId: tab.targetId,
          signal,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        if (!observed.ok) {
          res.json({ ok: false, status: observed.status, reasonCode: observed.reasonCode });
          return;
        }
        const observation = observed.observation;
        if (
          !sameOrigin(observation.origin, expectedOrigin) ||
          observation.documentId !== expectedDocumentId ||
          observation.frameId !== expectedFrameId ||
          observation.fieldSignature !== expectedFieldSignature
        ) {
          res.json({
            ok: false,
            status: "document_changed",
            reasonCode: "page_changed_after_approval",
          });
          return;
        }
        const page = await getPageForTargetId({
          cdpUrl,
          targetId: tab.targetId,
          ...(navigationPolicy.ssrfPolicy ? { ssrfPolicy: navigationPolicy.ssrfPolicy } : {}),
        });
        const passwordField = page.locator("input").nth(observation.fields.passwordIndex);
        try {
          await passwordField.press("Enter", { timeout: FILL_ACTION_TIMEOUT_MS });
        } catch {
          res.json({ ok: false, status: "unavailable", reasonCode: "submit_failed" });
          return;
        }
        if (page.isClosed()) {
          clearVaultFillSession(tab.targetId);
          res.json({ ok: true, status: "filled", targetId: tab.targetId });
          return;
        }
        // Best-effort clear; a disabled/read-only input may reject it. Never
        // treat that failure as a successful cleanup.
        await passwordField.fill("", { timeout: 1_000 }).catch(() => undefined);
        let retained: string | undefined;
        try {
          retained = await passwordField.inputValue();
        } catch {
          retained = undefined;
        }
        if (retained === "") {
          clearVaultFillSession(tab.targetId);
          res.json({ ok: true, status: "filled", targetId: tab.targetId });
          return;
        }
        // The field is not proven empty. Clear protection only when the browser
        // proves the approved document was replaced; if identity is unavailable
        // or unchanged, keep masking and all guards armed.
        const currentIdentity = await documentIdentity(page);
        if (currentIdentity && currentIdentity.documentId !== observation.documentId) {
          clearVaultFillSession(tab.targetId);
          res.json({ ok: true, status: "filled", targetId: tab.targetId });
          return;
        }
        res.json({
          ok: false,
          status: "needs_human",
          reasonCode: "password_clear_unverified",
        });
      },
    });
  });
}
