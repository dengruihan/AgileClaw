import { describe, expect, it } from "vitest";
import type { ModelAuthStatusResult } from "../../api/types.ts";
import { buildLoginProviders } from "./login-providers.ts";

function authStatusWithVariants(): ModelAuthStatusResult {
  return {
    ts: 1,
    providers: [],
    providerCapabilities: [
      {
        provider: "zai",
        apiKeySupported: true,
        quickApiKeySetup: true,
        loginOptions: [
          {
            id: "zai/zai-coding-global",
            brandId: "zai",
            groupLabel: "Z.AI",
            label: "Coding-Plan-Global",
            kind: "secret",
            featured: false,
          },
          {
            id: "zai/zai-coding-cn",
            brandId: "zai",
            groupLabel: "Z.AI",
            label: "Coding-Plan-CN",
            kind: "secret",
            featured: false,
          },
        ],
      },
    ],
  };
}

describe("buildLoginProviders", () => {
  it("keeps the manual setup entry when both surfaces list the same secret choice", () => {
    const groups = buildLoginProviders({
      authStatus: authStatusWithVariants(),
      allowQuickApiKey: false,
      manualProviders: [
        {
          id: "zai-coding-cn",
          brandId: "zai",
          groupLabel: "Z.AI",
          label: "Coding-Plan-CN",
        },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.choices.map((choice) => [choice.id, choice.kind])).toEqual([
      ["zai/zai-coding-global", "secret"],
      ["zai-coding-cn", "setup-secret"],
    ]);
  });

  it("keeps browser sign-in when the manual entry lists the same choice", () => {
    const groups = buildLoginProviders({
      allowQuickApiKey: false,
      authStatus: {
        ts: 1,
        providers: [],
        providerCapabilities: [
          {
            provider: "github-copilot",
            apiKeySupported: false,
            quickApiKeySetup: false,
            loginOptions: [
              {
                id: "github-copilot/github-copilot",
                brandId: "github-copilot",
                groupLabel: "Copilot",
                label: "GitHub Copilot",
                kind: "device-code",
                featured: false,
              },
            ],
          },
        ],
      },
      manualProviders: [
        {
          id: "github-copilot",
          brandId: "github-copilot",
          groupLabel: "Copilot",
          label: "GitHub Copilot",
          hint: "Device login with your GitHub account",
        },
      ],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.choices.map((choice) => [choice.id, choice.kind])).toEqual([
      ["github-copilot/github-copilot", "device-code"],
      ["github-copilot", "setup-secret"],
    ]);
  });
  it.each([false, true])(
    "groups plan credentials by their declared family (setup: %s)",
    (setup) => {
      const capabilities = ["qwen", "qwen-token-plan"].map((provider) => ({
        provider,
        apiKeySupported: true,
        quickApiKeySetup: true,
        loginOptions: [
          {
            id: `qwen/${provider}-key`,
            brandId: provider,
            groupId: "qwen",
            groupLabel: "Qwen Cloud",
            label: provider === "qwen" ? "Coding Plan" : "Token Plan",
            kind: "secret" as const,
            featured: false,
          },
        ],
      }));
      const groups = buildLoginProviders({
        authStatus: { ts: 1, providers: [], providerCapabilities: capabilities },
        allowQuickApiKey: !setup,
        manualProviders: setup
          ? capabilities.map((capability) => ({
              id: `${capability.provider}-key`,
              brandId: capability.provider,
              groupLabel: "Qwen Cloud",
              label: capability.loginOptions[0]!.label,
            }))
          : undefined,
      });
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({
        id: "qwen",
        label: "Qwen Cloud",
        authProviders: ["qwen", "qwen-token-plan"],
      });
      expect(groups[0]!.choices.map(({ brandId, kind }) => [brandId, kind])).toEqual([
        ["qwen", setup ? "setup-secret" : "secret"],
        ["qwen-token-plan", setup ? "setup-secret" : "secret"],
      ]);
      expect(groups[0]!.apiKeyProvider).toBe(setup ? undefined : "qwen");
    },
  );
});
