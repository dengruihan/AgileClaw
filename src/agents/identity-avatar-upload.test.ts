import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentAvatarStoragePath,
  decodeAvatarImageDataUrl,
  persistAgentAvatarUpload,
  stageAgentAvatarUpload,
} from "./identity-avatar-upload.js";
import { registerAgentWorkspaceAccess } from "./workspace-access.js";

const tempRoots: string[] = [];

async function createTempWorkspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-upload-"));
  tempRoots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const PNG_BODY = Buffer.from([1, 2, 3]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BODY.toString("base64")}`;

describe("decodeAvatarImageDataUrl", () => {
  it("decodes supported base64 image types to their storage extension", () => {
    for (const [mime, extension] of [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/webp", "webp"],
      ["image/gif", "gif"],
      ["image/svg+xml", "svg"],
    ] as const) {
      const result = decodeAvatarImageDataUrl(
        `data:${mime};base64,${Buffer.from("image").toString("base64")}`,
      );
      expect(result).toMatchObject({ ok: true, value: { mimeType: mime, extension } });
    }
  });

  it("accepts upper-case prefixes and padding", () => {
    const result = decodeAvatarImageDataUrl(`DATA:image/png;BASE64,${PNG_BODY.toString("base64")}`);
    expect(result).toMatchObject({ ok: true, value: { body: PNG_BODY } });
  });

  it.each([
    ["non-base64 payload", "data:image/png;base64,AQID%20"],
    ["non-canonical base64", "data:image/png;base64,AQI"],
    ["url-encoded svg", "data:image/svg+xml,%3Csvg%3E"],
    ["unsupported image mime", `data:image/bmp;base64,${PNG_BODY.toString("base64")}`],
    ["non-image data URL", "data:text/plain,aGVsbG8="],
    ["missing payload", "data:image/png;base64,"],
    ["plain path", "avatars/main.png"],
  ])("rejects %s", (_label, value) => {
    const result = decodeAvatarImageDataUrl(value);
    if (result.ok) {
      throw new Error(`expected ${value} to be rejected`);
    }
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("rejects payloads whose decoded size exceeds the avatar budget", () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    const result = decodeAvatarImageDataUrl(
      `data:image/png;base64,${oversized.toString("base64")}`,
    );
    expect(result).toMatchObject({ ok: false, reason: "too_large" });
  });
});

describe("stageAgentAvatarUpload", () => {
  it("stages bytes without touching the workspace until publish", async () => {
    const workspace = await createTempWorkspace();
    const staged = stageAgentAvatarUpload({
      workspaceDir: workspace,
      agentId: "main",
      avatar: PNG_DATA_URL,
    });
    if (!staged.ok) {
      throw new Error("expected staged avatar");
    }
    const source = agentAvatarStoragePath("main", "png", PNG_BODY);

    expect(staged.upload.source).toBe(source);
    await expect(fs.access(path.join(workspace, "avatars"))).rejects.toThrow();

    await staged.upload.publish();
    expect(await fs.readFile(staged.upload.filePath)).toEqual(PNG_BODY);
  });

  it("never replaces an earlier avatar file when a later upload fails to publish", async () => {
    const workspace = await createTempWorkspace();
    const first = stageAgentAvatarUpload({
      workspaceDir: workspace,
      agentId: "main",
      avatar: PNG_DATA_URL,
    });
    if (!first.ok) {
      throw new Error("expected staged avatar");
    }
    await first.upload.publish();

    const second = stageAgentAvatarUpload({
      workspaceDir: workspace,
      agentId: "main",
      avatar: `data:image/png;base64,${Buffer.from([9, 9, 9]).toString("base64")}`,
    });
    if (!second.ok) {
      throw new Error("expected staged avatar");
    }
    expect(second.upload.source).not.toBe(first.upload.source);

    await expect(fs.readFile(first.upload.filePath)).resolves.toEqual(PNG_BODY);
    await second.upload.publish();
    expect(await fs.readFile(first.upload.filePath)).toEqual(PNG_BODY);
    expect(await fs.readFile(second.upload.filePath)).toEqual(Buffer.from([9, 9, 9]));
  });

  it("reports unsupported uploads without staging workspace work", async () => {
    const workspace = await createTempWorkspace();
    const staged = stageAgentAvatarUpload({
      workspaceDir: workspace,
      agentId: "main",
      avatar: "data:image/bmp;base64,AQID",
    });
    expect(staged.ok).toBe(false);
    await expect(fs.access(path.join(workspace, "avatars"))).rejects.toThrow();
  });
});

describe("persistAgentAvatarUpload", () => {
  it("writes local workspace avatar files and returns the persisted source", async () => {
    const workspace = await createTempWorkspace();
    const decoded = decodeAvatarImageDataUrl(PNG_DATA_URL);
    if (!decoded.ok) {
      throw new Error("expected decodable avatar");
    }
    const persisted = await persistAgentAvatarUpload({
      workspaceDir: workspace,
      agentId: "main",
      decoded: decoded.value,
    });
    const source = agentAvatarStoragePath("main", "png", PNG_BODY);
    expect(persisted.source).toBe(source);
    expect(persisted.filePath).toBe(path.join(workspace, "avatars", source.split("/")[1]!));
    expect(await fs.readFile(persisted.filePath)).toEqual(PNG_BODY);
  });

  it("writes through remote workspace access bridges", async () => {
    const workspace = await createTempWorkspace();
    const writes: Array<{ filePath: string; data: Buffer }> = [];
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: async () => Buffer.alloc(0),
        writeFile: async (params) => {
          writes.push({ filePath: params.filePath, data: Buffer.from(params.data as Buffer) });
        },
        stat: async () => null,
      },
    });
    try {
      const staged = stageAgentAvatarUpload({
        workspaceDir: workspace,
        agentId: "remote-agent",
        avatar: PNG_DATA_URL,
      });
      if (!staged.ok) {
        throw new Error("expected staged avatar");
      }
      await staged.upload.publish();
      const source = agentAvatarStoragePath("remote-agent", "png", PNG_BODY);
      expect(writes).toEqual([{ filePath: source, data: PNG_BODY }]);
    } finally {
      release();
    }
  });

  it("reports unwritable workspaces with an actionable failure", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-avatar-denied-"));
    tempRoots.push(root);
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const blocked = path.join(workspace, "avatars");
    await fs.mkdir(blocked);
    await fs.chmod(blocked, 0o500);
    try {
      const decoded = decodeAvatarImageDataUrl(PNG_DATA_URL);
      if (!decoded.ok) {
        throw new Error("expected decodable avatar");
      }
      await expect(
        persistAgentAvatarUpload({
          workspaceDir: workspace,
          agentId: "main",
          decoded: decoded.value,
        }),
      ).rejects.toThrow();
    } finally {
      await fs.chmod(blocked, 0o700);
    }
  });

  it("rethrows admission revocation before creating workspace files", async () => {
    const workspace = await createTempWorkspace();
    const decoded = decodeAvatarImageDataUrl(PNG_DATA_URL);
    if (!decoded.ok) {
      throw new Error("expected decodable avatar");
    }
    const revocation = new Error("uploads disabled");
    await expect(
      persistAgentAvatarUpload({
        workspaceDir: workspace,
        agentId: "main",
        decoded: decoded.value,
        assertCurrent: () => {
          throw revocation;
        },
      }),
    ).rejects.toBe(revocation);
    await expect(fs.access(path.join(workspace, "avatars"))).rejects.toThrow();
  });
});
