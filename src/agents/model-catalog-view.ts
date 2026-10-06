/** Keeps public and private runtime projections on the same captured catalog. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createModelProviderRouteOverrideResolver,
  resolveMergedModelProviderConfig,
} from "../config/model-provider-config.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { dedupeByKey, indexFirstByKey } from "../shared/dedupe-by-key.js";
import { modelKey as pickerModelKey } from "../shared/model-key.js";
import {
  resolveAgentDir,
  resolveNativeModelPrimary,
  resolveAgentWorkspaceDir,
} from "./agent-scope.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import type { ModelAuthAvailabilityEvaluation } from "./model-auth-availability.js";
import { resolveSelectedModelCredential } from "./model-auth-selected-credential.js";
import {
  buildProviderConfigModelCatalogForBrowse,
  type ModelCatalogBrowseView,
} from "./model-catalog-browse.js";
import {
  projectModelCatalogEntryForRoute,
  createConfiguredModelCatalogOverridesResolver,
  type ModelCatalogRoutePolicy,
  type ModelCatalogRouteProjection,
} from "./model-catalog-route.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "./model-catalog.types.js";
import { hasAuthoredProviderRequestParams } from "./model-extra-params.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import {
  createModelCatalogIdentityKeyResolver,
  openAIModelCatalogRoutePolicy,
  resolveModelCatalogIdentityKey,
} from "./openai-model-routes.js";

/** Keep capability donors bound to one model and runtime without merging sibling metadata. */
export function selectModelCatalogRuntimeEntry(params: {
  entry: ModelCatalogEntry;
  routeVariants: readonly ModelCatalogEntry[];
  runtimeId: string;
}): { entry: ModelCatalogEntry; variants: ModelCatalogEntry[] } {
  const keyOf = createModelCatalogIdentityKeyResolver();
  const key = keyOf(params.entry);
  const observed = params.routeVariants.filter((variant) => keyOf(variant) === key);
  const variants = (observed.length ? observed : [params.entry])
    .filter((variant) => !variant.nativeRuntime || variant.nativeRuntime === params.runtimeId)
    .toSorted(
      (a, b) =>
        Number(b.nativeRuntime === params.runtimeId) - Number(a.nativeRuntime === params.runtimeId),
    );
  return {
    variants,
    entry: variants[0] ?? {
      id: params.entry.id,
      name: params.entry.name,
      provider: params.entry.provider,
    },
  };
}

/** Indexes physical variants for paired logical catalog projection. */
export function createModelCatalogView(params: {
  cfg: OpenClawConfig;
  catalog: ModelCatalogEntry[];
  routeVariants?: readonly ModelCatalogEntry[];
  routePolicy?: ModelCatalogRoutePolicy;
  keyOf?: ReturnType<typeof createModelCatalogIdentityKeyResolver>;
}) {
  const keyOf = params.keyOf ?? createModelCatalogIdentityKeyResolver();
  const variantsByKey = new Map<string, ModelCatalogEntry[]>();
  for (const entry of params.routeVariants ?? params.catalog) {
    const key = keyOf(entry);
    const variants = variantsByKey.get(key) ?? [];
    variants.push(entry);
    variantsByKey.set(key, variants);
  }
  // Deferred lookups can follow an await or owner reload; only the initial index shares policy.
  const variantsOf = (
    entry: Pick<ModelCatalogEntry, "provider" | "id">,
    key = resolveModelCatalogIdentityKey(entry),
  ) => variantsByKey.get(key);
  const routePolicy = params.routePolicy ?? openAIModelCatalogRoutePolicy;
  const resolveOverrides = createConfiguredModelCatalogOverridesResolver({
    cfg: params.cfg,
    policy: routePolicy,
  });
  const projectRoute = (
    entry: ModelCatalogEntry,
    projection: ModelCatalogRouteProjection,
    overrides: ReturnType<typeof resolveOverrides>,
    variants: readonly ModelCatalogEntry[] | undefined,
  ) => projectModelCatalogEntryForRoute({ entry, projection, catalog: variants, overrides });
  const projections = new WeakMap<
    ModelCatalogEntry,
    {
      overrides: ReturnType<typeof resolveOverrides>;
      rows: Map<
        | ModelCatalogRouteProjection["kind"]
        | Extract<ModelCatalogRouteProjection, { kind: "selected" }>["route"],
        ReturnType<typeof projectRoute>
      >;
    }
  >();
  return {
    logicalEntries: dedupeByKey(params.catalog, keyOf),
    variantsOf,
    readProjection(
      entry: ModelCatalogEntry,
      projection: ModelCatalogRouteProjection,
      identityKey?: string,
    ) {
      // Reuse only paired metadata from this view's donor scope. Readiness stays with callers;
      // configured overrides are captured lazily at the entry's first publication.
      let cached = projections.get(entry);
      if (!cached) {
        cached = { overrides: resolveOverrides(entry), rows: new Map() };
        projections.set(entry, cached);
      }
      const key = projection.kind === "selected" ? projection.route : projection.kind;
      let row = cached.rows.get(key);
      if (!row) {
        row = projectRoute(entry, projection, cached.overrides, variantsOf(entry, identityKey));
        cached.rows.set(key, row);
      }
      return row;
    },
    implicitNativeRuntime(entry: Pick<ModelCatalogEntry, "provider" | "id">) {
      const variants = variantsOf(entry);
      const runtime = variants?.[0]?.nativeRuntime;
      return runtime && variants?.every((variant) => variant.nativeRuntime === runtime)
        ? runtime
        : undefined;
    },
    project(
      entry: ModelCatalogEntry,
      evaluation: ModelAuthAvailabilityEvaluation,
      routeVariants?: readonly ModelCatalogEntry[],
    ) {
      const projection: ModelCatalogRouteProjection =
        evaluation.routeResolution === null
          ? { kind: "unmanaged" }
          : evaluation.selectedRoute
            ? {
                kind: "selected",
                route: evaluation.selectedRoute,
                policy: routePolicy,
              }
            : { kind: "unresolved", policy: routePolicy };
      // Runtime selection can narrow donors without rebuilding the configured-row index.
      return projectRoute(
        entry,
        projection,
        resolveOverrides(entry),
        routeVariants ?? variantsOf(entry),
      );
    },
  };
}

export type ModelCatalogViewFacts = {
  cfg: OpenClawConfig;
  agentId: string;
  agentDir?: string;
  workspaceDir: string;
  snapshot: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  pluginRegistry?: PluginRegistry;
  isCurrent?: () => boolean;
  observationConfig?: OpenClawConfig;
  preferredProfileId?: string;
  pinnedProfileId?: string;
  profileProvider?: string;
  view?: ModelCatalogBrowseView;
};

/** Projects captured catalog facts while keeping native observations revocable. */
export function prepareModelCatalogView(params: ModelCatalogViewFacts) {
  const defaultModel = resolveNativeModelPrimary(params.cfg, params.agentId);
  const agentDir = params.agentDir ?? resolveAgentDir(params.cfg, params.agentId);
  // Saved provider rows own runtime membership. Captured catalog rows may donate
  // route facts for those exact identities, but never restore deleted models.
  const catalog = buildConfiguredModelCatalog({
    cfg: params.cfg,
    catalog: params.snapshot.entries,
    manifestPlugins: params.metadataSnapshot,
  });
  const isCurrent = () => params.isCurrent?.() ?? params.observationConfig === undefined;
  const routes = createModelCatalogView({
    cfg: params.cfg,
    catalog,
    routeVariants: params.snapshot.routeVariants,
  });
  const runtimePolicies = new WeakMap<
    ModelCatalogEntry,
    ReturnType<typeof resolveAgentHarnessPolicy>
  >();
  const providerEndpoints = new Map<string, { endpoint?: string; api?: string }>();
  for (const [id, configured] of Object.entries(params.cfg.models?.providers ?? {})) {
    const provider = normalizeProviderId(id);
    if (!providerEndpoints.has(provider)) {
      // Status headers describe provider configuration, not private per-model route provenance.
      providerEndpoints.set(provider, {
        endpoint: normalizeOptionalString(configured.baseUrl),
        api: normalizeOptionalString(configured.api),
      });
    }
  }
  return {
    providerEndpoints,
    snapshot: params.snapshot,
    catalog,
    defaultModel,
    isCurrent,
    evaluateNative: (
      entry: ModelCatalogEntry,
      host: ModelAuthAvailabilityEvaluation,
      runtimeId?: string,
    ): ModelAuthAvailabilityEvaluation => {
      let policy = runtimePolicies.get(entry);
      if (!policy) {
        policy = resolveAgentHarnessPolicy({
          provider: entry.provider,
          modelId: entry.id,
          modelApi: entry.api,
          modelBaseUrl: entry.baseUrl,
          config: params.cfg,
          agentScope: { kind: "prepared", agentId: params.agentId },
        });
        runtimePolicies.set(entry, policy);
      }
      const runtime =
        runtimeId ??
        host.requestedRuntimeId ??
        (!policy.forcedByEnvironment && policy.runtimeSource === "implicit"
          ? (routes.implicitNativeRuntime(entry) ?? policy.runtime)
          : policy.runtime);
      if (runtime === "auto" || runtime === "openclaw") {
        return host;
      }
      const observedNative =
        entry.nativeRuntime === runtime ||
        routes.variantsOf(entry)?.some((variant) => variant.nativeRuntime === runtime) === true;
      const provider = normalizeProviderId(entry.provider);
      const sameProvider =
        !params.profileProvider || normalizeProviderId(params.profileProvider) === provider;
      const configured = resolveMergedModelProviderConfig(params.cfg, provider);
      const modelKey = (id: string) =>
        stripSelfProviderModelPrefix(provider, splitTrailingAuthProfile(id).model.trim()).trim();
      // Native account evidence cannot satisfy an authored host route, key, profile,
      // or request override. Those keep the prepared host evaluation.
      if (
        (sameProvider && params.preferredProfileId) ||
        (sameProvider && params.pinnedProfileId) ||
        (host.selectedAuthMode && (host.evidence !== "runtime" || !observedNative)) ||
        configured?.api ||
        configured?.baseUrl ||
        configured?.apiKey ||
        configured?.auth ||
        configured?.models?.some(
          (model) => modelKey(model.id) === modelKey(entry.id) && (model.api || model.baseUrl),
        ) ||
        Object.keys(params.cfg.auth?.order ?? {}).some(
          (id) => normalizeProviderId(id) === provider,
        ) ||
        Object.values(params.cfg.auth?.profiles ?? {}).some(
          (profile) => normalizeProviderId(profile.provider) === provider,
        ) ||
        createModelProviderRouteOverrideResolver({
          authoredConfig: params.cfg,
          provider,
        })(entry.id) === "present" ||
        hasAuthoredProviderRequestParams({
          config: params.cfg,
          provider,
          modelId: entry.id,
          agentId: params.agentId,
        })
      ) {
        return host;
      }
      const resolveRegistry = () =>
        params.observationConfig
          ? params.pluginRegistry
          : (params.pluginRegistry ?? getActivePluginRegistry());
      const registry = resolveRegistry();
      const harness = registry?.agentHarnesses.find(
        (registration) => registration.harness.id === runtime,
      )?.harness;
      if (
        !harness?.readModelCatalogReadiness &&
        !observedNative &&
        !(harness?.authBootstrap === "harness" && harness.loadModelCatalog)
      ) {
        return host;
      }
      let ready: boolean;
      let authMode: string | undefined;
      try {
        ready =
          isCurrent() &&
          harness?.authBootstrap === "harness" &&
          harness.supports({
            provider,
            modelId: entry.id,
            requestedRuntime: runtime,
            modelProvider: {
              preparedAuth: { source: "harness" },
              endpointOverrides: "none",
              requestTransportOverrides: "none",
            },
          }).supported &&
          isCurrent() &&
          resolveRegistry() === registry;
        const observation = ready
          ? harness?.readModelCatalogReadiness?.({
              config: params.observationConfig ?? params.cfg,
              agentId: params.agentId,
              agentDir,
              workspaceDir: params.workspaceDir,
              provider,
              modelId: entry.id,
            })
          : undefined;
        ready =
          ready &&
          (!harness?.readModelCatalogReadiness || observation !== undefined) &&
          isCurrent() &&
          resolveRegistry() === registry;
        authMode = ready ? observation?.authMode : undefined;
      } catch {
        // A failed/disposed owner supplies no account observation; do not infer host readiness.
        ready = false;
        authMode = undefined;
      }
      // A native catalog owner without an observation is unknown, not missing host API auth.
      const availability =
        ready && !harness?.readModelCatalogReadiness && !observedNative ? undefined : ready;
      return {
        availability,
        availabilityAuthoritative: true,
        routeResolution: null,
        ...(host.requestedRuntimeId ? { requestedRuntimeId: host.requestedRuntimeId } : {}),
        runtimeAuth: { id: runtime, source: "native" },
        selectedCredential: resolveSelectedModelCredential({
          provider,
          runtimeAuth: { id: runtime, source: "native" },
        }),
        ...(authMode ? { selectedAuthMode: authMode } : {}),
      };
    },
    providerInventory(
      sourceConfig: OpenClawConfig,
      canonicalEntries: readonly ModelCatalogEntry[],
    ) {
      const keyOf = createModelCatalogIdentityKeyResolver();
      const canonicalByKey = indexFirstByKey(canonicalEntries, keyOf);
      return dedupeByKey(
        buildProviderConfigModelCatalogForBrowse({
          cfg: sourceConfig,
          workspaceDir: params.workspaceDir,
        }).map((entry) => canonicalByKey.get(keyOf(entry)) ?? entry),
        keyOf,
      );
    },
  };
}

type PickerModelCatalogViewRequest = {
  kind: "picker";
  config: OpenClawConfig;
  preferredProvider?: string;
  preferLiveProviderCatalog?: boolean;
  providerScoped?: boolean;
  allowStaticFallbackCatalog?: boolean;
  includeConfiguredProvider?: (provider: string) => boolean;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

type StatusModelCatalogViewRequest = {
  kind: "status";
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  workspaceDir?: string;
  entries: readonly Pick<ModelCatalogEntry, "provider" | "id">[];
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
};

type StatusModelCatalogView = ReturnType<typeof prepareModelCatalogView> & {
  providerAuthLabels: Map<string, string>;
};

export function loadPreparedModelCatalogView(
  params: PickerModelCatalogViewRequest,
): Promise<{ snapshot: ModelCatalogSnapshot }>;
export function loadPreparedModelCatalogView(
  params: StatusModelCatalogViewRequest,
): Promise<StatusModelCatalogView>;
/** Acquires requested catalog facts before constructing a local view. */
export async function loadPreparedModelCatalogView(
  params: PickerModelCatalogViewRequest | StatusModelCatalogViewRequest,
): Promise<StatusModelCatalogView | { snapshot: ModelCatalogSnapshot }> {
  if (params.kind === "status") {
    const {
      getPublishedPreparedModelCatalogOwnerSnapshot,
      loadPreparedModelCatalogOwnerSnapshot,
      materializePreparedModelCatalogOwner,
    } = await import("./prepared-model-catalog.js");
    const { getPreparedModelRuntimeAuthLabels, getPreparedModelRuntimeAuthStore } =
      await import("./prepared-model-runtime-auth.js");
    const { formatModelCatalogAuthLabel } = await import("./model-catalog-auth-labels.js");
    const { resolveSessionRuntimeOverrideForProvider } =
      await import("./session-runtime-compat.js");
    const { buildAgentRuntimeAuthPlan } = await import("./runtime-plan/auth.js");
    const owner = materializePreparedModelCatalogOwner(
      getPublishedPreparedModelCatalogOwnerSnapshot(params) ??
        (await loadPreparedModelCatalogOwnerSnapshot({ ...params, readOnly: true })),
    );
    const capturedLabels = getPreparedModelRuntimeAuthLabels(owner);
    const store = getPreparedModelRuntimeAuthStore(owner);
    if (!store) {
      throw new Error("Prepared model runtime omitted auth display facts");
    }
    const authContext = { cfg: owner.config, store, metadataSnapshot: owner.metadataSnapshot };
    const providerAuthLabels = new Map<string, string>();
    for (const entry of params.entries) {
      const provider = normalizeProviderId(entry.provider);
      if (providerAuthLabels.has(provider)) {
        continue;
      }
      const runtime =
        resolveSessionRuntimeOverrideForProvider({
          provider,
          entry: params.sessionEntry,
          cfg: owner.config,
        }) ??
        resolveAgentHarnessPolicy({
          provider,
          modelId: entry.id,
          config: owner.config,
          agentId: params.agentId,
        }).runtime;
      const labels = capturedLabels.get(provider);
      let label = formatModelCatalogAuthLabel(
        (provider === "openai" && runtime !== "codex" ? labels?.apiKey : labels?.all) ?? "missing",
        authContext,
      );
      if (label === "missing") {
        const authProvider = buildAgentRuntimeAuthPlan({
          provider,
          config: owner.config,
          workspaceDir: owner.workspaceDir,
          metadataSnapshot: owner.metadataSnapshot,
          harnessRuntime: runtime,
        }).harnessAuthProvider;
        const runtimeLabel = formatModelCatalogAuthLabel(
          (authProvider && authProvider !== provider
            ? capturedLabels.get(authProvider)?.all
            : undefined) ?? "missing",
          authContext,
        );
        if (runtimeLabel !== "missing") {
          label = `via ${runtime} runtime / ${authProvider} ${runtimeLabel}`;
        }
      }
      providerAuthLabels.set(provider, label);
    }
    return {
      ...prepareModelCatalogView({
        cfg: owner.config,
        agentId: params.agentId,
        agentDir: owner.agentDir,
        workspaceDir:
          owner.workspaceDir ??
          params.workspaceDir ??
          resolveAgentWorkspaceDir(owner.config, params.agentId),
        snapshot: owner.modelCatalog,
        metadataSnapshot: owner.metadataSnapshot,
        isCurrent: owner.isCurrent,
      }),
      providerAuthLabels,
    };
  }
  const view = await acquirePickerModelCatalogView(params);
  const includeConfiguredProvider = params.includeConfiguredProvider;
  if (!includeConfiguredProvider) {
    return view;
  }
  const { buildConfiguredModelCatalog } = await import("./model-selection-shared.js");
  let catalog = view.snapshot.entries;
  let configured = buildConfiguredModelCatalog({ cfg: params.config }).filter((entry) =>
    includeConfiguredProvider(entry.provider),
  );
  if (params.preferredProvider && params.providerScoped && catalog.length > 0) {
    const { loadStaticManifestCatalogRowsForList } =
      await import("../commands/models/list.manifest-catalog.js");
    const staticRows = loadStaticManifestCatalogRowsForList({
      cfg: params.config,
      providerFilter: params.preferredProvider,
      ...(params.env !== undefined ? { env: params.env } : {}),
    });
    const keyOf = (entry: { provider: string; id: string }) =>
      pickerModelKey(entry.provider, entry.id);
    const staticKeys = new Set(staticRows.map(keyOf));
    const deprecatedKeys = new Set(
      staticRows.filter((entry) => entry.status === "deprecated").map(keyOf),
    );
    catalog = catalog.filter((entry) => !deprecatedKeys.has(keyOf(entry)));
    configured = configured.filter((entry) => !staticKeys.has(keyOf(entry)));
  }
  const entries = [...catalog];
  const seen = new Set(catalog.map((entry) => pickerModelKey(entry.provider, entry.id)));
  for (const entry of configured) {
    const key = pickerModelKey(entry.provider, entry.id);
    if (!seen.has(key)) {
      seen.add(key);
      entries.push(entry);
    }
  }
  return {
    snapshot: {
      ...view.snapshot,
      get refreshFailed() {
        return view.snapshot.refreshFailed;
      },
      entries,
    },
  };
}

async function acquirePickerModelCatalogView(
  params: PickerModelCatalogViewRequest,
): Promise<{ snapshot: ModelCatalogSnapshot }> {
  const { buildConfiguredModelCatalog } = await import("./model-selection-shared.js");
  const provider = normalizeProviderId(params.preferredProvider ?? "");
  const entries = buildConfiguredModelCatalog({ cfg: params.config }).filter(
    (entry) =>
      !params.providerScoped || !provider || normalizeProviderId(entry.provider) === provider,
  );
  return { snapshot: { entries, routeVariants: entries } };
}
