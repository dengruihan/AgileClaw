import { html, nothing } from "lit";
import {
  TEXT_SCALE_STOPS,
  UI_APPEARANCE_DEFAULTS,
  type TextScaleStop,
} from "../../app/settings.ts";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import {
  loadTypefaceSpecimens,
  normalizeTypefaceOverride,
  resolveTypefaces,
  TYPEFACES,
} from "../../app/typography.ts";
import { renderPicker } from "../../components/select-picker.ts";
import {
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { APPEARANCE_SETTINGS_TARGET_IDS } from "./route-data.ts";
import { renderSessionSources } from "./session-sources.ts";
import {
  renderChatPreferencesSection,
  renderLanguageSection,
  serverUiPrefProvenanceHint,
  renderSidebarPreferencesSection,
} from "./view-appearance-preferences.ts";
import type { ConfigProps } from "./view-types.ts";

const TEXT_SCALE_LABELS: Record<TextScaleStop, string> = {
  90: "configView.textSizes.small",
  100: "configView.textSizes.default",
  110: "configView.textSizes.large",
  125: "configView.textSizes.xl",
  140: "configView.textSizes.xxl",
};

const STYLE_LABEL = "Phosphor";

function renderTypography(props: ConfigProps) {
  const options = Object.entries(TYPEFACES).map(([face, metadata]) => ({
    value: face,
    label: face === "system" ? t("configView.appearance.fonts.system") : metadata.label,
    description: t(`configView.appearance.fontNotes.${face}`),
    labelStyle: `font-family: ${metadata.stack}`,
  }));
  return html`
    <section id=${APPEARANCE_SETTINGS_TARGET_IDS.typography} class="settings-section">
      <div class="settings-section__header">
        <h2 class="settings-section__heading">${t("configView.appearance.typography")}</h2>
      </div>
      <div class="settings-group">
        ${(["ui", "chat"] as const).map((slot) => {
          const isUi = slot === "ui";
          const title = t(`configView.appearance.fonts.${slot}`);
          const face = resolveTypefaces()[slot];
          return html`
            ${renderSettingsRow({
              title,
              description: serverUiPrefProvenanceHint(
                isUi ? props.fontUiProvenance : props.fontChatProvenance,
              ),
              stackedOnNarrow: true,
              control: renderPicker({
                id: `settings-font-${slot}`,
                label: title,
                value: (isUi ? props.fontUi : props.fontChat) ?? "theme",
                options: [
                  {
                    value: "theme",
                    label: t("configView.appearance.fonts.themeDefault"),
                    description: t("configView.appearance.fonts.themeFace", {
                      theme: STYLE_LABEL,
                      face: TYPEFACES[face].label,
                    }),
                    labelStyle: `font-family: ${TYPEFACES[face].stack}`,
                  },
                  ...options,
                ],
                onOpen: loadTypefaceSpecimens,
                onChange: (value) =>
                  (isUi ? props.setFontUi : props.setFontChat)(normalizeTypefaceOverride(value)),
              }),
            })}
          `;
        })}
        <div class="settings-row settings-row--stacked">
          <div class="settings-typography-preview">
            <div class="settings-typography-preview__caption">
              ${t("configView.appearance.fonts.previewCaption")}
            </div>
            <p class="settings-typography-preview__prose">
              ${t("configView.appearance.fonts.previewProse")}
            </p>
            <code class="settings-typography-preview__code"
              >${t("configView.appearance.fonts.previewCode")}</code
            >
          </div>
        </div>
      </div>
    </section>
  `;
}

export function renderAppearanceSection(props: ConfigProps) {
  const themeModeDefault =
    props.themeModeResetValue === "light"
      ? t("common.light")
      : props.themeModeResetValue === "dark"
        ? t("common.dark")
        : t("common.system");
  const themeModeProvenance = serverUiPrefProvenanceHint(props.themeModeProvenance);
  return html`
    <div class="settings-page" ${shellLayoutTraits({ settingsPage: true })}>
      ${renderLanguageSection(props)}
      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.theme} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("common.colorMode")}</h2>
        </div>
        <p class="settings-section__desc">
          ${renderSettingsDefaultDescription(themeModeDefault, props.themeModeOverridden)}
          ${themeModeProvenance}
        </p>
        <div class="settings-group">
          ${renderSettingsRow({
            title: t("common.colorMode"),
            stackedOnNarrow: true,
            control: renderSettingsSegmented({
              value: props.themeMode,
              options: [
                { value: "system", label: t("common.system") },
                { value: "light", label: t("common.light") },
                { value: "dark", label: t("common.dark") },
              ],
              ariaLabel: t("common.colorMode"),
              onChange: (mode) => props.setThemeMode(mode),
              onReselect: (mode) => {
                if (props.themeModeOverridden && mode === props.themeModeResetValue) {
                  props.setThemeMode(mode);
                }
              },
            }),
          })}
        </div>
      </section>

      ${renderTypography(props)}

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.textSize} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.appearance.textSize")}</h2>
        </div>
        <p class="settings-section__desc">
          ${renderSettingsDefaultDescription(
            `${UI_APPEARANCE_DEFAULTS.textScale}%`,
            props.textScaleOverridden,
          )}
          ${t("quickSettings.personal.browserOnly")}
        </p>
        <div class="settings-group">
          <div class="settings-row settings-row--stacked">
            <div class="settings-text-scale">
              <div class="settings-text-scale__options">
                ${TEXT_SCALE_STOPS.map(
                  (stop) => html`
                    <button
                      type="button"
                      class="settings-text-scale__btn ${stop === props.textScale ? "active" : ""}"
                      aria-pressed=${String(stop === props.textScale)}
                      @click=${() => props.setTextScale(stop)}
                    >
                      <span class="settings-text-scale__sample">${t(TEXT_SCALE_LABELS[stop])}</span>
                      <span class="settings-text-scale__label">${stop}%</span>
                    </button>
                  `,
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      ${renderSidebarPreferencesSection(props)} ${renderChatPreferencesSection(props)}
      ${renderSessionSources(props)}

      <section id=${APPEARANCE_SETTINGS_TARGET_IDS.connection} class="settings-section">
        <div class="settings-section__header">
          <h2 class="settings-section__heading">${t("configView.connection.title")}</h2>
        </div>
        <div class="settings-group">
          ${renderSettingsRow({
            title: t("configView.connection.gateway"),
            control: renderSettingsValue(props.gatewayUrl || "-", { mono: true }),
          })}
          ${renderSettingsRow({
            title: t("configView.connection.status"),
            control: renderSettingsStatus({
              kind: props.connected ? "ok" : "muted",
              label: props.connected ? t("common.connected") : t("common.offline"),
            }),
          })}
          ${
            props.assistantName
              ? renderSettingsRow({
                  title: t("configView.connection.assistant"),
                  control: renderSettingsValue(props.assistantName),
                })
              : nothing
          }
        </div>
      </section>
    </div>
  `;
}
