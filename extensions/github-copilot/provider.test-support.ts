import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginApi, ProviderCatalogResult } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { expect, vi } from "vitest";
import plugin from "./index.js";

type RegisteredProvider = Parameters<OpenClawPluginApi["registerProvider"]>[0];
type GithubCopilotTestProvider = RegisteredProvider & {
  catalog: {
    run: (ctx: unknown) => Promise<ProviderCatalogResult>;
  };
  prepareDynamicModel: NonNullable<RegisteredProvider["prepareDynamicModel"]>;
  resolveDynamicModel: NonNullable<RegisteredProvider["resolveDynamicModel"]>;
  preferRuntimeResolvedModel: NonNullable<RegisteredProvider["preferRuntimeResolvedModel"]>;
  prepareRuntimeAuth: NonNullable<RegisteredProvider["prepareRuntimeAuth"]>;
  resolveThinkingProfile: NonNullable<RegisteredProvider["resolveThinkingProfile"]>;
};

export function registerProviderWithPluginConfig(pluginConfig: Record<string, unknown>) {
  const registerProviderMock = vi.fn<OpenClawPluginApi["registerProvider"]>();
  plugin.register(
    createTestPluginApi({
      id: "github-copilot",
      pluginConfig,
      registerProvider: registerProviderMock,
    }),
  );
  expect(registerProviderMock).toHaveBeenCalledTimes(1);
  return expectDefined(
    registerProviderMock.mock.calls[0]?.[0],
    "provider registration",
  ) as GithubCopilotTestProvider;
}
