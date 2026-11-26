// Real Gateway close ordering: the maintenance stop owner must fence direct
// upload admission, join in-flight mutations, and remove staging plus unsent
// media before the HTTP listener closes, so a still-open route cannot publish
// after the final cleanup.
import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { getMediaDir } from "../media/store.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

const STAGING_DIR = path.join(resolvePreferredOpenClawTmpDir(), "chat-attachment-uploads");

type UploadResponse = { status: number; body: Record<string, unknown> | null };

async function inboundFiles(): Promise<string[]> {
  return (await fs.readdir(path.join(getMediaDir(), "inbound")).catch(() => [])).toSorted();
}

async function stagingFiles(): Promise<string[]> {
  return (await fs.readdir(STAGING_DIR).catch(() => [])).toSorted();
}

it("fences and cleans direct uploads before the HTTP listener closes", async () => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-attachment-upload-close");
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = fixture.kernels.get(port);
    expect(kernel).toBeDefined();
    const maintenance = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      scheduler: kernel!.scheduler,
      isNixMode: true,
      runManagedOutgoingMediaGc: async () => ({
        deletedRecordCount: 0,
        deletedFileCount: 0,
        retainedCount: 0,
      }),
    });
    kernel!.kernel.setMaintenanceHandles(maintenance);
    maintenance.startMediaCleanup();

    const token = `metadata-close-token-${port}`;
    const origin = `http://127.0.0.1:${port}`;
    const post = async (
      query: Record<string, string | number>,
      body?: BodyInit,
    ): Promise<UploadResponse> => {
      const response = await fetch(
        `${origin}/api/chat/attachments/upload?${new URLSearchParams(
          Object.entries(query).map(([key, value]) => [key, String(value)]),
        )}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          ...(body ? { body } : {}),
        },
      );
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as Record<string, unknown> | null,
      };
    };

    const inboundBefore = await inboundFiles();
    const stagingBaseline = await stagingFiles();

    // One upload is committed but never sent; another is left mid-staging.
    const payload = new Uint8Array(Buffer.from("%PDF-1.4\nunsent attachment\n"));
    const begin = await post({
      action: "begin",
      sizeBytes: payload.length,
      fileName: "unsent.pdf",
      mimeType: "application/pdf",
    });
    expect(begin.status).toBe(200);
    const committedId = begin.body?.uploadId as string;
    const part = await post({ action: "part", uploadId: committedId, offset: 0 }, payload);
    expect(part.status).toBe(200);
    const commit = await post({ action: "commit", uploadId: committedId });
    expect(commit.status).toBe(200);

    const staged = await post({ action: "begin", sizeBytes: 32, fileName: "staged.bin" });
    expect(staged.status).toBe(200);
    const stagedId = staged.body?.uploadId as string;
    const stagedPath = path.join(STAGING_DIR, `${stagedId}.part`);
    await expect(fs.stat(stagedPath)).resolves.toBeTruthy();
    expect((await inboundFiles()).length).toBe(inboundBefore.length + 1);

    // A begin racing the shutdown is either refused or fenced; either way it must
    // not leave an ID, a staging file, or media behind after the close.
    const racingBegin = post({ action: "begin", sizeBytes: 4, fileName: "race.bin" }).catch(
      () => undefined,
    );
    await server.close({ reason: "attachment upload close regression" });
    await racingBegin;

    // Final cleanup ran: the unsent published media and staging file are gone.
    expect(await inboundFiles()).toEqual(inboundBefore);
    expect(await stagingFiles()).toEqual(stagingBaseline);
    await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });

    // The listener is closed, so the route cannot accept a new upload afterwards.
    await expect(post({ action: "begin", sizeBytes: 4 })).rejects.toThrow();
  } finally {
    await fixture.cleanup();
  }
}, 120_000);
