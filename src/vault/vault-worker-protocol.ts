import type {
  VaultAuditEvent,
  VaultEntryCreateInput,
  VaultEntryMetadata,
  VaultEntryUpdateInput,
  VaultErrorCode,
  VaultStatus,
} from "./vault-types.js";

export type VaultWorkerOperation =
  | { type: "status" }
  | { type: "initialize"; passphrase: string; autoLockSeconds?: number }
  | { type: "unlock"; passphrase: string }
  | { type: "lock" }
  | { type: "list"; includeDeleted: boolean }
  | { type: "create"; input: VaultEntryCreateInput }
  | { type: "update"; input: VaultEntryUpdateInput }
  | { type: "delete"; itemRef: string; revision: number }
  | { type: "restore"; itemRef: string }
  | { type: "purge"; itemRef: string }
  | { type: "reveal"; itemRef: string; mode: "reveal" | "copy" }
  | { type: "generate"; length?: number; includeSymbols?: boolean }
  | { type: "setAutoLock"; autoLockSeconds: number }
  | { type: "audit.list"; limit: number; before?: number }
  | { type: "internal.tick"; advanceMs: number };

export type VaultWorkerResult =
  | { type: "status"; status: VaultStatus }
  | { type: "initialize"; status: VaultStatus }
  | { type: "unlock"; status: VaultStatus }
  | { type: "lock" }
  | { type: "list"; entries: VaultEntryMetadata[] }
  | { type: "create"; entry: VaultEntryMetadata }
  | { type: "update"; entry: VaultEntryMetadata }
  | { type: "delete" }
  | { type: "restore" }
  | { type: "purge" }
  | { type: "reveal"; entry: VaultEntryMetadata; password: string; notes: string }
  | { type: "generate"; password: string }
  | { type: "setAutoLock"; status: VaultStatus }
  | { type: "audit.list"; events: VaultAuditEvent[] }
  | { type: "internal.tick"; status: VaultStatus };

export type VaultWorkerRequest = {
  id: number;
  operation: VaultWorkerOperation;
};

export type VaultWorkerReply =
  | { type: "reply"; id: number; ok: true; result: VaultWorkerResult }
  | {
      type: "reply";
      id: number;
      ok: false;
      error: { code: VaultErrorCode; message: string; details?: Record<string, unknown> };
    }
  | { type: "locked"; reason: "auto" | "explicit" }
  | { type: "ready" }
  | { type: "fatal" };

export type VaultWorkerData = {
  databasePath: string;
  env?: Record<string, string>;
  /** Test-only manual clock; production workers use Date.now() and real timers. */
  clock?: { mode: "manual"; startMs: number };
};

export type VaultWorkerResultFor<Operation extends VaultWorkerOperation["type"]> = Extract<
  VaultWorkerResult,
  { type: Operation }
>;
