// Provider template picker: the "add provider" entry point lists curated
// endpoint templates (packages/model-catalog-core) before any editor opens.
// Rows are presentation only; selecting one starts the ordinary create flow
// with a template id, and the editor owns what that id prefills.
import {
  PROVIDER_TEMPLATE_GROUPS,
  PROVIDER_TEMPLATES,
  type ProviderTemplate,
  type ProviderTemplateGroup,
  type ProviderTemplateName,
} from "@openclaw/model-catalog-core/provider-templates";
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import { renderProviderBrandIcon } from "../../components/provider-icon.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";

registerSettingsEnglish();

/** One picker row; `addedProviderId` points at the config entry serving this endpoint. */
export type ProviderTemplatePickerRow = {
  id: string;
  label: string;
  icon: string;
  addedProviderId?: string;
};

export type ProviderTemplatePickerSection = {
  id: string;
  label: string;
  rows: ProviderTemplatePickerRow[];
};

export type ProviderTemplatePickerProps = {
  open: boolean;
  sections: readonly ProviderTemplatePickerSection[];
  /** True while creating is unavailable (shared config work or read-only access). */
  disabled: boolean;
  /** Explanation shown in the picker when creation waits for the provider list. */
  blockedReason: string | null;
  onSelectTemplate: (templateId: string) => void;
  onOpenProvider: (providerId: string) => void;
  onCustomProvider: () => void;
  onClose: () => void;
};

/** Bilingual template names resolve at render time; an absent zh-CN copy falls back to en. */
export function localizedTemplateName(name: ProviderTemplateName, locale: string): string {
  const localized = name.zhCN.trim();
  return locale.toLowerCase().startsWith("zh") && localized ? localized : name.en;
}

/**
 * Endpoint identity for duplicate detection: scheme and case-insensitive host
 * plus the path, with trailing slashes dropped. The path must stay because
 * templates share hosts across different API roots (Zhipu Coding vs API plans).
 */
export function normalizeTemplateEndpoint(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    return "";
  }
  try {
    const url = new URL(value);
    return `${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, "")}`;
  } catch {
    return value.replace(/\/+$/u, "");
  }
}

/** Config key already serving each endpoint, so a row can open it instead of creating. */
function endpointOwners(
  occupied: ReadonlyMap<string, string | undefined>,
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  for (const [providerId, baseUrl] of occupied) {
    const endpoint = normalizeTemplateEndpoint(baseUrl);
    if (endpoint && !owners.has(endpoint)) {
      owners.set(endpoint, providerId);
    }
  }
  return owners;
}

/** Groups in data order, rows in template order, localized and de-duplicated. */
export function buildProviderTemplateSections(options: {
  locale: string;
  occupied: ReadonlyMap<string, string | undefined>;
  templates?: readonly ProviderTemplate[];
  groups?: readonly ProviderTemplateGroup[];
}): ProviderTemplatePickerSection[] {
  const templates = options.templates ?? PROVIDER_TEMPLATES;
  const groups = options.groups ?? PROVIDER_TEMPLATE_GROUPS;
  const owners = endpointOwners(options.occupied);
  return [...groups]
    .toSorted((left, right) => left.order - right.order)
    .map((group) => ({
      id: group.id,
      label: localizedTemplateName(group.name, options.locale),
      rows: templates
        .filter((template) => template.group === group.id)
        .toSorted(
          (left, right) =>
            left.order - right.order ||
            localizedTemplateName(left.name, options.locale).localeCompare(
              localizedTemplateName(right.name, options.locale),
            ),
        )
        .map((template): ProviderTemplatePickerRow => {
          const addedProviderId = owners.get(normalizeTemplateEndpoint(template.provider.baseUrl));
          const row: ProviderTemplatePickerRow = {
            id: template.id,
            label: localizedTemplateName(template.name, options.locale),
            icon: template.icon,
          };
          if (addedProviderId) {
            row.addedProviderId = addedProviderId;
          }
          return row;
        }),
    }))
    .filter((section) => section.rows.length > 0);
}

function templateRow(row: ProviderTemplatePickerRow, props: ProviderTemplatePickerProps) {
  const added = row.addedProviderId !== undefined;
  return html`<button
    type="button"
    class="provider-template-picker__card ${added ? "is-added" : ""}"
    data-template-id=${row.id}
    data-template-added=${added ? "true" : nothing}
    ?disabled=${!added && props.disabled}
    @click=${() => (added ? props.onOpenProvider(row.addedProviderId!) : props.onSelectTemplate(row.id))}
  >
    ${renderProviderBrandIcon(row.id, {
      className: "provider-template-picker__icon",
      icon: row.icon,
      fallbackLabel: row.label,
    })}
    <span class="provider-template-picker__copy">
      <strong>${row.label}</strong>
      ${
        added
          ? html`<span class="provider-template-picker__badge"
              >${t("modelProviders.templates.added")}</span
            >`
          : nothing
      }
    </span>
  </button>`;
}

export function renderProviderTemplatePicker(props: ProviderTemplatePickerProps) {
  if (!props.open) {
    return nothing;
  }
  return html`<openclaw-modal-dialog
    class="provider-template-picker-dialog"
    label=${t("modelProviders.templates.title")}
    @modal-cancel=${(event: Event) => {
      event.preventDefault();
      props.onClose();
    }}
  >
    <div class="provider-template-picker" data-provider-template-picker>
      <header class="provider-template-picker__header">
        <div>
          <h2>${t("modelProviders.templates.title")}</h2>
          <p class="muted">${t("modelProviders.templates.description")}</p>
        </div>
        <button
          type="button"
          class="btn btn--icon btn--ghost btn--xs"
          aria-label=${t("common.close")}
          @click=${() => props.onClose()}
        >
          ${icons.x}
        </button>
      </header>
      ${
        props.blockedReason
          ? html`<p class="muted provider-template-picker__blocked" role="status">
              ${props.blockedReason}
            </p>`
          : nothing
      }
      <div class="provider-template-picker__body">
        <button
          type="button"
          class="provider-template-picker__card is-custom"
          data-template-custom
          ?disabled=${props.disabled}
          @click=${() => props.onCustomProvider()}
        >
          <span class="provider-template-picker__icon provider-template-picker__icon--custom">
            ${icons.plus}
          </span>
          <span class="provider-template-picker__copy">
            <strong>${t("modelProviders.manager.customProvider")}</strong>
            <span class="muted">${t("modelProviders.templates.customDescription")}</span>
          </span>
        </button>
        ${props.sections.map(
          (section) => html`<section
            class="provider-template-picker__section"
            data-template-group=${section.id}
          >
            <h3>${section.label}</h3>
            <div class="provider-template-picker__grid">
              ${section.rows.map((row) => templateRow(row, props))}
            </div>
          </section>`,
        )}
      </div>
    </div>
  </openclaw-modal-dialog>`;
}
