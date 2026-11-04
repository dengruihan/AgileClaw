import { t } from "../../i18n/index.ts";
import {
  loadSkillExperiences,
  promoteSkillExperience,
  reloadSkillExperienceDraftBase,
  restoreSkillExperience,
  retireSkillExperience,
  saveSkillExperienceDraft,
  selectSkillExperience,
  showSkillExperienceNotice,
} from "./experience.ts";
import { setSkillWorkshopMode } from "./header-controls.ts";
import { loadSkillWorkshopProposals, selectSkillWorkshopProposal } from "./proposals.ts";
import type { SkillWorkshopContext } from "./proposals.ts";
import type { SkillWorkshopState } from "./state.ts";

export type SkillExperienceActionOptions = {
  isCurrent: () => boolean;
  onProgress: () => void;
};

export async function loadSkillExperienceSection(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options: SkillExperienceActionOptions,
  force = true,
): Promise<void> {
  await loadSkillExperiences(state, context, {
    force,
    isCurrent: options.isCurrent,
    onProgress: options.onProgress,
  });
}

export async function saveSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options: SkillExperienceActionOptions,
): Promise<void> {
  const outcome = await saveSkillExperienceDraft(state, context, {
    isCurrent: options.isCurrent,
    onProgress: options.onProgress,
  });
  if (!options.isCurrent()) {
    return;
  }
  if (outcome === "saved") {
    showSkillExperienceNotice(
      state,
      t("skillWorkshop.experience.notices.saved"),
      options.onProgress,
    );
    await loadSkillExperiences(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
  }
  options.onProgress();
}

export async function reloadSkillExperienceConflict(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options: SkillExperienceActionOptions,
): Promise<void> {
  const reloaded = await reloadSkillExperienceDraftBase(state, context, {
    isCurrent: options.isCurrent,
    onProgress: options.onProgress,
  });
  const draft = state.skillWorkshopExperienceDraft;
  if (reloaded && options.isCurrent() && draft) {
    draft.notice = t("skillWorkshop.experience.draft.reloaded");
  }
  options.onProgress();
}

export async function promoteAndReviewSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options: SkillExperienceActionOptions,
): Promise<void> {
  const outcome = await promoteSkillExperience(state, context, {
    isCurrent: options.isCurrent,
    onProgress: options.onProgress,
  });
  if (!options.isCurrent()) {
    return;
  }
  if (outcome.status === "promoted") {
    // Promotion only stages a pending proposal; review stays in Suggestions.
    setSkillWorkshopMode(state, "suggestions", options.onProgress);
    showSkillExperienceNotice(
      state,
      t("skillWorkshop.experience.notices.promoted"),
      options.onProgress,
    );
    await loadSkillWorkshopProposals(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
    if (!options.isCurrent()) {
      return;
    }
    await selectSkillWorkshopProposal(state, context, outcome.proposalId);
  } else if (outcome.status === "conflict") {
    const draft = state.skillWorkshopExperiencePromoteDraft;
    if (draft) {
      draft.error = t("skillWorkshop.experience.promote.conflict");
    }
    await loadSkillExperiences(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
  }
  options.onProgress();
}

export async function retireConfirmedSkillExperience(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  options: SkillExperienceActionOptions,
): Promise<void> {
  const outcome = await retireSkillExperience(state, context, {
    isCurrent: options.isCurrent,
    onProgress: options.onProgress,
  });
  if (!options.isCurrent()) {
    return;
  }
  if (outcome === "saved") {
    showSkillExperienceNotice(
      state,
      t("skillWorkshop.experience.notices.retired"),
      options.onProgress,
    );
    await loadSkillExperiences(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
  } else if (outcome === "conflict") {
    const draft = state.skillWorkshopExperienceRetireDraft;
    if (draft) {
      draft.error = t("skillWorkshop.experience.retire.conflict");
    }
    await loadSkillExperiences(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
  }
  options.onProgress();
}

export async function restoreSkillExperienceFromDetail(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  experienceId: string,
  options: SkillExperienceActionOptions,
): Promise<void> {
  const outcome = await restoreSkillExperience(state, context, experienceId, {
    isCurrent: options.isCurrent,
    onProgress: options.onProgress,
  });
  if (!options.isCurrent()) {
    return;
  }
  if (outcome.status === "saved") {
    showSkillExperienceNotice(
      state,
      t("skillWorkshop.experience.notices.restored"),
      options.onProgress,
    );
  } else if (outcome.status === "conflict") {
    showSkillExperienceNotice(
      state,
      t("skillWorkshop.experience.notices.conflict"),
      options.onProgress,
    );
  } else if (outcome.status === "error") {
    showSkillExperienceNotice(state, outcome.message, options.onProgress);
  }
  if (outcome.status === "saved" || outcome.status === "conflict") {
    await loadSkillExperiences(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
    if (outcome.status === "saved" && options.isCurrent()) {
      // The write response can lag the proposal projection (M43 restores the
      // document before projecting its promotion link). Reconcile the filter
      // and selection from the authoritative refreshed row instead of the
      // write's status hint, so a promoted restore stays selected.
      const restored = state.skillWorkshopExperiences.find((entry) => entry.id === experienceId);
      if (restored) {
        state.skillWorkshopExperienceFilter = restored.status;
        await selectSkillExperience(state, context, restored.id);
      }
    }
  }
  options.onProgress();
}

export async function openSkillExperienceProposal(
  state: SkillWorkshopState,
  context: SkillWorkshopContext,
  proposalId: string,
  options: SkillExperienceActionOptions,
): Promise<void> {
  state.skillWorkshopQuery = "";
  setSkillWorkshopMode(state, "suggestions", options.onProgress);
  if (!state.skillWorkshopProposals.some((proposal) => proposal.key === proposalId)) {
    await loadSkillWorkshopProposals(state, context, {
      force: true,
      isCurrent: options.isCurrent,
      onProgress: options.onProgress,
    });
  }
  if (!options.isCurrent()) {
    return;
  }
  await selectSkillWorkshopProposal(state, context, proposalId);
  options.onProgress();
}
