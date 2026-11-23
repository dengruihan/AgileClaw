import { describe, expect, it, vi } from "vitest";
import type {
  SideConversationSummary,
  SideConversationsListResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { ChatSideConversations, sideConversationsFor } from "./side-conversations-controller.ts";

function conversation(
  overrides: Partial<SideConversationSummary> & { sessionKey: string },
): SideConversationSummary {
  return {
    parentSessionKey: "agent:main:run",
    intentId: overrides.sessionKey,
    ordinal: 1,
    state: "open",
    createdAt: 10,
    updatedAt: 10,
    isolation: { filesystem: "worktree", externalState: "shared" },
    worktree: { id: "wt", branch: "side/one", path: "/tmp/wt" },
    ...overrides,
  };
}

function listResult(conversations: SideConversationSummary[]): SideConversationsListResult {
  return { ok: true, parentSessionKey: "agent:main:run", sideConversations: conversations };
}

function client(handler: (method: string, params?: unknown) => Promise<unknown>) {
  return { request: vi.fn(handler) } as unknown as GatewayBrowserClient;
}

describe("ChatSideConversations", () => {
  it("shares one registry per Gateway client and notifies every subscriber", async () => {
    const gateway = client(async (method) => {
      if (method === "sideConversations.list") {
        return listResult([conversation({ sessionKey: "child" })]);
      }
      return { ok: true, conversation: conversation({ sessionKey: "child", state: "closed" }) };
    });
    const shared = sideConversationsFor(gateway);
    expect(sideConversationsFor(gateway)).toBe(shared);
    expect(sideConversationsFor(client(async () => ({})))).not.toBe(shared);
    const listener = vi.fn();
    const unsubscribe = shared.subscribe(listener);
    await shared.load("agent:main:run", gateway, "main");
    listener.mockClear();
    await shared.close({
      parentSessionKey: "agent:main:run",
      sessionKey: "child",
      client: gateway,
      agentId: "main",
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
    listener.mockClear();
    await shared.close({
      parentSessionKey: "agent:main:run",
      sessionKey: "child",
      client: gateway,
      agentId: "main",
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("loads one parent's registry and ignores an older response", async () => {
    const controller = new ChatSideConversations();
    let resolveFirst: (value: SideConversationsListResult) => void = () => {};
    const first = new Promise<SideConversationsListResult>((resolve) => {
      resolveFirst = resolve;
    });
    const request = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(listResult([conversation({ sessionKey: "new" })]));
    const gateway = { request } as unknown as GatewayBrowserClient;

    const stale = controller.load("agent:main:run", gateway, "main");
    await controller.load("agent:main:run", gateway, "main", { force: true });
    resolveFirst(listResult([conversation({ sessionKey: "stale" })]));
    await stale;

    expect(
      controller.view("agent:main:run", "main")?.conversations.map((row) => row.sessionKey),
    ).toEqual(["new"]);
    expect(request).toHaveBeenLastCalledWith("sideConversations.list", {
      parentSessionKey: "agent:main:run",
      agentId: "main",
    });
  });

  it("ignores a list response that started before a newer transition", async () => {
    const staleList = createDeferred<SideConversationsListResult>();
    let listCount = 0;
    const gateway = client((method) => {
      if (method === "sideConversations.list") {
        listCount += 1;
        return listCount === 1
          ? staleList.promise
          : Promise.resolve(
              listResult([conversation({ sessionKey: "child", state: "closed", updatedAt: 30 })]),
            );
      }
      return Promise.resolve({
        ok: true,
        conversation: conversation({ sessionKey: "child", state: "closed", updatedAt: 20 }),
      });
    });
    const controller = new ChatSideConversations();
    const loading = controller.load("agent:main:run", gateway, "main");

    await controller.close({
      parentSessionKey: "agent:main:run",
      sessionKey: "child",
      client: gateway,
      agentId: "main",
    });
    expect(controller.view("agent:main:run", "main")?.conversations[0]).toMatchObject({
      state: "closed",
      updatedAt: 20,
    });

    // The list snapshot was produced before the close and must not undo it.
    staleList.resolve(
      listResult([conversation({ sessionKey: "child", state: "open", updatedAt: 10 })]),
    );
    await loading;
    expect(controller.view("agent:main:run", "main")?.conversations[0]).toMatchObject({
      state: "closed",
      updatedAt: 20,
    });

    // The fence covers that snapshot only; a later read is authoritative again.
    await controller.load("agent:main:run", gateway, "main", { force: true });
    expect(controller.view("agent:main:run", "main")?.conversations[0]?.updatedAt).toBe(30);
  });

  it("ignores a list response that started before a newer create", async () => {
    const staleList = createDeferred<SideConversationsListResult>();
    let listCount = 0;
    const created = conversation({ sessionKey: "child", updatedAt: 20 });
    const gateway = client((method) => {
      if (method === "sideConversations.list") {
        listCount += 1;
        return listCount === 1 ? staleList.promise : Promise.resolve(listResult([created]));
      }
      return Promise.resolve({ ok: true, created: true, conversation: created });
    });
    const controller = new ChatSideConversations();
    const loading = controller.load("agent:main:run", gateway, "main");

    await controller.create({
      parentSessionKey: "agent:main:run",
      client: gateway,
      agentId: "main",
    });
    expect(
      controller.view("agent:main:run", "main")?.conversations.map((row) => row.sessionKey),
    ).toEqual(["child"]);

    staleList.resolve(listResult([]));
    await loading;
    expect(
      controller.view("agent:main:run", "main")?.conversations.map((row) => row.sessionKey),
    ).toEqual(["child"]);
  });

  it("starts a child once and merges the reply into the cached list", async () => {
    const created = conversation({ sessionKey: "child", ordinal: 2, updatedAt: 20 });
    const gateway = client(async (method) => {
      if (method === "sideConversations.list") {
        return listResult([conversation({ sessionKey: "child", ordinal: 1 })]);
      }
      return { ok: true, created: true, conversation: created };
    });
    const controller = new ChatSideConversations();
    await controller.load("agent:main:run", gateway, "main");

    await controller.create({
      parentSessionKey: "agent:main:run",
      client: gateway,
      agentId: "main",
    });

    expect(controller.view("agent:main:run", "main")?.conversations).toEqual([created]);
    const createCall = (gateway.request as ReturnType<typeof vi.fn>).mock.calls.find(
      ([method]) => method === "sideConversations.create",
    );
    expect(createCall?.[1]).toMatchObject({
      parentSessionKey: "agent:main:run",
      agentId: "main",
    });
    expect(createCall?.[1]?.intentId).toMatch(/^ui-/);
  });

  it("applies a close transition and keeps the newest state", async () => {
    const closed = conversation({ sessionKey: "child", state: "closed", closedAt: 30 });
    const gateway = client(async (method) => {
      if (method === "sideConversations.list") {
        return listResult([conversation({ sessionKey: "child" })]);
      }
      return { ok: true, conversation: closed };
    });
    const controller = new ChatSideConversations();
    await controller.load("agent:main:run", gateway, "main");

    await controller.close({
      parentSessionKey: "agent:main:run",
      sessionKey: "child",
      client: gateway,
      agentId: "main",
    });

    expect(controller.view("agent:main:run", "main")?.conversations[0]?.state).toBe("closed");
  });

  it("does not issue a second transition while one is pending", async () => {
    let release: () => void = () => {};
    const gateway = client((method) =>
      method === "sideConversations.list"
        ? Promise.resolve(listResult([conversation({ sessionKey: "child" })]))
        : new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                conversation: conversation({ sessionKey: "child", state: "closed" }),
              });
          }),
    );
    const controller = new ChatSideConversations();
    await controller.load("agent:main:run", gateway, "main");
    const target = {
      parentSessionKey: "agent:main:run",
      sessionKey: "child",
      client: gateway,
      agentId: "main",
    };

    const first = controller.close(target);
    const second = controller.close(target);
    expect(controller.view("agent:main:run", "main")?.pendingSessionKeys.has("child")).toBe(true);
    release();
    await Promise.all([first, second]);

    const transitions = (gateway.request as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([method]) => method !== "sideConversations.list",
    );
    expect(transitions).toHaveLength(1);
    expect(controller.view("agent:main:run", "main")?.pendingSessionKeys.size).toBe(0);
  });

  it("records a merge outcome and a visible transition error", async () => {
    const gateway = client(async (method) => {
      if (method === "sideConversations.list") {
        return listResult([conversation({ sessionKey: "child" })]);
      }
      if (method === "sideConversations.merge") {
        return {
          ok: true,
          conversation: conversation({ sessionKey: "child", state: "merged" }),
          alreadyMerged: false,
          mergeCommit: "abc",
        };
      }
      throw Object.assign(new Error("merge conflict in app.ts"), {});
    });
    const controller = new ChatSideConversations();
    await controller.load("agent:main:run", gateway, "main");

    await controller.merge({
      parentSessionKey: "agent:main:run",
      sessionKey: "child",
      client: gateway,
      agentId: "main",
    });
    expect(controller.view("agent:main:run", "main")?.notices.get("child")).toBe("merged");

    await expect(
      controller.abandon({
        parentSessionKey: "agent:main:run",
        sessionKey: "child",
        client: gateway,
        agentId: "main",
      }),
    ).rejects.toThrow();
    expect(controller.view("agent:main:run", "main")?.notices.get("child")).toContain(
      "merge conflict in app.ts",
    );
  });

  it("keeps parents isolated", async () => {
    const gateway = client(async () => listResult([conversation({ sessionKey: "child" })]));
    const controller = new ChatSideConversations();
    await controller.load("agent:main:other", gateway, "main");
    expect(controller.view("agent:main:run", "main")?.conversations).toEqual([]);
    expect(controller.view("agent:main:other", "main")?.conversations).toHaveLength(1);
  });
});
