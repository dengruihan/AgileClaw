import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { html, nothing, type TemplateResult } from "lit";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../../../i18n/locales/en-session-placement.ts";

registerSessionPlacementEnglish();

/**
 * Read-only device-scope chip for the chat header. It names the paired device a
 * session's tools execute on and whether the session still holds its occupancy
 * lease. Releasing is deliberately absent here: the composer's Stop button is
 * the only manual release path.
 */
export function renderChatPaneDeviceScope(
  session: GatewaySessionRow | undefined,
): TemplateResult | typeof nothing {
  const deviceId = normalizeOptionalString(session?.scopeDeviceId);
  if (!deviceId) {
    return nothing;
  }
  const leaseHeld = session?.scopeLeaseHeld === true;
  const lease = leaseHeld
    ? t("sessionsView.deviceScope.leaseHeld")
    : t("sessionsView.deviceScope.leaseFree");
  const announcement = t("sessionsView.deviceScope.chipLabel", { device: deviceId, lease });
  return html`
    <div class="chat-pane__device-scope">
      <wa-dropdown class="chat-pane__device-scope-menu" placement="bottom-start">
        <button
          slot="trigger"
          class="chat-pane__device-scope-chip"
          type="button"
          aria-label=${announcement}
        >
          <span class="chat-pane__device-scope-icon" aria-hidden="true">${icons.monitor}</span>
          <span class="chat-pane__device-scope-label"
            >${t("sessionsView.deviceScope.chip", { device: deviceId })}</span
          >
        </button>
        <dl class="chat-pane__device-scope-facts">
          <dt>${t("sessionsView.deviceScope.factDevice")}</dt>
          <dd class="chat-pane__device-scope-value">${deviceId}</dd>
          <dt>${t("sessionsView.deviceScope.factLease")}</dt>
          <dd>${lease}</dd>
        </dl>
        <div class="chat-pane__device-scope-note">
          ${leaseHeld ? t("sessionsView.deviceScope.noteHeld") : t("sessionsView.deviceScope.noteIdle")}
        </div>
      </wa-dropdown>
      <span class="sr-only" role="status">${announcement}</span>
    </div>
  `;
}
