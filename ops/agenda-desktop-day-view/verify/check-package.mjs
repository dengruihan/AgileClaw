#!/usr/bin/env node
import { readFile } from "node:fs/promises";
// Replayable package check: evidence files, artifact hashes, screenshots, and
// the external patch commit. Read-only.
import path from "node:path";
import {
  exists,
  packageRoot,
  readJson,
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

const commitText = await readFile(path.join(packageRoot, "external", "commit.txt"), "utf8");
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
check(fields.base === "53962ecd7b02c71aea7420401b2f2ef73b74d3e3", "base is the reviewed M18 tip");

const patch = await readFile(path.join(packageRoot, "external", "source.patch"), "utf8");
check(patch.startsWith("From "), "source.patch is a format-patch series");
check(patch.includes(fields.commit ?? "no-commit"), "source.patch contains the recorded commit");

const deploy = await readFile(path.join(packageRoot, "scripts", "deploy.mjs"), "utf8");
check(deploy.includes("createVerifiedBackup"), "deploy verifies the backup before mutation");
check(!deploy.includes(".catch(() => {})"), "deploy does not swallow copy failures");

const screenshot = await readFile(path.join(packageRoot, "verify", "screenshot.mjs"), "utf8");
check(
  screenshot.includes("waitForResponse") &&
    screenshot.includes('candidate.url().includes("/agenda/api/feedback")'),
  "screenshot waits for the feedback response",
);
check(
  await exists(path.join(packageRoot, "verify", "backup-failure.test.mjs")),
  "isolated backup-failure regression",
);

for (const name of [
  "before-desktop-light.png",
  "before-desktop-dark.png",
  "before-desktop-light-1280.png",
  "after-desktop-light.png",
  "after-desktop-dark.png",
  "after-desktop-light-1280.png",
  "after-desktop-light-1280-bottom.png",
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
