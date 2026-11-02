import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { agentAvatarStoragePath } from "../../agents/identity-avatar-upload.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import * as workspaceOwner from "../../agents/workspace.js";
import * as configBackup from "../../config/backup-rotation.js";
import { clearRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as fsSafe from "../../infra/fs-safe.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { agentsHandlers } from "./agents.js";
import type { GatewayClient } from "./client-types.js";

const inlineAvatar = "data:image/png;base64,AQID";
const inlineAvatarBody = Buffer.from([1, 2, 3]);
const originalIdentity = "# Identity\n\n- Name: Existing\n\nKeep these notes.\n";
let state: OpenClawTestState;
let config: OpenClawConfig;
let workspace: string;
let identityPath: string;
let serial = 0;
const context = createDirectChatContext({
  getRuntimeConfig: () => config,
  getCommittedRuntimeConfig: () => config,
});
const client: GatewayClient = {
  connId: "avatar-policy-client",
  connect: {
    minProtocol: 1,
    maxProtocol: 1,
    client: { id: "test", version: "1", platform: "test", mode: "test" },
  },
};
const avatarSourceFor = (method: "agents.create" | "agents.update") =>
  agentAvatarStoragePath(
    method === "agents.update" ? "existing" : "new-avatar-agent",
    "png",
    inlineAvatarBody,
  );
const avatarPathFor = (method: "agents.create" | "agents.update") =>
  path.join(workspace, avatarSourceFor(method));
function disableUploads() {
  config = { ...config, gateway: { uploads: { enabled: false } } };
}
async function call(
  method: "agents.create" | "agents.update",
  fields: Record<string, unknown> = { avatar: inlineAvatar },
  requester = client,
) {
  const respond = vi.fn();
  const params = {
    ...(method === "agents.create"
      ? { name: "New Avatar Agent", workspace }
      : { agentId: "existing" }),
    ...fields,
  };
  await agentsHandlers[method]!({
    req: { type: "req", id: "avatar-policy", method, params },
    params,
    context,
    respond,
    client: requester,
    isWebchatConnect: () => false,
  });
  return respond;
}
function expectDisabled(respond: ReturnType<typeof vi.fn>) {
  expect
    .soft(respond)
    .toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "FORBIDDEN", details: { code: "UPLOADS_DISABLED" } }),
    );
}
async function expectMaterializedAvatar(method: "agents.create" | "agents.update") {
  expect(await fs.readFile(avatarPathFor(method))).toEqual(inlineAvatarBody);
}

beforeAll(async () => {
  state = await createOpenClawTestState({ layout: "state-only", label: "agent-avatar-policy" });
});
afterAll(async () => {
  await state.cleanup();
});
afterEach(() => {
  vi.restoreAllMocks();
});
beforeEach(async () => {
  clearRuntimeConfigSnapshot();
  workspace = state.path("workspace-" + ++serial);
  identityPath = path.join(workspace, "IDENTITY.md");
  await fs.mkdir(workspace);
  await fs.writeFile(identityPath, originalIdentity);
  config = {
    gateway: { uploads: { enabled: true } },
    agents: {
      entries: { existing: { workspace, identity: { name: "Existing" } } },
    },
  };
  await state.writeConfig(config);
  // Workspace bootstrap has its own authority tests. Keep this boundary fixture on
  // the existing, already-hatched workspace and the real identity/config writers.
  vi.spyOn(workspaceOwner, "ensureAgentWorkspace").mockImplementation(async () => ({
    dir: workspace,
    identityPathCreated: false,
    bootstrapPending: false,
  }));
});

it.each([
  { method: "agents.create", stage: "identity-read" },
  { method: "agents.update", stage: "identity-read" },
  { method: "agents.create", stage: "config" },
  { method: "agents.update", stage: "config" },
  { method: "agents.create", stage: "unpublished-config" },
  { method: "agents.update", stage: "remote-write" },
] as const)(
  "$method rechecks upload admission at $stage and settles admitted bytes",
  async ({ method, stage }) => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const pause = async () => {
      entered.resolve();
      await resume.promise;
    };
    let release: (() => void) | undefined;
    const writeFile = vi.fn(async (params: { filePath: string; data: string | Uint8Array }) => {
      const destination =
        params.filePath === "IDENTITY.md" ? identityPath : path.join(workspace, params.filePath);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, params.data);
      if (params.filePath === "IDENTITY.md") {
        await pause();
      }
    });
    if (stage === "identity-read") {
      const realRoot = fsSafe.root;
      vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const handle = await realRoot(...args);
        if (args[0] === workspace) {
          const read = handle.read.bind(handle);
          let pausedOnce = false;
          vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
            // Pause before the identity bytes are accepted, then revoke uploads.
            if (!pausedOnce) {
              pausedOnce = true;
              await pause();
            }
            return await read(...readArgs);
          });
        }
        return handle;
      });
    } else if (stage === "config" || stage === "unpublished-config") {
      if (stage === "unpublished-config") {
        vi.mocked(workspaceOwner.ensureAgentWorkspace).mockResolvedValue({
          dir: workspace,
          identityPathCreated: false,
          bootstrapPending: true,
        });
      }
      const prepare = configBackup.prepareConfigFileWrite;
      vi.spyOn(configBackup, "prepareConfigFileWrite").mockImplementation(async (params) => {
        await pause();
        return await prepare(params);
      });
    } else {
      release = registerAgentWorkspaceAccess(workspace, {
        bridge: {
          readFile: async () => await fs.readFile(identityPath),
          writeFile,
          stat: vi.fn(),
        },
      });
    }
    const originalConfig = await fs.readFile(state.configPath, "utf8");
    const pending = call(method);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error(`handler did not reach ${stage}`);
        }),
      ]);
      const accepted = stage === "config" || stage === "remote-write";
      const admittedIdentity = await fs.readFile(identityPath, "utf8");
      if (accepted) {
        expect(admittedIdentity).toContain(avatarSourceFor(method));
      }
      disableUploads();
      resume.resolve();
      const respond = await pending;
      if (accepted) {
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          true,
          method === "agents.update" ? { ok: true, agentId: "existing" } : expect.anything(),
          undefined,
        );
        const persistedConfig = await fs.readFile(state.configPath, "utf8");
        expect(persistedConfig).toContain(avatarSourceFor(method));
        expect(persistedConfig).not.toContain("data:image");
        expect(await fs.readFile(identityPath, "utf8")).toBe(admittedIdentity);
        await expectMaterializedAvatar(method);
        if (stage === "remote-write") {
          expect(writeFile).toHaveBeenCalledTimes(2);
        }
      } else {
        expectDisabled(respond);
        expect.soft(await fs.readFile(identityPath, "utf8")).toBe(originalIdentity);
        expect.soft(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
        if (stage === "identity-read") {
          // Staged bytes never reach the workspace before the identity is accepted.
          await expect(fs.access(avatarPathFor(method))).rejects.toThrow();
        }
      }
    } finally {
      resume.resolve();
      await pending;
      release?.();
    }
  },
);

it.each(["agents.create", "agents.update"] as const)(
  "%s preserves non-upload identity edits and trusted internal avatar creation",
  async (method) => {
    disableUploads();
    const fields = { avatar: "https://example.test/avatar.png", name: "Text Name" };
    expect(await call(method, fields)).toHaveBeenCalledWith(true, expect.anything(), undefined);
    expect(await fs.readFile(identityPath, "utf8")).toContain(fields.avatar);
    expect(await fs.readFile(identityPath, "utf8")).toContain("Keep these notes.");
    const internal = { ...client, internal: { syntheticClient: true as const } };
    expect(await call(method, { avatar: inlineAvatar }, internal)).toHaveBeenCalledWith(
      true,
      expect.anything(),
      undefined,
    );
    const persistedIdentity = await fs.readFile(identityPath, "utf8");
    expect(persistedIdentity).toContain(avatarSourceFor(method));
    expect(persistedIdentity).not.toContain("data:image");
    expect(await fs.readFile(state.configPath, "utf8")).toContain(avatarSourceFor(method));
    await expectMaterializedAvatar(method);
  },
);

it("decodes avatar uploads into workspace image files and persists only the path", async () => {
  const respond = await call("agents.update");
  expect(respond).toHaveBeenCalledExactlyOnceWith(
    true,
    { ok: true, agentId: "existing" },
    undefined,
  );
  await expectMaterializedAvatar("agents.update");
  expect(await fs.readFile(identityPath, "utf8")).toContain(
    `- Avatar: ${avatarSourceFor("agents.update")}`,
  );
  expect(await fs.readFile(state.configPath, "utf8")).toContain(avatarSourceFor("agents.update"));
});

it("rejects avatar uploads whose data URL cannot be decoded", async () => {
  for (const avatar of [
    "data:image/png;base64,A",
    "data:image/bmp;base64,AQID",
    `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64")}`,
    "data:image/svg+xml,%3Csvg%3E",
  ]) {
    const respond = await call("agents.update", { avatar });
    expect
      .soft(respond)
      .toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    expect.soft(await fs.readFile(identityPath, "utf8")).toBe(originalIdentity);
  }
  await expect(fs.access(path.join(workspace, "avatars"))).rejects.toThrow();
});

it("keeps the existing avatar bytes when agents.create hits the duplicate check", async () => {
  const existingBody = Buffer.from([7, 8, 9]);
  const existingSource = agentAvatarStoragePath("existing", "png", existingBody);
  const existingPath = path.join(workspace, existingSource);
  await fs.mkdir(path.dirname(existingPath), { recursive: true });
  await fs.writeFile(existingPath, existingBody);
  config = {
    ...config,
    agents: {
      entries: {
        existing: { workspace, identity: { name: "Existing", avatar: existingSource } },
      },
    },
  };
  await state.writeConfig(config);
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const identityBefore = await fs.readFile(identityPath, "utf8");

  const respond = await call("agents.create", { name: "Existing", avatar: inlineAvatar });

  expect(respond).toHaveBeenCalledExactlyOnceWith(
    false,
    undefined,
    expect.objectContaining({ code: "INVALID_REQUEST" }),
  );
  expect(await fs.readFile(existingPath)).toEqual(existingBody);
  await expect(fs.access(avatarPathFor("agents.update"))).rejects.toThrow();
  expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
  expect(await fs.readFile(identityPath, "utf8")).toBe(identityBefore);
});

it("keeps the previous avatar bytes and config when an update cannot publish the upload", async () => {
  const previousBody = Buffer.from([4, 5, 6]);
  const previousSource = agentAvatarStoragePath("existing", "png", previousBody);
  const previousPath = path.join(workspace, previousSource);
  await fs.mkdir(path.dirname(previousPath), { recursive: true });
  await fs.writeFile(previousPath, previousBody);
  config = {
    ...config,
    agents: {
      entries: {
        existing: { workspace, identity: { name: "Existing", avatar: previousSource } },
      },
    },
  };
  await state.writeConfig(config);
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const identityBefore = await fs.readFile(identityPath, "utf8");
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: {
      readFile: async () => await fs.readFile(identityPath),
      writeFile: async (params) => {
        if (params.filePath === "IDENTITY.md") {
          await fs.writeFile(identityPath, params.data);
          return;
        }
        throw new Error("workspace storage offline");
      },
      stat: vi.fn(),
    },
  });

  try {
    const respond = await call("agents.update");
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      message: expect.stringContaining("could not save the avatar image"),
    });
    expect(await fs.readFile(previousPath)).toEqual(previousBody);
    expect(await fs.readFile(identityPath, "utf8")).toBe(identityBefore);
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
  } finally {
    release();
  }
});

it("restores IDENTITY.md when the config write fails after the avatar is published", async () => {
  const previousBody = Buffer.from([6, 5, 4]);
  const previousSource = agentAvatarStoragePath("existing", "png", previousBody);
  const previousPath = path.join(workspace, previousSource);
  await fs.mkdir(path.dirname(previousPath), { recursive: true });
  await fs.writeFile(previousPath, previousBody);
  const identityWithStoredAvatar = `# Identity\n\n- Name: Existing\n- Avatar: ${previousSource}\n`;
  await fs.writeFile(identityPath, identityWithStoredAvatar);
  config = {
    ...config,
    agents: {
      entries: {
        existing: { workspace, identity: { name: "Existing", avatar: previousSource } },
      },
    },
  };
  await state.writeConfig(config);
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const prepare = configBackup.prepareConfigFileWrite;
  let failOnce = true;
  vi.spyOn(configBackup, "prepareConfigFileWrite").mockImplementation(async (params) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("config write refused after publish");
    }
    return await prepare(params);
  });

  await expect(call("agents.update")).rejects.toThrow("config write refused after publish");

  expect(await fs.readFile(previousPath)).toEqual(previousBody);
  expect(await fs.readFile(identityPath, "utf8")).toBe(identityWithStoredAvatar);
  expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
});

it("removes a newly created remote IDENTITY.md when the config write fails", async () => {
  await fs.rm(identityPath, { force: true });
  config = {
    ...config,
    agents: {
      entries: { existing: { workspace, identity: { name: "Existing" } } },
    },
  };
  await state.writeConfig(config);
  const originalConfig = await fs.readFile(state.configPath, "utf8");
  const remove = vi.fn(async (params: { filePath: string }) => {
    if (params.filePath === "IDENTITY.md") {
      await fs.rm(identityPath, { force: true });
    }
  });
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: {
      readFile: async ({ filePath }) => {
        try {
          return await fs.readFile(path.join(workspace, filePath));
        } catch {
          throw Object.assign(new Error(`missing ${filePath}`), { code: "ENOENT" });
        }
      },
      writeFile: async ({ filePath, data }) => {
        const destination = path.join(workspace, filePath);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, data);
      },
      remove,
      stat: vi.fn(),
    },
  });
  const prepare = configBackup.prepareConfigFileWrite;
  let failOnce = true;
  vi.spyOn(configBackup, "prepareConfigFileWrite").mockImplementation(async (params) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("config write refused after publish");
    }
    return await prepare(params);
  });

  try {
    await expect(call("agents.update")).rejects.toThrow("config write refused after publish");

    expect(remove).toHaveBeenCalledExactlyOnceWith({ filePath: "IDENTITY.md" });
    await expect(fs.access(identityPath)).rejects.toThrow();
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalConfig);
  } finally {
    release();
  }
});

it("restores the previous IDENTITY.md when the config update is refused", async () => {
  const identityWithStoredAvatar =
    "# Identity\n\n- Name: Existing\n- Avatar: avatars/old-only-copy.png\n\nKeep these notes.\n";
  await fs.writeFile(identityPath, identityWithStoredAvatar);
  config = {
    ...config,
    agents: {
      entries: { existing: { workspace, identity: { name: "Existing" } } },
    },
  };
  await state.writeConfig(config);
  let firstIdentityWrite = true;
  const release = registerAgentWorkspaceAccess(workspace, {
    bridge: {
      readFile: async () => await fs.readFile(identityPath),
      writeFile: async (params) => {
        if (params.filePath !== "IDENTITY.md") {
          return;
        }
        await fs.writeFile(identityPath, params.data);
        if (firstIdentityWrite) {
          firstIdentityWrite = false;
          // The config loses the agent while the identity bytes are in flight.
          await state.writeConfig({ gateway: { uploads: { enabled: true } } });
        }
      },
      stat: vi.fn(),
    },
  });

  try {
    const respond = await call("agents.update");
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(await fs.readFile(identityPath, "utf8")).toBe(identityWithStoredAvatar);
  } finally {
    release();
  }
});
