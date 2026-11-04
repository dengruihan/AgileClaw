import { randomUUID } from "node:crypto";
import type { VaultFillOrigin } from "../../vault/vault-fill-types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type VaultFillBrowserExecutorInput = {
  targetId: string;
  profile: string;
  origin: VaultFillOrigin;
  documentId: string;
  frameId: string;
  fieldSignature: string;
  password: string;
  username?: string;
};

export type VaultFillBrowserExecutorResult =
  | { ok: true; status: "filled" }
  | { ok: false; status: string; reasonCode?: string };

export type VaultFillBrowserExecutor = (
  input: VaultFillBrowserExecutorInput,
) => Promise<VaultFillBrowserExecutorResult>;

/**
 * Dedicated trusted in-process capability: the vault handler invokes the
 * browser plugin's `browser.request` handler directly. The password is never
 * serialized into a Gateway response, WebSocket frame, or generic client path.
 */
export function createInProcessBrowserFillExecutor(
  options: Pick<
    GatewayRequestHandlerOptions,
    "context" | "client" | "isWebchatConnect" | "signal" | "hasCurrentClientAuthority"
  >,
): VaultFillBrowserExecutor | undefined {
  const handler = options.context.getGatewayMethodRegistry?.().getHandler("browser.request");
  if (!handler) {
    return undefined;
  }
  // The registry intentionally erases handler options to keep the generic
  // dispatch boundary opaque; this trusted in-process caller supplies the
  // concrete request shape.
  const dispatchBrowserRequest = handler as (
    opts: GatewayRequestHandlerOptions,
  ) => Promise<void> | void;
  return async (input) => {
    let outcome: { ok: boolean; payload?: unknown } | undefined;
    try {
      await dispatchBrowserRequest({
        req: { type: "req", id: `vault-fill-${randomUUID()}`, method: "browser.request" },
        params: {
          target: "host",
          query: { profile: input.profile },
          method: "POST",
          path: "/vault/fill",
          timeoutMs: 15_000,
          body: {
            targetId: input.targetId,
            password: input.password,
            ...(input.username !== undefined ? { username: input.username } : {}),
            expected: {
              origin: input.origin,
              documentId: input.documentId,
              frameId: input.frameId,
              fieldSignature: input.fieldSignature,
            },
          },
        },
        client: options.client,
        isWebchatConnect: options.isWebchatConnect,
        respond: (ok: boolean, payload?: unknown) => {
          outcome = { ok, payload };
        },
        context: options.context,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: options.hasCurrentClientAuthority }
          : {}),
      });
    } catch {
      return { ok: false, status: "unavailable", reasonCode: "browser_fill_failed" };
    }
    if (!outcome?.ok) {
      return { ok: false, status: "unavailable", reasonCode: "browser_fill_failed" };
    }
    const payload = outcome.payload;
    if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      if (record.ok === true && record.status === "filled") {
        return { ok: true, status: "filled" };
      }
      return {
        ok: false,
        status: typeof record.status === "string" ? record.status : "unavailable",
        ...(typeof record.reasonCode === "string" ? { reasonCode: record.reasonCode } : {}),
      };
    }
    return { ok: false, status: "unavailable", reasonCode: "browser_fill_invalid_response" };
  };
}
