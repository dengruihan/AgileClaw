import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { readInstalledSkill, searchInstalledSkills } from "../../agents/installed-skill-catalog.js";
import { prepareInstalledSkillCatalog } from "../../agents/installed-skill-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { parseSkillsPromptCatalog } from "../loading/skill-prompt-catalog.js";
import { buildSkillSnapshot } from "../loading/workspace-skill-prompt.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";
import { resolveSkillsWatchSourceRoots } from "../runtime/refresh-source-roots.js";
import { isSkillDiscoveryFileWatchPath } from "../runtime/refresh-watch-path.js";
import { resolveExperienceRoot } from "./experience-root.js";

// mock-isolation: keep host plugin roots out of the prompt snapshot fixture.
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
}));

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

async function writeFile(filePath: string, content: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

async function fixture(params?: { skillName?: string; skillDirName?: string }) {
  const root = await tempDirs.make("openclaw-experience-discovery-");
  const workspaceDir = path.join(root, "workspace");
  const agentDir = path.join(root, "agents", "main", "agent");
  const config: OpenClawConfig = { agents: { entries: { main: { agentDir } } } };
  await writeFile(
    path.join(agentDir, "experience", "draft-release-notes", "EXPERIENCE.md"),
    [
      "---",
      'name: "Draft release notes"',
      'description: "How this agent drafts release notes."',
      "---",
      "",
      "# Draft release notes",
      "",
      "Collect merged changes before writing.",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(
      workspaceDir,
      "skills",
      params?.skillDirName ?? params?.skillName ?? "release-helper",
      "SKILL.md",
    ),
    [
      "---",
      `name: "${params?.skillName ?? "release-helper"}"`,
      'description: "A workspace skill."',
      "---",
      "",
      "Workspace instructions.",
      "",
    ].join("\n"),
  );
  return { root, workspaceDir, agentDir, config };
}

async function buildSnapshot(workspaceDir: string, config: OpenClawConfig) {
  return await buildSkillSnapshot(workspaceDir, {
    config,
    agentId: "main",
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: path.join(workspaceDir, ".bundled"),
  });
}

describe("Experience discovery through the Skill owner", () => {
  it("lists Experience documents beside skills and distinguishes them in the prompt catalog", async () => {
    const { workspaceDir, config, agentDir } = await fixture();
    const snapshot = await buildSnapshot(workspaceDir, config);

    const catalog = parseSkillsPromptCatalog(snapshot.prompt);
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Draft release notes", kind: "experience" }),
        expect.objectContaining({ name: "release-helper", kind: "skill" }),
      ]),
    );
    const experienceEntry = snapshot.discoverySkills?.find(
      (skill) => skill.name === "Draft release notes",
    );
    expect(experienceEntry).toMatchObject({
      documentKind: "experience",
      source: "openclaw-experience",
      filePath: path.join(agentDir, "experience", "draft-release-notes", "EXPERIENCE.md"),
    });
    expect(
      resolveCodeModeSkills({
        skillsPrompt: snapshot.prompt,
        candidates: snapshot.discoverySkills ?? [],
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Draft release notes", kind: "experience" }),
      ]),
    );
  });

  it("serves Experience bodies on demand through the existing search/read tools", async () => {
    const { workspaceDir, config } = await fixture();
    const snapshot = await buildSnapshot(workspaceDir, config);
    const catalog = prepareInstalledSkillCatalog({
      snapshot,
      workspaceDir,
      assertCurrent: () => {},
    });
    const experience = catalog.find((skill) => skill.name === "Draft release notes");
    expect(experience?.kind).toBe("experience");

    const search = await searchInstalledSkills(catalog, "draft release notes", 5);
    expect(search.skills[0]).toMatchObject({
      name: "Draft release notes",
      kind: "experience",
    });
    expect(await readInstalledSkill(catalog, "Draft release notes")).toContain(
      "Collect merged changes",
    );
  });

  it("keeps a namesake Skill authoritative instead of loading a duplicate Experience", async () => {
    const { workspaceDir, config } = await fixture({
      skillName: "Draft release notes",
      skillDirName: "draft-release-notes",
    });
    const snapshot = await buildSnapshot(workspaceDir, config);
    const entries = snapshot.discoverySkills?.filter(
      (skill) => skill.name === "Draft release notes",
    );
    expect(entries).toHaveLength(1);
    expect(entries?.[0]?.source).toBe("openclaw-workspace");
    expect(entries?.[0]?.documentKind).toBeUndefined();
  });

  it("watches the agent Experience root and EXPERIENCE.md refresh paths", async () => {
    const { workspaceDir, config, agentDir } = await fixture();
    const roots = resolveSkillsWatchSourceRoots(
      workspaceDir,
      config,
      "main",
      undefined,
      undefined,
      resolveWorkspaceSkillSourcePlan(workspaceDir, { config, agentId: "main" }),
    );
    expect(roots.baseRoots).toEqual(
      expect.arrayContaining([
        { path: resolveExperienceRoot(config, "main"), source: "openclaw-experience" },
      ]),
    );
    expect(
      isSkillDiscoveryFileWatchPath(
        path.join(agentDir, "experience", "draft-release-notes", "EXPERIENCE.md"),
      ),
    ).toBe(true);
  });
});
