import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  filterSkillExperiences,
  type SkillExperienceCapture,
  type SkillExperienceFilter,
  type SkillExperiencePromotionState,
  type SkillExperienceStatus,
  type SkillExperienceVerification,
  type SkillWorkshopExperience,
} from "../../lib/skill-workshop/experience.ts";
import { renderSkillDocument } from "./collection-view.ts";
import {
  renderSkillExperienceDraftDialog,
  renderSkillExperiencePromoteDialog,
  renderSkillExperienceRetireDialog,
} from "./experience-dialogs.ts";
import type { SkillExperienceViewProps } from "./view-types.ts";

registerSkillWorkshopEnglish();

const FILTERS: Array<{ value: SkillExperienceFilter; labelKey: string }> = [
  { value: "active", labelKey: "skillWorkshop.experience.sections.candidate" },
  { value: "promoted", labelKey: "skillWorkshop.experience.sections.promoted" },
  { value: "retired", labelKey: "skillWorkshop.experience.sections.retired" },
];

function statusLabel(status: SkillExperienceStatus): string {
  switch (status) {
    case "promoted":
      return t("skillWorkshop.experience.sections.promoted");
    case "retired":
      return t("skillWorkshop.experience.sections.retired");
    default:
      return t("skillWorkshop.experience.sections.candidate");
  }
}

function captureLabel(capture: SkillExperienceCapture | undefined): string {
  switch (capture) {
    case "automatic":
      return t("skillWorkshop.experience.capture.automatic");
    case "learning-session":
      return t("skillWorkshop.experience.capture.learning");
    case "manual":
      return t("skillWorkshop.experience.capture.manual");
    default:
      return t("skillWorkshop.experience.capture.unknown");
  }
}

function verificationLabel(verification: SkillExperienceVerification): string {
  switch (verification) {
    case "observed":
      return t("skillWorkshop.experience.evidence.observed");
    case "reported":
      return t("skillWorkshop.experience.evidence.reported");
    default:
      return t("skillWorkshop.experience.evidence.unverified");
  }
}

function promotionLabel(state: SkillExperiencePromotionState, target: string): string {
  switch (state) {
    case "applied":
      return t("skillWorkshop.experience.promotion.applied", { skill: target });
    case "rejected":
      return t("skillWorkshop.experience.promotion.rejected");
    default:
      return t("skillWorkshop.experience.promotion.pending", { skill: target });
  }
}

function relativeTime(value: string | undefined): string {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? formatRelativeTimestamp(ms, { dateFallback: true }) : "";
}

function rowMeta(experience: SkillWorkshopExperience): string {
  const promotion = experience.promotion;
  if (experience.status === "promoted" && promotion) {
    return promotionLabel(promotion.state, promotion.targetSkillName);
  }
  if (experience.status === "promoted") {
    return statusLabel("promoted");
  }
  if (experience.status === "retired") {
    return experience.retiredAt
      ? t("skillWorkshop.experience.list.retiredAt", { time: relativeTime(experience.retiredAt) })
      : statusLabel("retired");
  }
  return `${captureLabel(experience.capture)} · ${relativeTime(experience.updatedAt)}`;
}

function renderFilterChip(props: SkillExperienceViewProps, filter: SkillExperienceFilter) {
  const label = FILTERS.find((entry) => entry.value === filter);
  const active = props.filter === filter;
  const countsKnown = props.loaded && !props.loading && !props.error;
  const count = countsKnown ? (props.counts?.[filter] ?? 0) : null;
  return html`
    <button
      type="button"
      class="sw-experience__chip ${active ? "is-active" : ""}"
      aria-pressed=${active ? "true" : "false"}
      @click=${() => props.onFilterChange(filter)}
    >
      <span>${t(label?.labelKey ?? "skillWorkshop.experience.sections.candidate")}</span>
      ${count === null ? nothing : html`<span class="sw-experience__chip-count">${count}</span>`}
    </button>
  `;
}

function renderListState(message: string, options?: { busy?: boolean; retry?: () => void }) {
  return html`
    <div class="sw-experience__state" role=${options?.retry ? "alert" : "status"}>
      <p class="sw-empty__sub">${message}</p>
      ${
        options?.retry
          ? html`<button type="button" class="sw-btn sw-btn--sm" @click=${options.retry}>
              ${t("pluginsPage.tryAgain")}
            </button>`
          : nothing
      }
    </div>
  `;
}

function renderRows(props: SkillExperienceViewProps) {
  const matches = filterSkillExperiences(props.experiences, props.query, props.filter);
  if (props.error && props.experiences.length === 0) {
    return html`<div class="sw-experience__state" role="alert">
      <p class="sw-empty__title">${t("skillWorkshop.experience.list.errorTitle")}</p>
      <p class="sw-empty__sub">${props.error}</p>
      <button type="button" class="sw-btn sw-btn--sm" @click=${props.onRetry}>
        ${t("pluginsPage.tryAgain")}
      </button>
    </div>`;
  }
  if (props.loading && props.experiences.length === 0) {
    return renderListState(t("skillWorkshop.experience.list.loading"), { busy: true });
  }
  if (!props.loaded && props.experiences.length === 0) {
    return renderListState(t("skillWorkshop.experience.list.loading"), { busy: true });
  }
  if (props.experiences.length === 0) {
    return html`
      <div class="sw-experience__state">
        <p class="sw-empty__title">${t("skillWorkshop.experience.list.emptyTitle")}</p>
        <p class="sw-empty__sub">${t("skillWorkshop.experience.list.emptyBody")}</p>
      </div>
    `;
  }
  if (matches.length === 0) {
    return html`
      <div class="sw-experience__state">
        <p class="sw-empty__title">${t("skillWorkshop.experience.list.noMatchTitle")}</p>
        <p class="sw-empty__sub">
          ${
            props.query.trim()
              ? t("skillWorkshop.experience.list.noMatchBody")
              : t("skillWorkshop.experience.list.emptyFilterBody")
          }
        </p>
        ${
          props.query.trim()
            ? html`<button
                type="button"
                class="sw-btn sw-btn--sm"
                @click=${() => props.onQueryChange("")}
              >
                ${t("skillWorkshop.experience.list.clearSearch")}
              </button>`
            : nothing
        }
      </div>
    `;
  }
  return matches.map((experience) => {
    const selected = experience.id === props.selectedId;
    return html`
      <button
        type="button"
        class="sw-experience__row ${selected ? "is-selected" : ""}"
        aria-current=${selected ? "true" : nothing}
        @click=${() => props.onSelect(experience.id)}
      >
        <span
          class="sw-experience__dot sw-experience__dot--${experience.status}"
          aria-hidden="true"
        ></span>
        <span class="sw-experience__row-main">
          <span class="sw-experience__row-name">${experience.name}</span>
          <span class="sw-experience__row-desc">${experience.description}</span>
          <span class="sw-experience__row-meta">${rowMeta(experience)}</span>
        </span>
      </button>
    `;
  });
}

function renderListPanel(props: SkillExperienceViewProps) {
  return html`
    <aside class="sw-experience__list" aria-label=${t("skillWorkshop.experience.list.aria")}>
      <div class="sw-experience__list-head">
        <div
          class="sw-experience__filters"
          role="group"
          aria-label=${t("skillWorkshop.experience.list.filterAria")}
        >
          ${FILTERS.map((filter) => renderFilterChip(props, filter.value))}
        </div>
        <div class="sw-experience__list-tools">
          <label class="sw-experience__search">
            ${icons.search}
            <input
              type="search"
              aria-label=${t("skillWorkshop.experience.list.searchLabel")}
              placeholder=${t("skillWorkshop.experience.list.search")}
              .value=${props.query}
              @input=${(event: Event) =>
                props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
            />
          </label>
          <button
            type="button"
            class="sw-btn sw-btn--sm sw-btn--primary"
            title=${props.canCreate ? t("skillWorkshop.experience.list.new") : t("skillWorkshop.experience.permission.readOnly")}
            ?disabled=${!props.canCreate}
            @click=${props.onNew}
          >
            ${t("skillWorkshop.experience.list.new")}
          </button>
        </div>
      </div>
      <div class="sw-experience__rows" aria-busy=${props.loading ? "true" : nothing}>
        ${renderRows(props)}
      </div>
    </aside>
  `;
}

function renderSource(props: SkillExperienceViewProps, experience: SkillWorkshopExperience) {
  const origin = experience.origin;
  return html`
    <section class="sw-section">
      <h3 class="sw-section__label">${t("skillWorkshop.experience.source.title")}</h3>
      <dl class="sw-experience__facts">
        <div>
          <dt>${t("skillWorkshop.experience.source.captured")}</dt>
          <dd>${captureLabel(experience.capture)}</dd>
        </div>
        <div>
          <dt>${t("skillWorkshop.experience.source.agent")}</dt>
          <dd>${origin?.agentId ?? props.agentName}</dd>
        </div>
        <div>
          <dt>${t("skillWorkshop.experience.source.session")}</dt>
          <dd>
            ${
              origin?.sessionKey
                ? html`<button
                    type="button"
                    class="sw-detail__meta-link"
                    @click=${() => props.onOpenSession(experience)}
                  >
                    ${t("skillWorkshop.experience.source.openSession")}
                  </button>`
                : t("skillWorkshop.experience.source.none")
            }
          </dd>
        </div>
        ${
          origin?.runId
            ? html`<div>
                <dt>${t("skillWorkshop.experience.source.run")}</dt>
                <dd class="sw-experience__mono">${origin.runId}</dd>
              </div>`
            : nothing
        }
      </dl>
    </section>
  `;
}

function renderEvidence(experience: SkillWorkshopExperience) {
  const evidence = experience.evidence;
  return html`
    <section class="sw-section">
      <h3 class="sw-section__label">${t("skillWorkshop.experience.evidence.title")}</h3>
      <div class="sw-experience__evidence">
        <span
          class="sw-experience__verification sw-experience__verification--${evidence?.verification ?? "unverified"}"
        >
          ${verificationLabel(evidence?.verification ?? "unverified")}
        </span>
        <span class="sw-experience__evidence-summary">
          ${evidence?.summary?.trim() || t("skillWorkshop.experience.evidence.none")}
        </span>
      </div>
    </section>
  `;
}

function renderPromotion(props: SkillExperienceViewProps, experience: SkillWorkshopExperience) {
  const promotion = experience.promotion;
  if (!promotion) {
    return nothing;
  }
  return html`
    <section class="sw-section">
      <h3 class="sw-section__label">${t("skillWorkshop.experience.promotion.title")}</h3>
      <div class="sw-experience__promotion">
        <span>${promotionLabel(promotion.state, promotion.targetSkillName)}</span>
        ${
          promotion.state === "pending"
            ? html`<button
                type="button"
                class="sw-detail__meta-link"
                @click=${() => props.onOpenProposal(promotion.proposalId)}
              >
                ${t("skillWorkshop.experience.promotion.review")}
              </button>`
            : nothing
        }
      </div>
    </section>
  `;
}

function renderDetail(props: SkillExperienceViewProps) {
  const experience = props.experiences.find((entry) => entry.id === props.selectedId);
  const shown =
    experience ?? filterSkillExperiences(props.experiences, props.query, props.filter)[0];
  if (!shown) {
    return html`
      <div class="sw-experience__detail sw-detail--empty">
        <div class="sw-filter-empty">
          <div class="sw-filter-empty__icon" aria-hidden="true">${icons.brain}</div>
          <p class="sw-empty__title">${t("skillWorkshop.experience.detail.emptyTitle")}</p>
          <p class="sw-empty__sub">${t("skillWorkshop.experience.detail.emptyBody")}</p>
          ${
            props.experiences.length === 0 && props.canCreate
              ? html`<button type="button" class="sw-btn sw-btn--primary" @click=${props.onNew}>
                  ${t("skillWorkshop.experience.list.new")}
                </button>`
              : nothing
          }
        </div>
      </div>
    `;
  }
  if (!shown.contentLoaded) {
    return html`
      <div class="sw-experience__detail">
        <div class="sw-detail__head">
          <div class="sw-detail__head-left">
            <h1 class="sw-detail__title">${shown.name}</h1>
            <div class="sw-detail__one-line">${shown.description}</div>
          </div>
        </div>
        <div class="sw-experience__detail-body">
          <p class="sw-muted" role="status">${t("skillWorkshop.experience.detail.loading")}</p>
        </div>
      </div>
    `;
  }
  const edited = shown.updatedAt && shown.updatedAt !== shown.createdAt;
  const busy = props.busy?.id === shown.id ? props.busy.action : null;
  const readOnly = !props.canUpdate || !props.canRetire || !props.canPromote || !props.canRestore;
  const disabledReason = readOnly ? t("skillWorkshop.experience.permission.readOnly") : undefined;
  const actionTitle = (allowed: boolean, hint: string) =>
    allowed ? hint : t("skillWorkshop.experience.permission.readOnly");
  return html`
    <div class="sw-experience__detail">
      <div class="sw-detail__head">
        <div class="sw-detail__head-left">
          <h1 class="sw-detail__title">${shown.name}</h1>
          <div class="sw-detail__one-line">${shown.description}</div>
          <div class="sw-detail__meta">
            <span class="sw-experience__badge sw-experience__badge--${shown.status}">
              ${statusLabel(shown.status)}
            </span>
            <span>·</span>
            <span>
              ${
                edited
                  ? t("skillWorkshop.experience.detail.edited", {
                      time: relativeTime(shown.updatedAt),
                    })
                  : t("skillWorkshop.experience.detail.created", {
                      time: relativeTime(shown.createdAt),
                    })
              }
            </span>
            ${
              shown.tags?.length
                ? html`<span>·</span>
                    <span class="sw-experience__tags">${shown.tags.join(" · ")}</span>`
                : nothing
            }
          </div>
        </div>
      </div>
      <div class="sw-experience__detail-body">
        ${renderSource(props, shown)} ${renderEvidence(shown)} ${renderPromotion(props, shown)}
        <section class="sw-section">
          <h3 class="sw-section__label">${t("skillWorkshop.experience.detail.document")}</h3>
          <div class="sw-body-card">
            ${
              shown.content.trim()
                ? renderSkillDocument(shown.content)
                : html`<p class="sw-muted">${t("skillWorkshop.experience.detail.noDocument")}</p>`
            }
          </div>
        </section>
      </div>
      <div class="sw-action-bar" aria-busy=${busy ? "true" : "false"}>
        ${
          shown.status === "retired"
            ? html`<button
                  type="button"
                  class="sw-btn sw-btn--primary ${busy === "restore" ? "is-busy" : ""}"
                  title=${actionTitle(props.canRestore, t("skillWorkshop.experience.actions.restoreHint"))}
                  ?disabled=${!props.canRestore || Boolean(busy)}
                  @click=${() => props.onRestore(shown)}
                >
                  ${t(
                    busy === "restore"
                      ? "skillWorkshop.experience.actions.restoring"
                      : "skillWorkshop.experience.actions.restore",
                  )}
                </button>
                ${readOnly ? html`<span class="sw-muted">${disabledReason}</span>` : nothing}`
            : html`
                <button
                  type="button"
                  class="sw-btn sw-btn--primary"
                  title=${actionTitle(props.canUpdate, t("skillWorkshop.experience.actions.editHint"))}
                  ?disabled=${!props.canUpdate || Boolean(busy)}
                  @click=${() => props.onEdit(shown)}
                >
                  ${t("skillWorkshop.experience.actions.edit")}
                </button>
                <button
                  type="button"
                  class="sw-btn"
                  title=${actionTitle(props.canPromote, t("skillWorkshop.experience.actions.promoteHint"))}
                  ?disabled=${
                    !props.canPromote ||
                    Boolean(busy) ||
                    shown.status !== "active" ||
                    Boolean(props.promoteDraft)
                  }
                  @click=${() => props.onPromoteOpen(shown)}
                >
                  ${t("skillWorkshop.experience.actions.promote")}
                </button>
                ${
                  shown.status === "promoted"
                    ? html`<span class="sw-muted"
                        >${t("skillWorkshop.experience.actions.promotedHint")}</span
                      >`
                    : nothing
                }
                <button
                  type="button"
                  class="sw-btn sw-btn--ghost sw-btn--danger"
                  title=${actionTitle(props.canRetire, t("skillWorkshop.experience.actions.retireHint"))}
                  ?disabled=${!props.canRetire || Boolean(busy)}
                  @click=${() => props.onRetireOpen(shown)}
                >
                  ${t("skillWorkshop.experience.actions.retire")}
                </button>
                ${readOnly ? html`<span class="sw-muted">${disabledReason}</span>` : nothing}
              `
        }
      </div>
    </div>
  `;
}

export function renderSkillWorkshopExperience(props: SkillExperienceViewProps): TemplateResult {
  return html`
    <div class="sw-experience">
      ${
        props.error && props.experiences.length > 0
          ? html`<div class="sw-error" role="status">
              <span>${props.error}</span>
              <button type="button" class="btn btn--sm" @click=${props.onRetry}>
                ${t("pluginsPage.tryAgain")}
              </button>
            </div>`
          : nothing
      }
      <div class="sw-experience__panes">${renderListPanel(props)} ${renderDetail(props)}</div>
    </div>
    ${renderSkillExperienceDraftDialog(props)} ${renderSkillExperiencePromoteDialog(props)}
    ${renderSkillExperienceRetireDialog(props)}
  `;
}
