import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentAvatarStoragePath,
  decodeAvatarImageDataUrl,
  materializeAgentAvatarUpload,
  persistAgentAvatarUpload,
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
    expect(persisted.source).toBe(agentAvatarStoragePath("main", "png"));
    expect(persisted.filePath).toBe(path.join(workspace, "avatars", "main.png"));
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
      const materialized = await materializeAgentAvatarUpload({
        workspaceDir: workspace,
        agentId: "remote-agent",
        avatar: PNG_DATA_URL,
      });
      expect(materialized).toEqual({ ok: true, source: "avatars/remote-agent.png" });
      expect(writes).toEqual([{ filePath: "avatars/remote-agent.png", data: PNG_BODY }]);
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
      const materialized = await materializeAgentAvatarUpload({
        workspaceDir: workspace,
        agentId: "main",
        avatar: PNG_DATA_URL,
      });
      if (materialized.ok) {
        throw new Error("expected the avatar write to fail");
      }
      expect(materialized.message).toMatch(/could not save the avatar image/);
    } finally {
      await fs.chmod(blocked, 0o700);
    }
  });

  it("rethrows admission revocation before creating workspace files", async () => {
    const workspace = await createTempWorkspace();
    const revocation = new Error("uploads disabled");
    const materialized = materializeAgentAvatarUpload({
      workspaceDir: workspace,
      agentId: "main",
      avatar: PNG_DATA_URL,
      assertCurrent: () => {
        throw revocation;
      },
      rethrowIf: (error) => error === revocation,
    });
    await expect(materialized).rejects.toBe(revocation);
    await expect(fs.access(path.join(workspace, "avatars"))).rejects.toThrow();
  });
});
