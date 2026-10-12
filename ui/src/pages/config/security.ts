import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
// Control UI Privacy & Security settings page presentation. Curated rows for
// the highest-impact policies sit above the schema-backed security/approvals
// section editor (same composition pattern as mcp.ts).
import { html, type TemplateResult } from "lit";
import { shellLayoutTraits } from "../../app/shell-layout-traits.ts";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { PROFILE_OPTIONS } from "../../lib/agents/tool-catalog.ts";

export type SecurityOverview = {
  gatewayAuth: string;
  execPolicy: string;
  browserEnabled: boolean;
  browserEnabledOverridden: boolean;
  redactionEnabled: boolean;
  redactionOverridden: boolean;
  toolProfile: string;
  toolProfileOverridden: boolean;
};

type SecurityViewProps = {
  security: SecurityOverview;
  configBusy: boolean;
  canPairDevice: boolean;
  onPairMobile?: () => void;
  onBrowserEnabledToggle?: (enabled: boolean) => void;
  onRedactionToggle?: (enabled: boolean) => void;
  onToolProfileChange?: (profile: string) => void;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

function renderSecurityOverview(props: SecurityViewProps) {
  const {
    gatewayAuth,
    execPolicy,
    browserEnabled,
    browserEnabledOverridden,
    redactionEnabled,
    redactionOverridden,
    toolProfile,
    toolProfileOverridden,
  } = props.security;
  const normalizedToolProfile = toolProfile.trim();
  const profileOptions = PROFILE_OPTIONS.map((profile) => ({
    value: profile.id as string,
    label: t(profile.labelKey),
  }));
  if (
    normalizedToolProfile &&
    !profileOptions.some((option) => option.value === normalizedToolProfile)
  ) {
    profileOptions.push({ value: normalizedToolProfile, label: normalizedToolProfile });
  }
  return renderSettingsSection({ title: t("quickSettings.security.title") }, [
    renderSettingsRow({
      title: t("quickSettings.security.gatewayAuth"),
      control: renderSettingsStatus({
        // "unknown" is a pre-hello placeholder, not a healthy auth mode.
        kind: gatewayAuth === "none" ? "warn" : gatewayAuth === "unknown" ? "muted" : "ok",
        label: gatewayAuth,
      }),
    }),
    renderSettingsRow({
      title: t("quickSettings.security.execPolicy"),
      control: renderSettingsValue(execPolicy),
    }),
    renderSettingsToggleRow({
      title: t("quickSettings.security.browserEnabled"),
      description: renderSettingsDefaultDescription(t("common.enabled"), browserEnabledOverridden),
      checked: browserEnabled,
      disabled: props.configBusy,
      onChange: (enabled) => props.onBrowserEnabledToggle?.(enabled),
    }),
    renderSettingsToggleRow({
      title: t("quickSettings.security.redaction"),
      description: redactionEnabled
        ? renderSettingsDefaultDescription(t("common.enabled"), redactionOverridden)
        : t("quickSettings.security.redactionOffWarning"),
      checked: redactionEnabled,
      disabled: props.configBusy,
      onChange: (enabled) => props.onRedactionToggle?.(enabled),
    }),
    renderSettingsRow({
      title: t("quickSettings.security.toolProfile"),
      description: toolProfileOverridden
        ? undefined
        : t("quickSettings.security.toolProfileDefault"),
      stacked: true,
      control: renderSettingsSegmented({
        value: normalizedToolProfile,
        options: profileOptions,
        ariaLabel: t("quickSettings.security.toolProfile"),
        disabled: props.configBusy,
        onChange: (profile) => props.onToolProfileChange?.(profile),
      }),
    }),
    renderSettingsRow({
      title: t("devices.pairing.title"),
      control: html`
        <button
          class="btn"
          title=${props.canPairDevice ? "" : t("devices.pairing.adminRequired")}
          ?disabled=${!props.canPairDevice}
          @click=${props.onPairMobile}
        >
          ${icons.smartphone} ${t("devices.pairing.button")}
        </button>
      `,
    }),
  ]);
}

export function extractQuickSettingsSecurity(root: Record<string, unknown>): SecurityOverview {
  const gateway = asConfigRecord(root.gateway);
  const auth = asConfigRecord(gateway?.auth);
  const tools = asConfigRecord(root.tools);
  const exec = asConfigRecord(tools?.exec) ?? {};
  const browser = asConfigRecord(root.browser);
  const logging = asConfigRecord(root.logging);
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    gatewayAuth = mode
      ? mode
      : auth.password
        ? "password"
        : auth.token
          ? "token"
          : auth.trustedProxy
            ? "trusted-proxy"
            : "none";
  }
  const profile = tools?.profile;
  const security = exec.security;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    browserEnabled: browser?.enabled !== false,
    browserEnabledOverridden: browser !== null && Object.hasOwn(browser, "enabled"),
    redactionEnabled: logging?.redact !== "off",
    redactionOverridden: logging !== null && Object.hasOwn(logging, "redact"),
    toolProfile: typeof profile === "string" ? profile.trim() : "",
    toolProfileOverridden: tools !== null && Object.hasOwn(tools, "profile"),
  };
}

export function renderSecurity(props: SecurityViewProps) {
  return html`
    <section class="security-page">
      <div class="settings-page" ${shellLayoutTraits({ settingsPage: true })}>
        ${renderSecurityOverview(props)}
      </div>
      ${props.editor}
    </section>
  `;
}
