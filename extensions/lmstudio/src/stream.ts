import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  applyModelCompatPatch,
  type ModelCompatConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  createOpenAICompatibleCompletionsThinkingOffWrapper,
  createPlainTextToolCallCompatWrapper,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LMSTUDIO_PROVIDER_ID } from "./defaults.js";

type StreamModel = Parameters<StreamFn>[0];

function withLmstudioUsageCompat(model: StreamModel): StreamModel {
  // Tool-schema policy fields live on the config-side ModelCompatConfig; the
  // per-api runtime compat unions omit them and transports read them structurally.
  const compat = model.compat as ModelCompatConfig | undefined;
  return applyModelCompatPatch(model as StreamModel & { compat?: ModelCompatConfig }, {
    supportsUsageInStreaming: true,
    // LM Studio's GGUF grammar rejects regex constraints; the shared transport
    // removes this keyword recursively while preserving native tool calling.
    unsupportedToolSchemaKeywords: uniqueStrings([
      ...(compat?.unsupportedToolSchemaKeywords ?? []),
      "pattern",
    ]),
  }) as StreamModel;
}

/** Runs inference against the model the operator has already loaded in LM Studio. */
export function wrapLmstudioInference(ctx: ProviderWrapStreamFnContext): StreamFn {
  const underlying = ctx.streamFn ?? streamSimple;
  const streamWithCompat = createOpenAICompatibleCompletionsThinkingOffWrapper(
    createPlainTextToolCallCompatWrapper(underlying),
    ctx.thinkingLevel,
  );
  return (model, context, options) =>
    streamWithCompat(
      model.provider === LMSTUDIO_PROVIDER_ID ? withLmstudioUsageCompat(model) : model,
      context,
      options,
    );
}
