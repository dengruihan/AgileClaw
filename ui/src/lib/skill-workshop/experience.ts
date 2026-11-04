import type {
  SkillExperienceListResult,
  SkillExperiencePromoteParams,
  SkillExperienceRecord,
  SkillExperienceStatus,
  SkillExperienceUpdateResult,
} from "@openclaw/gateway-protocol";

// The Gateway owns the Experience wire records (skill-experience schema); this
// module adds the Control UI's nullable projections and draft models on top.
export type SkillExperienceCapture = NonNullable<SkillExperienceRecord["capture"]>;
export type SkillExperienceVerification = NonNullable<
  SkillExperienceRecord["evidence"]
>["verification"];
export type SkillExperiencePromotionState = NonNullable<
  SkillExperienceRecord["promotion"]
>["state"];
export type SkillExperienceCounts = SkillExperienceListResult["counts"];
// Create/update/retire/restore share one record+revision result shape.
export type SkillExperienceMutationResult = SkillExperienceUpdateResult;
export type SkillExperiencePromoteTarget = SkillExperiencePromoteParams["target"];
export type SkillExperienceFilter = SkillExperienceStatus;

export const SKILL_EXPERIENCE_REVISION_CHANGED = "SKILL_EXPERIENCE_REVISION_CHANGED";

export type SkillWorkshopExperience = SkillExperienceRecord & {
  content: string;
  contentLoaded: boolean;
};

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
