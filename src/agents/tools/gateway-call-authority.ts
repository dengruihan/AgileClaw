import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createAgentRuntimeExecutionLineageHandoff,
  readAgentRuntimeExecutionLineage,
} from "../../gateway/agent-runtime-execution-lineage.js";
import {
  createAgentRuntimeIdentity,
  mintAgentRuntimeIdentityToken,
  verifyAgentRuntimeIdentityToken,
  type AgentRuntimeIdentity,
  type AgentRuntimeIdentityTokenParams,
} from "../../gateway/agent-runtime-identity-token.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import { resolveMessageActionTurnCapability } from "../../gateway/message-action-turn-capability.js";
import { getOperatorApprovalRuntimeToken } from "../../gateway/operator-approval-runtime-token.js";
import {
  claimAgentRunApprovalAuthority,
  getActiveAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import {
  loadDeviceIdentityIfPresentAsync,
  loadOrCreateDeviceIdentityAsync,
} from "../../infra/device-identity-async.js";
import type { DeviceIdentity } from "../../infra/device-identity.js";
import type { GatewayCallOptions, GatewayOverrideTarget } from "./gateway-call-options.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { getGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { getGatewaySessionSpawnParentExecutionIdentityToken } from "./gateway-session-spawn-execution-identity.js";

const APPROVAL_RUNTIME_METHODS = new Set<string>([
  "exec.approval.request",
  "exec.approval.resolve",
  "exec.approval.waitDecision",
  "plugin.approval.request",
  "plugin.approval.waitDecision",
]);

const AGENT_RUNTIME_IDENTITY_METHODS = new Set<string>([
  "exec.approval.request",
  "plugin.approval.request",
  "wake",
  "cron.list",
  "cron.get",
  "cron.add",
  "cron.update",
  "cron.remove",
  "cron.run",
  "cron.runs",
  "secrets.store.delete",
]);

const OPTIONAL_LOCAL_AGENT_RUNTIME_IDENTITY_METHODS = new Set<string>([
  "ui.command",
  "node.invoke",
  "computer.invoke",
  "question.request",
]);

export function resolveApprovalRuntimeTokenForGatewayTool(params: {
  method: string;
  opts: GatewayCallOptions;
  target: GatewayOverrideTarget;
}): string | undefined {
  if (!APPROVAL_RUNTIME_METHODS.has(params.method)) {
    return undefined;
  }
  if (trimToUndefined(params.opts.gatewayUrl) !== undefined) {
    // Runtime approval tokens are scoped to the local approval bridge, not arbitrary
    // caller-supplied gateway URLs.
    return undefined;
  }
  if (params.target !== "local") {
    return undefined;
  }
  return getOperatorApprovalRuntimeToken();
}

function isApprovalReplayNodeSystemRun(method: string, callParams: unknown): boolean {
  const invoke = method === "node.invoke" ? asNullableRecord(callParams) : null;
  const run = invoke?.command === "system.run" ? asNullableRecord(invoke.params) : null;
  const decision = normalizeOptionalString(run?.approvalDecision);
  return run?.approved === true || decision === "allow-once" || decision === "allow-always";
}

export function attachNodeInvokeTurnSource(method: string, params: unknown): unknown {
  if (method !== "node.invoke") {
    return params;
  }
  const invoke = asNullableRecord(params);
  const caller = getGatewayToolCallerIdentity();
  if (!invoke || !caller) {
    return params;
  }
  return {
    ...omitNodeInvokeTurnSource(invoke),
    ...(caller.turnSourceChannel ? { turnSourceChannel: caller.turnSourceChannel } : {}),
    ...(caller.turnSourceTo ? { turnSourceTo: caller.turnSourceTo } : {}),
    ...(caller.turnSourceAccountId ? { turnSourceAccountId: caller.turnSourceAccountId } : {}),
    ...(caller.turnSourceThreadId !== undefined
      ? { turnSourceThreadId: caller.turnSourceThreadId }
      : {}),
  };
}

function omitNodeInvokeTurnSource(invoke: Record<string, unknown>): Record<string, unknown> {
  const legacyParams = { ...invoke };
  delete legacyParams.turnSourceChannel;
  delete legacyParams.turnSourceTo;
  delete legacyParams.turnSourceAccountId;
  delete legacyParams.turnSourceThreadId;
  return legacyParams;
}

export function stripNodeInvokeTurnSource(params: unknown): unknown {
  const invoke = asNullableRecord(params);
  return invoke ? omitNodeInvokeTurnSource(invoke) : params;
}

export async function resolveApprovalRequesterDeviceIdentityForGatewayTool(params: {
  method: string;
  callParams: unknown;
  opts: GatewayCallOptions;
  approvalRuntimeToken: string | undefined;
}): Promise<DeviceIdentity | undefined> {
  const isApprovalRuntimeMethod = APPROVAL_RUNTIME_METHODS.has(params.method);
  const isNodeApprovalReplay = isApprovalReplayNodeSystemRun(params.method, params.callParams);
  if (!isApprovalRuntimeMethod && !isNodeApprovalReplay) {
    return undefined;
  }
  if (isApprovalRuntimeMethod && trimToUndefined(params.opts.gatewayUrl) !== undefined) {
    return undefined;
  }
  if (params.approvalRuntimeToken !== undefined) {
    // The approval-runtime token already proves this is the local approval bridge, and
    // the gateway grants record visibility from it. Sending the shared device identity
    // too would put the connect back under that device's paired role/scope baseline,
    // so an operator paired before operator.approvals existed can never reach the
    // prompt that would re-pair it. Same rule as the operator approvals client.
    return undefined;
  }
  try {
    if (isNodeApprovalReplay) {
      // Replay must reuse the identity present when the approval was registered.
      // Creating one here could turn a device-less record into a different identity.
      const identity = await loadDeviceIdentityIfPresentAsync();
      if (!identity) {
        throw new Error("device identity is not persisted");
      }
      return identity;
    }
    return await loadOrCreateDeviceIdentityAsync();
  } catch (error) {
    if (isNodeApprovalReplay) {
      throw new Error(
        [
          "approved node gateway calls require a stable device identity.",
          "Fix the AgileClaw state directory permissions and retry the approval.",
        ].join(" "),
        { cause: error },
      );
    }
    throw new Error(
      [
        "remote approval gateway calls require a stable device identity.",
        "Fix the AgileClaw state directory permissions or use the local approval-runtime gateway.",
      ].join(" "),
      { cause: error },
    );
  }
}

export async function resolveAgentRuntimeIdentityForGatewayTool(params: {
  method: string;
  opts: GatewayCallOptions;
  target: GatewayOverrideTarget;
  required?: boolean;
  signal?: AbortSignal;
  inProcess: boolean;
}): Promise<string | AgentRuntimeIdentity | undefined> {
  const optionalLocalIdentity = OPTIONAL_LOCAL_AGENT_RUNTIME_IDENTITY_METHODS.has(params.method);
  if (
    !params.required &&
    !AGENT_RUNTIME_IDENTITY_METHODS.has(params.method) &&
    !optionalLocalIdentity
  ) {
    return undefined;
  }
  const identity = getGatewayToolCallerIdentity();
  if (!identity) {
    if (params.required) {
      throw new Error("trusted agent runtime identity required for this gateway call");
    }
    return undefined;
  }
  const hasGatewayUrlOverride = trimToUndefined(params.opts.gatewayUrl) !== undefined;
  const hasGatewayTokenOverride = trimToUndefined(params.opts.gatewayToken) !== undefined;
  if (hasGatewayUrlOverride || hasGatewayTokenOverride || params.target !== "local") {
    // Optional provenance must never turn a supported remote call into an auth failure.
    if (optionalLocalIdentity && !params.required) {
      return undefined;
    }
    throw new Error("agent gateway calls require the trusted local gateway context");
  }
  if (identity.signedAgentRuntimeIdentityToken) {
    if (!params.inProcess) {
      return identity.signedAgentRuntimeIdentityToken;
    }
    const verified = await verifyAgentRuntimeIdentityToken(
      identity.signedAgentRuntimeIdentityToken,
    );
    if (!verified) {
      throw new Error("invalid agent runtime identity token");
    }
    return verified;
  }
  // Independent CLI runs have local claims, not authority in the target Gateway.
  if (optionalLocalIdentity && !params.required && !identity.gatewayContextResolver) {
    return undefined;
  }
  if (!identity.operationalRunInstance) {
    if (optionalLocalIdentity && !params.required) {
      return undefined;
    }
    throw new Error("trusted operational run instance required for this gateway call");
  }
  try {
    const sessionSpawnContext = getGatewaySessionSpawnContext();
    const parentExecutionIdentityToken = getGatewaySessionSpawnParentExecutionIdentityToken();
    const activeAuthority =
      identity.approvalAuthority ??
      getActiveAgentRunDelegatedAuthority(identity.operationalRunInstance);
    const executionLineage = readAgentRuntimeExecutionLineage(sessionSpawnContext);
    if (executionLineage && !activeAuthority) {
      throw new Error("execution lineage handoff requires active parent authority");
    }
    const lineageHandoff =
      sessionSpawnContext && executionLineage && activeAuthority
        ? createAgentRuntimeExecutionLineageHandoff({
            agentId: identity.agentId,
            sessionKey: identity.sessionKey,
            operationalRunInstance: identity.operationalRunInstance,
            delegatedAuthority: activeAuthority,
            ...(parentExecutionIdentityToken
              ? { executionIdentity: parentExecutionIdentityToken }
              : {}),
            sessionSpawnContext,
          })
        : undefined;
    if (executionLineage && !lineageHandoff) {
      throw new Error("execution lineage handoff could not bind the parent admission");
    }
    try {
      // A request lifetime narrows inherited tool lifetimes; neither may replace the other.
      const approvalSignals =
        params.method === "exec.approval.request" || params.method === "plugin.approval.request"
          ? [...(identity.approvalSignals ?? []), ...(params.signal ? [params.signal] : [])]
          : undefined;
      const approvalAuthority =
        activeAuthority && approvalSignals?.length
          ? claimAgentRunApprovalAuthority(activeAuthority, approvalSignals)
          : activeAuthority;
      const prepared: AgentRuntimeIdentityTokenParams = {
        ...identity,
        operationalRunInstance: identity.operationalRunInstance,
        approvalAuthority,
        ...(lineageHandoff ? { executionIdentityToken: undefined } : {}),
        ...(lineageHandoff
          ? { executionLineageHandoffId: lineageHandoff.id }
          : sessionSpawnContext
            ? { executionIdentityToken: parentExecutionIdentityToken, sessionSpawnContext }
            : {}),
      };
      if (!params.inProcess) {
        return await mintAgentRuntimeIdentityToken(prepared);
      }
      const runtimeIdentity = await createAgentRuntimeIdentity(prepared);
      if (!runtimeIdentity) {
        throw new Error("invalid agent runtime identity");
      }
      return runtimeIdentity;
    } catch (error) {
      lineageHandoff?.revoke();
      throw error;
    }
  } catch (error) {
    if (optionalLocalIdentity && !params.required) {
      return undefined;
    }
    throw error;
  }
}

type MessageActionAgentRuntimeIdentityParams = {
  opts: GatewayCallOptions;
  target: "local" | "remote";
  turnCapability?: string;
  turnCapabilitySessionKey?: string;
  runId?: string;
  sessionId?: string;
  sourceReplyFinal?: boolean;
  sourceReplyToolCallId?: string;
  callerOwnsTerminalReceipt?: boolean;
};

async function resolveMessageActionIdentity<T>(
  params: MessageActionAgentRuntimeIdentityParams,
  createIdentity: (params: AgentRuntimeIdentityTokenParams) => Promise<T | undefined>,
): Promise<T | undefined> {
  const terminalSourceReply = params.sourceReplyFinal === true;
  const sourceReplyToolCallId = normalizeOptionalString(params.sourceReplyToolCallId);
  if (terminalSourceReply && !sourceReplyToolCallId) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  const identity = getGatewayToolCallerIdentity();
  if (!identity) {
    if (terminalSourceReply) {
      throw new Error("terminal source reply requires trusted agent runtime identity");
    }
    return undefined;
  }
  const hasGatewayUrlOverride = trimToUndefined(params.opts.gatewayUrl) !== undefined;
  const hasGatewayTokenOverride = trimToUndefined(params.opts.gatewayToken) !== undefined;
  const usesUntrustedGatewayContext =
    hasGatewayUrlOverride || hasGatewayTokenOverride || params.target !== "local";
  if (usesUntrustedGatewayContext && !terminalSourceReply) {
    return undefined;
  }
  const turnCapabilitySessionKey =
    normalizeOptionalString(params.turnCapabilitySessionKey) ?? identity.sessionKey;
  const messageActionContext = resolveMessageActionTurnCapability({
    token: params.turnCapability,
    agentId: identity.agentId,
    runId: params.runId,
    sessionKey: turnCapabilitySessionKey,
    sessionId: params.sessionId,
  });
  if (!messageActionContext) {
    if (terminalSourceReply) {
      throw new Error("terminal source reply requires an active turn capability");
    }
    return undefined;
  }
  if (
    terminalSourceReply &&
    !normalizeOptionalString(messageActionContext.toolContext?.currentSourceTurnId)
  ) {
    throw new Error("terminal source reply requires source-turn correlation");
  }
  if (usesUntrustedGatewayContext) {
    if (params.callerOwnsTerminalReceipt !== true) {
      throw new Error("terminal source reply requires the trusted local gateway context");
    }
    // Remote gateways cannot trust caller-supplied turn metadata. The agent
    // process owns the durable receipt and sends no source authority over RPC.
    return undefined;
  }
  if (!identity.operationalRunInstance) {
    if (terminalSourceReply) {
      throw new Error("terminal source reply requires a trusted operational run instance");
    }
    return undefined;
  }
  const resolvedMessageActionContext = terminalSourceReply
    ? {
        ...messageActionContext,
        turnCapability: params.turnCapability,
        sourceReplyFinal: true as const,
        sourceReplyToolCallId: sourceReplyToolCallId!,
      }
    : {
        ...messageActionContext,
        turnCapability: params.turnCapability,
        ...(params.sourceReplyFinal === false ? { sourceReplyFinal: false as const } : {}),
        ...(sourceReplyToolCallId ? { sourceReplyToolCallId } : {}),
      };
  return await createIdentity({
    ...identity,
    sessionKey: turnCapabilitySessionKey,
    operationalRunInstance: identity.operationalRunInstance,
    messageActionContext: resolvedMessageActionContext,
  });
}

export async function resolveMessageActionAgentRuntimeIdentityToken(
  params: MessageActionAgentRuntimeIdentityParams,
): Promise<string | undefined> {
  return await resolveMessageActionIdentity(params, mintAgentRuntimeIdentityToken);
}

export async function resolveMessageActionAgentRuntimeIdentity(
  params: MessageActionAgentRuntimeIdentityParams,
): Promise<AgentRuntimeIdentity | undefined> {
  return await resolveMessageActionIdentity(params, async (prepared) => {
    const identity = await createAgentRuntimeIdentity(prepared);
    if (!identity) {
      throw new Error("invalid agent runtime identity");
    }
    return identity;
  });
}
