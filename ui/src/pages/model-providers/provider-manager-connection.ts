import { html, nothing, type TemplateResult } from "lit";
import type { ModelsProbeResult } from "../../api/types.ts";
import type { JsonSchema } from "../../components/config-form.ts";
import { t } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";

/** Interactive members the provider-manager connection form reads and calls. */
export type ProviderConnectionActions = {
  onConnect: () => void;
  onProbe: () => void;
  onRemoveCredential: () => Promise<void>;
  onProviderIdInput: (value: string) => void;
  onKeyInput: (value: string) => void;
  onToggleRevealKey: () => void;
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
  schema: JsonSchema | null;
};

/** Connection form for one provider-manager dialog body. */
export function providerConnectionFields(params: {
  actions: ProviderConnectionActions;
  renderFields: (schema: JsonSchema, draft: Record<string, unknown>) => TemplateResult;
  state: ProviderConnectionState;
}): TemplateResult {
  const { actions, state } = params;
  const { creating } = state;
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
                actions.onProviderIdInput((event.target as HTMLInputElement).value);
              }}
          /></label>`
        : nothing
    }
    ${state.schema ? params.renderFields(state.schema, state.draft) : nothing}
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
        : html`<p class="muted">${t("modelProviders.manager.addModelsAfterSave")}</p>`
    }`;
}
