#!/usr/bin/env node
// Static and transformer checks for the M20 package. No live state is read or
// written.

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const OPS_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_DIR = dirname(OPS_DIR);
const REPO_ROOT = join(PACKAGE_DIR, "../..");
const MANIFEST_FILE = join(PACKAGE_DIR, "manifest.json");
const APPLY_FLAG = join(PACKAGE_DIR, "scripts/apply-flag.mjs");

let passes = 0;
let failures = 0;
const pass = (message) => {
  passes += 1;
  console.log(`PASS package: ${message}`);
};
const fail = (message) => {
  failures += 1;
  console.log(`FAIL package: ${message}`);
};

function read(file) {
  return readFileSync(file, "utf8");
}

function hash(text) {
  return execFileSync("sha256sum", { input: text, encoding: "utf8" }).split(" ")[0];
}

function shaFile(file) {
  return hash(readFileSync(file));
}

function runApply(args) {
  try {
    const output = execFileSync(process.execPath, [APPLY_FLAG, ...args], { encoding: "utf8" });
    return { ok: true, output: JSON.parse(output) };
  } catch (error) {
    const text = error.stdout || error.message;
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The error may be plain text; callers only need ok=false then.
    }
    return { ok: false, output: parsed, text };
  }
}

function lines(text) {
  return text.split("\n").map((line) => line.replace(/\r$/, ""));
}

function frontmatterLines(text) {
  const all = lines(text);
  if (all[0] !== "---") return null;
  const close = all.indexOf("---", 1);
  if (close === -1) return null;
  return { all, close, body: all.slice(close + 1).join("\n") };
}

const manifest = JSON.parse(read(MANIFEST_FILE));
const targets = manifest.targets;

if (manifest.mission === "M20") pass("manifest records mission M20");
else fail(`manifest mission is ${manifest.mission}`);
if (manifest.surfaces?.flagKey === "disable-model-invocation")
  pass("flag is loader-supported disable-model-invocation");
else fail("manifest flag key is wrong");
if (manifest.surfaces?.flagLine === "disable-model-invocation: true")
  pass("flag line is exactly true");
else fail("manifest flag line is wrong");
if (
  manifest.surfaces?.expectedVisibleBefore - manifest.surfaces?.expectedHiddenCount ===
  manifest.surfaces?.expectedVisibleAfter
) {
  pass("visible-count math: 79 - 6 = 73");
} else {
  fail("visible-count math is inconsistent");
}
if (targets.length === 6) pass("manifest lists six targets");
else fail(`manifest lists ${targets.length} targets, expected 6`);
const names = targets.map((target) => target.name);
if (new Set(names).size === names.length) pass("target names are unique");
else fail("target names are not unique");
for (const name of [
  "collector-dingtalk-triage",
  "collector-mail-triage",
  "collector-source-triage",
  "collector-health-repair",
  "collector-notify",
  "biandan-todo",
]) {
  if (names.includes(name)) pass(`target present: ${name}`);
  else fail(`target missing: ${name}`);
}
const writeScope = manifest.deployment?.writeScope ?? [];
if (writeScope.length === 6 && targets.every((target) => writeScope.includes(target.path))) {
  pass("write scope is exactly the six target paths");
} else {
  fail("write scope does not match the six target paths");
}

const tmp = mkdtempSync(join(tmpdir(), "m20-check-"));
try {
  for (const target of targets) {
    const baselineFile = join(PACKAGE_DIR, target.baselineFixture);
    if (!existsSync(baselineFile)) {
      fail(`${target.name}: baseline fixture missing`);
      continue;
    }
    const baseline = read(baselineFile);
    if (shaFile(baselineFile) === target.baselineSha256)
      pass(`${target.name}: baseline hash matches manifest`);
    else fail(`${target.name}: baseline hash mismatch`);
    if (Buffer.byteLength(baseline) === target.baselineBytes)
      pass(`${target.name}: baseline byte count matches`);
    else fail(`${target.name}: baseline byte count mismatch`);

    const fm = frontmatterLines(baseline);
    if (!fm) {
      fail(`${target.name}: baseline has no frontmatter`);
      continue;
    }
    const nameLines = fm.all.filter((line) => /^name:\s*/.test(line));
    if (nameLines.length === 1) pass(`${target.name}: baseline has exactly one name line`);
    else fail(`${target.name}: baseline has ${nameLines.length} name lines`);
    if (!baseline.includes("disable-model-invocation"))
      pass(`${target.name}: baseline is not already hidden`);
    else fail(`${target.name}: baseline already contains the flag`);
    if (!baseline.includes("alwaysActive") && !/^always:\s*true/m.test(baseline)) {
      pass(`${target.name}: baseline has no alwaysActive/always:true`);
    } else {
      fail(`${target.name}: baseline uses alwaysActive/always:true`);
    }
    for (const token of target.requiredBodyTokens ?? []) {
      if (baseline.includes(token)) pass(`${target.name}: required body token present: ${token}`);
      else fail(`${target.name}: required body token missing: ${token}`);
    }

    const tmpFile = join(tmp, `${target.name}.md`);
    execFileSync("cp", [baselineFile, tmpFile]);
    const writeResult = runApply(["--file", tmpFile, "--name", target.name, "--write"]);
    if (!writeResult.ok || writeResult.output?.status !== "written") {
      fail(`${target.name}: transformer did not write`);
      continue;
    }
    const transformed = read(tmpFile);
    if (shaFile(tmpFile) === target.targetSha256)
      pass(`${target.name}: transformed hash matches manifest`);
    else fail(`${target.name}: transformed hash mismatch`);
    if (Buffer.byteLength(transformed) === target.targetBytes)
      pass(`${target.name}: transformed byte count matches`);
    else fail(`${target.name}: transformed byte count mismatch`);

    const transformedLines = lines(transformed);
    const flagIndexes = transformedLines
      .map((line, index) => (line.startsWith("disable-model-invocation") ? index : -1))
      .filter((index) => index >= 0);
    if (flagIndexes.length === 1) pass(`${target.name}: exactly one flag line`);
    else fail(`${target.name}: ${flagIndexes.length} flag lines`);
    const nameIndex = transformedLines.findIndex((line) => /^name:\s*/.test(line));
    if (flagIndexes[0] === nameIndex + 1) pass(`${target.name}: flag immediately follows name`);
    else fail(`${target.name}: flag is not immediately after name`);

    const removed = transformedLines.filter((_, index) => index !== flagIndexes[0]).join("\n");
    if (removed === baseline)
      pass(`${target.name}: removing the flag restores baseline byte-for-byte`);
    else fail(`${target.name}: removing the flag does not restore baseline`);

    const check = runApply(["--file", tmpFile, "--name", target.name, "--check"]);
    if (check.ok && check.output?.status === "hidden") pass(`${target.name}: check reports hidden`);
    else fail(`${target.name}: check does not report hidden`);

    const absolutePaths = [
      ...baseline.matchAll(/\/home\/raymond\/\.openclaw\/[^\s`]+SKILL\.md/g),
    ].map((match) => match[0]);
    if (absolutePaths.every((path) => transformed.includes(path))) {
      pass(`${target.name}: all ${absolutePaths.length} absolute SKILL.md references preserved`);
    } else {
      fail(`${target.name}: an absolute SKILL.md reference changed`);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// Older packages keep historical copies. Known copies are allowed as baselines;
// an unreconciled copy would be a new owner that can restore visibility silently.
const knownRoots = new Set(manifest.guard?.legacyPackageRoots ?? []);
const copiesByTarget = new Map(names.map((name) => [name, []]));
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (entry.name !== "SKILL.md") continue;
    const relativePath = relative(REPO_ROOT, full);
    if (!relativePath.includes("/files/")) continue;
    for (const name of names) {
      if (relativePath.endsWith(`/${name}/SKILL.md`)) copiesByTarget.get(name).push(relativePath);
    }
  }
}
walk(join(REPO_ROOT, "ops"));
for (const name of names) {
  const copies = [...new Set(copiesByTarget.get(name))];
  for (const copy of copies) {
    const packageName = copy.split("/")[1];
    if (!knownRoots.has(`ops/${packageName}`)) {
      fail(`${name}: unreconciled package copy ${copy}`);
      continue;
    }
    const text = read(join(REPO_ROOT, copy));
    if (text.includes("disable-model-invocation: true")) {
      pass(`${name}: known copy already hidden: ${copy}`);
    } else {
      pass(`${name}: known historical copy is pre-M20: ${copy}`);
    }
  }
  if (copies.length === 0) pass(`${name}: no repository package copy outside this package`);
}

const readme = join(PACKAGE_DIR, "README.md");
if (existsSync(readme)) {
  const text = read(readme);
  pass("README present");
  for (const token of [
    "disable-model-invocation",
    "79",
    "73",
    "18,000",
    "allowlist",
    "M15",
    "M19",
    "alwaysActive",
  ]) {
    if (text.includes(token)) pass(`README documents ${token}`);
    else fail(`README does not document ${token}`);
  }
  for (const name of names) {
    if (text.includes(name)) pass(`README names ${name}`);
    else fail(`README does not name ${name}`);
  }
} else {
  fail("README missing");
}

const scriptFiles = readdirSync(join(PACKAGE_DIR, "scripts")).map((name) =>
  join(PACKAGE_DIR, "scripts", name),
);
const scriptText = scriptFiles.map((file) => read(file)).join("\n");
for (const pattern of [
  /\bopenclaw\s+cron\b/,
  /\bcron\s+(edit|run|create|remove)\b/,
  /\bmessage\s+send\b/,
  /\blight_control\b/,
]) {
  if (pattern.test(scriptText)) fail(`scripts contain forbidden operation: ${pattern}`);
  else pass(`scripts avoid forbidden operation: ${pattern}`);
}
for (const token of [
  "new_backup_dir",
  "restore_targets_from_backup",
  "skills list",
  "skills info",
  "gateway health",
]) {
  if (scriptText.includes(token)) pass(`deploy/rollback scripts use ${token}`);
  else fail(`scripts do not use ${token}`);
}
if (read(join(PACKAGE_DIR, "scripts/deploy.sh")).includes("apply_write"))
  pass("deploy uses the reviewed transformer");
else fail("deploy does not use the reviewed transformer");
if (read(join(PACKAGE_DIR, "scripts/status.sh")).includes("VISIBILITY-RESTORED"))
  pass("status names visibility restoration");
else fail("status does not detect visibility restoration");
if (read(join(PACKAGE_DIR, "scripts/rollback.sh")).includes("--force"))
  pass("rollback has an explicit force path");
else fail("rollback has no force path");

for (const file of [
  "verify/check-catalog.sh",
  "verify/deploy-sim.sh",
  "verify/compare-catalog.mjs",
  "verify/check-info.mjs",
  "verify/fake-openclaw.mjs",
]) {
  if (existsSync(join(PACKAGE_DIR, file))) pass(`verification present: ${file}`);
  else fail(`verification missing: ${file}`);
}

// No package metadata should describe a different visible transition.
if (
  manifest.surfaces.expectedVisibleBefore === 79 &&
  manifest.surfaces.expectedVisibleAfter === 73
) {
  pass("manifest records the live 79 -> 73 transition");
} else {
  fail("manifest does not record 79 -> 73");
}
if (manifest.dependencyGate?.requiredMissions?.join(",") === "M15,M19")
  pass("manifest gates live deploy on M15 and M19");
else fail("manifest dependency gate is wrong");

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
