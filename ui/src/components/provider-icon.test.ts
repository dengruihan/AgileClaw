/* @vitest-environment jsdom */
import { render } from "lit";
import { describe, expect, it, onTestFinished } from "vitest";
import { registerProviderIconConfigSource } from "../lib/provider-icon-source.ts";
import { icons } from "./icons.ts";
import {
  compareCloudProfiles,
  hasProviderBrandIcon,
  renderProviderBrandIcon,
  resolveCloudProfileIcon,
} from "./provider-icon.ts";

/** Registers the config object a booting app would expose to icon surfaces. */
function registerProviders(providers: Record<string, unknown>) {
  onTestFinished(registerProviderIconConfigSource(() => ({ models: { providers } })));
}

function iconId(container: HTMLElement): string | null {
  return (
    container.querySelector("[data-provider-icon]")?.getAttribute("data-provider-icon") ?? null
  );
}

function fallbackLetter(container: HTMLElement): string | null {
  return container.querySelector(".provider-brand-icon--fallback")?.textContent?.trim() ?? null;
}

describe("cloud provider presentation", () => {
  it.each(["google", "machine0"])(
    "orders backend %s before local/custom profiles regardless of their names",
    (backend) => {
      const cloud = { id: "z-local", providerId: "crabbox", providerDisplayId: backend };
      const infrastructure = { id: "a-aws", providerId: "aws", providerDisplayId: "constructor" };
      expect(compareCloudProfiles(cloud, infrastructure)).toBeLessThan(0);
      expect(compareCloudProfiles(infrastructure, cloud)).toBeGreaterThan(0);
      expect(
        compareCloudProfiles(
          { id: "z-local", providerId: backend },
          { id: "a-aws", providerId: "crabbox" },
        ),
      ).toBeLessThan(0);
    },
  );

  it("keeps alphabetical order within each group without changing the catalog", () => {
    const profiles = [
      { id: "b", providerId: "incus" },
      { id: "z", providerId: "machine0" },
      { id: "a", providerId: "custom" },
      { id: "y", providerId: "aws" },
    ];
    expect(profiles.toSorted(compareCloudProfiles).map((p) => p.id)).toEqual(["y", "z", "a", "b"]);
    expect(profiles.map((p) => p.id)).toEqual(["b", "z", "a", "y"]);
  });
  it("keeps Google Cloud separate from model-provider brands", () => {
    const container = document.createElement("div");
    render(
      resolveCloudProfileIcon({ providerId: "crabbox", providerDisplayId: "google" }).icon,
      container,
    );
    expect(container.querySelector('[data-provider-icon="gcp"]')).not.toBeNull();
    render(renderProviderBrandIcon("google"), container);
    expect(container.querySelector('[data-provider-icon="gemini"]')).not.toBeNull();
  });
  it.each([
    ["machine0", icons.server],
    ["incus", icons.server],
    ["docker", icons.box],
    ["constructor", icons.cloud],
  ])("uses shared generic geometry for %s", (providerId, expectedIcon) => {
    const actual = document.createElement("div"),
      expected = document.createElement("div");
    render(resolveCloudProfileIcon({ providerId }).icon, actual);
    render(expectedIcon, expected);
    expect(actual.querySelector("svg")?.outerHTML).toBe(expected.querySelector("svg")?.outerHTML);
    expect(actual.querySelector("[data-provider-icon]")).toBeNull();
  });
});

describe("model provider brand icons", () => {
  it("renders the icon saved in provider config for an unknown provider id", () => {
    registerProviders({ "custom-relay": { displayName: "Relay", icon: "mistral" } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("custom-relay"), container);
    expect(iconId(container)).toBe("mistral");
    expect(hasProviderBrandIcon("custom-relay")).toBe(true);
  });

  it("prefers the saved icon over the exact provider-id mark", () => {
    registerProviders({ google: { icon: "mistral" } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("google"), container);
    expect(iconId(container)).toBe("mistral");
  });

  it("shows the configured name's first letter after a manual icon removal", () => {
    registerProviders({ "custom-relay": { displayName: "Relay Cloud", iconManual: true } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("custom-relay"), container);
    expect(iconId(container)).toBeNull();
    expect(fallbackLetter(container)).toBe("R");
    expect(hasProviderBrandIcon("custom-relay")).toBe(false);
  });

  it("does not restore the exact provider-id mark after a manual removal", () => {
    registerProviders({ anthropic: { displayName: "My Claude", iconManual: true } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("anthropic"), container);
    expect(iconId(container)).toBeNull();
    expect(fallbackLetter(container)).toBe("M");
  });

  it("falls back to the configured name when the saved icon is not a bundled asset", () => {
    registerProviders({ "custom-relay": { displayName: "Relay", icon: "missing-brand" } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("custom-relay"), container);
    expect(iconId(container)).toBeNull();
    expect(fallbackLetter(container)).toBe("R");
  });

  it("uses the configured display name for the letter badge without a saved icon", () => {
    registerProviders({ "custom-relay": { displayName: "中转服务" } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("custom-relay"), container);
    expect(iconId(container)).toBeNull();
    expect(fallbackLetter(container)).toBe("中");
  });

  it("lets an explicit draft icon outrank the saved config", () => {
    registerProviders({ "custom-relay": { displayName: "Relay", icon: "mistral" } });
    const container = document.createElement("div");
    render(renderProviderBrandIcon("custom-relay", { icon: "claude" }), container);
    expect(iconId(container)).toBe("claude");
  });

  it("previews a draft with no icon from the draft name", () => {
    registerProviders({ "custom-relay": { displayName: "Relay", icon: "mistral" } });
    const container = document.createElement("div");
    render(
      renderProviderBrandIcon("custom-relay", { icon: null, fallbackLabel: "自定义中转" }),
      container,
    );
    expect(iconId(container)).toBeNull();
    expect(fallbackLetter(container)).toBe("自");
  });

  it.each([
    { provider: "google", icon: "gemini" },
    { provider: "anthropic", icon: "claude" },
    { provider: "openai", icon: "codex" },
    { provider: "lmstudio", icon: "lmstudio" },
  ])(
    "keeps the built-in exact-id mark for $provider without a registered source",
    ({ provider, icon }) => {
      const container = document.createElement("div");
      render(renderProviderBrandIcon(provider), container);
      expect(iconId(container)).toBe(icon);
    },
  );

  it("keeps the provider-id letter and unknown-id fallback without a registered source", () => {
    const container = document.createElement("div");
    render(renderProviderBrandIcon("custom-provider"), container);
    expect(iconId(container)).toBeNull();
    expect(fallbackLetter(container)).toBe("C");
  });
});
