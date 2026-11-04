import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveCodeModeSkills, readCodeModeSkill } from "../../agents/code-mode-skills.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadWorkspaceSkills } from "../../skills/loading/workspace-skill-loader.js";
import { buildSkillSnapshot } from "../../skills/loading/workspace-skill-prompt.js";
import { transferSkillResources } from "./skill-resource-transfer.js";
import { createSshSpawnTunnel } from "./skill-resource-transfer.test-support.js";

// mock-isolation: keep host plugin roots out of the agent-root discovery fixture.
vi.mock("../../skills/loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

const temps = useAutoCleanupTempDirTracker(afterEach);

describe("remote-exec Experience resources", () => {
  it("transfers Experience resources with the EXPERIENCE.md instruction identity", async () => {
    const workspace = await fs.realpath(temps.make("remote-experience-source-"));
    const agentDir = temps.make("remote-experience-agent-");
    const config: OpenClawConfig = { agents: { entries: { main: { agentDir } } } };
    const baseDir = path.join(agentDir, "experience", "draft-release-notes");
    await fs.mkdir(baseDir, { recursive: true });
    const filePath = path.join(baseDir, "EXPERIENCE.md");
    await fs.writeFile(
      filePath,
      '---\nname: "Draft release notes"\ndescription: "How this agent drafts release notes."\n---\n\nCollect merged changes first.\n',
    );
    const entries = loadWorkspaceSkills(workspace, {
      config,
      agentId: "main",
      managedSkillsDir: path.join(workspace, ".managed"),
      bundledSkillsDir: path.join(workspace, ".bundled"),
    });
    const snapshot = await buildSkillSnapshot(workspace, { entries, config, agentId: "main" });
    const transport = createSshSpawnTunnel();
    const resources = await transferSkillResources({
      tunnel: transport,
      remoteWorkspaceDir: await fs.realpath(temps.make("remote-experience-workspace-")),
      assertCurrent: () => {},
      snapshot,
    });
    expect(resources).toBeDefined();
    const remote = resources!.mounts[0]!.containerPath;
    try {
      expect(remote.startsWith(workspace)).toBe(false);
      expect(await fs.readFile(path.join(remote, "EXPERIENCE.md"), "utf8")).toBe(
        await fs.readFile(filePath, "utf8"),
      );
      const selected = resources!.snapshot.resolvedSkills![0]!;
      expect(selected.documentKind).toBe("experience");
      expect(selected.filePath).toBe(`${remote}/EXPERIENCE.md`);
      expect(resources!.snapshot.prompt).toContain(`<location>${remote}/EXPERIENCE.md</location>`);
      const [codeModeSkill] = resolveCodeModeSkills({
        skillsPrompt: resources!.snapshot.prompt,
        candidates: [selected],
        reader: async () => {
          throw new Error("Paired nodes have no Gateway filesystem bridge");
        },
      });
      expect(codeModeSkill).toMatchObject({ name: "Draft release notes", kind: "experience" });
      expect(await readCodeModeSkill(codeModeSkill!)).toContain("Collect merged changes");
    } finally {
      await resources!.cleanup();
    }
  });
});
