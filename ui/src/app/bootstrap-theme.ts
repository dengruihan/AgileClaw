import { registerListener } from "../../../src/shared/listeners.js";
import type { ApplicationGateway, ApplicationTheme } from "./context.ts";
import { syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import {
  bindUiPreferences,
  loadUiPreferences,
  patchSettings,
  settingsKeyForGateway,
  type UiPreferences,
  type UiSettings,
} from "./settings.ts";
import { currentThemeBranding } from "./theme-branding.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
import {
  applyChatFontSmoothing,
  applyTypefaceOverrides,
  resolveTypefaces,
  syncTypefaceStylesheets,
} from "./typography.ts";

function subscribeMediaQuery(query: string, onChange: () => void): (() => void) | undefined {
  if (typeof globalThis.matchMedia !== "function") {
    return undefined;
  }
  const mediaQuery = globalThis.matchMedia(query);
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    return () => mediaQuery.removeEventListener("change", onChange);
  }
  if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(onChange);
    return () => mediaQuery.removeListener(onChange);
  }
  return undefined;
}

function applyThemePresentation(settings: UiPreferences): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(settings.theme, settings.themeMode);
  root.dataset.themeId = settings.theme;
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark";
  const branding = currentThemeBranding();
  root.dataset.themeMascot = branding.mascot;
  // Plugin semantic styles select on [data-theme-resolved]; keep it in lockstep
  // with data-theme-mode before their lazy stylesheet loads.
  root.dataset.themeResolved = root.dataset.themeMode;
  root.classList.toggle("wa-light", root.dataset.themeMode === "light");
  root.classList.toggle("wa-dark", root.dataset.themeMode === "dark");
  root.style.colorScheme = root.dataset.themeMode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
  const typefaces = resolveTypefaces(settings.fontUi, settings.fontChat);
  syncTypefaceStylesheets(typefaces);
  applyTypefaceOverrides(settings.fontUi, settings.fontChat);
  applyChatFontSmoothing(typefaces.chat);
  syncControlUiSystemChrome();
}

function livePreferencesKey(settings: UiPreferences): string {
  // Persisted navigation bindings are boot/resume state. Live selection is
  // published by the Gateway and agent-selection owners, not theme subscribers.
  const {
    sessionKey: _sessionKey,
    lastActiveSessionKey: _lastActiveSessionKey,
    selectedAgentId: _selectedAgentId,
    ...preferences
  } = settings;
  return JSON.stringify(preferences);
}

export function createApplicationTheme(
  initialSettings: UiSettings,
  gateway: ApplicationGateway,
): ApplicationTheme & { dispose: () => void } {
  const { token: _token, ...initialPreferences } = initialSettings;
  let settings: UiPreferences = initialPreferences;
  let systemThemeCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const publish = () => {
    applyThemePresentation(settings);
    for (const listener of listeners) {
      listener();
    }
  };

  const detachSystemThemeListener = () => {
    systemThemeCleanup?.();
    systemThemeCleanup = undefined;
  };

  const syncSystemThemeListener = () => {
    detachSystemThemeListener();
    if (settings.themeMode !== "system") {
      return;
    }
    systemThemeCleanup = subscribeMediaQuery("(prefers-color-scheme: light)", () => {
      if (settings.themeMode === "system") {
        publish();
      }
    });
  };

  const chromeBreakpointCleanup = subscribeMediaQuery(
    "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    () => syncControlUiSystemChrome(),
  );

  const refresh = () => {
    const next = loadUiPreferences(gateway.connection.gatewayUrl);
    const changed = livePreferencesKey(next) !== livePreferencesKey(settings);
    settings = next;
    if (!changed) {
      return;
    }
    publish();
    syncSystemThemeListener();
  };
  const stopPreferences = bindUiPreferences({
    gatewayUrl: () => gateway.connection.gatewayUrl,
    refresh,
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === settingsKeyForGateway(gateway.connection.gatewayUrl)) {
      refresh();
    }
  };
  globalThis.addEventListener?.("storage", onStorage);
  const stopGateway = gateway.subscribe(() => {
    if (settings.gatewayUrl !== gateway.connection.gatewayUrl) {
      refresh();
    }
  });
  syncSystemThemeListener();
  publish();

  return {
    get branding() {
      return currentThemeBranding();
    },
    get settings() {
      return settings;
    },
    get mode() {
      return settings.themeMode;
    },
    get resolvedMode() {
      return resolveTheme(settings.theme, settings.themeMode).endsWith("light") ? "light" : "dark";
    },
    setMode(mode: ThemeMode) {
      const currentTheme = resolveTheme(settings.theme, settings.themeMode);
      const nextTheme = resolveTheme(settings.theme, mode);
      startThemeTransition({
        nextTheme,
        currentTheme,
        applyTheme: () => {
          patchSettings({ themeMode: mode });
        },
      });
    },
    refresh,
    subscribe: (listener) => registerListener(listeners, listener),
    dispose() {
      stopPreferences();
      globalThis.removeEventListener?.("storage", onStorage);
      stopGateway();
      detachSystemThemeListener();
      chromeBreakpointCleanup?.();
      listeners.clear();
    },
  };
}
