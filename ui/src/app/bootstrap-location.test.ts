import { describe, expect, it, vi } from "vitest";
import { sessionRefFromPath } from "../app-session-route-paths.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import type { ApplicationContext } from "./context.ts";

describe("resolveInitialApplicationLocation", () => {
  it.each([
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345",
        hash: "",
      },
      expected: { pathname: "/chat/research/telegram/12345", search: "", hash: "" },
      namespace: "chat",
      sessionKey: "agent:research:telegram:12345",
    },
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Atelegram%3A12345&face=dashboard",
        hash: "",
      },
      expected: { pathname: "/dashboard/research/telegram/12345", search: "", hash: "" },
      namespace: "dashboard",
      sessionKey: "agent:research:telegram:12345",
    },
    {
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Arelease-deadbeef",
        hash: "",
      },
      expected: { pathname: "/chat/research/~key/release-deadbeef", search: "", hash: "" },
      namespace: "chat",
      sessionKey: "agent:research:release-deadbeef",
    },
  ] as const)("rewrites released query links to $expected.pathname", async (testCase) => {
    const subscribe = vi.fn(() => () => undefined);
    const resolved = await resolveInitialApplicationLocation({
      location: testCase.location,
      basePath: "",
      gateway: {
        snapshot: { phase: "connecting", client: null, hello: null },
        subscribe,
      } as unknown as ApplicationContext["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });

    expect(resolved).toEqual(testCase.expected);
    expect(sessionRefFromPath(resolved.pathname, "", "main")).toMatchObject({
      namespace: testCase.namespace,
      kind: "literal",
      sessionKey: testCase.sessionKey,
    });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("opens a new draft for a released link without a session key", async () => {
    const resolved = await resolveInitialApplicationLocation({
      location: { pathname: "/chat", search: "?session=", hash: "" },
      basePath: "",
      gateway: {
        snapshot: { phase: "connected", client: {}, hello: null },
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ApplicationContext["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });
    expect(resolved).toEqual({ pathname: "/new", search: "?agent=main", hash: "" });
  });

  it("preserves the UUID when rewriting a released session query", async () => {
    const resolved = await resolveInitialApplicationLocation({
      location: {
        pathname: "/chat",
        search:
          "?session=agent%3Aresearch%3Athread%3A12345678-aaaa-4000-8000-000000000001&draft=continue",
        hash: "",
      },
      basePath: "",
      gateway: {
        snapshot: { phase: "connected", client: {}, hello: null },
        subscribe: vi.fn(() => () => undefined),
      } as unknown as ApplicationContext["gateway"],
      agentsList: () => ({ defaultId: "main", mainKey: "main", scope: "global", agents: [] }),
      signal: new AbortController().signal,
    });
    expect(resolved).toEqual({
      pathname: "/chat/research/12345678aaaa40008000000000000001",
      search: "?draft=continue",
      hash: "",
    });
  });

  it("does not consume Sessions list row-expansion state", async () => {
    const location = { pathname: "/sessions", search: "?session=agent%3Amain%3Amain", hash: "" };
    const subscribe = vi.fn(() => () => undefined);
    await expect(
      resolveInitialApplicationLocation({
        location,
        basePath: "",
        gateway: {
          snapshot: { phase: "connecting", client: null, hello: null },
          subscribe,
        } as unknown as ApplicationContext["gateway"],
        agentsList: () => null,
        signal: new AbortController().signal,
      }),
    ).resolves.toBe(location);
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("waits for cold custom-main defaults before rewriting a released query link", async () => {
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const pending = resolveInitialApplicationLocation({
      location: {
        pathname: "/chat",
        search: "?session=agent%3Aresearch%3Aworkspace",
        hash: "",
      },
      basePath: "",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agentsList: () => null,
      signal: new AbortController().signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({
      pathname: "/chat/research",
      search: "",
      hash: "",
    });
  });
});
