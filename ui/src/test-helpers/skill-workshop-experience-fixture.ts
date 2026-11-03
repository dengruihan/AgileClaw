import type {
  SkillExperienceListResult,
  SkillExperiencePromoteResult,
  SkillExperienceRecord,
} from "../lib/skill-workshop/experience.ts";

const updatedAt = "2026-11-03T10:00:00.000Z";
const revisionA = "a".repeat(64);
const revisionB = "b".repeat(64);
const revisionC = "c".repeat(64);

function longDocument(): string {
  return Array.from({ length: 420 }, (_, index) =>
    index % 21 === 0
      ? `\n## Review phase ${Math.floor(index / 21) + 1}\n`
      : `- Confirm triage step ${String(index + 1).padStart(4, "0")} and record the observed result.\n`,
  ).join("\n");
}

export function createSkillWorkshopExperienceFixture() {
  const records: SkillExperienceRecord[] = [
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "release-rollback-check",
      status: "active",
      name: "release-rollback-check",
      description: "Check the saved rollback path before publishing a release.",
      tags: ["release", "rollback"],
      createdAt: "2026-10-31T09:00:00.000Z",
      updatedAt: "2026-11-03T08:00:00.000Z",
      revisionHash: revisionA,
      capture: "manual",
      origin: {
        agentId: "main",
        sessionKey: "agent:main:release-review",
        runId: "run-mock-4815",
      },
      evidence: {
        verification: "observed",
        summary: "The saved rollback command restored the previous build in a dry run.",
      },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "proxy-header-recovery",
      status: "active",
      name: "proxy-header-recovery",
      description: "Recover a reverse proxy that strips the forwarded host header.",
      createdAt: "2026-10-28T09:00:00.000Z",
      updatedAt: "2026-11-02T21:00:00.000Z",
      revisionHash: revisionB,
      capture: "automatic",
      evidence: { verification: "unverified" },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "flaky-e2e-quarantine",
      status: "promoted",
      name: "flaky-e2e-quarantine",
      description: "Quarantine a flaky end-to-end test before diagnosing it.",
      tags: ["testing"],
      createdAt: "2026-10-26T09:00:00.000Z",
      updatedAt: "2026-11-02T09:00:00.000Z",
      revisionHash: revisionC,
      capture: "automatic",
      evidence: {
        verification: "observed",
        summary: "Three consecutive runs passed once quarantined.",
      },
      promotion: {
        proposalId: "prop-experience-flaky",
        targetKind: "create",
        targetSkillName: "flaky-e2e-quarantine",
        state: "pending",
      },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "incident-triage-runbook",
      status: "active",
      name: "incident-triage-runbook",
      description: "A long recollection of how to triage a stuck deployment.",
      createdAt: "2026-11-02T09:00:00.000Z",
      updatedAt: "2026-11-03T09:30:00.000Z",
      revisionHash: revisionA,
      capture: "manual",
      evidence: { verification: "unverified" },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "legacy-shell-retry",
      status: "retired",
      name: "legacy-shell-retry",
      description: "Retry a legacy shell step after a timeout.",
      createdAt: "2026-10-04T09:00:00.000Z",
      updatedAt: "2026-10-29T09:00:00.000Z",
      revisionHash: revisionB,
      capture: "automatic",
      retiredAt: "2026-10-29T09:00:00.000Z",
      retireReason: "The retry moved into the deployment skill.",
      evidence: { verification: "reported" },
    },
  ];

  const contents: Record<string, string> = {
    "release-rollback-check": [
      "# Release rollback check",
      "",
      "## When this applies",
      "",
      "Publishing a release when the previous build is still serving traffic.",
      "",
      "## Steps",
      "",
      "1. Read the deployed version from the health response.",
      "2. Run the saved rollback command with `--dry-run`.",
      "3. Compare the reported target version with the previous build.",
      "4. Only then start the publish step.",
      "",
      "## Verification",
      "",
      "The dry run named the previous build and reported no schema change.",
    ].join("\n"),
    "proxy-header-recovery": [
      "# Proxy header recovery",
      "",
      "Restart the proxy with the forwarded host header, then re-check the public URL.",
      "If the page still loops, inspect the upstream health endpoint before editing more headers.",
    ].join("\n"),
    "flaky-e2e-quarantine": [
      "# Quarantine a flaky test",
      "",
      "1. Tag the test as quarantined.",
      "2. Keep it running on the scheduled lane.",
      "3. Record the failure signature before changing it.",
    ].join("\n"),
    "incident-triage-runbook": longDocument(),
    "legacy-shell-retry": [
      "# Legacy shell retry",
      "",
      "Retry once after a timeout, then stop and report the original error.",
    ].join("\n"),
  };

  const manifest: SkillExperienceListResult = {
    schema: "openclaw.skill-workshop.experiences-manifest.v1",
    updatedAt,
    experiences: records,
    counts: { active: 3, promoted: 1, retired: 1 },
  };
  const emptyManifest: SkillExperienceListResult = {
    ...manifest,
    experiences: [],
    counts: { active: 0, promoted: 0, retired: 0 },
  };
  const installedSkills = [
    { name: "changelog-style", skillKey: "changelog-style", description: "Changelog rules." },
    { name: "release-review", skillKey: "release-review", description: "Release checks." },
    {
      name: "release-rollback-check",
      skillKey: "release-rollback-check",
      description: "Rollback checks.",
    },
  ];
  const pendingProposal = {
    id: "prop-experience-flaky",
    kind: "create",
    status: "pending",
    title: "Promote flaky-e2e-quarantine",
    description: "Quarantine a flaky end-to-end test before diagnosing it.",
    skillName: "flaky-e2e-quarantine",
    skillKey: "flaky-e2e-quarantine",
    createdAt: "2026-11-02T09:00:00.000Z",
    updatedAt: "2026-11-02T09:00:00.000Z",
    scanState: "clean",
  };
  const proposalsManifest = {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt,
    proposals: [pendingProposal],
    installedSkills,
  };

  return {
    manifest,
    records,
    contents,
    installedSkills,
    proposalsManifest,
    featureMethods: [
      "config.get",
      "skills.experience.list",
      "skills.experience.read",
      "skills.experience.create",
      "skills.experience.update",
      "skills.experience.retire",
      "skills.experience.restore",
      "skills.experience.promote",
      "skills.proposals.apply",
      "skills.proposals.evaluate",
      "skills.proposals.reject",
      "skills.proposals.requestRevision",
    ],
    responses: {
      "config.get": {
        hash: "workshop-experience-config",
        config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        sourceConfig: { skills: { workshop: { autonomous: { mode: "auto" } } } },
        raw: "{}",
        valid: true,
        issues: [],
      },
      "agents.list": {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [
          { id: "main", name: "Main" },
          { id: "writer", name: "Writer" },
        ],
      },
      "skills.experience.list": {
        cases: [
          { match: { agentId: "main" }, response: manifest },
          { match: { agentId: "writer" }, response: emptyManifest },
        ],
      },
      "skills.experience.read": {
        cases: records.map((record) => ({
          match: { id: record.id },
          response: {
            record,
            revisionHash: record.revisionHash,
            content: contents[record.id] ?? "",
          },
        })),
      },
      "skills.proposals.list": proposalsManifest,
      "skills.proposals.inspect": {
        cases: [
          {
            match: { proposalId: pendingProposal.id },
            response: {
              record: {
                ...pendingProposal,
                schema: "openclaw.skill-workshop.proposal.v1",
                createdBy: "skill-workshop",
                proposedVersion: "1",
                draftFile: "PROPOSAL.md",
                draftHash: "d".repeat(64),
                target: {
                  source: "openclaw-workshop",
                  skillName: pendingProposal.skillName,
                  skillKey: pendingProposal.skillKey,
                  skillDir: `.agents/skills/${pendingProposal.skillKey}`,
                  skillFile: `.agents/skills/${pendingProposal.skillKey}/SKILL.md`,
                },
                scan: {
                  state: "clean",
                  scannedAt: updatedAt,
                  critical: 0,
                  warn: 0,
                  info: 0,
                  findings: [],
                },
              },
              revisionHash: "e".repeat(64),
              content: "# flaky-e2e-quarantine\n\nQuarantine a flaky test.",
              supportFiles: [],
            },
          },
        ],
      },
    },
  };
}

export function experiencePromoteResult(
  record: SkillExperienceRecord,
  proposalId = "prop-experience-promoted",
): SkillExperiencePromoteResult {
  return {
    record: {
      ...record,
      status: "promoted",
      promotion: {
        proposalId,
        targetKind: "create",
        targetSkillName: record.name,
        state: "pending",
        updatedAt: "2026-11-03T11:00:00.000Z",
      },
      updatedAt: "2026-11-03T11:00:00.000Z",
      revisionHash: "f".repeat(64),
    },
    revisionHash: "f".repeat(64),
    proposal: {
      schema: "openclaw.skill-workshop.proposal.v1",
      id: proposalId,
      kind: "create",
      status: "pending",
      title: `Promote ${record.name}`,
      description: record.description,
      createdAt: "2026-11-03T11:00:00.000Z",
      updatedAt: "2026-11-03T11:00:00.000Z",
      createdBy: "skill-workshop",
      proposedVersion: "1",
      draftFile: "PROPOSAL.md",
      draftHash: "d".repeat(64),
      target: {
        source: "openclaw-workshop",
        skillName: record.name,
        skillKey: record.name,
        skillDir: `.agents/skills/${record.name}`,
        skillFile: `.agents/skills/${record.name}/SKILL.md`,
      },
      scan: {
        state: "clean",
        scannedAt: "2026-11-03T11:00:00.000Z",
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    },
  };
}
