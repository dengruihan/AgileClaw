import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type {
  VaultAuditEvent,
  VaultEntryMetadata,
  VaultStatus,
} from "../../../../packages/gateway-protocol/src/index.js";
import { icon } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import {
  renderDocsLink,
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPageHeader,
  renderSettingsSection,
} from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import {
  passwordsVaultErrorHint,
  type PasswordsVaultClientError,
} from "../../lib/passwords-vault/index.ts";
import "../../styles/passwords-vault.css";

export type PasswordsDialogMode = "add" | "edit" | null;

export type PasswordsEntryDraft = {
  itemRef?: string;
  revision?: number;
  website: string;
  siteLabel: string;
  account: string;
  label: string;
  password: string;
  notes: string;
};

export type RevealedPasswordsEntry = {
  password: string;
  notes: string;
};

type PasswordsVaultViewProps = {
  status: VaultStatus | null;
  entries: VaultEntryMetadata[];
  audit: VaultAuditEvent[];
  loading: boolean;
  busy: boolean;
  loaded: boolean;
  error: PasswordsVaultClientError | null;
  notice: string | null;
  canManage: boolean;
  canReveal: boolean;
  search: string;
  showDeleted: boolean;
  dialogMode: PasswordsDialogMode;
  draft: PasswordsEntryDraft;
  formError: string | null;
  revealed: Readonly<Record<string, RevealedPasswordsEntry>>;
  authPassphrase: string;
  authConfirm: string;
  authAutoLockSeconds: number;
  notesMode: "keep" | "replace" | "clear";
  onSearchChange: (value: string) => void;
  onToggleDeleted: (value: boolean) => void;
  onRefresh: () => void;
  onOpenAdd: () => void;
  onOpenEdit: (entry: VaultEntryMetadata) => void;
  onCloseDialog: () => void;
  onDraftChange: (patch: Partial<PasswordsEntryDraft>) => void;
  onSubmitDraft: () => void;
  onGenerate: () => void;
  onReveal: (entry: VaultEntryMetadata) => void;
  onHide: (itemRef: string) => void;
  onCopy: (entry: VaultEntryMetadata, field: "password" | "notes") => void;
  onDelete: (entry: VaultEntryMetadata) => void;
  onRestore: (entry: VaultEntryMetadata) => void;
  onPurge: (entry: VaultEntryMetadata) => void;
  onLock: () => void;
  onAuthPassphraseChange: (value: string) => void;
  onAuthConfirmChange: (value: string) => void;
  onAuthAutoLockChange: (value: number) => void;
  onNotesModeChange: (mode: "keep" | "replace" | "clear") => void;
  onLoadNotes: () => void;
  onInitialize: () => void;
  onUnlock: () => void;
};

const DOCS_URL = "https://docs.openclaw.ai/gateway/passwords-vault";

function eventValue(event: Event): string {
  const target = event.target;
  return target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
    ? target.value
    : "";
}

function eventChecked(event: Event): boolean {
  const target = event.target;
  return target instanceof HTMLInputElement ? target.checked : false;
}
const MASK = "••••••••••••";

function formatTime(value: number | undefined, fallback: string): string {
  return value === undefined ? fallback : formatRelativeTimestamp(value, { fallback });
}

function errorText(error: PasswordsVaultClientError | null): TemplateResult | typeof nothing {
  if (!error) {
    return nothing;
  }
  // A localized hint fully replaces the gateway's English message; unknown
  // codes keep that message as the only diagnostic available.
  return html`
    <div class="passwords-vault__error" role="alert">
      <strong>${passwordsVaultErrorHint(error) ?? error.message}</strong>
    </div>
  `;
}

function renderAuthCard(props: PasswordsVaultViewProps): TemplateResult {
  const uninitialized = props.status?.state === "uninitialized";
  return html`
    <div class="passwords-vault__auth">
      <h2>${uninitialized ? t("passwords.setupTitle") : t("passwords.unlockTitle")}</h2>
      <p class="passwords-vault__muted">
        ${uninitialized ? t("passwords.setupHint") : t("passwords.unlockHint")}
      </p>
      <form
        class="passwords-vault__auth-form"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          if (uninitialized) {
            props.onInitialize();
          } else {
            props.onUnlock();
          }
        }}
      >
        <label class="passwords-vault__field">
          <span>${t("passwords.masterPassphrase")}</span>
          <input
            class="settings-input"
            type="password"
            name="master-passphrase"
            autocomplete="current-password"
            spellcheck="false"
            .value=${props.authPassphrase}
            @input=${(event: Event) => props.onAuthPassphraseChange(eventValue(event))}
          />
        </label>
        ${
          uninitialized
            ? html`
                <label class="passwords-vault__field">
                  <span>${t("passwords.confirmPassphrase")}</span>
                  <input
                    class="settings-input"
                    type="password"
                    name="confirm-passphrase"
                    autocomplete="new-password"
                    spellcheck="false"
                    .value=${props.authConfirm}
                    @input=${(event: Event) => props.onAuthConfirmChange(eventValue(event))}
                  />
                </label>
                <label class="passwords-vault__field">
                  <span>${t("passwords.autoLock")}</span>
                  <select
                    class="settings-input"
                    @change=${(event: Event) =>
                      props.onAuthAutoLockChange(Number(eventValue(event)))}
                  >
                    ${[60, 300, 900, 3600].map(
                      (seconds) => html`
                        <option value=${seconds} ?selected=${props.authAutoLockSeconds === seconds}>
                          ${t("passwords.minutes", { count: String(seconds / 60) })}
                        </option>
                      `,
                    )}
                  </select>
                </label>
              `
            : nothing
        }
        <button class="btn" type="submit" ?disabled=${props.busy}>
          ${uninitialized ? t("passwords.createVault") : t("passwords.unlock")}
        </button>
      </form>
      ${errorText(props.error)}
    </div>
  `;
}

function groupEntries(entries: VaultEntryMetadata[]): Map<string, VaultEntryMetadata[]> {
  const groups = new Map<string, VaultEntryMetadata[]>();
  for (const entry of entries) {
    const key = `${entry.originScheme}://${entry.originHost}:${entry.originPort}`;
    const list = groups.get(key) ?? [];
    list.push(entry);
    groups.set(key, list);
  }
  return groups;
}

function renderRevealedValue(
  props: PasswordsVaultViewProps,
  entry: VaultEntryMetadata,
): TemplateResult {
  const revealed = props.revealed[entry.itemRef];
  if (!revealed) {
    return html`<span class="passwords-vault__masked">${MASK}</span>`;
  }
  return html`
    <div class="passwords-vault__revealed">
      <code class="passwords-vault__secret">${revealed.password}</code>
      ${revealed.notes ? html`<pre class="passwords-vault__notes">${revealed.notes}</pre>` : nothing}
    </div>
  `;
}

function renderRow(props: PasswordsVaultViewProps, entry: VaultEntryMetadata): TemplateResult {
  const deleted = entry.deletedAtMs !== undefined;
  return html`
    <tr
      class=${deleted ? "passwords-vault__row passwords-vault__row--deleted" : "passwords-vault__row"}
    >
      <td data-label=${t("passwords.account")}>
        <span class="passwords-vault__account">${entry.account}</span>
        ${entry.label ? html`<span class="passwords-vault__label">${entry.label}</span>` : nothing}
        ${deleted ? html`<wa-badge variant="warning">${t("passwords.deleted")}</wa-badge>` : nothing}
      </td>
      <td data-label=${t("passwords.password")}>
        ${deleted ? html`<span class="passwords-vault__muted">${t("passwords.deleted")}</span>` : renderRevealedValue(props, entry)}
      </td>
      <td data-label=${t("passwords.updated")}>
        ${formatTime(entry.updatedAtMs, t("common.unknown"))}
      </td>
      <td data-label=${t("passwords.lastUsed")}>
        ${formatTime(entry.lastUsedAtMs, t("passwords.neverUsed"))}
      </td>
      <td class="passwords-vault__actions-cell">
        <div class="passwords-vault__actions">
          ${
            deleted
              ? html`
                  <button
                    class="btn btn--sm btn--ghost"
                    type="button"
                    ?disabled=${props.busy}
                    @click=${() => props.onRestore(entry)}
                  >
                    ${t("passwords.restore")}
                  </button>
                  <button
                    class="btn btn--sm btn--danger"
                    type="button"
                    ?disabled=${props.busy}
                    @click=${() => props.onPurge(entry)}
                  >
                    ${t("passwords.purge")}
                  </button>
                `
              : html`
                  ${
                    props.canReveal
                      ? html`
                          <button
                            class="btn btn--sm btn--ghost"
                            type="button"
                            ?disabled=${props.busy}
                            @click=${() =>
                              props.revealed[entry.itemRef]
                                ? props.onHide(entry.itemRef)
                                : props.onReveal(entry)}
                          >
                            ${props.revealed[entry.itemRef] ? t("passwords.hide") : t("passwords.show")}
                          </button>
                          <button
                            class="btn btn--sm btn--ghost"
                            type="button"
                            ?disabled=${props.busy}
                            @click=${() => props.onCopy(entry, "password")}
                          >
                            ${icon("copy")} ${t("passwords.copy")}
                          </button>
                        `
                      : nothing
                  }
                  ${
                    props.canManage
                      ? html`
                          <button
                            class="btn btn--sm btn--ghost"
                            type="button"
                            ?disabled=${props.busy}
                            @click=${() => props.onOpenEdit(entry)}
                          >
                            ${icon("pencil")} ${t("passwords.edit")}
                          </button>
                          <button
                            class="btn btn--sm btn--ghost"
                            type="button"
                            ?disabled=${props.busy}
                            @click=${() => props.onDelete(entry)}
                          >
                            ${icon("trash")} ${t("common.delete")}
                          </button>
                        `
                      : nothing
                  }
                `
          }
        </div>
      </td>
    </tr>
  `;
}

function renderGroups(props: PasswordsVaultViewProps): TemplateResult | typeof nothing {
  if (!props.entries.length) {
    return html`
      <div class="passwords-vault__empty">
        ${renderSettingsEmpty(t("passwords.empty"))}
        <p class="passwords-vault__muted">${t("passwords.emptyHint")}</p>
        ${renderDocsLink(DOCS_URL, t("common.docs"))}
      </div>
    `;
  }
  const groups = groupEntries(props.entries);
  return html`
    <div class="passwords-vault__groups">
      ${[...groups.entries()].map(([origin, entries]) => {
        const displayOrigin = origin.replace(/:443$/u, "");
        return html`
          <section class="passwords-vault__group" aria-label=${origin}>
            <header class="passwords-vault__group-header">
              <span class="passwords-vault__site">${entries[0]?.siteLabel ?? origin}</span>
              <code class="passwords-vault__origin">${displayOrigin}</code>
              <span class="passwords-vault__count"
                >${
                  entries.length === 1
                    ? t("passwords.accountCountOne")
                    : t("passwords.accountCount", { count: String(entries.length) })
                }</span
              >
            </header>
            <div class="passwords-vault__table-wrap">
              <table class="passwords-vault__table settings-table--stacked">
                <thead>
                  <tr>
                    <th scope="col">${t("passwords.account")}</th>
                    <th scope="col">${t("passwords.password")}</th>
                    <th scope="col">${t("passwords.updated")}</th>
                    <th scope="col">${t("passwords.lastUsed")}</th>
                    <th scope="col">
                      <span class="settings-control__sr-label">${t("passwords.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  ${repeat(
                    entries,
                    (entry) => entry.itemRef,
                    (entry) => renderRow(props, entry),
                  )}
                </tbody>
              </table>
            </div>
          </section>
        `;
      })}
    </div>
  `;
}

function renderEntryDialog(props: PasswordsVaultViewProps): TemplateResult | typeof nothing {
  if (!props.dialogMode) {
    return nothing;
  }
  const editing = props.dialogMode === "edit";
  return html`
    <openclaw-modal-dialog
      label=${editing ? t("passwords.editTitle") : t("passwords.addTitle")}
      description=${t("passwords.dialogHint")}
      @modal-cancel=${props.onCloseDialog}
    >
      <form
        class="passwords-vault__dialog"
        aria-busy=${props.busy ? "true" : "false"}
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          props.onSubmitDraft();
        }}
      >
        <div class="passwords-vault__dialog-header">
          <h2>${editing ? t("passwords.editTitle") : t("passwords.addTitle")}</h2>
        </div>
        <label class="passwords-vault__field">
          <span>${t("passwords.website")}</span>
          <input
            class="settings-input"
            name="website"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://example.com"
            .value=${props.draft.website}
            @input=${(event: Event) => props.onDraftChange({ website: eventValue(event) })}
          />
          <small>${t("passwords.websiteHint")}</small>
        </label>
        <label class="passwords-vault__field">
          <span>${t("passwords.siteLabel")}</span>
          <input
            class="settings-input"
            name="site-label"
            autocomplete="off"
            .value=${props.draft.siteLabel}
            @input=${(event: Event) => props.onDraftChange({ siteLabel: eventValue(event) })}
          />
        </label>
        <label class="passwords-vault__field">
          <span>${t("passwords.account")}</span>
          <input
            class="settings-input"
            name="account"
            autocomplete="off"
            .value=${props.draft.account}
            @input=${(event: Event) => props.onDraftChange({ account: eventValue(event) })}
          />
        </label>
        <label class="passwords-vault__field">
          <span>${t("passwords.label")}</span>
          <input
            class="settings-input"
            name="label"
            autocomplete="off"
            .value=${props.draft.label}
            @input=${(event: Event) => props.onDraftChange({ label: eventValue(event) })}
          />
        </label>
        <label class="passwords-vault__field">
          <span>${t("passwords.password")}</span>
          <div class="passwords-vault__password-row">
            <input
              class="settings-input"
              type="password"
              name="password"
              autocomplete="new-password"
              spellcheck="false"
              placeholder=${editing ? t("passwords.passwordKeepHint") : ""}
              .value=${props.draft.password}
              @input=${(event: Event) => props.onDraftChange({ password: eventValue(event) })}
            />
            <button class="btn btn--sm btn--ghost" type="button" @click=${props.onGenerate}>
              ${t("passwords.generate")}
            </button>
          </div>
        </label>
        ${
          editing
            ? html`
                <fieldset class="passwords-vault__notes-mode">
                  <legend>${t("passwords.notes")}</legend>
                  <label>
                    <input
                      type="radio"
                      name="notes-mode"
                      value="keep"
                      .checked=${props.notesMode === "keep"}
                      @change=${() => props.onNotesModeChange("keep")}
                    />
                    <span>${t("passwords.keepNotes")}</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="notes-mode"
                      value="replace"
                      .checked=${props.notesMode === "replace"}
                      @change=${() => props.onNotesModeChange("replace")}
                    />
                    <span>${t("passwords.replaceNotes")}</span>
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="notes-mode"
                      value="clear"
                      .checked=${props.notesMode === "clear"}
                      @change=${() => props.onNotesModeChange("clear")}
                    />
                    <span>${t("passwords.clearNotes")}</span>
                  </label>
                  ${
                    props.canReveal && props.notesMode !== "clear"
                      ? html`<button
                          class="btn btn--sm btn--ghost"
                          type="button"
                          @click=${props.onLoadNotes}
                        >
                          ${t("passwords.loadNotes")}
                        </button>`
                      : nothing
                  }
                </fieldset>
              `
            : nothing
        }
        ${
          !editing || props.notesMode === "replace"
            ? html`
                <label class="passwords-vault__field">
                  <span
                    >${
                      editing && props.notesMode === "replace"
                        ? t("passwords.notesReplacement")
                        : t("passwords.notes")
                    }</span
                  >
                  <textarea
                    class="settings-input passwords-vault__notes-input"
                    name="notes"
                    spellcheck="false"
                    .value=${props.draft.notes}
                    @input=${(event: Event) => props.onDraftChange({ notes: eventValue(event) })}
                  ></textarea>
                </label>
              `
            : nothing
        }
        ${
          editing && props.notesMode === "keep"
            ? html`<p class="passwords-vault__muted">${t("passwords.keepNotesHint")}</p>`
            : nothing
        }
        ${props.formError ? html`<div class="passwords-vault__error">${props.formError}</div>` : nothing}
        <div class="passwords-vault__dialog-actions">
          <button class="btn btn--ghost" type="button" @click=${props.onCloseDialog}>
            ${t("common.cancel")}
          </button>
          <button class="btn" type="submit" ?disabled=${props.busy}>${t("common.save")}</button>
        </div>
      </form>
    </openclaw-modal-dialog>
  `;
}

function renderAudit(props: PasswordsVaultViewProps): TemplateResult | typeof nothing {
  if (!props.audit.length) {
    return nothing;
  }
  const labels: Record<string, string> = {
    initialize: t("passwords.audit.initialize"),
    unlock: t("passwords.audit.unlock"),
    "unlock-failed": t("passwords.audit.unlockFailed"),
    lock: t("passwords.audit.lock"),
    create: t("passwords.audit.create"),
    update: t("passwords.audit.update"),
    delete: t("passwords.audit.delete"),
    restore: t("passwords.audit.restore"),
    purge: t("passwords.audit.purge"),
    reveal: t("passwords.audit.reveal"),
    copy: t("passwords.audit.copy"),
    generate: t("passwords.audit.generate"),
    fill: t("passwords.audit.fill"),
    "purge-expired": t("passwords.audit.purgeExpired"),
  };
  return renderSettingsSection(
    { title: t("passwords.activity"), description: t("passwords.activityHint") },
    html`
      <ul class="passwords-vault__audit">
        ${props.audit.map(
          (event) => html`
            <li>
              <span class="passwords-vault__audit-action"
                >${labels[event.action] ?? event.action}</span
              >
              <span class="passwords-vault__muted"
                >${formatTime(event.occurredAtMs, t("common.unknown"))}</span
              >
              ${
                event.itemRef
                  ? html`<code class="passwords-vault__audit-ref">${event.itemRef}</code>`
                  : nothing
              }
            </li>
          `,
        )}
      </ul>
    `,
  );
}

export function renderPasswordsVault(props: PasswordsVaultViewProps): TemplateResult {
  const status = props.status;
  const needsAuth =
    !status ||
    status.state === "uninitialized" ||
    status.state === "locked" ||
    status.state === "corrupted";
  const body = html`
    ${
      needsAuth
        ? renderAuthCard(props)
        : html`
            <div class="passwords-vault__toolbar">
              <input
                class="settings-input passwords-vault__search"
                type="search"
                placeholder=${t("passwords.searchPlaceholder")}
                .value=${props.search}
                @input=${(event: Event) => props.onSearchChange(eventValue(event))}
              />
              <label class="passwords-vault__toggle">
                <input
                  type="checkbox"
                  .checked=${props.showDeleted}
                  @change=${(event: Event) => props.onToggleDeleted(eventChecked(event))}
                />
                <span>${t("passwords.showDeleted")}</span>
              </label>
              <button class="btn btn--sm btn--ghost" type="button" @click=${props.onRefresh}>
                ${icon("refresh")} ${t("common.refresh")}
              </button>
              ${
                props.canManage
                  ? html`<button class="btn" type="button" @click=${props.onOpenAdd}>
                      ${icon("plus")} ${t("passwords.add")}
                    </button>`
                  : nothing
              }
              <button class="btn btn--sm btn--ghost" type="button" @click=${props.onLock}>
                ${icon("lock")} ${t("passwords.lock")}
              </button>
            </div>
            <div class="passwords-vault__statusline">
              <span>
                ${t("passwords.unlockedSummary", {
                  count: String(status.itemCount),
                  deleted: String(status.deletedCount),
                })}
              </span>
              <span class="passwords-vault__muted">
                ${t("passwords.autoLockSummary", {
                  count: String(Math.round(status.autoLockSeconds / 60)),
                })}
              </span>
            </div>
            ${
              props.loading && !props.loaded ? renderSettingsLoadingSkeleton() : renderGroups(props)
            }
            ${renderAudit(props)}
          `
    }
    ${!needsAuth ? errorText(props.error) : nothing}
    ${props.notice ? html`<div class="passwords-vault__notice" role="status">${props.notice}</div>` : nothing}
    ${renderEntryDialog(props)}
  `;
  return html`
    ${renderSettingsPageHeader({
      title: t("tabs.passwords"),
      subtitle: t("passwords.hint"),
    })}
    ${renderSettingsWorkspace(body)}
  `;
}
