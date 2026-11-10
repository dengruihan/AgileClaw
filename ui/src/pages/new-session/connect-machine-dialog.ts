import { html, nothing } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import { registerNewSessionSetupEnglish } from "../../i18n/locales/en-new-session-setup.ts";
import {
  closeDevicePairSetup,
  completeDevicePairSetup,
  createDevicePairSetupState,
  markDevicePairSetupDeliveryUncertain,
  openDevicePairSetup,
  parseDevicePairSetupCompletion,
  parseDevicePairSetupDeliveryUncertain,
  refreshDevicePairSetup,
  setDevicePairSetupAccess,
  syncDevicePairSetupCountdown,
  type DevicePairSetupState,
} from "../../lib/device-pair-setup.ts";
import { buildExternalLinkRel, EXTERNAL_LINK_TARGET } from "../../lib/external-link.ts";
import { renderDevicePairSetupBody } from "../devices/pair-guided.ts";

registerNewSessionSetupEnglish();
registerDevicesEnglish();

const NODE_PAIRING_DOCS_URL = "https://docs.openclaw.ai/gateway/pairing#one-paste-node-pairing";

export type ConnectMachineDialogHooks = {
  /** Deep-links a failed setup request to the existing Gateway connection settings. */
  onOpenConnectionSettings?: () => void;
};

type PairingEventGateway = {
  subscribeEvents: (listener: (event: { event: string; payload?: unknown }) => void) => () => void;
};

// New Session's "Connect a machine" entry. Every pairing decision lives in the
// shared DevicePairSetupLifecycle — this class only mounts the node-scoped
// dialog and keeps the New Session outer chrome.
export class ConnectMachineSetupState {
  private readonly pairing: DevicePairSetupState;
  private secretRevealed = false;
  private unsubscribeEvents: (() => void) | null = null;

  constructor(
    private readonly gateway: () => { client: GatewayBrowserClient | null; connected: boolean },
    private readonly requestUpdate: () => void,
    private readonly pairingEvents: () => PairingEventGateway | null = () => null,
  ) {
    this.pairing = createDevicePairSetupState({
      client: null,
      connected: false,
      onChange: () => this.requestUpdate(),
    });
  }

  get open(): boolean {
    return this.pairing.devicePairSetupOpen;
  }

  start(): void {
    this.synchronizeGateway();
    this.secretRevealed = false;
    void openDevicePairSetup(this.pairing);
    void setDevicePairSetupAccess(this.pairing, "node");
    // Pairing completions broadcast app-wide; this dialog instance must hear
    // them just like the Devices dialog's overlay-owned instance does.
    this.unsubscribeEvents ??=
      this.pairingEvents()?.subscribeEvents((event) => {
        if (event.event === "device.pair.setup.completed") {
          const completion = parseDevicePairSetupCompletion(event.payload);
          if (completion) {
            completeDevicePairSetup(this.pairing, completion);
          }
          return;
        }
        if (event.event === "device.pair.setup.deliveryUncertain") {
          const outcome = parseDevicePairSetupDeliveryUncertain(event.payload);
          if (outcome) {
            markDevicePairSetupDeliveryUncertain(this.pairing, outcome);
          }
        }
      }) ?? null;
    void this.refresh();
  }

  close(): void {
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
    closeDevicePairSetup(this.pairing);
    this.secretRevealed = false;
  }

  render(enabled: boolean, onManageDevices: () => void, hooks: ConnectMachineDialogHooks = {}) {
    if (!this.open || !enabled) {
      return nothing;
    }
    this.synchronizeGateway();
    const onClose = () => {
      this.close();
      this.requestUpdate();
    };
    const title = t("newSession.connectMachineTitle");
    // Terminal states reuse their own headline as the dialog description so the
    // accessible name tracks the visible state, matching the Devices dialog.
    const lifecycle = this.pairing.devicePairSetupLifecycle;
    const description =
      lifecycle.phase === "success"
        ? t("devices.pairing.pairedTitle")
        : lifecycle.phase === "delivery-uncertain"
          ? t("devices.pairing.deliveryUncertainTitle")
          : lifecycle.phase === "expired"
            ? t("devices.pairing.expiredTitle")
            : t("newSession.connectMachineDescription");

    return html`
      <openclaw-modal-dialog
        class="connect-machine-dialog"
        label=${title}
        description=${description}
        @modal-cancel=${onClose}
      >
        <section class="exec-approval-card connect-machine-dialog__card">
          <header class="exec-approval-header">
            <div>
              <h2 class="exec-approval-title">${title}</h2>
              <p class="exec-approval-sub">${description}</p>
            </div>
            <button
              class="btn btn--icon btn--ghost"
              type="button"
              aria-label=${t("common.dismiss")}
              @click=${onClose}
            >
              ${icons.x}
            </button>
          </header>

          <div class="connect-machine-dialog__body">
            ${renderDevicePairSetupBody({
              lifecycle: this.pairing.devicePairSetupLifecycle,
              nowMs: Date.now(),
              pendingCount: 0,
              nodeOnly: true,
              secretRevealed: this.secretRevealed,
              onToggleSecret: () => {
                this.secretRevealed = !this.secretRevealed;
                this.requestUpdate();
              },
              onRefresh: () => {
                // A regenerated setup is a fresh secret; never carry a reveal over.
                this.secretRevealed = false;
                void this.refresh();
              },
              onAccessChange: () => undefined,
              onClose,
              onManageDevices,
              onOpenConnectionSettings: hooks.onOpenConnectionSettings
                ? () => {
                    this.close();
                    hooks.onOpenConnectionSettings?.();
                  }
                : undefined,
            })}
          </div>

          <footer class="exec-approval-actions connect-machine-dialog__actions">
            <a
              href=${NODE_PAIRING_DOCS_URL}
              target=${EXTERNAL_LINK_TARGET}
              rel=${buildExternalLinkRel()}
              aria-label=${t("devices.pairing.helpNewTab")}
            >
              <span>${t("devices.pairing.help")}</span>
              <span class="device-pair-setup__external-icon" aria-hidden="true"
                >${icons.externalLink}</span
              >
            </a>
            <button class="btn btn--ghost" type="button" @click=${onManageDevices}>
              ${t("devices.pairing.manageDevices")}
            </button>
          </footer>
        </section>
      </openclaw-modal-dialog>
    `;
  }

  async refresh(): Promise<void> {
    this.synchronizeGateway();
    await refreshDevicePairSetup(this.pairing);
    syncDevicePairSetupCountdown(this.pairing, this.requestUpdate);
    this.requestUpdate();
  }

  private synchronizeGateway(): void {
    const { client, connected } = this.gateway();
    this.pairing.client = client;
    this.pairing.connected = connected;
  }
}
