/**
 * Step rule for device scope switching, enforced at the tool batch boundary.
 *
 * `use_device` must be the only placement-affecting call in its step: a scope
 * change applies at the next step boundary, so a placement call that shares a
 * batch with it runs on an unintended scope — before the switch on the old
 * scope, or after it on the new one mid-batch. The routing layer only rejected
 * calls that start while the switch is in flight, so a placement call ordered
 * before `use_device` ran silently on the old scope.
 *
 * This guard wraps `use_device` and every placement-kind tool once per run and
 * uses the agent loop's per-call execution context (the assistant message) as
 * the batch identity. Any batch that mixes the two is rejected per call with a
 * clear error before the scope-affecting work runs: `use_device` refuses to
 * start after placement calls already ran (the switch is not attempted and the
 * session keeps its committed scope), placement calls refuse to run after
 * a switch attempt in the same batch, whatever its outcome, and a second
 * use_device in the same batch is rejected before it can override the first.
 * Calls outside an agent-loop batch context keep the routing layer's in-flight
 * guard only.
 */
import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { copyAgentToolMetadata, getAgentToolExecutionLocation } from "../../agent-tool-metadata.js";
import type { AnyAgentTool } from "../../agent-tools.types.js";
import { USE_DEVICE_TOOL_NAME } from "../../tools/use-device-tool.js";

const STEP_GUARDED_TOOLS = new WeakSet<object>();

type DeviceStepScope = {
  /** Assistant message identity: one model step equals one tool batch. */
  assistantMessage: object;
  /** Placement tool names that started in this step. */
  placementTools: string[];
  /** A use_device attempt started in this step. */
  switchSeen: boolean;
};

function deviceStepPlacementBlockedMessage(toolName: string): string {
  return (
    `use_device ran earlier in this step, so its scope change does not apply to tool ${toolName} ` +
    "in the same step. use_device must be the only placement-affecting call in its step; retry " +
    `${toolName} in the next step.`
  );
}

function deviceStepSwitchBlockedMessage(placementTools: readonly string[]): string {
  const names = [...new Set(placementTools)].join(", ");
  return (
    `use_device must be the only placement-affecting call in its step; ${names} already ran in ` +
    "this step. The switch was not attempted and the session keeps its committed scope; call " +
    "use_device alone, then run placement tools in the next step."
  );
}

function deviceStepSecondSwitchBlockedMessage(): string {
  return (
    "use_device already ran in this step, and it must be the only placement-affecting call in " +
    "its step. This switch was not attempted and the session keeps the scope committed by the " +
    "earlier use_device call; call use_device again in the next step."
  );
}

/**
 * Wrap the assembled tool surface so a batch mixing `use_device` with other
 * placement-affecting calls fails per call instead of running on an unintended
 * scope. The catalog stays constant; tools are returned as-is when the surface
 * has no use_device tool, so nothing changes for device-less sessions.
 */
export function applyDeviceStepRuleBatchGuard(tools: AnyAgentTool[]): AnyAgentTool[] {
  if (!tools.some((tool) => tool.name === USE_DEVICE_TOOL_NAME)) {
    return tools;
  }
  let step: DeviceStepScope | undefined;
  const currentStep = (): DeviceStepScope | undefined => {
    const assistantMessage = getAgentToolExecutionContext()?.assistantMessage;
    if (!assistantMessage) {
      return undefined;
    }
    if (step?.assistantMessage !== assistantMessage) {
      step = { assistantMessage, placementTools: [], switchSeen: false };
    }
    return step;
  };
  return tools.map((tool) => {
    const isSwitch = tool.name === USE_DEVICE_TOOL_NAME;
    if (!isSwitch && getAgentToolExecutionLocation(tool).kind !== "placement") {
      return tool;
    }
    // A guarded tool already carries this run's step tracking; re-wrapping
    // would swap in a fresh tracker mid-run.
    if (STEP_GUARDED_TOOLS.has(tool)) {
      return tool;
    }
    const source = tool;
    const guarded: AnyAgentTool = {
      ...source,
      execute: async (toolCallId, toolParams, signal, onUpdate) => {
        const stepScope = currentStep();
        if (isSwitch) {
          // A second switch in the same batch would silently override the
          // first: reject it before it reaches the session patch owner.
          if (stepScope?.switchSeen) {
            throw new Error(deviceStepSecondSwitchBlockedMessage());
          }
          if (stepScope && stepScope.placementTools.length > 0) {
            throw new Error(deviceStepSwitchBlockedMessage(stepScope.placementTools));
          }
          if (stepScope) {
            // The attempt itself owns the step, committed or failed: later
            // placement calls in this batch must wait for the next one.
            stepScope.switchSeen = true;
          }
        } else {
          if (stepScope?.switchSeen) {
            throw new Error(deviceStepPlacementBlockedMessage(source.name));
          }
          // Record at entry, before the first await, so a switch attempt that
          // starts while this call is still in flight sees it.
          stepScope?.placementTools.push(source.name);
        }
        return await source.execute(toolCallId, toolParams, signal, onUpdate);
      },
    };
    STEP_GUARDED_TOOLS.add(guarded);
    return copyAgentToolMetadata(source, guarded);
  });
}
