import { html, nothing } from "lit";
import { pathForRoute } from "../../app-route-paths.ts";
import { renderAgentScopeControl } from "../../components/agent-scope-control.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { sessionNavigationTarget } from "../../lib/sessions/route-navigation.ts";
import {
  filterSkillWorkshopProposals,
  type SkillWorkshopMode,
} from "../../lib/skill-workshop/index.ts";
import { renderPluginsHubHeader } from "../plugins/plugins-hub-header.ts";
import { PLUGINS_HUB_PANEL_ID } from "../plugins/plugins-hub.ts";
import {
  canCallWorkshopAdminMethod,
  resolveWorkshopAccess,
  type SkillWorkshopAdminMethod,
} from "./access.ts";
import {
  cancelSkillExperienceDraft,
  cancelSkillExperiencePromoteDraft,
  cancelSkillExperienceRetireDraft,
  selectSkillExperience,
  setSkillExperienceFilter,
  setSkillExperienceQuery,
  startEditSkillExperienceDraft,
  startNewSkillExperienceDraft,
  startSkillExperiencePromoteDraft,
  startSkillExperienceRetireDraft,
} from "./experience.ts";
import { renderSkillWorkshopHeaderControls, setSkillWorkshopMode } from "./header-controls.ts";
import type { SkillWorkshopRenderContext } from "./page-types.ts";
import {
  selectSkillWorkshopInstalledSkill,
  selectSkillWorkshopProposal,
  type SkillWorkshopState,
} from "./proposals.ts";
import type { SkillExperienceViewProps } from "./view-types.ts";
import { renderSkillWorkshop } from "./view.ts";

registerSkillWorkshopEnglish();

export function renderSkillWorkshopPage(
  state: SkillWorkshopState,
  renderContext: SkillWorkshopRenderContext,
  requestUpdate: () => void,
) {
  const {
    context,
    revisionRecoveryActive,
    workshopAgentName,
    onLifecycleAction,
    onEvaluate,
    onRevisionSubmit,
    selfLearning,
    onSelfLearningToggle,
    learningBusy,
    learningError,
    onLearn,
    onRetry,
    onExperienceRetry,
    onExperienceSave,
    onExperienceReloadConflict,
    onExperiencePromoteSubmit,
    onExperienceRetireSubmit,
    onExperienceRestore,
    onExperienceOpenProposal,
  } = renderContext;
  const access = resolveWorkshopAccess(context.gateway.snapshot);
  const learningAccess = readSessionMethodAccess(context.gateway.snapshot, {
    method: "sessions.create",
  });
  const selectInstalled = (name: string, force = false) => {
    void selectSkillWorkshopInstalledSkill(state, context, name, {
      force,
      onProgress: requestUpdate,
    }).finally(requestUpdate);
    requestUpdate();
  };
  const runAdminAction = (method: SkillWorkshopAdminMethod, action: () => void) => {
    if (!canCallWorkshopAdminMethod(context.gateway.snapshot, method)) {
      return;
    }
    action();
    requestUpdate();
  };
  const selectMode = (mode: SkillWorkshopMode) => {
    state.skillWorkshopQuery = "";
    state.skillWorkshopFilePreviewKey = null;
    setSkillWorkshopMode(state, mode, requestUpdate);
    if (mode === "skills") {
      onRetry();
    } else if (mode === "suggestions") {
      const proposal = filterSkillWorkshopProposals(state.skillWorkshopProposals, "")[0];
      if (proposal) {
        void selectSkillWorkshopProposal(state, context, proposal.key).finally(requestUpdate);
      }
    } else {
      // Promotion state is projected from the proposal owner, so entering the
      // section always re-reads the documents instead of trusting a stale copy.
      onExperienceRetry();
    }
  };
  const experienceProps: SkillExperienceViewProps = {
    experiences: state.skillWorkshopExperiences,
    counts: state.skillWorkshopExperienceCounts,
    loaded: state.skillWorkshopExperienceLoaded,
    loading: state.skillWorkshopExperienceLoading,
    error: state.skillWorkshopExperienceError,
    query: state.skillWorkshopExperienceQuery,
    filter: state.skillWorkshopExperienceFilter,
    selectedId: state.skillWorkshopExperienceSelectedId,
    inspectingId: state.skillWorkshopExperienceInspectingId,
    canCreate: canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.experience.create"),
    canUpdate: canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.experience.update"),
    canPromote: canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.experience.promote"),
    canRetire: canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.experience.retire"),
    canRestore: canCallWorkshopAdminMethod(context.gateway.snapshot, "skills.experience.restore"),
    agentName: workshopAgentName || context.config.current.assistantIdentity.name,
    installedSkills: state.skillWorkshopInstalledSkills,
    draft: state.skillWorkshopExperienceDraft,
    promoteDraft: state.skillWorkshopExperiencePromoteDraft,
    retireDraft: state.skillWorkshopExperienceRetireDraft,
    busy: state.skillWorkshopExperienceBusy,
    notice: state.skillWorkshopExperienceNotice,
    onQueryChange: (query) => {
      setSkillExperienceQuery(state, query);
      const selectedId = state.skillWorkshopExperienceSelectedId;
      if (selectedId) {
        void selectSkillExperience(state, context, selectedId).finally(requestUpdate);
      }
      requestUpdate();
    },
    onFilterChange: (filter) => {
      setSkillExperienceFilter(state, filter);
      const selectedId = state.skillWorkshopExperienceSelectedId;
      if (selectedId) {
        void selectSkillExperience(state, context, selectedId).finally(requestUpdate);
      }
      requestUpdate();
    },
    onSelect: (id) => {
      void selectSkillExperience(state, context, id).finally(requestUpdate);
      requestUpdate();
    },
    onRetry: onExperienceRetry,
    onNew: () => {
      startNewSkillExperienceDraft(state);
      requestUpdate();
    },
    onEdit: (experience) => {
      startEditSkillExperienceDraft(state, experience);
      requestUpdate();
    },
    onCancelDraft: () => {
      cancelSkillExperienceDraft(state);
      requestUpdate();
    },
    onDraftChange: (patch) => {
      const draft = state.skillWorkshopExperienceDraft;
      if (!draft) {
        return;
      }
      Object.assign(draft, patch, { notice: null });
      requestUpdate();
    },
    onSave: onExperienceSave,
    onReloadConflict: onExperienceReloadConflict,
    onPromoteOpen: (experience) => {
      startSkillExperiencePromoteDraft(state, experience);
      requestUpdate();
    },
    onPromoteCancel: () => {
      cancelSkillExperiencePromoteDraft(state);
      requestUpdate();
    },
    onPromoteDraftChange: (patch) => {
      const draft = state.skillWorkshopExperiencePromoteDraft;
      if (!draft) {
        return;
      }
      Object.assign(draft, patch);
      if (patch.targetKind === "update" && !draft.skillName) {
        draft.skillName = state.skillWorkshopInstalledSkills[0]?.name ?? "";
      }
      requestUpdate();
    },
    onPromoteSubmit: onExperiencePromoteSubmit,
    onRetireOpen: (experience) => {
      startSkillExperienceRetireDraft(state, experience);
      requestUpdate();
    },
    onRetireCancel: () => {
      cancelSkillExperienceRetireDraft(state);
      requestUpdate();
    },
    onRetireReasonChange: (reason) => {
      const draft = state.skillWorkshopExperienceRetireDraft;
      if (draft) {
        draft.reason = reason;
        requestUpdate();
      }
    },
    onRetireSubmit: onExperienceRetireSubmit,
    onRestore: onExperienceRestore,
    onOpenProposal: onExperienceOpenProposal,
    onOpenSession: (experience) => {
      const sessionKey = experience.origin?.sessionKey;
      if (!sessionKey) {
        return;
      }
      context.navigate(
        "chat",
        sessionNavigationTarget({
          context,
          face: "chat",
          sessionKey,
          agentId: experience.origin?.agentId ?? state.skillWorkshopAgentId ?? undefined,
        }).options,
      );
    },
  };

  return html`
    <section class="content--skill-workshop">
      ${renderPluginsHubHeader({
        active: "skill-workshop",
        onSelect: (tab) => context.navigate(tab),
      })}
      <wa-tab-panel
        id=${PLUGINS_HUB_PANEL_ID}
        class="sw-hub-panel"
        name="skill-workshop"
        active
        aria-labelledby="plugins-tab-skill-workshop"
      >
        <div class="sw-workshop-toolbar">
          ${renderAgentScopeControl({
            agents: context.agents.state.agentsList?.agents ?? [],
            selection: context.agentSelection,
            selectedId: state.skillWorkshopAgentId,
            allowAll: false,
          })}
          ${renderSkillWorkshopHeaderControls(state, {
            ...renderContext,
            automationHref: `${pathForRoute("automation", context.basePath)}?section=cron`,
            onModeChange: selectMode,
          })}
          <button
            type="button"
            class="btn sw-learn-button"
            ?disabled=${learningBusy || !learningAccess.allowed}
            title=${learningAccess.allowed ? t("skillWorkshop.learning.description") : learningAccess.reason}
            @click=${onLearn}
          >
            <span aria-hidden="true">${icons.wandSparkles}</span>
            ${learningBusy ? t("skillWorkshop.learning.starting") : t("skillWorkshop.learning.start")}
          </button>
        </div>
        ${learningError ? html`<div class="sw-error" role="alert">${learningError}</div>` : nothing}
        ${(() => {
          const visibleProposals = filterSkillWorkshopProposals(
            state.skillWorkshopProposals,
            state.skillWorkshopQuery,
          );
          const isSelectedProposal = (proposal: (typeof visibleProposals)[number]) =>
            proposal.key === state.skillWorkshopSelectedKey;
          const selectedIndex = visibleProposals.findIndex(isSelectedProposal);
          const selectProposal = (key: string) => {
            state.skillWorkshopFilePreviewKey = null;
            void selectSkillWorkshopProposal(state, context, key).finally(requestUpdate);
            requestUpdate();
          };
          const selectRelativeProposal = (delta: -1 | 1) => {
            if (visibleProposals.length === 0) {
              return;
            }
            const nextIndex =
              selectedIndex < 0
                ? 0
                : (selectedIndex + delta + visibleProposals.length) % visibleProposals.length;
            const nextProposal = visibleProposals[nextIndex];
            if (nextProposal) {
              selectProposal(nextProposal.key);
            }
          };
          const selectVisibleFallback = (proposals: typeof visibleProposals) => {
            if (proposals.length === 0 || proposals.some(isSelectedProposal)) {
              return;
            }
            const firstProposal = proposals[0];
            if (firstProposal) {
              selectProposal(firstProposal.key);
            }
          };
          return html`<wa-tab-panel
            id="skill-workshop-mode-panel"
            name=${state.skillWorkshopMode}
            active
            aria-labelledby=${`skill-workshop-mode-tab-${state.skillWorkshopMode}`}
          >
            ${renderSkillWorkshop({
              access,
              loading: state.skillWorkshopLoading,
              error: state.skillWorkshopError,
              inspectingKey: state.skillWorkshopInspectingKey,
              proposals: state.skillWorkshopProposals,
              installedSkills: state.skillWorkshopInstalledSkills,
              installedSelection: state.skillWorkshopInstalledSkills.find(
                (skill) =>
                  skill.name ===
                  (state.skillWorkshopInstalledName ?? state.skillWorkshopInstalledSkills[0]?.name),
              )?.read ?? { status: "idle" },
              onSelectInstalled: selectInstalled,
              onRetryInstalled: () => {
                const name = state.skillWorkshopInstalledName;
                if (name) {
                  selectInstalled(name, true);
                }
              },
              selectedKey: state.skillWorkshopSelectedKey,
              query: state.skillWorkshopQuery,
              filePreviewKey: state.skillWorkshopFilePreviewKey,
              filePreviewQuery: state.skillWorkshopFilePreviewQuery,
              queueWidth: state.skillWorkshopQueueWidth,
              mode: state.skillWorkshopMode,
              actionBusy: state.skillWorkshopActionBusy,
              actionNotice: state.skillWorkshopActionNotice,
              revisionKey: state.skillWorkshopRevisionKey,
              revisionDraft: state.skillWorkshopRevisionDraft,
              revisionRecoveryActive,
              assistantName: context.config.current.assistantIdentity.name,
              workshopAgentName,
              selfLearning,
              experience: experienceProps,
              onRetry,
              onQueryChange: (query) => {
                state.skillWorkshopQuery = query;
                requestUpdate();
                if (state.skillWorkshopMode === "suggestions") {
                  selectVisibleFallback(
                    filterSkillWorkshopProposals(state.skillWorkshopProposals, query),
                  );
                }
              },
              onFilePreviewQueryChange: (query) => {
                state.skillWorkshopFilePreviewQuery = query;
                requestUpdate();
              },
              onQueueWidthChange: (width) => {
                state.skillWorkshopQueueWidth = width;
                requestUpdate();
              },
              onModeChange: selectMode,
              onSelect: selectProposal,
              onPrev: () => selectRelativeProposal(-1),
              onNext: () => selectRelativeProposal(1),
              onApply: (decision) =>
                runAdminAction("skills.proposals.apply", () =>
                  onLifecycleAction("apply", decision),
                ),
              onEvaluate: (key) =>
                runAdminAction("skills.proposals.evaluate", () => onEvaluate(key)),
              onRevise: (key) =>
                runAdminAction("skills.proposals.requestRevision", () => {
                  state.skillWorkshopRevisionKey = key;
                  state.skillWorkshopRevisionDraft = "";
                }),
              onReject: (decision) =>
                runAdminAction("skills.proposals.reject", () =>
                  onLifecycleAction("reject", decision),
                ),
              onRevisionDraftChange: (draft) => {
                state.skillWorkshopRevisionDraft = draft;
                requestUpdate();
              },
              onRevisionCancel: () => {
                if (revisionRecoveryActive) {
                  return;
                }
                state.skillWorkshopRevisionKey = null;
                state.skillWorkshopRevisionDraft = "";
                requestUpdate();
              },
              onRevisionSubmit: (key) =>
                canCallWorkshopAdminMethod(
                  context.gateway.snapshot,
                  "skills.proposals.requestRevision",
                )
                  ? onRevisionSubmit(key)
                  : undefined,
              onPreviewFile: (key, path) => {
                state.skillWorkshopSelectedKey = key;
                state.skillWorkshopFilePreviewKey = path;
                requestUpdate();
              },
              onClosePreview: () => {
                state.skillWorkshopFilePreviewKey = null;
                state.skillWorkshopFilePreviewQuery = "";
                requestUpdate();
              },
              onSelfLearningToggle,
            })}
          </wa-tab-panel>`;
        })()}
      </wa-tab-panel>
    </section>
  `;
}
