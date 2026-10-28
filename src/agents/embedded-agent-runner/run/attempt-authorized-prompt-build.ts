import type { HookRunner } from "../../../plugins/hooks.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforePromptBuildEvent,
} from "../../../plugins/types.js";
import type { AgentSession } from "../../sessions/index.js";
import {
  createAttemptTurnContextContributionsCapability,
  getAttemptTurnContextManager,
} from "./attempt-turn-context.js";

/** Initial prompts and consumed steering inputs share post-policy hook admission. */
export async function runEmbeddedAttemptAuthorizedPromptBuild(input: {
  hookRunner: HookRunner | null | undefined;
  hookCtx: PluginHookAgentContext;
  event: PluginHookBeforePromptBuildEvent;
  activeSession: AgentSession;
  runId: string;
  inputId?: string;
  toolAuthorityFingerprint?: string;
  activeToolNames: readonly string[];
  readCallableToolNames?: () => readonly string[];
  assertHostActive?: () => void;
  runAbortSignal?: AbortSignal;
}) {
  const { hookRunner, assertHostActive, toolAuthorityFingerprint } = input;
  if (!hookRunner || !assertHostActive || !toolAuthorityFingerprint || !input.runId) {
    return undefined;
  }
  const isCurrentInput = () => {
    const manager = getAttemptTurnContextManager(input.runId);
    return !input.inputId || !manager || manager.currentInputId === input.inputId;
  };
  if (!isCurrentInput()) {
    return undefined;
  }
  input.runAbortSignal?.throwIfAborted();
  assertHostActive();
  const turnContextContributions = createAttemptTurnContextContributionsCapability({
    eligible: hookRunner.hasAuthorizedPromptBuildHooks(input.hookCtx),
    runId: input.runId,
    inputId: input.inputId,
    runAbortSignal: input.runAbortSignal,
    assertHostActive,
    assertMemoryAudienceCurrent: input.hookCtx.assertMemoryAudienceCurrent,
    allowsTool: (toolName) =>
      (input.readCallableToolNames?.() ?? input.activeSession.getActiveToolNames()).includes(
        toolName,
      ),
  });
  const result = await hookRunner.runAuthorizedPromptBuild(
    input.event,
    turnContextContributions ? { ...input.hookCtx, turnContextContributions } : input.hookCtx,
    {
      toolAuthorityFingerprint,
      activeToolNames: input.activeToolNames,
      assertHostActive,
    },
  );
  return isCurrentInput() ? result : undefined;
}
