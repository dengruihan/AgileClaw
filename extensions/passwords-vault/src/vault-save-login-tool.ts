import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";
import {
  formatVaultSiteOrigin,
  parseVaultSiteParam,
  type ParsedVaultSite,
} from "./vault-save-login-site.js";

const SAVE_TIMEOUT_MS = 30_000;

const VaultSaveLoginToolSchema = Type.Object(
  {
    site: Type.String({
      minLength: 1,
      maxLength: 2048,
      description:
        "Required website origin: a full URL like https://example.com (path and query ignored) or a bare host like example.com.",
    }),
    account: Type.Optional(
      Type.String({
        maxLength: 512,
        description:
          "Username or email for this site. Optional: leave blank to save it empty for the user to fill in later.",
      }),
    ),
    password: Type.Optional(
      Type.String({
        maxLength: 4096,
        description:
          "Password for this site. Optional: leave blank to save it empty for the user to fill in later.",
      }),
    ),
    notes: Type.Optional(
      Type.String({ maxLength: 64 * 1024, description: "Free-form note attached to the entry." }),
    ),
    label: Type.Optional(
      Type.String({
        maxLength: 256,
        description: "Display name for the entry. Defaults to the site host.",
      }),
    ),
  },
  { additionalProperties: false },
);

type SavedEntry = {
  itemRef: string;
  siteLabel: string;
  account: string;
};

/**
 * Reads the vault's error payload without ever echoing password or notes.
 * `details.code` carries the VaultError code the Gateway handler mapped.
 */
function readVaultErrorDetails(error: unknown): {
  code?: string;
  message?: string;
  existingItemRef?: string;
} {
  const details = (error as { details?: unknown } | null | undefined)?.details;
  if (!details || typeof details !== "object") {
    return {};
  }
  const record = details as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
    ...(typeof record.existingItemRef === "string"
      ? { existingItemRef: record.existingItemRef }
      : {}),
  };
}

function mapSaveError(error: unknown, site: ParsedVaultSite): AgentToolResult<unknown> {
  const details = readVaultErrorDetails(error);
  const origin = formatVaultSiteOrigin(site);
  switch (details.code) {
    case "VAULT_DUPLICATE":
      return jsonResult({
        status: "duplicate",
        origin,
        ...(details.existingItemRef ? { existingItemRef: details.existingItemRef } : {}),
        message: "An entry for this site and account already exists.",
      });
    case "VAULT_INVALID_INPUT":
      return jsonResult({
        status: "invalid_input",
        origin,
        message: details.message ?? "The vault rejected this entry.",
      });
    case "VAULT_UNINITIALIZED":
      return jsonResult({
        status: "vault_uninitialized",
        origin,
        message:
          "The password vault is not set up yet; ask the user to create it in Settings → Passwords.",
      });
    case "VAULT_WRITE_KEY_UNAVAILABLE":
      return jsonResult({
        status: "setup_required",
        origin,
        message:
          "Agent saves while locked need one unlock first: ask the user to unlock the vault once.",
      });
    default:
      return jsonResult({ status: "unavailable", origin, reasonCode: "vault_save_failed" });
  }
}

/**
 * Agent-facing save into the built-in personal password vault. The site is
 * required; blank fields are stored blank for the operator to complete in
 * Settings → Passwords. No approval flow runs, the tool cannot list, reveal,
 * update, or delete entries, and its result never contains the password or
 * notes.
 */
export function createVaultSaveLoginTool(): AnyAgentTool {
  return {
    name: "vault_save_login",
    label: "Save vault login",
    description:
      "Save a website login into this user's built-in personal password vault (Settings → Passwords). No approval is needed. `site` is required and accepts a URL or bare host; account, password, notes, and label are optional — leave a field blank to save it empty for the user to fill in later. Saving works even while the vault is locked; the user can read the values after the next unlock. This tool never returns the saved password and cannot list, reveal, update, or delete entries. Use browser_login later to fill a saved login.",
    parameters: VaultSaveLoginToolSchema,
    execute: async (_toolCallId, rawParams, signal) => {
      const params = rawParams as Record<string, unknown>;
      // A missing site surfaces as the runtime's standard input error.
      const siteParam = readStringParam(params, "site", { required: true });
      const site = parseVaultSiteParam(siteParam);
      if (!site) {
        return jsonResult({
          status: "invalid_input",
          message: "site must be an http(s) URL or host, without credentials.",
        });
      }
      const account = readStringParam(params, "account");
      const password = readStringParam(params, "password");
      const notes = readStringParam(params, "notes");
      const label = readStringParam(params, "label");
      const emptyFields = [
        ...(account === undefined || account.trim().length === 0 ? ["account"] : []),
        ...(password === undefined || password.length === 0 ? ["password"] : []),
        ...(notes === undefined || notes.trim().length === 0 ? ["notes"] : []),
      ];
      let entry: SavedEntry;
      try {
        const result = await callGatewayTool<{ entry: SavedEntry }>(
          "vault.saveLogin",
          { timeoutMs: SAVE_TIMEOUT_MS },
          {
            originScheme: site.originScheme,
            originHost: site.originHost,
            originPort: site.originPort,
            ...(label !== undefined && label.length > 0 ? { label } : {}),
            ...(account !== undefined ? { account } : {}),
            ...(password !== undefined ? { password } : {}),
            ...(notes !== undefined ? { notes } : {}),
          },
          {
            scopes: ["operator.vault"],
            requireAgentRuntimeIdentity: true,
            signal,
          },
        );
        entry = result.entry;
      } catch (error) {
        return mapSaveError(error, site);
      }
      return jsonResult({
        status: "saved",
        itemRef: entry.itemRef,
        siteLabel: entry.siteLabel,
        origin: formatVaultSiteOrigin(site),
        account: entry.account,
        ...(emptyFields.length > 0
          ? {
              emptyFields,
              message:
                "Saved with blank fields; the user can complete them later in Settings → Passwords.",
            }
          : {}),
      });
    },
  };
}
