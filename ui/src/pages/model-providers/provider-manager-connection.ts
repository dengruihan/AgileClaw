import { html, nothing, type TemplateResult } from "lit";
import type { ModelsAuthInspectApiKeyResult } from "../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { stringInputValue } from "./provider-manager-model-form.ts";

/** Interactive members the provider-manager connection form reads and calls. */
export type ProviderConnectionActions = {
  onConnect: () => void;
  onProviderIdInput: (value: string) => void;
  onKeyInput: (value: string) => void;
  onToggleRevealKey: () => void;
  onFieldInput: (key: "baseUrl" | "api", value: string) => void;
};

export type ProviderConnectionState = {
  busy: boolean;
  card: ModelProviderCard | null;
  creating: boolean;
  dirty: boolean;
  disabled: boolean;
  draft: Record<string, unknown>;
  keyDraft: string;
  keyLoading: boolean;
  keyError: string | null;
  keySource: ModelsAuthInspectApiKeyResult["source"];
  providerCreated: boolean;
  providerId: string;
  revealKey: boolean;
};

/** Provider protocol options shown with friendly labels; values are config `api` values. */
const PROVIDER_API_OPTIONS = [
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
  const authMode = !creating ? state.card?.configAuthMode : undefined;
  const authModeBlocked = Boolean(authMode && authMode !== "api-key");
  return html` ${
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
        placeholder="https://api.example.com/v1"
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
        : authModeBlocked
          ? html`<p class="muted">
              ${t("modelProviders.apiKey.authModeBlocked", { mode: authMode ?? "" })}
            </p>`
          : html`<label class="field"
              ><span>${t("modelProviders.apiKey.label")}</span>
              <div class="provider-manager__key">
                <input
                  name="apiKey"
                  type=${state.revealKey ? "text" : "password"}
                  autocomplete="new-password"
                  placeholder=${t("modelProviders.manager.keepKey")}
                  .value=${state.keyDraft}
                  ?disabled=${state.disabled || state.keyLoading}
                  @input=${(event: Event) => {
                    // SAFETY: the handler only fires on this api-key text input.
                    actions.onKeyInput((event.target as HTMLInputElement).value);
                  }}
                /><button
                  type="button"
                  class="btn btn--icon provider-manager__key-toggle"
                  aria-label=${t(state.revealKey ? "modelProviders.manager.hideKey" : "modelProviders.manager.showKey")}
                  title=${t(state.revealKey ? "modelProviders.manager.hideKey" : "modelProviders.manager.showKey")}
                  ?disabled=${state.keyLoading || !state.keyDraft}
                  aria-pressed=${state.revealKey}
                  @click=${actions.onToggleRevealKey}
                >
                  ${state.revealKey ? icons.eyeOff : icons.eye}
                </button>
              </div></label
            >`
    }
    ${state.keyError ? html`<p class="callout danger" role="alert">${state.keyError}</p>` : nothing}
    ${
      state.keySource === "environment" || state.keySource === "reference"
        ? html`<p class="muted">${t("modelProviders.manager.externalKey")}</p>`
        : nothing
    }
    ${
      creating && !state.providerCreated
        ? html`<p class="muted">${t("modelProviders.manager.addModelsAfterSave")}</p>`
        : nothing
    }`;
}
