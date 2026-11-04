#!/usr/bin/env node
// Replayable package check: evidence files, artifact hashes, screenshots, and
// the external patch commit. Read-only.
import path from "node:path";
import {
  exists,
  packageRoot,
  readJson,
  sha256File,
  sourceCommit,
  sourceFileHashes,
  compareHashes,
} from "../scripts/lib.mjs";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const failures = [];
const check = (condition, message) => {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`);
  if (!condition) failures.push(message);
};

const commitText = await import("node:fs/promises").then((fs) =>
  fs.readFile(path.join(packageRoot, "external", "commit.txt"), "utf8"),
);
const fields = Object.fromEntries(
  commitText
    .trim()
    .split("\n")
    .map((line) => line.split(": "))
    .filter((parts) => parts.length === 2),
);
const recorded = await readJson(path.join(packageRoot, "external", "files.json"));
check(/^[0-9a-f]{40}$/.test(fields.commit ?? ""), `recorded commit ${fields.commit}`);
check(recorded.commit === fields.commit, "files.json belongs to the recorded commit");
check(/^[0-9a-f]{40}$/.test(fields.base ?? ""), `recorded base ${fields.base}`);

const patch = await import("node:fs/promises").then((fs) =>
  fs.readFile(path.join(packageRoot, "external", "source.patch"), "utf8"),
);
check(patch.startsWith("From "), "source.patch is a format-patch series");
check(patch.includes(fields.commit ?? "no-commit"), "source.patch contains the recorded commit");

for (const name of [
  "before-desktop-light.png",
  "after-desktop-light.png",
  "before-desktop-dark.png",
  "after-desktop-dark.png",
  "before-week-light.png",
  "after-week-light.png",
  "before-sidebar.png",
  "after-sidebar.png",
]) {
  check(await exists(path.join(packageRoot, "verify", "screenshots", name)), `screenshot ${name}`);
}

const source = args.get("--source");
if (source) {
  check(sourceCommit(source) === fields.commit, "source checkout is at the recorded commit");
  const hashes = await sourceFileHashes(source);
  for (const row of compareHashes(recorded.files, hashes)) {
    check(row.ok, `built artifact ${row.file}`);
  }
} else {
  console.log("skip --source not given: built-artifact hashes not re-verified");
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("\nPackage evidence is consistent.");
