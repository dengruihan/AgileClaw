import { html, nothing } from "lit";
import { renderSettingsStatus } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { formatDurationHuman } from "../../lib/format-duration.ts";
import type { ModelProviderCard } from "./data.ts";

registerSettingsEnglish();

type ProviderProfile = ModelProviderCard["profiles"][number];

function profileSource(profile: ProviderProfile): string | undefined {
  switch (profile.source) {
    case "config":
      return t("modelProviders.profiles.sourceConfig");
    case "external":
      return profile.displayName || t("modelProviders.profiles.sourceExternal");
    case "inherited":
      return t("modelProviders.profiles.sourceInherited");
    case "saved":
      return t("modelProviders.profiles.sourceSaved");
    default:
      return undefined;
  }
}

function apiKeySource(card: ModelProviderCard): string | undefined {
  if (card.apiKey?.source === "config") {
    return t("modelProviders.credentials.configKey");
  }
  if (card.apiKey?.source !== "env") {
    return undefined;
  }
  return card.apiKey.envVar
    ? t("modelProviders.credentials.envKeyNamed", { name: card.apiKey.envVar })
    : t("modelProviders.credentials.envKey");
}

function profileMeta(profile: ProviderProfile): string {
  const parts: string[] = [];
  const source = profileSource(profile);
  if (source && profile.source !== "saved") {
    parts.push(source);
  }
  if (profile.email && profile.displayName && profile.displayName !== source) {
    parts.push(profile.displayName);
  }
  if (profile.lastUsedAt) {
    parts.push(
      t("modelProviders.profiles.lastUsed", {
        time: formatDurationHuman(Date.now() - profile.lastUsedAt),
      }),
    );
  }
  return parts.join(" · ");
}

function profileInitials(identity: string): string {
  const localPart = identity.split("@")[0] ?? "";
  const words = localPart.split(/[^a-z0-9]+/iu).filter(Boolean);
  const initials =
    words.length > 1
      ? `${words[0]?.[0] ?? ""}${words.at(-1)?.[0] ?? ""}`
      : (words[0]?.slice(0, 2) ?? "");
  return initials.toLocaleUpperCase() || "?";
}

function profileStatus(profile: ProviderProfile, providerAuthRejected: boolean) {
  const status =
    profile.externallyManaged && (profile.status === "expired" || profile.status === "expiring")
      ? "ok"
      : profile.status;
  switch (status) {
    case "ok":
      return renderSettingsStatus({
        kind: providerAuthRejected ? "muted" : "ok",
        label: t(
          providerAuthRejected ? "modelProviders.status.configured" : "modelProviders.status.ok",
        ),
      });
    case "static":
      return renderSettingsStatus({ kind: "ok", label: t("modelProviders.status.configured") });
    case "expiring":
      return renderSettingsStatus({ kind: "warn", label: t("modelProviders.status.expiring") });
    case "expired":
      return renderSettingsStatus({ kind: "danger", label: t("modelProviders.status.expired") });
    default:
      return renderSettingsStatus({ kind: "muted", label: t("modelProviders.status.missing") });
  }
}

function profileIdentity(profile: ProviderProfile, index: number): string {
  return (
    profile.email ||
    profile.displayName ||
    t("modelProviders.profiles.account", { number: String(index + 1) })
  );
}

function renderProfileIdentity(profile: ProviderProfile, identity: string, showDetails: boolean) {
  const meta = profileMeta(profile);
  return html`
    <span class="model-providers__profile-avatar" aria-hidden="true"
      >${profileInitials(identity)}</span
    >
    <div class="model-providers__profile-copy">
      <strong>${identity}</strong>
      ${meta ? html`<span>${meta}</span>` : nothing}
      ${
        showDetails
          ? html`<details>
              <summary>${t("modelProviders.profiles.details")}</summary>
              <div>${profile.profileId}</div>
              ${profile.expiry ? html`<span>${t("modelProviders.expiresIn", { time: profile.expiry.label })}</span>` : nothing}
            </details>`
          : nothing
      }
    </div>
  `;
}

export function renderProviderAccountSummary(
  cards: ModelProviderCard[],
  recovery?: {
    authProvider: string;
    disabled: boolean;
    onUse: (profileId: string) => void;
  },
) {
  const profiles = cards.flatMap((card) =>
    card.profiles.map((profile) => ({
      profile,
      authRejected: card.catalogStatus === "auth-rejected",
      // A display card can combine providers whose credentials are not interchangeable.
      canUse:
        card.profileProviderIds[profile.profileId] === recovery?.authProvider &&
        (profile.source === "saved" || profile.source === "inherited"),
    })),
  );
  const sources = [...new Set(cards.map(apiKeySource).filter(Boolean))];
  return html`
    <section
      class="model-provider-login__accounts"
      aria-label=${t("modelProviders.login.accounts")}
    >
      <h3>${t("modelProviders.login.accounts")}</h3>
      ${
        profiles.length
          ? html`
              <div role="list">
                ${profiles.map(
                  ({ profile, authRejected, canUse }, index) => html`
                    <div
                      class="model-provider-login__account"
                      role="listitem"
                      data-profile-id=${profile.profileId}
                    >
                      ${renderProfileIdentity(profile, profileIdentity(profile, index), false)}
                      ${profileStatus(profile, authRejected)}
                      ${
                        canUse && recovery
                          ? html`<button
                              class="btn"
                              data-models-use-account
                              ?disabled=${recovery.disabled}
                              @click=${() => recovery.onUse(profile.profileId)}
                            >
                              ${t("modelProviders.login.useAccount")}
                            </button>`
                          : nothing
                      }
                    </div>
                  `,
                )}
              </div>
            `
          : nothing
      }
      ${sources.map((source) => html`<p class="muted">${source}</p>`)}
      ${!profiles.length && !sources.length ? html`<p class="muted">${t("modelProviders.login.noAccounts")}</p>` : nothing}
    </section>
  `;
}
