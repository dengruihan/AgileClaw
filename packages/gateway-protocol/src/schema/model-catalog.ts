import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { ChatAccountSelectionSchema, ModelAuthProfileIdSchema } from "./model-account-selection.js";
import {
  GatewayAgentRuntimeSchema,
  GatewayCompletionRouteSchema,
  GatewayContextWindowOptionSchema,
  GatewayThinkingLevelOptionSchema,
} from "./model-runtime-options.js";
import { NonEmptyString, SecretInputSchema } from "./primitives.js";

/** Model catalog request with optional visibility scope. */
export const ModelsListParamsSchema = Type.Object(
  {
    agentId: Type.Optional(NonEmptyString),
    sessionKey: Type.Optional(NonEmptyString),
    authProfileId: Type.Optional(ModelAuthProfileIdSchema),
    provider: Type.Optional(NonEmptyString),
    includeDetails: Type.Optional(Type.Boolean()),
    includeProviderCapabilities: Type.Optional(Type.Boolean()),
    /** Include global default-model previews, independent of agent/session overrides. */
    includeDefaultModels: Type.Optional(Type.Boolean()),
    /** Reuse prepared/cached facts without starting provider discovery. */
    preparedOnly: Type.Optional(Type.Boolean()),
    /** Force replacement of a completed full-catalog generation. */
    refresh: Type.Optional(Type.Boolean()),
    view: Type.Optional(
      Type.Union([
        Type.Literal("default"),
        Type.Literal("configured"),
        Type.Literal("provider-config"),
        Type.Literal("all"),
      ]),
    ),
  },
  {
    additionalProperties: false,
    allOf: [
      {
        not: {
          properties: { preparedOnly: { const: true }, refresh: { const: true } },
          required: ["preparedOnly", "refresh"],
        },
      },
      { not: { required: ["sessionKey", "authProfileId"] } },
    ],
  },
);

const ModelUnavailableReasonSchema = Type.Union([
  Type.Literal("missing-auth"),
  Type.Literal("auth-failed"),
  Type.Literal("cooldown"),
]);

const ModelRuntimeProperties = {
  available: Type.Optional(Type.Boolean()),
  /** Scoped manual-choice permission; separate from runtime readiness and automatic selection. */
  manualSelectionAllowed: Type.Optional(Type.Boolean()),
  unavailableReason: Type.Optional(ModelUnavailableReasonSchema),
  /** Earliest known retry time in epoch milliseconds, only for unavailable models. */
  unavailableUntil: Type.Optional(Type.Integer({ minimum: 0 })),
  contextWindow: Type.Optional(Type.Integer({ minimum: 1 })),
  contextTokens: Type.Optional(Type.Integer({ minimum: 1 })),
  local: Type.Optional(Type.Boolean()),
  contextWindows: Type.Optional(Type.Array(GatewayContextWindowOptionSchema)),
  contextWindowDefault: Type.Optional(NonEmptyString),
  reasoning: Type.Optional(Type.Boolean()),
  thinkingLevels: Type.Optional(Type.Array(GatewayThinkingLevelOptionSchema)),
  thinkingDefault: Type.Optional(NonEmptyString),
  effectiveFastMode: Type.Optional(
    Type.Union([Type.Boolean(), Type.Literal("auto"), Type.Literal("ultrafast")]),
  ),
  /** Account-scoped service tiers advertised for this selected runtime. Missing means unknown. */
  serviceTiers: Type.Optional(Type.Array(NonEmptyString)),
  /** Local selected-request applicability, not preference or upstream fulfillment. */
  supportsFastMode: Type.Optional(Type.Boolean()),
  supportsTools: Type.Optional(Type.Boolean()),
  input: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("text"),
        Type.Literal("image"),
        Type.Literal("audio"),
        Type.Literal("video"),
        Type.Literal("document"),
      ]),
    ),
  ),
};

/** Runtime-specific capabilities for an additional choice of the same canonical model. */
export const ModelRuntimeChoiceSchema = closedObject({
  agentRuntime: GatewayAgentRuntimeSchema,
  ...ModelRuntimeProperties,
  unavailableReason: Type.Optional(
    Type.Union([ModelUnavailableReasonSchema, Type.Literal("unsupported-runtime")]),
  ),
});

export const ModelChoiceSchema = closedObject({
  id: NonEmptyString,
  name: NonEmptyString,
  provider: NonEmptyString,
  alias: Type.Optional(NonEmptyString),
  tags: Type.Optional(Type.Array(NonEmptyString)),
  ...ModelRuntimeProperties,
  agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
  apiKeySupported: Type.Optional(Type.Boolean()),
  runtimeChoices: Type.Optional(Type.Array(ModelRuntimeChoiceSchema, { maxItems: 8 })),
});

/** Model catalog result. */
export const ModelCatalogProviderOutcomeSchema = closedObject({
  provider: NonEmptyString,
  profileId: Type.Optional(NonEmptyString),
  status: Type.Union([
    Type.Literal("ready"),
    Type.Literal("auth-rejected"),
    Type.Literal("unavailable"),
  ]),
});

export const ModelsListResultSchema = closedObject({
  models: Type.Array(ModelChoiceSchema),
  /** The Gateway owns role restrictions and the effective permitted reset target. */
  modelSelectionPolicy: Type.Optional(
    closedObject({
      restricted: Type.Literal(true),
      defaultModel: Type.Union([NonEmptyString, Type.Null()]),
    }),
  ),
  /** Manifest-owned decision choices, separate from conversational model routing. */
  decisionModels: Type.Optional(
    Type.Array(
      closedObject({
        id: NonEmptyString,
        provider: NonEmptyString,
        name: NonEmptyString,
        pluginId: NonEmptyString,
        capabilities: Type.Optional(
          closedObject({
            questionTypes: Type.Array(
              Type.Union([Type.Literal("boolean"), Type.Literal("choice"), Type.Literal("score")]),
              { minItems: 1, maxItems: 3, uniqueItems: true },
            ),
            maxQuestions: Type.Optional(
              Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            ),
            maxChoiceAlternatives: Type.Optional(
              Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            ),
            maxScoreLevels: Type.Optional(
              Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            ),
            maxInputTokens: Type.Optional(
              Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
            ),
            inputTokenScope: Type.Optional(
              Type.Union([
                Type.Literal("encoded-question"),
                Type.Literal("state-plus-each-criterion"),
              ]),
            ),
            requiresBooleanCriteria: Type.Optional(Type.Boolean()),
            confidence: Type.Optional(
              Type.Union([Type.Literal("provider-specific"), Type.Literal("none")]),
            ),
          }),
        ),
      }),
    ),
  ),
  defaultModels: Type.Optional(
    closedObject({
      /** Auto preview from agents.defaults.model, even when utility routing is explicit or disabled. */
      automaticUtilityModel: Type.Union([NonEmptyString, Type.Null()]),
      /** Route the utility model in effect (automatic or explicit) runs on; absent when disabled. */
      utilityRuntime: Type.Optional(GatewayCompletionRouteSchema),
    }),
  ),
  refreshFailed: Type.Optional(Type.Boolean()),
  pendingProviders: Type.Optional(Type.Array(NonEmptyString)),
  accountSelection: Type.Optional(ChatAccountSelectionSchema),
  providerOutcomes: Type.Optional(Type.Array(ModelCatalogProviderOutcomeSchema)),
});

/** Provider setup choices derived from lightweight plugin model metadata. */
export const ModelsProviderTemplatesParamsSchema = Type.Object({}, { additionalProperties: false });

export const ModelsProviderTemplateSchema = closedObject({
  id: NonEmptyString,
  name: NonEmptyString,
  requiresApiKey: Type.Boolean(),
  defaults: Type.Record(Type.String(), Type.Unknown()),
});

export const ModelsProviderTemplatesResultSchema = closedObject({
  templates: Type.Array(ModelsProviderTemplateSchema),
});

const ProviderDiscoveryConfigSchema = closedObject({
  name: Type.Optional(NonEmptyString),
  baseUrl: NonEmptyString,
  api: Type.Optional(
    Type.Union([
      Type.Literal("openai-completions"),
      Type.Literal("openai-responses"),
      Type.Literal("anthropic-messages"),
      Type.Literal("google-generative-ai"),
      Type.Literal("google-interactions"),
      Type.Literal("ollama"),
      Type.Literal("pi-messages"),
      Type.Literal("azure-openai-responses"),
    ]),
  ),
  apiKey: Type.Optional(SecretInputSchema),
  auth: Type.Optional(Type.Literal("api-key")),
  maxTokens: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
  region: Type.Optional(NonEmptyString),
  injectNumCtxForOpenAICompat: Type.Optional(Type.Boolean()),
  params: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  agentRuntime: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  authHeader: Type.Optional(Type.Boolean()),
  headers: Type.Optional(Type.Record(Type.String(), SecretInputSchema)),
  request: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  models: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  discovery: Type.Optional(
    closedObject({
      endpointPath: Type.Optional(NonEmptyString),
      headers: Type.Optional(Type.Record(Type.String(), SecretInputSchema)),
      request: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    }),
  ),
});

/** Explicit, side-effect-free model discovery against the caller's unsaved provider draft. */
export const ModelsDiscoverParamsSchema = closedObject({
  agentId: NonEmptyString,
  providerId: Type.Optional(NonEmptyString),
  config: ProviderDiscoveryConfigSchema,
});

export const ModelsDiscoverResultSchema = closedObject({
  models: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});

export type ModelChoice = Static<typeof ModelChoiceSchema>;
export type ModelRuntimeChoice = Static<typeof ModelRuntimeChoiceSchema>;
export type ModelCatalogProviderOutcome = Static<typeof ModelCatalogProviderOutcomeSchema>;
export type ModelsListResult = Static<typeof ModelsListResultSchema>;
export type ModelsProviderTemplatesParams = Static<typeof ModelsProviderTemplatesParamsSchema>;
export type ModelProviderTemplate = Static<typeof ModelsProviderTemplateSchema>;
export type ModelsProviderTemplatesResult = Static<typeof ModelsProviderTemplatesResultSchema>;
export type ModelProviderTemplatesResult = ModelsProviderTemplatesResult;
export type ModelsDiscoverParams = Static<typeof ModelsDiscoverParamsSchema>;
export type ModelsDiscoverResult = Static<typeof ModelsDiscoverResultSchema>;
export type ModelDiscoverResult = ModelsDiscoverResult;
export type ModelsListParams = Static<typeof ModelsListParamsSchema>;
