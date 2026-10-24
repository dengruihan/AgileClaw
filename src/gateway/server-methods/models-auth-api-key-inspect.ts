import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  ErrorCodes,
  errorShape,
  validateModelsAuthInspectApiKeyParams,
  type ModelsAuthInspectApiKeyResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAuthProfileOrder } from "../../agents/auth-profiles/order.js";
import { resolveProviderEnvAuthLookupMaps } from "../../agents/model-auth-env-vars.js";
import { resolveProviderEnvAuthEvidence } from "../../agents/model-auth-env.js";
import {
  resolveProviderConfigSecretInput,
  resolveProviderEntryApiKeyProfileReference,
} from "../../agents/model-auth-provider-config.js";
import {
  normalizeManualAuthProvider,
  resolveDefaultTokenProfileId,
} from "../../commands/models/auth-manual-input.js";
import { readConfigFileSnapshot, type OpenClawConfig } from "../../config/config.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import {
  readPreparedCatalog,
  type PreparedGatewayModelCatalogSnapshot,
} from "../server-model-catalog-auth.js";
import { resolveModelAuthAgentScope } from "./model-auth-agent-scope.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

type Inspection = Pick<
  ModelsAuthInspectApiKeyResult,
  "configured" | "source" | "key" | "profileId"
>;

function inspectApiKey(
  config: OpenClawConfig,
  prepared: PreparedGatewayModelCatalogSnapshot,
  provider: string,
  reveal: boolean,
): Inspection {
  const store = prepared.authStore;
  const lookup = {
    config,
    workspaceDir: prepared.workspaceDir,
    metadataSnapshot: prepared.metadataSnapshot,
    includeUntrustedWorkspacePlugins: false,
  };
  const connectionId = findNormalizedProviderKey(config.models?.providers, provider);
  const connection = connectionId ? config.models?.providers?.[connectionId] : undefined;
  if (connection?.auth && connection.auth !== "api-key") {
    return { configured: true, source: "unsupported" };
  }
  const { ref } = resolveProviderConfigSecretInput(config, provider, config);
  if (ref) {
    return { configured: true, source: ref.source === "env" ? "environment" : "reference" };
  }
  const binding = resolveProviderEntryApiKeyProfileReference({
    cfg: config,
    sourceConfig: config,
    provider,
    store,
    authAliasLookupParams: lookup,
  });
  if (binding.kind === "literal") {
    return { configured: true, source: "literal", ...(reveal ? { key: binding.apiKey } : {}) };
  }
  if (binding.kind === "profile-incompatible") {
    return { configured: true, source: "unsupported" };
  }
  if (binding.kind === "marker") {
    return {
      configured: binding.evidence === "environment",
      source: binding.evidence === "environment" ? "environment" : "none",
    };
  }
  // Match the existing writer's target: configured bindings win; an unbound
  // configured connection uses its manual profile, while implicit providers use order.
  const profileId =
    binding.kind === "profile"
      ? binding.profileId
      : ((!connectionId
          ? resolveAuthProfileOrder({
              cfg: config,
              store,
              provider,
              authAliasLookupParams: lookup,
            }).find((id) => store.profiles[id]?.type === "api_key" && !store.profiles[id]?.keyRef)
          : undefined) ?? resolveDefaultTokenProfileId(provider));
  const credential = store.profiles[profileId];
  if (credential) {
    if (
      isUserModelAuthProfileId(profileId) ||
      credential.type !== "api_key" ||
      normalizeProviderId(credential.provider) !== provider
    ) {
      return { configured: true, source: "unsupported" };
    }
    // Runtime snapshots can contain hydrated bytes alongside the authored ref.
    // Authoring inspection never reveals those externally managed values.
    if (credential.keyRef) {
      return { configured: true, source: "reference", profileId };
    }
    if (credential.key) {
      return {
        configured: true,
        source: "profile",
        profileId,
        ...(reveal ? { key: credential.key } : {}),
      };
    }
  }
  const envMaps = resolveProviderEnvAuthLookupMaps({ ...lookup, env: process.env });
  const evidence = resolveProviderEnvAuthEvidence(provider, process.env, {
    aliasMap: envMaps.aliasMap,
    candidateMap: envMaps.envCandidateMap,
    authEvidenceMap: envMaps.authEvidenceMap,
  });
  return evidence?.mode === "api-key"
    ? { configured: true, source: "environment" }
    : { configured: false, source: "none" };
}

export const modelsAuthApiKeyInspectHandlers: GatewayRequestHandlers = {
  "models.authInspectApiKey": defineValidatedGatewayHandler(
    "models.authInspectApiKey",
    validateModelsAuthInspectApiKeyParams,
    async ({ params, client, context, respond, signal, hasCurrentClientAuthority }) => {
      const authorized = () =>
        Boolean(
          client &&
          !client.invalidated &&
          !client.connectionSignal?.aborted &&
          client.connect.scopes?.includes("operator.admin") &&
          !signal?.aborted &&
          (!hasCurrentClientAuthority || hasCurrentClientAuthority()),
        );
      const deny = () =>
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Current administrator access is required to inspect model API keys.",
          ),
        );
      if (!authorized()) {
        deny();
        return;
      }
      try {
        const provider = normalizeManualAuthProvider(params.provider);
        const scope = resolveModelAuthAgentScope(context.getRuntimeConfig(), params.agentId);
        if (!scope.ok) {
          respond(false, undefined, scope.error);
          return;
        }
        const snapshot = await readConfigFileSnapshot();
        if (!authorized()) {
          deny();
          return;
        }
        const baseHash = snapshot.hash
          ? context.configRevisionProjector.projectRawHash(snapshot.hash)
          : undefined;
        if (!baseHash || baseHash !== params.baseHash) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "Configuration changed. Reload Models before inspecting this API key.",
            ),
          );
          return;
        }
        const prepared = await readPreparedCatalog(context, scope.agentId);
        if (!authorized()) {
          deny();
          return;
        }
        if (!prepared?.isCurrent()) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              "Model authentication is refreshing. Reload Models and try again.",
            ),
          );
          return;
        }
        const result: ModelsAuthInspectApiKeyResult = {
          provider,
          agentId: scope.agentId,
          baseHash,
          ...inspectApiKey(snapshot.sourceConfig, prepared, provider, params.reveal === true),
        };
        respond(true, result, undefined);
      } catch {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "API key inspection is unavailable. Reload Models and try again.",
          ),
        );
      }
    },
  ),
};
