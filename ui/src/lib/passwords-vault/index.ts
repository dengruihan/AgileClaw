import type {
  VaultAuditEvent,
  VaultEntryMetadata,
  VaultStatus,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";

export type PasswordsVaultClientError = {
  message: string;
  vaultCode?: string;
  lockedUntilMs?: number;
};

/**
 * Localized hint for a known vault failure; unknown codes keep the raw diagnostic.
 * Literal `t()` calls keep the canonical key references visible to
 * `ui:i18n:verify`; `VAULT_ORIGIN_MISMATCH` belongs to the agent fill surface,
 * which the Passwords page never calls.
 */
export function passwordsVaultErrorHint(error: PasswordsVaultClientError): string | null {
  switch (error.vaultCode) {
    case "VAULT_WRONG_PASSPHRASE":
      return t("passwords.wrongPassphrase");
    case "VAULT_LOCKED_OUT":
      return error.lockedUntilMs === undefined
        ? t("passwords.lockedOut")
        : t("passwords.lockedOutUntil", {
            time: new Date(error.lockedUntilMs).toLocaleTimeString(),
          });
    case "VAULT_CORRUPTED":
      return t("passwords.corrupted");
    case "VAULT_CONFLICT":
      return t("passwords.conflict");
    case "VAULT_DUPLICATE":
      return t("passwords.duplicate");
    case "VAULT_REVEAL_SCOPE_REQUIRED":
      return t("passwords.revealScopeRequired");
    case "VAULT_LOCKED":
      return t("passwords.locked");
    case "VAULT_UNINITIALIZED":
      return t("passwords.uninitialized");
    case "VAULT_ALREADY_INITIALIZED":
      return t("passwords.alreadyInitialized");
    case "VAULT_NOT_FOUND":
      return t("passwords.notFound");
    case "VAULT_DELETED":
      return t("passwords.deletedEntry");
    case "VAULT_INVALID_INPUT":
      return t("passwords.invalidInput");
    case "VAULT_UNAVAILABLE":
      return t("passwords.unavailable");
    default:
      return null;
  }
}

export type PasswordsVaultState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  status: VaultStatus | null;
  entries: VaultEntryMetadata[];
  audit: VaultAuditEvent[];
  showDeleted: boolean;
  loaded: boolean;
  loading: boolean;
  busy: boolean;
  error: PasswordsVaultClientError | null;
};

export function createInitialPasswordsVaultState(
  snapshot: Partial<Pick<PasswordsVaultState, "client" | "connected">> = {},
): PasswordsVaultState {
  return {
    client: snapshot.client ?? null,
    connected: snapshot.connected ?? false,
    status: null,
    entries: [],
    audit: [],
    showDeleted: false,
    loaded: false,
    loading: false,
    busy: false,
    error: null,
  };
}

export function toPasswordsVaultError(error: unknown): PasswordsVaultClientError {
  const details = readErrorDetails(error);
  const vaultCode = typeof details?.code === "string" ? details.code : undefined;
  const lockedUntilMs =
    typeof details?.lockedUntilMs === "number" ? details.lockedUntilMs : undefined;
  return {
    message: formatUiError(error, t("passwords.requestFailed")),
    ...(vaultCode ? { vaultCode } : {}),
    ...(lockedUntilMs !== undefined ? { lockedUntilMs } : {}),
  };
}

function readErrorDetails(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return undefined;
  }
  const details = error.details;
  if (!details || typeof details !== "object") {
    return undefined;
  }
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    record[key] = value;
  }
  return record;
}

function isCurrent(state: PasswordsVaultState, client: GatewayBrowserClient): boolean {
  return state.client === client && state.connected;
}

export async function refreshPasswordsVault(
  state: PasswordsVaultState,
  onProgress?: () => void,
): Promise<boolean> {
  const client = state.client;
  if (!client || !state.connected || state.loading) {
    return false;
  }
  state.loading = true;
  state.error = null;
  try {
    const status = await client.request<VaultStatus>("vault.status", {});
    if (!isCurrent(state, client)) {
      return false;
    }
    state.status = status;
    onProgress?.();
    const listParams = state.showDeleted ? { includeDeleted: true } : {};
    const list = await client.request<{ entries: VaultEntryMetadata[] }>("vault.list", listParams);
    if (!isCurrent(state, client)) {
      return false;
    }
    state.entries = list.entries;
    onProgress?.();
    if (status.state === "unlocked") {
      const audit = await client.request<{ events: VaultAuditEvent[] }>("vault.audit.list", {
        limit: 25,
      });
      if (!isCurrent(state, client)) {
        return false;
      }
      state.audit = audit.events;
    } else {
      state.audit = [];
    }
    state.loaded = true;
    return true;
  } catch (error) {
    if (isCurrent(state, client)) {
      state.error = toPasswordsVaultError(error);
    }
    return false;
  } finally {
    if (isCurrent(state, client)) {
      state.loading = false;
    }
  }
}

export function addShowDeletedFlag(state: PasswordsVaultState, showDeleted: boolean): void {
  state.showDeleted = showDeleted;
}

async function runMutation<T>(
  state: PasswordsVaultState,
  mutate: (client: GatewayBrowserClient) => Promise<T>,
): Promise<T | null> {
  const client = state.client;
  if (!client || !state.connected || state.busy) {
    return null;
  }
  state.busy = true;
  state.error = null;
  try {
    return await mutate(client);
  } catch (error) {
    if (isCurrent(state, client)) {
      state.error = toPasswordsVaultError(error);
    }
    return null;
  } finally {
    if (isCurrent(state, client)) {
      state.busy = false;
    }
  }
}

export function initializePasswordsVault(
  state: PasswordsVaultState,
  passphrase: string,
  autoLockSeconds: number,
): Promise<VaultStatus | null> {
  return runMutation(state, (client) =>
    client.request<VaultStatus>("vault.initialize", { passphrase, autoLockSeconds }),
  );
}

export function unlockPasswordsVault(
  state: PasswordsVaultState,
  passphrase: string,
): Promise<VaultStatus | null> {
  return runMutation(state, (client) =>
    client.request<VaultStatus>("vault.unlock", { passphrase }),
  );
}

export function lockPasswordsVault(state: PasswordsVaultState): Promise<unknown> {
  return runMutation(state, (client) => client.request("vault.lock", {}));
}

export function setPasswordsAutoLock(
  state: PasswordsVaultState,
  autoLockSeconds: number,
): Promise<VaultStatus | null> {
  return runMutation(state, (client) =>
    client.request<VaultStatus>("vault.setAutoLock", { autoLockSeconds }),
  );
}

export type PasswordsEntryDraft = {
  itemRef?: string;
  revision?: number;
  originScheme: "https" | "http";
  originHost: string;
  originPort: number;
  siteLabel: string;
  account: string;
  label: string;
  password: string;
  notes?: string;
};

export function createPasswordsEntry(
  state: PasswordsVaultState,
  draft: PasswordsEntryDraft,
): Promise<VaultEntryMetadata | null> {
  return runMutation(state, (client) =>
    client
      .request<{ entry: VaultEntryMetadata }>("vault.create", {
        originScheme: draft.originScheme,
        originHost: draft.originHost,
        originPort: draft.originPort,
        siteLabel: draft.siteLabel,
        account: draft.account,
        ...(draft.label ? { label: draft.label } : {}),
        password: draft.password,
        ...(draft.notes !== undefined ? { notes: draft.notes } : {}),
      })
      .then((result) => result.entry),
  );
}

export function updatePasswordsEntry(
  state: PasswordsVaultState,
  draft: PasswordsEntryDraft & { itemRef: string; revision: number },
): Promise<VaultEntryMetadata | null> {
  return runMutation(state, (client) =>
    client
      .request<{ entry: VaultEntryMetadata }>("vault.update", {
        itemRef: draft.itemRef,
        revision: draft.revision,
        originScheme: draft.originScheme,
        originHost: draft.originHost,
        originPort: draft.originPort,
        siteLabel: draft.siteLabel,
        account: draft.account,
        ...(draft.label ? { label: draft.label } : {}),
        ...(draft.password ? { password: draft.password } : {}),
        ...(draft.notes !== undefined ? { notes: draft.notes } : {}),
      })
      .then((result) => result.entry),
  );
}

export function deletePasswordsEntry(
  state: PasswordsVaultState,
  entry: VaultEntryMetadata,
): Promise<unknown> {
  return runMutation(state, (client) =>
    client.request("vault.delete", { itemRef: entry.itemRef, revision: entry.revision }),
  );
}

export function restorePasswordsEntry(
  state: PasswordsVaultState,
  itemRef: string,
): Promise<unknown> {
  return runMutation(state, (client) => client.request("vault.restore", { itemRef }));
}

export function purgePasswordsEntry(state: PasswordsVaultState, itemRef: string): Promise<unknown> {
  return runMutation(state, (client) => client.request("vault.purge", { itemRef }));
}

export function revealPasswordsEntry(
  state: PasswordsVaultState,
  itemRef: string,
  mode: "reveal" | "copy",
): Promise<{ entry: VaultEntryMetadata; password: string; notes: string } | null> {
  return runMutation(state, (client) =>
    client.request<{ entry: VaultEntryMetadata; password: string; notes: string }>(
      mode === "copy" ? "vault.copy" : "vault.reveal",
      { itemRef },
    ),
  );
}

export function generatePasswordsEntry(state: PasswordsVaultState): Promise<string | null> {
  return runMutation(state, (client) =>
    client
      .request<{ password: string }>("vault.generate", { length: 20, includeSymbols: true })
      .then((result) => result.password),
  );
}
