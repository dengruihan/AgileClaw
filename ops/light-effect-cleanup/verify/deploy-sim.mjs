#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Offline end-to-end simulation for the light-effect cleanup package.
//
// Builds synthetic live files that contain every manifest patch target, then
// runs deploy/status/rollback against a fake `openclaw` CLI and a temporary
// target root. No live file, Gateway, config, or message is touched.
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyOps, loadManifest, PACKAGE_DIR } from "../scripts/lib.mjs";

const manifest = loadManifest();
const root = mkdtempSync(join(tmpdir(), "lec-sim-root-"));
const backupBase = mkdtempSync(join(tmpdir(), "lec-sim-backup-"));
const openclawDir = mkdtempSync(join(tmpdir(), "lec-sim-cli-"));
const fakeCli = join(openclawDir, "openclaw");
cpSync(join(PACKAGE_DIR, "verify/fake-openclaw.mjs"), fakeCli);
chmodSync(fakeCli, 0o755);
const statePath = join(openclawDir, "state.json");

let failures = 0;
let checks = 0;
function check(name, condition, detail = "") {
  checks += 1;
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function target(rel) {
  return join(root, rel);
}

function readTarget(rel) {
  return readFileSync(target(rel), "utf8");
}

const originals = new Map();
for (const spec of manifest.files) {
  let text = `# synthetic fixture for ${spec.path}\n\n`;
  for (const op of spec.ops) {
    if (op.type === "replace") {
      for (let i = 0; i < (op.count ?? 1); i += 1) {
        text += `${op.old}\n\n`;
      }
    } else if (op.type === "removeSection") {
      text += `${op.start}\n\nsynthetic light instructions\n\n${op.end}\n\n`;
    }
  }
  text += "synthetic tail\n";
  originals.set(spec.path, text);
  mkdirSync(dirname(target(spec.path)), { recursive: true });
  writeFileSync(target(spec.path), text, "utf8");
}

const oldTrigger = manifest.job.triggerReplacements[0].old;
const job = {
  id: manifest.job.id,
  name: manifest.job.name,
  displayName: "统一事项收集",
  enabled: true,
  description: "synthetic collector",
  sessionTarget: "isolated",
  wakeMode: "now",
  schedule: { kind: "every", everyMs: 600000 },
  payload: {
    kind: "agentTurn",
    message: "clean dispatcher fixture: no light instructions",
    timeoutSeconds: 600,
    lightContext: true,
    toolsAllow: [
      "ls",
      "read",
      "edit",
      "write",
      "apply_patch",
      "exec",
      "process",
      "light_control",
      "agenda",
    ],
  },
  delivery: { mode: "none" },
  trigger: {
    script: `const one = "${oldTrigger}";\nconst two = "${oldTrigger}";\nreturn {};`,
  },
};
const config = {
  tools: {
    alsoAllow: [
      "notifications_summary",
      ...manifest.config.removeFromAlsoAllow,
      "ai_todo_list",
      "plugin-update",
    ],
  },
  agents: {
    entries: {
      main: {
        tools: {
          alsoAllow: [
            "notifications_summary",
            ...manifest.config.removeFromAlsoAllow,
            "ai_todo_list",
            "plugin-update",
          ],
        },
      },
    },
  },
};
writeFileSync(statePath, `${JSON.stringify({ job, config }, null, 2)}\n`, "utf8");

function readState() {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function run(script, args, extraEnv = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
    env: {
      ...process.env,
      LEC_TARGET_ROOT: root,
      LEC_BACKUP_BASE: backupBase,
      LEC_OPENCLAW_BIN: fakeCli,
      LEC_OPENCLAW_ROOT: openclawDir,
      LEC_SKIP_DISCOVERY: "1",
      LEC_SKIP_NOTIFY_CHECK: "1",
      FAKE_STATE: statePath,
      FAKE_TARGET_ROOT: root,
      ...extraEnv,
    },
  });
}

const deploy = join(PACKAGE_DIR, "scripts/deploy.mjs");
const status = join(PACKAGE_DIR, "scripts/status.mjs");
const rollback = join(PACKAGE_DIR, "scripts/rollback.mjs");
const forbidden = manifest.forbiddenAfter;

// 1. Read-only plan.
let result = run(deploy, []);
check("plan exits 0", result.status === 0, result.stderr);
check("plan mentions plan only", result.stdout.includes("plan only"));
check(
  "plan does not modify files",
  [...originals].every(([rel, text]) => readTarget(rel) === text),
);

// 2. Refuse drift without --allow-drift.
result = run(deploy, ["--yes"]);
check("drift refusal exits 1", result.status === 1);
check(
  "drift refusal names --allow-drift",
  result.stdout.includes("--allow-drift") || result.stderr.includes("--allow-drift"),
);
check(
  "drift refusal leaves files untouched",
  [...originals].every(([rel, text]) => readTarget(rel) === text),
);

// 3. Config-patch failure restores files and cron.
let stateBefore = readState();
result = run(deploy, ["--yes", "--allow-drift"], { FAKE_FAIL_CONFIG_PATCH: "1" });
check("config failure exits 1", result.status === 1, result.stderr);
check(
  "config failure restores files",
  [...originals].every(([rel, text]) => readTarget(rel) === text),
);
check(
  "config failure restores collector tools",
  JSON.stringify(readState().job.payload.toolsAllow) ===
    JSON.stringify(stateBefore.job.payload.toolsAllow),
);
check(
  "config failure restores collector trigger",
  readState().job.trigger.script === stateBefore.job.trigger.script,
);
check(
  "config failure leaves config untouched",
  JSON.stringify(readState().config) === JSON.stringify(stateBefore.config),
);

// 4. Successful deploy.
result = run(deploy, ["--yes", "--allow-drift"]);
check("deploy exits 0", result.status === 0, result.stderr || result.stdout);
for (const spec of manifest.files) {
  const text = readTarget(spec.path);
  const expected = applyOps(originals.get(spec.path), spec.ops).text;
  check(`${spec.path} patched`, text === expected);
  const leftovers = forbidden.filter((token) => text.includes(token));
  check(`${spec.path} has no light tokens`, leftovers.length === 0, leftovers.join(","));
}
let stateAfter = readState();
check(
  "alsoAllow drops every light tool",
  manifest.config.alsoAllowPaths.every((path) => {
    const parts = path.split(".");
    let cursor = stateAfter.config;
    for (const part of parts) {
      cursor = cursor?.[part];
    }
    return (
      Array.isArray(cursor) &&
      !cursor.some((tool) => manifest.config.removeFromAlsoAllow.includes(tool))
    );
  }),
);
check(
  "deny lists every light tool",
  manifest.config.denyTools.every((tool) => stateAfter.config.tools.deny?.includes(tool)),
);
check(
  "collector toolsAllow drops light_control",
  !stateAfter.job.payload.toolsAllow.includes("light_control"),
);
check("collector trigger has no 灯效", !stateAfter.job.trigger.script.includes("灯效"));
check(
  "collector message untouched",
  stateAfter.job.payload.message === stateBefore.job.payload.message,
);
check(
  "backup recorded",
  readdirSync(backupBase).some((name) => existsSync(join(backupBase, name, "deploy.json"))),
);

// 5. Status.
result = run(status, []);
check("status exits 0", result.status === 0, result.stderr);
check(
  "status reports deployed",
  result.stdout.includes("state:            deployed"),
  result.stdout,
);

// 6. Idempotent deploy.
result = run(deploy, ["--yes", "--allow-drift"]);
check("second deploy exits 0", result.status === 0, result.stderr);
check(
  "second deploy reports nothing to do",
  result.stdout.includes("nothing to do"),
  result.stdout,
);

// 7. Rollback.
result = run(rollback, ["--yes"]);
check("rollback exits 0", result.status === 0, result.stderr || result.stdout);
for (const spec of manifest.files) {
  check(`${spec.path} restored`, readTarget(spec.path) === originals.get(spec.path));
}
stateAfter = readState();
check(
  "rollback restores alsoAllow",
  JSON.stringify(stateAfter.config.tools.alsoAllow) === JSON.stringify(config.tools.alsoAllow),
);
check("rollback removes deny", stateAfter.config.tools.deny === undefined);
check(
  "rollback restores collector tools",
  JSON.stringify(stateAfter.job.payload.toolsAllow) === JSON.stringify(job.payload.toolsAllow),
);
check("rollback restores collector trigger", stateAfter.job.trigger.script === job.trigger.script);

// 8. Rollback is idempotent.
result = run(rollback, ["--yes"]);
check("second rollback exits 0", result.status === 0, result.stderr);
check(
  "second rollback reports nothing to do",
  result.stdout.includes("nothing to do"),
  result.stdout,
);

console.log(`\n${checks - failures}/${checks} checks passed`);
console.log(`temp root: ${root}`);
console.log(`temp backups: ${backupBase}`);
if (failures > 0) {
  process.exit(1);
}
