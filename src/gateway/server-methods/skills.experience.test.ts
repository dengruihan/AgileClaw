import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExperienceRoot } from "../../skills/experience/experience-root.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { skillsExperienceHandlers } from "./skills-experience.js";
import { callGatewayHandler } from "./skills.test-helpers.js";

const tempDirs = createTrackedTempDirs();
const mocks = vi.hoisted(() => ({ workspaceDir: "" }));

// mock-isolation: pin the single test agent and its temp workspace without gateway state.
vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
  resolveDefaultAgentId: () => "main",
  resolveAgentWorkspaceDir: () => mocks.workspaceDir,
}));

// mock-isolation: the handler reads runtime config from the injected test context only.
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  resetConfigRuntimeState: () => undefined,
  writeConfigFile: vi.fn(),
}));

afterEach(async () => {
  await tempDirs.cleanup();
});

async function fixture() {
  const root = await tempDirs.make("openclaw-experience-gateway-");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  mocks.workspaceDir = workspaceDir;
  const config = {
    agents: { entries: { main: { agentDir: path.join(root, "agents", "main", "agent") } } },
  } as never;
  const context = { getRuntimeConfig: () => config } as never;
  const call = (method: string, params: Record<string, unknown>) =>
    callGatewayHandler(skillsExperienceHandlers, method, params, { context });
  return { root, workspaceDir, config, call };
}

describe("skills.experience gateway methods", () => {
  it("creates, lists, reads, updates, retires, and restores an agent-scoped document", async () => {
    const { call, config } = await fixture();
    const created = await call("skills.experience.create", {
      agentId: "main",
      name: "Release checklist",
      description: "Checklist for release notes.",
      content: "1. Collect merged changes.\n",
      capture: "manual",
    });
    expect(created.ok).toBe(true);
    const createdRecord = (created.response as { record: { id: string; revisionHash: string } })
      .record;
    expect(createdRecord.id).toBe("release-checklist");

    const listed = await call("skills.experience.list", { agentId: "main" });
    expect(listed.response).toMatchObject({
      schema: "openclaw.skill-workshop.experiences-manifest.v1",
      counts: { active: 1, promoted: 0, retired: 0 },
    });

    const read = await call("skills.experience.read", {
      agentId: "main",
      id: "release-checklist",
    });
    expect(read.response).toMatchObject({
      content: "1. Collect merged changes.\n",
      record: { name: "Release checklist", status: "active" },
    });
    const revisionHash = (read.response as { revisionHash: string }).revisionHash;

    await expect(
      fs.readFile(
        path.join(resolveExperienceRoot(config, "main"), "release-checklist", "EXPERIENCE.md"),
        "utf8",
      ),
    ).resolves.toContain('name: "Release checklist"');

    const updated = await call("skills.experience.update", {
      agentId: "main",
      id: "release-checklist",
      expectedRevisionHash: revisionHash,
      content: "1. Collect merged changes.\n2. Verify the build.\n",
    });
    expect(updated.ok).toBe(true);
    const updatedHash = (updated.response as { revisionHash: string }).revisionHash;

    const conflict = await call("skills.experience.update", {
      agentId: "main",
      id: "release-checklist",
      expectedRevisionHash: revisionHash,
      content: "Stale write.\n",
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error).toMatchObject({
      details: {
        code: "SKILL_EXPERIENCE_REVISION_CHANGED",
        currentRevisionHash: updatedHash,
      },
    });

    const retired = await call("skills.experience.retire", {
      agentId: "main",
      id: "release-checklist",
      expectedRevisionHash: updatedHash,
      reason: "Superseded",
    });
    expect(retired.response).toMatchObject({
      record: { status: "retired", retireReason: "Superseded" },
    });
    expect((await call("skills.experience.list", { agentId: "main" })).response).toMatchObject({
      counts: { active: 0, promoted: 0, retired: 1 },
    });

    const restored = await call("skills.experience.restore", {
      agentId: "main",
      id: "release-checklist",
    });
    expect(restored.response).toMatchObject({
      record: { status: "active" },
    });
  });

  it("validates params and refuses unknown agents", async () => {
    const { call } = await fixture();
    expect((await call("skills.experience.read", { id: "" })).ok).toBe(false);
    expect((await call("skills.experience.list", { agentId: "ghost" })).error).toMatchObject({
      message: expect.stringContaining("unknown agent id"),
    });
  });
});
