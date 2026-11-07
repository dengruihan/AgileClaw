/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_APPEARANCE_PREFERENCE_KEYS } from "../../../packages/gateway-protocol/src/schema/ui-appearance-preferences.ts";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import { extractServerUiPrefs, type SyncedPrefKey } from "./server-prefs-state.ts";
import {
  configWithPrefs,
  createServerPrefsWriter,
  type RequestMock,
} from "./server-prefs.test-support.ts";
import {
  applyServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const profileId = "profile-ada";
const scope = "ws://profiles";
const createWriter = (request: RequestMock, canPatch = true) =>
  createServerPrefsWriter(request, scope, true, { ok: true }, canPatch);
function readOptions(
  writer: ReturnType<typeof createWriter>,
  configObject: unknown,
  id = profileId,
  onApplied = vi.fn(),
) {
  return { client: writer.state.client!, profileId: id, configObject, scope, onApplied };
}

function profileState<K extends SyncedPrefKey>(config: unknown, key: K, settings = loadSettings()) {
  return resolveServerUiPrefState(config, key, scope, settings, { profileId });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});

afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

describe("profile-bound appearance preferences", () => {
  it("normalizes profile overrides above config while rejecting malformed stored values", async () => {
    const config = configWithPrefs({
      themeMode: "dark",
      fontUi: "unsupported",
      fontChat: "lora",
    });
    const request = vi.fn(async () => ({
      status: "ok" as const,
      entries: {
        "ui.themeMode": { mode: "light" },
        "ui.fontUi": "geist",
        "ui.fontChat": { family: "lora" },
      },
    }));
    const writer = createWriter(request);
    const onApplied = vi.fn();

    await refreshProfileAppearancePrefs(readOptions(writer, config, profileId, onApplied));

    expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.get", {
      keys: ["ui.themeMode", "ui.fontUi", "ui.fontChat"],
    });
    expect(onApplied).toHaveBeenCalledWith({ themeMode: "dark", fontUi: "geist" });
    expect(loadSettings().fontChat).toBeUndefined();
    expect(loadSettings().themeMode).toBe("dark");
    expect(extractServerUiPrefs(config)).toEqual({ themeMode: "dark" });
    for (const [key, value, resetValue] of [
      ["fontUi", "geist", undefined],
      ["fontChat", undefined, undefined],
    ] as const) {
      expect(profileState(config, key, loadSettings()), key).toEqual({
        overridden: value !== undefined,
        provenance: value === undefined ? "default" : "profile",
        resetValue,
        value,
      });
    }
    expect(profileState(config, "themeMode", loadSettings()).provenance).toBe("synced");
  });

  it.each(["empty", "unavailable"] as const)(
    "retains the boot mirror while the profile is unresolved, then handles %s",
    async (outcome) => {
      const config = configWithPrefs({
        themeMode: "light",
        chatShowThinking: false,
      });
      const mirror = { themeMode: "dark" as const, fontUi: "geist" as const };
      patchSettings(mirror);
      const lastSeenKey = `openclaw.control.serverPrefs.v1:${scope}:profile:${profileId}`;
      localStorage.setItem(lastSeenKey, JSON.stringify(mirror));
      const { promise, resolve } = createDeferred<unknown>();
      const request = vi.fn(() => promise);
      const writer = createWriter(request);
      const options = readOptions(writer, config);

      applyServerUiPrefs(config, options);
      const refresh = refreshProfileAppearancePrefs(options);

      expect(loadSettings()).toMatchObject({ ...mirror, chatShowThinking: false });
      expect(JSON.parse(localStorage.getItem(lastSeenKey)!)).toEqual({
        ...mirror,
        chatShowThinking: false,
      });
      resolve(
        outcome === "unavailable" ? { status: "unavailable" } : { status: "ok", entries: {} },
      );
      await refresh;
      expect(loadSettings()).toMatchObject(
        outcome === "empty"
          ? { themeMode: "light", fontUi: undefined, chatShowThinking: false }
          : { ...mirror, chatShowThinking: false },
      );
    },
  );

  it.each([
    ["themeMode", "dark", "light"],
    ["fontUi", "geist", undefined],
  ] as const)("persists a %s reset during profile loading", async (key, saved, fallback) => {
    const preferenceKey = UI_APPEARANCE_PREFERENCE_KEYS[key];
    const config = configWithPrefs({ [key]: fallback });
    const savedEntries = { [preferenceKey]: saved };
    let entries: Record<string, string> = { ...savedEntries };
    const initial = createServerPrefsWriter(
      vi.fn(async () => ({ status: "ok", entries })),
      scope,
    );
    const options = {
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs({ ...options, client: initial.state.client! });
    resetServerUiPrefsSync();

    const delayed = createDeferred<unknown>();
    let firstRead = true;
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "users.prefs.get") {
        if (firstRead) {
          firstRead = false;
          return delayed.promise;
        }
        return { status: "ok", entries };
      }
      expect(method).toBe("users.prefs.set");
      expect(params).toEqual({ entries: { [preferenceKey]: null } });
      entries = {};
      return { status: "ok" };
    });
    const writer = createWriter(request, false);
    Object.assign(writer.state, { configSnapshot: { config } });
    applyServerUiPrefs(config, options);
    const pending = refreshProfileAppearancePrefs({ ...options, client: writer.state.client! });
    await waitForFast(() => expect(request).toHaveBeenCalledOnce());

    const previous = loadSettings();
    const state = profileState(config, key, previous);
    const next = resetServerUiPref(key, state, scope, profileId);
    expect(next[key]).toBe(fallback);
    const delta = changedServerUiPrefs(previous, next);
    expect(delta).toEqual({ [key]: null });
    const committed = vi.fn();
    pushServerUiPrefs(writer, delta!, { profileId, canWrite: true, afterCommit: committed });
    await waitForFast(() => expect(committed).toHaveBeenCalledOnce());

    // users.prefs.changed forces a fresh read before an older response can publish.
    await refreshProfileAppearancePrefs({ ...options, client: writer.state.client! });
    delayed.resolve({ status: "ok", entries: savedEntries });
    await pending;
    expect(loadSettings()[key]).toBe(fallback);
    expect(entries).toEqual({});

    resetServerUiPrefsSync();
    const reloaded = createWriter(request);
    await refreshProfileAppearancePrefs({ ...options, client: reloaded.state.client! });
    expect(loadSettings()[key]).toBe(fallback);
  });

  it.each([profileId, null])(
    "cancels a queued profile edit when reset after disconnect (%s)",
    async (profileIdAtEdit) => {
      const config = configWithPrefs({ themeMode: "dark" });
      const request = vi.fn(async (_method: string) => ({
        status: "ok",
        entries: { "ui.themeMode": "light" },
      }));
      const writer = createWriter(request);
      await refreshProfileAppearancePrefs(readOptions(writer, config));
      Object.assign(writer.state, { connected: false });
      patchSettings({ themeMode: "system" });
      pushServerUiPrefs(
        writer,
        { themeMode: "system" },
        { profileId: profileIdAtEdit, canWrite: true },
      );
      const previous = loadSettings();
      const state = resolveServerUiPrefState(undefined, "themeMode", scope, previous, {
        canSync: null,
      });
      const next = resetServerUiPref("themeMode", state, scope);
      expect(next.themeMode).toBe("light");
      expect(changedServerUiPrefs(previous, next)).toBeNull();

      resetServerUiPrefsSync();
      const reconnected = createWriter(request);
      flushServerUiPrefs(reconnected, { profileId: null, canWrite: true });
      flushServerUiPrefs(reconnected, { profileId, canWrite: true });
      await refreshProfileAppearancePrefs(readOptions(reconnected, config));
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "users.prefs.get",
        "users.prefs.get",
      ]);
      expect(loadSettings().themeMode).toBe("light");
    },
  );

  it.each([false, true])(
    "keeps profile-only fonts out of config writes after offline=%s edits",
    async (offline) => {
      const request = vi.fn(async () => ({}));
      const writer = createServerPrefsWriter(request, scope, !offline);
      patchSettings({ fontUi: "geist", fontChat: "lora" });
      pushServerUiPrefs(writer, { fontUi: "geist", fontChat: "lora", themeMode: "dark" });
      if (offline) {
        expect(request).not.toHaveBeenCalled();
        flushServerUiPrefs(createServerPrefsWriter(request, scope));
      }
      await waitForFast(() =>
        expect(request).toHaveBeenCalledExactlyOnceWith("config.patch", {
          raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
          note: "control-ui prefs sync",
        }),
      );
      expect(loadSettings()).toMatchObject({ fontUi: "geist", fontChat: "lora" });
    },
  );

  it("keeps pending local edits above incoming profile updates", async () => {
    const { promise: write, resolve: releaseWrite } = createDeferred<unknown>();
    let profileMode = "dark";
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: { "ui.themeMode": profileMode } }
        : await write,
    );
    const writer = createWriter(request, false);
    const config = configWithPrefs({ themeMode: "system" });
    const options = readOptions(writer, config);
    await refreshProfileAppearancePrefs(options);
    patchSettings({ themeMode: "light" });
    const afterCommit = vi.fn();
    pushServerUiPrefs(writer, { themeMode: "light" }, { profileId, canWrite: true, afterCommit });
    await waitForFast(() =>
      expect(request).toHaveBeenCalledWith("users.prefs.set", {
        entries: { "ui.themeMode": "light" },
      }),
    );
    profileMode = "dark";

    await refreshProfileAppearancePrefs(options);
    expect(request.mock.calls.filter(([method]) => method === "users.prefs.get")).toHaveLength(2);

    expect(loadSettings().themeMode).toBe("light");
    expect(profileState(config, "themeMode", loadSettings())).toMatchObject({
      provenance: "pending",
      value: "light",
    });
    releaseWrite({ status: "ok" });
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(profileState(config, "themeMode", loadSettings())).toMatchObject({
      provenance: "profile",
      value: "light",
    });
    Object.assign(writer.state, { configSnapshot: { config } });
    const previous = loadSettings();
    const reset = resetServerUiPref(
      "themeMode",
      profileState(config, "themeMode"),
      scope,
      profileId,
    );
    expect(reset.themeMode).toBe("system");
    const delta = changedServerUiPrefs(previous, reset);
    expect(delta).toEqual({ themeMode: null });
    afterCommit.mockClear();
    pushServerUiPrefs(writer, delta!, { profileId, canWrite: true, afterCommit });
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());
    expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
      entries: { "ui.themeMode": null },
    });
    expect(profileState(config, "themeMode")).toMatchObject({
      provenance: "synced",
      value: "system",
    });
  });

  it("keeps read-only profile edits device-local without attempting a profile write", async () => {
    const config = configWithPrefs({ themeMode: "system" });
    const request = vi.fn(async () => ({ status: "ok" as const, entries: {} }));
    const writer = createWriter(request, false);
    await refreshProfileAppearancePrefs(readOptions(writer, config));
    patchSettings({ themeMode: "dark" });
    const afterCommit = vi.fn();

    pushServerUiPrefs(writer, { themeMode: "dark" }, { profileId, canWrite: false, afterCommit });

    expect(request).toHaveBeenCalledOnce();
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: false, retainedLocal: true });
    expect(
      resolveServerUiPrefState(config, "themeMode", scope, loadSettings(), {
        profileId,
        canSync: false,
      }),
    ).toMatchObject({ provenance: "device-local", value: "dark" });
  });

  it("targets reset at the gateway value so an explicit product-default choice persists", async () => {
    const config = configWithPrefs({ themeMode: "light" });
    const request = vi.fn(async (method: string) =>
      method === "users.prefs.get"
        ? { status: "ok" as const, entries: {} }
        : { status: "ok" as const },
    );
    const writer = createWriter(request, false);
    await refreshProfileAppearancePrefs(readOptions(writer, config));

    const state = profileState(config, "themeMode", loadSettings());
    expect(state).toMatchObject({ provenance: "synced", resetValue: "light", value: "light" });

    patchSettings({ themeMode: "system" });
    pushServerUiPrefs(writer, { themeMode: "system" }, { profileId, canWrite: true });
    await waitForFast(() =>
      expect(request).toHaveBeenLastCalledWith("users.prefs.set", {
        entries: { "ui.themeMode": "system" },
      }),
    );

    const reset = resetServerUiPref("themeMode", state, scope, profileId);
    expect(reset.themeMode).toBe("light");
  });

  it("restores profile appearance after reloading during a pending identity switch", async () => {
    const config = configWithPrefs({});
    let activeProfile = "profile-b";
    const request = vi.fn(async () => ({
      status: "ok",
      entries:
        activeProfile === "profile-b"
          ? { "ui.themeMode": "dark" }
          : { "ui.themeMode": "light", "ui.fontUi": "geist" },
    }));
    const writer = createWriter(request);
    const options = (selectedProfileId: string) => readOptions(writer, config, selectedProfileId);
    await refreshProfileAppearancePrefs(options(activeProfile));
    activeProfile = "profile-a";
    await refreshProfileAppearancePrefs(options(activeProfile));
    expect(loadSettings().themeMode).toBe("light");
    expect(loadSettings().fontUi).toBe("geist");
    activeProfile = "profile-b";
    applyServerUiPrefs(config, options(activeProfile));
    resetServerUiPrefsSync();
    applyServerUiPrefs(config, options(activeProfile));

    await refreshProfileAppearancePrefs(options(activeProfile));

    expect(loadSettings()).toMatchObject({ themeMode: "dark", fontUi: undefined });
  });
});
