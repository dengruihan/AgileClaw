import { html, nothing, type TemplateResult } from "lit";
import type { ControlUiBuildInfo } from "../../build-info.ts";
import { brandIcons } from "../../components/brand-icons.ts";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import {
  renderSettingsPage,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { i18n, t } from "../../i18n/index.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import "../../styles/about.css";

export type AboutCommitCopyState = "idle" | "copying" | "copied" | "error";

type AboutProps = {
  buildInfo: ControlUiBuildInfo;
  gatewayVersion: string | null;
  copyState: AboutCommitCopyState;
  onCopyCommit: () => void;
};

const SHORT_COMMIT_LENGTH = 12;

// GitHub is the project home until an AgileClaw website ships; the former
// Website/Docs/Discord/X/Changelog entries pointed at upstream OpenClaw
// resources and return alongside that site.
const ABOUT_LINKS: ReadonlyArray<{ href: string; icon: TemplateResult; label: () => string }> = [
  {
    href: "https://github.com/dengruihan/AgileClaw",
    icon: brandIcons.github,
    label: () => t("aboutPage.linkGitHub"),
  },
];

function formatControlUiBuildDate(
  value: string | null,
  locales?: Intl.LocalesArgument,
): string | null {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locales, {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function renderUnavailable() {
  return html`<span class="muted">${t("aboutPage.unavailable")}</span>`;
}

// Always-relative commit age; the exact localized timestamp lives on hover
// (title) so the row stays compact for any artifact age.
function renderCommitAge(commitAt: string | null) {
  if (!commitAt) {
    return nothing;
  }
  const timestamp = Date.parse(commitAt);
  if (!Number.isFinite(timestamp)) {
    return nothing;
  }
  const exact = new Intl.DateTimeFormat(i18n.getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
  return html`
    <time class="about-commit__age" dir="auto" datetime=${commitAt} title=${exact}
      >${formatRelativeTimestamp(timestamp, { fallback: "" })}</time
    >
  `;
}

function renderCommit(props: AboutProps) {
  const commit = props.buildInfo.commit;
  if (!commit) {
    return renderUnavailable();
  }
  const label = t(
    {
      idle: "aboutPage.copyCommit",
      copying: "aboutPage.copyingCommit",
      copied: "aboutPage.copiedCommit",
      error: "aboutPage.copyCommitFailed",
    }[props.copyState],
  );
  return html`
    <span class="about-commit">
      <code dir="ltr" title=${commit}>${commit.slice(0, SHORT_COMMIT_LENGTH)}</code>
      ${renderCommitAge(props.buildInfo.commitAt)}
      <openclaw-tooltip .content=${label}>
        <button
          type="button"
          class="about-commit__copy"
          aria-label=${label}
          aria-busy=${props.copyState === "copying" ? "true" : nothing}
          ?disabled=${props.copyState === "copying"}
          @click=${props.onCopyCommit}
        >
          <span aria-hidden="true">${props.copyState === "copied" ? icons.check : icons.copy}</span>
        </button>
      </openclaw-tooltip>
      <span class="sr-only" role="status" aria-live="polite"
        >${props.copyState === "copied" || props.copyState === "error" ? label : ""}</span
      >
    </span>
  `;
}

function renderHero(props: AboutProps) {
  return html`
    <section class="about-hero">
      <span class="about-hero__mark" aria-hidden="true">${icons.lobster}</span>
      <h2 class="about-hero__name">${t("aboutPage.productName")}</h2>
      <p class="about-hero__tagline">${t("aboutPage.tagline")}</p>
      ${
        props.buildInfo.version
          ? html`<code class="about-hero__version" dir="ltr">v${props.buildInfo.version}</code>`
          : nothing
      }
      <nav class="about-hero__links" aria-label=${t("aboutPage.linksLabel")}>
        ${ABOUT_LINKS.map(
          (link) => html`
            <a
              class="about-hero__link"
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
            >
              <span class="about-hero__link-icon" aria-hidden="true">${link.icon}</span>
              <span>${link.label()}</span>
            </a>
          `,
        )}
      </nav>
    </section>
  `;
}

export function renderAbout(props: AboutProps) {
  const buildDate = formatControlUiBuildDate(props.buildInfo.builtAt, i18n.getLocale());
  const buildFacts = html`
    <dl class="settings-kv about-build-grid" aria-label=${t("aboutPage.artifactDetails")}>
      <dt>${t("aboutPage.version")}</dt>
      <dd>
        ${
          props.buildInfo.version
            ? html`<code dir="ltr" title=${props.buildInfo.version}
                >${props.buildInfo.version}</code
              >`
            : renderUnavailable()
        }
      </dd>
      <dt>${t("aboutPage.commit")}</dt>
      <dd>${renderCommit(props)}</dd>
      ${
        props.buildInfo.branch
          ? html`
              <dt>${t("aboutPage.branch")}</dt>
              <dd>
                <code dir="ltr" title=${props.buildInfo.branch}
                  >${props.buildInfo.branch}${props.buildInfo.dirty === true ? "*" : ""}</code
                >
              </dd>
            `
          : nothing
      }
      <dt>${t("aboutPage.built")}</dt>
      <dd>
        ${
          buildDate && props.buildInfo.builtAt
            ? html`<time
                dir="auto"
                datetime=${props.buildInfo.builtAt}
                title=${props.buildInfo.builtAt}
                >${buildDate}</time
              >`
            : renderUnavailable()
        }
      </dd>
    </dl>
  `;
  return renderSettingsPage([
    renderHero(props),
    renderSettingsSection(
      { title: t("aboutPage.artifactTitle"), description: t("aboutPage.artifactSubtitle") },
      buildFacts,
    ),
    renderSettingsSection(
      {},
      renderSettingsRow({
        title: t("aboutPage.gatewayVersion"),
        description: t("aboutPage.gatewayVersionHint"),
        control: props.gatewayVersion
          ? renderSettingsValue(
              html`<code dir="ltr" title=${props.gatewayVersion}>${props.gatewayVersion}</code>`,
              { mono: true },
            )
          : renderSettingsValue(t("aboutPage.unavailable")),
      }),
    ),
    html`<p class="about-footer">${t("aboutPage.license")}</p>`,
  ]);
}
