/**
 * Agent fill contracts.
 *
 * The model may name an opaque `itemRef` and the browser tool supplies the
 * origin it observed from the local browser. Passwords never appear in these
 * types: only the broker's internal material handle carries a value, and that
 * handle is consumed by the trusted fill executor.
 */

export const VAULT_FILL_PREVIEW_TTL_MS = 120_000;
export const VAULT_FILL_APPROVAL_TTL_MS = 120_000;
export const VAULT_FILL_LEASE_TTL_MS = 30_000;
export const VAULT_FILL_MAX_FIELD_SIGNATURE_LENGTH = 512;
export const VAULT_FILL_REASON_MAX_LENGTH = 300;

export type VaultFillOrigin = {
  scheme: "https" | "http";
  host: string;
  port: number;
};

/** Exact browser observation the fill is bound to. Never model-supplied. */
export type VaultFillObservedTarget = {
  origin: VaultFillOrigin;
  profile: string;
  targetId: string;
  documentId: string;
  frameId: string;
  fieldSignature: string;
};

export type VaultFillAgentBinding = {
  agentId: string;
  sessionKey: string;
};

export type VaultFillBinding = VaultFillObservedTarget &
  VaultFillAgentBinding & {
    itemRef: string;
    revision: number;
  };

export type VaultFillOutcomeStatus =
  | "filled"
  | "needs_approval"
  | "needs_human"
  | "denied"
  | "origin_mismatch"
  | "subdomain_mismatch"
  | "insecure_origin"
  | "iframe_denied"
  | "document_changed"
  | "revision_mismatch"
  | "not_found"
  | "expired"
  | "replayed"
  | "vault_locked"
  | "unavailable";

export type VaultFillPublicResult = {
  status: VaultFillOutcomeStatus;
  /** Opaque reference; safe to keep in conversation. */
  itemRef?: string;
  siteLabel?: string;
  /** Non-secret account label, shown only for the current approved request. */
  accountLabel?: string;
  origin: VaultFillOrigin;
  approvalId?: string;
  reasonCode?: string;
};

export type VaultFillPreviewResult = VaultFillPublicResult & {
  previewId?: string;
  revision?: number;
};
