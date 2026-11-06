/* @vitest-environment jsdom */

import type { BoardGetParams, BoardSnapshot } from "@openclaw/gateway-protocol";
import type { LitElement } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_SESSION_ROSTER_LIMIT } from "../../../../src/shared/session-list-limits.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  DASHBOARD_DOCUMENT_ELEMENT,
  ensureCustomElementDefined,
} from "../../app/lazy-custom-element.ts";
import { i18n } from "../../i18n/index.ts";
import type { SessionListOptions, SessionListSnapshot } from "../../lib/sessions/index.ts";
import {
  createApplicationContextProvider,
  createApplicationGateway,
} from "../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { settleLitElement } from "../../test-helpers/lit-settle.ts";
import type { DashboardsRouteData } from "./view.ts";
import "./dashboards-page.ts";

type DashboardsPageElement = HTMLElement & {
  routeData?: DashboardsRouteData;
  updateComplete: Promise<boolean>;
};

function result(sessionRow: GatewaySessionRow): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [sessionRow],
  };
}

function results(sessionRows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "(multiple)",
    count: sessionRows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: sessionRows,
  };
}

function row(key: string, displayName: string): GatewaySessionRow {
  return {
    key,
    kind: "direct",
    boardFace: "dashboard",
    displayName,
    updatedAt: 1,
  };
}

function routeData(sessionRow: GatewaySessionRow): DashboardsRouteData {
  return {
    result: result(sessionRow),
    error: null,
    basePath: "",
    fallbackAgentId: "main",
    mainKey: "main",
    globalScope: false,
  };
}

function createDashboardClient() {
  return createTestGatewayClient(async (method, params) => {
    if (method === "environments.list") {
      return { environments: [] };
    }
    if (method === "node.list") {
      return { nodes: [] };
    }
    if (method === "system.info") {
      return {
        machineName: "Gateway host",
        hostname: "gateway-host",
        platform: "linux",
        release: "test",
        arch: "x64",
        osLabel: "Linux",
        nodeVersion: "v26",
        pid: 1,
        uptimeMs: 1_000,
        cpuCount: 4,
        memoryTotalBytes: 8_192,
        memoryFreeBytes: 4_096,
        loadAverage: [0.5, 0.4, 0.3],
      };
    }
    if (method !== "board.get") {
      throw new Error(`Unexpected Gateway method: ${method}`);
    }
    const { sessionKey } = params as BoardGetParams;
    return { sessionKey, revision: 1, tabs: [], widgets: [] } satisfies BoardSnapshot;
  });
}

function controlPreviewFrames(): () => void {
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  return () => {
    const pendingFrameIds = [...frames.keys()];
    for (const id of pendingFrameIds) {
      const callback = frames.get(id);
      frames.delete(id);
      callback?.(0);
    }
  };
}

async function settleDashboardPreviews(element: DashboardsPageElement, runFrame: () => void) {
  await settleLitElement(element);
  runFrame();
  const previews = element.querySelectorAll<LitElement>("openclaw-dashboard-preview");
  expect(previews.length).toBeGreaterThan(0);
  for (const preview of previews) {
    await settleLitElement(preview);
    const board = preview.querySelector<LitElement>("openclaw-board-document")!;
    expect(board).not.toBeNull();
    await settleLitElement(board);
    const view = board.querySelector<LitElement>("openclaw-board-view")!;
    expect(view, board.textContent ?? "").not.toBeNull();
    await settleLitElement(view);
    expect(view.querySelector('[data-test-id="board-empty"]')).not.toBeNull();
  }
}

describe("DashboardsPage", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
    await ensureCustomElementDefined(
      DASHBOARD_DOCUMENT_ELEMENT.tagName,
      DASHBOARD_DOCUMENT_ELEMENT.loadModule,
    );
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("subscribes to the exact query and preserves rows while a new agent scope loads", async () => {
    const runFrame = controlPreviewFrames();
    const selectionListeners = new Set<() => void>();
    const listListeners = new Map<string, (snapshot: SessionListSnapshot) => void>();
    const snapshots = new Map<string, SessionListSnapshot>();
    const queryKey = (options: SessionListOptions) => options.agentId ?? "all";
    const allResult = result(row("agent:main:before", "Before"));
    snapshots.set("all", { result: allResult, agentId: null, loading: false, error: null });
    snapshots.set("writer", { result: null, agentId: null, loading: false, error: null });
    const refreshList = vi.fn(async () => undefined);
    const subscribeList = vi.fn(
      (query: SessionListOptions, listener: (snapshot: SessionListSnapshot) => void) => {
        const key = queryKey(query);
        listListeners.set(key, listener);
        return () => listListeners.delete(key);
      },
    );
    const selectionState = { selectedId: "main", scopeId: null as string | null };
    const context = {
      basePath: "",
      gateway: {
        snapshot: { client: createDashboardClient(), phase: "connected", hello: null },
        subscribe: () => () => undefined,
        subscribeEvents: () => () => undefined,
      },
      sessions: {
        state: { result: null },
        listSnapshot(query: SessionListOptions) {
          return snapshots.get(queryKey(query))!;
        },
        subscribeList,
        subscribe: () => () => undefined,
        refreshList,
      },
      agentSelection: {
        state: selectionState,
        subscribe(listener: () => void) {
          selectionListeners.add(listener);
          return () => selectionListeners.delete(listener);
        },
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = routeData(row("agent:main:before", "Before"));
    const provider = createApplicationContextProvider(context);
    provider.append(element);
    document.body.append(provider);
    await element.updateComplete;

    expect(subscribeList).toHaveBeenCalledWith(
      {
        limit: SIDEBAR_SESSION_ROSTER_LIMIT,
        rowMode: "compact",
        hasBoard: true,
        archivedFilter: "all",
      },
      expect.any(Function),
    );
    expect(refreshList).not.toHaveBeenCalled();
    const retiredListener = listListeners.get("all")!;

    selectionState.scopeId = "writer";
    selectionListeners.forEach((listener) => listener());
    await vi.waitFor(() => expect(refreshList).toHaveBeenCalledTimes(1));
    expect(refreshList).toHaveBeenCalledWith({
      limit: SIDEBAR_SESSION_ROSTER_LIMIT,
      rowMode: "compact",
      hasBoard: true,
      archivedFilter: "all",
      agentId: "writer",
      force: true,
    });
    expect(element.textContent).toContain("Before");

    listListeners.get("writer")?.({
      result: result(row("agent:writer:current", "Writer dashboard")),
      agentId: "writer",
      loading: false,
      error: null,
    });
    await vi.waitFor(() => expect(element.textContent).toContain("Writer dashboard"));
    await settleDashboardPreviews(element, runFrame);
    retiredListener({
      result: result(row("agent:main:retired", "Retired")),
      agentId: null,
      loading: false,
      error: "Retired scope refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Retired");

    const writerListener = listListeners.get("writer")!;
    writerListener({
      result: result(row("agent:writer:current", "Writer dashboard")),
      agentId: "writer",
      loading: false,
      error: "Writer refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).toContain("Writer dashboard");
    expect(element.querySelector('[role="alert"]')?.textContent).toContain("Writer refresh failed");
    expect(element.querySelector('[role="alert"] button')).toBeNull();
    writerListener({
      result: result(row("agent:writer:current", "Recovered dashboard")),
      agentId: "writer",
      loading: false,
      error: null,
    });
    await element.updateComplete;
    await settleDashboardPreviews(element, runFrame);
    expect(element.textContent).toContain("Recovered dashboard");
    expect(element.querySelector('[role="alert"]')).toBeNull();

    element.remove();
    writerListener({
      result: null,
      agentId: "writer",
      loading: false,
      error: "Detached refresh failed",
    });
    await element.updateComplete;
    expect(element.textContent).not.toContain("Detached refresh failed");
  });

  it.each([false, true])(
    "loads every dashboard page unless its connection is retired (retired: %s)",
    async (retired) => {
      const runFrame = controlPreviewFrames();
      const first = {
        ...results([row("agent:main:new", "New dashboard")]),
        totalCount: 2,
        hasMore: true,
        nextOffset: 1,
        offset: 0,
      };
      const second = {
        ...results([row("agent:main:old", "Old dashboard")]),
        totalCount: 2,
        hasMore: false,
        nextOffset: null,
        offset: 1,
      };
      const snapshot = { result: first, agentId: null, loading: false, error: null };
      let resolvePage!: (value: SessionsListResult | null) => void;
      const pendingPage = new Promise<SessionsListResult | null>((resolve) => {
        resolvePage = resolve;
      });
      const list = vi.fn(async () => (retired ? pendingPage : second));
      const gatewayListeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
      const publishGateway = () => {
        for (const listener of gatewayListeners) {
          listener(context.gateway.snapshot);
        }
      };
      const context = {
        basePath: "",
        gateway: {
          snapshot: { client: createDashboardClient(), phase: "connected", hello: null },
          subscribe: (listener: (snapshot: ApplicationGatewaySnapshot) => void) => {
            gatewayListeners.add(listener);
            return () => gatewayListeners.delete(listener);
          },
          subscribeEvents: () => () => undefined,
        },
        sessions: {
          state: { result: null },
          list,
          listSnapshot: () => snapshot,
          subscribeList: () => () => undefined,
          subscribe: () => () => undefined,
          refreshList: vi.fn(async () => undefined),
        },
        agentSelection: {
          state: { selectedId: "main", scopeId: null },
          subscribe: () => () => undefined,
        },
        agents: { state: { agentsList: null } },
      } as unknown as ApplicationContext;
      const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
      element.routeData = {
        result: first,
        error: null,
        basePath: "",
        fallbackAgentId: "main",
        mainKey: "main",
        globalScope: false,
      };
      const provider = createApplicationContextProvider(context);
      provider.append(element);
      document.body.append(provider);

      if (retired) {
        await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
        for (const phase of ["reconnecting", "connected"] as const) {
          Object.assign(context.gateway.snapshot, { phase });
          publishGateway();
        }
        resolvePage(null);
        await settleLitElement(element);
        await settleDashboardPreviews(element, runFrame);
        expect(element.textContent).toContain("New dashboard");
        expect(element.textContent).not.toContain("dashboard enumeration returned no result");
        expect(element.querySelector('[role="alert"]')).toBeNull();
        return;
      }

      await vi.waitFor(() =>
        expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(2),
      );
      await settleDashboardPreviews(element, runFrame);
      expect(list).toHaveBeenCalledWith({
        limit: SIDEBAR_SESSION_ROSTER_LIMIT,
        rowMode: "compact",
        hasBoard: true,
        archivedFilter: "all",
        offset: 1,
      });

      const search = element.querySelector<HTMLInputElement>('input[type="search"]')!;
      search.value = "old";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await element.updateComplete;
      expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
      expect(element.textContent).toContain("Old dashboard");
    },
  );

  it("filters by search and author and sorts visible cards by title", async () => {
    const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
    element.routeData = {
      result: results([
        {
          ...row("agent:main:dashboard:zulu", "Zulu monitor"),
          updatedAt: 30,
          createdActor: { type: "human", id: "peter", label: "Peter" },
        },
        {
          ...row("agent:main:dashboard:alpha", "Alpha signals"),
          updatedAt: 10,
          createdActor: { type: "human", id: "mira", label: "Mira" },
        },
        {
          ...row("agent:main:dashboard:bravo", "Bravo health"),
          updatedAt: 20,
          createdActor: { type: "human", id: "peter", label: "Peter" },
        },
      ]),
      error: null,
      basePath: "",
      fallbackAgentId: "main",
      mainKey: "main",
      globalScope: false,
    };
    document.body.append(element);
    await element.updateComplete;

    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(3);
    expect(element.querySelector(".dashboard-preview")?.hasAttribute("inert")).toBe(true);

    const search = element.querySelector<HTMLInputElement>('input[type="search"]');
    expect(search).not.toBeNull();
    if (!search) {
      return;
    }
    search.value = "signals";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("Alpha signals");

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await element.updateComplete;
    const selects = element.querySelectorAll<HTMLSelectElement>("select");
    const authorSelect = selects.item(0);
    const sortSelect = selects.item(1);
    authorSelect.value = "mira";
    authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(element.querySelectorAll("[data-dashboard-session]")).toHaveLength(1);
    expect(element.textContent).toContain("By Mira");

    authorSelect.value = "";
    authorSelect.dispatchEvent(new Event("change", { bubbles: true }));
    sortSelect.value = "title";
    sortSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await element.updateComplete;
    expect(
      Array.from(element.querySelectorAll(".dashboard-card__heading h2"), (heading) =>
        heading.textContent?.trim(),
      ),
    ).toEqual(["Alpha signals", "Bravo health", "Zulu monitor"]);
  });
  it("renders machine monitoring from the dashboards owner with one poll per interval", async () => {
    vi.useFakeTimers();
    try {
      const requests = new Map<string, number>();
      const systemInfo = {
        machineName: "Gateway machine",
        hostname: "gateway-host",
        platform: "linux",
        release: "test",
        arch: "x64",
        osLabel: "Linux",
        nodeVersion: "v26",
        pid: 1,
        uptimeMs: 1_000,
        cpuCount: 4,
        memoryTotalBytes: 8_192,
        memoryFreeBytes: 4_096,
        loadAverage: [0.5, 0.4, 0.3],
        diskTotalBytes: 16_384,
        diskAvailableBytes: 8_192,
      };
      const client = createTestGatewayClient(async (method) => {
        requests.set(method, (requests.get(method) ?? 0) + 1);
        switch (method) {
          case "environments.list":
            return {
              environments: [
                { id: "gateway", type: "local", label: "Gateway machine", status: "available" },
                { id: "worker-one", type: "worker", label: "Cloud worker", status: "available" },
                {
                  id: "worker-off",
                  type: "worker",
                  label: "Offline worker",
                  status: "unavailable",
                },
              ],
            };
          case "node.list":
            return { nodes: [] };
          case "system.info":
            return systemInfo;
          default:
            throw new Error(`Unexpected Gateway method: ${method}`);
        }
      });
      const gateway = createApplicationGateway({
        client,
        phase: "connected",
        hello: gatewayHelloForMethods(["system.info"]),
        sessionKey: "",
        offlineStable: false,
        canvasPluginSurfaceUrl: null,
        assistantAgentId: null,
        lastError: null,
        lastErrorCode: null,
      } as ApplicationGatewaySnapshot);
      const context = {
        basePath: "",
        gateway: gateway.gateway,
        sessions: {
          state: { result: null },
          subscribe: () => () => undefined,
          listSnapshot: () => ({ result: null, agentId: null, loading: false, error: null }),
          subscribeList: () => () => undefined,
          refreshList: vi.fn(async () => undefined),
        },
        agentSelection: {
          state: { selectedId: "main", scopeId: null },
          subscribe: () => () => undefined,
        },
        agents: { state: { agentsList: null } },
      } as unknown as ApplicationContext;
      const element = document.createElement("openclaw-dashboards-page") as DashboardsPageElement;
      element.routeData = routeData(row("agent:main:before", "Before"));
      const provider = createApplicationContextProvider(context);
      provider.append(element);
      document.body.append(provider);

      await vi.advanceTimersByTimeAsync(1);
      await settleLitElement(element);
      await vi.advanceTimersByTimeAsync(1);
      await settleLitElement(element);

      const monitoring = element.querySelector("[data-monitoring]");
      expect(monitoring).not.toBeNull();
      expect(monitoring?.textContent).toContain("Gateway machine");
      expect(monitoring?.textContent).toContain("Cloud worker");
      expect(
        Array.from(
          element.querySelectorAll<HTMLElement>("[data-monitoring-machine]"),
          (machine) => machine.dataset.status,
        ),
      ).toEqual(["available", "available", "unavailable"]);
      expect(element.querySelectorAll("[data-monitoring] openclaw-sparkline")).toHaveLength(3);
      expect(requests.get("environments.list")).toBe(1);
      expect(requests.get("node.list")).toBe(1);
      expect(requests.get("system.info")).toBe(1);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(requests.get("environments.list")).toBe(2);
      expect(requests.has("backup.status")).toBe(false);

      element.remove();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests.get("environments.list")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
