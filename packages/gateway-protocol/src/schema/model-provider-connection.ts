import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Inspects the editable API key for one provider at the displayed configuration revision. */
export const ModelsAuthInspectApiKeyParamsSchema = closedObject({
  provider: Type.String({ pattern: "\\S" }),
  agentId: Type.Optional(Type.String()),
  baseHash: NonEmptyString,
  reveal: Type.Optional(Type.Boolean()),
});

export const ModelsAuthInspectApiKeyResultSchema = closedObject({
  provider: NonEmptyString,
  agentId: NonEmptyString,
  baseHash: NonEmptyString,
  configured: Type.Boolean(),
  source: Type.Union([
    Type.Literal("literal"),
    Type.Literal("profile"),
    Type.Literal("environment"),
    Type.Literal("reference"),
    Type.Literal("none"),
    Type.Literal("unsupported"),
  ]),
  key: Type.Optional(Type.String()),
  profileId: Type.Optional(NonEmptyString),
});

/** Runs a bounded live credential probe for one model provider. */
export const ModelsProbeParamsSchema = closedObject({
  provider: NonEmptyString,
  modelId: Type.Optional(NonEmptyString),
  profileId: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  agentId: Type.Optional(Type.String()),
});

export const AuthProbeStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unknown"),
  Type.Literal("no_model"),
]);

/** Secret-free result for one provider credential target. */
export const ModelsProbeTargetResultSchema = closedObject({
  profileId: Type.Optional(NonEmptyString),
  label: NonEmptyString,
  status: AuthProbeStatusSchema,
  latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});

/** Provider-level live probe rollup plus per-credential results. */
export const ModelsProbeResultSchema = closedObject({
  provider: NonEmptyString,
  status: AuthProbeStatusSchema,
  latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
  results: Type.Array(ModelsProbeTargetResultSchema),
});

export type ModelsAuthInspectApiKeyParams = Static<typeof ModelsAuthInspectApiKeyParamsSchema>;
export type ModelsAuthInspectApiKeyResult = Static<typeof ModelsAuthInspectApiKeyResultSchema>;
export type AuthProbeStatus = Static<typeof AuthProbeStatusSchema>;
export type ModelsProbeParams = Static<typeof ModelsProbeParamsSchema>;
export type ModelsProbeTargetResult = Static<typeof ModelsProbeTargetResultSchema>;
export type ModelsProbeResult = Static<typeof ModelsProbeResultSchema>;
