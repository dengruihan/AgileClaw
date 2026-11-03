import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerSkillWorkshopEnglish } from "../../i18n/locales/en-skill-workshop.ts";
import type { SkillExperienceViewProps } from "./view-types.ts";

registerSkillWorkshopEnglish();

export function renderSkillExperienceDraftDialog(props: SkillExperienceViewProps) {
  const draft = props.draft;
  if (!draft) {
    return nothing;
  }
  const saving = draft.saving;
  const canSave =
    Boolean(draft.name.trim()) &&
    Boolean(draft.description.trim()) &&
    Boolean(draft.content.trim()) &&
    !saving;
  const title =
    draft.mode === "create"
      ? t("skillWorkshop.experience.draft.newTitle")
      : t("skillWorkshop.experience.draft.editTitle");
  return html`
    <openclaw-modal-dialog
      .label=${title}
      .description=${t("skillWorkshop.experience.draft.description")}
      style="--openclaw-modal-width: 720px"
      @modal-cancel=${() => {
        if (!saving) {
          props.onCancelDraft();
        }
      }}
    >
      <section class="sw-experience-dialog" aria-busy=${saving ? "true" : "false"}>
        <div class="sw-experience-dialog__head">
          <h2>${title}</h2>
          <button
            type="button"
            class="sw-revision-dialog__close"
            aria-label=${t("skillWorkshop.experience.actions.close")}
            ?disabled=${saving}
            @click=${props.onCancelDraft}
          >
            ${icons.x}
          </button>
        </div>
        <label class="sw-experience-dialog__field">
          <span>${t("skillWorkshop.experience.draft.name")}</span>
          <input
            type="text"
            maxlength="200"
            .value=${draft.name}
            ?disabled=${saving}
            placeholder=${t("skillWorkshop.experience.draft.namePlaceholder")}
            @input=${(event: Event) =>
              props.onDraftChange({ name: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="sw-experience-dialog__field">
          <span>${t("skillWorkshop.experience.draft.summary")}</span>
          <input
            type="text"
            maxlength="160"
            .value=${draft.description}
            ?disabled=${saving}
            placeholder=${t("skillWorkshop.experience.draft.summaryPlaceholder")}
            @input=${(event: Event) =>
              props.onDraftChange({ description: (event.currentTarget as HTMLInputElement).value })}
          />
        </label>
        <label class="sw-experience-dialog__field">
          <span>${t("skillWorkshop.experience.draft.body")}</span>
          <textarea
            class="sw-experience-dialog__body"
            .value=${draft.content}
            ?disabled=${saving}
            placeholder=${t("skillWorkshop.experience.draft.bodyPlaceholder")}
            @input=${(event: Event) =>
              props.onDraftChange({ content: (event.currentTarget as HTMLTextAreaElement).value })}
          ></textarea>
        </label>
        ${
          draft.conflictHeld
            ? html`
                <div class="sw-experience__conflict" role="alert">
                  <div>
                    <strong>${t("skillWorkshop.experience.draft.conflictTitle")}</strong>
                    <p>${t("skillWorkshop.experience.draft.conflictBody")}</p>
                  </div>
                  <button type="button" class="sw-btn sw-btn--sm" @click=${props.onReloadConflict}>
                    ${t("skillWorkshop.experience.draft.reload")}
                  </button>
                </div>
              `
            : nothing
        }
        ${draft.notice ? html`<p class="sw-muted" role="status">${draft.notice}</p>` : nothing}
        ${draft.error ? html`<p class="sw-error" role="alert">${draft.error}</p>` : nothing}
        <div class="sw-revision-dialog__actions">
          <button
            type="button"
            class="sw-btn sw-btn--ghost"
            ?disabled=${saving}
            @click=${props.onCancelDraft}
          >
            ${t("skillWorkshop.experience.actions.cancel")}
          </button>
          <button
            type="button"
            class="sw-btn sw-btn--primary ${saving ? "is-busy" : ""}"
            ?disabled=${!canSave}
            @click=${props.onSave}
          >
            ${t(
              saving
                ? "skillWorkshop.experience.actions.saving"
                : "skillWorkshop.experience.actions.save",
            )}
          </button>
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}

export function renderSkillExperiencePromoteDialog(props: SkillExperienceViewProps) {
  const draft = props.promoteDraft;
  if (!draft) {
    return nothing;
  }
  const normalizedName = draft.experienceName.trim().toLowerCase();
  const existingSkill = props.installedSkills.find(
    (skill) => skill.name.toLowerCase() === normalizedName,
  );
  const sameNameExperience = props.experiences.find(
    (experience) => experience.id !== draft.id && experience.name.toLowerCase() === normalizedName,
  );
  const createCollision = draft.targetKind === "create" && Boolean(existingSkill);
  const canSubmit =
    !draft.busy &&
    (draft.targetKind === "create"
      ? Boolean(draft.description.trim()) && !createCollision
      : Boolean(draft.skillName));
  return html`
    <openclaw-modal-dialog
      .label=${t("skillWorkshop.experience.promote.title")}
      .description=${t("skillWorkshop.experience.promote.description")}
      style="--openclaw-modal-width: 600px"
      @modal-cancel=${() => {
        if (!draft.busy) {
          props.onPromoteCancel();
        }
      }}
    >
      <section class="sw-experience-dialog" aria-busy=${draft.busy ? "true" : "false"}>
        <div class="sw-experience-dialog__head">
          <h2>${t("skillWorkshop.experience.promote.heading", { name: draft.experienceName })}</h2>
          <button
            type="button"
            class="sw-revision-dialog__close"
            aria-label=${t("skillWorkshop.experience.actions.close")}
            ?disabled=${draft.busy}
            @click=${props.onPromoteCancel}
          >
            ${icons.x}
          </button>
        </div>
        <p class="sw-muted">${t("skillWorkshop.experience.promote.draftNotice")}</p>
        <fieldset class="sw-experience-dialog__target">
          <legend>${t("skillWorkshop.experience.promote.target")}</legend>
          <label>
            <input
              type="radio"
              name="experience-promote-target"
              .checked=${draft.targetKind === "create"}
              ?disabled=${draft.busy}
              @change=${() => props.onPromoteDraftChange({ targetKind: "create" })}
            />
            <span>${t("skillWorkshop.experience.promote.createOption")}</span>
          </label>
          <label class=${props.installedSkills.length === 0 ? "is-disabled" : ""}>
            <input
              type="radio"
              name="experience-promote-target"
              .checked=${draft.targetKind === "update"}
              ?disabled=${draft.busy || props.installedSkills.length === 0}
              @change=${() => props.onPromoteDraftChange({ targetKind: "update" })}
            />
            <span>${t("skillWorkshop.experience.promote.updateOption")}</span>
          </label>
        </fieldset>
        ${
          draft.targetKind === "create"
            ? html`
                <div class="sw-experience-dialog__field">
                  <span>${t("skillWorkshop.experience.promote.skillName")}</span>
                  <p class="sw-experience__fixed-target">${draft.experienceName}</p>
                  <span class="sw-experience-dialog__hint">
                    ${t("skillWorkshop.experience.promote.fixedNameHint")}
                  </span>
                </div>
                ${
                  createCollision
                    ? html`
                        <div class="sw-experience__dedupe" role="alert">
                          <span>
                            ${t("skillWorkshop.experience.promote.dedupeSkill", {
                              name: existingSkill?.name ?? draft.experienceName,
                            })}
                          </span>
                          <button
                            type="button"
                            class="sw-btn sw-btn--sm"
                            @click=${() =>
                              props.onPromoteDraftChange({
                                targetKind: "update",
                                skillName: existingSkill?.name ?? "",
                              })}
                          >
                            ${t("skillWorkshop.experience.promote.useUpdate", {
                              name: existingSkill?.name ?? draft.experienceName,
                            })}
                          </button>
                        </div>
                      `
                    : nothing
                }
              `
            : html`
                <label class="sw-experience-dialog__field">
                  <span>${t("skillWorkshop.experience.promote.installedSkill")}</span>
                  <select
                    .value=${draft.skillName}
                    ?disabled=${draft.busy}
                    @change=${(event: Event) =>
                      props.onPromoteDraftChange({
                        skillName: (event.currentTarget as HTMLSelectElement).value,
                      })}
                  >
                    <option value="" ?selected=${draft.skillName === ""}>
                      ${t("skillWorkshop.experience.promote.selectSkill")}
                    </option>
                    ${props.installedSkills.map(
                      (skill) => html`<option
                        value=${skill.name}
                        ?selected=${skill.name === draft.skillName}
                      >
                        ${skill.name}
                      </option>`,
                    )}
                  </select>
                </label>
              `
        }
        ${
          sameNameExperience
            ? html`<p class="sw-experience__dedupe-note" role="status">
                ${t("skillWorkshop.experience.promote.dedupeExperience", {
                  name: sameNameExperience.name,
                })}
              </p>`
            : nothing
        }
        <label class="sw-experience-dialog__field">
          <span>${t("skillWorkshop.experience.promote.skillDescription")}</span>
          <input
            type="text"
            maxlength="160"
            .value=${draft.description}
            ?disabled=${draft.busy}
            @input=${(event: Event) =>
              props.onPromoteDraftChange({
                description: (event.currentTarget as HTMLInputElement).value,
              })}
          />
        </label>
        ${draft.error ? html`<p class="sw-error" role="alert">${draft.error}</p>` : nothing}
        <div class="sw-revision-dialog__actions">
          <button
            type="button"
            class="sw-btn sw-btn--ghost"
            ?disabled=${draft.busy}
            @click=${props.onPromoteCancel}
          >
            ${t("skillWorkshop.experience.actions.cancel")}
          </button>
          <button
            type="button"
            class="sw-btn sw-btn--primary ${draft.busy ? "is-busy" : ""}"
            ?disabled=${!canSubmit}
            @click=${props.onPromoteSubmit}
          >
            ${t(
              draft.busy
                ? "skillWorkshop.experience.promote.submitting"
                : "skillWorkshop.experience.promote.submit",
            )}
          </button>
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}

export function renderSkillExperienceRetireDialog(props: SkillExperienceViewProps) {
  const draft = props.retireDraft;
  if (!draft) {
    return nothing;
  }
  return html`
    <openclaw-modal-dialog
      .label=${t("skillWorkshop.experience.retire.title")}
      .description=${t("skillWorkshop.experience.retire.body")}
      style="--openclaw-modal-width: 480px"
      @modal-cancel=${() => {
        if (!draft.busy) {
          props.onRetireCancel();
        }
      }}
    >
      <section class="sw-experience-dialog" aria-busy=${draft.busy ? "true" : "false"}>
        <div class="sw-experience-dialog__head">
          <h2>${t("skillWorkshop.experience.retire.heading", { name: draft.experienceName })}</h2>
          <button
            type="button"
            class="sw-revision-dialog__close"
            aria-label=${t("skillWorkshop.experience.actions.close")}
            ?disabled=${draft.busy}
            @click=${props.onRetireCancel}
          >
            ${icons.x}
          </button>
        </div>
        <p class="sw-muted">${t("skillWorkshop.experience.retire.body")}</p>
        <label class="sw-experience-dialog__field">
          <span>${t("skillWorkshop.experience.retire.reason")}</span>
          <textarea
            class="sw-experience-dialog__reason"
            .value=${draft.reason}
            ?disabled=${draft.busy}
            placeholder=${t("skillWorkshop.experience.retire.reasonPlaceholder")}
            @input=${(event: Event) =>
              props.onRetireReasonChange((event.currentTarget as HTMLTextAreaElement).value)}
          ></textarea>
        </label>
        ${draft.error ? html`<p class="sw-error" role="alert">${draft.error}</p>` : nothing}
        <div class="sw-revision-dialog__actions">
          <button
            type="button"
            class="sw-btn sw-btn--ghost"
            ?disabled=${draft.busy}
            @click=${props.onRetireCancel}
          >
            ${t("skillWorkshop.experience.actions.cancel")}
          </button>
          <button
            type="button"
            class="sw-btn sw-btn--danger ${draft.busy ? "is-busy" : ""}"
            ?disabled=${draft.busy}
            @click=${props.onRetireSubmit}
          >
            ${t(
              draft.busy
                ? "skillWorkshop.experience.retire.confirming"
                : "skillWorkshop.experience.retire.confirm",
            )}
          </button>
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}
