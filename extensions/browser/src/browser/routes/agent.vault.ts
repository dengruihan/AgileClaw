import { createHash } from "node:crypto";
import type { SsrFPolicy } from "openclaw/plugin-sdk/security-runtime";
import type { Page } from "playwright-core";
import { getBrowserProfileCapabilities } from "../profile-capabilities.js";
import { getPageForTargetId } from "../pw-session-connection.js";
import type { BrowserRouteContext } from "../server-context.js";
import {
  browserNavigationPolicyForProfile,
  readBody,
  withRouteTabContext,
} from "./agent.shared.js";
import type { BrowserRouteRegistrar } from "./types.js";
import { jsonError, toStringOrEmpty } from "./utils.js";

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

function readOrigin(url: string): ObservedOrigin | undefined {
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

async function documentIdentity(page: Page): Promise<{ documentId: string; frameId: string }> {
  const mainFrame = page.mainFrame();
  try {
    const session = await page.context().newCDPSession(page);
    try {
      const tree = (await session.send("Page.getFrameTree")) as {
        frameTree?: { frame?: { id?: string; loaderId?: string; url?: string } };
      };
      const frame = tree.frameTree?.frame;
      if (frame?.id && frame.loaderId) {
        return { documentId: frame.loaderId, frameId: frame.id };
      }
    } finally {
      await session.detach().catch(() => undefined);
    }
  } catch {
    // CDP document identity is preferred; a stable frame-scoped fallback keeps
    // the lease closed rather than widening it.
  }
  return {
    documentId: `frame:${createHash("sha256").update(mainFrame.url()).digest("hex")}`,
    frameId: mainFrame.name() || "main",
  };
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
  const origin = readOrigin(url);
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
    await withRouteTabContext({
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
    await withRouteTabContext({
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
        const inputs = page.locator("input");
        try {
          if (username !== undefined && observation.fields.usernameIndex >= 0) {
            await inputs.nth(observation.fields.usernameIndex).fill(username);
          }
          const passwordField = inputs.nth(observation.fields.passwordIndex);
          await passwordField.fill(password);
        } catch {
          // Browser errors can echo typed values; keep the error value-free.
          res.json({ ok: false, status: "unavailable", reasonCode: "fill_failed" });
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
    await withRouteTabContext({
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
        try {
          await page.locator("input").nth(observation.fields.passwordIndex).press("Enter");
        } catch {
          res.json({ ok: false, status: "unavailable", reasonCode: "submit_failed" });
          return;
        }
        res.json({ ok: true, status: "filled", targetId: tab.targetId });
      },
    });
  });
}
