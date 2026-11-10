// Devices page renders the mobile device pairing setup dialog. The dialog's
// body (access choices, QR, guided node handoff, terminal states) is shared
// with the New Session "Connect a machine" dialog through pair-guided.ts.
import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import type { DevicePairSetupLifecycle } from "../../lib/device-pair-setup.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { renderDevicePairSetupBody, type DevicePairSetupBodyProps } from "./pair-guided.ts";

registerDevicesEnglish();

const MOBILE_PAIRING_DOCS_URL =
  "https://docs.openclaw.ai/channels/pairing#pair-from-the-control-ui-recommended";
const NODE_PAIRING_DOCS_URL = "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing";

export type DevicePairSetupProps = DevicePairSetupBodyProps & {
  open: boolean;
  onGetApps: () => void;
};

export function renderDevicePairSetup(props: DevicePairSetupProps) {
  if (!props.open) {
    return nothing;
  }
  const lifecycle: DevicePairSetupLifecycle = props.lifecycle;
  const title = t("devices.pairing.title");
  // Terminal states reuse their own headline as the dialog description so the
  // accessible name tracks the visible state without a parallel string set.
  const description =
    lifecycle.phase === "success"
      ? t("devices.pairing.pairedTitle")
      : lifecycle.phase === "delivery-uncertain"
        ? t("devices.pairing.deliveryUncertainTitle")
        : lifecycle.phase === "expired"
          ? t("devices.pairing.expiredTitle")
          : t("devices.pairing.subtitle");
  const isNodeSetup = props.nodeOnly || lifecycle.access === "node";
  const pairingDocsUrl = isNodeSetup ? NODE_PAIRING_DOCS_URL : MOBILE_PAIRING_DOCS_URL;

  return html`
    <openclaw-modal-dialog label=${title} description=${description} @modal-cancel=${props.onClose}>
      <section class="device-pair-setup">
        <header class="device-pair-setup__header">
          <div class="device-pair-setup__phone" aria-hidden="true">
            ${isNodeSetup ? icons.server : icons.smartphone}
          </div>
          <div>
            <h2>${title}</h2>
            <p>${description}</p>
            ${
              lifecycle.phase !== "success" && !isNodeSetup
                ? html`<p class="device-pair-setup__get-apps">
                    ${t("devices.pairing.noApp")}
                    <button type="button" @click=${props.onGetApps}>
                      ${t("devices.pairing.getApps")}
                    </button>
                  </p>`
                : nothing
            }
          </div>
          <button
            class="btn btn--icon btn--ghost device-pair-setup__close"
            type="button"
            aria-label=${t("common.dismiss")}
            @click=${props.onClose}
          >
            ${icons.x}
          </button>
        </header>

        <div class="device-pair-setup__body">${renderDevicePairSetupBody(props)}</div>

        <footer class="device-pair-setup__footer">
          <a
            href=${pairingDocsUrl}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
            aria-label=${t("devices.pairing.helpNewTab")}
          >
            <span>${t("devices.pairing.help")}</span>
            <span class="device-pair-setup__external-icon" aria-hidden="true"
              >${icons.externalLink}</span
            >
          </a>
          <button class="btn btn--ghost" type="button" @click=${props.onManageDevices}>
            ${t("devices.pairing.manageDevices")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
