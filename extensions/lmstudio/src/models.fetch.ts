import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { LiveModelCatalogHttpError } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { readProviderJsonArrayFieldResponse } from "openclaw/plugin-sdk/provider-http";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  mapLmstudioWireModels,
  resolveLmstudioServerBase,
  type LmstudioModelWire,
} from "./models.js";
import { buildLmstudioAuthHeaders } from "./runtime.js";

const log = createSubsystemLogger("extensions/lmstudio/models");

type FetchLmstudioModelsResult = {
  reachable: boolean;
  status?: number;
  models: LmstudioModelWire[];
  error?: unknown;
};

type DiscoverLmstudioModelsParams = {
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  quiet: boolean;
  discoveryMode?: "strict";
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
};

async function fetchLmstudioEndpoint(params: {
  url: string;
  init?: RequestInit;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
  auditContext: string;
  signal?: AbortSignal;
}): Promise<{ response: Response; release: () => Promise<void> }> {
  params.signal?.throwIfAborted();
  const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
  let response: Response;
  let release: () => Promise<void>;
  if (params.ssrfPolicy) {
    const guarded = await fetchWithSsrFGuard({
      url: params.url,
      init: params.init,
      timeoutMs,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      policy: params.ssrfPolicy,
      auditContext: params.auditContext,
    });
    response = guarded.response;
    release = guarded.release;
  } else {
    const fetchFn = params.fetchImpl ?? fetch;
    response = await fetchFn(params.url, {
      ...params.init,
      signal: params.signal
        ? AbortSignal.any([params.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });
    release = async () => undefined;
  }
  return {
    response,
    release: async () => {
      // A capture tee must not delay the guard's bounded dispatcher release.
      if (!response.bodyUsed) {
        void response.body?.cancel().catch(() => undefined);
      }
      await release();
    },
  };
}

/** Fetches /api/v1/models and reports transport reachability separately from HTTP status. */
export async function fetchLmstudioModels(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  ssrfPolicy?: SsrFPolicy;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable fetch implementation; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}): Promise<FetchLmstudioModelsResult> {
  const baseUrl = resolveLmstudioServerBase(params.baseUrl);
  const timeoutMs = params.timeoutMs ?? 5000;
  try {
    const { response, release } = await fetchLmstudioEndpoint({
      url: `${baseUrl}/api/v1/models`,
      init: {
        headers: buildLmstudioAuthHeaders({
          apiKey: params.apiKey,
          headers: params.headers,
        }),
      },
      timeoutMs,
      signal: params.signal,
      fetchImpl: params.fetchImpl,
      ssrfPolicy: params.ssrfPolicy,
      auditContext: "lmstudio-model-discovery",
    });
    try {
      if (!response.ok) {
        return {
          reachable: true,
          status: response.status,
          models: [],
        };
      }
      const models = await readProviderJsonArrayFieldResponse(
        response,
        "LM Studio model list",
        "models",
      );
      const validModels = models.filter(isRecord);
      if (models.length > 0 && validModels.length === 0) {
        throw new Error("LM Studio model list: malformed JSON response");
      }
      return {
        reachable: true,
        status: response.status,
        models: validModels,
      };
    } finally {
      await release();
    }
  } catch (error) {
    return {
      reachable: false,
      models: [],
      error,
    };
  }
}

/** Discovers LLM models from LM Studio and maps them to OpenClaw model definitions. */
export async function discoverLmstudioModels(
  params: DiscoverLmstudioModelsParams,
): Promise<ModelDefinitionConfig[]> {
  const fetched = await fetchLmstudioModels({
    baseUrl: params.baseUrl,
    apiKey: params.apiKey,
    headers: params.headers,
    fetchImpl: params.fetchImpl,
  });
  const quiet = params.quiet;
  if (!fetched.reachable || (fetched.status !== undefined && fetched.status >= 400)) {
    const error =
      fetched.status === undefined
        ? fetched.error
        : new LiveModelCatalogHttpError("lmstudio", fetched.status);
    if (params.discoveryMode === "strict") {
      throw error;
    }
    if (!quiet) {
      log.debug(`Failed to discover LM Studio models: ${String(error)}`);
    }
    return [];
  }

  return mapLmstudioWireModels(fetched.models, "runtime");
}
