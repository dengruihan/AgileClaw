import { randomBytes } from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  compareFillOrigin,
  normalizeObservedFillOrigin,
  type VaultFillOriginMismatch,
} from "./vault-fill-origin.js";
import {
  VAULT_FILL_APPROVAL_TTL_MS,
  VAULT_FILL_MAX_FIELD_SIGNATURE_LENGTH,
  VAULT_FILL_PREVIEW_TTL_MS,
  type VaultFillBinding,
  type VaultFillOrigin,
  type VaultFillOutcomeStatus,
  type VaultFillPreviewResult,
} from "./vault-fill-types.js";
import { VaultError, type VaultEntryMetadata } from "./vault-types.js";

const log = createSubsystemLogger("vault/fill");

const ITEM_REF_MAX_LENGTH = 128;
const AGENT_ID_MAX_LENGTH = 256;
const SESSION_KEY_MAX_LENGTH = 512;
const PROFILE_MAX_LENGTH = 128;
const TARGET_ID_MAX_LENGTH = 128;
const DOCUMENT_ID_MAX_LENGTH = 256;
const FRAME_ID_MAX_LENGTH = 256;

/** Approval facts the broker needs. The approval owner stays authoritative. */
export type VaultFillApprovalSnapshot = {
  status?: string | null;
  decision?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
  detail?: string | null;
};

export type VaultFillApprovalLookup = {
  getSnapshot(id: string): Promise<VaultFillApprovalSnapshot | null>;
  /** Atomically consumes an allow-once approval; false means already used. */
  consumeAllowOnce(id: string, consumerId: string): Promise<boolean>;
};

export type VaultFillServicePort = {
  status(): Promise<{ state: "uninitialized" | "locked" | "unlocked" | "corrupted" }>;
  list(includeDeleted: boolean): Promise<VaultEntryMetadata[]>;
  fill(
    itemRef: string,
    revision: number,
    origin: VaultFillOrigin,
  ): Promise<{ entry: VaultEntryMetadata; password: string }>;
  recordFillAudit(
    itemRef: string | undefined,
    reasonCode: string,
    status?: "failed" | "blocked",
  ): Promise<void>;
  /** Fires on lock/worker-generation transitions; the broker revokes previews. */
  onLock?: (listener: () => void) => () => void;
};

export type VaultFillBrokerOptions = {
  service: VaultFillServicePort;
  approval: VaultFillApprovalLookup;
  now?: () => number;
  previewTtlMs?: number;
  approvalTtlMs?: number;
  randomId?: () => string;
};

export type VaultFillPreviewInput = {
  itemRef: string;
  origin: { scheme: string; host: string; port: number };
  agentId: string;
  sessionKey: string;
  profile: string;
  targetId: string;
  documentId: string;
  frameId: string;
  fieldSignature: string;
  reason?: string;
};

export type VaultFillExecuteInput = {
  previewId: string;
  approvalId: string;
  binding: VaultFillBinding;
};

type PreviewRecord = {
  previewId: string;
  binding: VaultFillBinding;
  entry: VaultEntryMetadata;
  createdAtMs: number;
  expiresAtMs: number;
  status: "pending" | "consumed" | "revoked";
};

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new VaultError("VAULT_INVALID_INPUT", `${field} is required.`);
  }
  if (value.length > maxLength) {
    throw new VaultError("VAULT_INVALID_INPUT", `${field} is too long.`);
  }
  return value;
}

function publicOrigin(origin: VaultFillOrigin): VaultFillOrigin {
  return { scheme: origin.scheme, host: origin.host, port: origin.port };
}

function newOpaqueId(prefix: string, randomId: () => string): string {
  return `${prefix}_${randomId()}`;
}

function defaultRandomId(): string {
  return randomBytes(24).toString("hex");
}

/** Internal material is consumed by the trusted executor and never serialized. */
export type VaultFillMaterial = {
  password: string;
  entry: { itemRef: string; siteLabel: string; accountLabel: string };
  origin: VaultFillOrigin;
};

export type VaultFillExecuteInternal =
  | { status: "filled"; material: VaultFillMaterial }
  | { status: Exclude<VaultFillOutcomeStatus, "filled">; reasonCode?: string };

/**
 * Owns the exact-origin, one-time agent fill lease. The model only ever sees an
 * opaque itemRef and a status; passwords stay inside the returned material and
 * are dropped by the fill executor after CDP insertion.
 */
export class VaultFillBroker {
  private readonly service: VaultFillServicePort;
  private readonly approval: VaultFillApprovalLookup;
  private readonly now: () => number;
  private readonly previewTtlMs: number;
  private readonly approvalTtlMs: number;
  private readonly randomId: () => string;
  private readonly previews = new Map<string, PreviewRecord>();

  constructor(options: VaultFillBrokerOptions) {
    this.service = options.service;
    this.approval = options.approval;
    this.now = options.now ?? Date.now;
    this.previewTtlMs = options.previewTtlMs ?? VAULT_FILL_PREVIEW_TTL_MS;
    this.approvalTtlMs = options.approvalTtlMs ?? VAULT_FILL_APPROVAL_TTL_MS;
    this.randomId = options.randomId ?? defaultRandomId;
    options.service.onLock?.(() => this.revokeAll());
  }

  /** Validate the observed origin against the entry and mint a preview binding. */
  async preview(input: VaultFillPreviewInput): Promise<VaultFillPreviewResult> {
    const itemRef = requireBoundedString(input.itemRef, "Entry reference", ITEM_REF_MAX_LENGTH);
    const binding = this.normalizeBinding(input);
    const observedOrigin = binding.origin;
    const vaultStatus = await this.service.status();
    if (vaultStatus.state !== "unlocked") {
      return {
        status: "needs_human",
        reasonCode: vaultStatus.state === "locked" ? "vault_locked" : "vault_unavailable",
        origin: publicOrigin(observedOrigin),
      };
    }
    const entry = await this.findEntry(itemRef);
    if (!entry) {
      await this.recordAudit(itemRef, "not_found");
      return { status: "not_found", origin: publicOrigin(observedOrigin) };
    }
    const comparison = compareFillOrigin(
      { scheme: entry.originScheme, host: entry.originHost, port: entry.originPort },
      observedOrigin,
    );
    if (comparison !== "match") {
      await this.recordAudit(itemRef, comparison);
      return this.mismatchResult(comparison, observedOrigin, entry);
    }
    binding.revision = entry.revision;
    const previewId = newOpaqueId("vaultfill", this.randomId);
    const createdAtMs = this.now();
    this.previews.set(previewId, {
      previewId,
      binding,
      entry,
      createdAtMs,
      expiresAtMs: createdAtMs + this.previewTtlMs,
      status: "pending",
    });
    this.pruneExpired();
    return {
      status: "needs_approval",
      itemRef: entry.itemRef,
      siteLabel: entry.siteLabel,
      accountLabel: entry.account,
      origin: publicOrigin(observedOrigin),
      previewId,
      revision: entry.revision,
    };
  }

  /**
   * Consume a preview and its one-time operator approval, then decrypt once.
   * The caller must drop the returned material immediately after insertion.
   */
  async execute(input: VaultFillExecuteInput): Promise<VaultFillExecuteInternal> {
    const previewId = requireBoundedString(input.previewId, "Preview reference", 256);
    const approvalId = requireBoundedString(input.approvalId, "Approval reference", 256);
    const record = this.previews.get(previewId);
    if (!record || record.status !== "pending") {
      const reason = record?.status === "consumed" ? "replayed" : "expired";
      await this.recordAudit(input.binding.itemRef, reason);
      return { status: record?.status === "consumed" ? "replayed" : "expired" };
    }
    if (record.expiresAtMs <= this.now()) {
      record.status = "revoked";
      this.previews.delete(previewId);
      await this.recordAudit(record.binding.itemRef, "expired");
      return { status: "expired" };
    }
    const mismatch = this.compareBinding(record.binding, input.binding);
    if (mismatch) {
      await this.recordAudit(record.binding.itemRef, mismatch);
      return { status: mismatch };
    }
    const approval = await this.approval.getSnapshot(approvalId).catch((error: unknown) => {
      log.warn("fill approval lookup failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
      return null;
    });
    const approvalError = this.validateApproval(approval, record);
    if (approvalError) {
      await this.recordAudit(record.binding.itemRef, approvalError);
      return { status: approvalError };
    }
    // Consume before decryption: a failed fill cannot be replayed with the same
    // operator decision, and a second caller cannot race the same preview.
    record.status = "consumed";
    const consumed = await this.approval
      .consumeAllowOnce(approvalId, previewId)
      .catch((error: unknown) => {
        log.warn("fill approval consume failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
        return false;
      });
    if (!consumed) {
      await this.recordAudit(record.binding.itemRef, "replayed");
      return { status: "replayed" };
    }
    try {
      const { entry, password } = await this.service.fill(
        record.entry.itemRef,
        record.entry.revision,
        record.binding.origin,
      );
      return {
        status: "filled",
        material: {
          password,
          entry: {
            itemRef: entry.itemRef,
            siteLabel: entry.siteLabel,
            accountLabel: entry.account,
          },
          origin: publicOrigin(record.binding.origin),
        },
      };
    } catch (error) {
      const status = fillErrorStatus(error);
      await this.recordAudit(record.binding.itemRef, status);
      return { status };
    }
  }

  /** Drop every pending preview for an entry; rotation and deletion call this. */
  revokeItem(itemRef: string): number {
    let revoked = 0;
    for (const [previewId, record] of this.previews) {
      if (record.binding.itemRef === itemRef) {
        record.status = "revoked";
        this.previews.delete(previewId);
        revoked += 1;
      }
    }
    return revoked;
  }

  revokeTarget(targetId: string): void {
    for (const [previewId, record] of this.previews) {
      if (record.binding.targetId === targetId) {
        record.status = "revoked";
        this.previews.delete(previewId);
      }
    }
  }

  revokeAll(): void {
    for (const record of this.previews.values()) {
      record.status = "revoked";
    }
    this.previews.clear();
  }

  approvalExpiresAtMs(nowMs = this.now()): number {
    return nowMs + this.approvalTtlMs;
  }

  pendingPreviewCount(): number {
    this.pruneExpired();
    let pending = 0;
    for (const record of this.previews.values()) {
      if (record.status === "pending") {
        pending += 1;
      }
    }
    return pending;
  }

  private normalizeBinding(input: VaultFillPreviewInput): VaultFillBinding {
    return {
      itemRef: requireBoundedString(input.itemRef, "Entry reference", ITEM_REF_MAX_LENGTH),
      revision: 0,
      origin: normalizeObservedFillOrigin(input.origin),
      agentId: requireBoundedString(input.agentId, "Agent identity", AGENT_ID_MAX_LENGTH),
      sessionKey: requireBoundedString(input.sessionKey, "Session key", SESSION_KEY_MAX_LENGTH),
      profile: requireBoundedString(input.profile, "Browser profile", PROFILE_MAX_LENGTH),
      targetId: requireBoundedString(input.targetId, "Browser target", TARGET_ID_MAX_LENGTH),
      documentId: requireBoundedString(
        input.documentId,
        "Browser document",
        DOCUMENT_ID_MAX_LENGTH,
      ),
      frameId: requireBoundedString(input.frameId, "Browser frame", FRAME_ID_MAX_LENGTH),
      fieldSignature: requireBoundedString(
        input.fieldSignature,
        "Fill field signature",
        VAULT_FILL_MAX_FIELD_SIGNATURE_LENGTH,
      ),
    };
  }

  private compareBinding(
    expected: VaultFillBinding,
    candidate: VaultFillBinding,
  ): Exclude<VaultFillOutcomeStatus, "filled"> | null {
    if (
      candidate.itemRef !== expected.itemRef ||
      candidate.agentId !== expected.agentId ||
      candidate.sessionKey !== expected.sessionKey
    ) {
      return "denied";
    }
    if (candidate.revision !== expected.revision) {
      return "revision_mismatch";
    }
    let origin: VaultFillOrigin;
    try {
      origin = normalizeObservedFillOrigin(candidate.origin);
    } catch {
      return "origin_mismatch";
    }
    if (
      origin.scheme !== expected.origin.scheme ||
      origin.host !== expected.origin.host ||
      origin.port !== expected.origin.port
    ) {
      return "origin_mismatch";
    }
    if (
      candidate.profile !== expected.profile ||
      candidate.targetId !== expected.targetId ||
      candidate.documentId !== expected.documentId ||
      candidate.frameId !== expected.frameId ||
      candidate.fieldSignature !== expected.fieldSignature
    ) {
      return candidate.documentId !== expected.documentId ? "document_changed" : "denied";
    }
    return null;
  }

  private validateApproval(
    approval: VaultFillApprovalSnapshot | null,
    record: PreviewRecord,
  ): Exclude<VaultFillOutcomeStatus, "filled"> | null {
    if (!approval) {
      return "needs_approval";
    }
    if (approval.status === "pending") {
      return "needs_approval";
    }
    if (approval.status === "expired" || approval.status === "cancelled") {
      return "expired";
    }
    if (approval.status !== "allowed" || approval.decision !== "allow-once") {
      return "denied";
    }
    if (
      approval.agentId !== record.binding.agentId ||
      approval.sessionKey !== record.binding.sessionKey
    ) {
      return "denied";
    }
    // The approval description carries the opaque preview id; requiring it here
    // binds the operator decision to this exact observed document/binding.
    if (typeof approval.detail !== "string" || !approval.detail.includes(record.previewId)) {
      return "replayed";
    }
    return null;
  }

  private mismatchResult(
    comparison: VaultFillOriginMismatch,
    observed: VaultFillOrigin,
    entry: VaultEntryMetadata,
  ): VaultFillPreviewResult {
    return {
      status: comparison,
      itemRef: entry.itemRef,
      siteLabel: entry.siteLabel,
      origin: publicOrigin(observed),
      reasonCode: comparison,
    };
  }

  private async findEntry(itemRef: string): Promise<VaultEntryMetadata | undefined> {
    const entries = await this.service.list(false);
    return entries.find((entry) => entry.itemRef === itemRef);
  }

  private async recordAudit(itemRef: string | undefined, reasonCode: string): Promise<void> {
    await this.service
      .recordFillAudit(itemRef, reasonCode, reasonCode === "not_found" ? "failed" : "blocked")
      .catch((error: unknown) => {
        log.warn("fill audit failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      });
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [previewId, record] of this.previews) {
      if (record.expiresAtMs <= now) {
        record.status = "revoked";
        this.previews.delete(previewId);
      }
    }
  }
}

function fillErrorStatus(error: unknown): Exclude<VaultFillOutcomeStatus, "filled"> {
  if (error instanceof VaultError) {
    switch (error.code) {
      case "VAULT_LOCKED":
      case "VAULT_LOCKED_OUT":
      case "VAULT_UNINITIALIZED":
        return "vault_locked";
      case "VAULT_ORIGIN_MISMATCH":
        return "origin_mismatch";
      case "VAULT_CONFLICT":
        return "revision_mismatch";
      case "VAULT_NOT_FOUND":
      case "VAULT_DELETED":
        return "not_found";
      default:
        return "unavailable";
    }
  }
  return "unavailable";
}
