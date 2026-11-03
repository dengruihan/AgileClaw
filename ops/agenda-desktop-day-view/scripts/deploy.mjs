#!/usr/bin/env node
// Deploy the reviewed Agenda build to the live installation with a full backup,
// native plugin reload, and health verification. Never touches the live database.
import { chmod, cp, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  backupRoot,
  compareHashes,
  createVerifiedBackup,
  databasePath,
  installRoot,
  installedHashes,
  liveRevision,
  managedEntries,
  packageRoot,
  readJson,
  run,
  sha256File,
  sourceCommit,
  sourceFileHashes,
} from "./lib.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const apply = process.argv.includes("--yes");
const source = path.resolve(args.get("--source") ?? "");
if (!args.get("--source")) {
  console.error("Usage: deploy.mjs --source <built agenda checkout> [--yes]");
  process.exit(2);
}
const recorded = await readJson(path.join(packageRoot, "external", "files.json"));
const commit = sourceCommit(source);
if (commit !== recorded.commit) {
  console.error(
    `Source HEAD ${commit ?? "unavailable"} does not match the reviewed commit ${recorded.commit}.`,
  );
  process.exit(1);
}
const built = await sourceFileHashes(source);
const mismatches = compareHashes(recorded.files, built).filter((row) => !row.ok);
if (mismatches.length) {
  console.error("The source build does not match the reviewed artifact hashes:");
  for (const row of mismatches) console.error(`  ${row.file}`);
  console.error("Run `node build.mjs` in the source checkout before deploying.");
  process.exit(1);
}
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(backupRoot, stamp);
const revisionBefore = await liveRevision();
console.log(`source commit: ${commit}`);
console.log(`install:       ${installRoot}`);
console.log(`backup:        ${backup}`);
console.log(
  `live revision: ${revisionBefore.ok ? revisionBefore.revision : `unavailable (${revisionBefore.error})`}`,
);
console.log(`database:      ${databasePath} (snapshot only; never modified by this script)`);
if (!apply) {
  console.log("\nDry run. Re-run with --yes to back up, copy, reload, and verify.");
  process.exit(0);
}

let backupSummary;
try {
  backupSummary = await createVerifiedBackup(installRoot, backup, managedEntries);
} catch (error) {
  console.error(
    `Backup failed before any live file was changed: ${error instanceof Error ? error.message : String(error)}`,
  );
  await rm(backup, { recursive: true, force: true });
  process.exit(1);
}
console.log(
  `backup verified: ${backupSummary.files} files across ${backupSummary.entries} entries`,
);
const backupMetadata = {
  timestamp: stamp,
  sourceCommit: commit,
  liveRevisionBefore: revisionBefore,
  installedBefore: await installedHashes(),
  database: databasePath,
};
const dbSnapshot = path.join(backup, "agenda.sqlite.snapshot");
const vacuum = run("sqlite3", [databasePath, `VACUUM INTO '${dbSnapshot}'`]);
if (!vacuum.ok) {
  console.error(`Database snapshot failed: ${vacuum.stderr.trim()}`);
  process.exit(1);
}
await chmod(dbSnapshot, 0o600);
backupMetadata.databaseSnapshot = dbSnapshot;
backupMetadata.databaseSnapshotSha256 = await sha256File(dbSnapshot);
await writeFile(path.join(backup, "metadata.json"), `${JSON.stringify(backupMetadata, null, 2)}\n`);

const staged = await mkdtemp(path.join(os.tmpdir(), "agenda-stage-"));
try {
  for (const entry of managedEntries) {
    await cp(path.join(source, entry), path.join(staged, entry), { recursive: true });
  }
  for (const entry of managedEntries) {
    const target = path.join(installRoot, entry);
    const incoming = path.join(staged, entry);
    if (entry === "skills") {
      // Preserve any installation-only skill directories while updating Agenda's.
      for (const name of await readdir(incoming)) {
        await rm(path.join(target, name), { recursive: true, force: true });
        await cp(path.join(incoming, name), path.join(target, name), { recursive: true });
      }
      continue;
    }
    const previous = `${target}.pre-deploy`;
    await rm(previous, { recursive: true, force: true });
    await rename(target, previous).catch(async () => {
      await rm(target, { recursive: true, force: true });
    });
    await cp(incoming, target, { recursive: true });
    await rm(previous, { recursive: true, force: true });
  }
} catch (error) {
  console.error(`Copy failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`Restore manually from ${backup}.`);
  process.exit(1);
} finally {
  await rm(staged, { recursive: true, force: true });
}

const reload = run("openclaw", ["plugins", "reload", "agenda", "--wait", "--json"], {
  timeout: 180_000,
});
console.log(`reload: ${reload.ok ? "ok" : "FAILED"}`);
if (!reload.ok) {
  console.error(reload.stdout.trim());
  console.error(reload.stderr.trim());
  console.error(`Files were replaced; the previous build is in ${backup}.`);
  process.exit(1);
}
const health = run("openclaw", ["gateway", "health"]);
const live = await installedHashes();
const rows = compareHashes(recorded.files, live);
const revisionAfter = await liveRevision();
const record = {
  timestamp: stamp,
  sourceCommit: commit,
  reloadOk: reload.ok,
  gatewayHealthOk: health.ok && health.stdout.includes("OK"),
  liveRevisionBefore: revisionBefore,
  liveRevisionAfter: revisionAfter,
  files: rows,
};
await writeFile(path.join(backup, "deploy-record.json"), `${JSON.stringify(record, null, 2)}\n`);
console.log(`gateway health: ${record.gatewayHealthOk ? "OK" : "FAILED"}`);
console.log(
  `live revision:  ${revisionAfter.ok ? revisionAfter.revision : `unavailable (${revisionAfter.error})`}`,
);
for (const row of rows) console.log(`${row.ok ? "ok      " : "MISMATCH"} ${row.file}`);
const failed = rows.filter((row) => !row.ok);
if (failed.length || !record.gatewayHealthOk || !revisionAfter.ok) {
  console.error(`\nDeployment verification failed. Restore from ${backup} if needed.`);
  process.exit(1);
}
console.log(`\nDeployed ${commit}. Backup and evidence: ${backup}`);
