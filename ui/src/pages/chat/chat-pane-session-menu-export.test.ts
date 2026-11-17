/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { downloadBlobFile } from "../../lib/download.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { showToast } from "../../lib/toast.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
  createTestChatPane,
} from "./chat-pane.test-support.ts";
import {
  installTranscriptDomMocks,
  resetTranscriptTestDom,
} from "./components/chat-transcript.test-support.ts";

vi.mock("../../lib/toast.ts", () => ({ showToast: vi.fn() }));
vi.mock("../../lib/download.ts", () => ({
  downloadBlobFile: vi.fn(),
  downloadTextFile: vi.fn(),
}));

beforeEach(installTranscriptDomMocks);

afterEach(() => {
  resetTranscriptTestDom();
  vi.clearAllMocks();
});

const session = {
  key: "agent:main:pdf-export",
  sessionId: "session-pdf",
  kind: "direct" as const,
  updatedAt: 1,
};
const otherSession = {
  key: "agent:main:pdf-export-other",
  sessionId: "session-other",
  kind: "direct" as const,
  updatedAt: 2,
};

function sessionsResult(rows: (typeof session)[]) {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows.map((row) => ({ ...row })),
  };
}

function createFixture(
  request: Parameters<typeof createGatewayBrowserClientFixture>[0]["request"],
) {
  const client = createGatewayBrowserClientFixture({ request });
  const { pane, state } = createTestChatPane({
    client,
    sessions: createSessionCapabilityFixture(),
  });
  const hello = gatewayHelloForMethods(["chat.history"], ["operator.read", "operator.write"]);
  pane.context.gateway.snapshot.client = client;
  pane.context.gateway.snapshot.phase = "connected";
  pane.context.gateway.snapshot.hello = hello;
  state.hello = hello;
  state.sessionKey = session.key;
  state.currentSessionId = session.sessionId;
  state.sessionsResult = sessionsResult([session, otherSession]);
  state.settings = loadSettings();
  return { pane, state, hello };
}

function historyPage(messages: unknown[], params: { hasMore: boolean; sessionId: string }) {
  return {
    sessionId: params.sessionId,
    messages,
    totalMessages: 3,
    hasMore: params.hasMore,
    ...(params.hasMore ? { nextOffset: 1 } : {}),
    deltaCursor: "cursor",
    sessionInfo: { activeLeafEntryId: "leaf" },
  };
}

describe("chat pane PDF export authority boundary", () => {
  it.each(["role", "scopes"] as const)(
    "stops a pending export when live history %s authority is revoked in place",
    async (revocation) => {
      const deferred = createDeferred<unknown>();
      let calls = 0;
      const request = vi.fn(async (method: string) => {
        if (method !== "chat.history") {
          return {};
        }
        calls += 1;
        if (calls === 1) {
          return historyPage([{ role: "user", content: "first page" }], {
            hasMore: true,
            sessionId: session.sessionId,
          });
        }
        return await deferred.promise;
      });
      const { pane, state, hello } = createFixture(request);

      const exported = pane.handleHeaderSessionAction({ kind: "export-pdf" }, { ...session });
      await vi.waitFor(() => expect(calls).toBe(2));

      // The Gateway can revoke authority inside the same hello object it already sent.
      hello.auth =
        revocation === "role"
          ? { role: "node", scopes: hello.auth?.scopes ?? [] }
          : { role: "operator", scopes: [] };
      deferred.resolve(
        historyPage([{ role: "assistant", content: "second page" }], {
          hasMore: false,
          sessionId: session.sessionId,
        }),
      );
      await exported;

      expect(pane.context.gateway.snapshot.hello).toBe(hello);
      expect(downloadBlobFile).not.toHaveBeenCalled();
      // The pane surfaces the same live denial the transcript read hit.
      expect(state.chatError).toBe(
        readSessionMethodAccess(pane.context.gateway.snapshot, {
          method: "chat.history",
          requiredScope: "operator.read",
          sessionScope: true,
        }).reason,
      );
    },
  );

  it("retires a pending export after a session switch and only then reports no download", async () => {
    const deferred = createDeferred<unknown>();
    let calls = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "chat.history") {
        return {};
      }
      calls += 1;
      if (calls === 1) {
        return historyPage([{ role: "user", content: "first page" }], {
          hasMore: true,
          sessionId: session.sessionId,
        });
      }
      return await deferred.promise;
    });
    const { pane, state } = createFixture(request);

    const exported = pane.handleHeaderSessionAction({ kind: "export-pdf" }, { ...session });
    await vi.waitFor(() => expect(calls).toBe(2));

    // The pane now presents another conversation while the old read is still open.
    state.sessionKey = otherSession.key;
    state.currentSessionId = otherSession.sessionId;
    state.sessionsResult = sessionsResult([otherSession]);
    deferred.resolve(
      historyPage([{ role: "assistant", content: "second page" }], {
        hasMore: false,
        sessionId: session.sessionId,
      }),
    );
    // Awaiting the handler proves the export finished before the zero-download check.
    await exported;

    expect(downloadBlobFile).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: t("chat.sessionHeader.exportPdf.downloaded") }),
    );
    expect(state.chatError).toBeNull();
  });
  it("reports replaced characters in the completion toast", async () => {
    const request = vi.fn(async (method: string) => {
      if (method !== "chat.history") {
        return {};
      }
      return historyPage(
        [
          { role: "user", content: "Emoji fidelity: \u{1F99E}" },
          { role: "assistant", content: "Body text." },
        ],
        { hasMore: false, sessionId: session.sessionId },
      );
    });
    const { pane } = createFixture(request);

    await pane.handleHeaderSessionAction({ kind: "export-pdf" }, { ...session });

    expect(downloadBlobFile).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith({
      message: expect.stringContaining("1 character"),
    });
  });
});
