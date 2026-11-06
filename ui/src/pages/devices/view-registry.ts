import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { icons } from "../../components/icons.ts";
import { renderSettingsStatus, renderSettingsToggle } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerDevicesEnglish } from "../../i18n/locales/en-devices.ts";
import type { DeviceInventoryEntry } from "../../lib/nodes/inventory.ts";
import type { DeviceCommandPolicy } from "../../lib/nodes/page-operations.ts";
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

/** Execution facts for one consolidated device row, joined with its occupancy holder. */
export function resolveExecutionDeviceRow(
  entry: DeviceInventoryEntry,
  occupancy: DevicesProps["deviceOccupancy"],
): ExecutionDeviceRow {
  const node = entry.node!;
  const row: ExecutionDeviceRow = {
    id: node.nodeId,
    // The row's resolved display name (operator label first) keeps dialogs and
    // aria labels naming the same device the operator sees.
    name: entry.name,
    platform: node.platform,
    connected: node.connected,
    // Absent on legacy rows written before the device registry existed;
    // those devices keep executing until an operator disables them.
    enabled: node.enabled !== false,
    commandPolicy: readCommandPolicy(node.commandPolicy),
  };
  const holder = occupancy.find((candidate) => candidate.deviceId === node.nodeId);
  if (holder) {
    row.holder = holder;
  }
  return row;
}

export function executionPolicySummary(row: ExecutionDeviceRow): string {
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

/** Enabled and occupancy statuses for the consolidated row's status cluster. */
export function renderExecutionStatuses(row: ExecutionDeviceRow): TemplateResult {
  return html`
    ${
      row.enabled
        ? renderSettingsStatus({ kind: "accent", label: t("devices.registry.enabled") })
        : renderSettingsStatus({ kind: "muted", label: t("devices.registry.disabled") })
    }
    ${
      row.holder
        ? renderSettingsStatus({
            kind: "warn",
            label: t("devices.registry.inUse", { session: row.holder.sessionLabel }),
          })
        : renderSettingsStatus({ kind: "muted", label: t("devices.registry.idle") })
    }
  `;
}

/** Drill-in to the session holding this device's occupancy lease. */
export function renderExecutionHolder(
  row: ExecutionDeviceRow,
  props: DevicesProps,
): TemplateResult | typeof nothing {
  const holder = row.holder;
  if (!holder) {
    return nothing;
  }
  return html`
    <button
      class="device-registry__holder"
      type="button"
      aria-label=${t("devices.registry.openHolder", { session: holder.sessionLabel })}
      @click=${() => props.onDeviceRegistryHolderOpen(holder)}
    >
      <span class="device-registry__holder-label">${t("devices.registry.holderLabel")}</span>
      <span class="device-registry__holder-session">${holder.sessionLabel}</span>
      <span class="device-registry__chevron" aria-hidden="true">${icons.chevronRight}</span>
    </button>
  `;
}

/** Enable/disable switch and command-policy editor for one paired node device. */
export function renderExecutionControls(
  row: ExecutionDeviceRow,
  props: DevicesProps,
): TemplateResult {
  const canManage = props.canManagePairing;
  return html`
    ${renderSettingsToggle({
      checked: row.enabled,
      disabled: !canManage,
      ariaLabel: t("devices.registry.toggle", { name: row.name }),
      onChange: (checked) => props.onDeviceRegistryEnabled({ id: row.id, name: row.name }, checked),
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
  `;
}

/**
 * No device-level release control exists by design: occupancy ends through the
 * holding session's composer Stop. Shown once under the consolidated rows.
 */
export function renderExecutionReleaseHint(): TemplateResult {
  return html`
    <p class="settings-section__desc device-registry__hint">${t("devices.registry.releaseHint")}</p>
  `;
}
