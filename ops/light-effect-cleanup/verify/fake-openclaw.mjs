#!/usr/bin/env node
// Minimal fake of the `openclaw` CLI used by verify/deploy-sim.mjs.
// State lives in FAKE_STATE (JSON). It only implements the commands the
// cleanup package calls, so the simulator never needs a Gateway.
import { readFileSync, writeFileSync } from "node:fs";

const statePath = process.env.FAKE_STATE;
if (!statePath) {
  console.error("FAKE_STATE is required");
  process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);

function save() {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function getPath(dotted) {
  let cursor = state.config;
  for (const part of dotted.split(".")) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return { found: false };
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      return { found: false };
    }
    cursor = cursor[part];
  }
  return { found: true, value: cursor };
}

function setPath(dotted, value) {
  const parts = dotted.split(".");
  let cursor = state.config;
  for (const part of parts.slice(0, -1)) {
    cursor[part] ??= {};
    cursor = cursor[part];
  }
  if (value === null) {
    delete cursor[parts.at(-1)];
  } else {
    cursor[parts.at(-1)] = value;
  }
}

function deepMerge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key];
    } else if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      deepMerge(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const [command, subcommand, ...rest] = args;

if (command === "cron" && subcommand === "get") {
  process.stdout.write(`${JSON.stringify(state.job, null, 2)}\n`);
  process.exit(0);
}

if (command === "cron" && subcommand === "edit") {
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--tools") {
      state.job.payload.toolsAllow = rest[i + 1].split(/[,\s]+/).filter(Boolean);
      i += 1;
    } else if (rest[i] === "--trigger-script") {
      state.job.trigger.script = readFileSync(rest[i + 1], "utf8");
      i += 1;
    }
  }
  save();
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  process.exit(0);
}

if (command === "config" && subcommand === "get") {
  const path = rest[0];
  const result = getPath(path);
  if (!result.found) {
    process.stdout.write(
      `${JSON.stringify({
        ok: false,
        error: {
          type: "cli_error",
          message: `Config path is valid but unset: ${path}. The runtime default applies until you set an authored value.`,
        },
      })}\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
  process.exit(0);
}

if (command === "config" && subcommand === "patch") {
  if (process.env.FAKE_FAIL_CONFIG_PATCH === "1") {
    console.error("fake config patch failure");
    process.exit(1);
  }
  const fileIndex = rest.indexOf("--file");
  if (fileIndex < 0) {
    fail("config patch needs --file");
  }
  const patch = JSON.parse(readFileSync(rest[fileIndex + 1], "utf8"));
  deepMerge(state.config, patch);
  save();
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  process.exit(0);
}

if (command === "config" && subcommand === "validate") {
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  process.exit(0);
}

if (command === "skills" && subcommand === "info") {
  process.stdout.write(
    `${JSON.stringify({
      name: "collector-notify",
      eligible: true,
      modelVisible: true,
      filePath: `${process.env.FAKE_TARGET_ROOT ?? ""}/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md`,
    })}\n`,
  );
  process.exit(0);
}

if (command === "plugins" && subcommand === "list") {
  process.stdout.write(
    `${JSON.stringify({
      plugins: [
        {
          id: "phone-notifications",
          name: "Phone Notifications & Light Control",
          version: "1.20.2",
          enabled: true,
          status: "loaded",
          toolNames: [
            "notifications_summary",
            "light_control",
            "lightrules_list",
            "lightrules_create",
            "lightrules_update",
            "lightrules_delete",
            "ai_todo_list",
            "ai_todo_get",
            "ai_todo_create",
            "ai_todo_update",
            "ai_todo_delete",
            "plugin-update",
            "result_deliver",
          ],
        },
      ],
    })}\n`,
  );
  process.exit(0);
}

fail(`fake openclaw: unsupported command: ${args.join(" ")}`);
