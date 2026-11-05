import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateNodePairApproveParams,
  validateNodePairListParams,
  validateNodePairRejectParams,
  validateNodePairRemoveParams,
  validateNodeRenameParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { lazyCompile } from "../../../packages/gateway-protocol/src/protocol-validator.js";
import {
  NodeDeviceDisableParamsSchema,
  NodeDeviceEnableParamsSchema,
  NodeDeviceUpdateParamsSchema,
} from "../../../packages/gateway-protocol/src/schema/devices.js";
import { captureNodePairingState } from "../../infra/device-pairing-node-state.js";
import {
  approveNodePairing,
  getPendingNodePairing,
  listNodePairing,
  rejectNodePairing,
  renamePairedNode,
  setPairedNodeDeviceCommandPolicy,
  setPairedNodeDeviceEnabled,
} from "../../infra/device-pairing-node.js";
import {
  getPairedDevice,
  listApprovedPairedDeviceRoles,
  removePairedDeviceRole,
} from "../../infra/device-pairing.js";
import { reconcileRevokedDeviceWorker } from "../device-worker-revocation.js";
import { clearRemovedNodeRuntimeState } from "../node-runtime-state.js";
import { invalidateNodeWakeState } from "../node-wake-state.js";
import { PAIRING_SCOPE } from "../operator-scopes.js";
import {
  deniesCrossDeviceManagement,
  pairedDeviceHasNonOperatorRole,
  resolveDeviceManagementAuthz,
  resolveDeviceSessionAuthz,
  type DeviceManagementAuthz,
} from "./device-management-authz.js";
import { emitDeviceManagementSecurityEvent } from "./device-management-security.js";
import { refreshConnectedNodeSurfaceCaches } from "./nodes.read.js";
import { respondUnavailableOnThrow } from "./response.js";
import {
  releaseRemovedDeviceScopeLeases,
  revokeDeviceScopeLeases,
} from "./session-device-scope.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./shared-types.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function emitNodePairingDeniedSecurityEvent(params: {
  authz: DeviceManagementAuthz;
  nodeId: string;
  controlId: "node.pair.approve" | "node.pair.reject" | "node.rename";
  reason: string;
}): void {
  emitDeviceManagementSecurityEvent({
    action: "device.pairing.denied",
    outcome: "denied",
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.nodeId,
    policyId: "gateway.device-pairing",
    decision: "deny",
    controlId: params.controlId,
    reason: params.reason,
    attributes: { role: "node" },
  });
}

async function enforcePendingNodePairingOwnership(params: {
  requestId: string;
  mutation: "approve" | "reject";
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "logGateway">;
  respond: RespondFn;
}): Promise<boolean> {
  const action = params.mutation === "approve" ? "approval" : "rejection";
  const controlId = params.mutation === "approve" ? "node.pair.approve" : "node.pair.reject";
  const deniedMessage = `node pairing ${action} denied`;
  const pending = await getPendingNodePairing(params.requestId);
  const sessionAuthz = resolveDeviceSessionAuthz(params.client);
  if (!pending) {
    if (sessionAuthz.callerDeviceId && !sessionAuthz.isAdminCaller) {
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deniedMessage));
      return false;
    }
    return true;
  }

  const authz = resolveDeviceManagementAuthz(params.client, pending.nodeId);
  if (!deniesCrossDeviceManagement(authz)) {
    return true;
  }
  params.context.logGateway.warn(
    `${deniedMessage} node=${pending.nodeId} reason=device-ownership-mismatch`,
  );
  emitNodePairingDeniedSecurityEvent({
    authz,
    nodeId: pending.nodeId,
    controlId,
    reason: "device-ownership-mismatch",
  });
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deniedMessage));
  return false;
}

function emitNodeRoleRemovalSecurityEvent(params: {
  authz: DeviceManagementAuthz;
  deviceId: string;
  reason?: string;
  removedDevice?: boolean;
}): void {
  const denied = params.reason !== undefined;
  emitDeviceManagementSecurityEvent({
    action: denied ? "device.role.removal_denied" : "device.role.removed",
    outcome: denied ? "denied" : "success",
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.deviceId,
    policyId: "gateway.device-pairing",
    decision: denied ? "deny" : "allow",
    controlId: "node.pair.remove",
    ...(params.reason ? { reason: params.reason } : {}),
    attributes: {
      role: "node",
      ...(params.removedDevice !== undefined ? { removed_device: params.removedDevice } : {}),
    },
  });
}

function emitNodeDeviceRegistrySecurityEvent(params: {
  authz: DeviceManagementAuthz;
  nodeId: string;
  controlId: "node.device.enable" | "node.device.disable" | "node.device.update";
  outcome: "success" | "denied";
  reason?: string;
  attributes?: Record<string, string | number | boolean>;
}): void {
  emitDeviceManagementSecurityEvent({
    action:
      params.outcome === "denied" ? "device.registry.update_denied" : "device.registry.updated",
    outcome: params.outcome,
    severity: "medium",
    authz: params.authz,
    targetDeviceId: params.nodeId,
    policyId: "gateway.device-pairing",
    decision: params.outcome === "denied" ? "deny" : "allow",
    controlId: params.controlId,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.attributes ? { attributes: params.attributes } : {}),
  });
}

const validateNodeDeviceEnableParams = lazyCompile(NodeDeviceEnableParamsSchema);
const validateNodeDeviceDisableParams = lazyCompile(NodeDeviceDisableParamsSchema);
const validateNodeDeviceUpdateParams = lazyCompile(NodeDeviceUpdateParamsSchema);

// A whitespace-only id is invalid input, not a store failure; reject it before
// the pairing owner throws its own `nodeId required` (which surfaces as
// UNAVAILABLE through respondUnavailableOnThrow).
function readDeviceNodeId(params: { nodeId: string }, respond: RespondFn): string | null {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
    return null;
  }
  return nodeId;
}

async function removePairedDeviceBackedNode(params: {
  nodeId: string;
  client: GatewayClient | null;
  context: Pick<GatewayRequestContext, "invalidateClientsForDevice" | "logGateway">;
}): Promise<
  | {
      status: "removed";
      nodeId: string;
    }
  | { status: "denied"; message: string }
  | { status: "unknown" }
> {
  const nodeId = params.nodeId.trim();
  if (!nodeId) {
    return { status: "unknown" };
  }
  const paired = await getPairedDevice(nodeId);
  if (!paired || !listApprovedPairedDeviceRoles(paired).includes("node")) {
    return { status: "unknown" };
  }

  const authz = resolveDeviceManagementAuthz(params.client, nodeId);
  // Mirror device.pair.remove: the admin requirement for mixed-role rows only
  // applies to device-token self-service callers (callerDeviceId set). Shared-auth
  // / CLI operators holding operator.pairing manage pairings on others' behalf and
  // are allowed to remove non-operator (e.g. node) rows without operator.admin.
  const reason = deniesCrossDeviceManagement(authz)
    ? "device-ownership-mismatch"
    : authz.callerDeviceId && !authz.isAdminCaller && pairedDeviceHasNonOperatorRole(paired)
      ? "role-management-requires-admin"
      : undefined;
  if (reason) {
    params.context.logGateway.warn(`node pairing removal denied node=${nodeId} reason=${reason}`);
    emitNodeRoleRemovalSecurityEvent({ authz, deviceId: nodeId, reason });
    return { status: "denied", message: "node pairing removal denied" };
  }

  const removed = await removePairedDeviceRole({ deviceId: nodeId, role: "node" });
  if (!removed) {
    return { status: "unknown" };
  }
  params.context.logGateway.info(`node pairing removed device-backed node=${removed.deviceId}`);
  emitNodeRoleRemovalSecurityEvent({
    authz,
    deviceId: removed.deviceId,
    removedDevice: removed.removedDevice,
  });
  // Match device.pair.remove: invalidate before responding so pipelined frames
  // on the affected device token are rejected. The caller queues the hard close
  // only after the success response is emitted.
  params.context.invalidateClientsForDevice?.(removed.deviceId, {
    role: "node",
    reason: "device-pair-removed",
  });
  return {
    status: "removed",
    nodeId: removed.deviceId,
  };
}

export const nodePairingHandlers: GatewayRequestHandlers = {
  "node.pair.list": async ({ params, respond, client }) => {
    if (!assertValidParams(params, validateNodePairListParams, "node.pair.list", respond)) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const list = await listNodePairing();
      const authz = resolveDeviceSessionAuthz(client);
      const visibleList =
        authz.callerDeviceId && !authz.isAdminCaller
          ? {
              pending: list.pending.filter(
                (request) => request.nodeId.trim() === authz.callerDeviceId,
              ),
              paired: list.paired.filter((node) => node.nodeId.trim() === authz.callerDeviceId),
            }
          : list;
      respond(true, visibleList, undefined);
    });
  },
  "node.pair.approve": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodePairApproveParams, "node.pair.approve", respond)) {
      return;
    }
    const { requestId } = params;
    // Intentionally fail closed for RPC callers without an explicit scoped session.
    const callerScopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
    await respondUnavailableOnThrow(respond, async () => {
      if (
        !(await enforcePendingNodePairingOwnership({
          requestId,
          mutation: "approve",
          client,
          context,
          respond,
        }))
      ) {
        return;
      }
      const pendingApproval = await getPendingNodePairing(requestId);
      const pairingStateBeforeApproval = pendingApproval
        ? await captureNodePairingState(pendingApproval.nodeId)
        : null;
      const sessionBeforeApproval = pendingApproval
        ? context.nodeRegistry.get(pendingApproval.nodeId)
        : undefined;
      const approved = await approveNodePairing(requestId, { callerScopes });
      if (!approved) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      if ("status" in approved && approved.status === "forbidden") {
        respond(
          false,
          undefined,
          missingScopeErrorShape({
            missingScope: approved.missingScope,
            requiredScopes:
              approved.missingScope === PAIRING_SCOPE
                ? [PAIRING_SCOPE]
                : [PAIRING_SCOPE, approved.missingScope],
          }),
        );
        return;
      }
      if (!("node" in approved)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      const approvedNode = approved.node;
      // Surface approval rotates the persistent generation. Abort any wake
      // already admitted under the prior command surface before it can send.
      invalidateNodeWakeState(approvedNode.nodeId);
      // Only the exact generation committed by this approval may inherit the
      // authenticated live session. A later re-pair must reconnect instead.
      const persistedApprovedState = await captureNodePairingState(approvedNode.nodeId);
      const previousGenerationKey = pairingStateBeforeApproval?.generation?.key;
      const liveSessionOwnsPreviousPairingState = Boolean(
        sessionBeforeApproval &&
        pairingStateBeforeApproval?.identity.key === approved.pairingIdentity &&
        sessionBeforeApproval.pairingIdentity === approved.pairingIdentity &&
        approved.previousPairingGeneration === previousGenerationKey &&
        sessionBeforeApproval.pairingGeneration === previousGenerationKey &&
        approved.nextPairingGeneration !== undefined,
      );
      const updatedNode =
        liveSessionOwnsPreviousPairingState &&
        sessionBeforeApproval &&
        approved.nextPairingGeneration &&
        persistedApprovedState?.identity.key === approved.pairingIdentity &&
        persistedApprovedState.generation?.key === approved.nextPairingGeneration
          ? context.nodeRegistry.updateSurface(
              approvedNode.nodeId,
              {
                caps: approvedNode.caps ?? [],
                commands: approvedNode.commands ?? [],
                permissions: approvedNode.permissions,
              },
              {
                expectedConnId: sessionBeforeApproval.connId,
                expectedPairingIdentity: approved.pairingIdentity,
                ...(previousGenerationKey
                  ? { expectedPairingGeneration: previousGenerationKey }
                  : {}),
                nextPairingGeneration: approved.nextPairingGeneration,
              },
            )
          : null;
      const resolved = {
        requestId,
        nodeId: approvedNode.nodeId,
        decision: "approved",
        ts: Date.now(),
      };
      if (updatedNode) {
        refreshConnectedNodeSurfaceCaches({ context, nodeSession: updatedNode });
        const notified = await context.nodeRegistry.sendEventForPairingIdentity({
          nodeId: updatedNode.nodeId,
          connId: updatedNode.connId,
          pairingIdentity: approved.pairingIdentity,
          event: "node.pair.resolved",
          payload: resolved,
        });
        if (!notified) {
          context.logGateway.warn(
            `node approval refresh was not delivered for ${approvedNode.nodeId}; the current node must republish after reconnect`,
          );
        }
      }
      context.broadcast("node.pair.resolved", resolved, { dropIfSlow: true });
      respond(true, { requestId: approved.requestId, node: approvedNode }, undefined);
    });
  },
  "node.pair.reject": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodePairRejectParams, "node.pair.reject", respond)) {
      return;
    }
    const { requestId } = params;
    await respondUnavailableOnThrow(respond, async () => {
      if (
        !(await enforcePendingNodePairingOwnership({
          requestId,
          mutation: "reject",
          client,
          context,
          respond,
        }))
      ) {
        return;
      }
      const rejected = await rejectNodePairing(requestId);
      if (!rejected) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown requestId"));
        return;
      }
      context.broadcast(
        "node.pair.resolved",
        {
          requestId,
          nodeId: rejected.nodeId,
          decision: "rejected",
          ts: Date.now(),
        },
        { dropIfSlow: true },
      );
      respond(true, rejected, undefined);
    });
  },
  // Remove a node pairing (CLI: `openclaw nodes remove`). This revokes the
  // device's `node` role in the paired-device store, which drops the approved node
  // surface with it, and disconnects the device's node-role sessions: a
  // mixed-role device keeps its row and only loses the `node` role, a
  // node-only device row is deleted. Authz mirrors device.pair.remove:
  // operator.pairing may remove non-operator node rows; a device-token caller
  // revoking its own node role on a mixed-role device additionally needs
  // operator.admin (see removePairedDeviceBackedNode).
  "node.pair.remove": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodePairRemoveParams, "node.pair.remove", respond)) {
      return;
    }
    const { nodeId } = params;
    await respondUnavailableOnThrow(respond, async () => {
      const deviceBacked = await removePairedDeviceBackedNode({ nodeId, client, context });
      if (deviceBacked.status === "denied") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, deviceBacked.message));
        return;
      }
      if (deviceBacked.status !== "removed") {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      try {
        clearRemovedNodeRuntimeState({ nodeId: deviceBacked.nodeId, context });
        await reconcileRevokedDeviceWorker(context, deviceBacked.nodeId);
        // Removing the pairing retires the device's mirrored occupancy leases:
        // the node clears its own occupancy when the hard close lands, so no
        // revoke invoke happens here. The dropped mirrors record the delete.
        releaseRemovedDeviceScopeLeases({ deviceId: deviceBacked.nodeId });
        context.broadcast(
          "node.pair.resolved",
          {
            requestId: "",
            nodeId: deviceBacked.nodeId,
            decision: "removed",
            ts: Date.now(),
          },
          { dropIfSlow: true },
        );
        respond(true, { nodeId: deviceBacked.nodeId }, undefined);
      } finally {
        // Preserve response-first shutdown on success, while guaranteeing the
        // hard close when runtime cleanup or later bookkeeping throws.
        queueMicrotask(() => {
          context.disconnectClientsForDevice?.(deviceBacked.nodeId, {
            role: "node",
          });
        });
      }
    });
  },
  "node.rename": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodeRenameParams, "node.rename", respond)) {
      return;
    }
    const { nodeId, displayName } = params;
    await respondUnavailableOnThrow(respond, async () => {
      const authz = resolveDeviceManagementAuthz(client, nodeId);
      if (deniesCrossDeviceManagement(authz)) {
        context.logGateway.warn(
          `node rename denied node=${authz.normalizedTargetDeviceId} reason=device-ownership-mismatch`,
        );
        emitNodePairingDeniedSecurityEvent({
          authz,
          nodeId: authz.normalizedTargetDeviceId,
          controlId: "node.rename",
          reason: "device-ownership-mismatch",
        });
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "node rename denied"));
        return;
      }
      const trimmed = displayName.trim();
      if (!trimmed) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "displayName required"));
        return;
      }
      const updated = await renamePairedNode(nodeId, trimmed);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(true, { nodeId: updated.nodeId, displayName: updated.displayName }, undefined);
    });
  },
  // Device-registry transitions (settings: enable/disable a device, edit its
  // per-device command policy). Both directions invalidate the device's node
  // clients so the node reconnects and is re-admitted against fresh registry
  // state; disable additionally empties the live surface, aborts pending and
  // in-flight work, and reconciles device-backed workers — the same cleanup
  // trio as node.pair.remove, minus deleting the pairing record.
  "node.device.enable": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodeDeviceEnableParams, "node.device.enable", respond)) {
      return;
    }
    const nodeId = readDeviceNodeId(params, respond);
    if (!nodeId) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const authz = resolveDeviceManagementAuthz(client, nodeId);
      if (deniesCrossDeviceManagement(authz)) {
        context.logGateway.warn(
          `node device enable denied node=${authz.normalizedTargetDeviceId} reason=device-ownership-mismatch`,
        );
        emitNodeDeviceRegistrySecurityEvent({
          authz,
          nodeId: authz.normalizedTargetDeviceId,
          controlId: "node.device.enable",
          outcome: "denied",
          reason: "device-ownership-mismatch",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "node device enable denied"),
        );
        return;
      }
      const updated = await setPairedNodeDeviceEnabled(nodeId, true);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      emitNodeDeviceRegistrySecurityEvent({
        authz,
        nodeId: updated.nodeId,
        controlId: "node.device.enable",
        outcome: "success",
        attributes: { enabled: true },
      });
      context.logGateway.info(`node device enabled device=${updated.nodeId}`);
      context.invalidateClientsForDevice?.(updated.nodeId, {
        role: "node",
        reason: "device-enabled",
      });
      respond(true, updated, undefined);
    });
  },
  "node.device.disable": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(params, validateNodeDeviceDisableParams, "node.device.disable", respond)
    ) {
      return;
    }
    const nodeId = readDeviceNodeId(params, respond);
    if (!nodeId) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const authz = resolveDeviceManagementAuthz(client, nodeId);
      if (deniesCrossDeviceManagement(authz)) {
        context.logGateway.warn(
          `node device disable denied node=${authz.normalizedTargetDeviceId} reason=device-ownership-mismatch`,
        );
        emitNodeDeviceRegistrySecurityEvent({
          authz,
          nodeId: authz.normalizedTargetDeviceId,
          controlId: "node.device.disable",
          outcome: "denied",
          reason: "device-ownership-mismatch",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "node device disable denied"),
        );
        return;
      }
      const disabled = await setPairedNodeDeviceEnabled(nodeId, false);
      if (!disabled) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      try {
        // Revoke the device's occupancy lease while the node is still connected:
        // a disabled device must not stay reserved, and the node tree-kills the
        // holder's processes as part of the revoke contract.
        await revokeDeviceScopeLeases({
          registry: context.nodeRegistry,
          deviceId: disabled.nodeId,
        });
        // Empty the live surface and abort queued/in-flight work before the
        // response so no further command dispatch can be admitted.
        clearRemovedNodeRuntimeState({ nodeId: disabled.nodeId, context });
        await reconcileRevokedDeviceWorker(context, disabled.nodeId);
        emitNodeDeviceRegistrySecurityEvent({
          authz,
          nodeId: disabled.nodeId,
          controlId: "node.device.disable",
          outcome: "success",
          attributes: { enabled: false },
        });
        context.logGateway.info(`node device disabled device=${disabled.nodeId}`);
        context.invalidateClientsForDevice?.(disabled.nodeId, {
          role: "node",
          reason: "device-disabled",
        });
        respond(true, disabled, undefined);
      } finally {
        // Preserve response-first shutdown on success, while guaranteeing the
        // hard close when runtime cleanup or later bookkeeping throws.
        queueMicrotask(() => {
          context.disconnectClientsForDevice?.(disabled.nodeId, {
            role: "node",
          });
        });
      }
    });
  },
  "node.device.update": async ({ params, respond, context, client }) => {
    if (!assertValidParams(params, validateNodeDeviceUpdateParams, "node.device.update", respond)) {
      return;
    }
    const nodeId = readDeviceNodeId(params, respond);
    if (!nodeId) {
      return;
    }
    const { commands } = params;
    await respondUnavailableOnThrow(respond, async () => {
      const authz = resolveDeviceManagementAuthz(client, nodeId);
      if (deniesCrossDeviceManagement(authz)) {
        context.logGateway.warn(
          `node device update denied node=${authz.normalizedTargetDeviceId} reason=device-ownership-mismatch`,
        );
        emitNodeDeviceRegistrySecurityEvent({
          authz,
          nodeId: authz.normalizedTargetDeviceId,
          controlId: "node.device.update",
          outcome: "denied",
          reason: "device-ownership-mismatch",
        });
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "node device update denied"),
        );
        return;
      }
      const updated = await setPairedNodeDeviceCommandPolicy(nodeId, commands ?? null);
      if (!updated) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      emitNodeDeviceRegistrySecurityEvent({
        authz,
        nodeId: updated.nodeId,
        controlId: "node.device.update",
        outcome: "success",
        attributes: {
          ...(updated.commandPolicy?.deny ? { deny_count: updated.commandPolicy.deny.length } : {}),
          ...(updated.commandPolicy?.allow
            ? { allow_count: updated.commandPolicy.allow.length }
            : {}),
        },
      });
      context.logGateway.info(`node device policy updated device=${updated.nodeId}`);
      context.invalidateClientsForDevice?.(updated.nodeId, {
        role: "node",
        reason: "device-policy-updated",
      });
      respond(true, updated, undefined);
    });
  },
};
