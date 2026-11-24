import { describe, expect, it, onTestFinished } from "vitest";
import {
  readProviderIconConfig,
  readProviderIconConfigEntries,
  registerProviderIconConfigSource,
} from "./provider-icon-source.ts";

const config = {
  models: {
    providers: {
      "custom-relay": { displayName: "  Relay  ", icon: "mistral", iconManual: true },
      openai: { models: [] },
      broken: "not-an-entry",
    },
  },
};

function useConfigSource(): void {
  onTestFinished(registerProviderIconConfigSource(() => config));
}

describe("readProviderIconConfigEntries", () => {
  it("reads authored icon fields and skips malformed entries", () => {
    expect(readProviderIconConfigEntries(config)).toEqual({
      "custom-relay": { displayName: "Relay", icon: "mistral", iconManual: true },
      openai: { displayName: null, icon: null, iconManual: false },
    });
  });

  it("returns no entries for an empty or malformed config", () => {
    expect(readProviderIconConfigEntries(null)).toEqual({});
    expect(readProviderIconConfigEntries({ models: { providers: [] } })).toEqual({});
  });
});

describe("readProviderIconConfig", () => {
  it("returns null before bootstrap registers a config source", () => {
    expect(readProviderIconConfig("custom-relay")).toBeNull();
  });

  it("reads the stored entry for an authored provider key", () => {
    useConfigSource();
    expect(readProviderIconConfig("custom-relay")).toEqual({
      displayName: "Relay",
      icon: "mistral",
      iconManual: true,
    });
  });

  it("matches canonical provider ids against authored keys case-insensitively", () => {
    useConfigSource();
    expect(readProviderIconConfig(" CUSTOM-RELAY ")).toEqual({
      displayName: "Relay",
      icon: "mistral",
      iconManual: true,
    });
  });

  it("returns null when the registered config is empty or the provider is unknown", () => {
    onTestFinished(registerProviderIconConfigSource(() => ({})));
    expect(readProviderIconConfig("custom-relay")).toBeNull();
    expect(readProviderIconConfig("")).toBeNull();
  });

  it("stops serving entries after the registration is released", () => {
    const unregister = registerProviderIconConfigSource(() => config);
    expect(readProviderIconConfig("custom-relay")).not.toBeNull();
    unregister();
    expect(readProviderIconConfig("custom-relay")).toBeNull();
  });
});
