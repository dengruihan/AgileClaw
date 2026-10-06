import { describe, expect, it } from "vitest";
import { applyStepFunPlanConfigCn, applyStepFunStandardConfig } from "./onboard.js";

describe.each([
  ["stepfun", applyStepFunStandardConfig, ["step-3.7-flash", "step-3.5-flash"]],
  [
    "stepfun-plan",
    applyStepFunPlanConfigCn,
    ["step-3.7-flash", "step-3.5-flash", "step-3.5-flash-2603"],
  ],
] as const)("%s setup", (provider, apply, rows) => {
  it("seeds the shipped catalog and retains aliases", () => {
    const config = apply({});

    expect(config.models?.providers?.[provider]?.models.map((model) => model.id)).toEqual(rows);
    expect(config.agents?.defaults?.models?.[`${provider}/step-3.7-flash`]).toEqual({});
    expect(config.agents?.defaults?.models?.[`${provider}/step-3.5-flash`]?.alias).toBeDefined();
    expect(apply(config)).toEqual(config);
  });
});
