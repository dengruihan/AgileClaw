// Regression coverage: the configured models.list projection keeps the authored
// model-settings order for Chat session reads and the New Session scope.
import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildModelsListResult } from "./models-list-result.js";
import {
  createModelsListTestContext,
  WITHOUT_OPENAI_ENV_AUTH,
} from "./models-list-result.openai-routes.test-support.js";

// Non-alphabetical on purpose: provider declaration order (zeta before alpha
// and openai) and non-alphabetical model arrays prove authored order, not the
// provider/id fallback comparator.
const AUTHORED_ORDER = [
  "zeta/m-current",
  "zeta/z-strong",
  "zeta/a-small",
  "openai/z-last",
  "openai/a-first",
] as const;

function configuredFixture() {
  const cfg = {
    agents: {
      defaults: { model: { primary: "zeta/z-strong" } },
    },
    models: {
      providers: {
        zeta: {
          api: "openai-completions",
          baseUrl: "https://zeta.invalid/v1",
          apiKey: "synthetic-key",
          models: [
            { id: "m-current", name: "Zeta current" },
            { id: "z-strong", name: "Zeta strong" },
            { id: "a-small", name: "Zeta small" },
          ],
        },
        openai: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          models: [
            { id: "z-last", name: "OpenAI last" },
            { id: "a-first", name: "OpenAI first" },
          ],
        },
      },
    },
  } as OpenClawConfig;
  const catalog = AUTHORED_ORDER.map(
    (ref) =>
      ({
        provider: ref.slice(0, ref.indexOf("/")),
        id: ref.slice(ref.indexOf("/") + 1),
        name: ref,
        api: "openai-completions",
      }) satisfies ModelCatalogEntry,
  );
  return { cfg, catalog };
}

async function readConfiguredModels(options: {
  extraModelIds?: readonly string[];
  includeManualSelection?: boolean;
  sessionEntry?: { modelOverride: string; providerOverride: string };
}) {
  const { cfg, catalog } = configuredFixture();
  const context = createModelsListTestContext({
    cfg,
    catalog: [
      ...catalog,
      ...(options.extraModelIds ?? []).map(
        (id) =>
          ({
            provider: "zeta",
            id,
            name: id,
            api: "openai-completions",
          }) satisfies ModelCatalogEntry,
      ),
    ],
  });
  const result = await buildModelsListResult({
    source: { kind: "gateway", context },
    agentId: "main",
    params: { view: "configured" },
    ...(options.includeManualSelection ? { includeManualSelection: true } : {}),
    ...(options.sessionEntry
      ? {
          readScope: {
            agentId: "main",
            sessionKey: "agent:main:main",
            sessionEntry: options.sessionEntry,
          },
        }
      : {}),
  });
  return result.models;
}

function modelKeys(models: Awaited<ReturnType<typeof readConfiguredModels>>) {
  return models.map((model) => `${model.provider}/${model.id}`);
}

describe("models.list configured picker order", () => {
  it.each(["zeta/m-current", "openai/a-first"])(
    "keeps non-alphabetical authored order when the Chat session selects %s",
    async (selected) => {
      await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
        const [provider, model] = selected.split("/");
        const models = await readConfiguredModels({
          includeManualSelection: true,
          sessionEntry: { modelOverride: model, providerOverride: provider },
        });
        expect(modelKeys(models)).toEqual([...AUTHORED_ORDER]);
      });
    },
  );

  it("keeps the authored order for the New Session configured scope", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const models = await readConfiguredModels({});
      expect(modelKeys(models)).toEqual([...AUTHORED_ORDER]);
    });
  });

  it("keeps a pinned unavailable selection in its authored slot", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const models = await readConfiguredModels({
        includeManualSelection: true,
        sessionEntry: { modelOverride: "z-last", providerOverride: "openai" },
      });
      expect(modelKeys(models)).toEqual([...AUTHORED_ORDER]);
      expect(models[3]).toMatchObject({
        provider: "openai",
        id: "z-last",
        available: false,
        unavailableReason: "missing-auth",
      });
    });
  });

  it("keeps a retained selection outside the authored list visible after authored rows", async () => {
    await withEnvAsync(WITHOUT_OPENAI_ENV_AUTH, async () => {
      const models = await readConfiguredModels({
        includeManualSelection: true,
        extraModelIds: ["foxtrot"],
        sessionEntry: { modelOverride: "foxtrot", providerOverride: "zeta" },
      });
      expect(modelKeys(models)).toEqual([...AUTHORED_ORDER, "zeta/foxtrot"]);
    });
  });
});
