import { Worker } from "node:worker_threads";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import {
  resolveRuntimeWorkerThreadExecArgv,
  resolveRuntimeWorkerUrl,
} from "../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveDatabasePath } from "../state/openclaw-state-db.paths.js";
import {
  VaultError,
  type VaultAuditEvent,
  type VaultEntryCreateInput,
  type VaultEntryMetadata,
  type VaultEntryUpdateInput,
  type VaultStatus,
} from "./vault-types.js";
import type {
  VaultWorkerOperation,
  VaultWorkerReply,
  VaultWorkerResult,
} from "./vault-worker-protocol.js";

const log = createSubsystemLogger("vault/service");
const REQUEST_TIMEOUT_MS = 30_000;

export type VaultServiceOptions = {
  databasePath?: string;
  env?: NodeJS.ProcessEnv;
};

type Pending = {
  resolve: (result: VaultWorkerResult) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
};

function toProcessEnvRecord(
  env: NodeJS.ProcessEnv | undefined,
): Record<string, string> | undefined {
  if (!env) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      record[key] = value;
    }
  }
  return record;
}

export class VaultService {
  private worker: Worker | undefined;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: VaultServiceOptions = {}) {}

  status(): Promise<VaultStatus> {
    return this.request<VaultStatus>({ type: "status" });
  }

  initialize(passphrase: string, autoLockSeconds?: number): Promise<VaultStatus> {
    return this.request<VaultStatus>({
      type: "initialize",
      passphrase,
      ...(autoLockSeconds !== undefined ? { autoLockSeconds } : {}),
    });
  }

  unlock(passphrase: string): Promise<VaultStatus> {
    return this.request<VaultStatus>({ type: "unlock", passphrase });
  }

  async lock(): Promise<void> {
    try {
      await this.request<void>({ type: "lock" });
    } finally {
      // Terminating the dedicated worker is the strongest zeroization boundary.
      await this.terminateWorker();
    }
  }

  list(includeDeleted: boolean): Promise<VaultEntryMetadata[]> {
    return this.request<VaultEntryMetadata[]>({ type: "list", includeDeleted });
  }

  create(input: VaultEntryCreateInput): Promise<VaultEntryMetadata> {
    return this.request<VaultEntryMetadata>({ type: "create", input });
  }

  update(input: VaultEntryUpdateInput): Promise<VaultEntryMetadata> {
    return this.request<VaultEntryMetadata>({ type: "update", input });
  }

  async delete(itemRef: string, revision: number): Promise<void> {
    await this.request<void>({ type: "delete", itemRef, revision });
  }

  async restore(itemRef: string): Promise<void> {
    await this.request<void>({ type: "restore", itemRef });
  }

  async purge(itemRef: string): Promise<void> {
    await this.request<void>({ type: "purge", itemRef });
  }

  reveal(
    itemRef: string,
    mode: "reveal" | "copy",
  ): Promise<{ entry: VaultEntryMetadata; password: string; notes: string }> {
    return this.request({ type: "reveal", itemRef, mode });
  }

  generate(length?: number, includeSymbols?: boolean): Promise<string> {
    return this.request<string>({
      type: "generate",
      ...(length !== undefined ? { length } : {}),
      ...(includeSymbols !== undefined ? { includeSymbols } : {}),
    });
  }

  setAutoLock(autoLockSeconds: number): Promise<VaultStatus> {
    return this.request<VaultStatus>({ type: "setAutoLock", autoLockSeconds });
  }

  auditList(limit: number, before?: number): Promise<VaultAuditEvent[]> {
    return this.request<VaultAuditEvent[]>({
      type: "audit.list",
      limit,
      ...(before !== undefined ? { before } : {}),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.terminateWorker();
  }

  private request<T>(operation: VaultWorkerOperation): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) {
        throw new VaultError("VAULT_UNAVAILABLE", "The password vault service is closed.");
      }
      const worker = this.ensureWorker();
      const id = this.nextId;
      this.nextId += 1;
      const result = await new Promise<VaultWorkerResult>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          void this.terminateWorker();
          reject(new VaultError("VAULT_UNAVAILABLE", "The password vault operation timed out."));
        }, REQUEST_TIMEOUT_MS);
        timer.unref();
        this.pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, operation }, []);
      });
      return extractResult(operation.type, result) as T;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.vaultWorker);
    const env = toProcessEnvRecord(this.options.env);
    const databasePath = resolveDatabasePath({
      ...(this.options.databasePath ? { path: this.options.databasePath } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
    });
    const worker = new Worker(moduleUrl, {
      execArgv: resolveRuntimeWorkerThreadExecArgv(moduleUrl),
      workerData: {
        databasePath,
        ...(env ? { env } : {}),
      },
    });
    worker.on("message", (message: VaultWorkerReply) => {
      if (message.type === "reply") {
        const pending = this.pending.get(message.id);
        if (!pending) {
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.ok) {
          pending.resolve(message.result);
        } else {
          pending.reject(
            new VaultError(message.error.code, message.error.message, message.error.details),
          );
        }
        return;
      }
      if (message.type === "locked") {
        void this.terminateWorker();
      }
      if (message.type === "fatal") {
        this.failAll(new VaultError("VAULT_UNAVAILABLE", "The password vault worker failed."));
        void this.terminateWorker();
      }
    });
    worker.on("error", (error) => {
      log.warn("vault worker error", { error: error instanceof Error ? error.message : "unknown" });
      this.failAll(new VaultError("VAULT_UNAVAILABLE", "The password vault worker failed."));
      void this.terminateWorker();
    });
    worker.on("exit", () => {
      if (this.worker === worker) {
        this.worker = undefined;
      }
      this.failAll(new VaultError("VAULT_UNAVAILABLE", "The password vault worker stopped."));
    });
    worker.unref();
    this.worker = worker;
    return worker;
  }

  private failAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async terminateWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.failAll(new VaultError("VAULT_UNAVAILABLE", "The password vault worker stopped."));
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // A worker that already exited needs no further cleanup.
      }
    }
  }
}

function extractResult(type: VaultWorkerOperation["type"], result: VaultWorkerResult): unknown {
  switch (type) {
    case "status":
    case "initialize":
    case "unlock":
    case "setAutoLock":
      if (result.type === type) {
        return result.status;
      }
      break;
    case "list":
      if (result.type === "list") {
        return result.entries;
      }
      break;
    case "create":
    case "update":
      if (result.type === type) {
        return result.entry;
      }
      break;
    case "reveal":
      if (result.type === "reveal") {
        return { entry: result.entry, password: result.password, notes: result.notes };
      }
      break;
    case "generate":
      if (result.type === "generate") {
        return result.password;
      }
      break;
    case "audit.list":
      if (result.type === "audit.list") {
        return result.events;
      }
      break;
    case "lock":
    case "delete":
    case "restore":
    case "purge":
      return undefined;
  }
  throw new VaultError("VAULT_UNAVAILABLE", "The password vault returned an invalid response.");
}

let defaultService: VaultService | undefined;

/** Gateway-wide vault owner. The worker holds the DEK; this module never sees it. */
export function getVaultService(): VaultService {
  defaultService ??= new VaultService();
  return defaultService;
}

export async function shutdownVaultService(): Promise<void> {
  const service = defaultService;
  defaultService = undefined;
  await service?.close();
}

export function resetVaultServiceForTests(): void {
  void defaultService?.close();
  defaultService = undefined;
}
