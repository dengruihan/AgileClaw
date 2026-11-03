#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Deploy the light-effect cleanup package.
//
// Without --yes this is a read-only plan. Every apply backs up all touched
// surfaces first, then verifies them; a failed verification restores the
// backup and exits non-zero.
//
// What changes:
//   - five live instruction/policy files plus dingtalk-notify.mjs and the
//     collector trigger source file
//   - the collector automation's trigger script and toolsAllow
//   - tools.alsoAllow (global + main) and tools.deny
// What does not change:
//   - the collector payload.message, schedule, timeout, lightContext, delivery,
//     session/wake settings
//   - the phone-notifications plugin installation or enablement
//   - any live message, Gateway process, or hardware state
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyOps,
  backupBase,
  backupFile,
  cronGet,
  fmtList,
  loadManifest,
  openclawBin,
  restoreFile,
  runCli,
  sha256,
  targetPath,
  writeJson,
  writeTextAtomic,
} from "./lib.mjs";
import { buildPlan } from "./plan.mjs";

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const allowDrift = args.includes("--allow-drift");
const skipDiscovery = process.env.LEC_SKIP_DISCOVERY === "1" || args.includes("--skip-discovery");
const skipNotifyCheck =
  process.env.LEC_SKIP_NOTIFY_CHECK === "1" || args.includes("--skip-notify-check");
const backupOverride = args.includes("--backup") ? args[args.indexOf("--backup") + 1] : undefined;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function jobSnapshot(job) {
  return {
    enabled: job.enabled ?? null,
    description: job.description ?? null,
    sessionTarget: job.sessionTarget ?? null,
    wakeMode: job.wakeMode ?? null,
    schedule: job.schedule ?? null,
    timeoutSeconds: job.payload?.timeoutSeconds ?? null,
    lightContext: job.payload?.lightContext ?? null,
    delivery: job.delivery ?? null,
  };
}

function assertNoErrors(plan) {
  if (plan.errors.length > 0) {
    fail(`live state does not match the package preconditions:\n- ${plan.errors.join("\n- ")}`);
  }
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

function integrationCheck(manifest) {
  if (skipDiscovery) {
    return { ok: true, skipped: true };
  }
  const problems = [];
  const skills = runCli(["skills", "info", "collector-notify", "--agent", "main", "--json"]);
  if (!skills.ok) {
    problems.push("collector-notify skill is not discoverable for agent main");
  } else {
    try {
      const parsed = JSON.parse(skills.stdout);
      if (parsed.eligible !== true || parsed.modelVisible !== true) {
        problems.push("collector-notify skill is not eligible/modelVisible");
      }
    } catch {
      problems.push("collector-notify skills info returned non-JSON");
    }
  }
  const plugins = runCli(["plugins", "list", "--json"]);
  if (!plugins.ok) {
    problems.push("plugins list failed");
  } else {
    try {
      const parsed = JSON.parse(plugins.stdout);
      const plugin = (parsed.plugins ?? []).find((entry) => entry.id === "phone-notifications");
      if (!plugin) {
        problems.push("phone-notifications plugin disappeared");
      } else {
        if (plugin.enabled !== true || plugin.status === "error") {
          problems.push("phone-notifications plugin is not enabled/loaded");
        }
        const names = plugin.toolNames ?? [];
        for (const required of ["notifications_summary", "ai_todo_list"]) {
          if (!names.includes(required)) {
            problems.push(`phone-notifications no longer exposes ${required}`);
          }
        }
      }
    } catch {
      problems.push("plugins list returned non-JSON");
    }
  }
  const validate = runCli(["config", "validate"]);
  if (!validate.ok) {
    problems.push(`config validate failed: ${(validate.stderr || validate.stdout).trim()}`);
  }
  return { ok: problems.length === 0, problems, skipped: false };
}

function notifyDryRunCheck() {
  if (skipNotifyCheck) {
    return { ok: true, skipped: true };
  }
  const path = targetPath("home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs");
  const result = spawnSync(
    process.execPath,
    [path, "--title", "清理验证", "--text", "只做dry-run不发送", "--dry-run"],
    { encoding: "utf8", timeout: 60_000, env: process.env },
  );
  if (result.error) {
    return {
      ok: false,
      problems: [`dingtalk-notify dry-run failed to start: ${result.error.message}`],
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      problems: [
        `dingtalk-notify dry-run exited ${result.status}: ${(result.stderr || "").trim()}`,
      ],
    };
  }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.dryRun !== true || !Array.isArray(parsed.sends) || parsed.sends.length === 0) {
      return { ok: false, problems: ["dingtalk-notify dry-run did not produce a send plan"] };
    }
    if (parsed.sends.length !== parsed.chunks) {
      return { ok: false, problems: ["dingtalk-notify dry-run chunk count mismatch"] };
    }
  } catch {
    return { ok: false, problems: ["dingtalk-notify dry-run returned non-JSON output"] };
  }
  return { ok: true, skipped: false };
}

function restoreBackup(record, backupDir, manifest) {
  echoRestore("restoring files");
  for (const entry of record.files) {
    try {
      restoreFile(backupDir, entry.backup, targetPath(entry.path));
    } catch (error) {
      console.error(`==> failed to restore ${entry.path}: ${error.message}`);
    }
  }
  if (record.job.triggerChanged || record.job.toolsChanged) {
    echoRestore("restoring collector trigger/tools");
    const restoreArgs = ["cron", "edit", manifest.job.id];
    if (record.job.toolsChanged) {
      restoreArgs.push("--tools", record.job.beforeTools.join(","));
    }
    if (record.job.triggerChanged) {
      const triggerFile = join(backupDir, "trigger.before.js");
      writeFileSync(triggerFile, record.job.beforeTrigger, "utf8");
      restoreArgs.push("--trigger-script", triggerFile);
    }
    const result = runCli(restoreArgs);
    if (!result.ok) {
      console.error(
        `==> restore cron edit FAILED; run scripts/rollback.mjs --yes --backup ${backupDir}`,
      );
    }
  }
  if (record.config.changed) {
    echoRestore("restoring config tool policy");
    const patch = {};
    for (const entry of record.config.alsoAllow) {
      if (entry.changed) {
        setPatchPath(patch, entry.path, entry.before);
      }
    }
    if (record.config.deny.changed) {
      setPatchPath(
        patch,
        record.config.deny.path,
        record.config.deny.wasUnset ? null : record.config.deny.before,
      );
    }
    const patchFile = join(backupDir, "config.restore.json");
    writeJson(patchFile, patch);
    const result = runCli(["config", "patch", "--file", patchFile]);
    if (!result.ok) {
      console.error(
        `==> restore config patch FAILED; run scripts/rollback.mjs --yes --backup ${backupDir}`,
      );
    }
  }
}

function echoRestore(message) {
  console.error(`==> ${message}`);
}

const manifest = loadManifest();
let plan = buildPlan(manifest);

if (plan.errors.length > 0) {
  console.error("Precondition errors:");
  for (const error of plan.errors) {
    console.error(`- ${error}`);
  }
  fail("fix the live state (or update the package manifest) before deploying");
}

const changedFiles = plan.files.filter((file) => file.changed);
const drifted = changedFiles.filter((file) => !file.baselineMatch);
const cronChanged = plan.cron.toolsChanged || plan.cron.triggerChanged;
const configChanged = plan.config.patchChanged;

console.log(`job:              ${manifest.job.name} (${manifest.job.id})`);
console.log(`message sha256:   ${plan.cron.messageSha} (left untouched)`);
console.log(`trigger sha256:   ${plan.cron.currentTriggerSha} -> ${plan.cron.desiredTriggerSha}`);
console.log(`toolsAllow:       ${fmtList(plan.cron.currentTools)}`);
console.log(`             ->   ${fmtList(plan.cron.desiredTools)}`);
console.log(
  `alsoAllow:        ${plan.config.alsoAllow
    .map((entry) => `${entry.path}: ${fmtList(entry.current)} -> ${fmtList(entry.next)}`)
    .join("\n                  ")}`,
);
console.log(
  `deny:             ${plan.config.deny.path}: ${fmtList(plan.config.deny.current)} -> ${fmtList(plan.config.deny.next)}`,
);
for (const file of plan.files) {
  const state = !file.changed
    ? "up-to-date"
    : `${file.baselineMatch ? "patch" : "patch (drift)"} ${file.sha.slice(0, 12)} -> ${file.nextSha.slice(0, 12)}`;
  console.log(`file:             ${file.spec.path}: ${state}`);
}

if (plan.complete) {
  console.log("state:            deployed (nothing to do)");
  process.exit(0);
}

if (!yes) {
  if (drifted.length > 0) {
    console.log(
      `NOTE: ${drifted.length} file(s) changed since the package baseline; applying will require --allow-drift.`,
    );
  }
  console.log("plan only. Rerun with --yes to apply.");
  console.log(
    "apply order: file patches -> collector trigger/tools -> config tool policy -> verification",
  );
  process.exit(0);
}

if (drifted.length > 0 && !allowDrift) {
  fail(
    `these files changed since the package baseline:\n- ${drifted
      .map((file) => `${file.spec.path} (${file.sha})`)
      .join(
        "\n- ",
      )}\nReview the diff, then rerun with --allow-drift if the edit is still intended.`,
  );
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = backupOverride ?? join(backupBase(), stamp);
mkdirSync(join(backupDir, "files"), { recursive: true });

const record = {
  version: 1,
  package: manifest.name,
  createdAt: new Date().toISOString(),
  jobId: manifest.job.id,
  before: {
    messageSha256: plan.cron.messageSha,
    triggerSha256: plan.cron.currentTriggerSha,
    tools: plan.cron.currentTools,
    config: {
      alsoAllow: plan.config.alsoAllow.map((entry) => ({
        path: entry.path,
        value: entry.current,
        changed: entry.changed,
      })),
      deny: {
        path: plan.config.deny.path,
        value: plan.config.deny.current,
        wasUnset: plan.config.deny.wasUnset,
        changed: plan.config.deny.changed,
      },
    },
  },
  after: {
    messageSha256: plan.cron.messageSha,
    triggerSha256: plan.cron.desiredTriggerSha,
    tools: plan.cron.desiredTools,
    config: {
      alsoAllow: plan.config.alsoAllow.map((entry) => ({
        path: entry.path,
        value: entry.next,
      })),
      deny: plan.config.deny.next,
    },
  },
  files: changedFiles.map((file) => {
    const backup = backupFile(file.path, backupDir, file.index);
    return {
      path: file.spec.path,
      beforeSha256: file.sha,
      afterSha256: file.nextSha,
      backup,
    };
  }),
  job: {
    full: plan.cron.job,
    snapshot: jobSnapshot(plan.cron.job),
    triggerChanged: plan.cron.triggerChanged,
    toolsChanged: plan.cron.toolsChanged,
    beforeTrigger: plan.cron.currentTrigger,
    beforeTools: plan.cron.currentTools,
  },
  config: {
    changed: configChanged,
    alsoAllow: plan.config.alsoAllow.map((entry) => ({
      path: entry.path,
      before: entry.current,
      after: entry.next,
      changed: entry.changed,
    })),
    deny: {
      path: plan.config.deny.path,
      before: plan.config.deny.current,
      after: plan.config.deny.next,
      wasUnset: plan.config.deny.wasUnset,
      changed: plan.config.deny.changed,
    },
  },
};
writeJson(join(backupDir, "deploy.json"), record);
writeJson(join(backupDir, "collector-job.before.json"), plan.cron.job);
writeFileSync(join(backupDir, "trigger.before.js"), plan.cron.currentTrigger, "utf8");
console.log(`backup:           ${backupDir}`);

try {
  for (const file of changedFiles) {
    writeTextAtomic(file.path, file.next, file.mode);
    console.log(`wrote:            ${file.spec.path}`);
  }

  if (cronChanged) {
    const editArgs = ["cron", "edit", manifest.job.id];
    if (plan.cron.toolsChanged) {
      editArgs.push("--tools", plan.cron.desiredTools.join(","));
    }
    if (plan.cron.triggerChanged) {
      const desiredTriggerFile = join(backupDir, "trigger.after.js");
      writeFileSync(desiredTriggerFile, plan.cron.desiredTrigger, "utf8");
      editArgs.push("--trigger-script", desiredTriggerFile);
    }
    const result = runCli(editArgs);
    if (!result.ok) {
      throw new Error(
        `cron edit failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
      );
    }
    console.log("updated:          collector trigger/tools");
  }

  if (configChanged) {
    const patchFile = join(backupDir, "config.patch.json");
    writeJson(patchFile, plan.config.patch);
    const result = runCli(["config", "patch", "--file", patchFile]);
    if (!result.ok) {
      throw new Error(
        `config patch failed: ${(result.stderr || result.stdout).trim() || `exit ${result.status}`}`,
      );
    }
    console.log("updated:          tool policy (alsoAllow/deny)");
  }

  const after = buildPlan(manifest);
  if (!after.complete) {
    throw new Error(
      `post-deploy verification failed:\n- ${
        after.errors.length > 0
          ? after.errors.join("\n- ")
          : "one or more surfaces still differ from the package"
      }`,
    );
  }
  const afterJob = cronGet(manifest.job.id);
  if (!afterJob.ok) {
    throw new Error(`post-deploy cron get failed: ${afterJob.error}`);
  }
  if (afterJob.value.payload?.message !== plan.cron.message) {
    throw new Error("collector payload.message changed unexpectedly");
  }
  if (JSON.stringify(jobSnapshot(afterJob.value)) !== JSON.stringify(jobSnapshot(plan.cron.job))) {
    throw new Error("an untouched collector job field changed unexpectedly");
  }
  const integration = integrationCheck(manifest);
  if (!integration.ok) {
    throw new Error(`integration checks failed:\n- ${integration.problems.join("\n- ")}`);
  }
  const notify = notifyDryRunCheck();
  if (!notify.ok) {
    throw new Error(`notification dry-run failed:\n- ${notify.problems.join("\n- ")}`);
  }

  console.log("verified:         files, collector trigger/tools, and config tool policy");
  console.log(`state:            deployed`);
  console.log(`backup:           ${backupDir}`);
  console.log(`openclaw:         ${openclawBin()}`);
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  restoreBackup(record, backupDir, manifest);
  process.exit(1);
}
