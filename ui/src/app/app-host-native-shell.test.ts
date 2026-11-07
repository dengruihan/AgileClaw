/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../components/macos-titlebar-controls.runtime.ts";
import "../components/sidebar-update-card.ts";
import { getRenderedModalDialog, installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import "./app-host.ts";
import { resetAppHostTestGlobals, type ShellKeyboardState } from "./app-host.test-support.ts";
import { ShellChromeOwner, type ShellChromeHost } from "./app-shell-chrome.ts";
import type { ShellViewCallbacks } from "./app-shell-view-callbacks.ts";
import type { ApplicationContext } from "./context.ts";
import {
  handleNavDrawerKeydown,
  navigationSurfaceIsHidden,
  renderFloatingUpdateCard,
} from "./navigation-surface.ts";

type ShellNavigationState = {
  runtime: { context: ApplicationContext };
  handleNativeToggleSidebar: () => void;
  handleNativeNewSession: () => void;
  handleNativeNavigate: (event: Event) => void;
  updated: (changedProperties: Map<string, unknown>) => void;
};

type ShellSettingsEscapeState = ShellKeyboardState & {
  lastWorkspaceLocation: { routeId: "usage"; pathname: string; search: string; hash: string };
  navDrawerOpen: boolean;
  routeState: { routeId: "appearance" };
};

type TestWebKitWindow = Window & {
  webkit?: {
    messageHandlers: {
      openclawNav: { postMessage: (message: unknown) => void };
    };
  };
};

type MacosTitlebarControlsState = HTMLElement & {
  navCollapsed: boolean;
  historyOnly: boolean;
  newSessionDisabledReason?: string;
  onToggleSidebar?: () => void;
  onOpenNewSession?: () => void;
  updateComplete: Promise<boolean>;
};

function nativeSessionContext(
  navigate: ReturnType<typeof vi.fn>,
  selectedId: string,
  options: { methods?: string[]; scopes?: string[] } = {},
): ApplicationContext {
  return {
    navigate,
    agentSelection: { state: { selectedId } },
    gateway: {
      snapshot: {
        client: {},
        phase: "connected",
        hello: {
          auth: { role: "operator", scopes: options.scopes ?? ["operator.write"] },
          features: { methods: options.methods ?? ["sessions.create"] },
        },
      },
    },
  } as unknown as ApplicationContext;
}

afterEach(() => {
  resetAppHostTestGlobals();
});

describe("AgileClaw native shell", () => {
  it.each(["MacIntel", "Win32"])(
    "uses only the platform sidebar modifier on %s without consuming text navigation",
    (platform) => {
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const snapshot = { navCollapsed: false };
      const update = vi.fn((next: { navCollapsed: boolean }) => Object.assign(snapshot, next));
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
      shell.runtime = {
        context: { navigation: { snapshot, update } } as unknown as ApplicationContext,
      };
      const drawer = Object.assign(document.createElement("div"), { closeNavDrawer: vi.fn() });
      const editor = document.createElement("textarea");
      editor.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      try {
        for (const modifiers of [
          { metaKey: true },
          { ctrlKey: true },
          { metaKey: true, ctrlKey: true },
          { ctrlKey: true, altKey: true },
        ]) {
          update.mockClear();
          drawer.closeNavDrawer.mockClear();
          const expected =
            platform === "MacIntel"
              ? Object.keys(modifiers).length === 1 && "metaKey" in modifiers
              : Object.keys(modifiers).length === 1 && "ctrlKey" in modifiers;
          const init = { key: "b", code: "KeyB", cancelable: true, ...modifiers };
          const event = new KeyboardEvent("keydown", init);
          editor.dispatchEvent(event);
          expect(event.defaultPrevented).toBe(expected);
          expect(update).toHaveBeenCalledTimes(Number(expected));
          const drawerEvent = new KeyboardEvent("keydown", init);
          handleNavDrawerKeydown(drawer, drawerEvent);
          expect(drawerEvent.defaultPrevented).toBe(expected);
          expect(drawer.closeNavDrawer).toHaveBeenCalledTimes(Number(expected));
        }
      } finally {
        platformSpy.mockRestore();
      }
    },
  );

  it("reports readiness only while the native command listener owner is connected", () => {
    const shell = document.createElement("openclaw-app-shell") as HTMLElement & {
      connectedCallback(): void;
      disconnectedCallback(): void;
      nativeHistoryState: { canGoBack: boolean; canGoForward: boolean };
    };
    const nativeWindow = window as Window & { __OPENCLAW_NATIVE_COMMANDS_READY__?: boolean };
    const states: boolean[] = [];
    const recordState = () =>
      states.push(nativeWindow["__OPENCLAW_NATIVE_COMMANDS_READY__"] === true);
    window.addEventListener("openclaw:native-commands-state", recordState);
    try {
      shell.connectedCallback();
      window.dispatchEvent(
        new CustomEvent("openclaw:native-history-state", {
          detail: { canGoBack: true, canGoForward: false },
        }),
      );
      expect(shell.nativeHistoryState.canGoBack).toBe(true);
      expect(states).toEqual([true]);

      shell.disconnectedCallback();
      shell.nativeHistoryState = { canGoBack: false, canGoForward: false };
      window.dispatchEvent(
        new CustomEvent("openclaw:native-history-state", {
          detail: { canGoBack: true, canGoForward: false },
        }),
      );
      expect(shell.nativeHistoryState.canGoBack).toBe(false);
      expect(states).toEqual([true, false]);
    } finally {
      shell.disconnectedCallback();
      window.removeEventListener("openclaw:native-commands-state", recordState);
      Reflect.deleteProperty(nativeWindow, "__OPENCLAW_NATIVE_COMMANDS_READY__");
    }
  });

  it("opens Settings with Shift-Command-Comma", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = {
      context: {
        navigate,
      } as unknown as ApplicationContext,
    };
    const event = new KeyboardEvent("keydown", {
      key: "<",
      code: "Comma",
      metaKey: true,
      shiftKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith("appearance", undefined);
  });

  it("restores the complete prior workspace URL when Escape leaves Settings", () => {
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsEscapeState;
    shell.runtime = {
      context: {
        navigate,
        overlays: { snapshot: { devicePairSetupOpen: false } },
      } as unknown as ApplicationContext,
    };
    shell.lastWorkspaceLocation = {
      routeId: "usage",
      pathname: "/usage",
      search: "?agent=main",
      hash: "#queue",
    };
    shell.navDrawerOpen = false;
    shell.routeState = { routeId: "appearance" };

    shell.handleDocumentKeydown(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("usage", {
      pathname: "/usage",
      search: "?agent=main",
      hash: "#queue",
    });
  });

  it("keeps the raw config editor unchanged when Escape is pressed", () => {
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsEscapeState;
    shell.runtime = {
      context: {
        navigate,
        overlays: { snapshot: { devicePairSetupOpen: false } },
      } as unknown as ApplicationContext,
    };
    shell.lastWorkspaceLocation = { routeId: "usage", pathname: "/usage", search: "", hash: "" };
    shell.navDrawerOpen = false;
    shell.routeState = { routeId: "appearance" };
    const rawField = document.body.appendChild(document.createElement("label"));
    rawField.className = "config-raw-field";
    const rawEditor = rawField.appendChild(document.createElement("textarea"));
    rawEditor.value = '{ "gateway": { "port": 18789 } }';
    rawEditor.focus();
    const onInput = vi.fn();
    rawEditor.addEventListener("input", onInput);
    rawEditor.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));

    try {
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
      rawEditor.dispatchEvent(event);

      expect(rawEditor.value).toBe('{ "gateway": { "port": 18789 } }');
      expect(onInput).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      rawField.remove();
    }
  });

  it("lets a shadow-root confirmation own Escape without leaving Settings", async () => {
    const restoreDialogPolyfill = installDialogPolyfill();
    const navigate = vi.fn();
    const shell = document.createElement(
      "openclaw-app-shell",
    ) as unknown as ShellSettingsEscapeState;
    shell.runtime = {
      context: {
        navigate,
        overlays: { snapshot: { devicePairSetupOpen: false } },
      } as unknown as ApplicationContext,
    };
    shell.lastWorkspaceLocation = { routeId: "usage", pathname: "/usage", search: "", hash: "" };
    shell.navDrawerOpen = false;
    shell.routeState = { routeId: "appearance" };
    const container = document.body.appendChild(document.createElement("div"));
    const modal = container.appendChild(document.createElement("openclaw-modal-dialog"));
    const cancel = modal.appendChild(document.createElement("button"));

    try {
      const { dialog } = await getRenderedModalDialog(container);
      expect(dialog.open).toBe(true);
      expect(document.querySelector("dialog[open]")).toBeNull();
      cancel.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });

      cancel.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      container.remove();
      restoreDialogPolyfill();
    }
  });

  it("toggles the navigation sidebar when the native macOS titlebar button fires", () => {
    const snapshot = { navCollapsed: false };
    const update = vi.fn((next: { navCollapsed: boolean }) => {
      snapshot.navCollapsed = next.navCollapsed;
    });
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    shell.runtime = {
      context: {
        navigation: { snapshot, update },
      } as unknown as ApplicationContext,
    };

    shell.handleNativeToggleSidebar();
    expect(update).toHaveBeenLastCalledWith({ navCollapsed: true });

    shell.handleNativeToggleSidebar();
    expect(update).toHaveBeenLastCalledWith({ navCollapsed: false });
  });

  it.each(["operator.write", "operator.sessions.write"])(
    "starts a session from native titlebar events with %s",
    (scope) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: nativeSessionContext(navigate, "agent/a", { scopes: [scope] }),
      };
      shell.handleNativeNewSession();

      expect(navigate).toHaveBeenCalledWith("new-session", { search: "?agent=agent%2Fa" });
    },
  );

  it.each(["MacIntel", "Win32", "Linux x86_64"])(
    "opens a draft from the composer on %s without taking New Window or modified Enter",
    (platform) => {
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
      shell.runtime = {
        context: nativeSessionContext(navigate, "research", {
          scopes: ["operator.sessions.write"],
        }),
      };
      const textarea = document.createElement("textarea");
      textarea.value = "Keep this foreground draft";
      textarea.addEventListener("keydown", (event) => shell.handleDocumentKeydown(event));
      const modifier = platform === "MacIntel" ? { metaKey: true } : { ctrlKey: true };
      try {
        // Receiver semantics only; synthetic DOM events cannot prove browser delivery.
        const event = new KeyboardEvent("keydown", {
          key: "O",
          code: "KeyO",
          shiftKey: true,
          cancelable: true,
          ...modifier,
        });
        textarea.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", {
          search: "?agent=research",
        });
        expect(textarea.value).toBe("Keep this foreground draft");
        for (const init of [
          { key: "n", code: "KeyN" },
          { key: "Enter", code: "Enter" },
          { key: "O", code: "KeyO", shiftKey: true, repeat: true },
          { key: "O", code: "KeyO", shiftKey: true, isComposing: true },
          { key: "O", code: "KeyO", shiftKey: true, keyCode: 229 },
        ]) {
          const ignored = new KeyboardEvent("keydown", { ...modifier, ...init, cancelable: true });
          textarea.dispatchEvent(ignored);
          expect(ignored.defaultPrevented).toBe(false);
        }
        expect(navigate).toHaveBeenCalledOnce();
      } finally {
        platformSpy.mockRestore();
      }
    },
  );

  it.each(["modal", "read-only", "unavailable", "offline"])(
    "leaves the New Session shortcut unhandled during %s",
    (guard) => {
      const platformSpy = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState &
        ShellNavigationState;
      const context = nativeSessionContext(navigate, "main", {
        ...(guard === "read-only" ? { scopes: ["operator.read"] } : {}),
        ...(guard === "unavailable" ? { methods: [] } : {}),
      });
      shell.runtime = { context };
      if (guard === "offline") {
        context.gateway.snapshot.phase = "offline";
      }
      const modal = document.createElement("div");
      if (guard === "modal") {
        (document.openClawModalLayers ??= new Set()).add(modal);
      }
      try {
        const key = new KeyboardEvent("keydown", {
          key: "O",
          code: "KeyO",
          metaKey: true,
          shiftKey: true,
          cancelable: true,
        });
        shell.handleDocumentKeydown(key);
        expect(key.defaultPrevented).toBe(false);
        expect(navigate).not.toHaveBeenCalled();
      } finally {
        document.openClawModalLayers?.delete(modal);
        platformSpy.mockRestore();
      }
    },
  );

  it("leaves a rendered modal navigation drawer in control of the New Session chord", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = { context: nativeSessionContext(navigate, "main") };
    const drawer = document.body.appendChild(document.createElement("nav"));
    drawer.className = "shell-nav";
    drawer.setAttribute("aria-modal", "true");
    try {
      shell.handleDocumentKeydown(
        new KeyboardEvent("keydown", {
          key: "O",
          code: "KeyO",
          metaKey: true,
          shiftKey: true,
          cancelable: true,
        }),
      );
      expect(navigate).not.toHaveBeenCalled();
    } finally {
      drawer.remove();
    }
  });

  it("keeps the new-thread control in the native titlebar only while collapsed", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const shell = document.createElement("openclaw-app-shell") as HTMLElement & {
      runtime: { context: ApplicationContext };
      viewCallbacks: ShellViewCallbacks;
      navDrawerTrigger: HTMLElement | null;
      navDrawerOpen: boolean;
    };
    shell.runtime = { context: {} as ApplicationContext };
    const drawerTrigger = shell.appendChild(document.createElement("button"));
    drawerTrigger.className = "topbar-nav-toggle";
    Object.defineProperty(drawerTrigger, "checkVisibility", { value: () => true });
    const onOpenNewSession = vi.fn();
    const controls = document.createElement(
      "openclaw-macos-titlebar-controls",
    ) as unknown as MacosTitlebarControlsState;
    controls.navCollapsed = false;
    controls.historyOnly = false;
    controls.onToggleSidebar = shell.viewCallbacks.toggleSidebar;
    controls.onOpenNewSession = onOpenNewSession;
    document.body.append(controls);
    await controls.updateComplete;

    controls.querySelector<HTMLButtonElement>(".macos-titlebar-controls__sidebar-toggle")?.click();
    expect(shell.navDrawerOpen).toBe(true);
    expect(shell.navDrawerTrigger).toBe(drawerTrigger);
    expect(controls.querySelector(".macos-titlebar-controls__new-session")).toBeNull();

    controls.navCollapsed = true;
    await controls.updateComplete;
    controls.querySelector<HTMLButtonElement>(".macos-titlebar-controls__new-session")?.click();

    expect(onOpenNewSession).toHaveBeenCalledOnce();
    controls.remove();
  });

  it("disables the native titlebar new-session control with its access reason", async () => {
    const onOpenNewSession = vi.fn();
    const controls = document.createElement(
      "openclaw-macos-titlebar-controls",
    ) as unknown as MacosTitlebarControlsState;
    controls.navCollapsed = true;
    controls.newSessionDisabledReason = "Operator write access is required.";
    controls.onOpenNewSession = onOpenNewSession;
    document.body.append(controls);
    await controls.updateComplete;

    const button = controls.querySelector<HTMLButtonElement>(
      ".macos-titlebar-controls__new-session",
    );
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(onOpenNewSession).not.toHaveBeenCalled();
    controls.remove();
  });

  it("retains a native new-session request until a context exists", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;

    shell.handleNativeNewSession();

    shell.runtime = {
      context: nativeSessionContext(navigate, "main"),
    };
    shell.handleNativeNewSession();

    expect(navigate).toHaveBeenCalledExactlyOnceWith("new-session", { search: "?agent=main" });
  });

  it("does not start a native session without exact sessions.create access", () => {
    for (const options of [
      { methods: ["sessions.list"], scopes: ["operator.write"] },
      { methods: ["sessions.create"], scopes: ["operator.read"] },
      { methods: ["sessions.create"], scopes: ["operator.sessions.read"] },
    ]) {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: nativeSessionContext(navigate, "main", options),
      };

      shell.handleNativeNewSession();

      expect(navigate).not.toHaveBeenCalled();
    }
  });

  it.each([
    { path: "/settings/appearance", routeId: "appearance", basePath: "", search: undefined },
    {
      path: "/settings/appearance",
      routeId: "appearance",
      basePath: "/gateway",
      search: undefined,
    },
    { path: "/settings/channels", routeId: "channels", basePath: "", search: undefined },
    {
      path: "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef",
      routeId: "chat",
      search: "?view=chat",
      basePath: "/gateway",
    },
  ])(
    "preserves native destination $basePath$path and acknowledges it",
    ({ path, routeId, search, basePath }) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: { navigate, basePath } as unknown as ApplicationContext,
      };
      const event = new CustomEvent("openclaw:native-navigate", {
        cancelable: true,
        detail: { path, search },
      });

      shell.handleNativeNavigate(event);

      expect(event.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith(routeId, {
        pathname: `${basePath}${path}`,
        ...(search ? { search } : {}),
      });
    },
  );

  it.each(["onboarding=1", "?onboarding=1#x"])(
    "ignores malformed native search %s and keeps the plain route",
    (search) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: {
          navigate,
          basePath: "",
        } as unknown as ApplicationContext,
      };
      const event = new CustomEvent("openclaw:native-navigate", {
        cancelable: true,
        detail: { path: "/chat", search },
      });

      shell.handleNativeNavigate(event);

      expect(event.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname: "/chat" });
    },
  );

  it.each(["https://example.com", "//example.com", "/https://example.com", "/unknown"])(
    "leaves invalid native Dashboard path %s unhandled",
    (path) => {
      const navigate = vi.fn();
      const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
      shell.runtime = {
        context: {
          navigate,
        } as unknown as ApplicationContext,
      };
      const event = new CustomEvent("openclaw:native-navigate", {
        cancelable: true,
        detail: { path },
      });

      shell.handleNativeNavigate(event);

      expect(event.defaultPrevented).toBe(false);
      expect(navigate).not.toHaveBeenCalled();
    },
  );

  it("deduplicates native nav state reports", () => {
    const postMessage = vi.fn();
    (window as TestWebKitWindow).webkit = {
      messageHandlers: { openclawNav: { postMessage } },
    };
    const snapshot = { navCollapsed: false, navWidth: 280 };
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellNavigationState;
    shell.runtime = {
      context: {
        navigation: { snapshot },
      } as unknown as ApplicationContext,
    };

    shell.updated(new Map());
    shell.updated(new Map());
    snapshot.navCollapsed = true;
    shell.updated(new Map());

    expect(postMessage.mock.calls).toEqual([
      [{ type: "nav-state", collapsed: false, width: 280 }],
      [{ type: "nav-state", collapsed: true, width: 280 }],
    ]);
  });

  it("leaves plain Command-Comma to the browser", () => {
    const navigate = vi.fn();
    const shell = document.createElement("openclaw-app-shell") as unknown as ShellKeyboardState;
    shell.runtime = {
      context: {
        navigate,
      } as unknown as ApplicationContext,
    };
    const event = new KeyboardEvent("keydown", {
      key: ",",
      code: "Comma",
      metaKey: true,
      cancelable: true,
    });

    shell.handleDocumentKeydown(event);

    expect(event.defaultPrevented).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("AgileClaw shell update affordance", () => {
  it("floats only the stale-client refresh card, never a floating Inbox", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    try {
      const collapsed = navigationSurfaceIsHidden({
        navCollapsed: true,
        navDrawerOpen: false,
        mobileNavLayout: false,
      });
      expect(collapsed).toBe(true);

      render(renderFloatingUpdateCard({ refreshRequired: false, onRefresh: vi.fn() }), container);
      expect(container.querySelector("openclaw-sidebar-attention")).toBeNull();
      expect(container.querySelector("openclaw-sidebar-update-card")).toBeNull();

      render(renderFloatingUpdateCard({ refreshRequired: true, onRefresh: vi.fn() }), container);
      const refreshCard = container.querySelector<
        HTMLElement & { onRefresh: () => void; refreshRequired: boolean }
      >("openclaw-sidebar-update-card");
      expect(refreshCard?.refreshRequired).toBe(true);
      refreshCard?.onRefresh();
    } finally {
      container.remove();
    }
  });

  it("preserves the stale-client refresh card in the closed mobile drawer", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    try {
      const navigationSurfaceHidden = navigationSurfaceIsHidden({
        navCollapsed: false,
        navDrawerOpen: false,
        mobileNavLayout: true,
      });
      expect(navigationSurfaceHidden).toBe(true);

      render(renderFloatingUpdateCard({ refreshRequired: true, onRefresh: vi.fn() }), container);
      const refreshCard = container.querySelector<
        HTMLElement & { updateComplete: Promise<boolean> }
      >("openclaw-sidebar-update-card");
      await refreshCard?.updateComplete;
      expect(refreshCard?.querySelector(".sidebar-update-card")).not.toBeNull();
      expect(container.querySelector("openclaw-sidebar-attention")).toBeNull();
    } finally {
      container.remove();
    }
  });
});

type NotificationShellOptions = {
  basePath?: string;
  gatewayUrl?: string;
};

function notificationShellChrome(
  navigate: ReturnType<typeof vi.fn>,
  options: NotificationShellOptions = {},
): ShellChromeOwner {
  const context = {
    basePath: options.basePath ?? "",
    navigate,
    gateway: {
      connection: { gatewayUrl: options.gatewayUrl ?? "wss://gateway.example" },
    },
  } as unknown as ApplicationContext;
  return new ShellChromeOwner({ context, navigate } as unknown as ShellChromeHost);
}

function installMessageChannelServiceWorker() {
  const controller = { state: "activated" };
  const addEventListener = vi.fn();
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { addEventListener, controller, removeEventListener: vi.fn() },
  });
  return { addEventListener, controller };
}

function dispatchServiceWorkerNavigation(
  owner: ShellChromeOwner,
  url: unknown,
  source: unknown,
  type: unknown = "openclaw-notification-navigate",
) {
  const replyPort = { postMessage: vi.fn() };
  owner.handleServiceWorkerMessage({
    data: { type, url },
    ports: [replyPort],
    source,
  } as unknown as MessageEvent);
  return replyPort;
}

describe("AgileClaw notification navigation handshake", () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, "serviceWorker");
  });

  it("routes a notification target through the app router and acknowledges it", () => {
    const { controller } = installMessageChannelServiceWorker();
    const navigate = vi.fn();
    const owner = notificationShellChrome(navigate);
    const pathname = "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef";

    const reply = dispatchServiceWorkerNavigation(
      owner,
      `${window.location.origin}${pathname}?view=chat#latest`,
      controller,
    );

    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", {
      pathname,
      search: "?view=chat",
      hash: "#latest",
    });
    expect(reply.postMessage).toHaveBeenCalledExactlyOnceWith({ handled: true });
  });

  it("keeps the mount base path and known SPA routes in app", () => {
    const { controller } = installMessageChannelServiceWorker();
    const navigate = vi.fn();
    const owner = notificationShellChrome(navigate, { basePath: "/openclaw" });

    const reply = dispatchServiceWorkerNavigation(
      owner,
      `${window.location.origin}/openclaw/settings/appearance?tab=theme`,
      controller,
    );

    expect(navigate).toHaveBeenCalledExactlyOnceWith("appearance", {
      pathname: "/openclaw/settings/appearance",
      search: "?tab=theme",
    });
    expect(reply.postMessage).toHaveBeenCalledExactlyOnceWith({ handled: true });
  });

  it("drops a matching Gateway handoff fragment before routing in app", () => {
    const { controller } = installMessageChannelServiceWorker();
    const navigate = vi.fn();
    const owner = notificationShellChrome(navigate, { gatewayUrl: "wss://gateway.example" });
    const pathname = "/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef";

    const reply = dispatchServiceWorkerNavigation(
      owner,
      `${window.location.origin}${pathname}#gatewayUrl=wss%3A%2F%2Fgateway.example`,
      controller,
    );

    expect(navigate).toHaveBeenCalledExactlyOnceWith("chat", { pathname });
    expect(reply.postMessage).toHaveBeenCalledExactlyOnceWith({ handled: true });
  });

  it.each([
    {
      name: "a different Gateway",
      url: (origin: string) =>
        `${origin}/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef#gatewayUrl=wss%3A%2F%2Fother.example`,
      options: {},
    },
    {
      name: "an approval document route",
      url: (origin: string) => `${origin}/approve/exec%3A1`,
      options: {},
    },
    {
      name: "a question document route",
      url: (origin: string) => `${origin}/ask/question-1`,
      options: {},
    },
    {
      name: "a nested approval document route",
      url: (origin: string) =>
        `${origin}/openclaw/approve/exec%3A1#gatewayUrl=wss%3A%2F%2Fgateway.example`,
      options: { basePath: "/openclaw" },
    },
    {
      name: "another origin",
      url: () => "https://other.example/chat/main/dashboard/12345678-90ab-cdef-1234-567890abcdef",
      options: {},
    },
    {
      name: "a sibling mount",
      url: (origin: string) => `${origin}/openclaw-other/chat`,
      options: { basePath: "/openclaw" },
    },
    {
      name: "an unknown app route",
      url: (origin: string) => `${origin}/not-a-route`,
      options: {},
    },
    {
      name: "a protocol-relative target",
      url: () => "//other.example/chat",
      options: {},
    },
    {
      name: "a malformed target",
      url: () => "https://[invalid",
      options: {},
    },
  ])("leaves $name to the service worker's document navigation", ({ url, options }) => {
    const { controller } = installMessageChannelServiceWorker();
    const navigate = vi.fn();
    const owner = notificationShellChrome(navigate, options);

    const reply = dispatchServiceWorkerNavigation(owner, url(window.location.origin), controller);

    expect(navigate).not.toHaveBeenCalled();
    expect(reply.postMessage).toHaveBeenCalledExactlyOnceWith({ handled: false });
  });

  it("leaves invalid handshake payloads unhandled", () => {
    const { controller } = installMessageChannelServiceWorker();
    const navigate = vi.fn();
    const owner = notificationShellChrome(navigate);

    const wrongType = dispatchServiceWorkerNavigation(
      owner,
      `${window.location.origin}/chat`,
      controller,
      "openclaw-other",
    );
    const wrongUrl = dispatchServiceWorkerNavigation(owner, 42, controller);

    expect(navigate).not.toHaveBeenCalled();
    expect(wrongType.postMessage).toHaveBeenCalledExactlyOnceWith({ handled: false });
    expect(wrongUrl.postMessage).toHaveBeenCalledExactlyOnceWith({ handled: false });
  });

  it.each([
    { name: "a window message", source: null },
    { name: "another service worker", source: { state: "activated" } },
  ])("ignores $name instead of acknowledging the handshake", ({ source }) => {
    installMessageChannelServiceWorker();
    const navigate = vi.fn();
    const owner = notificationShellChrome(navigate);

    const reply = dispatchServiceWorkerNavigation(owner, `${window.location.origin}/chat`, source);

    expect(navigate).not.toHaveBeenCalled();
    // No answer keeps the worker on its document-level fallback.
    expect(reply.postMessage).not.toHaveBeenCalled();
  });

  it("owns the message listener for exactly one shell connection", () => {
    const { addEventListener } = installMessageChannelServiceWorker();
    const host = Object.assign(document.createElement("div"), {
      context: {} as ApplicationContext,
      nativeHistoryState: { canGoBack: false, canGoForward: false },
    }) as unknown as ShellChromeHost;
    const owner = new ShellChromeOwner(host);

    owner.connect();
    const registration = addEventListener.mock.calls.find(([type]) => type === "message");
    if (!registration) {
      throw new Error("Shell did not register a service-worker message listener");
    }
    expect(registration[1]).toBe(owner.handleServiceWorkerMessage);
    const signal = (registration[2] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(false);

    owner.disconnect();
    expect(signal.aborted).toBe(true);
  });
});
