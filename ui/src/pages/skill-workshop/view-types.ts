import type {
  SkillExperienceCounts,
  SkillExperienceDraft,
  SkillExperienceFilter,
  SkillExperiencePromoteDraft,
  SkillExperiencePromoteTarget,
  SkillExperienceRetireDraft,
  SkillWorkshopExperience,
} from "../../lib/skill-workshop/experience.ts";
import type {
  SkillWorkshopActionBusy,
  SkillWorkshopActionNotice,
  SkillWorkshopInstalledSkill,
  SkillWorkshopInstalledSelection,
  SkillWorkshopMode,
  SkillWorkshopProposal,
  SkillWorkshopProposalDecision,
} from "../../lib/skill-workshop/index.ts";
import type { SkillWorkshopAccess } from "./access.ts";
import type { SkillWorkshopSelfLearning } from "./self-learning.ts";
import type { SkillWorkshopExperienceBusy } from "./state.ts";

export type SkillExperienceViewProps = {
  experiences: SkillWorkshopExperience[];
  counts: SkillExperienceCounts | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  query: string;
  filter: SkillExperienceFilter;
  selectedId: string | null;
  inspectingId: string | null;
  canCreate: boolean;
  canUpdate: boolean;
  canPromote: boolean;
  canRetire: boolean;
  canRestore: boolean;
  agentName: string;
  installedSkills: SkillWorkshopInstalledSkill[];
  draft: SkillExperienceDraft | null;
  promoteDraft: SkillExperiencePromoteDraft | null;
  retireDraft: SkillExperienceRetireDraft | null;
  busy: SkillWorkshopExperienceBusy | null;
  notice: string | null;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: SkillExperienceFilter) => void;
  onSelect: (id: string) => void;
  onRetry: () => void;
  onNew: () => void;
  onEdit: (experience: SkillWorkshopExperience) => void;
  onCancelDraft: () => void;
  onDraftChange: (patch: { name?: string; description?: string; content?: string }) => void;
  onSave: () => void;
  onReloadConflict: () => void;
  onPromoteOpen: (experience: SkillWorkshopExperience) => void;
  onPromoteCancel: () => void;
  onPromoteDraftChange: (patch: {
    targetKind?: SkillExperiencePromoteTarget["kind"];
    name?: string;
    skillName?: string;
    description?: string;
  }) => void;
  onPromoteSubmit: () => void;
  onRetireOpen: (experience: SkillWorkshopExperience) => void;
  onRetireCancel: () => void;
  onRetireReasonChange: (reason: string) => void;
  onRetireSubmit: () => void;
  onRestore: (experience: SkillWorkshopExperience) => void;
  onOpenProposal: (proposalId: string) => void;
  onOpenSession: (experience: SkillWorkshopExperience) => void;
};

export type SkillWorkshopProps = {
  access: SkillWorkshopAccess;
  loading: boolean;
  error: string | null;
  inspectingKey: string | null;
  proposals: SkillWorkshopProposal[];
  installedSkills: SkillWorkshopInstalledSkill[];
  installedSelection: SkillWorkshopInstalledSelection;
  onSelectInstalled: (name: string) => void;
  onRetryInstalled: () => void;
  selectedKey: string | null;
  query: string;
  filePreviewKey: string | null;
  filePreviewQuery: string;
  queueWidth: number;
  mode: SkillWorkshopMode;
  actionBusy: SkillWorkshopActionBusy | null;
  actionNotice: SkillWorkshopActionNotice | null;
  revisionKey: string | null;
  revisionDraft: string;
  revisionRecoveryActive: boolean;
  assistantName: string;
  workshopAgentName: string;
  selfLearning: SkillWorkshopSelfLearning | null;
  experience: SkillExperienceViewProps;
  onRetry: () => void;
  onQueryChange: (query: string) => void;
  onFilePreviewQueryChange: (query: string) => void;
  onQueueWidthChange: (width: number) => void;
  onModeChange: (mode: SkillWorkshopMode) => void;
  onSelect: (key: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onApply: (decision: SkillWorkshopProposalDecision) => void;
  onEvaluate: (key: string) => void;
  onRevise: (key: string) => void;
  onReject: (decision: SkillWorkshopProposalDecision) => void;
  onRevisionDraftChange: (draft: string) => void;
  onRevisionCancel: () => void;
  onRevisionSubmit: (key: string) => void;
  onPreviewFile: (key: string, path: string) => void;
  onClosePreview: () => void;
  onSelfLearningToggle: (enabled: boolean) => void;
};
