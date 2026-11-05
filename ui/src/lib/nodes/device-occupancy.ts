import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatUiError } from "../format-error.ts";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

/**
 * One session tree holding a paired device's occupancy lease, projected from
 * the session row's scope facts. The node stays occupancy authority; this is
 * only the row the Gateway last reported.
 */
export type DeviceOccupancyEntry = {
  deviceId: string;
  sessionKey: string;
  sessionLabel: string;
  agentId?: string;
};

export type DeviceOccupancyState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  requestGeneration: number;
  occupancyLoading: boolean;
  /** null until the first read; [] is a read that found no held lease. */
  deviceOccupancy: DeviceOccupancyEntry[] | null;
  occupancyError: string | null;
};

function isCurrentRequest(
  state: DeviceOccupancyState,
  client: GatewayRequestClient,
  generation: number,
): boolean {
  return state.connected && state.client === client && state.requestGeneration === generation;
}

function parseDeviceOccupancy(rows: unknown): DeviceOccupancyEntry[] {
  if (!Array.isArray(rows)) {
    return [];
  }
  const entries: DeviceOccupancyEntry[] = [];
  for (const row of rows) {
    const record = asOptionalRecord(row);
    if (!record || record.scopeLeaseHeld !== true) {
      continue;
    }
    const deviceId = normalizeOptionalString(record.scopeDeviceId);
    const sessionKey = normalizeOptionalString(record.key);
    if (!deviceId || !sessionKey) {
      continue;
    }
    const agentId = normalizeOptionalString(record.agentId);
    entries.push({
      deviceId,
      sessionKey,
      sessionLabel:
        normalizeOptionalString(record.label) ??
        normalizeOptionalString(record.displayName) ??
        sessionKey,
      ...(agentId ? { agentId } : {}),
    });
  }
  return entries;
}

/**
 * Reads which sessions hold a device occupancy lease. The Gateway projects the
 * row facts from its lease mirror; this only joins them to registry rows.
 */
export async function loadDeviceOccupancy(state: DeviceOccupancyState, opts?: { quiet?: boolean }) {
  const client = state.client;
  if (!client || !state.connected || state.occupancyLoading) {
    return;
  }
  state.occupancyLoading = true;
  if (!opts?.quiet) {
    state.occupancyError = null;
  }
  const generation = state.requestGeneration;
  try {
    const res = await client.request<{ sessions?: unknown[] }>("sessions.list", {
      limit: 500,
      excludeSubagents: true,
      includeGlobal: true,
    });
    if (isCurrentRequest(state, client, generation)) {
      state.deviceOccupancy = parseDeviceOccupancy(res?.sessions);
    }
  } catch (err) {
    if (!opts?.quiet && isCurrentRequest(state, client, generation)) {
      state.occupancyError = formatUiError(err);
    }
  } finally {
    if (isCurrentRequest(state, client, generation)) {
      state.occupancyLoading = false;
    }
  }
}
