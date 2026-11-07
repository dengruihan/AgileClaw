/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { changedServerUiPrefs } from "./server-prefs-intent.ts";
import {
  configWithPrefs,
  createServerPrefsWriter as createClient,
  type RequestMock,
} from "./server-prefs.test-support.ts";
import {
  applyServerUiPrefs,
  flushServerUiPrefs,
  pushServerUiPrefs,
  resetServerUiPref,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings, setSettingsChangeListener } from "./settings.ts";

const pendingKey = (scope: string) => `openclaw.control.serverPrefs.pending.v1:${scope}`;
const readPending = (scope: string) =>
  JSON.parse(localStorage.getItem(pendingKey(scope)) ?? "{}") as Record<string, unknown>;

const scope = "ws://gw";
type Request = (method: string, params?: unknown) => Promise<unknown>;

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
});

afterEach(() => {
  setSettingsChangeListener(null);
  resetServerUiPrefsSync();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function expectPatch(request: RequestMock, prefs: Record<string, unknown>) {
  const params = { raw: JSON.stringify({ ui: { prefs } }), note: "control-ui prefs sync" };
  expect(request).toHaveBeenCalledWith("config.patch", params);
}

const conflictError = () =>
  new Error("config changed since last load; re-run config.get and retry");

const rejection = new GatewayRequestError({ code: "INVALID_REQUEST", message: "invalid config" });

describe("server preferences", () => {
  it("keeps presentation preferences browser-local", () => {
    const before = loadSettings();
    expect(
      changedServerUiPrefs(before, {
        ...before,
        textScale: 125,
        sidebarLiveActivity: false,
        chatMessageMaxWidth: "82%",
        showAdvancedSettings: true,
        openLinksExternally: true,
      }),
    ).toBeNull();
  });

  it("applies only valid, known pref values", () => {
    const onApplied = vi.fn();
    expect(
      applyServerUiPrefs(
        configWithPrefs({
          themeMode: "dark",
          locale: "de",
          chatShowThinking: false,
          chatShowToolCalls: false,
          chatPersistCommentary: false,
          chatSendShortcut: "modifier-enter",
          textScale: 125,
          sidebarLiveActivity: false,
          chatMessageMaxWidth: "82%",
          sidebarEntries: ["route:usage", "session:agent:main:test", "route:usage", 7],
          bogus: true,
        }),
        { onApplied },
      ),
    ).toBe(true);
    expect(onApplied).toHaveBeenCalledWith({
      themeMode: "dark",
      locale: "de",
      chatShowThinking: false,
      chatShowToolCalls: false,
      chatPersistCommentary: false,
      chatSendShortcut: "modifier-enter",
      sidebarEntries: ["route:usage", "session:agent:main:test"],
    });
  });

  it("does not reapply a retained pre-commit snapshot after an ack moves lastSeen", async () => {
    const oldSnapshot = configWithPrefs({ themeMode: "light" });
    const onApplied = vi.fn();
    applyServerUiPrefs(oldSnapshot, { scope, onApplied });
    patchSettings({ themeMode: "dark" });
    const request = vi.fn(async () => ({}));
    const client = createClient(request, scope, true, {
      ok: false,
      error: "config.get failed",
    });
    const afterCommit = vi.fn();
    pushServerUiPrefs(client, { themeMode: "dark" }, { afterCommit });
    await waitForFast(() =>
      expect(localStorage.getItem(`openclaw.control.serverPrefs.pending.v1:${scope}`)).toBeNull(),
    );

    expect(applyServerUiPrefs(oldSnapshot, { scope, onApplied })).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");
    expect(afterCommit).toHaveBeenCalledWith({ needsRefresh: true });
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), { scope, onApplied })).toBe(
      true,
    );
    expect(loadSettings().themeMode).toBe("light");
  });

  it("preserves a local sidebar edit when only another server preference changes", () => {
    const onApplied = vi.fn();
    const sidebarEntries = ["route:usage", "session:agent:main:test"];
    applyServerUiPrefs(configWithPrefs({ sidebarEntries, themeMode: "dark" }), { onApplied });
    patchSettings({ sidebarEntries: ["route:usage"] });

    expect(
      applyServerUiPrefs(
        configWithPrefs({ sidebarEntries: [...sidebarEntries], themeMode: "light" }),
        { onApplied },
      ),
    ).toBe(true);
    expect(loadSettings().sidebarEntries).toEqual(["route:usage"]);
    expect(loadSettings().themeMode).toBe("light");
    expect(onApplied).toHaveBeenLastCalledWith({ themeMode: "light" });
  });

  it("syncs an authored default-valued reset through the settings listener", async () => {
    const request = vi.fn(async () => ({}));
    const writer = createClient(request, scope);
    setSettingsChangeListener((previous, next) => {
      const prefs = changedServerUiPrefs(previous, next);
      if (prefs) {
        pushServerUiPrefs(writer, prefs);
      }
    });

    const state = resolveServerUiPrefState(
      configWithPrefs({ themeMode: "system" }),
      "themeMode",
      scope,
    );
    resetServerUiPref("themeMode", state);

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith(
        "config.patch",
        expect.objectContaining({
          raw: JSON.stringify({ ui: { prefs: { themeMode: null } } }),
        }),
      ),
    );
  });

  it("restores product defaults when authored synced values are removed", () => {
    const onApplied = vi.fn();
    applyServerUiPrefs(
      configWithPrefs({
        themeMode: "dark",
        chatSendShortcut: "modifier-enter",
        locale: "de",
        chatFollowUpMode: "queue",
      }),
      { onApplied },
    );

    const before = loadSettings();
    expect(applyServerUiPrefs(configWithPrefs({}), { onApplied })).toBe(true);
    const reset = loadSettings();
    expect(changedServerUiPrefs(before, reset)).toEqual({
      themeMode: "system",
      locale: null,
      chatSendShortcut: "enter",
      chatFollowUpMode: null,
    });
    expect(reset).toMatchObject({
      theme: "phosphor",
      themeMode: "system",
    });
    expect(reset.locale).toBeUndefined();
    expect(reset.chatFollowUpMode).toBeUndefined();
    expect(reset.chatSendShortcut).toBe("enter");
    const persisted = JSON.parse(
      localStorage.getItem(`openclaw.control.settings.v1:${reset.gatewayUrl}`) ?? "{}",
    ) as Record<string, unknown>;
    expect(Object.hasOwn(persisted, "chatSendShortcut")).toBe(false);
  });

  it("does not publish a server mode change shadowed by pending local intent", async () => {
    const requestGate = createDeferred<unknown>();
    const request = vi.fn<Request>(() => requestGate.promise);
    const client = createClient(request, scope);
    const onApplied = vi.fn();
    applyServerUiPrefs(configWithPrefs({ themeMode: "system" }), { scope, onApplied });

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "dark" }), { scope, onApplied })).toBe(
      false,
    );

    onApplied.mockClear();
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "dark", locale: "de" }), {
        scope,
        onApplied,
      }),
    ).toBe(true);
    expect(onApplied).toHaveBeenCalledExactlyOnceWith({ locale: "de" });
    expect(loadSettings().locale).toBe("de");

    requestGate.resolve({});
    await waitForFast(() => expect(localStorage.getItem(pendingKey(scope))).toBeNull());
  });

  it("keeps a synced default reset as a pending offline null intent", () => {
    const previous = loadSettings();
    const next = resetServerUiPref("themeMode");
    const prefs = changedServerUiPrefs(previous, next);
    expect(prefs).toEqual({ themeMode: null });

    pushServerUiPrefs(createClient(vi.fn(), scope, false), prefs ?? {});

    expect(readPending(scope)).toEqual({ themeMode: null });
    expect(
      resolveServerUiPrefState(configWithPrefs({ themeMode: "system" }), "themeMode", scope),
    ).toEqual({
      overridden: false,
      provenance: "pending",
      resetValue: "system",
      value: "system",
    });
  });

  it("retains a rejected local edit until that server key actually changes", async () => {
    const initialConfig = configWithPrefs({ themeMode: "system", locale: "de" });
    const onApplied = vi.fn();
    applyServerUiPrefs(initialConfig, { scope, onApplied });
    const beforeLocalEdit = loadSettings();
    const retained = patchSettings({ themeMode: "dark" });
    const prefs = changedServerUiPrefs(beforeLocalEdit, retained);
    const afterCommit = vi.fn();
    const request = vi.fn<Request>().mockRejectedValue(rejection);

    pushServerUiPrefs(createClient(request, scope), prefs ?? {}, { afterCommit });
    await waitForFast(() =>
      expect(afterCommit).toHaveBeenCalledWith({
        needsRefresh: false,
        retainedLocal: true,
      }),
    );

    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "system", locale: "de" }), {
        scope,
        onApplied,
      }),
    ).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");

    resetServerUiPrefsSync();
    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "system", locale: "de" }), {
        scope,
        onApplied,
      }),
    ).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");

    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "system", locale: "fr" }), {
        scope,
        onApplied,
      }),
    ).toBe(true);
    expect(loadSettings()).toMatchObject({ themeMode: "dark", locale: "fr" });

    expect(
      applyServerUiPrefs(configWithPrefs({ themeMode: "light", locale: "fr" }), {
        scope,
        onApplied,
      }),
    ).toBe(true);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("settles only this tab's acknowledged keys from sibling persisted pending", async () => {
    const flight = createDeferred<unknown>();
    const request = vi.fn<Request>(() => flight.promise);
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));
    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    flight.resolve({});

    await waitForFast(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("drops only this tab's validation-rejected keys from persisted pending", async () => {
    const request = vi.fn<Request>().mockRejectedValue(rejection);
    const client = createClient(request, scope);
    flushServerUiPrefs(client);
    localStorage.setItem(pendingKey(scope), JSON.stringify({ locale: "fr" }));

    pushServerUiPrefs(client, { themeMode: "dark" });

    await waitForFast(() => expect(readPending(scope)).toEqual({ locale: "fr" }));
  });

  it("preserves a newer same-key edit across the older batch ack", async () => {
    const first = createDeferred<unknown>();
    const request = vi.fn<Request>().mockReturnValueOnce(first.promise).mockResolvedValue({});
    const client = createClient(request);

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    pushServerUiPrefs(client, { themeMode: "light" });
    first.resolve({});

    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toEqual({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "light" } } }),
      note: "control-ui prefs sync",
    });
  });

  it("retains in-memory pending intent when localStorage is unavailable", async () => {
    const storageError = new Error("storage unavailable");
    const unavailable = () => {
      throw storageError;
    };
    vi.stubGlobal("localStorage", {
      getItem: unavailable,
      removeItem: unavailable,
      setItem: unavailable,
    });
    const request = vi.fn<Request>(async () => ({}));
    const client = createClient(request, "ws://gw", false);

    pushServerUiPrefs(client, { locale: "de" });
    (client.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expectPatch(request, { locale: "de" });
  });

  it("retains a connected transient failure and retries it on flush", async () => {
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({});
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expect(readPending("ws://gw")).toEqual({ locale: "de" });

    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitForFast(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("ignores a superseded request rejection while its replacement is pending", async () => {
    const first = createDeferred<unknown>();
    const second = createDeferred<unknown>();
    const request = vi
      .fn<Request>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(second.promise);
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    first.reject(new Error("socket closed"));
    await Promise.resolve();

    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();
    second.resolve({});
    await waitForFast(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());
  });

  it("reconciles the refreshed snapshot again after clearing its pending shadow", async () => {
    const refreshedSnapshot = configWithPrefs({ themeMode: "light" });
    patchSettings({ themeMode: "dark" });
    const onApplied = vi.fn();
    const request = vi.fn<Request>(async () => {
      applyServerUiPrefs(refreshedSnapshot, { scope: "ws://gw", onApplied });
      return {};
    });
    const client = createClient(request);

    pushServerUiPrefs(
      client,
      { themeMode: "dark" },
      {
        afterCommit: ({ needsRefresh }) => {
          expect(needsRefresh).toBe(false);
          applyServerUiPrefs(refreshedSnapshot, {
            scope: "ws://gw",
            onApplied,
          });
        },
      },
    );
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await waitForFast(() => expect(localStorage.getItem(pendingKey("ws://gw"))).toBeNull());

    expect(onApplied).toHaveBeenCalledWith({ themeMode: "light" });
    expect(loadSettings().themeMode).toBe("light");
  });

  it("does not let another scope's reconcile replace an active drain's pending state", async () => {
    const flight = createDeferred<unknown>();
    const request = vi.fn<Request>(() => flight.promise);
    const client = createClient(request, "ws://a");
    localStorage.setItem(pendingKey("ws://b"), JSON.stringify({ locale: "de" }));

    pushServerUiPrefs(client, { themeMode: "dark" });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    applyServerUiPrefs(configWithPrefs({ themeMode: "light", locale: "fr" }), {
      scope: "ws://b",
      onApplied: vi.fn(),
    });
    flight.resolve({});

    await waitForFast(() => expect(localStorage.getItem(pendingKey("ws://a"))).toBeNull());
    expect(JSON.parse(localStorage.getItem(pendingKey("ws://b")) ?? "{}")).toEqual({
      locale: "de",
    });
  });

  it("cancels a conflict re-drain when flush or reset supersedes its epoch", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn<Request>()
      .mockRejectedValueOnce(conflictError())
      .mockRejectedValueOnce(conflictError())
      .mockResolvedValue({});
    const client = createClient(request);

    pushServerUiPrefs(client, { locale: "de" });
    await vi.advanceTimersByTimeAsync(250);
    flushServerUiPrefs(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);

    resetServerUiPrefsSync();
    localStorage.clear();
    const conflicting = vi.fn<Request>().mockRejectedValue(conflictError());
    pushServerUiPrefs(createClient(conflicting), { locale: "fr" });
    await vi.advanceTimersByTimeAsync(250);
    expect(conflicting).toHaveBeenCalledTimes(2);
    resetServerUiPrefsSync();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(conflicting).toHaveBeenCalledTimes(2);
  });

  it("caps conflict-triggered re-drains at five", async () => {
    vi.useFakeTimers();
    const request = vi.fn<Request>().mockRejectedValue(conflictError());

    pushServerUiPrefs(createClient(request), { locale: "de" });
    for (let round = 0; round <= 5; round += 1) {
      await vi.advanceTimersByTimeAsync(250);
      expect(request).toHaveBeenCalledTimes((round + 1) * 2);
      if (round < 5) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(request).toHaveBeenCalledTimes(12);
    expect(localStorage.getItem(pendingKey("ws://gw"))).not.toBeNull();
  });

  it("marks sidebar arrays for replacement", async () => {
    const request = vi.fn<Request>(async () => ({}));
    const sidebarEntries = ["route:usage"];

    pushServerUiPrefs(createClient(request), { sidebarEntries });
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledWith("config.patch", {
      raw: JSON.stringify({ ui: { prefs: { sidebarEntries } } }),
      replacePaths: ["ui.prefs.sidebarEntries"],
      note: "control-ui prefs sync",
    });
  });

  it("re-adopts scope when a stable writer gains or changes its gateway client", async () => {
    const request = vi.fn<Request>(async () => ({}));
    const writer = createClient(request, "", false);
    Object.assign(writer.state, { client: null });

    pushServerUiPrefs(writer, { locale: "de" });
    expect(JSON.parse(localStorage.getItem(pendingKey("")) ?? "{}")).toEqual({ locale: "de" });

    const firstClient = createClient(request, "ws://first").state.client;
    Object.assign(writer.state, { client: firstClient });
    (writer.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(writer);
    await waitForFast(() => expect(localStorage.getItem(pendingKey("ws://first"))).toBeNull());
    expect(localStorage.getItem(pendingKey(""))).toBeNull();

    localStorage.setItem(pendingKey("ws://second"), JSON.stringify({ themeMode: "dark" }));
    const secondClient = createClient(request, "ws://second").state.client;
    Object.assign(writer.state, { client: secondClient });
    flushServerUiPrefs(writer);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      raw: JSON.stringify({ ui: { prefs: { themeMode: "dark" } } }),
    });
  });
});

describe("read-only server preference lifecycle", () => {
  const applied = { scope, onApplied: vi.fn() };
  const retainedKey = `openclaw.control.serverPrefs.retained-local.v1:${scope}`;
  it("retains a pre-snapshot read-only edit until the first server baseline is recorded", () => {
    const request = vi.fn<Request>();
    patchSettings({ themeMode: "dark" });

    pushServerUiPrefs(
      createClient(request, scope, true, { ok: true }, false),
      { themeMode: "dark" },
      { afterCommit: vi.fn() },
    );

    const initial = configWithPrefs({ themeMode: "system" });
    expect(applyServerUiPrefs(initial, applied)).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");
    expect(localStorage.getItem(retainedKey)).toBeNull();

    resetServerUiPrefsSync();
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "system" }), applied)).toBe(false);
    expect(loadSettings().themeMode).toBe("dark");
    const previous = loadSettings();
    const state = resolveServerUiPrefState(initial, "themeMode", scope, previous, {
      canSync: false,
    });
    const reset = resetServerUiPref("themeMode", state, scope);
    expect(reset.themeMode).toBe("system");
    expect(changedServerUiPrefs(previous, reset)).toBeNull();

    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), applied)).toBe(true);
    expect(loadSettings().themeMode).toBe("light");
    expect(request).not.toHaveBeenCalled();
  });

  it("applies the first server delta after a post-snapshot read-only edit", () => {
    const initial = configWithPrefs({ themeMode: "system" });
    applyServerUiPrefs(initial, applied);
    patchSettings({ themeMode: "dark" });

    pushServerUiPrefs(
      createClient(vi.fn(), scope, true, { ok: true }, false),
      { themeMode: "dark" },
      {
        afterCommit: ({ retainedLocal }) => {
          expect(retainedLocal).toBe(true);
          expect(applyServerUiPrefs(initial, applied)).toBe(false);
        },
      },
    );

    expect(localStorage.getItem(retainedKey)).toBeNull();
    expect(applyServerUiPrefs(configWithPrefs({ themeMode: "light" }), applied)).toBe(true);
    expect(loadSettings().themeMode).toBe("light");
  });

  it("keeps offline intent through read-only reconnect and replays it after authorization", async () => {
    const request = vi.fn<Request>(async () => ({}));
    const writer = createClient(request, scope, false, { ok: true }, false);
    patchSettings({ themeMode: "dark" });

    pushServerUiPrefs(writer, { themeMode: "dark" });
    expect(readPending(scope)).toEqual({ themeMode: "dark" });
    expect(
      resolveServerUiPrefState(
        configWithPrefs({ themeMode: "system" }),
        "themeMode",
        scope,
        loadSettings(),
        {
          canSync: false,
        },
      ),
    ).toEqual({
      overridden: true,
      provenance: "device-local",
      resetValue: "system",
      value: "dark",
    });

    (writer.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(writer);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(readPending(scope)).toEqual({ themeMode: "dark" });

    (writer as { canPatch?: boolean }).canPatch = true;
    flushServerUiPrefs(writer);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(localStorage.getItem(pendingKey(scope))).toBeNull());
  });

  it("rechecks write capability after queued config writes settle", async () => {
    const gate = createDeferred<unknown>();
    const request = vi.fn<Request>(async () => ({}));
    const writer = createClient(request);
    const dispatch = writer.runExternalMutation;
    writer.runExternalMutation = async (task, options) => {
      await gate.promise;
      return dispatch(task, options);
    };

    pushServerUiPrefs(writer, { locale: "de" });
    Object.assign(writer, { canPatch: false });
    gate.resolve(undefined);
    await vi.waitFor(() => expect(readPending(scope)).toEqual({ locale: "de" }));

    expect(request).not.toHaveBeenCalled();
  });

  it("does not resurrect a sibling key another tab cancelled during a read-only edit", async () => {
    const request = vi.fn<Request>(async () => ({}));
    const client = createClient(request, scope, false);

    pushServerUiPrefs(client, { locale: "de", themeMode: "dark" });
    localStorage.setItem(pendingKey(scope), JSON.stringify({ themeMode: "dark" }));
    (client.state as { connected: boolean }).connected = true;
    (client as { canPatch: boolean }).canPatch = false;
    pushServerUiPrefs(client, { locale: "fr" });

    expect(readPending(scope)).toEqual({ themeMode: "dark" });
    expect(request).not.toHaveBeenCalled();

    (client as { canPatch: boolean }).canPatch = true;
    flushServerUiPrefs(client);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expectPatch(request, { themeMode: "dark" });
  });

  it("dispatches a same-key replacement persisted by another tab", async () => {
    const request = vi.fn<Request>(async () => ({}));
    const client = createClient(request, scope, false);

    pushServerUiPrefs(client, { themeMode: "dark" });
    localStorage.setItem(pendingKey(scope), JSON.stringify({ themeMode: "light" }));
    (client.state as { connected: boolean }).connected = true;
    flushServerUiPrefs(client);

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expectPatch(request, { themeMode: "light" });
  });

  it("does not migrate cancelled pre-connection intent into an adopted gateway scope", async () => {
    const request: RequestMock = vi.fn(async () => ({}));
    const writer = createClient(request, "", false);
    Object.assign(writer.state, { client: null });

    pushServerUiPrefs(writer, { themeMode: "dark" });
    localStorage.removeItem(pendingKey(""));

    Object.assign(writer.state, createClient(request, "ws://first").state);
    flushServerUiPrefs(writer);
    pushServerUiPrefs(writer, { themeMode: "dark" });

    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    expectPatch(request, { themeMode: "dark" });
  });
});
