// Regression coverage: the configured models.list projection keeps the authored
// model-settings order for Chat session reads and the New Session scope.
import { describe, expect, it } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildModelsListResult } from "./models-list-result.js";
import { createModelsListTestContext } from "./models-list-result.openai-routes.test-support.js";

const AUTHORED_MODEL_IDS = ["alpha", "bravo", "charlie", "delta", "echo"] as const;

function configuredFixture(extraModelIds: readonly string[] = []) {
  const modelIds = [...AUTHORED_MODEL_IDS, ...extraModelIds];
  const cfg = {
    agents: {
      defaults: { model: { primary: "fixture/charlie" } },
    },
    models: {
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: "https://fixture.invalid/v1",
          apiKey: "synthetic-key",
          models: AUTHORED_MODEL_IDS.map((id) => ({ id, name: `Model ${id}` })),
        },
      },
    },
  } as OpenClawConfig;
  const catalog = modelIds.map(
    (id) =>
      ({
        provider: "fixture",
        id,
        name: `Model ${id}`,
        api: "openai-completions",
      }) satisfies ModelCatalogEntry,
  );
  return { cfg, catalog };
}

async function readConfiguredModelIds(options: {
  extraModelIds?: readonly string[];
  includeManualSelection?: boolean;
  sessionEntry?: { modelOverride: string; providerOverride: string };
}) {
  const { cfg, catalog } = configuredFixture(options.extraModelIds);
  const context = createModelsListTestContext({ cfg, catalog });
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
  return result.models.map((model) => model.id);
}

describe("models.list configured picker order", () => {
  it.each(["delta", "echo"])(
    "keeps the authored order when the Chat session selects %s",
    async (selected) => {
      await expect(
        readConfiguredModelIds({
          includeManualSelection: true,
          sessionEntry: { modelOverride: selected, providerOverride: "fixture" },
        }),
      ).resolves.toEqual([...AUTHORED_MODEL_IDS]);
    },
  );

  it("keeps the authored order for the New Session configured scope", async () => {
    await expect(readConfiguredModelIds({})).resolves.toEqual([...AUTHORED_MODEL_IDS]);
  });

  it("keeps a selected model outside the authored list visible without promoting it", async () => {
    await expect(
      readConfiguredModelIds({
        includeManualSelection: true,
        extraModelIds: ["foxtrot"],
        sessionEntry: { modelOverride: "foxtrot", providerOverride: "fixture" },
      }),
    ).resolves.toEqual([...AUTHORED_MODEL_IDS, "foxtrot"]);
  });
});
