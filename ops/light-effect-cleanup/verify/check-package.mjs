#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Offline structural checks for the light-effect cleanup package.
// These do not read or write live state.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { loadManifest, PACKAGE_DIR } from "../scripts/lib.mjs";

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

const manifest = loadManifest();
const forbidden = manifest.forbiddenAfter;
const lightTools = [
  "light_control",
  "lightrules_list",
  "lightrules_create",
  "lightrules_update",
  "lightrules_delete",
].sort();

check("manifest has files", manifest.files.length >= 9);
check(
  "every target is under home/raymond/.openclaw",
  manifest.files.every((spec) => /^home\/raymond\/\.openclaw\//.test(spec.path)),
);
check(
  "target paths are unique",
  new Set(manifest.files.map((spec) => spec.path)).size === manifest.files.length,
);
check(
  "baseline hashes are sha256",
  manifest.files.every((spec) => /^[0-9a-f]{64}$/.test(spec.baselineSha256)),
);

const requiredOwners = [
  "home/raymond/.openclaw/workspace/AGENTS.md",
  "home/raymond/.openclaw/workspace/scripts/sentinel.md",
  "home/raymond/.openclaw/agents/main/agent/workshop-skills/dingtalk-busy-reply/SKILL.md",
  "home/raymond/.openclaw/agents/main/agent/workshop-skills/yoooclaw-plugin-status/SKILL.md",
  "home/raymond/.openclaw/agents/main/agent/workshop-skills/openclaw-automations-jobs/SKILL.md",
  "home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md",
  "home/raymond/.openclaw/workspace/skills/collector-health-repair/SKILL.md",
  "home/raymond/.openclaw/workspace/collection/README.md",
  "home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs",
  "home/raymond/.openclaw/workspace/collection/trigger-collector.mjs",
];
for (const path of requiredOwners) {
  check(
    `inventory includes ${path}`,
    manifest.files.some((spec) => spec.path === path),
  );
}

for (const spec of manifest.files) {
  check(`${spec.path} has ops`, spec.ops.length > 0);
  for (const [index, op] of spec.ops.entries()) {
    if (op.type === "replace") {
      check(`${spec.path} op#${index + 1} has old/new`, Boolean(op.old && op.new));
      const leftovers = forbidden.filter((token) => op.new.includes(token));
      check(
        `${spec.path} op#${index + 1} new text is light-free`,
        leftovers.length === 0,
        leftovers.join(","),
      );
    } else if (op.type === "removeSection") {
      check(`${spec.path} op#${index + 1} has start/end`, Boolean(op.start && op.end));
    } else {
      check(`${spec.path} op#${index + 1} type`, false, `unknown ${op.type}`);
    }
  }
}

check(
  "alsoAllow removal covers the five light tools",
  JSON.stringify([...manifest.config.removeFromAlsoAllow].sort()) === JSON.stringify(lightTools),
);
check(
  "deny list covers the five light tools",
  JSON.stringify([...manifest.config.denyTools].sort()) === JSON.stringify(lightTools),
);
check("collector removes light_control", manifest.job.removeTools.includes("light_control"));
check(
  "collector message is checked for light references",
  ["light_control", "lightrules"].every((token) => manifest.job.forbiddenInMessage.includes(token)),
);
check(
  "post-patch scan includes bare ntf light",
  manifest.forbiddenAfter.includes("ntf light") &&
    manifest.forbiddenAfter.includes("ntf.cjs light"),
);

const allNewText = manifest.files.flatMap((spec) =>
  spec.ops.map((op) => (op.type === "replace" ? op.new : "")),
);
check(
  "no replacement reintroduces a light command",
  allNewText.every(
    (text) => !/ntf(?:\.cjs)?\s+light|light_control|lightrules_|light send/.test(text),
  ),
);
check(
  "reminder replacements use dingtalk-notify",
  manifest.files
    .filter((spec) => spec.path === "home/raymond/.openclaw/workspace/AGENTS.md")
    .every((spec) => spec.ops.some((op) => op.new.includes("dingtalk-notify.mjs"))),
);

const packageFiles = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      walk(path);
    } else {
      packageFiles.push(path);
    }
  }
}
walk(PACKAGE_DIR);

const forbiddenPatterns = [
  { name: "staffId target", regex: /user:\d{5,}/ },
  { name: "mobile number", regex: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: "bearer token", regex: /Bearer\s+[A-Za-z0-9._-]{12,}/ },
  { name: "api key assignment", regex: /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]/i },
  { name: "private key", regex: /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/ },
];
check(
  "package contains no credential/private-target patterns",
  packageFiles.every((path) => {
    const text = readFileSync(path, "utf8");
    return forbiddenPatterns.every((pattern) => !pattern.regex.test(text));
  }),
);

check(
  "package does not disable the phone-notifications plugin",
  packageFiles
    .filter((path) => path.endsWith(".mjs"))
    .every(
      (path) =>
        !/"phone-notifications"[\s\S]{0,80}enabled\s*:\s*false/.test(readFileSync(path, "utf8")),
    ),
);

const jsFiles = packageFiles.filter((path) => path.endsWith(".mjs"));
check(
  "JavaScript files parse",
  jsFiles.every((path) => {
    const result = spawnSync(process.execPath, ["--check", path], { encoding: "utf8" });
    return result.status === 0;
  }),
);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  process.exit(1);
}
console.log(`package: ${relative(process.cwd(), PACKAGE_DIR) || "."}`);
