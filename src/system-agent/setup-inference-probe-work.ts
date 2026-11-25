import type { AgentExecutionAuthBinding } from "../agents/execution-auth-binding.js";
import { resolveMergedModelProviderEntry } from "../config/model-provider-config.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import type { SetupInferenceFailureStatus } from "./setup-inference-core.js";

/**
 * Reasoning-first models spend output tokens on thinking before their first
 * visible token, and providers count that thinking against `maxTokens`. The
 * setup probe used to cap output at 256 tokens, which the model could spend
 * inside reasoning (stopReason=length, no text); the runner then exhausted its
 * reasoning-only retries and the wizard reported a failed "Test & use" for a
 * model and credential that answer fine in chat. Keep room for the transport's
 * default 1024-token thinking budget plus a visible-output reserve, matching
 * PROBE_MIN_OUTPUT_TOKENS in src/commands/models/list.probe.ts; the probe
 * timeout, not this cap, bounds the wait.
 */
export const SETUP_INFERENCE_PROBE_MIN_OUTPUT_TOKENS = 2_048;

/**
 * Resolves the output cap for one setup probe. The floor gives reasoning models
 * room to think, but never exceeds the model's configured output cap: transports
 * that forward an explicit cap unchanged (anthropic-messages, openai-responses)
 * would otherwise reject the request as invalid instead of measuring the route.
 */
export function resolveSetupInferenceProbeOutputTokens(
  route: Pick<SystemAgentConfiguredRoute, "runConfig" | "provider" | "model">,
): number {
  const configuredMax = resolveMergedModelProviderEntry(
    route.runConfig,
    route.provider,
  )?.providerConfig.models?.find((model) => model.id === route.model)?.maxTokens;
  return configuredMax && configuredMax > 0
    ? Math.min(SETUP_INFERENCE_PROBE_MIN_OUTPUT_TOKENS, configuredMax)
    : SETUP_INFERENCE_PROBE_MIN_OUTPUT_TOKENS;
}

export type SetupTurnFailure = {
  ok: false;
  status: SetupInferenceFailureStatus;
  error: string;
};

export type SetupTurnSuccess = {
  ok: true;
  latencyMs: number;
  text: string;
  auth: AgentExecutionAuthBinding;
};

/** The probe is setup evidence, not a chat turn: its events must never reach Gateway projection. */
export function registerHiddenSetupInferenceProbeRun(
  runId: string,
  agentId: string,
  sessionKey: string,
) {
  registerAgentRunContext(runId, {
    agentId,
    sessionKey,
    isControlUiVisible: false,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
}

/** Setup must release the isolated probe generation before activation can replace it. */
export async function runSetupInferenceProbeWork<TParams, TResult>(
  run: (params: TParams) => Promise<TResult>,
  params: TParams,
): Promise<TResult> {
  const failures = new Set<unknown>();
  const work = new AsyncWorkScope(failures);
  let result: TResult;
  try {
    result = await work.track(() => run(params));
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [work],
      () => work.drain(),
    );
  }
  if (failures.size > 0) {
    throw new AggregateError([...failures], "Inference setup probe cleanup did not finish safely.");
  }
  return result;
}
