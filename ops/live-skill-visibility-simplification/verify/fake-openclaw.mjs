#!/usr/bin/env node
// Minimal fake `openclaw` CLI for the isolated deploy simulator. It implements
// only `skills list --json`, `skills info --json`, and `gateway health`, reading
// throwaway SKILL.md files under M20_FAKE_OPENCLAW_HOME.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.M20_FAKE_OPENCLAW_HOME || process.env.M20_OPENCLAW_HOME;
if (!root) {
  console.error("fake-openclaw: M20_FAKE_OPENCLAW_HOME or M20_OPENCLAW_HOME is required");
  process.exit(2);
}

const stateDir = process.env.M20_FAKE_STATE_DIR || join(root, ".fake-state");
const disabledFromEnv = (process.env.M20_FAKE_DISABLED || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const disabled = new Set(disabledFromEnv);

const configFile = join(root, "openclaw.json");
if (existsSync(configFile)) {
  try {
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    for (const [name, entry] of Object.entries(config?.skills?.entries ?? {})) {
      if (entry && entry.enabled === false) disabled.add(name);
    }
  } catch {
    // The simulator writes valid JSON; an unreadable file simply contributes no disabled entries.
  }
}

const roots = [
  { dir: join(root, "workspace/skills"), source: "openclaw-workspace" },
  { dir: join(root, "agents/main/agent/workshop-skills"), source: "openclaw-workshop" },
  { dir: join(root, "skills"), source: "openclaw-managed" },
];

function parseFrontmatter(text) {
  const lines = text.split("\n");
  const bare = (line) => line.replace(/\r$/, "");
  if (bare(lines[0]) !== "---") return null;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (bare(lines[i]) === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) return null;
  const fields = {};
  for (let i = 1; i < close; i += 1) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(bare(lines[i]));
    if (!match) continue;
    fields[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return fields;
}

function skills() {
  const found = [];
  for (const { dir, source } of roots) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const file = join(dir, entry.name, "SKILL.md");
      if (!existsSync(file)) continue;
      const fields = parseFrontmatter(readFileSync(file, "utf8"));
      if (!fields || !fields.name) continue;
      const isDisabled = disabled.has(fields.name);
      let modelVisible = !isDisabled && fields["disable-model-invocation"] !== "true";
      if (process.env.M20_FAKE_INFO_HIDE_FAIL === fields.name) modelVisible = true;
      found.push({
        name: fields.name,
        description: fields.description ?? "",
        emoji: "",
        eligible: !isDisabled,
        disabled: isDisabled,
        blockedByAllowlist: false,
        blockedByAgentFilter: false,
        modelVisible,
        userInvocable: fields["user-invocable"] !== "false",
        commandVisible: fields["user-invocable"] !== "false",
        source,
        bundled: false,
        filePath: file,
        baseDir: join(dir, entry.name),
      });
    }
  }
  return found;
}

function bumpListCall() {
  if (!existsSync(stateDir)) return 1;
  const file = join(stateDir, "list-calls");
  let count = 0;
  if (existsSync(file)) count = Number(readFileSync(file, "utf8")) || 0;
  count += 1;
  writeFileSync(file, String(count));
  return count;
}

const args = process.argv.slice(2);
const command = args[0];
if (command === "skills") {
  const sub = args[1];
  if (sub === "list") {
    const list = skills();
    const call = bumpListCall();
    const flip = process.env.M20_FAKE_LIST_FLIP_AFTER;
    if (flip && call >= 2) {
      for (const skill of list) {
        if (skill.name === flip) skill.modelVisible = !skill.modelVisible;
      }
    }
    process.stdout.write(
      JSON.stringify(
        {
          workspaceDir: join(root, "workspace"),
          managedSkillsDir: join(root, "skills"),
          skills: list,
        },
        null,
        2,
      ) + "\n",
    );
    process.exit(0);
  }
  if (sub === "info") {
    const name = args[2];
    const skill = skills().find((item) => item.name === name);
    if (!skill) {
      process.stdout.write(JSON.stringify({ name, eligible: false, modelVisible: false }) + "\n");
      process.exit(0);
    }
    process.stdout.write(JSON.stringify(skill, null, 2) + "\n");
    process.exit(0);
  }
  console.error(`fake-openclaw: unsupported skills command: ${sub ?? ""}`);
  process.exit(2);
}
if (command === "gateway" && args[1] === "health") {
  process.stdout.write("OK (0ms), fake gateway\n");
  process.exit(0);
}
console.error(`fake-openclaw: unsupported command: ${args.join(" ")}`);
process.exit(2);
