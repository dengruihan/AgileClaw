import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import {
  beginStagedChatAttachment,
  commitStagedChatAttachment,
  writeStagedChatAttachmentPart,
} from "../chat-attachment-upload-store.js";
import { prepareChatSendAttachments } from "./chat-send-attachments.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";

it.each(["off", "all"] as const)(
  "prepares both owners' global attachments with sandbox %s",
  async (mode) => {
    await withOpenClawTestState({ label: "gateway-media-owner" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            main: { workspace: state.path("main") },
            work: { workspace: state.path("work") },
          },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode,
              scope: "agent" as const,
              workspaceRoot: state.path("sandboxes"),
              workspaceAccess: "none" as const,
            },
          },
        },
        session: { scope: "global" as const },
      };
      const paths: string[] = [];
      for (const agentId of ["main", "work"]) {
        const bytes = `${agentId} attachment contents`;
        const fileName = "notes café 雪 🦞.txt";
        const request = normalizeChatSendRequest({
          client: null,
          params: {
            agentId,
            sessionKey: "global",
            message: "read the file",
            idempotencyKey: `media-${agentId}`,
            attachments: [
              {
                fileName,
                mimeType: "text/plain",
                content: Buffer.from(bytes).toString("base64"),
              },
            ],
          },
        });
        expect(request.ok).toBe(true);
        if (!request.ok) {
          throw new Error(request.error);
        }
        const respond = vi.fn();
        const controller = new AbortController();
        const result = await prepareChatSendAttachments({
          request: request.value,
          session: {
            cfg,
            sessionKey: "global",
            agentId,
            resolvedSessionModel: { provider: "fixture", model: "fixture" },
            clientRunId: `media-${agentId}`,
          },
          admission: {
            activeRunAbort: { controller },
            assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
            cleanupAdmittedRun() {},
          },
          context: { logGateway: createSubsystemLogger("test/media-owner") },
          respond,
        } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
        expect(respond.mock.calls).toEqual([]);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          throw new Error("attachment preparation failed");
        }
        const media = result.value.mediaPathOffloads[0]!;
        expect(media.fileName).toBe(fileName);
        const file = path.resolve(media.workspaceDir!, media.path!);
        expect(await fs.readFile(file, "utf8")).toBe(bytes);
        paths.push(file);
        if (mode === "all") {
          expect(file.startsWith(state.path("sandboxes"))).toBe(true);
        }
      }
      expect(paths[0]).not.toBe(paths[1]);
    });
  },
);

it.each(["off", "all"] as const)(
  "prepares a direct upload through the real prestage path with sandbox %s",
  async (mode) => {
    await withOpenClawTestState({ label: "gateway-direct-upload-sandbox" }, async (state) => {
      const cfg = {
        agents: {
          ownership: "explicit" as const,
          entries: { main: { workspace: state.path("main") } },
          defaults: {
            skipBootstrap: true,
            sandbox: {
              mode,
              scope: "agent" as const,
              workspaceRoot: state.path("sandboxes"),
              workspaceAccess: "none" as const,
            },
          },
        },
        session: { scope: "global" as const },
      };
      const bytes = "%PDF-1.4\ndirect upload payload";
      const scope = { sessionKey: "global", agentId: "main" };
      const upload = await beginStagedChatAttachment({
        scope,
        declaredBytes: bytes.length,
        maxBytes: 1024 * 1024,
        fileName: "direct.pdf",
        mimeType: "application/pdf",
      });
      await writeStagedChatAttachmentPart({
        uploadId: upload.uploadId,
        offset: 0,
        stream: (async function* () {
          yield Buffer.from(bytes);
        })(),
        scope,
        maxBytes: 1024 * 1024,
      });
      await commitStagedChatAttachment({
        uploadId: upload.uploadId,
        scope,
        maxBytes: 1024 * 1024,
      });

      const request = normalizeChatSendRequest({
        client: null,
        params: {
          agentId: "main",
          sessionKey: "global",
          message: "read the file",
          idempotencyKey: "direct-upload-sandbox",
          attachments: [
            { fileName: "direct.pdf", mimeType: "application/pdf", uploadId: upload.uploadId },
          ],
        },
      });
      expect(request.ok).toBe(true);
      if (!request.ok) {
        throw new Error(request.error);
      }
      const controller = new AbortController();
      const result = await prepareChatSendAttachments({
        request: request.value,
        session: {
          cfg,
          sessionKey: "global",
          agentId: "main",
          resolvedSessionModel: { provider: "fixture", model: "fixture" },
          clientRunId: "direct-upload-sandbox",
        },
        admission: {
          activeRunAbort: { controller },
          assertWorkAdmissionCurrent: () => controller.signal.throwIfAborted(),
          cleanupAdmittedRun() {},
        },
        context: { logGateway: createSubsystemLogger("test/direct-upload-sandbox") },
        respond: vi.fn(),
      } as unknown as Parameters<typeof prepareChatSendAttachments>[0]);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error("attachment preparation failed");
      }
      const media = result.value.mediaPathOffloads[0]!;
      expect(media.fileName).toBe("direct.pdf");
      const file = path.resolve(media.workspaceDir!, media.path!);
      expect(await fs.readFile(file, "utf8")).toBe(bytes);
      if (mode === "all") {
        expect(file.startsWith(state.path("sandboxes"))).toBe(true);
      }
      await fs.rm(file, { force: true });
    });
  },
);
