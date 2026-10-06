import { describe, expect, it } from "vitest";
import { buildTokenHubProvider, buildTokenPlanProvider } from "./api.js";
import { applyTokenHubConfig, applyTokenPlanConfig } from "./onboard.js";

describe("Tencent onboarding", () => {
  it.each([
    { providerId: "tencent-tokenhub", apply: applyTokenHubConfig, build: buildTokenHubProvider },
    { providerId: "tencent-tokenplan", apply: applyTokenPlanConfig, build: buildTokenPlanProvider },
  ])("seeds $providerId rows after authored rows", ({ providerId, apply, build }) => {
    const provider = build();
    expect(apply({}).models?.providers?.[providerId]?.models.map((model) => model.id)).toEqual(
      provider.models.map((model) => model.id),
    );
    const authored = provider.models.map((model) =>
      Object.assign({}, model, { id: `operator-${model.id}` }),
    );
    const result = apply({
      models: { providers: { [providerId]: { ...provider, models: authored } } },
    });
    expect(result.models?.providers?.[providerId]?.models).toEqual([
      ...authored,
      ...provider.models,
    ]);
  });
});
