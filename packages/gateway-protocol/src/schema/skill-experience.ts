import type { Static } from "typebox";
import { Type } from "typebox";
import { SkillsProposalRecordResultSchema } from "./agents-models-skills.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString, Sha256String } from "./primitives.js";

const ExperienceNameString = Type.String({ minLength: 1, maxLength: 120 });
const ExperienceDescriptionString = Type.String({ minLength: 1, maxLength: 400 });
const ExperienceTagString = Type.String({ minLength: 1, maxLength: 64 });

const SkillExperienceStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("promoted"),
  Type.Literal("retired"),
]);

const SkillExperienceCaptureSchema = Type.Union([
  Type.Literal("manual"),
  Type.Literal("automatic"),
  Type.Literal("learning-session"),
]);

const SkillExperienceOriginSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  messageId: Type.Optional(NonEmptyString),
});

const SkillExperienceEvidenceSchema = closedObject({
  verification: Type.Union([
    Type.Literal("observed"),
    Type.Literal("reported"),
    Type.Literal("unverified"),
  ]),
  summary: Type.Optional(Type.String({ maxLength: 2_000 })),
});

const SkillExperienceProjectSchema = closedObject({
  workspaceDir: Type.Optional(NonEmptyString),
  skillFile: Type.Optional(NonEmptyString),
});

/** Latest promotion attempt, projected from the Workshop proposal owner at read time. */
const SkillExperiencePromotionSchema = closedObject({
  proposalId: NonEmptyString,
  targetKind: Type.Union([Type.Literal("create"), Type.Literal("update")]),
  targetSkillName: NonEmptyString,
  state: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("rejected")]),
  updatedAt: Type.Optional(NonEmptyString),
});

/** Agent-private EXPERIENCE.md document. Filesystem documents are the only source of truth. */
export const SkillExperienceRecordSchema = closedObject({
  schema: Type.Literal("openclaw.skill-workshop.experience.v1"),
  id: ExperienceNameString,
  status: SkillExperienceStatusSchema,
  name: ExperienceNameString,
  description: ExperienceDescriptionString,
  tags: Type.Optional(Type.Array(ExperienceTagString, { maxItems: 20 })),
  createdAt: NonEmptyString,
  updatedAt: NonEmptyString,
  revisionHash: Sha256String,
  capture: Type.Optional(SkillExperienceCaptureSchema),
  origin: Type.Optional(SkillExperienceOriginSchema),
  evidence: Type.Optional(SkillExperienceEvidenceSchema),
  project: Type.Optional(SkillExperienceProjectSchema),
  promotion: Type.Optional(SkillExperiencePromotionSchema),
  retiredAt: Type.Optional(NonEmptyString),
  retireReason: Type.Optional(Type.String({ maxLength: 2_000 })),
});

export const SkillExperienceListParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

export const SkillExperienceListResultSchema = closedObject({
  schema: Type.Literal("openclaw.skill-workshop.experiences-manifest.v1"),
  updatedAt: NonEmptyString,
  experiences: Type.Array(SkillExperienceRecordSchema),
  counts: closedObject({
    active: Type.Integer({ minimum: 0 }),
    promoted: Type.Integer({ minimum: 0 }),
    retired: Type.Integer({ minimum: 0 }),
  }),
});

export const SkillExperienceReadParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  id: ExperienceNameString,
});

/** Shared result for Experience writes. */
export const SkillExperienceRecordResultSchema = closedObject({
  record: SkillExperienceRecordSchema,
  revisionHash: Sha256String,
});

/** Reads a single agent-private Experience document with its editable body. */
export const SkillExperienceReadResultSchema = closedObject({
  record: SkillExperienceRecordSchema,
  revisionHash: Sha256String,
  content: Type.String(),
});

export const SkillExperienceCreateParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  name: ExperienceNameString,
  description: ExperienceDescriptionString,
  content: Type.String(),
  tags: Type.Optional(Type.Array(ExperienceTagString, { maxItems: 20 })),
  capture: Type.Optional(SkillExperienceCaptureSchema),
  origin: Type.Optional(SkillExperienceOriginSchema),
  evidence: Type.Optional(SkillExperienceEvidenceSchema),
  project: Type.Optional(SkillExperienceProjectSchema),
});

export const SkillExperienceUpdateParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  id: ExperienceNameString,
  expectedRevisionHash: Sha256String,
  name: Type.Optional(ExperienceNameString),
  description: Type.Optional(ExperienceDescriptionString),
  content: Type.Optional(Type.String()),
  tags: Type.Optional(Type.Array(ExperienceTagString, { maxItems: 20 })),
});

export const SkillExperienceRetireParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  id: ExperienceNameString,
  expectedRevisionHash: Sha256String,
  reason: Type.Optional(Type.String({ maxLength: 2_000 })),
});

export const SkillExperienceRestoreParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  id: ExperienceNameString,
  expectedRevisionHash: Type.Optional(Sha256String),
});

/** Promotion stages a Workshop proposal; it never edits the live skill. */
export const SkillExperiencePromoteTargetSchema = Type.Union([
  closedObject({
    kind: Type.Literal("create"),
    name: ExperienceNameString,
    description: ExperienceDescriptionString,
  }),
  closedObject({
    kind: Type.Literal("update"),
    skillName: ExperienceNameString,
    description: Type.Optional(ExperienceDescriptionString),
  }),
]);

export const SkillExperiencePromoteParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  id: ExperienceNameString,
  expectedRevisionHash: Sha256String,
  target: SkillExperiencePromoteTargetSchema,
});

export const SkillExperiencePromoteResultSchema = closedObject({
  record: SkillExperienceRecordSchema,
  revisionHash: Sha256String,
  proposal: SkillsProposalRecordResultSchema,
});

export type SkillExperienceStatus = Static<typeof SkillExperienceStatusSchema>;
export type SkillExperienceOrigin = Static<typeof SkillExperienceOriginSchema>;
export type SkillExperienceEvidence = Static<typeof SkillExperienceEvidenceSchema>;
export type SkillExperienceProject = Static<typeof SkillExperienceProjectSchema>;
export type SkillExperiencePromotion = Static<typeof SkillExperiencePromotionSchema>;
export type SkillExperienceRecord = Static<typeof SkillExperienceRecordSchema>;
export type SkillExperienceListParams = Static<typeof SkillExperienceListParamsSchema>;
export type SkillExperienceListResult = Static<typeof SkillExperienceListResultSchema>;
export type SkillExperienceReadParams = Static<typeof SkillExperienceReadParamsSchema>;
export type SkillExperienceReadResult = Static<typeof SkillExperienceReadResultSchema>;
export type SkillExperienceCreateParams = Static<typeof SkillExperienceCreateParamsSchema>;
export type SkillExperienceCreateResult = Static<typeof SkillExperienceRecordResultSchema>;
export type SkillExperienceUpdateParams = Static<typeof SkillExperienceUpdateParamsSchema>;
export type SkillExperienceUpdateResult = Static<typeof SkillExperienceRecordResultSchema>;
export type SkillExperienceRetireParams = Static<typeof SkillExperienceRetireParamsSchema>;
export type SkillExperienceRetireResult = Static<typeof SkillExperienceRecordResultSchema>;
export type SkillExperienceRestoreParams = Static<typeof SkillExperienceRestoreParamsSchema>;
export type SkillExperienceRestoreResult = Static<typeof SkillExperienceRecordResultSchema>;
export type SkillExperiencePromoteParams = Static<typeof SkillExperiencePromoteParamsSchema>;
export type SkillExperiencePromoteResult = Static<typeof SkillExperiencePromoteResultSchema>;
