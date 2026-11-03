import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SkillWorkshopProposalMutationBudget } from "../../skills/workshop/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSkillWorkshopTool } from "./skill-workshop-tool.js";

let testState: OpenClawTestState = undefined as never;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-experience-tool-",
  });
});

afterEach(async () => {
  await testState.cleanup();
});

function buildTool(options: { proposalOnly?: boolean; updateProposals?: boolean } = {}) {
  const agentDir = path.join(testState.stateDir, "agents", "main", "agent");
  return createSkillWorkshopTool({
    workspaceDir: testState.workspaceDir,
    config: { agents: { entries: { main: { agentDir } } } },
    env: testState.env,
    agentId: "main",
    ...options,
  });
}

function text(result: Awaited<ReturnType<ReturnType<typeof buildTool>["execute"]>>) {
  const block = result.content?.find((entry) => entry.type === "text");
  return block && "text" in block ? block.text : "";
}

describe("skill_workshop Experience actions", () => {
  it("captures, lists, reads, and updates an Experience without a new tool", async () => {
    const tool = buildTool();
    const captured = await tool.execute("call-capture", {
      action: "experience_capture",
      name: "Release checklist",
      description: "How this agent prepares release notes.",
      experience_content: "1. Collect merged changes.\n",
      evidence: "Verified in this session.",
    });
    expect(text(captured)).toContain("Captured Experience release-checklist");
    const capturedDetails = captured.details as { id: string; created: boolean };
    expect(capturedDetails).toMatchObject({ id: "release-checklist", created: true });

    const listed = await tool.execute("call-list", { action: "experience_list" });
    expect(text(listed)).toContain("- release-checklist [active] Release checklist");
    expect(text(listed)).toContain("Experiences: 1 active");

    const read = await tool.execute("call-read", {
      action: "experience_read",
      experience_id: "release-checklist",
    });
    expect(text(read)).toContain("1. Collect merged changes.");
    expect(text(read)).toContain("Revision: ");
    const revisionHash = (read.details as { revisionHash: string }).revisionHash;

    const updated = await tool.execute("call-update", {
      action: "experience_update",
      experience_id: "release-checklist",
      expected_experience_hash: revisionHash,
      experience_content: "1. Collect merged changes.\n2. Verify the build.\n",
    });
    expect(text(updated)).toContain("Updated Experience release-checklist");
    expect((updated.details as { revisionHash: string }).revisionHash).not.toBe(revisionHash);
  });

  it("bounds automatic capture to one document per run and requires a read hash", async () => {
    const budget: SkillWorkshopProposalMutationBudget = { remaining: 1 };
    const tool = buildTool({ proposalOnly: true, updateProposals: true });
    const toolWithBudget = createSkillWorkshopTool({
      workspaceDir: testState.workspaceDir,
      config: {
        agents: {
          entries: { main: { agentDir: path.join(testState.stateDir, "agents", "main", "agent") } },
        },
      },
      env: testState.env,
      agentId: "main",
      proposalOnly: true,
      updateProposals: true,
      proposalMutationBudget: budget,
    });

    await toolWithBudget.execute("call-capture", {
      action: "experience_capture",
      name: "First note",
      description: "First note.",
      experience_content: "Body.\n",
    });
    await expect(
      toolWithBudget.execute("call-capture", {
        action: "experience_capture",
        name: "Second note",
        description: "Second note.",
        experience_content: "Body.\n",
      }),
    ).rejects.toThrow("already captured one Experience");
    expect(budget.experienceCaptureUsed).toBe(true);

    await expect(
      tool.execute("call-update", {
        action: "experience_update",
        experience_id: "first-note",
        experience_content: "No hash.\n",
      }),
    ).rejects.toThrow("expected_experience_hash");
  });

  it("keeps Experience reads and captures available to draft-only reviews but not edits", async () => {
    const tool = buildTool({ proposalOnly: true, updateProposals: false });
    await tool.execute("call-capture", {
      action: "experience_capture",
      name: "Review note",
      description: "Review note.",
      experience_content: "Body.\n",
    });
    await expect(
      tool.execute("call-update", {
        action: "experience_update",
        experience_id: "review-note",
        expected_experience_hash: "a".repeat(64),
        experience_content: "Edited.\n",
      }),
    ).rejects.toThrow("allows only");
  });
});
