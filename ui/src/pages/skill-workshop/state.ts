import type {
  SkillExperienceCounts,
  SkillExperienceDraft,
  SkillExperienceFilter,
  SkillExperiencePromoteDraft,
  SkillExperienceRetireDraft,
  SkillWorkshopExperience,
} from "../../lib/skill-workshop/experience.ts";
import type {
  SkillWorkshopActionBusy,
  SkillWorkshopActionNotice,
  SkillWorkshopInstalledSkill,
  SkillWorkshopMode,
  SkillWorkshopProposal,
} from "../../lib/skill-workshop/index.ts";

export type SkillWorkshopExperienceBusy = {
  id: string;
  action: "retire" | "restore";
};

export type SkillWorkshopState = {
  skillWorkshopAgentId: string | null;
  skillWorkshopLoading: boolean;
  skillWorkshopLoaded: boolean;
  skillWorkshopError: string | null;
  skillWorkshopInspectingKey: string | null;
  skillWorkshopProposals: SkillWorkshopProposal[];
  skillWorkshopInstalledSkills: SkillWorkshopInstalledSkill[];
  skillWorkshopInstalledName: string | null;
  skillWorkshopSelectedKey: string | null;
  skillWorkshopActionBusy: SkillWorkshopActionBusy | null;
  skillWorkshopActionNotice: SkillWorkshopActionNotice | null;
  skillWorkshopActionNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
  skillWorkshopRevisionKey: string | null;
  skillWorkshopRevisionDraft: string;
  skillWorkshopQuery: string;
  skillWorkshopFilePreviewKey: string | null;
  skillWorkshopFilePreviewQuery: string;
  skillWorkshopQueueWidth: number;
  skillWorkshopMode: SkillWorkshopMode;
  skillWorkshopExperiences: SkillWorkshopExperience[];
  skillWorkshopExperienceCounts: SkillExperienceCounts | null;
  skillWorkshopExperienceLoading: boolean;
  skillWorkshopExperienceLoaded: boolean;
  skillWorkshopExperienceError: string | null;
  skillWorkshopExperienceSelectedId: string | null;
  skillWorkshopExperienceInspectingId: string | null;
  skillWorkshopExperienceQuery: string;
  skillWorkshopExperienceFilter: SkillExperienceFilter;
  skillWorkshopExperienceDraft: SkillExperienceDraft | null;
  skillWorkshopExperiencePromoteDraft: SkillExperiencePromoteDraft | null;
  skillWorkshopExperienceRetireDraft: SkillExperienceRetireDraft | null;
  skillWorkshopExperienceBusy: SkillWorkshopExperienceBusy | null;
  skillWorkshopExperienceNotice: string | null;
  skillWorkshopExperienceNoticeTimer?: ReturnType<typeof globalThis.setTimeout> | number | null;
};

// Experience rows carry a Gateway revision, so an agent or connection change
// must not let a prior scope's list or draft survive into the new one.
export function resetSkillExperienceState(state: SkillWorkshopState): void {
  if (state.skillWorkshopExperienceNoticeTimer) {
    globalThis.clearTimeout(state.skillWorkshopExperienceNoticeTimer);
  }
  state.skillWorkshopExperiences = [];
  state.skillWorkshopExperienceCounts = null;
  state.skillWorkshopExperienceLoading = false;
  state.skillWorkshopExperienceLoaded = false;
  state.skillWorkshopExperienceError = null;
  state.skillWorkshopExperienceSelectedId = null;
  state.skillWorkshopExperienceInspectingId = null;
  state.skillWorkshopExperienceQuery = "";
  state.skillWorkshopExperienceFilter = "active";
  state.skillWorkshopExperienceDraft = null;
  state.skillWorkshopExperiencePromoteDraft = null;
  state.skillWorkshopExperienceRetireDraft = null;
  state.skillWorkshopExperienceBusy = null;
  state.skillWorkshopExperienceNotice = null;
  state.skillWorkshopExperienceNoticeTimer = null;
}

export function createSkillWorkshopState(): SkillWorkshopState {
  return {
    skillWorkshopAgentId: null,
    skillWorkshopLoading: false,
    skillWorkshopLoaded: false,
    skillWorkshopError: null,
    skillWorkshopInspectingKey: null,
    skillWorkshopProposals: [],
    skillWorkshopInstalledSkills: [],
    skillWorkshopInstalledName: null,
    skillWorkshopSelectedKey: null,
    skillWorkshopActionBusy: null,
    skillWorkshopActionNotice: null,
    skillWorkshopActionNoticeTimer: null,
    skillWorkshopRevisionKey: null,
    skillWorkshopRevisionDraft: "",
    skillWorkshopQuery: "",
    skillWorkshopFilePreviewKey: null,
    skillWorkshopFilePreviewQuery: "",
    skillWorkshopQueueWidth: 360,
    skillWorkshopMode: "skills",
    skillWorkshopExperiences: [],
    skillWorkshopExperienceCounts: null,
    skillWorkshopExperienceLoading: false,
    skillWorkshopExperienceLoaded: false,
    skillWorkshopExperienceError: null,
    skillWorkshopExperienceSelectedId: null,
    skillWorkshopExperienceInspectingId: null,
    skillWorkshopExperienceQuery: "",
    skillWorkshopExperienceFilter: "active",
    skillWorkshopExperienceDraft: null,
    skillWorkshopExperiencePromoteDraft: null,
    skillWorkshopExperienceRetireDraft: null,
    skillWorkshopExperienceBusy: null,
    skillWorkshopExperienceNotice: null,
    skillWorkshopExperienceNoticeTimer: null,
  };
}
