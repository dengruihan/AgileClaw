import {
  MODEL_DATA_APIS,
  MODEL_DATA_THINKING_FORMATS,
} from "../../packages/llm-core/src/model-data.js";
import type { OpenAICompletionsCompat } from "../llm/types.js";
import { isStringOption } from "../utils/string-readers.js";

/** Provider API adapter ids accepted by model/provider config and schema generation. */
export const MODEL_APIS = [...MODEL_DATA_APIS] as const;

export type ModelApi = (typeof MODEL_APIS)[number];

/** Model APIs supported without native-account or cloud-identity authentication. */
export const API_KEY_MODEL_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-interactions",
  "ollama",
  "pi-messages",
  "azure-openai-responses",
] as const satisfies readonly ModelApi[];

export type ApiKeyModelApi = (typeof API_KEY_MODEL_APIS)[number];

/** Runtime guard shared by config validation and API-family discovery. */
export function isApiKeyModelApi(value: string): value is ApiKeyModelApi {
  return isStringOption(value, API_KEY_MODEL_APIS);
}

export type SupportedThinkingFormat =
  | NonNullable<OpenAICompletionsCompat["thinkingFormat"]>
  | "deepseek"
  | "openrouter"
  | "together";

/** Thinking/reasoning payload dialects emitted by OpenAI-compatible providers. */
export const MODEL_THINKING_FORMATS = [
  ...MODEL_DATA_THINKING_FORMATS,
] as const satisfies readonly SupportedThinkingFormat[];

/** Runtime guard for config-provided thinking format strings. */
export function isModelThinkingFormat(value: string): value is SupportedThinkingFormat {
  return isStringOption(value, MODEL_THINKING_FORMATS);
}
