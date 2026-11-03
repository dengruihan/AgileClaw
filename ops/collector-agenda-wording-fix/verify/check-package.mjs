#!/usr/bin/env node
import { spawnSync } from "node:child_process";
// Static contract checks for the M15 collector Agenda-wording fix.
//
// The mission changes wording, so these checks protect exactly that:
//   - the package copies equal their reviewed manifest hashes
//   - the recorded baselines equal the previous owner packages and live hashes
//   - reverse-applying the change reconstructs each baseline byte-for-byte
//   - no positive 便单 destination/claim survives, while the explicit
//     prohibition line is allowed
//   - Agenda is the only collector todo destination and notifications may only
//     claim actions completed in the current run
//   - deploy/rollback write only the five recorded surfaces and send nothing
//   - no private mail/user data or credentials are shipped
//
// Usage: node verify/check-package.mjs
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const exists = (p) => existsSync(join(root, p));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const bytes = (text) => Buffer.byteLength(text);

const manifest = JSON.parse(read("manifest.json"));
const payload = read("payload-message.txt").replace(/\n$/u, "");
const readme = read("README.md");
const lib = read("scripts/lib.sh");
const deploy = read("scripts/deploy.sh");
const rollback = read("scripts/rollback.sh");
const status = read("scripts/status.sh");
const deploySim = read("verify/deploy-sim.sh");

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
const apply = (text, list, from, to) => {
  let out = text;
  for (const item of list) out = out.replace(item[from], item[to]);
  return out;
};
const positiveLines = (text) =>
  text
    .split("\n")
    .filter((line) => line.includes("便单"))
    .filter((line) => !manifest.prohibitionMarkers.some((m) => line.includes(m)));

// --- 1. Manifest, package copies and recorded baselines ---------------------
check("package name", manifest.name === "collector-agenda-wording-fix", manifest.name);
check("mission is M15", manifest.mission === "M15", manifest.mission);
check("two skill copies are recorded", manifest.files.length === 2);
check("two anchored patches are recorded", manifest.patches.length === 2);

for (const entry of manifest.files) {
  const name = entry.path.split("/").slice(-2)[0];
  const packageFile = join(root, "files", entry.path);
  check(`package file exists: ${name}`, exists(join("files", entry.path)), packageFile);
  if (!exists(join("files", entry.path))) continue;
  const text = read(join("files", entry.path));
  check(
    `package hash matches manifest: ${name}`,
    sha256(text) === entry.deployedSha256,
    sha256(text),
  );
  check(`package byte length matches manifest: ${name}`, bytes(text) === entry.deployedBytes);
  check(`baseline fixture exists: ${name}`, exists(join("baselines", entry.baselineFixture)));
  if (!exists(join("baselines", entry.baselineFixture))) continue;
  const baseline = read(join("baselines", entry.baselineFixture));
  check(
    `baseline fixture hash matches manifest: ${name}`,
    sha256(baseline) === entry.baselineSha256,
  );
  check(`baseline fixture bytes match manifest: ${name}`, bytes(baseline) === entry.baselineBytes);
  check(`baseline differs from the package: ${name}`, baseline !== text);
  if (existsSync(join(root, "..", "..", entry.baselineOwner))) {
    const owner = readFileSync(join(root, "..", "..", entry.baselineOwner), "utf8");
    check(
      `baseline equals the previous owner copy: ${name}`,
      sha256(owner) === entry.baselineSha256,
    );
  } else {
    check(`previous owner copy found: ${name}`, false, entry.baselineOwner);
  }
  check(
    `reverse replacements are recorded: ${name}`,
    Array.isArray(entry.reverseReplacements) && entry.reverseReplacements.length > 0,
  );
  const reversed = apply(text, entry.reverseReplacements, "new", "old");
  check(
    `reverse application reconstructs the baseline: ${name}`,
    sha256(reversed) === entry.baselineSha256,
  );
  check(
    `reverse application matches baseline bytes: ${name}`,
    bytes(reversed) === entry.baselineBytes,
  );
  for (const item of entry.reverseReplacements) {
    check(
      `reverse replacement is unique in the package: ${name}`,
      count(text, item.new) === 1,
      item.new.slice(0, 24),
    );
  }
}

// --- 2. Cron payload baseline and desired text -----------------------------
check(
  "cron job id is the collector automation",
  manifest.cron.jobId === "6a45be21-ce0b-4b8b-8986-4c885d1ea659",
);
check(
  "payload hash matches manifest",
  sha256(payload) === manifest.cron.desiredMessageSha256,
  sha256(payload),
);
check("payload bytes match manifest", bytes(payload) === manifest.cron.desiredMessageBytes);
check("payload chars match manifest", [...payload].length === manifest.cron.desiredMessageChars);
check(
  "payload is short enough to stay a dispatcher",
  payload.length >= 700 && payload.length <= 900,
);
const baselinePayload = read(join("baselines", "payload-message.pre-m15.txt")).replace(/\n$/u, "");
check(
  "payload baseline hash matches manifest",
  sha256(baselinePayload) === manifest.cron.baselineMessageSha256,
);
check(
  "payload baseline bytes match manifest",
  bytes(baselinePayload) === manifest.cron.baselineMessageBytes,
);
check("payload changed", payload !== baselinePayload);
check(
  "payload baseline equals the previous owner copy",
  sha256(baselinePayload) ===
    sha256(
      readFileSync(
        join(root, "..", "collector-mail-agent-triage/payload-message.txt"),
        "utf8",
      ).replace(/\n$/u, ""),
    ),
);

// --- 3. No positive 便单 wording; explicit prohibition is allowed ----------
const texts = {
  notify: read(join("files", "home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md")),
  source: read(
    join("files", "home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md"),
  ),
  payload,
};
for (const [label, text] of Object.entries(texts)) {
  check(
    `no positive 便单 line: ${label}`,
    positiveLines(text).length === 0,
    positiveLines(text).join(" | "),
  );
  for (const token of manifest.forbiddenPositive) {
    check(`forbidden positive token absent: ${label}: ${token}`, !has(text, token));
  }
}
check("explicit prohibition line is present", has(texts.notify, "便单已停用：不要登记到便单"));
check("source-triage does not mention 便单 at all", !has(texts.source, "便单"));
for (const entry of manifest.patches) {
  const newText = entry.replacements.map((r) => r.new).join("\n");
  for (const item of entry.replacements) {
    check(`patch old and new differ: ${entry.path}`, item.old !== item.new);
    check(
      `patch new line has no positive 便单: ${entry.path}`,
      positiveLines(item.new).length === 0,
    );
  }
  for (const anchor of entry.requiredAfter) {
    check(`patch new text carries required anchor: ${entry.path}: ${anchor}`, has(newText, anchor));
  }
}

// --- 4. Notification behavior stays Agenda-only and evidence-bound ---------
for (const [label, needle] of [
  ["frontmatter name", "name: collector-notify"],
  ["Agenda is the only todo destination", "Agenda 是 collector 记录待办的唯一去处"],
  ["actions must be real this run", "通知里的每个动作都必须是本轮真实完成的结果"],
  ["agenda receipt required for registration", "登记要有成功的 `agenda` 回执"],
  ["scheduling/reminder needs a written block", "排程或提醒要有实际写下的执行块"],
  ["nothing to claim means no claim", "没做到、失败或不确定就不写"],
  ["examples are not scripts", "示例只示范口吻和长度，不要照抄其中的动作"],
  ["ordinary example kept", "G12 Academic English 3 群 17:22 有新消息"],
  ["fault example kept", "钉钉消息抓取连续失败，原因是 DWS 认证失效"],
  ["unreadable mail still skipped", "正文确实读不到就跳过那封，不猜内容，也不提醒你自己去看邮箱"],
  [
    "DingTalk command unchanged",
    "node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>",
  ],
  ["private markdown single chat", "私人钉钉机器人 Markdown 单聊（非 AI 卡片），只发给用户自己"],
  ["failure path stays local", "不换通道重发、不凭记忆补发"],
  ["dedupe ownership stays elsewhere", "本 skill 不重复判断"],
]) {
  check(`notify: ${label}`, has(texts.notify, needle), needle);
}
for (const example of [
  "- 普通变化：",
  "- 需要行动：",
  "- 紧急事项：",
  "- 收集故障：",
  "- 邮件提醒：",
]) {
  check(`notify keeps example ${example}`, count(texts.notify, example) === 1);
}

// --- 5. Source triage and dispatcher route stay owned ----------------------
for (const [label, needle] of [
  ["Agenda registration route", "需要提醒、排程、登记 agenda 或跟进"],
  [
    "schedule-sweep stays the owner",
    "/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md",
  ],
  ["agenda rules are not copied", "agenda 字段、查重、去重、优先级只在那里"],
  ["notify skill is read before sending", "collector-notify/SKILL.md"],
  ["no-action stays silent", "无需行动：不通知、不登记"],
]) {
  check(`source-triage: ${label}`, has(texts.source, needle), needle);
}
for (const needle of manifest.cron.requiredAfter) {
  check(`payload keeps route: ${needle.slice(0, 24)}`, has(payload, needle));
}
for (const [label, needle] of [
  ["per-round read limit", "每类 skill 每轮只读一次"],
  ["no fixed patrol", "不额外巡检"],
  ["failed read stops the class", "读不到就停用该类处置"],
  ["fault boundary", "故障不动 agenda"],
]) {
  check(`payload: ${label}`, has(payload, needle), needle);
}

// --- 6. Deploy/rollback/status safety --------------------------------------
for (const name of ["lib.sh", "deploy.sh", "rollback.sh", "status.sh"]) {
  const syntax = spawnSync("bash", ["-n", join(root, "scripts", name)], { encoding: "utf8" });
  check(`${name} parses`, syntax.status === 0, syntax.stderr.trim());
}
check(
  "package hash is locked to the manifest",
  has(lib, "does not match the reviewed manifest hash"),
);
check(
  "payload hash is locked to the manifest",
  has(lib, "payload file does not match the reviewed manifest hash"),
);
check(
  "deploy backs up before writing",
  deploy.indexOf('backup_dir"') < deploy.indexOf('info "writing skill files"'),
);
check(
  "deploy verifies after writing",
  has(deploy, "verify_after") && has(deploy, "restore_previous"),
);
check(
  "deploy refuses drift by default",
  has(deploy, "--allow-drift") && has(deploy, "allow_drift"),
);
check(
  "deploy applies patches exactly once",
  has(deploy, "patch_apply") && has(lib, "patch anchor count"),
);
check(
  "deploy edits only payload.message",
  has(deploy, 'cron edit "$JOB_ID" --message') &&
    !has(deploy, "--trigger-script") &&
    !has(deploy, "--tools") &&
    !has(deploy, "--light-context") &&
    !has(deploy, "--every") &&
    !has(deploy, "--timeout-seconds"),
);
check(
  "rollback refuses post-deploy drift by default",
  has(rollback, "changed after deployment") && has(rollback, "--force"),
);
check(
  "status is read-only",
  !has(status, "cp ") && !has(status, "mv ") && !has(status, "rm ") && !has(status, "cron edit"),
);
for (const forbiddenCall of [
  "dingtalk-notify.mjs --title",
  "mail send",
  "curl ",
  "openclaw cron run",
  "cron run",
]) {
  check(
    `scripts never send or force-run: ${forbiddenCall}`,
    ![deploy, rollback, status, lib].some((s) => has(s, forbiddenCall)),
  );
}
check(
  "sim covers a package changed after review",
  has(deploySim, "unreviewed append") && has(deploySim, "no backup"),
);

// --- 7. README deliverable -------------------------------------------------
for (const [label, needle] of [
  ["why", "## 1. 为什么改"],
  ["surfaces", "## 2. 改动的五个面"],
  ["deploy", "## 4. 部署"],
  ["rollback", "## 5. 回滚"],
  ["verification", "## 6. 验证"],
  ["untouched surfaces", "## 7. 不改动的部分"],
  ["residual risk", "## 9. 残留风险"],
  ["privacy", "## 10. 隐私"],
]) {
  check(`README: ${label}`, has(readme, needle), needle);
}
check(
  "README states Agenda is the only destination",
  has(readme, "Agenda 是 collector 记录待办的唯一去处"),
);
check("README states notifications only claim completed actions", has(readme, "只写本轮真实动作"));

// --- 8. Privacy ------------------------------------------------------------
const secretPatterns = [
  [/[\w.+-]+@[\w-]+\.[\w.]+/u, "email address"],
  [/\b1[3-9]\d{9}\b/u, "mobile number"],
  [/\b(?:sk|ak|ghp|github_pat)-[A-Za-z0-9_-]{10,}/u, "API token"],
  [/\bBearer\s+[A-Za-z0-9._-]{10,}/u, "bearer token"],
  [/staffId\s*[:=]/iu, "staff id"],
];
for (const [label, text] of Object.entries(texts)) {
  for (const [pattern, name] of secretPatterns) {
    check(`no ${name} in ${label}`, !pattern.test(text));
  }
}
check("no secrets in the manifest", !/Bearer |sk-|ghp_/u.test(JSON.stringify(manifest)));

if (failures.length > 0) {
  console.error(`FAIL ${failures.length} check(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`PASS ${passed} checks`);
