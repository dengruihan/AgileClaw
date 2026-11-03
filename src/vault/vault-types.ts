export const VAULT_OWNER_KIND = "profile" as const;
export const VAULT_DEFAULT_OWNER_ID = "local" as const;
export const VAULT_SOFT_DELETE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const VAULT_DEFAULT_AUTO_LOCK_SECONDS = 300;
export const VAULT_MIN_AUTO_LOCK_SECONDS = 15;
export const VAULT_MAX_AUTO_LOCK_SECONDS = 24 * 60 * 60;
export const VAULT_MAX_FAILED_ATTEMPTS_BEFORE_BACKOFF = 5;
export const VAULT_PASSPHRASE_MIN_LENGTH = 8;
export const VAULT_PASSPHRASE_MAX_LENGTH = 1024;
export const VAULT_PASSWORD_MAX_BYTES = 4096;
export const VAULT_NOTES_MAX_BYTES = 64 * 1024;
export const VAULT_SITE_LABEL_MAX_LENGTH = 256;
export const VAULT_ACCOUNT_MAX_LENGTH = 512;
export const VAULT_LABEL_MAX_LENGTH = 256;

export type VaultOwner = {
  kind: typeof VAULT_OWNER_KIND;
  id: string;
};

export type VaultOrigin = {
  scheme: "https" | "http";
  host: string;
  port: number;
};

export type VaultEntryMetadata = {
  itemRef: string;
  originScheme: "https" | "http";
  originHost: string;
  originPort: number;
  siteLabel: string;
  account: string;
  label?: string;
  hasNotes: boolean;
  revision: number;
  passwordUpdatedAtMs?: number;
  lastUsedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
  deletedAtMs?: number;
};

export type VaultEntryCreateInput = {
  originScheme: "https" | "http";
  originHost: string;
  originPort: number;
  siteLabel: string;
  account: string;
  label?: string;
  password: string;
  notes?: string;
};

export type VaultEntryUpdateInput = {
  itemRef: string;
  revision: number;
  originScheme: "https" | "http";
  originHost: string;
  originPort: number;
  siteLabel: string;
  account: string;
  label?: string;
  password?: string;
  notes?: string;
};

export type VaultStatus = {
  initialized: boolean;
  state: "uninitialized" | "locked" | "unlocked" | "corrupted";
  autoLockSeconds: number;
  failedAttempts: number;
  lockedUntilMs?: number;
  itemCount: number;
  deletedCount: number;
};

export type VaultAuditAction =
  | "initialize"
  | "unlock"
  | "unlock-failed"
  | "lock"
  | "create"
  | "update"
  | "delete"
  | "restore"
  | "purge"
  | "reveal"
  | "copy"
  | "generate"
  | "purge-expired";

export type VaultAuditStatus = "succeeded" | "failed" | "blocked";

export type VaultAuditEvent = {
  sequence: number;
  action: VaultAuditAction;
  status: VaultAuditStatus;
  itemRef?: string;
  reasonCode?: string;
  occurredAtMs: number;
};

export type VaultErrorCode =
  | "VAULT_UNINITIALIZED"
  | "VAULT_ALREADY_INITIALIZED"
  | "VAULT_LOCKED"
  | "VAULT_LOCKED_OUT"
  | "VAULT_WRONG_PASSPHRASE"
  | "VAULT_CORRUPTED"
  | "VAULT_NOT_FOUND"
  | "VAULT_DELETED"
  | "VAULT_CONFLICT"
  | "VAULT_DUPLICATE"
  | "VAULT_INVALID_INPUT"
  | "VAULT_UNAVAILABLE";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: VaultErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "VaultError";
    this.code = code;
    this.details = details;
  }
}

export function vaultErrorFromUnknown(error: unknown): VaultError {
  if (error instanceof VaultError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "vault operation failed";
  if (message.includes("UNIQUE constraint failed")) {
    return new VaultError("VAULT_DUPLICATE", "An entry for this site and account already exists.");
  }
  return new VaultError("VAULT_UNAVAILABLE", "The password vault is unavailable.");
}
