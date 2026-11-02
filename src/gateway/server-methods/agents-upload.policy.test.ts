import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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
  method === "agents.update" ? "avatars/existing.png" : "avatars/new-avatar-agent.png";
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
  { method: "agents.create", stage: "identity-write" },
  { method: "agents.update", stage: "identity-write" },
  { method: "agents.create", stage: "config" },
  { method: "agents.update", stage: "config" },
  { method: "agents.create", stage: "unpublished-config" },
  { method: "agents.update", stage: "remote-read" },
  { method: "agents.update", stage: "remote-write" },
] as const)(
  "$method rechecks upload admission at $stage and settles accepted bytes",
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
    if (stage === "identity-write") {
      const realRoot = fsSafe.root;
      vi.spyOn(fsSafe, "root").mockImplementation(async (...args) => {
        const handle = await realRoot(...args);
        if (args[0] === workspace) {
          const write = handle.write.bind(handle);
          let pausedOnce = false;
          vi.spyOn(handle, "write").mockImplementation(async (...writeArgs) => {
            // The avatar file write happens before the identity write.
            if (!pausedOnce) {
              pausedOnce = true;
              await pause();
            }
            return await write(...writeArgs);
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
          readFile: async () => {
            if (stage === "remote-read") {
              await pause();
            }
            return await fs.readFile(identityPath);
          },
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
      } else if (stage === "unpublished-config") {
        expect(admittedIdentity).toBe(originalIdentity);
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
        if (stage === "remote-read") {
          // The admitted avatar bytes settled before the revoked identity read.
          expect(writeFile).toHaveBeenCalledTimes(1);
          await expectMaterializedAvatar(method);
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
  expect(await fs.readFile(identityPath, "utf8")).toContain("- Avatar: avatars/existing.png");
  expect(await fs.readFile(state.configPath, "utf8")).toContain("avatars/existing.png");
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
  await expect(fs.access(avatarPathFor("agents.update"))).rejects.toThrow();
});
