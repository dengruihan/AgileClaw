import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_CAPS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
  validateModelsDiscoverParams,
  validateModelsProviderTemplatesParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import { resolveApiKeyForProfile } from "../../agents/auth-profiles/oauth.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth-provider-config.js";
import { refreshExpiredPreparedModelCatalog } from "../../agents/prepared-model-catalog.js";
import { PreparedModelRuntimePublicationSupersededError } from "../../agents/prepared-model-runtime.errors.js";
import { applyRemoteModelCatalogUpdate } from "../../agents/prepared-model-runtime.js";
import { isApiKeyModelApi } from "../../config/model-config-vocabulary.js";
import { resolveMergedModelProviderEntry } from "../../config/model-provider-config.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import type { SecretInput } from "../../config/types.secrets.js";
import { ModelsConfigSchema } from "../../config/zod-schema.core.js";
import { resolveCanonicalConfiguredSecretInputString } from "../../gateway/resolve-configured-secret-input-string.js";
import { discoverProviderModelRows } from "../../plugin-sdk/provider-catalog-live-runtime.js";
import { listProviderModelTemplates } from "../../plugins/provider-model-templates.js";
import { roleScopesAllow } from "../../shared/operator-scope-compat.js";
import { ModelAccountConnectAuthorityError } from "../model-account-connect.js";
import { prepareOperatorModelPresentation } from "../operator-model-presentation.js";
import { authorizeCurrentOperatorRoleScopes } from "../operator-role-policy.js";
import { READ_SCOPE, SESSION_READ_SCOPE } from "../operator-scopes.js";
import { projectModelFastModeCatalog } from "../session-fast-mode-presentation.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import type { ChatMetadataReadParams } from "./chat-metadata-contract.js";
import { resolveChatMetadataReadParams } from "./chat-metadata-handler.js";
import { projectSessionModelCatalog } from "./chat-metadata-session-projection.js";
import { UnknownModelCatalogProviderError } from "./models-list-capabilities.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { preparePersonalModelAccountSelection } from "./users-model-account-access.js";
import { assertValidParams } from "./validation.js";

// Ordinary reads return saved rows while expired provider inventory refreshes in the background.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.providerTemplates": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateModelsProviderTemplatesParams,
        "models.providerTemplates",
        respond,
      )
    ) {
      return;
    }
    respond(true, listProviderModelTemplates(), undefined);
  },
  "models.discover": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsDiscoverParams, "models.discover", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId,
      respond,
      cfg,
      normalize: normalizeOptionalString,
    });
    if (!resolved) {
      return;
    }
    const providerId = params.providerId;
    const storedProviderEntry = providerId
      ? resolveMergedModelProviderEntry(cfg, providerId)
      : undefined;
    const storedProvider = storedProviderEntry?.providerConfig;
    const providerConfigKey = storedProviderEntry?.providerKey ?? providerId;
    const draft = params.config;
    const api = draft.api;
    if (!api || !isApiKeyModelApi(api)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Choose a supported API format before pulling models.",
        ),
      );
      return;
    }
    const parsedConfig = ModelsConfigSchema.safeParse({
      providers: {
        [providerId ?? "__discover__"]: {
          ...draft,
          models: [],
        },
      },
    });
    if (!parsedConfig.success || !parsedConfig.data) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "The provider draft is invalid."),
      );
      return;
    }
    const parsedProvider = parsedConfig.data.providers?.[providerId ?? "__discover__"];
    if (!parsedProvider) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "The provider draft is invalid."),
      );
      return;
    }
    const baseUrl = parsedProvider.baseUrl ?? storedProvider?.baseUrl;
    if (!baseUrl) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Set a Base URL before pulling models."),
      );
      return;
    }
    // An omitted key may reuse only this provider's saved API key. An empty key is an
    // explicit clear signal and must not fall back to the saved credential.
    const explicitlyClearedKey = draft.apiKey === "";
    const apiKeyInput: unknown = explicitlyClearedKey
      ? undefined
      : draft.apiKey !== undefined
        ? draft.apiKey
        : storedProvider?.apiKey;
    let resolvedProfileApiKey: string | undefined;
    if (
      draft.apiKey === undefined &&
      storedProviderEntry &&
      typeof storedProvider?.apiKey === "string"
    ) {
      const agentDir = resolveAgentDir(cfg, resolved.agentId);
      const store = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
      const binding = resolveProviderEntryApiKeyProfileReference({
        cfg,
        provider: storedProviderEntry.providerKey,
        store,
      });
      if (binding.kind === "profile") {
        if (binding.credential.type !== "api_key") {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "The saved provider key is not an API-key credential.",
            ),
          );
          return;
        }
        const credential = await resolveApiKeyForProfile({
          cfg,
          store,
          profileId: binding.profileId,
          agentDir,
        });
        if (!credential?.apiKey) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "The saved provider API key is unavailable."),
          );
          return;
        }
        resolvedProfileApiKey = credential.apiKey;
      } else if (binding.kind === "profile-incompatible") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "The saved provider API key belongs to another provider.",
          ),
        );
        return;
      }
    }
    const providerConfigForSecrets = {
      ...cfg,
      models: {
        ...cfg.models,
        providers: {
          ...cfg.models?.providers,
          ...(providerConfigKey
            ? {
                [providerConfigKey]: {
                  ...storedProvider,
                  ...parsedProvider,
                  baseUrl,
                  models: [],
                },
              }
            : {}),
        },
      },
    };
    let apiKey: string | undefined;
    try {
      if (resolvedProfileApiKey !== undefined) {
        apiKey = resolvedProfileApiKey;
      } else if (apiKeyInput !== undefined && apiKeyInput !== "") {
        const secret = await resolveCanonicalConfiguredSecretInputString({
          config: providerConfigForSecrets,
          env: process.env,
          value: apiKeyInput,
          path: providerConfigKey
            ? `models.providers.${providerConfigKey}.apiKey`
            : "models.discover.apiKey",
        });
        apiKey = secret.value;
        if (!apiKey) {
          throw new Error(secret.unresolvedRefReason ?? "The API key could not be resolved.");
        }
      }
      const headers: Record<string, string> = {};
      const resolveHeaders = async (
        values: Record<string, SecretInput> | undefined,
        path: string,
      ) => {
        for (const [key, value] of Object.entries(values ?? {})) {
          const secret = await resolveCanonicalConfiguredSecretInputString({
            config: providerConfigForSecrets,
            env: process.env,
            value,
            path: `${path}.${key}`,
          });
          if (secret.value) {
            headers[key] = secret.value;
          }
        }
      };
      await resolveHeaders(
        { ...storedProvider?.headers, ...parsedProvider.headers },
        providerConfigKey
          ? `models.providers.${providerConfigKey}.headers`
          : "models.discover.headers",
      );
      await resolveHeaders(
        parsedProvider.request?.headers,
        providerConfigKey
          ? `models.providers.${providerConfigKey}.request.headers`
          : "models.discover.request.headers",
      );
      await resolveHeaders(
        parsedProvider.discovery?.request?.headers,
        providerConfigKey
          ? `models.providers.${providerConfigKey}.discovery.request.headers`
          : "models.discover.discovery.request.headers",
      );
      await resolveHeaders(
        parsedProvider.discovery?.headers,
        providerConfigKey
          ? `models.providers.${providerConfigKey}.discovery.headers`
          : "models.discover.discovery.headers",
      );
      const requestAuth = parsedProvider.discovery?.request?.auth ?? parsedProvider.request?.auth;
      if (requestAuth?.mode === "authorization-bearer" && requestAuth.token !== undefined) {
        const secret = await resolveCanonicalConfiguredSecretInputString({
          config: providerConfigForSecrets,
          env: process.env,
          value: requestAuth.token,
          path: providerId
            ? `models.providers.${providerConfigKey}.request.auth.token`
            : "models.discover.request.auth.token",
        });
        if (secret.value) {
          headers.Authorization = `Bearer ${secret.value}`;
        }
      } else if (
        requestAuth?.mode === "header" &&
        requestAuth.headerName !== undefined &&
        requestAuth.value !== undefined
      ) {
        const secret = await resolveCanonicalConfiguredSecretInputString({
          config: providerConfigForSecrets,
          env: process.env,
          value: requestAuth.value,
          path: providerId
            ? `models.providers.${providerConfigKey}.request.auth.value`
            : "models.discover.request.auth.value",
        });
        if (secret.value) {
          headers[requestAuth.headerName] = `${requestAuth.prefix ?? ""}${secret.value}`;
        }
      }
      const {
        headers: _draftHeaders,
        apiKey: _draftKey,
        request,
        discovery,
        ...providerDefaults
      } = parsedProvider;
      // Discovery request settings win over shared ones; resolved headers and the
      // key travel separately so they cannot leak into the returned config rows.
      const providerConfig = {
        ...providerDefaults,
        baseUrl,
        models: [],
        request: discovery?.request ?? request,
        ...(discovery?.endpointPath ? { discovery: { endpointPath: discovery.endpointPath } } : {}),
      } satisfies ModelProviderConfig;
      const models = await discoverProviderModelRows({
        providerId: providerId ?? "custom",
        providerConfig,
        apiKey,
        additionalHeaders: headers,
      });
      respond(true, { models }, undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Model discovery failed.";
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, message, { retryable: true }));
    }
  },
  "models.list": async (options) => {
    const { params, respond, context, client } = options;
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    let scope: ChatMetadataReadParams | undefined;
    let publicationScope: ChatMetadataReadParams | undefined;
    try {
      const scoped = Boolean(params.sessionKey || params.authProfileId);
      const draftAccountSelection =
        !params.sessionKey && params.authProfileId
          ? await preparePersonalModelAccountSelection(
              options,
              params.authProfileId,
              SESSION_READ_SCOPE,
            )
          : undefined;
      scope = scoped
        ? await resolveChatMetadataReadParams(options, params, draftAccountSelection)
        : undefined;
      if (scoped && !scope) {
        return;
      }
      const cfg = context.getRuntimeConfig();
      const resolved =
        scope ??
        resolveAgentIdOrRespondError({
          rawAgentId: params.agentId ?? tryResolveAmbientOwnerAgentId(cfg),
          respond,
          cfg,
          normalize: normalizeOptionalString,
        });
      if (!resolved) {
        return;
      }
      if (!scope) {
        const roleError = authorizeCurrentOperatorRoleScopes(client, cfg);
        if (roleError) {
          respond(false, undefined, roleError);
          return;
        }
        const scopes = client?.connect.scopes ?? [];
        const limitedSessionRead =
          roleScopesAllow({
            role: "operator",
            requestedScopes: [SESSION_READ_SCOPE],
            allowedScopes: scopes,
          }) &&
          !roleScopesAllow({
            role: "operator",
            requestedScopes: [READ_SCOPE],
            allowedScopes: scopes,
          });
        if (limitedSessionRead) {
          scope = await resolveChatMetadataReadParams(options, { agentId: resolved.agentId });
          if (!scope) {
            return;
          }
        }
      }
      publicationScope =
        scope ?? (await resolveChatMetadataReadParams(options, { agentId: resolved.agentId }));
      if (!publicationScope) {
        return;
      }
      publicationScope.assertCurrent?.();
      if (params.refresh !== true) {
        refreshExpiredPreparedModelCatalog({ agentId: resolved.agentId, config: cfg });
      }
      const includeManualSelection = hasGatewayClientCap(
        client?.connect.caps,
        GATEWAY_CLIENT_CAPS.MODEL_SELECTION_POLICY,
      );
      const prepared =
        !scope && params.refresh !== true
          ? await context.readPreparedModelsList?.({
              agentId: resolved.agentId,
              params,
              includeManualSelection,
              requesterProfileId: publicationScope.requesterProfileId,
            })
          : undefined;
      const result =
        prepared ??
        (await buildModelsListResult({
          source: { kind: "gateway", context },
          agentId: resolved.agentId,
          params,
          includeManualSelection,
          requesterProfileId: publicationScope.requesterProfileId,
          readScope: scope,
          publicationScope,
        }));
      publicationScope.draftAccountSelection?.assertCurrent();
      publicationScope.assertCurrent?.();
      const currentConfig = context.getRuntimeConfig();
      const projected =
        scope && params.view !== "provider-config"
          ? {
              ...result,
              models: projectSessionModelCatalog(scope, result.models, currentConfig),
            }
          : result;
      const policy = prepareOperatorModelPresentation({
        cfg: currentConfig,
        policyConfig: context.getCommittedRuntimeConfig?.() ?? currentConfig,
        client,
      })?.forAgent(resolved.agentId, projected.models);
      respond(
        true,
        projectModelFastModeCatalog(policy ? policy.catalog(projected) : projected, client),
        undefined,
      );
      if (params.refresh === true) {
        void Promise.resolve()
          .then(() => applyRemoteModelCatalogUpdate(context.getRuntimeConfig))
          .catch((error: unknown) => {
            context.logGateway.warn("remote model catalog adoption failed", {
              error: String(error),
            });
          });
      }
    } catch (error) {
      if (error instanceof UnknownModelCatalogProviderError) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
        return;
      }
      if (error instanceof SessionMutationAuthorizationChangedError) {
        respond(false, undefined, error.error);
        return;
      }
      if (error instanceof PreparedModelRuntimePublicationSupersededError) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, { retryable: true, retryAfterMs: 0 }),
        );
        return;
      }
      if (!(error instanceof ModelAccountConnectAuthorityError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
    } finally {
      (publicationScope ?? scope)?.release?.();
    }
  },
};
