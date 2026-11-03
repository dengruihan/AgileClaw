import type {
  SkillsProposalEvaluateResult,
  SkillsProposalInspectResult,
  SkillsProposalRecordResult,
  SkillsProposalsListResult,
} from "../packages/gateway-protocol/src/schema/agents-models-skills.js";
import type {
  SkillExperienceListResult,
  SkillExperienceMutationResult,
  SkillExperiencePromoteResult,
  SkillExperienceReadResult,
  SkillExperienceRecord,
} from "../ui/src/lib/skill-workshop/experience.ts";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

type ExperienceRecordFixture = SkillExperienceRecord;

export function buildSkillWorkshopMocks(baseTime: number) {
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  const proposals = [
    {
      id: "prop-release-tweets",
      kind: "update",
      status: "pending",
      title: "Tighten release tweet drafting",
      description: "Capture the changelog-to-tweet flow the agent keeps re-deriving.",
      skillName: "release-tweets",
      skillKey: "release-tweets",
      createdAt: new Date(baseTime - 2 * hour).toISOString(),
      updatedAt: new Date(baseTime - hour).toISOString(),
      scanState: "clean",
    },
    {
      id: "prop-crawler-etiquette",
      kind: "create",
      status: "pending",
      title: "Add crawler etiquette skill",
      description: "Rate limits and robots.txt handling learned during the docs sweep.",
      skillName: "crawler-etiquette",
      skillKey: "crawler-etiquette",
      createdAt: new Date(baseTime - 3 * day).toISOString(),
      updatedAt: new Date(baseTime - 2 * day).toISOString(),
      scanState: "clean",
    },
    {
      id: "prop-changelog-style",
      kind: "update",
      status: "applied",
      title: "Changelog bullet style",
      description: "One bullet per entry, no hard wraps.",
      skillName: "changelog-style",
      skillKey: "changelog-style",
      createdAt: new Date(baseTime - 6 * day).toISOString(),
      updatedAt: new Date(baseTime - 5 * day).toISOString(),
      scanState: "clean",
    },
  ] satisfies SkillsProposalsListResult["proposals"];
  const revisionHash = "b".repeat(64);
  const recordFor = (proposal: (typeof proposals)[number]): SkillsProposalRecordResult => ({
    schema: "openclaw.skill-workshop.proposal.v1",
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    title: proposal.title,
    description: proposal.description,
    createdAt: proposal.createdAt,
    updatedAt: proposal.updatedAt,
    createdBy: "skill-workshop",
    proposedVersion: "2",
    draftFile: "PROPOSAL.md",
    draftHash: "a".repeat(64),
    target: {
      source: "openclaw-workshop",
      skillName: proposal.skillName,
      skillKey: proposal.skillKey,
      skillDir: `.agents/skills/${proposal.skillKey}`,
      skillFile: `.agents/skills/${proposal.skillKey}/SKILL.md`,
    },
    scan: {
      state: proposal.scanState,
      scannedAt: new Date(baseTime - hour).toISOString(),
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
  });
  const evaluation: SkillsProposalEvaluateResult["evaluation"] = {
    id: "evaluation-control-ui-mock",
    proposedVersion: "2",
    revisionHash,
    trigger: "manual",
    startedAt: new Date(baseTime - 20_000).toISOString(),
    completedAt: new Date(baseTime - 18_000).toISOString(),
    outcomes: [
      {
        pluginId: "fixture-quality",
        pluginVersion: "1.0.0",
        evaluatorId: "readability",
        status: "completed",
        result: {
          summary: "The workflow is bounded and includes a recovery step.",
          decision: "pass",
          decisionReason: "No blocking findings in the sanitized fixture.",
        },
      },
    ],
  };
  const iso = (ms: number) => new Date(ms).toISOString();
  const experienceRecords: ExperienceRecordFixture[] = [
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "release-rollback-check",
      status: "active",
      name: "release-rollback-check",
      description: "Check the saved rollback path before publishing a release.",
      tags: ["release", "rollback"],
      createdAt: iso(baseTime - 3 * day),
      updatedAt: iso(baseTime - 2 * hour),
      revisionHash: "e1".padEnd(64, "0"),
      capture: "manual",
      origin: { agentId: "main", sessionKey: "agent:main:release-review", runId: "run-mock-4815" },
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
      tags: ["proxy", "recovery"],
      createdAt: iso(baseTime - 6 * day),
      updatedAt: iso(baseTime - 9 * hour),
      revisionHash: "e2".padEnd(64, "0"),
      capture: "automatic",
      evidence: { verification: "unverified" },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "changelog-two-pass",
      status: "active",
      name: "changelog-two-pass",
      description: "Write the changelog once for wording, then again for ordering.",
      createdAt: iso(baseTime - 12 * day),
      updatedAt: iso(baseTime - 2 * day),
      revisionHash: "e3".padEnd(64, "0"),
      capture: "manual",
      evidence: {
        verification: "reported",
        summary: "The operator reported fewer rewrite passes.",
      },
      promotion: {
        proposalId: "prop-changelog-style",
        targetKind: "update",
        targetSkillName: "changelog-style",
        state: "rejected",
      },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "flaky-e2e-quarantine",
      status: "promoted",
      name: "flaky-e2e-quarantine",
      description: "Quarantine a flaky end-to-end test before diagnosing it.",
      tags: ["testing"],
      createdAt: iso(baseTime - 8 * day),
      updatedAt: iso(baseTime - day),
      revisionHash: "e4".padEnd(64, "0"),
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
      id: "release-note-format",
      status: "promoted",
      name: "release-note-format",
      description: "One bullet per change, user impact first.",
      createdAt: iso(baseTime - 20 * day),
      updatedAt: iso(baseTime - 4 * day),
      revisionHash: "e5".padEnd(64, "0"),
      capture: "manual",
      evidence: { verification: "observed", summary: "Applied in the last two release notes." },
      promotion: {
        proposalId: "prop-changelog-style",
        targetKind: "update",
        targetSkillName: "changelog-style",
        state: "applied",
      },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "legacy-shell-retry",
      status: "retired",
      name: "legacy-shell-retry",
      description: "Retry a legacy shell step after a timeout.",
      createdAt: iso(baseTime - 30 * day),
      updatedAt: iso(baseTime - 5 * day),
      revisionHash: "e6".padEnd(64, "0"),
      capture: "automatic",
      retiredAt: iso(baseTime - 5 * day),
      retireReason: "The retry moved into the deployment skill.",
      evidence: { verification: "reported" },
    },
    {
      schema: "openclaw.skill-workshop.experience.v1",
      id: "incident-triage-runbook",
      status: "active",
      name: "incident-triage-runbook",
      description: "A long recollection of how to triage a stuck deployment.",
      createdAt: iso(baseTime - day),
      updatedAt: iso(baseTime - 30 * 60 * 1000),
      revisionHash: "e7".padEnd(64, "0"),
      capture: "manual",
      evidence: { verification: "unverified" },
    },
  ];
  const experienceContents: Record<string, string> = {
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
    "changelog-two-pass": [
      "# Changelog in two passes",
      "",
      "Pass one: capture every change in plain language.",
      "Pass two: order by user impact and remove duplicates.",
    ].join("\n"),
    "flaky-e2e-quarantine": [
      "# Quarantine a flaky test",
      "",
      "1. Tag the test as quarantined.",
      "2. Keep it running on the scheduled lane.",
      "3. Record the failure signature before changing it.",
    ].join("\n"),
    "release-note-format": [
      "# Release note format",
      "",
      "- One bullet per change.",
      "- Lead with the user impact.",
      "- Keep migration steps in their own section.",
    ].join("\n"),
    "legacy-shell-retry": [
      "# Legacy shell retry",
      "",
      "Retry once after a timeout, then stop and report the original error.",
    ].join("\n"),
    "incident-triage-runbook": [
      "# Stuck deployment triage",
      "",
      ...Array.from({ length: 90 }, (_, index) =>
        index % 10 === 0
          ? `\n## Phase ${Math.floor(index / 10) + 1}\n`
          : `- Check triage item ${String(index + 1).padStart(3, "0")} and record the observed state.\n`,
      ),
    ].join("\n"),
  };
  return {
    experience: {
      manifest: {
        schema: "openclaw.skill-workshop.experiences-manifest.v1",
        updatedAt: iso(baseTime - 30 * 60 * 1000),
        experiences: experienceRecords,
        counts: {
          active: experienceRecords.filter((record) => record.status === "active").length,
          promoted: experienceRecords.filter((record) => record.status === "promoted").length,
          retired: experienceRecords.filter((record) => record.status === "retired").length,
        },
      } satisfies SkillExperienceListResult,
      details: experienceRecords.map((record) => ({
        id: record.id,
        content: experienceContents[record.id] ?? "",
      })),
    },
    list: {
      schema: "openclaw.skill-workshop.proposals-manifest.v1",
      updatedAt: new Date(baseTime - hour).toISOString(),
      proposals,
      installedSkills: proposals
        .filter((proposal) => proposal.status === "applied")
        .map((proposal) => ({
          name: proposal.skillName,
          skillKey: proposal.skillKey,
          description: proposal.description,
        })),
    } satisfies SkillsProposalsListResult,
    inspect: {
      cases: proposals.map((proposal) => ({
        match: { proposalId: proposal.id },
        response: {
          record: {
            ...recordFor(proposal),
            ...(proposal.id === "prop-release-tweets" ? { evaluation } : {}),
          },
          revisionHash,
          content: [
            `# ${proposal.title}`,
            "",
            proposal.description,
            "",
            "## Steps",
            "1. Gather the source material.",
            "2. Apply the documented workflow.",
          ].join("\n"),
          supportFiles: [],
        },
      })),
    },
    evaluation,
    requestRevision: { runId: "skill-workshop-revision-mock", status: "started" },
  };
}

/** Each agent's proposal records own both mutation replies and subsequent reads. */
function installSkillWorkshopMock(seed: ReturnType<typeof buildSkillWorkshopMocks>): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const scopes = new Map<
    string,
    {
      list: SkillsProposalsListResult;
      details: Map<string, SkillsProposalInspectResult>;
    }
  >();
  for (const method of [
    "list",
    "inspect",
    "evaluate",
    "apply",
    "reject",
    "historyStatus",
    "historyScan",
    "read",
  ]) {
    gateway.setRequestHandler(
      method === "read" ? "skills.workshop.read" : `skills.proposals.${method}`,
      ({ params: input, respond }) => {
        const reject = (message: string) =>
          respond({ __mockError: { code: "INVALID_REQUEST", message } });
        if (method === "historyStatus" || method === "historyScan") {
          return reject(
            "Historical batch scans are retired. Start a learning session from Workshop to review past conversations.",
          );
        }
        const params = (input ?? {}) as {
          agentId?: string;
          proposalId?: string;
          expectedRevisionHash?: string;
          name?: string;
        };
        const agentId = params.agentId ?? "main";
        let scope = scopes.get(agentId);
        if (!scope) {
          scope = {
            list: structuredClone(seed.list),
            details: new Map(
              seed.inspect.cases.map((entry) => [
                entry.match.proposalId,
                structuredClone(entry.response),
              ]),
            ),
          };
          scopes.set(agentId, scope);
        }
        if (method === "list") {
          respond(scope.list);
          return;
        }
        if (method === "read") {
          const installed = scope.list.installedSkills.find((skill) => skill.name === params.name);
          const detail =
            installed &&
            Array.from(scope.details.values()).find(
              (candidate) =>
                candidate.record.status === "applied" &&
                candidate.record.target.skillKey === installed.skillKey,
            );
          if (!installed || !detail) {
            return reject("Mock Workshop skill not found.");
          }
          respond({ ...installed, content: detail.content });
          return;
        }
        const detail = params.proposalId ? scope.details.get(params.proposalId) : undefined;
        if (!detail) {
          return reject("Unknown mock proposal; refresh the Workshop.");
        }
        if (method === "inspect") {
          respond(detail);
          return;
        }
        if (detail.record.status !== "pending") {
          return reject("Only pending proposals can be evaluated, applied, or rejected.");
        }
        if (params.expectedRevisionHash && params.expectedRevisionHash !== detail.revisionHash) {
          return reject("The proposal revision changed; refresh the proposal before retrying.");
        }
        const now = new Date().toISOString();
        detail.record.updatedAt = now;
        if (method === "evaluate") {
          const evaluation = structuredClone(seed.evaluation);
          evaluation.startedAt = now;
          evaluation.completedAt = now;
          detail.record.evaluation = evaluation;
        } else if (method === "apply") {
          detail.record.status = "applied";
          detail.record.appliedAt = now;
          const skillKey = detail.record.target.skillKey;
          const installed = {
            name: detail.record.kind === "create" ? skillKey : detail.record.target.skillName,
            skillKey,
            description: detail.record.description,
          };
          scope.list.installedSkills = [
            ...scope.list.installedSkills.filter((skill) => skill.skillKey !== skillKey),
            installed,
          ];
        } else {
          detail.record.status = "rejected";
          detail.record.rejectedAt = now;
        }
        const entry = scope.list.proposals.find((proposal) => proposal.id === detail.record.id);
        if (entry) {
          entry.status = detail.record.status;
          entry.updatedAt = now;
          entry.revisionHash = detail.revisionHash;
        }
        scope.list.updatedAt = now;
        if (method === "evaluate") {
          respond({ record: detail.record, evaluation: detail.record.evaluation });
        } else if (method === "apply") {
          respond({
            record: detail.record,
            targetSkillFile: `.agents/skills/${detail.record.target.skillKey}/SKILL.md`,
          });
        } else {
          respond(detail.record);
        }
      },
    );
  }

  // Experience documents share this installer so a promotion can stage a
  // pending proposal in the same in-memory store the Suggestions tab reads.
  type ExperienceScope = {
    records: Map<string, SkillExperienceRecord>;
    contents: Map<string, string>;
  };
  const experienceScopes = new Map<string, ExperienceScope>();
  const experienceScopeFor = (agentId: string): ExperienceScope => {
    let scope = experienceScopes.get(agentId);
    if (!scope) {
      scope = {
        records: new Map(
          seed.experience.manifest.experiences.map((record) => [
            record.id,
            structuredClone(record),
          ]),
        ),
        contents: new Map(seed.experience.details.map((detail) => [detail.id, detail.content])),
      };
      experienceScopes.set(agentId, scope);
    }
    return scope;
  };
  let experienceSequence = 100;
  const nextRevision = () => `e${String(++experienceSequence).padStart(63, "0")}`;
  const nowIso = () => new Date().toISOString();
  const slugify = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const experienceManifest = (scope: ExperienceScope): SkillExperienceListResult => {
    const experiences = Array.from(scope.records.values());
    return {
      schema: "openclaw.skill-workshop.experiences-manifest.v1",
      updatedAt: nowIso(),
      experiences,
      counts: {
        active: experiences.filter((record) => record.status === "active").length,
        promoted: experiences.filter((record) => record.status === "promoted").length,
        retired: experiences.filter((record) => record.status === "retired").length,
      },
    };
  };
  const rejectExperience = (
    respond: (payload: unknown) => void,
    message: string,
    details?: unknown,
  ) =>
    respond({ __mockError: { code: "INVALID_REQUEST", message, ...(details ? { details } : {}) } });
  const revisionMismatch = (
    respond: (payload: unknown) => void,
    expected: string | undefined,
    current: string,
  ) =>
    rejectExperience(respond, "The experience changed; reload it before retrying.", {
      code: "SKILL_EXPERIENCE_REVISION_CHANGED",
      expectedRevisionHash: expected,
      currentRevisionHash: current,
    });

  gateway.setRequestHandler("skills.experience.list", ({ params: input, respond }) => {
    const params = (input ?? {}) as { agentId?: string };
    respond(experienceManifest(experienceScopeFor(params.agentId ?? "main")));
  });

  gateway.setRequestHandler("skills.experience.read", ({ params: input, respond }) => {
    const params = (input ?? {}) as { agentId?: string; id?: string };
    const scope = experienceScopeFor(params.agentId ?? "main");
    const record = params.id ? scope.records.get(params.id) : undefined;
    if (!record) {
      return rejectExperience(respond, "Unknown mock experience; refresh the Workshop.");
    }
    const result: SkillExperienceReadResult = {
      record: structuredClone(record),
      revisionHash: record.revisionHash,
      content: scope.contents.get(record.id) ?? "",
    };
    respond(result);
  });

  gateway.setRequestHandler("skills.experience.create", ({ params: input, respond }) => {
    const params = (input ?? {}) as {
      agentId?: string;
      name?: string;
      description?: string;
      content?: string;
    };
    const agentId = params.agentId ?? "main";
    const scope = experienceScopeFor(agentId);
    const name = params.name?.trim() ?? "";
    if (!name || !params.description?.trim() || !params.content?.trim()) {
      return rejectExperience(respond, "Name, summary, and document are required.");
    }
    const proposalScope = scopes.get(agentId);
    if (
      proposalScope?.list.installedSkills.some(
        (skill) => skill.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return rejectExperience(respond, `A skill named ${name} already exists.`);
    }
    if (
      Array.from(scope.records.values()).some(
        (record) => record.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      return rejectExperience(respond, `An experience named ${name} already exists.`);
    }
    const id = slugify(name) || `experience-${experienceSequence}`;
    const now = nowIso();
    const record: SkillExperienceRecord = {
      schema: "openclaw.skill-workshop.experience.v1",
      id,
      status: "active",
      name,
      description: params.description.trim(),
      createdAt: now,
      updatedAt: now,
      revisionHash: nextRevision(),
      capture: "manual",
    };
    scope.records.set(id, record);
    scope.contents.set(id, params.content);
    const result: SkillExperienceMutationResult = {
      record,
      revisionHash: record.revisionHash,
    };
    respond(result);
  });

  gateway.setRequestHandler("skills.experience.update", ({ params: input, respond }) => {
    const params = (input ?? {}) as {
      agentId?: string;
      id?: string;
      expectedRevisionHash?: string;
      name?: string;
      description?: string;
      content?: string;
    };
    const scope = experienceScopeFor(params.agentId ?? "main");
    const record = params.id ? scope.records.get(params.id) : undefined;
    if (!record) {
      return rejectExperience(respond, "Unknown mock experience; refresh the Workshop.");
    }
    if (record.status === "retired") {
      return rejectExperience(respond, "Retired experiences are read-only. Restore it first.");
    }
    if (params.expectedRevisionHash !== record.revisionHash) {
      return revisionMismatch(respond, params.expectedRevisionHash, record.revisionHash);
    }
    if (params.name !== undefined) {
      record.name = params.name.trim();
    }
    if (params.description !== undefined) {
      record.description = params.description.trim();
    }
    if (params.content !== undefined) {
      scope.contents.set(record.id, params.content);
    }
    record.updatedAt = nowIso();
    record.revisionHash = nextRevision();
    const result: SkillExperienceMutationResult = {
      record,
      revisionHash: record.revisionHash,
    };
    respond(result);
  });

  gateway.setRequestHandler("skills.experience.retire", ({ params: input, respond }) => {
    const params = (input ?? {}) as {
      agentId?: string;
      id?: string;
      expectedRevisionHash?: string;
      reason?: string;
    };
    const scope = experienceScopeFor(params.agentId ?? "main");
    const record = params.id ? scope.records.get(params.id) : undefined;
    if (!record) {
      return rejectExperience(respond, "Unknown mock experience; refresh the Workshop.");
    }
    if (record.status === "retired") {
      return rejectExperience(respond, "This experience is already retired.");
    }
    if (params.expectedRevisionHash !== record.revisionHash) {
      return revisionMismatch(respond, params.expectedRevisionHash, record.revisionHash);
    }
    const now = nowIso();
    record.status = "retired";
    record.retiredAt = now;
    record.retireReason = params.reason?.trim() || undefined;
    record.updatedAt = now;
    record.revisionHash = nextRevision();
    const result: SkillExperienceMutationResult = {
      record,
      revisionHash: record.revisionHash,
    };
    respond(result);
  });

  gateway.setRequestHandler("skills.experience.restore", ({ params: input, respond }) => {
    const params = (input ?? {}) as {
      agentId?: string;
      id?: string;
      expectedRevisionHash?: string;
    };
    const scope = experienceScopeFor(params.agentId ?? "main");
    const record = params.id ? scope.records.get(params.id) : undefined;
    if (!record) {
      return rejectExperience(respond, "Unknown mock experience; refresh the Workshop.");
    }
    if (record.status !== "retired") {
      return rejectExperience(respond, "Only retired experiences can be restored.");
    }
    if (
      params.expectedRevisionHash !== undefined &&
      params.expectedRevisionHash !== record.revisionHash
    ) {
      return revisionMismatch(respond, params.expectedRevisionHash, record.revisionHash);
    }
    record.status =
      record.promotion && record.promotion.state !== "rejected" ? "promoted" : "active";
    record.retiredAt = undefined;
    record.retireReason = undefined;
    record.updatedAt = nowIso();
    record.revisionHash = nextRevision();
    const result: SkillExperienceMutationResult = {
      record,
      revisionHash: record.revisionHash,
    };
    respond(result);
  });

  gateway.setRequestHandler("skills.experience.promote", ({ params: input, respond }) => {
    const params = (input ?? {}) as {
      agentId?: string;
      id?: string;
      expectedRevisionHash?: string;
      target?:
        | { kind: "create"; name: string; description: string }
        | { kind: "update"; skillName: string; description?: string };
    };
    const agentId = params.agentId ?? "main";
    const scope = experienceScopeFor(agentId);
    const record = params.id ? scope.records.get(params.id) : undefined;
    if (!record || !params.target) {
      return rejectExperience(respond, "Unknown mock experience or missing promotion target.");
    }
    if (record.status !== "active") {
      return rejectExperience(respond, "Only candidate experiences can be promoted.");
    }
    if (params.expectedRevisionHash !== record.revisionHash) {
      return revisionMismatch(respond, params.expectedRevisionHash, record.revisionHash);
    }
    const proposalScope = scopes.get(agentId) ?? {
      list: structuredClone(seed.list),
      details: new Map<string, SkillsProposalInspectResult>(),
    };
    scopes.set(agentId, proposalScope);
    const targetSkillName =
      params.target.kind === "create" ? params.target.name.trim() : params.target.skillName;
    if (!targetSkillName) {
      return rejectExperience(respond, "A skill name is required.");
    }
    const proposalId = `prop-experience-${record.id}`;
    if (proposalScope.list.proposals.some((proposal) => proposal.id === proposalId)) {
      return rejectExperience(respond, "This experience already has a promotion proposal.");
    }
    if (
      params.target.kind === "create" &&
      proposalScope.list.installedSkills.some(
        (skill) => skill.name.toLowerCase() === targetSkillName.toLowerCase(),
      )
    ) {
      return rejectExperience(
        respond,
        `A skill named ${targetSkillName} already exists. Update it instead.`,
      );
    }
    const now = nowIso();
    const description = params.target.description?.trim() || record.description;
    const revisionHash = "c".repeat(64);
    const proposal: SkillsProposalRecordResult = {
      schema: "openclaw.skill-workshop.proposal.v1",
      id: proposalId,
      kind: params.target.kind,
      status: "pending",
      title: `Promote ${record.name}`,
      description,
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "1",
      draftFile: "PROPOSAL.md",
      draftHash: "a".repeat(64),
      target: {
        source: "openclaw-workshop",
        skillName: targetSkillName,
        skillKey: targetSkillName,
        skillDir: `.agents/skills/${targetSkillName}`,
        skillFile: `.agents/skills/${targetSkillName}/SKILL.md`,
      },
      scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
    };
    proposalScope.list.proposals = [
      {
        id: proposalId,
        kind: params.target.kind,
        status: "pending",
        title: proposal.title,
        description,
        skillName: targetSkillName,
        skillKey: targetSkillName,
        createdAt: now,
        updatedAt: now,
        scanState: "clean",
        revisionHash,
      },
      ...proposalScope.list.proposals,
    ];
    proposalScope.details.set(proposalId, {
      record: proposal,
      revisionHash,
      content: `# ${targetSkillName}\n\n${description}\n\n${scope.contents.get(record.id) ?? ""}`,
      supportFiles: [],
    });
    record.status = "promoted";
    record.promotion = {
      proposalId,
      targetKind: params.target.kind,
      targetSkillName,
      state: "pending",
      updatedAt: now,
    };
    record.updatedAt = now;
    record.revisionHash = nextRevision();
    const result: SkillExperiencePromoteResult = {
      record,
      revisionHash: record.revisionHash,
      proposal,
    };
    respond(result);
  });
}

export function skillWorkshopMockInitScript(baseTime: number): string {
  return `(() => { const __name = (target) => target; (${installSkillWorkshopMock.toString()})(${JSON.stringify(buildSkillWorkshopMocks(baseTime))}); })();`;
}
