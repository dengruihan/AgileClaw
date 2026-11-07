/* @vitest-environment jsdom */

import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { showInputDialog } from "../../components/input-dialog.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";

vi.mock("../../components/input-dialog.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../components/input-dialog.ts")>()),
  showInputDialog: vi.fn(),
}));
import {
  createPaneHeaderWorkspaceFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";

describe("chat pane session access", () => {
  it("refuses ordinary session creation for read-only operators", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.create"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(pane.createSession()).resolves.toBe(false);

    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.lastError).toContain("operator.sessions.write");
    expect(state.chatError).toBe(state.lastError);
  });

  it("requires operator.admin when session creation inherits an incognito parent", async () => {
    const sessions = {
      create: vi.fn(async () => "agent:main:new"),
    } as unknown as SessionCapability;
    const client = {} as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:main:dashboard:incognito-current";
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.create"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await expect(pane.createSession()).resolves.toBe(false);

    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.lastError).toContain("operator.admin");
    expect(state.chatError).toBe(state.lastError);
  });

  it("refuses header rename when sessions.patch is unavailable or lacks write scope", async () => {
    for (const hello of [
      {
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["sessions.create"] },
      },
      {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["sessions.patch"] },
      },
    ]) {
      const patch = vi.fn(async () => ({}));
      const sessions = { patch } as unknown as SessionCapability;
      const { pane, state, requestUpdate } = createTestChatPane({
        client: {} as GatewayBrowserClient,
        sessions,
      });
      pane.context.gateway.snapshot.hello =
        hello as ApplicationContext["gateway"]["snapshot"]["hello"];
      const session = {
        key: "agent:main:current",
        kind: "direct",
        updatedAt: 0,
      } satisfies GatewaySessionRow;

      await pane.handleHeaderSessionAction({ kind: "rename" }, session);

      expect(showInputDialog).not.toHaveBeenCalled();
      expect(state.chatError).toBeTruthy();
      expect(requestUpdate).toHaveBeenCalledOnce();
      expect(patch).not.toHaveBeenCalled();
    }
  });

  it("rechecks header rename access after the dialog resolves", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    vi.mocked(showInputDialog).mockImplementation(async () => {
      pane.context.gateway.snapshot.hello = {
        auth: { role: "operator", scopes: ["operator.read"] },
        features: { methods: ["sessions.patch"] },
      } as ApplicationContext["gateway"]["snapshot"]["hello"];
      return "Blocked rename";
    });
    await pane.handleHeaderSessionAction({ kind: "rename" }, session);

    expect(state.chatError).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("drops a resolved rename dialog when the Gateway source changes for the same session", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = createSessionCapabilityFixture({ patch });
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client, sessions });
    const hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    pane.context.gateway.snapshot.hello = hello;
    state.hello = hello;
    const session = {
      key: state.sessionKey,
      kind: "direct",
      updatedAt: 0,
    } satisfies GatewaySessionRow;

    vi.mocked(showInputDialog).mockImplementation(async () => {
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        client: { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient,
        phase: "stopped",
        hello: null,
        sessionKey: state.sessionKey,
      });
      return "Replacement Gateway title";
    });
    await pane.handleHeaderSessionAction({ kind: "rename" }, session);

    expect(patch).not.toHaveBeenCalled();
  });

  it("refuses archived-session restore without exact sessions.patch access", async () => {
    const patch = vi.fn(async () => ({}));
    const sessions = { patch } as unknown as SessionCapability;
    const { pane, state, requestUpdate } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.read"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(state.chatError).toBeTruthy();
    expect(state.lastError).toBe(state.chatError);
    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(patch).not.toHaveBeenCalled();
  });

  it("restores the exact durable session observed by the composer", async () => {
    const patch = vi.fn(async () => ({ ok: true }));
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: { patch } as unknown as SessionCapability,
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["sessions.patch"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    state.sessionsResult = sessionsResult(
      [
        {
          key: state.sessionKey,
          kind: "direct",
          sessionId: "session-a",
          archived: true,
          sharingRole: "owner",
        },
      ],
      0,
    );

    await pane.restoreArchivedSession(state.sessionKey, "session-a");

    expect(patch).toHaveBeenCalledWith(
      state.sessionKey,
      { archived: false },
      { agentId: "main", expectedSessionId: "session-a" },
    );
  });

  it("keeps sharing hidden when legacy Gateways omit method metadata", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      sharingRole: "owner",
      visibility: "shared",
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");

    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        null,
      ),
      container,
    );

    expect(container.querySelector(".chat-pane__sharing-menu")).toBeNull();
  });

  it("keeps visibility controls available without member-list support", () => {
    const { pane, state } = createTestChatPane({
      client: {} as GatewayBrowserClient,
      sessions: createSessionCapabilityFixture(),
    });
    pane.context.gateway.snapshot.hello = {
      auth: { role: "operator", scopes: ["operator.write"] },
      features: { methods: ["session.visibility.set"] },
      policy: { allowedSessionVisibilities: ["shared", "read-only"] },
    } as ApplicationContext["gateway"]["snapshot"]["hello"];
    const session = {
      key: "agent:main:current",
      kind: "direct",
      updatedAt: 0,
      sharingRole: "owner",
      visibility: "shared",
    } satisfies GatewaySessionRow;
    const container = document.createElement("div");

    render(
      pane.renderPaneHeader(
        createPaneHeaderWorkspaceFixture(state),
        session,
        false,
        undefined,
        null,
      ),
      container,
    );

    expect(
      container.querySelector<HTMLButtonElement>(".chat-pane__sharing-trigger")?.disabled,
    ).toBe(false);
    expect(
      container.querySelector('wa-dropdown-item[value="visibility:read-only"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain("People");
  });
});
