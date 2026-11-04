import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import type { SkillProposalReadResult, SkillProposalRecord } from "../workshop/types.js";
import { createExperienceFile, readExperienceFile } from "./experience-document.js";
import { resolveExperienceRoot } from "./experience-root.js";
import { listExperiences, promoteExperience, readExperience } from "./experience-service.js";

const tempDirs = createTrackedTempDirs();
const mocks = vi.hoisted(() => ({
  proposeCreateSkill: vi.fn(),
  proposeUpdateSkill: vi.fn(),
  rejectSkillProposal: vi.fn(),
  listSkillProposals: vi.fn(),
  inspectSkillProposal: vi.fn(),
  prepareWorkspaceSkillEntries: vi.fn(),
}));

// mock-isolation: promotion orchestration is tested against staged proposal results.
vi.mock("../workshop/service.js", () => ({
  proposeCreateSkill: mocks.proposeCreateSkill,
  proposeUpdateSkill: mocks.proposeUpdateSkill,
  rejectSkillProposal: mocks.rejectSkillProposal,
}));

// mock-isolation: proposal state projection is tested with explicit records.
vi.mock("../workshop/service-query.js", () => ({
  listSkillProposals: mocks.listSkillProposals,
  inspectSkillProposal: mocks.inspectSkillProposal,
}));

// mock-isolation: existing Skill names are supplied without scanning the host workspace.
vi.mock("../loading/workspace-skill-loader.js", () => ({
  prepareWorkspaceSkillEntries: mocks.prepareWorkspaceSkillEntries,
}));

function proposalRecord(
  status: SkillProposalRecord["status"],
  target = { skillName: "Release checklist", skillKey: "release-checklist" },
): SkillProposalReadResult {
  const record = {
    schema: "openclaw.skill-workshop.proposal.v1",
    id: "proposal-1",
    kind: "create",
    status,
    title: `Create ${target.skillName}`,
    description: "Promoted experience",
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    createdBy: "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: "draft-hash",
    target: {
      ...target,
      skillDir: "/workshop/release-checklist",
      skillFile: "/workshop/release-checklist/SKILL.md",
    },
    scan: {
      state: "clean",
      scannedAt: "2026-11-03T00:00:00.000Z",
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
  } as unknown as SkillProposalRecord;
  return { record, revisionHash: "proposal-revision", content: "PROPOSAL.md" };
}

function manifest(proposals: Array<ReturnType<typeof proposalRecord>>) {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-11-03T00:00:00.000Z",
    proposals: proposals.map(({ record }) => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      title: record.title,
      description: record.description,
      skillName: record.target.skillName,
      skillKey: record.target.skillKey,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      scanState: record.scan.state,
    })),
    installedSkills: [],
  };
}

let root = "";
let config = {} as never;
let scope: {
  config: never;
  agentId: string;
  workspaceDir: string;
};

beforeEach(async () => {
  root = await tempDirs.make("openclaw-experience-promotion-");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  config = {
    agents: { entries: { main: { agentDir: path.join(root, "agents", "main", "agent") } } },
  } as never;
  scope = { config, agentId: "main", workspaceDir };
  mocks.listSkillProposals.mockResolvedValue(manifest([]));
  mocks.inspectSkillProposal.mockResolvedValue(null);
  mocks.prepareWorkspaceSkillEntries.mockResolvedValue({ entries: [] });
  mocks.rejectSkillProposal.mockResolvedValue(proposalRecord("rejected").record);
});

afterEach(async () => {
  vi.clearAllMocks();
  await tempDirs.cleanup();
});

async function createDocument(
  content = "1. Collect merged changes.\n",
  name = "Release checklist",
) {
  return await createExperienceFile({
    config,
    agentId: "main",
    name,
    description: "Checklist for release notes.",
    content,
    evidence: { verification: "observed", summary: "Verified in this session." },
  });
}

describe("Experience promotion", () => {
  it("stages a create proposal, links it, and never edits the live skill", async () => {
    const document = await createDocument();
    mocks.proposeCreateSkill.mockResolvedValue(proposalRecord("pending"));
    const result = await promoteExperience(scope, {
      id: document.id,
      expectedRevisionHash: document.revisionHash,
      target: { kind: "create", name: "Release checklist", description: "Release notes." },
    });

    expect(mocks.proposeCreateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Release checklist",
        description: "Release notes.",
        content: "1. Collect merged changes.\n",
        goal: "Promote Experience release-checklist.",
        evidence: expect.stringContaining(document.revisionHash),
      }),
    );
    expect(result.proposal.id).toBe("proposal-1");
    expect(result.record).toMatchObject({
      status: "promoted",
      promotion: {
        proposalId: "proposal-1",
        targetKind: "create",
        targetSkillName: "Release checklist",
        state: "pending",
      },
    });
    expect(result.revisionHash).not.toBe(document.revisionHash);

    const read = await readExperienceFile({
      config,
      agentId: "main",
      id: document.id,
    });
    expect(read.metadata.promotion).toMatchObject({
      proposalId: "proposal-1",
      targetKind: "create",
      targetSkillName: "Release checklist",
    });
    expect(read.body).toBe("1. Collect merged changes.\n");
  });

  it("refuses a second promotion while a proposal is pending", async () => {
    const document = await createDocument();
    mocks.proposeCreateSkill.mockResolvedValue(proposalRecord("pending"));
    const first = await promoteExperience(scope, {
      id: document.id,
      expectedRevisionHash: document.revisionHash,
      target: { kind: "create", name: "Release checklist", description: "Release notes." },
    });
    mocks.inspectSkillProposal.mockResolvedValue(proposalRecord("pending"));

    await expect(
      promoteExperience(scope, {
        id: document.id,
        expectedRevisionHash: first.revisionHash,
        target: { kind: "create", name: "Release checklist", description: "Release notes." },
      }),
    ).rejects.toThrow("already has a pending promotion proposal");
  });

  it("allows a retry after the previous promotion was rejected", async () => {
    const document = await createDocument();
    mocks.proposeCreateSkill
      .mockResolvedValueOnce(proposalRecord("pending"))
      .mockResolvedValueOnce(proposalRecord("pending"));
    const first = await promoteExperience(scope, {
      id: document.id,
      expectedRevisionHash: document.revisionHash,
      target: { kind: "create", name: "Release checklist", description: "Release notes." },
    });
    mocks.inspectSkillProposal.mockResolvedValue(proposalRecord("rejected"));

    const retried = await promoteExperience(scope, {
      id: document.id,
      expectedRevisionHash: first.revisionHash,
      target: { kind: "create", name: "Release checklist", description: "Release notes." },
    });
    expect(retried.record.status).toBe("promoted");
    expect(mocks.proposeCreateSkill).toHaveBeenCalledTimes(2);
  });

  it("refuses to overwrite an existing Skill with the same name", async () => {
    const document = await createDocument();
    mocks.prepareWorkspaceSkillEntries.mockResolvedValue({
      entries: [
        {
          skill: {
            name: "Release checklist",
            description: "Existing",
            filePath: "/workspace/skills/release/SKILL.md",
            source: "openclaw-workspace",
            sourceInfo: {},
            baseDir: "/workspace/skills/release",
            disableModelInvocation: false,
          },
        },
      ],
    });

    await expect(
      promoteExperience(scope, {
        id: document.id,
        expectedRevisionHash: document.revisionHash,
        target: { kind: "create", name: "Release checklist", description: "Release notes." },
      }),
    ).rejects.toThrow("already exists");
    expect(mocks.proposeCreateSkill).not.toHaveBeenCalled();
  });

  it("rejects the orphan proposal when the Experience changes before the link is written", async () => {
    const document = await createDocument();
    const filePath = path.join(resolveExperienceRoot(config, "main"), document.id, "EXPERIENCE.md");
    mocks.proposeCreateSkill.mockImplementation(async () => {
      await fs.appendFile(filePath, "\nConcurrent edit.\n", "utf8");
      return proposalRecord("pending");
    });

    await expect(
      promoteExperience(scope, {
        id: document.id,
        expectedRevisionHash: document.revisionHash,
        target: { kind: "create", name: "Release checklist", description: "Release notes." },
      }),
    ).rejects.toThrow("changed since it was read");
    expect(mocks.rejectSkillProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "proposal-1",
        expectedRevisionHash: "proposal-revision",
      }),
    );
  });

  it("propagates proposal-owner failures instead of reporting missing or duplicating promotion", async () => {
    const document = await createDocument();
    mocks.proposeCreateSkill.mockResolvedValue(proposalRecord("pending"));
    const promoted = await promoteExperience(scope, {
      id: document.id,
      expectedRevisionHash: document.revisionHash,
      target: { kind: "create", name: "Release checklist", description: "Release notes." },
    });

    mocks.inspectSkillProposal.mockRejectedValue(new Error("proposal store unavailable"));
    mocks.listSkillProposals.mockRejectedValue(new Error("proposal store unavailable"));
    await expect(listExperiences(scope)).rejects.toThrow("proposal store unavailable");
    await expect(readExperience(scope, document.id)).rejects.toThrow("proposal store unavailable");
    await expect(
      promoteExperience(scope, {
        id: document.id,
        expectedRevisionHash: promoted.revisionHash,
        target: { kind: "create", name: "Release checklist", description: "Release notes." },
      }),
    ).rejects.toThrow("proposal store unavailable");
    expect(mocks.proposeCreateSkill).toHaveBeenCalledTimes(1);
  });

  it("projects pending and rejected proposal states into list results", async () => {
    const first = await createDocument();
    mocks.proposeCreateSkill.mockResolvedValue(proposalRecord("pending"));
    const promoted = await promoteExperience(scope, {
      id: first.id,
      expectedRevisionHash: first.revisionHash,
      target: { kind: "create", name: "Release checklist", description: "Release notes." },
    });
    await createDocument("Another body.\n", "Other note");
    mocks.listSkillProposals.mockResolvedValue(manifest([proposalRecord("pending")]));

    const pending = await listExperiences(scope);
    expect(pending.experiences.find((record) => record.id === first.id)).toMatchObject({
      status: "promoted",
      promotion: { state: "pending" },
    });

    mocks.listSkillProposals.mockResolvedValue(manifest([proposalRecord("rejected")]));
    const rejected = await listExperiences(scope);
    expect(rejected.experiences.find((record) => record.id === first.id)).toMatchObject({
      status: "active",
      promotion: { state: "rejected" },
    });
    expect(rejected.counts).toEqual({ active: 2, promoted: 0, retired: 0 });
    expect(promoted.revisionHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
