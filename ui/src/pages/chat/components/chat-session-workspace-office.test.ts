import { describe, expect, it, vi } from "vitest";
import { gatewayHelloForMethods } from "../../../test-helpers/gateway-methods.ts";
import {
  createGatewayBrowserClientFixture,
  createSessionCapabilityFixture,
} from "../chat-pane.test-support.ts";
import {
  createSidebarContentRecorder,
  loadedSidebarContent,
} from "./chat-session-workspace.test-support.ts";
import { openSessionWorkspaceFile, type SessionWorkspaceHost } from "./chat-session-workspace.ts";

describe("openSessionWorkspaceFile Office previews", () => {
  it("opens an Office workspace file with its converted PDF payload", async () => {
    const pdf = {
      mimeType: "application/pdf" as const,
      data: btoa("%PDF-1.7\nworkspace-preview"),
      sizeBytes: 22,
    };
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
      sessionKey,
      root: "/shared",
      file: {
        path: "budget.xlsx",
        workspacePath: "budget.xlsx",
        name: "budget.xlsx",
        kind: "read",
        missing: false,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        previewKind: "office",
        previewState: "ready",
        officePdf: pdf,
      },
    }));
    const state: SessionWorkspaceHost = {
      client: createGatewayBrowserClientFixture(),
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:viewer",
      sidebarContent: null,
      requestUpdate: vi.fn(),
      sessions: createSessionCapabilityFixture({ getFile }),
    };

    openSessionWorkspaceFile(state, { path: "budget.xlsx" });

    expect(await loadedSidebarContent(state)).toEqual({
      kind: "office",
      title: "budget.xlsx",
      pdf,
    });
  });

  it("shows the degraded reason for an Office file without a PDF", async () => {
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
      sessionKey,
      root: "/shared",
      file: {
        path: "budget.xlsx",
        workspacePath: "budget.xlsx",
        name: "budget.xlsx",
        kind: "read",
        missing: false,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        previewKind: "unsupported",
        previewState: "unavailable",
      },
    }));
    const state: SessionWorkspaceHost = {
      client: createGatewayBrowserClientFixture(),
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:viewer",
      sidebarContent: null,
      requestUpdate: vi.fn(),
      sessions: createSessionCapabilityFixture({ getFile }),
    };

    openSessionWorkspaceFile(state, { path: "budget.xlsx" });

    const content = await loadedSidebarContent(state);
    expect(content.kind).toBe("markdown");
    if (content.kind === "markdown") {
      expect(content.content).toContain("document conversion service is unavailable");
    }
  });
  it("explains both the source and converted-PDF preview limits", async () => {
    const getFile = vi.fn<SessionWorkspaceHost["sessions"]["getFile"]>(async (sessionKey) => ({
      sessionKey,
      root: "/shared",
      file: {
        path: "budget.xlsx",
        workspacePath: "budget.xlsx",
        name: "budget.xlsx",
        kind: "read",
        missing: false,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        previewKind: "unsupported",
        previewState: "too-large",
      },
    }));
    const state: SessionWorkspaceHost = {
      client: createGatewayBrowserClientFixture(),
      connected: true,
      connectionEpoch: 1,
      handleOpenSidebar: createSidebarContentRecorder(),
      hello: gatewayHelloForMethods([]),
      sessionKey: "agent:main:viewer",
      sidebarContent: null,
      requestUpdate: vi.fn(),
      sessions: createSessionCapabilityFixture({ getFile }),
    };

    openSessionWorkspaceFile(state, { path: "budget.xlsx" });

    const content = await loadedSidebarContent(state);
    expect(content.kind).toBe("markdown");
    if (content.kind === "markdown") {
      expect(content.content).toContain("8 MiB");
      expect(content.content).toContain("16 MiB");
    }
  });
});
