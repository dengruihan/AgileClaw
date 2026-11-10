// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import {
  SessionFileOfficePreviewStateSchema,
  type SessionFileOfficePreviewState,
} from "./office-preview.js";
import { NonEmptyString } from "./primitives.js";
import { SessionFileOfficeFormatSchema, SessionFileOfficePreviewSchema } from "./sessions.js";

/**
 * Artifact lookup and download protocol schemas.
 *
 * Artifacts are files or payloads produced by sessions, runs, or agents;
 * these schemas keep lookup filters explicit and download results transport-safe.
 */
const ArtifactQueryParamsProperties = {
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  /** Assistant-delivered artifacts only; omit to include uploaded inputs and tool observations. */
  messageRole: Type.Optional(Type.Literal("assistant")),
};

/** Artifact lookup payload with a required artifact id plus optional scope filters. */
const ArtifactGetParamsSchema = closedObject({
  ...ArtifactQueryParamsProperties,
  artifactId: NonEmptyString,
});

/** Public artifact metadata returned before or alongside download data. */
export const ArtifactSummarySchema = closedObject({
  id: NonEmptyString,
  type: NonEmptyString,
  title: NonEmptyString,
  mimeType: Type.Optional(NonEmptyString),
  sizeBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  messageSeq: Type.Optional(Type.Integer({ minimum: 1 })),
  source: Type.Optional(NonEmptyString),
  image: Type.Optional(closedObject({ url: NonEmptyString })),
  download: closedObject({
    mode: Type.Union([Type.Literal("bytes"), Type.Literal("url"), Type.Literal("unsupported")]),
  }),
});

/** List request payload for artifacts visible in the selected scope. */
export const ArtifactsListParamsSchema = closedObject({
  ...ArtifactQueryParamsProperties,
  type: Type.Optional(Type.Literal("image")),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

/** List response containing artifact summaries only. */
export const ArtifactsListResultSchema = closedObject({
  artifacts: Type.Array(ArtifactSummarySchema),
  nextCursor: Type.Optional(NonEmptyString),
  omittedOversized: Type.Optional(Type.Boolean()),
});

/** Get request payload for one artifact summary. */
export const ArtifactsGetParamsSchema = ArtifactGetParamsSchema;

/** Get response containing one artifact summary. */
export const ArtifactsGetResultSchema = closedObject({
  artifact: ArtifactSummarySchema,
});

/** Download request payload for one artifact. */
export const ArtifactsDownloadParamsSchema = closedObject({
  ...ArtifactQueryParamsProperties,
  artifactId: NonEmptyString,
  /** Opt in only when the client can reach the Gateway's HTTP(S) media routes. */
  transport: Type.Optional(Type.Literal("http")),
  /** Opt-in structured preview; the default download path never parses content. */
  preview: Type.Optional(Type.Literal("office")),
});

/**
 * Structured read-only Office preview returned only when the caller opts in.
 * Legacy containers and non-Office files report `unsupported` without a format.
 */
export const ArtifactOfficePreviewSchema = closedObject({
  kind: Type.Literal("office"),
  /** Modern OOXML format the reader selected; absent when no modern format applies. */
  format: Type.Optional(SessionFileOfficeFormatSchema),
  state: SessionFileOfficePreviewStateSchema,
  preview: Type.Optional(SessionFileOfficePreviewSchema),
});

/** Download response, either inline base64 bytes, URL, or metadata for unsupported modes. */
export const ArtifactsDownloadResultSchema = closedObject({
  artifact: ArtifactSummarySchema,
  encoding: Type.Optional(Type.Literal("base64")),
  data: Type.Optional(Type.String()),
  url: Type.Optional(NonEmptyString),
  expiresAt: Type.Optional(NonEmptyString),
  /** Present only for `preview: "office"` requests. */
  preview: Type.Optional(ArtifactOfficePreviewSchema),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type ArtifactSummary = Static<typeof ArtifactSummarySchema>;
export type ArtifactsListParams = Static<typeof ArtifactsListParamsSchema>;
export type ArtifactsListResult = Static<typeof ArtifactsListResultSchema>;
export type ArtifactsGetParams = Static<typeof ArtifactsGetParamsSchema>;
export type ArtifactsGetResult = Static<typeof ArtifactsGetResultSchema>;
export type ArtifactsDownloadParams = Static<typeof ArtifactsDownloadParamsSchema>;
export type ArtifactsDownloadResult = Static<typeof ArtifactsDownloadResultSchema>;
export type ArtifactOfficePreviewState = SessionFileOfficePreviewState;
export type ArtifactOfficePreview = Static<typeof ArtifactOfficePreviewSchema>;
