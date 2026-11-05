import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  migrateLegacyDevicePairingStore,
  migratePairedDeviceRegistryPolicyFields,
} from "./device-pairing-migration.js";
import { migrateLegacyNodePairingStore } from "./node-pairing-migration.js";
import { listLegacyPairingStoreFiles } from "./pairing-files.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";

export async function migrateDoctorPairingStores(params: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  cfg: OpenClawConfig;
}) {
  const legacy =
    (await listLegacyPairingStoreFiles(params.stateDir)).length === 0
      ? { changes: [], warnings: [] }
      : await withLegacyMigrationStateLock({
          ...params,
          label: "legacy pairing stores",
          releaseLabel: "Pairing store",
          run: async () => {
            const changes: string[] = [];
            const warnings: string[] = [];
            const log = {
              info: (message: string) => changes.push(message),
              warn: (message: string) => warnings.push(message),
            };
            // The node fold must see imported device approvals before classifying orphan rows.
            await migrateLegacyDevicePairingStore({
              baseDir: params.stateDir,
              cfg: params.cfg,
              log,
            });
            await migrateLegacyNodePairingStore({ baseDir: params.stateDir, cfg: params.cfg, log });
            return { changes, warnings, warningDisposition: "recoverable" };
          },
        });
  // The registry-field backfill is not tied to legacy files: pairing rows that
  // predate the enabled/command-policy columns need it on every install. It
  // runs after the legacy import so freshly imported rows are backfilled in the
  // same pass.
  const registryRepair = await migratePairedDeviceRegistryPolicyFields({
    baseDir: params.stateDir,
  });
  return {
    ...legacy,
    changes: [...legacy.changes, ...(registryRepair?.changes ?? [])],
    warnings: [...legacy.warnings, ...(registryRepair?.warnings ?? [])],
  };
}
