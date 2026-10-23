import { html, nothing, type TemplateResult } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { stringInputValue } from "./provider-manager-model-form.ts";

/** Interactive members the provider-manager connection form reads and calls. */
export type ProviderConnectionActions = {
  onConnect: () => void;
  onProbe: () => void;
  onRemoveCredential: () => Promise<void>;
  onProviderIdInput: (value: string) => void;
  onKeyInput: (value: string) => void;
  onToggleRevealKey: () => void;
  onFieldInput: (key: "baseUrl" | "api", value: string) => void;
};

export type ProviderConnectionState = {
  agentId: string;
  busy: boolean;
  card: ModelProviderCard | null;
  creating: boolean;
  dirty: boolean;
  disabled: boolean;
  draft: Record<string, unknown>;
  keyDraft: string;
  probe: ModelsProbeResult | undefined;
  providerCreated: boolean;
  providerId: string;
  revealKey: boolean;
};

/** Provider protocol options shown with friendly labels; values are config `api` values. */
export const PROVIDER_API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "openai-chatgpt-responses",
  "anthropic-messages",
  "google-generative-ai",
  "google-interactions",
  "google-vertex",
  "github-copilot",
  "bedrock-converse-stream",
  "ollama",
  "pi-messages",
  "azure-openai-responses",
] as const;

function apiOptionLabel(value: string): string {
  return t(`modelProviders.manager.apiFormat.${value}`);
}

/** Connection form for one provider-manager dialog body. */
export function providerConnectionFields(params: {
  actions: ProviderConnectionActions;
  state: ProviderConnectionState;
}): TemplateResult {
  const { actions, state } = params;
  const { creating } = state;
  // A custom provider has no catalog protocol to inherit, so creation starts
  // from the OpenAI-compatible default the save path already applies.
  const selectedApi =
    creating && state.draft.api === undefined
      ? "openai-completions"
      : stringInputValue(state.draft.api);
  return html` <p class="muted">
      ${t("modelProviders.manager.connectionScope", { agent: state.agentId })}
    </p>
    ${
      creating
        ? html`<label class="field"
            ><span>${t("modelProviders.manager.providerId")}</span
            ><input
              name="providerId"
              required
              pattern="[a-z0-9][a-z0-9._-]*"
              .value=${state.providerId}
              ?disabled=${state.disabled || state.providerCreated}
              @input=${(event: Event) => {
                // SAFETY: the handler only fires on this provider-id text input.
                actions.onProviderIdInput((event.target as HTMLInputElement).value);
              }}
          /></label>`
        : nothing
    }
    <label class="field"
      ><span>${t("modelProviders.manager.baseUrlLabel")}</span
      ><input
        name="baseUrl"
        .value=${stringInputValue(state.draft.baseUrl)}
        ?required=${creating}
        ?disabled=${state.disabled}
        @input=${(event: Event) => {
          // SAFETY: the handler only fires on this base-url text input.
          actions.onFieldInput("baseUrl", (event.target as HTMLInputElement).value);
        }}
    /></label>
    <label class="field"
      ><span>${t("modelProviders.manager.apiFormatLabel")}</span
      ><select
        name="api"
        class="settings-select"
        ?disabled=${state.disabled}
        @change=${(event: Event) => {
          // SAFETY: the handler only fires on this api-format select.
          actions.onFieldInput("api", (event.target as HTMLSelectElement).value);
        }}
      >
        ${
          creating
            ? nothing
            : html`<option value="" ?selected=${selectedApi === ""}>
                ${t("modelProviders.manager.apiFormatDefault")}
              </option>`
        }
        ${PROVIDER_API_OPTIONS.map(
          (value) =>
            html`<option value=${value} ?selected=${selectedApi === value}>
              ${apiOptionLabel(value)}
            </option>`,
        )}
      </select></label
    >
    ${
      state.card?.apiKeySupported === false && !creating
        ? html`<button
            type="button"
            class="btn"
            ?disabled=${state.disabled}
            @click=${actions.onConnect}
          >
            ${t("modelProviders.login.action")}
          </button>`
        : html`<label class="field"
            ><span>${t("modelProviders.apiKey.label")}</span>
            <div class="provider-manager__key">
              <input
                name="apiKey"
                type=${state.revealKey ? "text" : "password"}
                autocomplete="new-password"
                placeholder=${t("modelProviders.manager.keepKey")}
                .value=${state.keyDraft}
                ?disabled=${state.disabled}
                @input=${(event: Event) => {
                  // SAFETY: the handler only fires on this api-key text input.
                  actions.onKeyInput((event.target as HTMLInputElement).value);
                }}
              /><button
                type="button"
                class="btn btn--sm"
                aria-pressed=${state.revealKey}
                @click=${actions.onToggleRevealKey}
              >
                ${t(state.revealKey ? "modelProviders.manager.hideKey" : "modelProviders.manager.showKey")}
              </button>
            </div></label
          >`
    }
    ${
      !creating
        ? html`<p class="muted">${t("modelProviders.manager.saveBeforeTest")}</p>
            <div class="provider-manager__actions">
              <button
                type="button"
                class="btn"
                ?disabled=${state.disabled || state.dirty || !state.card}
                @click=${actions.onProbe}
              >
                ${t("modelProviders.probe.test")}</button
              >${
                state.card?.hasConfigApiKey ||
                state.card?.profiles.some(
                  (profile) => profile.type === "api_key" && profile.logoutSupported,
                )
                  ? html`<button
                      type="button"
                      class="btn danger"
                      ?disabled=${state.disabled}
                      @click=${() => void actions.onRemoveCredential()}
                    >
                      ${t("modelProviders.apiKey.remove")}
                    </button>`
                  : nothing
              }
            </div>
            ${
              state.probe
                ? html`<p
                    role="status"
                    class="callout ${state.probe.status === "ok" ? "success" : "danger"}"
                  >
                    ${t(`modelProviders.probe.status.${state.probe.status}`)}
                    ${state.probe.error ?? ""}
                  </p>`
                : nothing
            }`
        : state.providerCreated
          ? nothing
          : html`<p class="muted">${t("modelProviders.manager.addModelsAfterSave")}</p>`
    }`;
}
