// Shared guided presentation for the device pairing setup dialog. The Devices
// dialog and the New Session "Connect a machine" dialog both render this body;
// each host owns only its outer chrome. Node handoffs are guided through
// download → transfer → observe with no terminal command anywhere: the join URL
// and the bare setup code are both reveal-once secrets.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { handleCopyButton, renderCopyButton } from "../../components/copy-button.ts";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { registerAppsEnglish } from "../../i18n/locales/en-apps.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import type {
  DevicePairSetupAccess,
  DevicePairSetupLifecycle,
} from "../../lib/device-pair-setup.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { formatCountdown } from "../../lib/format.ts";
import { APP_DOWNLOAD_LINKS } from "../apps/download-links.ts";

registerDevicesEnglish();
registerAppsEnglish();

const PAIRING_ACCESS_OPTIONS = [
  ["full", "devices.pairing.fullAccess", "devices.pairing.fullAccessHint"],
  ["limited", "devices.pairing.limitedAccess", "devices.pairing.limitedAccessHint"],
  ["node", "devices.pairing.nodeAccess", "devices.pairing.nodeAccessHint"],
] as const satisfies ReadonlyArray<readonly [DevicePairSetupAccess, string, string]>;

export type DevicePairSetupBodyProps = {
  lifecycle: DevicePairSetupLifecycle;
  nowMs: number;
  pendingCount: number;
  /** Node-scoped host: no access choices and no QR, only the guided handoff. */
  nodeOnly: boolean;
  secretRevealed: boolean;
  onToggleSecret: () => void;
  onRefresh: () => void;
  onAccessChange: (access: DevicePairSetupAccess) => void;
  onClose: () => void;
  onManageDevices: () => void;
  /** Deep-links a failed setup request to the existing Gateway connection settings. */
  onOpenConnectionSettings?: () => void;
};

export function accessLabel(access: DevicePairSetupLifecycle["access"]): string {
  if (access === "limited") {
    return t("devices.pairing.limitedAccess");
  }
  if (access === "node") {
    return t("devices.pairing.nodeAccessSummary");
  }
  return t("devices.pairing.fullAccessSummary");
}

// Secrets render masked until deliberately revealed; copying works either way.
const SECRET_MASK = "••••••••••••••••";

function renderSecretRow(params: {
  value: string;
  revealed: boolean;
  onToggle: () => void;
  copyLabel: string;
}) {
  const revealLabel = t(
    params.revealed ? "devices.pairing.hideSecret" : "devices.pairing.showSecret",
  );
  return html`<div class="device-pair-setup__secret">
    <div class="login-gate__command">
      <code data-secret-state=${params.revealed ? "revealed" : "masked"}>
        ${params.revealed ? params.value : SECRET_MASK}
      </code>
      ${renderCopyButton(params.value, params.copyLabel)}
    </div>
    <button
      class="btn btn--xs"
      type="button"
      aria-pressed=${String(params.revealed)}
      @click=${params.onToggle}
    >
      ${revealLabel}
    </button>
  </div>`;
}

function renderSetupCodeFallback(params: { setupCode: string; copyLabel: string }) {
  return keyed(
    params.setupCode,
    html`<details class="device-pair-setup__fallback">
      <summary>${t("devices.pairing.showSetupCode")}</summary>
      <div class="login-gate__command">
        <code>${params.setupCode}</code>
        ${renderCopyButton(params.setupCode, params.copyLabel)}
      </div>
      <p class="device-pair-setup__waiting">${t("devices.pairing.setupCodeFallbackHint")}</p>
    </details>`,
  );
}

function renderNodeHandoffSteps(props: DevicePairSetupBodyProps) {
  const setup = (props.lifecycle as Extract<DevicePairSetupLifecycle, { phase: "waiting" }>).setup;
  const joinUrl = setup.joinUrl?.trim() ?? "";
  const setupExpired = setup.expiresAtMs <= props.nowMs;
  const countdown = setupExpired
    ? t(joinUrl ? "devices.pairing.joinExpired" : "devices.pairing.setupCodeExpired")
    : t(joinUrl ? "devices.pairing.joinExpiresIn" : "devices.pairing.setupCodeExpiresIn", {
        time: formatCountdown(setup.expiresAtMs, props.nowMs),
      });
  return html`
    <ol class="device-pair-setup__steps">
      <li class="device-pair-setup__step">
        <h3>${t("devices.pairing.stepDownloadTitle")}</h3>
        <p>${t("devices.pairing.stepDownloadHint")}</p>
        <div class="device-pair-setup__downloads">
          ${APP_DOWNLOAD_LINKS.map(
            (link) => html`<a
              href=${link.href}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              aria-label=${t("devices.pairing.downloadPlatform", {
                platform: t(`appsPage.cards.${link.id}.title`),
              })}
            >
              ${t(`appsPage.cards.${link.id}.title`)}
              <span class="device-pair-setup__external-icon" aria-hidden="true"
                >${icons.externalLink}</span
              >
            </a>`,
          )}
        </div>
      </li>
      <li class="device-pair-setup__step">
        <h3>
          ${t(
            joinUrl
              ? "devices.pairing.stepTransferTitle"
              : "devices.pairing.stepTransferFallbackTitle",
          )}
        </h3>
        <p>
          ${t(
            joinUrl
              ? "devices.pairing.stepTransferHint"
              : "devices.pairing.stepTransferFallbackHint",
          )}
        </p>
        ${
          joinUrl && !setupExpired
            ? renderSecretRow({
                value: joinUrl,
                revealed: props.secretRevealed,
                onToggle: props.onToggleSecret,
                copyLabel: t("devices.pairing.copyJoinUrl"),
              })
            : nothing
        }
        ${
          !joinUrl && !setupExpired
            ? renderSecretRow({
                value: setup.setupCode,
                revealed: props.secretRevealed,
                onToggle: props.onToggleSecret,
                copyLabel: t("devices.pairing.copySetupCode"),
              })
            : nothing
        }
        <p class="device-pair-setup__waiting" role="timer" aria-live="off">${countdown}</p>
        ${
          joinUrl
            ? renderSetupCodeFallback({
                setupCode: setup.setupCode,
                copyLabel: t("devices.pairing.copySetupCode"),
              })
            : nothing
        }
      </li>
      <li class="device-pair-setup__step">
        <h3>${t("devices.pairing.stepObserveTitle")}</h3>
        <p>${t("devices.pairing.stepObserveHint")}</p>
      </li>
    </ol>
  `;
}

export function renderDevicePairSetupBody(props: DevicePairSetupBodyProps) {
  const lifecycle = props.lifecycle;
  const setup = lifecycle.phase === "waiting" ? lifecycle.setup : null;
  const isNodeSetup = props.nodeOnly || lifecycle.access === "node";
  const showAccessChoices =
    !props.nodeOnly &&
    lifecycle.phase !== "success" &&
    lifecycle.phase !== "delivery-uncertain" &&
    lifecycle.phase !== "reconciling" &&
    !(lifecycle.phase === "error" && lifecycle.source === "status");
  const canSelectAccess =
    lifecycle.phase === "selection" ||
    (lifecycle.phase === "error" && lifecycle.source === "create");
  const gatewayUrls = setup?.gatewayUrls ?? (setup ? [setup.gatewayUrl] : []);
  const copyLabel = t("devices.pairing.copySetupCode");
  return html`
    ${
      showAccessChoices
        ? html`<fieldset class="device-pair-setup__access" ?disabled=${!canSelectAccess}>
            <legend>${t("devices.pairing.accessTitle")}</legend>
            ${PAIRING_ACCESS_OPTIONS.map(
              ([access, label, hint]) => html`<label>
                <input
                  type="radio"
                  name="device-pair-access"
                  .checked=${lifecycle.access === access}
                  @change=${() => props.onAccessChange(access)}
                />
                <span>
                  <strong>${t(label)}</strong>
                  <small>${t(hint)}</small>
                </span>
              </label>`,
            )}
          </fieldset>`
        : nothing
    }
    ${
      lifecycle.phase === "selection"
        ? html`
            <button class="btn primary" type="button" @click=${props.onRefresh}>
              ${isNodeSetup ? icons.server : icons.smartphone} ${t("devices.pairing.generateCode")}
            </button>
          `
        : nothing
    }
    ${
      lifecycle.phase === "loading" || lifecycle.phase === "reconciling"
        ? html`
            <div class="device-pair-setup__loading" role="status" aria-live="polite">
              <span class="device-pair-setup__spinner" aria-hidden="true"></span>
              <span
                >${t(lifecycle.phase === "loading" ? "devices.pairing.generating" : "common.loading")}</span
              >
            </div>
          `
        : nothing
    }
    ${
      lifecycle.phase === "error"
        ? html`
            <div class="callout danger device-pair-setup__error" role="alert">
              <strong
                >${t(
                  lifecycle.source === "status"
                    ? "devices.pairing.statusFailed"
                    : "devices.pairing.failed",
                )}</strong
              >
              <span>${lifecycle.message}</span>
            </div>
            <div class="device-pair-setup__actions">
              <button class="btn primary" type="button" @click=${props.onRefresh}>
                ${icons.refresh} ${t("common.reload")}
              </button>
              ${
                props.onOpenConnectionSettings
                  ? html`<button class="btn" type="button" @click=${props.onOpenConnectionSettings}>
                      ${t("devices.pairing.connectionSettings")}
                    </button>`
                  : nothing
              }
            </div>
          `
        : nothing
    }
    ${
      setup && isNodeSetup
        ? html`
            ${renderNodeHandoffSteps(props)}
            <div class="device-pair-setup__meta">
              <span class="settings-status settings-status--accent">
                <span class="settings-status__dot"></span>
                ${setup.auth}
              </span>
              <div class="device-pair-setup__gateways">
                ${gatewayUrls.map(
                  (gatewayUrl) => html`
                    <span class="device-pair-setup__gateway" title=${gatewayUrl}
                      >${gatewayUrl}</span
                    >
                  `,
                )}
              </div>
            </div>
            ${
              setup.accessDowngraded
                ? html`
                    <div class="callout warn device-pair-setup__access-warning" role="status">
                      <strong>${t("devices.pairing.transportLimitedTitle")}</strong>
                      <span>${t("devices.pairing.transportLimitedHint")}</span>
                    </div>
                  `
                : nothing
            }
            <div class="device-pair-setup__actions">
              <button class="btn" type="button" @click=${props.onRefresh}>
                ${icons.refresh} ${t("devices.pairing.newCode")}
              </button>
            </div>
          `
        : nothing
    }
    ${
      setup && !isNodeSetup
        ? html`
            <div class="device-pair-setup__qr-frame">
              ${
                setup.qrDataUrl
                  ? html`<img
                      class="device-pair-setup__qr"
                      src=${setup.qrDataUrl}
                      alt=${t("devices.pairing.qrAlt")}
                      width="360"
                      height="360"
                      draggable="false"
                    />`
                  : html`<div class="device-pair-setup__qr-unavailable">
                      ${t("devices.pairing.qrUnavailable")}
                    </div>`
              }
            </div>
            <div class="device-pair-setup__meta">
              <span class="settings-status settings-status--accent">
                <span class="settings-status__dot"></span>
                ${setup.auth}
              </span>
              <div class="device-pair-setup__gateways">
                ${gatewayUrls.map(
                  (gatewayUrl) => html`
                    <span class="device-pair-setup__gateway" title=${gatewayUrl}
                      >${gatewayUrl}</span
                    >
                  `,
                )}
              </div>
            </div>
            ${
              setup.accessDowngraded
                ? html`
                    <div class="callout warn device-pair-setup__access-warning" role="status">
                      <strong>${t("devices.pairing.transportLimitedTitle")}</strong>
                      <span>${t("devices.pairing.transportLimitedHint")}</span>
                    </div>
                  `
                : nothing
            }
            <div class="device-pair-setup__actions">
              ${keyed(
                setup.setupCode,
                html`<button
                  class="btn primary"
                  type="button"
                  @click=${(event: Event) =>
                    void handleCopyButton(event, setup.setupCode, copyLabel)}
                >
                  ${icons.copy} <span data-copy-label>${copyLabel}</span>
                </button>`,
              )}
              <button class="btn" type="button" @click=${props.onRefresh}>
                ${icons.refresh} ${t("devices.pairing.newCode")}
              </button>
            </div>
            ${renderSetupCodeFallback({ setupCode: setup.setupCode, copyLabel })}
            <p class="device-pair-setup__waiting">${t("devices.pairing.waiting")}</p>
          `
        : nothing
    }
    ${
      (lifecycle.phase === "waiting" || lifecycle.phase === "success") && props.pendingCount > 0
        ? html`
            <div class="callout warn device-pair-setup__pending">
              <span>${t("devices.pairing.pending", { count: String(props.pendingCount) })}</span>
              <button class="btn btn--sm" @click=${props.onManageDevices}>
                ${t("devices.pairing.review")}
              </button>
            </div>
          `
        : nothing
    }
    ${
      lifecycle.phase === "success"
        ? html`<div class="device-pair-setup__state" role="status" aria-live="polite">
            <div
              class="device-pair-setup__state-icon device-pair-setup__state-icon--success"
              aria-hidden="true"
            >
              ${icons.badgeCheck}
            </div>
            <h3>${lifecycle.deviceName ?? t("devices.pairing.pairedTitle")}</h3>
            <p>
              ${
                lifecycle.deviceName
                  ? html`${t("devices.pairing.pairedTitle")}
                      <span aria-hidden="true">·</span> `
                  : nothing
              }${accessLabel(lifecycle.access)}
            </p>
            <div class="device-pair-setup__actions">
              <button class="btn primary" type="button" @click=${props.onManageDevices}>
                ${t("devices.pairing.openInventory")}
              </button>
              <button class="btn btn--ghost" type="button" @click=${props.onClose}>
                ${t("devices.pairing.done")}
              </button>
            </div>
          </div>`
        : nothing
    }
    ${
      lifecycle.phase === "delivery-uncertain"
        ? html`<div class="device-pair-setup__state" role="alert">
            <div class="device-pair-setup__state-icon" aria-hidden="true">
              ${icons.alertTriangle}
            </div>
            <h3>${t("devices.pairing.deliveryUncertainTitle")}</h3>
            <p>${t("devices.pairing.deliveryUncertainHint")}</p>
            <div class="device-pair-setup__actions">
              <button class="btn primary" type="button" @click=${props.onRefresh}>
                ${icons.refresh} ${t("devices.pairing.generateNewCode")}
              </button>
            </div>
          </div>`
        : nothing
    }
    ${
      lifecycle.phase === "expired"
        ? html`<div class="device-pair-setup__state" role="status" aria-live="polite">
            <div class="device-pair-setup__state-icon" aria-hidden="true">${icons.refresh}</div>
            <h3>${t("devices.pairing.expiredTitle")}</h3>
            <button class="btn primary" type="button" @click=${props.onRefresh}>
              ${icons.refresh} ${t("devices.pairing.generateNewCode")}
            </button>
          </div>`
        : nothing
    }
  `;
}
