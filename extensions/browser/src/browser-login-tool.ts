import { Type } from "typebox";
import { applyBrowserTabToolBinding, parseBrowserTabToolBinding } from "./browser-tool-binding.js";
import { resolveBrowserBaseUrl } from "./browser-tool.routing.js";
import type { AnyAgentTool } from "./browser-tool.runtime.js";
import {
  getRuntimeConfig,
  jsonResult,
  readStringParam,
  resolveBrowserConfig,
  resolveProfile,
} from "./browser-tool.runtime.js";
import { executeVaultAutofillAction } from "./browser-tool.vault-fill.js";

const BrowserLoginToolSchema = Type.Object(
  {
    itemRef: Type.String({
      minLength: 1,
      maxLength: 128,
      description: "Opaque password-vault entry reference.",
    }),
    reason: Type.Optional(
      Type.String({ maxLength: 300, description: "Why this saved login is needed." }),
    ),
    submit: Type.Optional(
      Type.Boolean({
        description: "Submit the form after fill; default false and shown in approval.",
      }),
    ),
    profile: Type.Optional(Type.String()),
    targetId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type BrowserLoginToolOptions = {
  sandboxBridgeUrl?: string;
  allowHostControl?: boolean;
  agentSessionKey?: string;
  agentId?: string;
  runToolBinding?: unknown;
};

/**
 * Separate from the general browser schema so the provider schema budget stays
 * intact. The model supplies only an opaque item reference; the tool observes
 * the current page origin, asks the operator for a one-time approval, and never
 * receives the password.
 */
export function createBrowserLoginTool(opts?: BrowserLoginToolOptions): AnyAgentTool {
  return {
    name: "browser_login",
    label: "Browser login",
    description:
      "Use one saved website login in the local managed browser without receiving the password. Each use needs operator approval; the origin is read from the browser. To store a new login, use vault_save_login instead.",
    parameters: BrowserLoginToolSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const raw = rawParams as Record<string, unknown>;
      let params = raw;
      if (opts?.runToolBinding !== undefined) {
        const parsed = parseBrowserTabToolBinding(opts.runToolBinding);
        if (!parsed.ok) {
          return jsonResult({ status: "needs_human", reasonCode: "invalid_tab_binding" });
        }
        if (parsed.binding.target !== "host") {
          return jsonResult({ status: "needs_human", reasonCode: "local_browser_required" });
        }
        try {
          params = applyBrowserTabToolBinding(raw, parsed.binding);
        } catch {
          return jsonResult({ status: "needs_human", reasonCode: "tab_binding_mismatch" });
        }
      }
      const itemRef = readStringParam(params, "itemRef", { required: true });
      const reason = readStringParam(params, "reason");
      const targetId = readStringParam(params, "targetId");
      const requestedProfile = readStringParam(params, "profile");
      const runtimeConfig = getRuntimeConfig();
      const resolvedBrowser = resolveBrowserConfig(runtimeConfig.browser, runtimeConfig);
      const profile = requestedProfile ?? resolvedBrowser.defaultProfile;
      if (!profile) {
        return jsonResult({ status: "needs_human", reasonCode: "profile_required" });
      }
      if (
        requestedProfile &&
        !resolveProfile(resolvedBrowser, requestedProfile) &&
        requestedProfile !== resolvedBrowser.defaultProfile
      ) {
        return jsonResult({ status: "needs_human", reasonCode: "unknown_profile" });
      }
      let baseUrl: string | undefined;
      try {
        baseUrl = resolveBrowserBaseUrl({
          target: "host",
          sandboxBridgeUrl: opts?.sandboxBridgeUrl,
          allowHostControl: opts?.allowHostControl,
        });
      } catch {
        return jsonResult({ status: "needs_human", reasonCode: "host_browser_unavailable" });
      }
      return await executeVaultAutofillAction({
        itemRef,
        ...(reason !== undefined ? { reason } : {}),
        submit: params.submit === true,
        targetId,
        baseUrl,
        profile,
        proxyRequest: null,
        signal,
        ...(opts?.agentId ? { agentId: opts.agentId } : {}),
        ...(opts?.agentSessionKey ? { agentSessionKey: opts.agentSessionKey } : {}),
      });
    },
  };
}
