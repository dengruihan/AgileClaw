import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SkillExperienceCreateParams,
  SkillExperienceListResult,
  SkillExperiencePromoteParams,
  SkillExperienceReadResult,
  SkillExperienceRecord,
  SkillExperienceRestoreParams,
  SkillExperienceRetireParams,
  SkillExperienceUpdateParams,
} from "../../../packages/gateway-protocol/src/schema/skill-experience.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareWorkspaceSkillEntries } from "../loading/workspace-skill-loader.js";
import { listSkillProposals, inspectSkillProposal } from "../workshop/service-query.js";
import {
  proposeCreateSkill,
  proposeUpdateSkill,
  rejectSkillProposal,
} from "../workshop/service.js";
import type { SkillProposalRecord } from "../workshop/types.js";
import {
  createExperienceFile,
  ExperienceNotFoundError,
  ExperienceRevisionChangedError,
  experienceStatus,
  linkExperiencePromotion,
  listExperienceFiles,
  readExperienceFile,
  restoreExperienceFile,
  retireExperienceFile,
  updateExperienceFile,
  type ExperienceDocument,
} from "./experience-document.js";
import { normalizeExperienceId } from "./experience-root.js";

export type ExperienceScope = {
  config: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
};

type ProjectedPromotion = NonNullable<SkillExperienceRecord["promotion"]>;

function proposalState(status: SkillProposalRecord["status"]): ProjectedPromotion["state"] {
  return status === "pending" ? "pending" : status === "applied" ? "applied" : "rejected";
}

function toRecord(params: {
  id: string;
  metadata: ExperienceDocument["metadata"];
  revisionHash: string;
  retired: boolean;
  promotionState?: ProjectedPromotion;
}): SkillExperienceRecord {
  const promotion = params.metadata.promotion
    ? {
        proposalId: params.metadata.promotion.proposalId,
        targetKind: params.metadata.promotion.targetKind,
        targetSkillName: params.metadata.promotion.targetSkillName,
        state: params.promotionState?.state ?? "rejected",
        ...(params.promotionState?.updatedAt ? { updatedAt: params.promotionState.updatedAt } : {}),
      }
    : undefined;
  return {
    schema: "openclaw.skill-workshop.experience.v1",
    id: params.id,
    status: experienceStatus({ retired: params.retired, ...(promotion ? { promotion } : {}) }),
    name: params.metadata.name,
    description: params.metadata.description,
    ...(params.metadata.tags ? { tags: params.metadata.tags } : {}),
    createdAt: params.metadata.createdAt,
    updatedAt: params.metadata.updatedAt,
    revisionHash: params.revisionHash,
    ...(params.metadata.capture ? { capture: params.metadata.capture } : {}),
    ...(params.metadata.origin ? { origin: params.metadata.origin } : {}),
    ...(params.metadata.evidence ? { evidence: params.metadata.evidence } : {}),
    ...(params.metadata.project ? { project: params.metadata.project } : {}),
    ...(promotion ? { promotion } : {}),
    ...(params.metadata.retiredAt ? { retiredAt: params.metadata.retiredAt } : {}),
    ...(params.metadata.retireReason ? { retireReason: params.metadata.retireReason } : {}),
  };
}

async function proposalStates(scope: ExperienceScope): Promise<Map<string, ProjectedPromotion>> {
  const manifest = await listSkillProposals({
    config: scope.config,
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
  });
  const states = new Map<string, ProjectedPromotion>();
  for (const proposal of manifest.proposals) {
    states.set(proposal.id, {
      proposalId: proposal.id,
      targetKind: proposal.kind,
      targetSkillName: proposal.skillName,
      state: proposalState(proposal.status),
      updatedAt: proposal.updatedAt,
    });
  }
  return states;
}

function projectDocument(document: ExperienceDocument, state?: ProjectedPromotion) {
  return {
    record: toRecord({
      id: document.id,
      metadata: document.metadata,
      revisionHash: document.revisionHash,
      retired: document.retired,
      ...(state ? { promotionState: state } : {}),
    }),
    revisionHash: document.revisionHash,
    document,
  };
}

export async function listExperiences(scope: ExperienceScope): Promise<SkillExperienceListResult> {
  const files = await listExperienceFiles(scope);
  // The proposal owner is authoritative for promotion state; an operational
  // failure propagates rather than masquerading as a rejected or missing link.
  const states = files.some((file) => file.metadata.promotion)
    ? await proposalStates(scope)
    : new Map<string, ProjectedPromotion>();
  const experiences = files.map((file) =>
    toRecord({
      id: file.id,
      metadata: file.metadata,
      revisionHash: file.revisionHash,
      retired: file.retired,
      ...(file.metadata.promotion
        ? { promotionState: states.get(file.metadata.promotion.proposalId) }
        : {}),
    }),
  );
  const counts = { active: 0, promoted: 0, retired: 0 };
  for (const record of experiences) {
    counts[record.status] += 1;
  }
  return {
    schema: "openclaw.skill-workshop.experiences-manifest.v1",
    updatedAt: new Date().toISOString(),
    experiences,
    counts,
  };
}

export async function readExperience(
  scope: ExperienceScope,
  id: string,
): Promise<SkillExperienceReadResult> {
  const document = await readExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    id,
    ...(scope.env ? { env: scope.env } : {}),
  });
  let state: ProjectedPromotion | undefined;
  if (document.metadata.promotion) {
    const inspected = await inspectSkillProposal(document.metadata.promotion.proposalId, {
      config: scope.config,
      agentId: scope.agentId,
      ...(scope.env ? { env: scope.env } : {}),
    });
    state = inspected
      ? {
          proposalId: inspected.record.id,
          targetKind: inspected.record.kind,
          targetSkillName: inspected.record.target.skillName,
          state: proposalState(inspected.record.status),
          updatedAt: inspected.record.updatedAt,
        }
      : undefined;
  }
  const projected = projectDocument(document, state);
  return {
    record: projected.record,
    revisionHash: projected.revisionHash,
    content: document.body,
  };
}

export async function createExperience(
  scope: ExperienceScope,
  params: Omit<SkillExperienceCreateParams, "agentId">,
) {
  const document = await createExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...params,
  });
  return projectDocument(document);
}

export type CaptureExperienceInput = Omit<SkillExperienceCreateParams, "agentId"> & {
  capture?: SkillExperienceRecord["capture"];
  project?: SkillExperienceRecord["project"];
};

export async function captureExperience(
  scope: ExperienceScope,
  params: CaptureExperienceInput,
): Promise<{ created: boolean; record: SkillExperienceRecord; revisionHash: string }> {
  const id = normalizeExperienceId(params.name);
  try {
    const existing = await readExperienceFile({
      config: scope.config,
      agentId: scope.agentId,
      id,
      ...(scope.env ? { env: scope.env } : {}),
    });
    if (existing.retired) {
      throw new Error(`Experience is retired; restore it before capturing again: ${id}`);
    }
    if (existing.body.trim() !== params.content.trim()) {
      throw new Error(
        `Experience ${id} already exists with different content; update it with expected_revision_hash instead of capturing a duplicate.`,
      );
    }
    const projected = projectDocument(existing);
    return {
      created: false,
      record: projected.record,
      revisionHash: projected.revisionHash,
    };
  } catch (error) {
    if (!(error instanceof ExperienceNotFoundError)) {
      throw error;
    }
  }
  const created = await createExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    name: params.name,
    description: params.description,
    content: params.content,
    ...(params.tags ? { tags: params.tags } : {}),
    capture: params.capture ?? (params.origin ? "automatic" : "manual"),
    ...(params.origin ? { origin: params.origin } : {}),
    ...(params.evidence ? { evidence: params.evidence } : {}),
    ...(params.project ? { project: params.project } : {}),
  });
  const projected = projectDocument(created);
  return { created: true, record: projected.record, revisionHash: projected.revisionHash };
}

export async function updateExperience(
  scope: ExperienceScope,
  params: Omit<SkillExperienceUpdateParams, "agentId">,
) {
  const document = await updateExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...params,
  });
  return projectDocument(document);
}

export async function retireExperience(
  scope: ExperienceScope,
  params: Omit<SkillExperienceRetireParams, "agentId">,
) {
  const document = await retireExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...params,
  });
  return projectDocument(document);
}

export async function restoreExperience(
  scope: ExperienceScope,
  params: Omit<SkillExperienceRestoreParams, "agentId">,
) {
  const document = await restoreExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    ...(scope.env ? { env: scope.env } : {}),
    ...params,
  });
  return projectDocument(document);
}

export function buildExperiencePromotionEvidence(document: ExperienceDocument): string {
  const verification = document.metadata.evidence?.verification;
  const summary = document.metadata.evidence?.summary;
  return [
    `Promoted from agent Experience ${document.id} (revision ${document.revisionHash}).`,
    ...(verification ? [`Verification: ${verification}.`] : []),
    ...(summary ? [summary] : []),
  ].join(" ");
}

async function skillNameInUse(scope: ExperienceScope, name: string): Promise<boolean> {
  const { entries } = await prepareWorkspaceSkillEntries(scope.workspaceDir, {
    config: scope.config,
    agentId: scope.agentId,
    agentSkillFilter: "ignore",
  });
  return entries.some(
    (entry) => entry.skill.documentKind !== "experience" && entry.skill.name === name,
  );
}

export async function promoteExperience(
  scope: ExperienceScope,
  params: Omit<SkillExperiencePromoteParams, "agentId">,
): Promise<{
  record: SkillExperienceRecord;
  revisionHash: string;
  proposal: SkillProposalRecord;
}> {
  const document = await readExperienceFile({
    config: scope.config,
    agentId: scope.agentId,
    id: params.id,
    ...(scope.env ? { env: scope.env } : {}),
  });
  if (document.retired) {
    throw new Error(`Experience is retired; restore it before promoting: ${params.id}`);
  }
  if (document.revisionHash !== params.expectedRevisionHash) {
    throw new ExperienceRevisionChangedError(params.expectedRevisionHash, document.revisionHash);
  }
  if (document.metadata.promotion) {
    const existing = await inspectSkillProposal(document.metadata.promotion.proposalId, {
      config: scope.config,
      agentId: scope.agentId,
      ...(scope.env ? { env: scope.env } : {}),
    });
    if (
      existing &&
      (existing.record.status === "pending" || existing.record.status === "applied")
    ) {
      throw new Error(
        `Experience already has a ${existing.record.status} promotion proposal (${existing.record.id}); review or wait for it instead of promoting again.`,
      );
    }
  }
  const targetName = params.target.kind === "create" ? params.target.name : params.target.skillName;
  const description =
    normalizeOptionalString(
      params.target.kind === "create" ? params.target.description : params.target.description,
    ) ?? document.metadata.description;
  if (params.target.kind === "create") {
    if (targetName !== document.metadata.name) {
      throw new Error(
        `A new Skill must keep the Experience name (${document.metadata.name}); update the document name or promote into an existing Skill.`,
      );
    }
    if (await skillNameInUse(scope, targetName)) {
      throw new Error(
        `Skill ${targetName} already exists. Promote into that Skill instead of overwriting it.`,
      );
    }
  }
  const origin = document.metadata.origin
    ? {
        ...(document.metadata.origin.agentId ? { agentId: document.metadata.origin.agentId } : {}),
        ...(document.metadata.origin.sessionKey
          ? { sessionKey: document.metadata.origin.sessionKey }
          : {}),
        ...(document.metadata.origin.runId ? { runId: document.metadata.origin.runId } : {}),
        ...(document.metadata.origin.messageId
          ? { messageId: document.metadata.origin.messageId }
          : {}),
      }
    : undefined;
  const evidence = buildExperiencePromotionEvidence(document);
  const proposal = await (params.target.kind === "create"
    ? proposeCreateSkill({
        config: scope.config,
        workspaceDir: scope.workspaceDir,
        agentId: scope.agentId,
        ...(scope.env ? { env: scope.env } : {}),
        ...(origin ? { origin } : {}),
        name: params.target.name,
        description,
        content: document.body,
        goal: `Promote Experience ${document.id}.`,
        evidence,
      })
    : proposeUpdateSkill({
        config: scope.config,
        workspaceDir: scope.workspaceDir,
        agentId: scope.agentId,
        ...(scope.env ? { env: scope.env } : {}),
        ...(origin ? { origin } : {}),
        skillName: params.target.skillName,
        description,
        content: document.body,
        goal: `Promote Experience ${document.id}.`,
        evidence,
      }));
  try {
    const linked = await linkExperiencePromotion({
      config: scope.config,
      agentId: scope.agentId,
      ...(scope.env ? { env: scope.env } : {}),
      id: document.id,
      expectedRevisionHash: params.expectedRevisionHash,
      promotion: {
        proposalId: proposal.record.id,
        targetKind: params.target.kind,
        targetSkillName: targetName,
      },
    });
    const record = toRecord({
      id: linked.id,
      metadata: linked.metadata,
      revisionHash: linked.revisionHash,
      retired: false,
      promotionState: {
        proposalId: proposal.record.id,
        targetKind: params.target.kind,
        targetSkillName: targetName,
        state: "pending",
        updatedAt: proposal.record.updatedAt,
      },
    });
    return { record, revisionHash: linked.revisionHash, proposal: proposal.record };
  } catch (error) {
    // The Experience changed after the proposal was staged: drop the orphan
    // proposal so a retry cannot accumulate duplicate promotions.
    await rejectSkillProposal({
      config: scope.config,
      workspaceDir: scope.workspaceDir,
      agentId: scope.agentId,
      ...(scope.env ? { env: scope.env } : {}),
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
      reason: "Experience changed while promotion was being recorded.",
    }).catch(() => undefined);
    throw error;
  }
}
