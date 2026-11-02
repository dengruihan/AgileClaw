import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectAvatarFileMigrationFindings,
  migrateAgentAvatarFilesToWorkspaces,
} from "./doctor-avatar-file-migration.js";

const tempRoots: string[] = [];

async function createTempRoot(label: string): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  tempRoots.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  return { root, env };
}

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const AVATAR_BODY = Buffer.from([1, 2, 3]);
const AVATAR_DATA_URL = `data:image/png;base64,${AVATAR_BODY.toString("base64")}`;

async function createAgentWorkspace(
  root: string,
  agentId: string,
  options: { identityAvatar?: string } = {},
): Promise<string> {
  const workspace = path.join(root, `${agentId}-workspace`);
  await fs.mkdir(workspace, { recursive: true });
  const lines = ["# IDENTITY.md - Agent Identity", "", `- Name: ${agentId}`, ""];
  if (options.identityAvatar !== undefined) {
    lines.push(`- Avatar: ${options.identityAvatar}`);
  }
  await fs.writeFile(path.join(workspace, "IDENTITY.md"), `${lines.join("\n")}\n`);
  return workspace;
}

describe("avatar file migration", () => {
  it("decodes config and IDENTITY.md base64 avatars and archives the original identity file", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-");
    const workspace = await createAgentWorkspace(root, "main", {
      identityAvatar: AVATAR_DATA_URL,
    });
    const config: OpenClawConfig = {
      agents: {
        entries: {
          main: { workspace, identity: { name: "main", avatar: AVATAR_DATA_URL } },
        },
      },
    };

    const findings = await collectAvatarFileMigrationFindings(config, env);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: "warning",
      target: "main",
      fixHint: expect.stringContaining("openclaw doctor --fix"),
    });

    const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
    expect(result.warnings).toEqual([]);
    expect(result.fileChanges).toHaveLength(1);
    expect(result.configChanges).toHaveLength(1);
    expect(await fs.readFile(path.join(workspace, "avatars", "main.png"))).toEqual(AVATAR_BODY);
    expect(config.agents?.entries?.main?.identity?.avatar).toBe("avatars/main.png");
    const identity = await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8");
    expect(identity).toContain("- Avatar: avatars/main.png");
    expect(identity).not.toContain("data:image");
    expect(identity).toContain("- Name: main");

    const archiveDir = path.join(env.OPENCLAW_STATE_DIR!, "backups", "avatar-file-migration");
    const archives = await fs.readdir(archiveDir);
    expect(archives).toHaveLength(1);
    expect(await fs.readFile(path.join(archiveDir, archives[0]!), "utf8")).toContain(
      AVATAR_DATA_URL,
    );

    const rerun = await migrateAgentAvatarFilesToWorkspaces({ config, env });
    expect(rerun.fileChanges).toEqual([]);
    expect(rerun.configChanges).toEqual([]);
    expect(rerun.warnings).toEqual([]);
    expect(await collectAvatarFileMigrationFindings(config, env)).toEqual([]);
  });

  it("migrates IDENTITY.md-only base64 avatars without inventing config values", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-file-only-");
    const workspace = await createAgentWorkspace(root, "writer", {
      identityAvatar: AVATAR_DATA_URL,
    });
    const config: OpenClawConfig = {
      agents: { entries: { writer: { workspace, identity: { name: "writer" } } } },
    };

    const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
    expect(result.warnings).toEqual([]);
    expect(result.configChanges).toEqual([]);
    expect(await fs.readFile(path.join(workspace, "avatars", "writer.png"))).toEqual(AVATAR_BODY);
    expect(config.agents?.entries?.writer?.identity?.avatar).toBeUndefined();
    expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toContain(
      "- Avatar: avatars/writer.png",
    );
  });

  it("leaves a configured http avatar untouched even when IDENTITY.md still holds base64", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-http-");
    const workspace = await createAgentWorkspace(root, "remote", {
      identityAvatar: AVATAR_DATA_URL,
    });
    const remoteAvatar = "https://example.test/avatar.png";
    const config: OpenClawConfig = {
      agents: { entries: { remote: { workspace, identity: { avatar: remoteAvatar } } } },
    };

    const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
    expect(result.warnings).toEqual([]);
    expect(result.configChanges).toEqual([]);
    expect(config.agents?.entries?.remote?.identity?.avatar).toBe(remoteAvatar);
    expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toContain(
      "- Avatar: avatars/remote.png",
    );
  });

  it("migrates legacy agents.list rosters", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-list-");
    const workspace = await createAgentWorkspace(root, "legacy", {
      identityAvatar: AVATAR_DATA_URL,
    });
    const config = {
      agents: {
        list: [{ id: "legacy", workspace, identity: { avatar: AVATAR_DATA_URL } }],
      },
    } as unknown as OpenClawConfig;

    const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
    expect(result.warnings).toEqual([]);
    expect(result.configChanges).toHaveLength(1);
    expect(
      (config.agents as { list?: { identity?: { avatar?: string } }[] }).list?.[0]?.identity
        ?.avatar,
    ).toBe("avatars/legacy.png");
  });

  it("keeps original values when the avatar cannot be decoded", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-invalid-");
    const workspace = await createAgentWorkspace(root, "broken");
    const oversized = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}`;
    const config: OpenClawConfig = {
      agents: { entries: { broken: { workspace, identity: { avatar: oversized } } } },
    };

    const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
    expect(result.fileChanges).toEqual([]);
    expect(result.configChanges).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/was not migrated: .*exceeds/u);
    expect(config.agents?.entries?.broken?.identity?.avatar).toBe(oversized);
    expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).not.toContain(
      "avatars/broken.png",
    );
  });

  it("keeps original values when the workspace cannot receive the image file", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-unwritable-");
    const workspace = await createAgentWorkspace(root, "locked", {
      identityAvatar: AVATAR_DATA_URL,
    });
    await fs.chmod(workspace, 0o500);
    const config: OpenClawConfig = {
      agents: { entries: { locked: { workspace, identity: { avatar: AVATAR_DATA_URL } } } },
    };

    try {
      const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
      expect(result.fileChanges).toEqual([]);
      expect(result.configChanges).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/was not migrated: /u);
      expect(config.agents?.entries?.locked?.identity?.avatar).toBe(AVATAR_DATA_URL);
      expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toContain(
        AVATAR_DATA_URL,
      );
    } finally {
      await fs.chmod(workspace, 0o700);
    }
  });
});
