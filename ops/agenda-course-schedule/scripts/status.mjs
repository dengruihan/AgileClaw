#!/usr/bin/env node
// Read-only: compare the live installation with the reviewed build and report health.
import path from "node:path";
import {
  compareHashes,
  installedHashes,
  liveRevision,
  packageRoot,
  readJson,
  sourceCommit,
  installRoot,
  databasePath,
} from "./lib.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const recorded = await readJson(path.join(packageRoot, "external", "files.json"));
const commit = recorded.commit;
const live = await installedHashes();
const rows = compareHashes(recorded.files, live);
console.log(`install: ${installRoot}`);
console.log(`recorded commit: ${commit}`);
const source = args.get("--source");
if (source) console.log(`source HEAD:    ${sourceCommit(source) ?? "unavailable"}`);
console.log(`database: ${databasePath}`);
const revision = await liveRevision();
console.log(
  `live revision: ${revision.ok ? revision.revision : `unavailable (${revision.error})`}`,
);
for (const row of rows) {
  console.log(`${row.ok ? "ok      " : "MISMATCH"} ${row.file}`);
}
const mismatches = rows.filter((row) => !row.ok);
if (mismatches.length) {
  process.exitCode = 1;
  console.log(`\n${mismatches.length} file(s) differ from the reviewed build.`);
} else {
  console.log("\nThe installed files match the reviewed build.");
}
