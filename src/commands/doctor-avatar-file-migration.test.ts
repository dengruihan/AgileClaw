import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentAvatarStoragePath } from "../agents/identity-avatar-upload.js";
import { registerAgentWorkspaceAccess } from "../agents/workspace-access.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectAvatarFileMigrationFindings,
  migrateAgentAvatarFilesToWorkspaces,
} from "./doctor-avatar-file-migration.js";

const archiveHooks = vi.hoisted(() => ({
  afterPublish: undefined as (() => void | Promise<void>) | undefined,
}));

vi.mock("../infra/directory-durability.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/directory-durability.js")>();
  return {
    ...actual,
    publishFileNoClobber: async (...args: Parameters<typeof actual.publishFileNoClobber>) => {
      const result = await actual.publishFileNoClobber(...args);
      await archiveHooks.afterPublish?.();
      return result;
    },
  };
});

const tempRoots: string[] = [];

async function createTempRoot(label: string): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  tempRoots.push(root);
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  return { root, env };
}

afterEach(async () => {
  archiveHooks.afterPublish = undefined;
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const AVATAR_BODY = Buffer.from([1, 2, 3]);
const AVATAR_DATA_URL = `data:image/png;base64,${AVATAR_BODY.toString("base64")}`;
const avatarSource = (agentId: string) => agentAvatarStoragePath(agentId, "png", AVATAR_BODY);

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
    expect(await fs.readFile(path.join(workspace, avatarSource("main")))).toEqual(AVATAR_BODY);
    expect(config.agents?.entries?.main?.identity?.avatar).toBe(avatarSource("main"));
    const identity = await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8");
    expect(identity).toContain(`- Avatar: ${avatarSource("main")}`);
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

  it("migrates remote IDENTITY.md through the workspace bridge and archives its bytes", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-remote-");
    const workspace = path.join(root, "remote-workspace");
    const original = `# IDENTITY.md - Agent Identity\n\n- Name: remote\n- Avatar: ${AVATAR_DATA_URL}\n`;
    const files = new Map<string, Buffer>([
      [path.posix.join("IDENTITY.md"), Buffer.from(original)],
    ]);
    const writes: string[] = [];
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: async ({ filePath }) => {
          const value = files.get(filePath);
          if (!value) {
            throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
          }
          return value;
        },
        writeFile: async ({ filePath, data }) => {
          writes.push(filePath);
          files.set(filePath, Buffer.from(data));
        },
        stat: async () => null,
      },
    });
    const config: OpenClawConfig = {
      agents: {
        entries: { remote: { workspace, identity: { avatar: AVATAR_DATA_URL } } },
      },
    };
    try {
      expect(await collectAvatarFileMigrationFindings(config, env)).toHaveLength(1);
      const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
      expect(result.warnings).toEqual([]);
      expect(result.fileChanges).toHaveLength(1);
      expect(config.agents?.entries?.remote?.identity?.avatar).toBe(avatarSource("remote"));
      expect(files.get(avatarSource("remote"))).toEqual(AVATAR_BODY);
      expect(files.get("IDENTITY.md")?.toString("utf8")).toContain(
        `- Avatar: ${avatarSource("remote")}`,
      );
      expect(writes).toEqual([avatarSource("remote"), "IDENTITY.md"]);

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
      expect(writes).toEqual([avatarSource("remote"), "IDENTITY.md"]);
      expect(await fs.readdir(archiveDir)).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("keeps config and remote IDENTITY.md when the bridge cannot rewrite the identity", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-remote-fail-");
    const workspace = path.join(root, "remote-workspace");
    const original = `- Name: remote\n- Avatar: ${AVATAR_DATA_URL}\n`;
    const files = new Map<string, Buffer>([["IDENTITY.md", Buffer.from(original)]]);
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: async ({ filePath }) => {
          const value = files.get(filePath);
          if (!value) {
            throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
          }
          return value;
        },
        writeFile: async ({ filePath, data }) => {
          if (filePath === "IDENTITY.md") {
            throw new Error("remote identity write refused");
          }
          files.set(filePath, Buffer.from(data));
        },
        stat: async () => null,
      },
    });
    const config: OpenClawConfig = {
      agents: {
        entries: { remote: { workspace, identity: { avatar: AVATAR_DATA_URL } } },
      },
    };
    try {
      const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
      expect(result.fileChanges).toEqual([]);
      expect(result.configChanges).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(/was not migrated: .*remote identity write refused/u);
      expect(config.agents?.entries?.remote?.identity?.avatar).toBe(AVATAR_DATA_URL);
      expect(files.get("IDENTITY.md")?.toString("utf8")).toBe(original);
    } finally {
      release();
    }
  });

  it("leaves every source unchanged and keeps an error finding when remote IDENTITY.md is unreadable", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-remote-unreadable-");
    const workspace = path.join(root, "remote-workspace");
    const writeFile = vi.fn(async () => {
      throw new Error("unexpected write");
    });
    const release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
        writeFile,
        stat: async () => null,
      },
    });
    const config: OpenClawConfig = {
      agents: {
        entries: { remote: { workspace, identity: { avatar: AVATAR_DATA_URL } } },
      },
    };
    try {
      const findings = await collectAvatarFileMigrationFindings(config, env);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ severity: "error", target: "remote" });
      expect(findings[0]?.message).toMatch(
        /IDENTITY\.md could not be inspected: .*permission denied/u,
      );

      const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
      expect(result.fileChanges).toEqual([]);
      expect(result.configChanges).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(
        /was not migrated: IDENTITY\.md could not be read \(.*permission denied\)/u,
      );
      expect(config.agents?.entries?.remote?.identity?.avatar).toBe(AVATAR_DATA_URL);
      expect(writeFile).not.toHaveBeenCalled();

      const rerun = await migrateAgentAvatarFilesToWorkspaces({ config, env });
      expect(rerun.warnings).toHaveLength(1);
      expect(await collectAvatarFileMigrationFindings(config, env)).toHaveLength(1);
    } finally {
      release();
    }
  });

  it("refuses to write a remote identity through a replaced workspace binding", async () => {
    const { root, env } = await createTempRoot("openclaw-avatar-migrate-remote-swap-");
    const workspace = path.join(root, "remote-workspace");
    const original = `- Name: remote\n- Avatar: ${AVATAR_DATA_URL}\n`;
    const firstFiles = new Map<string, Buffer>([["IDENTITY.md", Buffer.from(original)]]);
    const firstWrites: string[] = [];
    let releaseFirst: (() => void) | undefined = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: async ({ filePath }) => {
          const value = firstFiles.get(filePath);
          if (!value) {
            throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
          }
          return value;
        },
        writeFile: async ({ filePath, data }) => {
          firstWrites.push(filePath);
          firstFiles.set(filePath, Buffer.from(data));
        },
        stat: async () => null,
      },
    });
    const secondFiles = new Map<string, Buffer>();
    const secondWrites: string[] = [];
    let releaseSecond: (() => void) | undefined;
    archiveHooks.afterPublish = () => {
      releaseFirst?.();
      releaseFirst = undefined;
      releaseSecond = registerAgentWorkspaceAccess(workspace, {
        bridge: {
          readFile: async ({ filePath }) => {
            const value = secondFiles.get(filePath);
            if (!value) {
              throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
            }
            return value;
          },
          writeFile: async ({ filePath, data }) => {
            secondWrites.push(filePath);
            secondFiles.set(filePath, Buffer.from(data));
          },
          stat: async () => null,
        },
      });
    };
    const config: OpenClawConfig = {
      agents: { entries: { remote: { workspace, identity: {} } } },
    };
    try {
      const result = await migrateAgentAvatarFilesToWorkspaces({ config, env });
      expect(result.configChanges).toEqual([]);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toMatch(
        /Workspace access changed after the Agent identity was archived/u,
      );
      expect(secondWrites).toEqual([]);
      expect(firstFiles.get("IDENTITY.md")?.toString("utf8")).toBe(original);
    } finally {
      releaseSecond?.();
      releaseFirst?.();
    }
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
    expect(await fs.readFile(path.join(workspace, avatarSource("writer")))).toEqual(AVATAR_BODY);
    expect(config.agents?.entries?.writer?.identity?.avatar).toBeUndefined();
    expect(await fs.readFile(path.join(workspace, "IDENTITY.md"), "utf8")).toContain(
      `- Avatar: ${avatarSource("writer")}`,
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
      `- Avatar: ${avatarSource("remote")}`,
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
    ).toBe(avatarSource("legacy"));
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
      avatarSource("broken"),
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
