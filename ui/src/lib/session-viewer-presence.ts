import { DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS } from "@openclaw/gateway-client/browser";
import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";
import { createGatewaySetSyncLifecycle } from "./gateway-set-sync-lifecycle.ts";
import { resolveSessionKey } from "./sessions/index.ts";

const SESSION_VIEWERS_SET_METHOD = "sessions.viewers.set";

type SessionViewerPresenceStore = {
  watch: (owner: object, sessionKeys: readonly string[]) => void;
  unwatch: (owner: object) => void;
};

const stores = new WeakMap<ApplicationGateway, SessionViewerPresenceStore>();

function createStore(gateway: ApplicationGateway): SessionViewerPresenceStore {
  const watchedByOwner = new Map<object, Set<string>>();
  let knownClient = gateway.snapshot.client;
  let lastHello: object | null = null;
  let lastSignature: string | null = null;
  let acknowledgedSignature: string | null = null;
  let acknowledgedGeneration = 0;
  let requestGeneration = 0;
  let requestController: AbortController | null = null;
  const readDocumentFocus = () => {
    if (typeof document === "undefined" || typeof document.hasFocus !== "function") {
      // Unknown focus must not suppress completion pushes; a later focus event
      // can still establish the foreground state.
      return false;
    }
    try {
      return document.hasFocus();
    } catch {
      return false;
    }
  };
  // Event order can make hasFocus lag a blur; the window's own focus state wins
  // until a visibility or focus change re-reads the document.
  let windowFocused = readDocumentFocus();

  const retireRequest = () => {
    requestController?.abort();
    requestController = null;
  };

  const isActive = () => watchedByOwner.size > 0;

  const clearReceipt = () => {
    lastHello = null;
    lastSignature = null;
    acknowledgedSignature = null;
    acknowledgedGeneration = 0;
  };

  const visibleSessionKeys = (): string[] => {
    const hello = gateway.snapshot.hello;
    const keys = new Set<string>();
    for (const watched of watchedByOwner.values()) {
      for (const rawKey of watched) {
        const key = resolveSessionKey(rawKey, hello).trim();
        if (key) {
          keys.add(key);
        }
      }
    }
    return [...keys].toSorted().slice(0, SESSION_VIEWER_PRESENCE_MAX_KEYS);
  };

  const handleWindowFocus = () => {
    windowFocused = true;
    sync();
  };
  const handleWindowBlur = () => {
    windowFocused = false;
    sync();
  };
  const handleVisibilityChange = () => {
    if (typeof document === "undefined" || document.visibilityState !== "hidden") {
      windowFocused = readDocumentFocus();
    }
    sync();
  };
  const lifecycle = createGatewaySetSyncLifecycle(gateway, {
    sync,
    onAttach: () => {
      knownClient = gateway.snapshot.client;
      clearReceipt();
      windowFocused = readDocumentFocus();
      if (typeof window !== "undefined") {
        window.addEventListener("focus", handleWindowFocus);
        window.addEventListener("blur", handleWindowBlur);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", handleVisibilityChange);
      }
    },
    onDetach: () => {
      requestGeneration += 1;
      retireRequest();
      clearReceipt();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleWindowFocus);
        window.removeEventListener("blur", handleWindowBlur);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibilityChange);
      }
    },
  });
  const { retry } = lifecycle;

  function sync() {
    const snapshot = gateway.snapshot;
    const client = snapshot.client;
    if (client !== knownClient) {
      retry.reset();
      knownClient = client;
      clearReceipt();
    }
    const available =
      snapshot.phase === "connected" &&
      client !== null &&
      snapshot.hello !== null &&
      isGatewayMethodAdvertised(snapshot, SESSION_VIEWERS_SET_METHOD) === true;
    if (!available) {
      clearReceipt();
      retireRequest();
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    const visible = typeof document === "undefined" || document.visibilityState !== "hidden";
    const sessionKeys = visible ? visibleSessionKeys() : [];
    // Focus is this connection's private delivery context; hidden or unknown focus never
    // claims the foreground so a missing signal cannot suppress another client's push.
    const focused = visible && sessionKeys.length > 0 && windowFocused;
    const agentId = sessionKeys.some((key) => !key.startsWith("agent:"))
      ? snapshot.assistantAgentId
      : undefined;
    const signature = JSON.stringify({ agentId, sessionKeys, focused });
    if (snapshot.hello === lastHello && signature === lastSignature) {
      if (
        !isActive() &&
        acknowledgedSignature === signature &&
        acknowledgedGeneration === requestGeneration
      ) {
        lifecycle.detach();
      }
      return;
    }
    lastHello = snapshot.hello;
    lastSignature = signature;
    const currentGeneration = ++requestGeneration;
    // Same-set churn keeps its attempt; only supersession retires the old waiter.
    retireRequest();
    requestController = new AbortController();
    const isCurrentRequest = () =>
      lifecycle.attached &&
      currentGeneration === requestGeneration &&
      snapshot.hello === lastHello &&
      signature === lastSignature;
    retry.cancel();
    const request = client.request(
      SESSION_VIEWERS_SET_METHOD,
      { ...(agentId ? { agentId } : {}), sessionKeys, focused },
      { timeoutMs: DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS, signal: requestController.signal },
    );
    void request
      .then(() => {
        if (isCurrentRequest()) {
          acknowledgedSignature = signature;
          acknowledgedGeneration = currentGeneration;
          retry.reset();
          if (!isActive()) {
            lifecycle.detach();
          }
        }
      })
      .catch(() => {
        if (!isCurrentRequest()) {
          return;
        }
        lastSignature = null;
        retry.schedule(lifecycle.schedule);
      });
  }

  const watch = (owner: object, sessionKeys: readonly string[]) => {
    const next = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    const current = watchedByOwner.get(owner);
    const unchanged =
      current === undefined
        ? next.size === 0
        : current.size === next.size && [...next].every((key) => current.has(key));
    if (unchanged) {
      return;
    }
    if (next.size === 0) {
      watchedByOwner.delete(owner);
    } else {
      watchedByOwner.set(owner, next);
    }
    retry.reset();
    if (isActive()) {
      lifecycle.attach();
      lifecycle.schedule();
    } else if (lifecycle.attached) {
      lifecycle.sync();
    }
  };

  return { watch, unwatch: (owner) => watch(owner, []) };
}

export function sessionViewerPresenceForGateway(
  gateway: ApplicationGateway,
): SessionViewerPresenceStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const store = createStore(gateway);
  stores.set(gateway, store);
  return store;
}
