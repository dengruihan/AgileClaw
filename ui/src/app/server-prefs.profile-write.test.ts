/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../api/gateway.ts";
import { createStorageMock } from "../test-helpers/storage.ts";
import { waitForFast } from "../test-helpers/wait-for.ts";
import { configWithPrefs, createServerPrefsWriter } from "./server-prefs.test-support.ts";
import {
  pushServerUiPrefs,
  refreshProfileAppearancePrefs,
  resetServerUiPrefsSync,
  resolveServerUiPrefState,
} from "./server-prefs.ts";
import { loadSettings, patchSettings } from "./settings.ts";

const profileId = "profile-appearance-writer";
const scope = "ws://appearance-batch";

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorageMock());
  resetServerUiPrefsSync();
  patchSettings({ gatewayUrl: scope });
});
afterEach(() => {
  resetServerUiPrefsSync();
  vi.unstubAllGlobals();
});

it.each([false, true])(
  "keeps mixed profile appearance edits in one mutation (rejected=%s)",
  async (rejected) => {
    const entries = {
      "ui.themeMode": "dark",
      "ui.fontUi": "geist",
    };
    const request = vi.fn(async (method: string) => {
      if (method === "users.prefs.get") {
        return { status: "ok", entries };
      }
      if (rejected) {
        throw new GatewayRequestError({
          code: "INVALID_REQUEST",
          message: "Preference is no longer available.",
        });
      }
      return { status: "ok" };
    });
    const writer = createServerPrefsWriter(request, scope, true, { ok: true }, false);
    const config = configWithPrefs({ themeMode: "light", fontUi: "lora" });
    const profileRead = {
      client: writer.state.client!,
      profileId,
      configObject: config,
      scope,
      onApplied: vi.fn(),
    };
    await refreshProfileAppearancePrefs(profileRead);
    request.mockClear();

    const local = {
      themeMode: "dark",
      fontUi: undefined,
      fontChat: "lora",
    } as const;
    patchSettings(local);
    const afterCommit = vi.fn();
    pushServerUiPrefs(
      writer,
      { ...local, fontUi: null },
      { profileId, canWrite: true, afterCommit },
    );
    await waitForFast(() => expect(afterCommit).toHaveBeenCalledOnce());

    expect(request).toHaveBeenCalledExactlyOnceWith("users.prefs.set", {
      entries: { "ui.themeMode": "dark", "ui.fontUi": null, "ui.fontChat": "lora" },
    });
    expect(afterCommit).toHaveBeenCalledWith(
      rejected ? { needsRefresh: false, retainedLocal: true } : { needsRefresh: false },
    );
    expect(loadSettings()).toMatchObject(local);
    if (rejected) {
      await refreshProfileAppearancePrefs(profileRead);
      expect(loadSettings()).toMatchObject(local);
    }
    expect(
      resolveServerUiPrefState(config, "themeMode", scope, loadSettings(), { profileId }),
    ).toMatchObject({ value: local.themeMode });
  },
);
