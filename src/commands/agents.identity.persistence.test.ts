import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTempHome, writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { updateAgentConfigEntry } from "../gateway/server-methods/agents-config-mutations.js";
import { VERSION } from "../version.js";
import { agentsSetIdentityCommand } from "./agents.commands.identity.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

async function avatarConfig(home: string): Promise<OpenClawConfig> {
  return {
    meta: {
      lastTouchedVersion: VERSION,
      migrations: { modelPolicyAllowlist: true, utilityModelSeparation: true },
    },
    gateway: { mode: "local" },
    agents: {
      ownership: "explicit",
      entries: {
        avatar: {
          workspace: path.join(home, "workspace"),
          identity: {
            name: "Avatar",
            emoji: "🦉",
            avatar: `https://example.test/${"a".repeat(300)}/avatar.png`,
          },
        },
        other: { workspace: path.join(home, "other"), identity: { name: "Other" } },
      },
    },
  };
}

describe("agent identity persistence", () => {
  it.each(["cli", "gateway"] as const)(
    "%s persists a smaller avatar without changing other fields",
    async (owner) => {
      await withTempHome(async (home) => {
        const before = await avatarConfig(home);
        const configPath = await writeOpenClawConfig(home, before);
        const avatar = "https://example.test/avatar.png";
        if (owner === "cli") {
          await agentsSetIdentityCommand({ agent: "avatar", avatar }, createThrowingTestRuntime());
        } else {
          await updateAgentConfigEntry({ agentId: "avatar", identity: { avatar } });
        }
        const expected = structuredClone(before);
        expected.agents!.entries!.avatar!.identity!.avatar = avatar;
        expect(JSON.parse(await fs.readFile(configPath, "utf8"))).toEqual(expected);
      });
    },
  );

  it.each(["cli", "gateway"] as const)(
    "%s rejects a base64 data URI avatar with migration guidance",
    async (owner) => {
      await withTempHome(async (home) => {
        const before = await avatarConfig(home);
        const configPath = await writeOpenClawConfig(home, before);
        const original = await fs.readFile(configPath, "utf8");
        const dataUrl = `data:image/png;base64,${Buffer.from("avatar").toString("base64")}`;
        if (owner === "cli") {
          await expect(
            agentsSetIdentityCommand(
              { agent: "avatar", avatar: dataUrl },
              createThrowingTestRuntime(),
            ),
          ).rejects.toThrow(/cannot use a base64 data URI/);
        } else {
          await expect(
            updateAgentConfigEntry({ agentId: "avatar", identity: { avatar: dataUrl } }),
          ).rejects.toThrow(/no longer accepts base64 data URIs/);
        }
        expect(await fs.readFile(configPath, "utf8")).toBe(original);
      });
    },
  );

  it("rejects a model-only size drop and retains the authored configuration", async () => {
    await withTempHome(async (home) => {
      const before = await avatarConfig(home);
      before.agents!.entries!.avatar!.identity!.avatar = "https://example.test/avatar.png";
      before.agents!.entries!.avatar!.model = {
        primary: "openai/gpt-5.4-mini",
        fallbacks: Array.from({ length: 500 }, () => "openai/gpt-5.4-mini"),
      };
      const configPath = await writeOpenClawConfig(home, before);
      const original = await fs.readFile(configPath, "utf8");
      await expect(
        updateAgentConfigEntry({ agentId: "avatar", model: null }),
      ).rejects.toMatchObject({
        code: "CONFIG_WRITE_REJECTED",
        reasons: [expect.stringMatching(/^size-drop:/)],
      });
      expect(await fs.readFile(configPath, "utf8")).toBe(original);
    });
  });
});
