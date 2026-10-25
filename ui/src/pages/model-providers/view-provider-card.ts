import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import type { ModelProviderRowMessage } from "./config-mutation.ts";
import type {
  DefaultModelSelection,
  ModelPickerEntry,
  ModelProviderCard,
  ProviderOption,
} from "./data.ts";
import type { DefaultModelsViewProps } from "./default-models-view.ts";
import { renderMutationMessage } from "./view-status.ts";

export type ModelProvidersViewProps = Omit<
  DefaultModelsViewProps,
  "models" | "selection" | "message"
> & {
  connected: boolean;
  busy: Record<string, boolean>;
  catalogSettings?: TemplateResult;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  updatedAt: number | null;
  credentialAgentLabel: string;
  cards: ModelProviderCard[];
  configuredModels: ModelPickerEntry[];
  defaultModels: DefaultModelSelection;
  /** True while picker-triggered catalog discovery is in flight. */
  catalogDiscovering: boolean;
  /** Retryable error from picker-triggered catalog discovery. */
  catalogDiscoveryError: string | null;
  configBusy: boolean;
  unconfiguredProviders: ProviderOption[];
  defaultsMutationBlockedReason: string | null;
  messages: Record<string, ModelProviderRowMessage>;
  addProviderOpen: boolean;
  addProviderId: string;
  addProviderKey: string;
  installedAgents: TemplateResult | typeof nothing;
  onRefresh: () => void;
  /** Deletes an authored provider entry and its references; custom providers only. */
  onDeleteProvider: (card: ModelProviderCard) => void;
  canDeleteProvider?: (card: ModelProviderCard) => boolean;
  onAddProviderToggle: () => void;
  onAddProviderKeyChange: (value: string) => void;
  onAddProvider: () => void;
  providerScope?: TemplateResult;
  providerEditor?: TemplateResult;
  selectedProvider?: string;
  creatingProvider?: boolean;
  accountRecovery?: TemplateResult | typeof nothing;
  isLocalOrCustom?: (card: ModelProviderCard) => boolean;
  onProviderSettings?: (card: ModelProviderCard) => void;
  onCustomProvider?: () => void;
  providerQuery?: string;
  onProviderQueryChange?: (value: string) => void;
  onConnect: (card: ModelProviderCard) => void;
  canConnect: (card: ModelProviderCard) => boolean;
  loginBusy: boolean;
};

export function configMutationDisabled(props: ModelProvidersViewProps): boolean {
  return !props.canMutate || props.configBusy;
}

function renderDeleteProviderAction(card: ModelProviderCard, props: ModelProvidersViewProps) {
  if (!props.canDeleteProvider?.(card)) {
    return nothing;
  }
  return html`<button
    class="btn btn--sm danger"
    data-models-delete-provider=${card.id}
    ?disabled=${Boolean(props.busy[`delete:${card.id}`]) || configMutationDisabled(props)}
    title=${props.mutationBlockedReason ?? ""}
    @click=${() => props.onDeleteProvider(card)}
  >
    ${t("modelProviders.delete.action")}
  </button>`;
}

export function renderProviderRow(card: ModelProviderCard, props: ModelProvidersViewProps) {
  const message = props.messages[`key:${card.id}`] ?? props.messages[card.id];
  return html`
    <div class="model-providers__provider-details" data-provider-details=${card.id}>
      ${renderDeleteProviderAction(card, props)} ${renderMutationMessage(message)}
    </div>
  `;
}

export function renderAddProvider(props: ModelProvidersViewProps) {
  if (!props.addProviderOpen) {
    return nothing;
  }
  const busy = Boolean(props.busy.add);
  const disabled = configMutationDisabled(props) || busy;
  const provider = props.unconfiguredProviders.find((entry) => entry.id === props.addProviderId);
  return html`
    <openclaw-modal-dialog
      label=${t("modelProviders.add.title")}
      @modal-cancel=${(event: Event) => {
        event.preventDefault();
        if (!busy) {
          props.onAddProviderToggle();
        }
      }}
    >
      <div class="model-setup-wizard" data-models-key-dialog>
        <div class="model-setup-wizard__header">
          <h2>${provider?.displayName ?? props.addProviderId}</h2>
        </div>
        <div class="model-setup-wizard__body">
          <p>${t("modelProviders.credentials.label", { agent: props.credentialAgentLabel })}</p>
          <label class="field">
            <span>${t("modelProviders.apiKey.label")}</span>
            <input
              type="password"
              autocomplete="off"
              placeholder=${t("modelProviders.apiKey.placeholder")}
              .value=${props.addProviderKey}
              ?disabled=${disabled}
              @input=${(event: Event) => props.onAddProviderKeyChange((event.target as HTMLInputElement).value)}
            />
          </label>
          ${renderMutationMessage(props.messages.add)}
        </div>
        <div class="model-setup-wizard__footer">
          <button class="btn" ?disabled=${busy} @click=${props.onAddProviderToggle}>
            ${t("common.cancel")}
          </button>
          <button
            class="btn primary"
            ?disabled=${disabled || !props.addProviderId || !props.addProviderKey.trim()}
            @click=${props.onAddProvider}
          >
            ${busy ? t("modelProviders.saving") : t("modelProviders.add.save")}
          </button>
        </div>
      </div>
    </openclaw-modal-dialog>
  `;
}
