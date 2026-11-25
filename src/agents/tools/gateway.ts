import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY } from "../../../packages/gateway-protocol/src/system-run-execution-context.js";
import { callGateway, type CallGatewayOptions } from "../../gateway/call.js";
import { trimToUndefined } from "../../gateway/credentials.js";
import {
  resolveLeastPrivilegeOperatorScopesForMethod,
  type OperatorScope,
} from "../../gateway/method-scopes.js";
import type { GatewayNodeInvokeStream } from "../../gateway/server-methods/types.js";
import {
  attachNodeInvokeTurnSource,
  resolveAgentRuntimeIdentityForGatewayTool,
  resolveApprovalRequesterDeviceIdentityForGatewayTool,
  resolveApprovalRuntimeTokenForGatewayTool,
  stripNodeInvokeTurnSource,
} from "./gateway-call-authority.js";
import { resolveGatewayOptions, type GatewayCallOptions } from "./gateway-call-options.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  isStaleGatewayAgentRuntimeIdentityRejection,
  isStaleGatewayNodeInvokeTurnSourceRejection,
  staleGatewayAgentRuntimeIdentityError,
} from "./gateway-transport-errors.js";

export type { GatewayCallOptions } from "./gateway-call-options.js";
export { readGatewayCallOptions, resolveGatewayOptions } from "./gateway-call-options.js";
export {
  resolveMessageActionAgentRuntimeIdentity,
  resolveMessageActionAgentRuntimeIdentityToken,
} from "./gateway-call-authority.js";

/** Presentation hint from the admitted operator source; RPC admission remains authoritative. */
export function readGatewayToolOperatorScopes(): readonly string[] | undefined {
  const authority = getGatewayToolCallerIdentity()?.operatorAuthority;
  if (!authority) {
    return undefined;
  }
  authority.assertCurrent();
  return [...authority.scopes];
}

/** Explicit destinations remain transport calls; retired hosted bindings must reject locally. */
export function shouldUseInProcessGatewayTool(opts: GatewayCallOptions): boolean {
  const resolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  return (
    Boolean(resolver) &&
    !trimToUndefined(opts.gatewayUrl) &&
    !trimToUndefined(opts.gatewayToken) &&
    resolver?.()?.localEmbedded !== true
  );
}

export async function callGatewayTool<T = Record<string, unknown>>(
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: {
    expectFinal?: boolean;
    scopes?: OperatorScope[];
    requireAgentRuntimeIdentity?: boolean;
    signal?: AbortSignal;
    onHelloOk?: CallGatewayOptions["onHelloOk"];
    dispatchAuthority?: { version: 2; kind: "run" | "source-bound"; assertCurrent: () => void };
    /** In-process node.invoke streaming; ignored on the transport fallback. */
    nodeInvokeStream?: GatewayNodeInvokeStream;
  },
) {
  const dispatchAuthority = extra?.dispatchAuthority;
  if (
    dispatchAuthority &&
    (dispatchAuthority.version !== 2 || typeof dispatchAuthority.assertCurrent !== "function")
  ) {
    throw new Error("Gateway dispatch authority requires version 2 and a synchronous assertion");
  }
  const inProcess = shouldUseInProcessGatewayTool(opts);
  const gateway = resolveGatewayOptions(opts);
  const resolveGatewayContext = getGatewayToolCallerIdentity()?.gatewayContextResolver;
  const callParams = attachNodeInvokeTurnSource(method, params);
  const nodeInvoke = method === "node.invoke" ? asNullableRecord(callParams) : null;
  const scopes = Array.isArray(extra?.scopes)
    ? extra.scopes
    : resolveLeastPrivilegeOperatorScopesForMethod(method, callParams);
  const runtimeIdentity = await resolveAgentRuntimeIdentityForGatewayTool({
    method,
    opts,
    target: inProcess ? "local" : gateway.target,
    required: extra?.requireAgentRuntimeIdentity,
    signal: extra?.signal,
    inProcess,
  });
  if (inProcess) {
    if (typeof runtimeIdentity === "string") {
      throw new Error("in-process Gateway requests require an internal runtime identity");
    }
    const { callAgentToolGatewayRequest, withAgentToolGatewayRuntimeIdentity } =
      await import("./in-process-gateway.js");
    return await callAgentToolGatewayRequest<T>(
      withAgentToolGatewayRuntimeIdentity(
        {
          method,
          params: callParams,
          timeoutMs: gateway.timeoutMs,
          signal: extra?.signal,
          expectFinal: extra?.expectFinal,
          assertDispatchCurrent: dispatchAuthority?.assertCurrent,
          ...(extra?.nodeInvokeStream ? { nodeInvokeStream: extra.nodeInvokeStream } : {}),
          ...(Array.isArray(extra?.scopes) ? { scopes } : {}),
        },
        runtimeIdentity,
      ),
    );
  }
  const agentRuntimeIdentityToken =
    typeof runtimeIdentity === "string" ? runtimeIdentity : undefined;
  const approvalRuntimeToken = resolveApprovalRuntimeTokenForGatewayTool({
    method,
    opts,
    target: gateway.target,
  });
  const deviceIdentity = await resolveApprovalRequesterDeviceIdentityForGatewayTool({
    method,
    callParams,
    opts,
    approvalRuntimeToken,
  });
  const callOptions = {
    ...(gateway.localPortOverride !== undefined
      ? {
          config: gateway.config,
          localPortOverride: gateway.localPortOverride,
          ignoreEnvUrlOverride: gateway.ignoreEnvUrlOverride,
          tlsFingerprint: gateway.tlsFingerprint,
        }
      : {}),
    url: gateway.url,
    token: gateway.token,
    method,
    params: callParams,
    timeoutMs: gateway.timeoutMs,
    signal: extra?.signal,
    expectFinal: extra?.expectFinal,
    onHelloOk: extra?.onHelloOk,
    requiredCapabilities:
      (nodeInvoke?.command === "system.run" || nodeInvoke?.command === "system.run.prepare") &&
      asNullableRecord(nodeInvoke.params)?.executionContext !== undefined
        ? [SYSTEM_RUN_EXECUTION_CONTEXT_CAPABILITY]
        : undefined,
    assertDispatchCurrent: extra?.dispatchAuthority?.assertCurrent,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "agent",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    ...(approvalRuntimeToken ? { approvalRuntimeToken } : {}),
    ...(agentRuntimeIdentityToken ? { agentRuntimeIdentityToken } : {}),
    ...(deviceIdentity ? { deviceIdentity } : {}),
    scopes,
  };
  const dispatch = (options: typeof callOptions) => {
    // Token minting and a prior RPC may await; never downgrade a retired owner.
    if (resolveGatewayContext && !resolveGatewayContext()) {
      throw new Error("The admitting Gateway is no longer available. Retry from a new agent run.");
    }
    return callGateway<T>(options);
  };
  try {
    return await dispatch(callOptions);
  } catch (error) {
    if (method === "node.invoke" && isStaleGatewayNodeInvokeTurnSourceRejection(error)) {
      return await dispatch({
        ...callOptions,
        params: stripNodeInvokeTurnSource(callOptions.params),
      });
    }
    if (agentRuntimeIdentityToken && isStaleGatewayAgentRuntimeIdentityRejection(error)) {
      if (method === "node.invoke" && extra?.requireAgentRuntimeIdentity !== true) {
        return await dispatch({
          ...callOptions,
          params: stripNodeInvokeTurnSource(callOptions.params),
          agentRuntimeIdentityToken: undefined,
        });
      }
      throw staleGatewayAgentRuntimeIdentityError(error);
    }
    throw error;
  }
}
