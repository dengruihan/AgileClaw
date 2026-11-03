import type { SkillsProposalRecordResult } from "@openclaw/gateway-protocol";

// Wire contract owned by skills.experience.* (skill-experience schema). Mirrored
// here so the Control UI can build before that protocol module merges; the
// Gateway remains the only writer of these records.
export type SkillExperienceStatus = "active" | "promoted" | "retired";
export type SkillExperienceCapture = "manual" | "automatic" | "learning-session";
export type SkillExperienceVerification = "observed" | "reported" | "unverified";
export type SkillExperiencePromotionState = "pending" | "applied" | "rejected";

export type SkillExperienceRecord = {
  schema: "openclaw.skill-workshop.experience.v1";
  id: string;
  status: SkillExperienceStatus;
  name: string;
  description: string;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
  revisionHash: string;
  capture?: SkillExperienceCapture;
  origin?: {
    agentId?: string;
    sessionKey?: string;
    runId?: string;
    messageId?: string;
  };
  evidence?: {
    verification: SkillExperienceVerification;
    summary?: string;
  };
  project?: { workspaceDir?: string; skillFile?: string };
  promotion?: {
    proposalId: string;
    targetKind: "create" | "update";
    targetSkillName: string;
    state: SkillExperiencePromotionState;
    updatedAt?: string;
  };
  retiredAt?: string;
  retireReason?: string;
};

export type SkillExperienceCounts = {
  active: number;
  promoted: number;
  retired: number;
};

export type SkillExperienceListResult = {
  schema: "openclaw.skill-workshop.experiences-manifest.v1";
  updatedAt: string;
  experiences: SkillExperienceRecord[];
  counts: SkillExperienceCounts;
};

export type SkillExperienceReadResult = {
  record: SkillExperienceRecord;
  revisionHash: string;
  content: string;
};

// Writes and retire/restore return the record only; the body stays with the
// document owner and arrives through read.
export type SkillExperienceMutationResult = {
  record: SkillExperienceRecord;
  revisionHash: string;
};

export type SkillExperiencePromoteTarget =
  | { kind: "create"; name: string; description: string }
  | { kind: "update"; skillName: string; description?: string };

export type SkillExperiencePromoteResult = {
  record: SkillExperienceRecord;
  revisionHash: string;
  proposal: SkillsProposalRecordResult;
};

export const SKILL_EXPERIENCE_REVISION_CHANGED = "SKILL_EXPERIENCE_REVISION_CHANGED";

export type SkillWorkshopExperience = SkillExperienceRecord & {
  content: string;
  contentLoaded: boolean;
};

export type SkillExperienceFilter = SkillExperienceStatus;

export type SkillExperienceDraft = {
  mode: "create" | "edit";
  id: string | null;
  name: string;
  description: string;
  content: string;
  baseRevisionHash: string | null;
  saving: boolean;
  error: string | null;
  conflictHeld: boolean;
  notice: string | null;
};

export type SkillExperiencePromoteDraft = {
  id: string;
  experienceName: string;
  experienceDescription: string;
  targetKind: "create" | "update";
  skillName: string;
  description: string;
  busy: boolean;
  error: string | null;
};

export type SkillExperienceRetireDraft = {
  id: string;
  experienceName: string;
  reason: string;
  busy: boolean;
  error: string | null;
};

export function filterSkillExperiences(
  experiences: SkillWorkshopExperience[],
  query: string,
  status: SkillExperienceFilter,
): SkillWorkshopExperience[] {
  const q = query.trim().toLowerCase();
  return experiences.filter(
    (experience) =>
      experience.status === status &&
      (!q ||
        `${experience.name} ${experience.description} ${(experience.tags ?? []).join(" ")}`
          .toLowerCase()
          .includes(q)),
  );
}

export function sortSkillExperiences(
  experiences: SkillWorkshopExperience[],
): SkillWorkshopExperience[] {
  return experiences.toSorted(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}
