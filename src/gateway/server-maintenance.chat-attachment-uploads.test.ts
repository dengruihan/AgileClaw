// Real maintenance-owner regression: a stop that arrives while a stale
// generation's activation waits for the previous shutdown must not be reopened
// by that stale activation after both stops have drained.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginStagedChatAttachment,
  commitStagedChatAttachment,
  discardChatAttachmentUploads,
  resetChatAttachmentUploadsForTests,
  runStagedChatAttachmentMutation,
  writeStagedChatAttachmentPart,
} from "./chat-attachment-upload-store.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const SCOPE = { sessionKey: "agent:main:main", agentId: "main" };

let stagingRoot = "";
let stateDir = "";

function maintenanceDeps() {
  return {
    ...createGatewayMaintenanceStateForTest(),
    logHealth: { info: vi.fn(), error: vi.fn() },
    runWorktreeGc: vi.fn(async () => undefined),
    runDeliveryQueueMediaGc: vi.fn(async () => undefined),
    runManagedOutgoingMediaGc: vi.fn(async () => ({
      deletedRecordCount: 0,
      deletedFileCount: 0,
      retainedCount: 0,
    })),
  };
}

async function stagingFiles(): Promise<string[]> {
  return (await fs.readdir(stagingRoot).catch(() => [])).toSorted();
}

async function inboundFiles(): Promise<string[]> {
  const { getMediaDir } = await import("../media/store.js");
  return (await fs.readdir(path.join(getMediaDir(), "inbound")).catch(() => [])).toSorted();
}

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-maint-state-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
});

afterAll(async () => {
  delete process.env.OPENCLAW_STATE_DIR;
  await fs.rm(stateDir, { recursive: true, force: true });
  await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-maint-parts-"));
  resetChatAttachmentUploadsForTests({ stagingRoot: async () => stagingRoot });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await discardChatAttachmentUploads();
  await fs.rm(stagingRoot, { recursive: true, force: true });
});

describe("attachment uploads across maintenance owners", () => {
  it("stays fenced when a stop arrives while a stale activation waits", async () => {
    vi.useFakeTimers();
    const stale = startGatewayMaintenanceTimers(maintenanceDeps());
    const blocker = startGatewayMaintenanceTimers(maintenanceDeps());
    try {
      const inboundBefore = await inboundFiles();
      const payload = Buffer.from("owned before stop");
      const begin = await beginStagedChatAttachment({
        scope: SCOPE,
        declaredBytes: payload.length,
        maxBytes: 1024,
        fileName: "owned.pdf",
        mimeType: "application/pdf",
      });
      await writeStagedChatAttachmentPart({
        uploadId: begin.uploadId,
        offset: 0,
        stream: (async function* () {
          yield payload;
        })(),
        scope: SCOPE,
        maxBytes: 1024,
      });

      // Hold one active upload mutation so the blocker's shutdown drain stays pending.
      const hold = createDeferred();
      const mutation = runStagedChatAttachmentMutation("held", () => hold.promise);

      // The stale owner registers its post-drain callback while the drain set is
      // still empty; the blocker immediately starts and registers the real shutdown.
      stale.startMediaCleanup();
      const blockerStop = blocker.stopMediaCleanup();
      // Let the stale callback enter activation and wait for that shutdown.
      for (let index = 0; index < 4; index += 1) {
        await Promise.resolve();
      }
      // The stale owner is stopped while its activation waits.
      const staleStop = stale.stopMediaCleanup();

      hold.resolve();
      await mutation;
      await vi.advanceTimersByTimeAsync(0);
      await expect(blockerStop).resolves.toBe("drained");
      await expect(staleStop).resolves.toBe("drained");
      // Let any queued activation continuation run before the assertions.
      for (let index = 0; index < 6; index += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      // Both owners stopped: every upload path refuses and nothing is left behind.
      await expect(
        beginStagedChatAttachment({ scope: SCOPE, declaredBytes: 4, maxBytes: 4 }),
      ).rejects.toMatchObject({ code: "shutting-down" });
      await expect(
        writeStagedChatAttachmentPart({
          uploadId: begin.uploadId,
          offset: payload.length,
          stream: (async function* () {
            yield Buffer.alloc(1);
          })(),
          scope: SCOPE,
          maxBytes: 1024,
        }),
      ).rejects.toMatchObject({ code: "shutting-down" });
      await expect(
        commitStagedChatAttachment({ uploadId: begin.uploadId, scope: SCOPE, maxBytes: 1024 }),
      ).rejects.toMatchObject({ code: "shutting-down" });
      expect(await stagingFiles()).toEqual([]);
      expect(await inboundFiles()).toEqual(inboundBefore);
    } finally {
      await stale.stopMediaCleanup().catch(() => undefined);
      await blocker.stopMediaCleanup().catch(() => undefined);
    }
  });
});
