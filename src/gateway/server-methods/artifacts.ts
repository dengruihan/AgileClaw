import {
  ErrorCodes,
  errorShape,
  type ArtifactsGetParams,
  type ArtifactsListParams,
  validateArtifactsDownloadParams,
  validateArtifactsGetParams,
  validateArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { resolveSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { readSessionTranscriptUpdateVersion } from "../../sessions/transcript-events.js";
import { resolveChatAttachmentFrameBudgetBytes } from "../../shared/chat-attachment-frame-budget.js";
import { canCreateArtifactDownload, createArtifactDownload } from "../artifact-download-grants.js";
import type { PreparedArtifactDownload } from "../artifact-download-projection.js";
import {
  parseManagedOutgoingArtifactId,
  readManagedOutgoingMediaArtifactContent,
  resolveManagedOutgoingMediaArtifactDownload,
  resolveManagedOutgoingMediaUrlDownload,
} from "../managed-image-attachments.js";
import {
  buildOfficePreviewPayload,
  resolveOfficePreviewFamily,
} from "../office-preview/office-preview-payload.js";
import { OFFICE_PREVIEW_MAX_BYTES } from "../office-preview/office-preview.js";
import { MAX_PAYLOAD_BYTES } from "../server-constants.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import { getSessionRowProjection } from "../session-row-projection-access.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import { parseTranscriptImageArtifactId } from "../transcript-image-artifacts.js";
import {
  type ArtifactLookup,
  type ArtifactRecord,
  toArtifactSummary,
} from "./artifacts-content.js";
import { readArtifactImagePage } from "./artifacts-image-page.js";
import { prepareArtifactSessionRead } from "./artifacts-session-read.js";
import {
  ArtifactSessionResolutionError,
  artifactResponseIsCurrent,
  type ArtifactQuery,
  type ArtifactSessionAccess,
  createArtifactSessionAccess,
  prepareArtifactSessionResolution,
} from "./artifacts-session-resolution.js";
import { findTranscriptImageArtifact } from "./artifacts-transcript-images.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

type ArtifactCollectionOptions = {
  includeDownloadData?: boolean;
  downloadArtifactId?: string;
};

type ArtifactDownloadLookup = ArtifactLookup &
  ({ download: PreparedArtifactDownload; release: () => void } | { download?: undefined });

const queuedArtifactDownloads = new Map<
  string,
  {
    ids: Set<string>;
    result: Promise<{ sessionKey: string; artifacts: ArtifactRecord[] }>;
  }
>();

function createArtifactRequestAccess(request: GatewayRequestHandlerOptions) {
  const { assertCurrent } = readGatewayRequestMutationAuthority(request);
  const { context, respond } = request;
  assertCurrent();
  return Object.assign(
    createArtifactSessionAccess({
      client: request.client,
      projection: getSessionRowProjection(context),
      getRuntimeConfig: () => {
        assertCurrent();
        return context.getRuntimeConfig();
      },
    }),
    {
      assertCurrent,
      respond: (...args: Parameters<RespondFn>) => {
        assertCurrent();
        respond(...args);
      },
    },
  );
}

function artifactError(type: string, message: string, details?: Record<string, unknown>) {
  return errorShape(ErrorCodes.INVALID_REQUEST, message, {
    details: {
      type,
      ...details,
    },
  });
}

async function loadArtifacts(
  query: ArtifactsListParams,
  access: ArtifactSessionAccess,
  opts: ArtifactCollectionOptions = {},
): Promise<{
  artifacts: ArtifactRecord[];
  sessionKey?: string;
  nextCursor?: string;
  omittedOversized?: boolean;
  assertCurrent?: () => void;
}> {
  const selected = await prepareArtifactSessionRead(query, access);
  if (!selected?.scope) {
    return { sessionKey: selected?.sessionKey, artifacts: [] };
  }
  const { sessionKey, scope, assertCurrent } = selected;
  const { storePath, sessionId, sessionEntry: entry } = scope;
  if (query.type === "image") {
    const page = await readArtifactImagePage({
      scope,
      binding: JSON.stringify([
        sessionKey,
        scope.agentId,
        sessionId,
        query.runId,
        query.messageRole,
      ]),
      client: access.client,
      cursor: query.cursor,
      limit: query.limit ?? 4,
      sessionKey,
      filters: { runId: query.runId, messageRole: query.messageRole },
    });
    assertCurrent();
    return { ...page, sessionKey, assertCurrent };
  }
  const downloadIds = opts.downloadArtifactId ? new Set([opts.downloadArtifactId]) : undefined;
  const queuedKey =
    downloadIds && !resolveSessionTranscriptReadFence(scope)
      ? JSON.stringify([
          storePath,
          scope.agentId,
          sessionKey,
          sessionId,
          entry?.lifecycleRevision,
          query.runId,
          query.messageRole,
          readSessionTranscriptUpdateVersion(),
        ])
      : undefined;
  const queued = queuedKey ? queuedArtifactDownloads.get(queuedKey) : undefined;
  if (queued && opts.downloadArtifactId) {
    queued.ids.add(opts.downloadArtifactId);
    const loaded = await queued.result;
    assertCurrent();
    return { ...loaded, assertCurrent };
  }
  const collect = async () => {
    // Close before target resolution or snapshot acquisition, including empty/error reads.
    // Later requests must start a fresh scan; only already queued downloads share this one.
    if (queuedKey) {
      queuedArtifactDownloads.delete(queuedKey);
    }
    const { artifacts } = await readSessionArtifacts(scope, {
      kind: "list",
      sessionKey,
      runId: query.runId,
      messageRole: query.messageRole,
      includeDownloadData: opts.includeDownloadData,
      downloadArtifactIds: downloadIds ? [...downloadIds] : undefined,
    });
    return { sessionKey, artifacts };
  };
  const result = queuedKey && downloadIds ? Promise.resolve().then(collect) : collect();
  if (queuedKey && downloadIds) {
    queuedArtifactDownloads.set(queuedKey, { ids: downloadIds, result });
  }
  // Queued scans share data; each caller retains its own disclosure authority.
  const loaded = await result;
  assertCurrent();
  return { ...loaded, assertCurrent };
}

function requireQueryable(params: ArtifactQuery, respond: RespondFn): boolean {
  if (params.sessionKey || params.runId) {
    return true;
  }
  respond(
    false,
    undefined,
    artifactError("artifact_query_unsupported", "artifacts require sessionKey or runId"),
  );
  return false;
}

function respondArtifactNotFound(respond: RespondFn, requestedArtifactId: string): void {
  respond(
    false,
    undefined,
    artifactError("artifact_not_found", "artifact not found", {
      artifactId: requestedArtifactId,
    }),
  );
}

async function runArtifactSessionOperation<T>(
  respond: RespondFn,
  operation: () => Promise<T> | T,
): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    if (error instanceof ArtifactSessionResolutionError) {
      respond(false, undefined, error.shape);
      return { ok: false };
    }
    if (error instanceof AgentSelectionRequiredError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return { ok: false };
    }
    throw error;
  }
}

async function findArtifact(
  params: ArtifactsGetParams,
  access: ArtifactSessionAccess,
  opts: ArtifactCollectionOptions = {},
): Promise<ArtifactLookup> {
  if (parseTranscriptImageArtifactId(params.artifactId)) {
    return findTranscriptImageArtifact(params, access, opts.includeDownloadData !== false);
  }
  const loaded = await loadArtifacts(params, access, opts);
  return {
    sessionKey: loaded.sessionKey,
    artifact: loaded.artifacts.find((artifact) => artifact.id === params.artifactId),
    assertCurrent: loaded.assertCurrent,
  };
}

async function prepareDownload(
  query: ArtifactsGetParams,
  access: ArtifactSessionAccess,
): Promise<ArtifactDownloadLookup> {
  const selected = await prepareArtifactSessionRead(query, access);
  if (!selected?.scope) {
    return { sessionKey: selected?.sessionKey };
  }
  const { selection } = await readSessionArtifacts(selected.scope, {
    ...query,
    kind: "download-grant",
    sessionKey: selected.sessionKey,
  });
  selected.assertCurrent();
  const result = {
    sessionKey: selected.sessionKey,
    assertCurrent: selected.assertCurrent,
    release: selected.release,
  };
  return selection?.kind === "prepared"
    ? { ...result, artifact: selection.download.artifact, download: selection.download }
    : { ...result, artifact: selection?.artifact };
}

async function respondManagedArtifactDownload(
  query: ArtifactsGetParams,
  access: ArtifactSessionAccess,
  respond: RespondFn,
  matched?: ArtifactRecord,
): Promise<void> {
  await runArtifactSessionOperation(respond, async () => {
    const resolveSession = await prepareArtifactSessionResolution(query, access.projection);
    const resolved = await resolveSession(access);
    const cfg = access.getRuntimeConfig();
    const defaultAgentId = resolved
      ? tryResolveSessionCompatibilityOwnerAgentId(cfg, resolved.sessionKey)
      : undefined;
    const managed =
      resolved && (!matched || matched.sessionKey === resolved.sessionKey)
        ? await resolveManagedOutgoingMediaArtifactDownload({
            sessionKey: resolved.sessionKey,
            ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
            ...(defaultAgentId ? { defaultAgentId } : {}),
            artifactId: query.artifactId,
          })
        : null;
    resolved?.readCurrent();
    if (!managed) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    respond(true, {
      artifact: {
        id: managed.artifactId,
        type: managed.type,
        title: managed.title,
        ...(managed.mimeType ? { mimeType: managed.mimeType } : {}),
        ...(managed.sizeBytes !== undefined ? { sizeBytes: managed.sizeBytes } : {}),
        sessionKey: managed.sessionKey,
        ...(matched?.runId ? { runId: matched.runId } : {}),
        ...(matched?.messageSeq !== undefined ? { messageSeq: matched.messageSeq } : {}),
        source: "session-transcript",
        download: { mode: "url" as const },
      },
      url: managed.url,
      expiresAt: managed.expiresAt,
    });
  });
}

function managedArtifactSummary(
  content: NonNullable<Awaited<ReturnType<typeof readManagedOutgoingMediaArtifactContent>>>,
  matched?: ArtifactRecord,
) {
  return {
    id: content.artifactId,
    type: content.type,
    title: content.title,
    ...(content.mimeType ? { mimeType: content.mimeType } : {}),
    ...(content.sizeBytes !== undefined ? { sizeBytes: content.sizeBytes } : {}),
    sessionKey: content.sessionKey,
    ...(matched?.runId ? { runId: matched.runId } : {}),
    ...(matched?.messageSeq !== undefined ? { messageSeq: matched.messageSeq } : {}),
    source: "session-transcript",
    download: { mode: "url" as const },
  };
}

const BASE64_MAX_LENGTH_FOR_OFFICE_PREVIEW = Math.ceil((OFFICE_PREVIEW_MAX_BYTES * 4) / 3) + 4;

/**
 * Opt-in structured preview for one artifact. The normal download path never
 * parses content; only `preview: "office"` reads the bounded original and
 * reuses the shared Office worker.
 *
 * Returns `"ordinary"` without responding when the artifact is outside the
 * Office families, so the caller answers with the artifact's normal download
 * delivery instead of a payload-less summary.
 */
async function respondArtifactOfficePreview(
  query: ArtifactsGetParams,
  access: ArtifactSessionAccess & { assertCurrent: () => void },
  respond: RespondFn,
): Promise<"handled" | "ordinary"> {
  const outcome = await runArtifactSessionOperation(respond, async () => {
    const resolveSession = await prepareArtifactSessionResolution(query, access.projection);
    const resolved = await resolveSession(access);
    const cfg = access.getRuntimeConfig();
    const defaultAgentId = resolved
      ? tryResolveSessionCompatibilityOwnerAgentId(cfg, resolved.sessionKey)
      : undefined;
    const managedId = parseManagedOutgoingArtifactId(query.artifactId);
    let matched: ArtifactRecord | undefined;
    let matchedLookup: ArtifactLookup | undefined;
    if (managedId && (query.runId || query.messageRole)) {
      // Provenance filters are a membership contract, not an ownership hint:
      // prove the managed id belongs to the requested run/role through the same
      // filtered lookup the ordinary download path uses before reading its bytes.
      const filtered = await runArtifactSessionOperation(respond, () =>
        findArtifact(query, access, { includeDownloadData: false }),
      );
      if (!filtered.ok) {
        return "handled" as const;
      }
      if (!filtered.value.artifact || filtered.value.artifact.id !== query.artifactId) {
        respondArtifactNotFound(respond, query.artifactId);
        return "handled" as const;
      }
      if (!artifactResponseIsCurrent(filtered.value, respond)) {
        return "handled" as const;
      }
      matched = filtered.value.artifact;
      matchedLookup = filtered.value;
    }
    if (managedId?.family === "image") {
      // Managed images are never Office; keep their ordinary managed delivery.
      await respondManagedArtifactDownload(query, access, respond, matched);
      return "handled" as const;
    }
    if (managedId) {
      const content = resolved
        ? await readManagedOutgoingMediaArtifactContent({
            sessionKey: resolved.sessionKey,
            ...(resolved.agentId ? { agentId: resolved.agentId } : {}),
            ...(defaultAgentId ? { defaultAgentId } : {}),
            artifactId: query.artifactId,
            maxBytes: OFFICE_PREVIEW_MAX_BYTES,
          })
        : null;
      resolved?.readCurrent();
      access.assertCurrent();
      if (!content) {
        respondArtifactNotFound(respond, query.artifactId);
        return "handled" as const;
      }
      if (matchedLookup && !artifactResponseIsCurrent(matchedLookup, respond)) {
        return "handled" as const;
      }
      if (
        !resolveOfficePreviewFamily({
          filename: content.filename,
          ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        }).office
      ) {
        await respondManagedArtifactDownload(query, access, respond, matched);
        return "handled" as const;
      }
      const preview = await buildOfficePreviewPayload({
        filename: content.filename,
        ...(content.mimeType ? { mimeType: content.mimeType } : {}),
        ...(content.sizeBytes !== undefined ? { sizeBytes: content.sizeBytes } : {}),
        read: async () => content.buffer ?? null,
      });
      access.assertCurrent();
      if (matchedLookup && !artifactResponseIsCurrent(matchedLookup, respond)) {
        return "handled" as const;
      }
      respond(true, {
        artifact: managedArtifactSummary(content, matched),
        ...(preview ? { preview } : {}),
      });
      return "handled" as const;
    }
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(query, access, {
        downloadArtifactId: query.artifactId,
        includeDownloadData: true,
      }),
    );
    if (!found.ok) {
      return "handled" as const;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, query.artifactId);
      return "handled" as const;
    }
    const family = resolveOfficePreviewFamily({
      filename: artifact.title,
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
    });
    if (!family.office) {
      // A preview request never strips the ordinary payload: answer non-Office
      // artifacts through the normal download path.
      return "ordinary" as const;
    }
    const encodedData = artifact.data;
    const preview =
      encodedData && encodedData.length > BASE64_MAX_LENGTH_FOR_OFFICE_PREVIEW
        ? {
            kind: "office" as const,
            ...(family.format ? { format: family.format } : {}),
            state: "too-large" as const,
          }
        : artifact.download.mode === "bytes"
          ? await buildOfficePreviewPayload({
              filename: artifact.title,
              ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
              ...(artifact.sizeBytes !== undefined ? { sizeBytes: artifact.sizeBytes } : {}),
              read: async () =>
                typeof artifact.data === "string" ? Buffer.from(artifact.data, "base64") : null,
            })
          : {
              kind: "office" as const,
              ...(family.format ? { format: family.format } : {}),
              state: "unsupported" as const,
            };
    if (!artifactResponseIsCurrent(found.value, respond)) {
      return "handled" as const;
    }
    respond(true, {
      artifact: toArtifactSummary(artifact),
      ...(preview ? { preview } : {}),
    });
    return "handled" as const;
  });
  return outcome.ok ? outcome.value : "handled";
}

export const artifactsHandlers: GatewayRequestHandlers = {
  "artifacts.list": async (request) => {
    const { params } = request;
    using access = createArtifactRequestAccess(request);
    const { respond } = access;
    if (!assertValidParams(params, validateArtifactsListParams, "artifacts.list", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    if (params.type !== "image" && (params.limit !== undefined || params.cursor !== undefined)) {
      respond(
        false,
        undefined,
        artifactError("artifact_query_unsupported", "limit and cursor require type image"),
      );
      return;
    }
    const query = { ...params };
    const loaded = await runArtifactSessionOperation(respond, () =>
      loadArtifacts(query, access, { includeDownloadData: false }),
    );
    if (!loaded.ok) {
      return;
    }
    const { artifacts, sessionKey, nextCursor, omittedOversized } = loaded.value;
    if (!sessionKey && query.runId) {
      respond(
        false,
        undefined,
        artifactError("artifact_scope_not_found", "no session found for artifact query"),
      );
      return;
    }
    if (artifactResponseIsCurrent(loaded.value, respond)) {
      respond(true, {
        artifacts: artifacts.map(toArtifactSummary),
        ...(nextCursor ? { nextCursor } : {}),
        ...(omittedOversized ? { omittedOversized: true } : {}),
      });
    }
  },
  "artifacts.get": async (request) => {
    const { params } = request;
    using access = createArtifactRequestAccess(request);
    const { respond } = access;
    if (!assertValidParams(params, validateArtifactsGetParams, "artifacts.get", respond)) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const query = { ...params };
    const found = await runArtifactSessionOperation(respond, () =>
      findArtifact(query, access, { includeDownloadData: false }),
    );
    if (!found.ok) {
      return;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    if (artifactResponseIsCurrent(found.value, respond)) {
      respond(true, { artifact: toArtifactSummary(artifact) });
    }
  },
  "artifacts.download": async (request) => {
    const { params, client } = request;
    using access = createArtifactRequestAccess(request);
    const { respond, assertCurrent } = access;
    if (
      !assertValidParams(params, validateArtifactsDownloadParams, "artifacts.download", respond)
    ) {
      return;
    }
    if (!requireQueryable(params, respond)) {
      return;
    }
    const query = { ...params };
    if (query.preview === "office") {
      if ((await respondArtifactOfficePreview(query, access, respond)) === "handled") {
        return;
      }
      // Non-Office artifacts keep their ordinary download delivery.
      delete query.preview;
    }
    if (
      query.sessionKey &&
      !query.runId &&
      !query.messageRole &&
      parseManagedOutgoingArtifactId(query.artifactId)
    ) {
      await respondManagedArtifactDownload(query, access, respond);
      return;
    }
    let found = await runArtifactSessionOperation<ArtifactDownloadLookup>(respond, () =>
      query.transport === "http" && canCreateArtifactDownload(client)
        ? prepareDownload(query, access)
        : findArtifact(query, access, { downloadArtifactId: query.artifactId }),
    );
    assertCurrent();
    if (found.ok && found.value.download && !canCreateArtifactDownload(client)) {
      found = await runArtifactSessionOperation(respond, () =>
        findArtifact(query, access, { downloadArtifactId: query.artifactId }),
      );
      assertCurrent();
    }
    if (!found.ok) {
      return;
    }
    const { artifact } = found.value;
    if (!artifact) {
      respondArtifactNotFound(respond, query.artifactId);
      return;
    }
    if (parseManagedOutgoingArtifactId(artifact.id)) {
      // Filters prove transcript membership; the managed ID still owns the bytes.
      // Never retarget a stale ID through inline data or another block URL.
      await respondManagedArtifactDownload(query, access, respond, artifact);
      return;
    }
    if (artifact.download.mode === "unsupported") {
      respond(
        false,
        undefined,
        artifactError("artifact_download_unsupported", "artifact download is unsupported", {
          artifactId: artifact.id,
        }),
      );
      return;
    }
    if (found.value.download) {
      const assertArtifactCurrent = found.value.assertCurrent;
      const download = createArtifactDownload({
        client,
        prepared: found.value.download,
        release: found.value.release,
        assertCurrent: () => {
          assertCurrent();
          assertArtifactCurrent?.();
        },
        read: async (response) => {
          using reader = createArtifactSessionAccess({
            getRuntimeConfig: access.getRuntimeConfig,
            client,
            projection: access.projection,
          });
          const selected = await prepareArtifactSessionRead(query, reader);
          if (!selected?.scope) {
            return undefined;
          }
          const current = await readSessionArtifacts(selected.scope, {
            ...query,
            kind: "download-response",
            sessionKey: selected.sessionKey,
            response,
          });
          selected.assertCurrent();
          return current.response;
        },
      });
      access.detach(found.value.release);
      respond(true, {
        artifact: { ...toArtifactSummary(artifact), download: { mode: "url" as const } },
        ...download,
      });
      return;
    }
    const managedUrl =
      artifact.download.mode === "url" && artifact.url && artifact.sessionKey
        ? await resolveManagedOutgoingMediaUrlDownload({
            sessionKey: artifact.sessionKey,
            url: artifact.url,
          })
        : null;
    if (!artifactResponseIsCurrent(found.value, respond)) {
      return;
    }
    const payload = {
      artifact: toArtifactSummary(artifact),
      ...(artifact.download.mode === "bytes"
        ? { encoding: "base64" as const, data: artifact.data }
        : {}),
      ...(artifact.download.mode === "url"
        ? {
            url: managedUrl?.url ?? artifact.url,
            ...(managedUrl ? { expiresAt: managedUrl.expiresAt } : {}),
          }
        : {}),
    };
    if (artifact.download.mode === "bytes") {
      // The shared budget is decoded bytes; large metadata can need more than its reserved slack.
      const maxBase64Length =
        4 * Math.floor(resolveChatAttachmentFrameBudgetBytes(MAX_PAYLOAD_BYTES) / 3);
      const envelopeBytes = Buffer.byteLength(
        JSON.stringify({
          type: "res",
          id: request.req.id,
          ok: true,
          payload: { ...payload, data: "" },
        }),
      );
      if (
        (artifact.data?.length ?? 0) > Math.min(maxBase64Length, MAX_PAYLOAD_BYTES - envelopeBytes)
      ) {
        respond(
          false,
          undefined,
          artifactError(
            "artifact_download_unsupported",
            'artifact is too large for inline transfer; request transport: "http"',
            { artifactId: artifact.id },
          ),
        );
        return;
      }
    }
    respond(true, payload);
  },
};
