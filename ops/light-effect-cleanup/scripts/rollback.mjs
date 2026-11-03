#!/usr/bin/env node
// Roll back a light-effect cleanup deployment.
//
// Restores the exact pre-deploy files, collector trigger/tools, and config
// tool policy recorded by deploy.mjs. A surface that changed after deployment
// is reported and skipped unless --force is passed.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  backupBase,
  configGet,
  cronGet,
  loadManifest,
  readJson,
  readText,
  restoreFile,
  runCli,
  sha256,
  targetPath,
  writeJson,
} from "./lib.mjs";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const force = args.includes("--force");
const backupArg = args.includes("--backup") ? args[args.indexOf("--backup") + 1] : undefined;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function newestBackup() {
  const base = backupBase();
  if (!existsSync(base)) {
    return null;
  }
  const candidates = readdirSync(base)
    .map((name) => join(base, name))
    .filter((path) => existsSync(join(path, "deploy.json")))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

function setPatchPath(target, dotted, value) {
  const parts = dotted.split(".");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ??= {};
    cursor = cursor[part];
  }
  cursor[parts.at(-1)] = value;
}

const manifest = loadManifest();
const backupDir = backupArg ?? newestBackup();
if (!backupDir) {
  fail(`no deployment backup found under ${backupBase()}`);
}
const recordPath = join(backupDir, "deploy.json");
if (!existsSync(recordPath)) {
  fail(`not a deployment backup: ${backupDir}`);
}
const record = readJson(recordPath);

console.log(`backup:           ${backupDir}`);
console.log(`deployed at:      ${record.createdAt}`);

const fileActions = [];
for (const entry of record.files) {
  const path = targetPath(entry.path);
  let currentSha = "missing";
  try {
    currentSha = sha256(readText(path));
  } catch {
    currentSha = "missing";
  }
  if (currentSha === entry.afterSha256) {
    fileActions.push({ entry, path, action: "restore" });
  } else if (currentSha === entry.beforeSha256) {
    fileActions.push({ entry, path, action: "noop (already restored)" });
  } else if (force) {
    fileActions.push({ entry, path, action: "restore (drift override)" });
  } else {
    fileActions.push({ entry, path, action: "SKIP: changed after deploy (use --force)" });
  }
}

const jobResult = cronGet(manifest.job.id);
if (!jobResult.ok) {
  fail(`cron get failed: ${jobResult.error}`);
}
const job = jobResult.value;
const currentTrigger = job.trigger?.script ?? "";
const currentTriggerSha = sha256(currentTrigger);
const currentTools = Array.isArray(job.payload?.toolsAllow) ? job.payload.toolsAllow : [];

let triggerAction = "noop";
if (record.job.triggerChanged) {
  if (currentTriggerSha === record.after.triggerSha256) {
    triggerAction = "restore";
  } else if (currentTriggerSha === record.before.triggerSha256) {
    triggerAction = "noop (already restored)";
  } else if (force) {
    triggerAction = "restore (drift override)";
  } else {
    triggerAction = "SKIP: trigger changed after deploy (use --force)";
  }
}

let toolsAction = "noop";
if (record.job.toolsChanged) {
  if (JSON.stringify(currentTools) === JSON.stringify(record.after.tools)) {
    toolsAction = "restore";
  } else if (JSON.stringify(currentTools) === JSON.stringify(record.before.tools)) {
    toolsAction = "noop (already restored)";
  } else if (force) {
    toolsAction = "restore (drift override)";
  } else {
    toolsAction = "SKIP: toolsAllow changed after deploy (use --force)";
  }
}

const configActions = [];
for (const entry of record.config.alsoAllow) {
  const current = configGet(entry.path);
  if (!current.ok) {
    configActions.push({ entry, action: `SKIP: ${current.error}` });
    continue;
  }
  const value = current.unset ? undefined : current.value;
  if (JSON.stringify(value) === JSON.stringify(entry.after)) {
    configActions.push({ entry, action: "restore" });
  } else if (JSON.stringify(value) === JSON.stringify(entry.before)) {
    configActions.push({ entry, action: "noop (already restored)" });
  } else if (force) {
    configActions.push({ entry, action: "restore (drift override)" });
  } else {
    configActions.push({ entry, action: "SKIP: changed after deploy (use --force)" });
  }
}
let denyAction = "noop";
if (record.config.deny.changed) {
  const current = configGet(record.config.deny.path);
  const value = current.ok && !current.unset ? current.value : undefined;
  if (JSON.stringify(value) === JSON.stringify(record.config.deny.after)) {
    denyAction = "restore";
  } else if (
    (record.config.deny.wasUnset && value === undefined) ||
    JSON.stringify(value) === JSON.stringify(record.config.deny.before)
  ) {
    denyAction = "noop (already restored)";
  } else if (force) {
    denyAction = "restore (drift override)";
  } else {
    denyAction = "SKIP: changed after deploy (use --force)";
  }
}

for (const item of fileActions) {
  console.log(`file ${item.entry.path}: ${item.action}`);
}
console.log(`cron trigger: ${triggerAction}`);
console.log(`cron toolsAllow: ${toolsAction}`);
for (const item of configActions) {
  console.log(`config ${item.entry.path}: ${item.action}`);
}
console.log(`config ${record.config.deny.path}: ${denyAction}`);

const pending =
  fileActions.some((item) => item.action.startsWith("restore")) ||
  triggerAction.startsWith("restore") ||
  toolsAction.startsWith("restore") ||
  configActions.some((item) => item.action.startsWith("restore")) ||
  denyAction.startsWith("restore");
if (!pending) {
  console.log("nothing to do");
  process.exit(0);
}
if (!yes) {
  console.log("plan only. Rerun with --yes to apply.");
  process.exit(0);
}

for (const item of fileActions) {
  if (!item.action.startsWith("restore")) {
    continue;
  }
  restoreFile(backupDir, item.entry.backup, item.path);
  console.log(`restored:         ${item.entry.path}`);
}

if (triggerAction.startsWith("restore") || toolsAction.startsWith("restore")) {
  const editArgs = ["cron", "edit", manifest.job.id];
  if (toolsAction.startsWith("restore")) {
    editArgs.push("--tools", record.before.tools.join(","));
  }
  if (triggerAction.startsWith("restore")) {
    const triggerFile = join(backupDir, "trigger.restore.js");
    writeFileSync(triggerFile, record.job.beforeTrigger, "utf8");
    editArgs.push("--trigger-script", triggerFile);
  }
  const result = runCli(editArgs);
  if (!result.ok) {
    fail(
      `cron rollback failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  }
  console.log("restored:         collector trigger/tools");
}

const patch = {};
let configPending = false;
for (const item of configActions) {
  if (item.action.startsWith("restore")) {
    setPatchPath(patch, item.entry.path, item.entry.before);
    configPending = true;
  }
}
if (denyAction.startsWith("restore")) {
  setPatchPath(
    patch,
    record.config.deny.path,
    record.config.deny.wasUnset ? null : record.config.deny.before,
  );
  configPending = true;
}
if (configPending) {
  const patchFile = join(backupDir, "config.rollback.json");
  writeJson(patchFile, patch);
  const result = runCli(["config", "patch", "--file", patchFile]);
  if (!result.ok) {
    fail(
      `config rollback failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
    );
  }
  console.log("restored:         config tool policy");
}

let verifyProblems = [];
for (const entry of record.files) {
  const path = targetPath(entry.path);
  let currentSha = "missing";
  try {
    currentSha = sha256(readText(path));
  } catch {
    currentSha = "missing";
  }
  if (currentSha !== entry.beforeSha256) {
    verifyProblems.push(`${entry.path} does not match the pre-deploy hash`);
  }
}
const afterJob = cronGet(manifest.job.id);
if (!afterJob.ok) {
  verifyProblems.push(`cron get failed: ${afterJob.error}`);
} else {
  const afterTriggerSha = sha256(afterJob.value.trigger?.script ?? "");
  if (record.job.triggerChanged && afterTriggerSha !== record.before.triggerSha256) {
    verifyProblems.push("collector trigger does not match the pre-deploy hash");
  }
  if (
    record.job.toolsChanged &&
    JSON.stringify(afterJob.value.payload?.toolsAllow) !== JSON.stringify(record.before.tools)
  ) {
    verifyProblems.push("collector toolsAllow does not match the pre-deploy value");
  }
  if (afterJob.value.payload?.message !== record.job.full.payload?.message) {
    verifyProblems.push("collector payload.message changed during rollback");
  }
}
for (const item of configActions) {
  const current = configGet(item.entry.path);
  const value = current.ok && !current.unset ? current.value : undefined;
  if (JSON.stringify(value) !== JSON.stringify(item.entry.before)) {
    verifyProblems.push(`${item.entry.path} does not match the pre-deploy value`);
  }
}
if (record.config.deny.changed) {
  const current = configGet(record.config.deny.path);
  const value = current.ok && !current.unset ? current.value : undefined;
  if (
    record.config.deny.wasUnset
      ? value !== undefined
      : JSON.stringify(value) !== JSON.stringify(record.config.deny.before)
  ) {
    verifyProblems.push(`${record.config.deny.path} does not match the pre-deploy value`);
  }
}

if (verifyProblems.length > 0) {
  fail(`rollback verification failed:\n- ${verifyProblems.join("\n- ")}`);
}
console.log("verified:         pre-deploy files, trigger/tools, and config restored");
