import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
/**
 * `sessions.patch` glue for the device execution scope.
 *
 * A scope write is not an ordinary preference: it leases a device from its
 * node, so the patch handler prepares (validate + acquire) before the entry
 * mutation, commits the entry write as the switch's commit point, and rolls the
 * grant back when the patch fails. This module keeps that transaction shape out
 * of the generic patch handler.
 */
import {
  ErrorCodes,
  errorShape,
  type ErrorShape,
  type SessionsPatchManyParams,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionStoreKey } from "../session-store-key.js";
import { emitSessionsChanged } from "./session-change-event.js";
import {
  prepareDeviceScopeSwitch,
  publishSessionDeviceScopePrompt,
  releaseDeviceScopeLease,
  resolveSessionScopeRoot,
  writeSessionDeviceScope,
  type DeviceScopeFailureCode,
  type DeviceScopeRegistry,
  type DeviceScopeSwitch,
} from "./session-device-scope.js";
import type { SessionMutationAuthorization } from "./shared-types.js";
import type { GatewayRequestContext } from "./types.js";

export type PreparedSessionDeviceScope = {
  scopeSwitch: DeviceScopeSwitch;
  target: { rootSessionKey: string; agentId: string; deviceId: string | null };
};

export type BeginSessionPatchDeviceScopeResult =
  | { ok: true; change: PreparedSessionDeviceScope }
  | { ok: false; error: ErrorShape };

function scopeError(code: DeviceScopeFailureCode | "DEVICE_SCOPE_NOT_ROOT", message: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, { details: { code } });
}

/** Scope belongs to one session; a multi-target patch cannot carry a lease. */
export function patchManyDeviceScopeError(): ErrorShape {
  return scopeError(
    "DEVICE_SCOPE_UNAVAILABLE",
    "sessions.patchMany cannot change device scope; patch one session at a time",
  );
}

/**
 * Validate and lease one scope change before the entry patch. A rejected device
 * never changes where the session executes, and a busy device is never queued.
 */
export async function beginSessionPatchDeviceScope(params: {
  cfg: OpenClawConfig;
  registry: DeviceScopeRegistry;
  requestedKey: string;
  requestedAgentId?: string;
  /** `null` returns the session to the Gateway. */
  requestedScopeDeviceId: string | null;
  /** Per-target patch authorization; runs before any real occupancy acquire. */
  assertAuthorized?: () => void;
  signal?: AbortSignal;
  connectionSignal?: AbortSignal;
}): Promise<BeginSessionPatchDeviceScopeResult> {
  const requestedKey = params.requestedKey.trim();
  const root = resolveSessionScopeRoot({
    cfg: params.cfg,
    sessionKey: requestedKey,
    ...(params.requestedAgentId ? { agentId: params.requestedAgentId } : {}),
  });
  if (!root) {
    return {
      ok: false,
      error: scopeError("DEVICE_SCOPE_UNAVAILABLE", "session is unavailable or changed"),
    };
  }
  if (root.rootSessionKey !== requestedKey) {
    // Device scope belongs to the tree root; a subagent shares it. Forks are
    // their own root, so this only rejects spawned lineage.
    return {
      ok: false,
      error: scopeError(
        "DEVICE_SCOPE_NOT_ROOT",
        `session ${requestedKey} shares the device scope of its root session ${root.rootSessionKey}. Switch scope from the root session.`,
      ),
    };
  }
  const sessionId = root.entry.sessionId;
  if (!sessionId) {
    return {
      ok: false,
      error: scopeError("DEVICE_SCOPE_UNAVAILABLE", "session has no durable identity yet"),
    };
  }
  const deviceId =
    params.requestedScopeDeviceId === null
      ? null
      : (normalizeOptionalString(params.requestedScopeDeviceId) ?? "");
  if (deviceId === "") {
    return {
      ok: false,
      error: scopeError("DEVICE_NOT_FOUND", "scopeDeviceId must be a device id or null"),
    };
  }
  // Authorization precedes the lease: an unauthorized client must never make a
  // device acquire real occupancy, even transiently.
  params.assertAuthorized?.();
  const prepared = await prepareDeviceScopeSwitch({
    cfg: params.cfg,
    registry: params.registry,
    rootSessionKey: root.rootSessionKey,
    sessionId,
    agentId: root.agentId,
    deviceId,
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.connectionSignal ? { connectionSignal: params.connectionSignal } : {}),
  });
  if (!prepared.ok) {
    return { ok: false, error: scopeError(prepared.code, prepared.message) };
  }
  return {
    ok: true,
    change: {
      scopeSwitch: prepared,
      target: { rootSessionKey: root.rootSessionKey, agentId: root.agentId, deviceId },
    },
  };
}

/** Request-level adapter: only single-target patches may carry a device scope. */
export async function beginSessionPatchRequestDeviceScope(params: {
  request:
    | { many: true; params: SessionsPatchManyParams }
    | { many: false; params: SessionsPatchParams };
  context: GatewayRequestContext;
  /** RPC-level authority assertion, rechecked before any real occupancy acquire. */
  assertCurrent: () => void;
  sessionMutationAuthorization?: SessionMutationAuthorization;
  signal?: AbortSignal;
  connectionSignal?: AbortSignal;
}): Promise<BeginSessionPatchDeviceScopeResult | undefined> {
  if (params.request.many) {
    return params.request.params.patch.scopeDeviceId === undefined
      ? undefined
      : { ok: false, error: patchManyDeviceScopeError() };
  }
  const request = params.request.params;
  if (request.scopeDeviceId === undefined) {
    return undefined;
  }
  return await beginSessionPatchDeviceScope({
    cfg: params.context.getRuntimeConfig(),
    registry: params.context.nodeRegistry,
    requestedKey: request.key,
    ...(request.agentId ? { requestedAgentId: request.agentId } : {}),
    requestedScopeDeviceId:
      request.scopeDeviceId === null
        ? null
        : (normalizeOptionalString(request.scopeDeviceId) ?? ""),
    assertAuthorized: () => {
      params.assertCurrent();
      params.sessionMutationAuthorization?.assertTargetCurrent({
        sessionKey: request.key.trim(),
        ...(request.agentId ? { agentId: request.agentId } : {}),
      });
    },
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.connectionSignal ? { connectionSignal: params.connectionSignal } : {}),
  });
}

/**
 * Commit the prepared scope: write the entry, then release the tree's previous
 * grant. Only a committed write may release it, so a failed patch keeps the old
 * lease intact. Returns the entry the response should project.
 */
export async function commitSessionPatchDeviceScope(params: {
  cfg: OpenClawConfig;
  registry: DeviceScopeRegistry;
  change: PreparedSessionDeviceScope;
  fallbackEntry: SessionEntry;
  context: GatewayRequestContext;
}): Promise<SessionEntry> {
  const { target } = params.change;
  const written = await writeSessionDeviceScope({
    cfg: params.cfg,
    rootSessionKey: target.rootSessionKey,
    agentId: target.agentId,
    deviceId: target.deviceId,
  });
  const previousLease = params.change.scopeSwitch.previousLease;
  if (previousLease) {
    await releaseDeviceScopeLease({
      registry: params.registry,
      rootSessionKey: target.rootSessionKey,
      deviceId: previousLease.deviceId,
      leaseToken: previousLease.leaseToken,
    });
  }
  // M64 publishes one scope fact per session at the turn boundary; the switch
  // itself is a scope change, so refresh the fact here instead of waiting for
  // the next turn to notice a stale value.
  publishSessionDeviceScopePrompt({
    sessionKey: target.rootSessionKey,
    registry: params.registry,
    ...(target.deviceId ? { scopeDeviceId: target.deviceId } : {}),
  });
  emitSessionsChanged(
    params.context,
    {
      sessionKey: target.rootSessionKey,
      agentId: target.agentId,
      reason: "update",
    },
    { accessChanged: false },
  );
  if (written) {
    return written;
  }
  if (target.deviceId) {
    return { ...params.fallbackEntry, scopeDeviceId: target.deviceId };
  }
  const cleared: SessionEntry = { ...params.fallbackEntry };
  delete cleared.scopeDeviceId;
  return cleared;
}

/** A patch that failed after preparation must not leave a phantom holder. */
export async function rollbackSessionPatchDeviceScope(
  registry: DeviceScopeRegistry,
  change: PreparedSessionDeviceScope | undefined,
): Promise<void> {
  const lease = change?.scopeSwitch.lease;
  if (!lease || !change?.target.deviceId) {
    return;
  }
  await releaseDeviceScopeLease({
    registry,
    rootSessionKey: change.target.rootSessionKey,
    deviceId: change.target.deviceId,
    leaseToken: lease.leaseToken,
  });
}

/**
 * Archiving retires a row's device occupancy. The node owns occupancy, so this
 * releases the node lease (tree-killing its holder processes per the node
 * contract) before dropping the Gateway mirror; an archived session must not
 * keep the device occupied for every other session.
 */
export async function releaseArchivedSessionDeviceScopes(params: {
  context: GatewayRequestContext;
  registry: DeviceScopeRegistry;
  cfg: OpenClawConfig;
  targets: ReadonlyArray<{ key: string; agentId?: string }>;
  outcomes: ReadonlyArray<{ ok: boolean }>;
  targetAgentIds: ReadonlyArray<string | undefined>;
}): Promise<void> {
  for (const [index, outcome] of params.outcomes.entries()) {
    if (!outcome.ok) {
      continue;
    }
    const target = params.targets[index];
    if (!target) {
      continue;
    }
    const agentId = params.targetAgentIds[index] ?? target.agentId;
    const canonicalKey = resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey: target.key,
      storeAgentId: agentId,
    });
    const rootSessionKey =
      resolveSessionScopeRoot({
        cfg: params.cfg,
        sessionKey: canonicalKey,
        ...(agentId ? { agentId } : {}),
      })?.rootSessionKey ?? canonicalKey;
    const released = await releaseDeviceScopeLease({
      registry: params.registry,
      rootSessionKey,
    });
    if (released) {
      publishSessionDeviceScopePrompt({ sessionKey: rootSessionKey, registry: params.registry });
      emitSessionsChanged(params.context, {
        sessionKey: canonicalKey,
        ...(agentId ? { agentId } : {}),
        reason: "update",
      });
    }
  }
}
