#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Static contract checks for the collector-notify mail-example sync (M13).
//
// The mission is a one-line wording sync, so these checks protect exactly that:
//   - the package skill equals the reviewed deployed content
//   - replacing the new example with the old one reconstructs the live
//     post-M11 baseline byte-for-byte (proves nothing else changed)
//   - the stale mail wording and every light-effect token stay out
//   - the other language rules, DingTalk send command and M11 failure text stay
//   - deploy/rollback/status write only collector-notify/SKILL.md
//   - no real mail content, addresses or credentials are shipped
//
// Usage: node verify/check-package.mjs
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const exists = (p) => existsSync(join(root, p));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const manifest = JSON.parse(read("manifest.json"));
const skill = read("files/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md");
const readme = read("README.md");
const deploy = read("scripts/deploy.sh");
const rollback = read("scripts/rollback.sh");
const status = read("scripts/status.sh");
const lib = read("scripts/lib.sh");

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
}
const has = (text, needle) => text.includes(needle);
const count = (text, needle) => text.split(needle).length - 1;

// --- 1. Package file and manifest agree -------------------------------------
check(
  "target path is the collector-notify skill",
  manifest.target.path === "home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md",
  manifest.target.path,
);
check("package file sha256 matches manifest", sha256(skill) === manifest.target.deployedSha256);
check(
  "package file byte length matches manifest",
  Buffer.byteLength(skill) === manifest.target.deployedBytes,
  `${Buffer.byteLength(skill)} vs ${manifest.target.deployedBytes}`,
);
check(
  "baseline hash is the recorded M11/M12 live value",
  manifest.target.baselineSha256 ===
    "6be95ab380d8435300d5401e40639440814662849f623c778180fa3718d857dc",
);

// --- 2. Exactly one line differs from the baseline ---------------------------
const { old: oldLine, new: newLine } = manifest.replacement;
check(
  "old mail example is a single bullet line",
  oldLine.startsWith("- ") && !oldLine.includes("\n"),
);
check(
  "new mail example is a single bullet line",
  newLine.startsWith("- ") && !newLine.includes("\n"),
);
check("new example replaces the old one once", count(skill, newLine) === 1 && !has(skill, oldLine));
const reconstructed = skill.replace(newLine, oldLine);
check(
  "reconstruction matches the baseline byte-for-byte",
  sha256(reconstructed) === manifest.target.baselineSha256,
  sha256(reconstructed),
);
check(
  "reconstruction matches the baseline byte length",
  Buffer.byteLength(reconstructed) === manifest.target.baselineBytes,
  `${Buffer.byteLength(reconstructed)} vs ${manifest.target.baselineBytes}`,
);

// --- 3. Stale wording and light-effect residue stay out ---------------------
for (const token of manifest.forbiddenAfter) {
  check(`forbidden token absent: ${token}`, !has(skill, token));
}
check("no stale 'mail body not collected' claim", !has(skill, "正文不在收集范围"));
check("no instruction to open the mailbox", !has(skill, "打开邮箱"));
check("description no longer mentions the light fallback", !has(skill, "灯效"));

// --- 4. Reviewed anchors survive --------------------------------------------
for (const token of manifest.requiredAfter) {
  check(`required token present: ${token}`, has(skill, token));
}
for (const example of [
  "- 普通变化：",
  "- 需要行动：",
  "- 紧急事项：",
  "- 收集故障：",
  "- 邮件提醒：",
]) {
  check(`example kept: ${example}`, count(skill, example) === 1);
}
check(
  "DingTalk command unchanged",
  has(
    skill,
    "node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>",
  ),
);
check(
  "failure path reports instead of switching channels",
  has(skill, "不换通道重发、不凭记忆补发"),
);
check("dedupe ownership stays with the triage/repair skills", has(skill, "schedule-sweep 的职责"));
check("frontmatter name is collector-notify", has(skill, "name: collector-notify"));

// --- 5. Deploy/rollback write only the target -------------------------------
for (const [name, script] of [
  ["lib.sh", lib],
  ["deploy.sh", deploy],
  ["rollback.sh", rollback],
  ["status.sh", status],
]) {
  const syntax = spawnSync("bash", ["-n", join(root, "scripts", name)], { encoding: "utf8" });
  check(`${name} parses`, syntax.status === 0, syntax.stderr.trim());
}
check("lib defines exactly one skill path", count(lib, "SKILL_REL=") === 1);
check("target path is collector-notify", has(lib, 'skills/collector-notify/SKILL.md"'));
for (const forbiddenCall of [
  "cron edit",
  "cron get",
  "config patch",
  "--message",
  "openclaw skills",
  "git ",
]) {
  check(
    `scripts never call: ${forbiddenCall}`,
    ![deploy, rollback, status].some((s) => has(s, forbiddenCall)),
  );
}
check(
  "deploy backs up before writing",
  deploy.indexOf("SKILL.md.before") < deploy.indexOf('mv "$tmp"'),
);
check(
  "deploy verifies after writing",
  has(deploy, "verify_after") && has(deploy, "restore_previous"),
);
check(
  "deploy refuses unrecorded drift by default",
  has(deploy, "--allow-drift") && has(deploy, "allow_drift"),
);
check(
  "rollback refuses post-deploy drift by default",
  has(rollback, "changed after deployment") && has(rollback, "--force"),
);
check("status is read-only", !has(status, "cp ") && !has(status, "mv ") && !has(status, "rm "));

// --- 6. Deliverable hygiene --------------------------------------------------
check("README documents deploy", has(readme, "## 3. 部署"));
check("README documents rollback", has(readme, "## 4. 回滚"));
check("README documents verification", has(readme, "## 5. 验证"));
check("README states untouched surfaces", has(readme, "## 6. 不改动的部分"));
check("README states privacy limits", has(readme, "## 8. 隐私"));
check(
  "README names the one-line replacement",
  has(readme, "无法读取内容") && has(readme, "邮件提醒"),
);

const secretPatterns = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/u, "email address"],
  [/\b1[3-9]\d{9}\b/u, "mobile number"],
  [/\b(?:sk|ak|ghp|github_pat)-[A-Za-z0-9_-]{10,}/u, "API token"],
  [/\bBearer\s+[A-Za-z0-9._-]{10,}/u, "bearer token"],
  [/staffId\s*[:=]/iu, "staff id"],
];
for (const [pattern, label] of secretPatterns) {
  check(`no ${label} in skill`, !pattern.test(skill));
}
check(
  "no real mail identifiers in manifest",
  !/@|message[_-]?id/iu.test(JSON.stringify(manifest.replacement)),
);

if (failures.length > 0) {
  console.error(`FAIL ${failures.length} check(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`PASS ${passed} checks`);
