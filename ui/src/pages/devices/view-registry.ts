import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { parseNodeList } from "../../../../src/shared/node-list-parse.js";
import type { NodeListNode } from "../../../../src/shared/node-list-types.js";
import { icons } from "../../components/icons.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import type { DeviceCommandPolicy } from "../../lib/nodes/page-operations.ts";
import { prettifyPlatform } from "../../lib/platform-label.ts";
import { renderDeviceTile } from "./view-shared.ts";
import type { DevicesProps } from "./view.types.ts";

registerDevicesEnglish();

export type ExecutionDeviceRow = {
  id: string;
  name: string;
  platform?: string;
  connected: boolean;
  enabled: boolean;
  commandPolicy: DeviceCommandPolicy | null;
  holder?: DevicesProps["deviceOccupancy"][number];
};

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((entry) => {
    const text = typeof entry === "string" ? entry.trim() : "";
    return text ? [text] : [];
  });
}

function readCommandPolicy(value: unknown): DeviceCommandPolicy | null {
  const record = asOptionalRecord(value);
  if (!record) {
    return null;
  }
  const allow = readStringList(record.allow);
  const deny = readStringList(record.deny);
  return allow || deny ? { ...(allow ? { allow } : {}), ...(deny ? { deny } : {}) } : null;
}

/** One row per paired execution device from the gateway node catalog. */
export function resolveExecutionDevices(props: DevicesProps): ExecutionDeviceRow[] {
  const holderByDevice = new Map(
    (props.deviceOccupancy ?? []).map((entry) => [entry.deviceId, entry] as const),
  );
  return parseNodeList({ nodes: props.nodes })
    .filter((node: NodeListNode) => node.paired === true)
    .map((node) => {
      const row: ExecutionDeviceRow = {
        id: node.nodeId,
        name: node.displayName?.trim() || node.clientId?.trim() || node.nodeId,
        platform: node.platform,
        connected: node.connected === true,
        // Absent on legacy rows written before the device registry existed;
        // those devices keep executing until an operator disables them.
        enabled: node.enabled !== false,
        commandPolicy: readCommandPolicy(node.commandPolicy),
      };
      const holder = holderByDevice.get(node.nodeId);
      if (holder) {
        row.holder = holder;
      }
      return row;
    })
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
}

function policySummary(row: ExecutionDeviceRow): string {
  const policy = row.commandPolicy;
  if (!policy) {
    return t("devices.registry.policyNone");
  }
  const allow = policy.allow?.length ?? 0;
  const deny = policy.deny?.length ?? 0;
  if (allow > 0 && deny > 0) {
    return t("devices.registry.policyBoth", { allow: String(allow), deny: String(deny) });
  }
  return allow > 0
    ? t("devices.registry.policyAllow", { count: String(allow) })
    : t("devices.registry.policyDeny", { count: String(deny) });
}

function renderRegistryRow(row: ExecutionDeviceRow, props: DevicesProps): TemplateResult {
  const canManage = props.canManagePairing;
  const connectionStatus = row.connected
    ? renderSettingsStatus({ kind: "ok", label: t("devices.registry.connected") })
    : renderSettingsStatus({ kind: "muted", label: t("devices.registry.offline") });
  const enabledStatus = row.enabled
    ? renderSettingsStatus({ kind: "accent", label: t("devices.registry.enabled") })
    : renderSettingsStatus({ kind: "muted", label: t("devices.registry.disabled") });
  const occupancyStatus = row.holder
    ? renderSettingsStatus({
        kind: "warn",
        label: t("devices.registry.inUse", { session: row.holder.sessionLabel }),
      })
    : renderSettingsStatus({ kind: "muted", label: t("devices.registry.idle") });
  const meta = [row.platform ? prettifyPlatform(row.platform) : null, policySummary(row)]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const holder = row.holder;
  return html`
    <div class="settings-row device-entry device-registry__row" data-device-id=${row.id}>
      ${renderDeviceTile(icons.server)}
      <div class="device-entry__body">
        <div class="device-entry__heading">
          <span class="settings-row__title">${row.name}</span>
          <span class="device-entry__status">
            ${connectionStatus} ${enabledStatus} ${occupancyStatus}
          </span>
        </div>
        <span class="settings-row__desc">${meta}</span>
        ${
          holder
            ? html`<button
                class="device-registry__holder"
                type="button"
                aria-label=${t("devices.registry.openHolder", { session: holder.sessionLabel })}
                @click=${() => props.onDeviceRegistryHolderOpen(holder)}
              >
                <span class="device-registry__holder-label"
                  >${t("devices.registry.holderLabel")}</span
                >
                <span class="device-registry__holder-session">${holder.sessionLabel}</span>
                <span class="device-registry__chevron" aria-hidden="true"
                  >${icons.chevronRight}</span
                >
              </button>`
            : nothing
        }
      </div>
      <div class="settings-row__control">
        ${renderSettingsToggle({
          checked: row.enabled,
          disabled: !canManage,
          ariaLabel: t("devices.registry.toggle", { name: row.name }),
          onChange: (checked) =>
            props.onDeviceRegistryEnabled({ id: row.id, name: row.name }, checked),
        })}
        <button
          class="btn btn--sm"
          ?disabled=${!canManage}
          aria-label=${t("devices.registry.editAction", { name: row.name })}
          @click=${() =>
            props.onDeviceRegistryEdit({
              id: row.id,
              name: row.name,
              commandPolicy: row.commandPolicy,
            })}
        >
          ${icons.pencil} ${t("devices.registry.edit")}
        </button>
      </div>
    </div>
  `;
}

export function renderExecutionDeviceRegistry(props: DevicesProps) {
  const rows = resolveExecutionDevices(props);
  const loading = props.loading && rows.length === 0;
  const actions = html`
    <button
      class="btn"
      title=${props.canPairDevice ? "" : t("devices.registry.addTitle")}
      ?disabled=${!props.canPairDevice}
      @click=${props.onDevicePairSetupOpen}
    >
      ${icons.plus} ${t("devices.registry.add")}
    </button>
  `;
  return renderSettingsSection(
    {
      title: t("devices.registry.title"),
      description: t("devices.registry.subtitle"),
      count: rows.length,
      actions,
    },
    html`
      ${
        props.occupancyError
          ? html`<div class="callout danger">${props.occupancyError}</div>`
          : nothing
      }
      ${
        loading
          ? renderSettingsLoadingSkeleton()
          : rows.length === 0
            ? renderSettingsEmpty(
                props.occupancyLoading
                  ? t("devices.registry.loading")
                  : t("devices.registry.empty"),
              )
            : rows.map((row) => renderRegistryRow(row, props))
      }
      <p class="settings-section__desc device-registry__hint">
        ${t("devices.registry.releaseHint")}
      </p>
    `,
  );
}
