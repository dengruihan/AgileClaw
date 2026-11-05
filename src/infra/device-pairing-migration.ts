// One-time import of the retired devices/*.json pairing store into SQLite.
// Older gateways kept paired devices, pending requests, and bootstrap tokens
// in <state>/devices/{paired,pending,bootstrap}.json; the store now lives in
// the shared state DB (device_pairing_* / device_bootstrap_tokens tables).
// Doctor runs this before the node-surface fold, which writes onto the
// imported device records. Pending requests (5 min TTL) and bootstrap tokens
// (10 min TTL) are transients and are not imported; devices re-request and
// setup codes are reissued.
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { preserveLegacyDesktopStreamOptOut } from "./device-pairing-node-desktop-migration.js";
import { withPairedDeviceRecords, type PairedDevice } from "./device-pairing.js";
import { normalizePairedDeviceCommandPolicy } from "./device-pairing.types.js";
import {
  coercePairingStateRecord,
  readJsonIfExists,
  resolvePairingPaths,
} from "./pairing-files.js";

type LegacyDevicePairingMigrationResult = {
  imported: number;
  skippedExisting: number;
};

const SQLITE_TEXT_FIELDS = [
  "displayName",
  "operatorLabel",
  "platform",
  "deviceFamily",
  "clientId",
  "clientMode",
  "browserOrigin",
  "role",
  "remoteIp",
  "approvedVia",
  "lastSeenReason",
] as const satisfies readonly (keyof PairedDevice)[];

function normalizeLegacyPairedDevice(
  record: PairedDevice,
): { device: PairedDevice; omittedFields: number } | null {
  if (!isRecord(record)) {
    return null;
  }
  if (
    typeof record.publicKey !== "string" ||
    !record.publicKey.trim() ||
    !Number.isSafeInteger(record.createdAtMs) ||
    !Number.isSafeInteger(record.approvedAtMs)
  ) {
    return null;
  }

  const device = { ...record };
  let omittedFields = 0;
  if (device.lastSeenAtMs !== undefined && !Number.isSafeInteger(device.lastSeenAtMs)) {
    delete device.lastSeenAtMs;
    omittedFields += 1;
  }
  for (const field of SQLITE_TEXT_FIELDS) {
    if (device[field] !== undefined && typeof device[field] !== "string") {
      delete device[field];
      omittedFields += 1;
    }
  }
  return { device, omittedFields };
}

async function archiveLegacyFile(filePath: string): Promise<void> {
  try {
    await fs.rename(filePath, `${filePath}.migrated`);
  } catch {
    // Missing file or a racing second gateway process; nothing left to archive.
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(
    () => true,
    () => false,
  );
}

/**
 * Import legacy devices/paired.json records into the SQLite pairing store,
 * then archive the legacy files. Existing SQLite records win over legacy rows
 * for the same device id. Idempotent: after the first run the files carry a
 * `.migrated` suffix and the function returns null immediately. Throws on an
 * unreadable paired.json so a failed import leaves the files for a retry
 * instead of silently dropping approved pairings.
 */
export async function migrateLegacyDevicePairingStore(params?: {
  baseDir?: string;
  cfg?: OpenClawConfig;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<LegacyDevicePairingMigrationResult | null> {
  const { dir, pendingPath, pairedPath } = resolvePairingPaths(params?.baseDir, "devices");
  const bootstrapPath = path.join(dir, "bootstrap.json");
  const pairedRaw = await readJsonIfExists<unknown>(pairedPath);
  const hasTransientFiles = (await fileExists(pendingPath)) || (await fileExists(bootstrapPath));
  if (pairedRaw == null && !hasTransientFiles) {
    return null;
  }

  const legacyPaired = coercePairingStateRecord<PairedDevice>(pairedRaw);
  let imported = 0;
  let skippedExisting = 0;
  let skippedInvalid = 0;
  let omittedInvalidFields = 0;
  if (Object.keys(legacyPaired).length > 0) {
    await withPairedDeviceRecords(params?.baseDir, (pairedByDeviceId) => {
      for (const [rawDeviceId, record] of Object.entries(legacyPaired)) {
        const deviceId = rawDeviceId.trim();
        if (!deviceId) {
          skippedInvalid += 1;
          continue;
        }
        if (pairedByDeviceId[deviceId]) {
          skippedExisting += 1;
          continue;
        }
        const normalized = normalizeLegacyPairedDevice(record);
        if (!normalized) {
          skippedInvalid += 1;
          continue;
        }
        omittedInvalidFields += normalized.omittedFields;
        const device = { ...normalized.device, deviceId };
        preserveLegacyDesktopStreamOptOut(device, params?.cfg ?? {}, Date.now());
        pairedByDeviceId[deviceId] = device;
        imported += 1;
      }
      return { value: undefined, persist: imported > 0 };
    });
  }

  if (skippedInvalid > 0) {
    params?.log?.warn(
      `device pairing store migration skipped ${skippedInvalid} invalid paired record(s)`,
    );
  }
  if (omittedInvalidFields > 0) {
    params?.log?.warn(
      `device pairing store migration omitted ${omittedInvalidFields} invalid optional field(s)`,
    );
  }

  await Promise.all([
    archiveLegacyFile(pairedPath),
    archiveLegacyFile(pendingPath),
    archiveLegacyFile(bootstrapPath),
  ]);
  const result = { imported, skippedExisting };
  params?.log?.info(
    `device pairing store migrated to SQLite: imported ${imported} paired device(s), kept ${skippedExisting} existing record(s)`,
  );
  return result;
}

/**
 * Backfill the device-registry columns onto pre-existing pairing rows: rows
 * written before the `enabled` column existed load with the key absent and
 * read as enabled; this writes that value explicitly so the registry state is
 * durable. The same write round-trips every row, dropping malformed
 * command-policy JSON that row readers already treat as no policy. Idempotent:
 * rows with an explicit value are left untouched.
 */
export async function migratePairedDeviceRegistryPolicyFields(params?: {
  baseDir?: string;
  log?: { info: (message: string) => void; warn: (message: string) => void };
}): Promise<{ changes: string[]; warnings: string[] } | null> {
  let backfilled = 0;
  let repaired = false;
  await withPairedDeviceRecords(params?.baseDir, (pairedByDeviceId) => {
    for (const device of Object.values(pairedByDeviceId)) {
      if (device.enabled === undefined) {
        device.enabled = true;
        backfilled += 1;
      }
      if (device.commandPolicy !== undefined) {
        // Normalize stored policy in place; a malformed shape reads as absent.
        const normalized = normalizePairedDeviceCommandPolicy(device.commandPolicy);
        if (normalized) {
          device.commandPolicy = normalized;
        } else {
          delete device.commandPolicy;
          repaired = true;
        }
      }
    }
    return { value: undefined, persist: backfilled > 0 || repaired };
  });
  if (backfilled === 0 && !repaired) {
    return null;
  }
  const changes = [
    `device registry fields backfilled: ${backfilled} paired device(s) set to enabled${repaired ? `, malformed command policy cleared on affected device(s)` : ""}`,
  ];
  params?.log?.info(changes[0]!);
  return { changes, warnings: [] };
}
