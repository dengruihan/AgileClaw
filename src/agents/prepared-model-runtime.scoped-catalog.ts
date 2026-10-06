import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { modelCatalogRowToEntry } from "./model-catalog-entry.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";
import { ensureOpenClawModelsJson, planOpenClawModelsJsonSource } from "./models-config.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import { prepareWorkspaceBuildGroup } from "./prepared-model-runtime.facts.js";
import {
  materializePreparedModelCatalog,
  prepareFullCatalogFacts,
} from "./prepared-model-runtime.full-catalog.js";
import { discardPreparedPluginGeneration } from "./prepared-model-runtime.plugin-lifetime.js";
import type {
  PreparedModelRuntimeCatalogMode,
  PreparedModelRuntimeInput,
  PreparedModelRuntimePluginGeneration,
} from "./prepared-model-runtime.types.js";

/** Builds a request-scoped read-only catalog; live discovery requires an explicit mode. */
export async function prepareScopedReadOnlyModelCatalog(
  input: PreparedModelRuntimeInput,
  catalogMode: PreparedModelRuntimeCatalogMode = "static",
): Promise<ModelCatalogSnapshot> {
  const scopedInput = input.readOnly ? input : { ...input, readOnly: true };
  const { agentFacts, pluginGeneration } = await prepareWorkspaceBuildGroup(
    [scopedInput],
    catalogMode,
  );
  await using _ = {
    [Symbol.asyncDispose]: () => discardPreparedPluginGeneration(pluginGeneration),
  };
  const agentFactsForInput = agentFacts[0];
  if (!agentFactsForInput) {
    throw new Error("scoped prepared model catalog facts are missing");
  }
  await ensureAgentCatalogSource(agentFactsForInput, pluginGeneration, false);
  const { modelCatalog, configuredRuntimeModels } = await prepareFullCatalogFacts(
    agentFactsForInput,
    pluginGeneration,
    catalogMode,
  );
  return materializePreparedModelCatalog(
    modelCatalog,
    agentFactsForInput.runtimeCapabilityModels,
    configuredRuntimeModels.map(({ model }) => modelCatalogRowToEntry(model)),
  );
}

/**
 * Keeps the agent's generated models.json current before a catalog build reads it.
 * Discovery outcomes belong to the explicit models.discover flow, not this source.
 */
export async function ensureAgentCatalogSource(
  agentFacts: Pick<PreparedModelRuntimeAgentFacts, "input" | "env">,
  pluginGeneration: PreparedModelRuntimePluginGeneration,
  persist = true,
): Promise<void> {
  const { env, input } = agentFacts;
  const options = {
    pluginMetadataSnapshot: pluginGeneration.pluginMetadataSnapshot,
    ...(input.workspaceDir ? { workspaceDir: input.workspaceDir } : {}),
    ...(input.env ? { env } : {}),
  };
  const prepareSource = async () => {
    if (!persist) {
      await planOpenClawModelsJsonSource(input.config, input.agentDir, options);
      return;
    }
    if (!input.readOnly) {
      await ensureOpenClawModelsJson(input.config, input.agentDir, options);
    }
  };
  const { pluginMetadataSnapshot: metadataSnapshot, pluginRegistry } = pluginGeneration;
  return pluginRegistry
    ? withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, prepareSource)
    : prepareSource();
}
