#!/usr/bin/env node
import { createHash } from "node:crypto";
// Static contract checks for the collector mail-triage cutover (M12).
//
// These checks protect the properties the mission is about:
//   - the collector script still only syncs and counts: this package ships no
//     collection adapter, trigger or report change, and no real mail content
//   - mail wakes route to collector-mail-triage; collector-source-triage no
//     longer owns mail, and the other wake routes are unchanged
//   - collector-mail-triage reads the local notmuch index read-only, with
//     bounded candidate count and body size, no attachments, no tag/new,
//     no marking read and no replies
//   - watermarks store timestamps only
//   - schedule-sweep stays the only owner of agenda rules and collector-notify
//     stays the only owner of notification wording (M11 owns its fallback)
//   - deploy/rollback only edit payload.message and the two mail skills, and
//     preserve a parallel M11 toolsAllow/lightContext change
//   - no real mail content, addresses, message ids or credentials leak into
//     the deliverable
//
// Usage: node verify/check-package.mjs
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const exists = (relativePath) => existsSync(join(root, relativePath));

const SKILL_DIR = "files/home/raymond/.openclaw/workspace/skills";
const MAIL_SKILL = `${SKILL_DIR}/collector-mail-triage/SKILL.md`;
const SOURCE_SKILL = `${SKILL_DIR}/collector-source-triage/SKILL.md`;
const MAIL_TARGET = "/home/raymond/.openclaw/workspace/skills/collector-mail-triage/SKILL.md";
const SOURCE_TARGET = "/home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md";
const DINGTALK_TARGET =
  "/home/raymond/.openclaw/workspace/skills/collector-dingtalk-triage/SKILL.md";
const REPAIR_TARGET = "/home/raymond/.openclaw/workspace/skills/collector-health-repair/SKILL.md";
const NOTIFY_TARGET = "/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md";
const SCHEDULE_SWEEP =
  "/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md";
const WATERMARK = "/home/raymond/.openclaw/workspace/collection/state/mail-triage.json";

const payload = read("payload-message.txt").replace(/\n$/u, "");
const mail = read(MAIL_SKILL);
const source = read(SOURCE_SKILL);
const readme = read("README.md");
const deploy = read("scripts/deploy.sh");
const rollback = read("scripts/rollback.sh");
const status = read("scripts/status.sh");
const lib = read("scripts/lib.sh");
const isolated = read("verify/notmuch-isolated.sh");
const liveProbe = read("verify/live-readonly-probe.sh");
const deploySim = read("verify/deploy-sim.sh");

const m10Dir = join(root, "..", "collector-skill-dispatcher");
const m10Payload = readFileSync(join(m10Dir, "payload-message.txt"), "utf8").replace(/\n$/u, "");
const m10Source = readFileSync(
  join(m10Dir, MAIL_SKILL.replace("collector-mail-triage", "collector-source-triage")),
  "utf8",
);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

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

// --- 1. Dispatcher payload ---------------------------------------------------
check(
  "payload stays a short dispatcher",
  payload.length >= 700 && payload.length <= 900,
  `${payload.length} chars`,
);
check("payload routes only by the wake reason", has(payload, "只处置唤醒消息末尾点明的原因"));
check("payload requires the read tool", has(payload, "用 read 工具读对应 skill 的绝对路径"));
check(
  "payload stops the class on a failed read",
  has(payload, "读不到就停用该类处置") && has(payload, "不凭记忆操作"),
);
check("payload keeps silence for no action", has(payload, "无需行动就静默结束，不发消息"));
check(
  "payload routes mail to collector-mail-triage",
  has(payload, `- 邮件计数变化 → ${MAIL_TARGET}`),
  MAIL_TARGET,
);
check(
  "payload routes non-mail sources to collector-source-triage",
  has(payload, `- 云谷课堂/课表、One Schoolhouse 变化 → ${SOURCE_TARGET}`),
  SOURCE_TARGET,
);
check("payload keeps the DingTalk route", has(payload, DINGTALK_TARGET));
check("payload keeps the repair route", has(payload, REPAIR_TARGET));
check("payload keeps the scheduling route", has(payload, SCHEDULE_SWEEP));
check("payload keeps the notify route", has(payload, NOTIFY_TARGET));
check(
  "payload does not send mail to source-triage",
  !/- 邮件[^\n]*collector-source-triage/u.test(payload),
);
for (const boundary of [
  "本人已回复不提醒",
  "补查失败不发无正文提醒",
  "每轮补查上限",
  "故障不动 agenda",
]) {
  check(`payload names boundary ${boundary}`, has(payload, boundary));
}
check("payload does not rely on $skill", !/\$[a-z][a-z0-9-]+/u.test(payload));
check("payload does not rely on skills_read/skills_search", !/skills_(read|search)/u.test(payload));
check(
  "payload does not add a fixed patrol",
  !has(payload, "固定巡检") && !has(payload, "定时巡检"),
);

// --- 2. Skill files and frontmatter -----------------------------------------
for (const [path, key] of [
  [MAIL_SKILL, "mail"],
  [SOURCE_SKILL, "source"],
]) {
  check(`skill ${key} exists`, exists(path));
  const body = read(path);
  const dirName = path.split("/")[6];
  const front = /^---\nname: ([^\n]+)\ndescription: "([^"\n]+)"\n---\n/u.exec(body);
  check(`skill ${key} frontmatter`, front !== null);
  if (front) {
    check(`skill ${key} name matches directory`, front[1] === dirName, front[1]);
    check(`skill ${key} description is short`, front[2].length <= 90, `${front[2].length} chars`);
  }
  check(`skill ${key} stays small`, body.length <= 6000, `${body.length} chars`);
  check(`skill ${key} has no platform gate`, !/^platforms:/mu.test(body));
  check(`skill ${key} does not disable model invocation`, !has(body, "disable-model-invocation"));
}

const skillNames = readdirSync(join(root, SKILL_DIR)).sort();
check(
  "exactly two skills in the package",
  JSON.stringify(skillNames) ===
    JSON.stringify(["collector-mail-triage", "collector-source-triage"]),
  skillNames.join(","),
);

// --- 3. Mail triage behavior ------------------------------------------------
for (const [label, needle] of [
  ["collection only syncs and counts", "收集层只同步并给出收件箱净计数"],
  ["no content in report or snapshots", "发件人/主题/正文都不进 report.json 或收集快照"],
  ["not a capability boundary", "这是常规步骤，不是能力边界"],
  ["count alone is not an action basis", "不能单独作为提醒理由"],
  ["watermark path", WATERMARK],
  ["watermark read command", "cat \"$W\" 2>/dev/null || echo '{}'"],
  [
    "candidate search command",
    'notmuch search --format=json --sort=newest-first --limit=10 "folder:$acct/INBOX"',
  ],
  ["candidate watermark filter", "select(.timestamp > $s)"],
  ["candidate rows carry sender/subject", "[$a, .timestamp, .query[0], .authors, .subject]"],
  ["two mail accounts", "for acct in yungu qq; do"],
  ["per-account bound", "每账号最多 10 条"],
  ["round candidate bound", "取前 8 封为本轮候选"],
  ["excess candidates skipped", "更旧的候选本轮完全跳过"],
  ["no guessing from counts", "也不凭计数猜内容"],
  [
    "late-delivery fallback",
    "若某个账号净新增 > 0 却没有候选，放宽到该账号最新 3 封（忽略水位）重新定位",
  ],
  ["fallback failure skipped", "仍无可读条目就跳过该账号本轮，不猜"],
  [
    "body read command",
    "notmuch show --format=text --body=true --include-html=true --entire-thread=false",
  ],
  ["body size bound", "head -c 4000"],
  ["body size wording", "正文最多 4000 字节"],
  ["read only needed bodies", "其余需要确认时才读正文，每封一次"],
  ["skip bodies for obvious marketing", "明显营销、群发、自动通知"],
  ["no attachment reads", "不按 part 取附件、不转存、不打开附件文件"],
  ["no sync/tag mutations", "不运行 mbsync/notmuch new/notmuch tag"],
  ["no marking read or movement", "不标记已读、不移动邮件"],
  ["no replies", "不回信、不对外发送"],
  ["marketing is silent", "营销、通知、自动回执 → 无需行动，静默结束"],
  ["action signals", "截止日期、缴费/注册、学校或老师要求回复、面试/预约、账号安全、需要本人决策"],
  ["context-aware judgement", "结合现有上下文（agenda、当日安排）判断"],
  ["uncertain stays silent", "拿不准是否需行动、且没有明确截止或请求 → 静默"],
  ["no bodyless reminder", "不发「收集层无正文」「请自己打开邮箱查看」这类提醒"],
  ["notify example override", "collector-notify 里的邮件无法读取示例不适用于本轮"],
  [
    "watermark is timestamp only",
    "水位文件只写 unix 时间戳，不写发件人、主题、正文、邮件 id、链接或凭据",
  ],
  ["watermark monotonic", "只增不减"],
  [
    "query failure keeps watermark",
    "查询整体失败（notmuch 报错/超时/不可用）时不要更新对应账号水位，下轮重试",
  ],
  ["single message failure skipped", "单封读取失败跳过该封，其余照常"],
  [
    "watermark write failure is reported",
    "水位写入失败不影响本轮判断，在结果里说明下轮可能重复读取",
  ],
  ["retry once", "重试一次"],
  ["no bodyless reminder on failure", "不发无正文提醒，不猜内容"],
  ["round cap wording", "每轮最多 8 封候选、每封正文 4000 字节"],
  ["prefer a miss over a wrong reminder", "宁可本轮漏报，也不做无正文误报"],
  ["net change semantics", "计数是净变化（新增减删除）"],
  ["does not run collection", "不运行收集命令"],
  ["does not change the trigger", "不改 trigger/schedule"],
  ["schedule-sweep route", SCHEDULE_SWEEP],
  ["schedule-sweep owns agenda rules", "agenda 字段、查重、去重、优先级只在那里，本 skill 不复制"],
  ["notify route", NOTIFY_TARGET],
]) {
  check(`mail: ${label}`, has(mail, needle), needle);
}

// Read-only constraints: no mutating notmuch/mail commands anywhere in the skill.
check("mail skill never tags messages", !/notmuch\s+tag\s+[+-]/u.test(mail));
check("mail skill never inserts messages", !/notmuch\s+insert/u.test(mail));
check("mail skill never removes tags", !/--remove-all/u.test(mail));
check("mail skill never fetches attachments by part", !has(mail, "--part"));
check("mail skill never syncs mail", !/\bmbsync\s+[a-z]/u.test(mail));
check("mail skill never sends mail", !/(sendmail|smtp|mailto:)/iu.test(mail));
check("mail skill never tells the user to open the mailbox", !has(mail, "请用户打开邮箱"));
check(
  "mail skill does not copy schedule-sweep tokens",
  !/important_urgent|expectedRevision|operationId|unlockBlockIds/u.test(mail),
);
check("mail skill never writes content to collector state", !/report\.json[^\n]*写/u.test(mail));

// --- 4. Source triage no longer owns mail ----------------------------------
check("source skill has no mail responsibility", !/邮件|邮箱|mail/iu.test(source));
for (const [label, needle] of [
  ["Yungu/OSH scope", "云谷课堂/课表、One Schoolhouse"],
  ["entries are readable", "事项带完整条目，可直接阅读"],
  ["skipped entries ignored", "忽略 report.json 里 skipped 的条目"],
  ["no action is silent", "无需行动：不通知、不登记，直接结束本轮"],
  ["schedule-sweep route", SCHEDULE_SWEEP],
  ["schedule-sweep owns agenda rules", "agenda 字段、查重、去重、优先级只在那里，本 skill 不重复"],
  ["notify route", NOTIFY_TARGET],
]) {
  check(`source: ${label}`, has(source, needle), needle);
}
// Everything from the M10 source skill except its mail bullet must survive.
const m10SourceLines = m10Source
  .split("\n")
  .filter((line) => line.trim() && !line.includes("邮件"))
  .map((line) => line.trim());
for (const line of m10SourceLines) {
  if (line.startsWith("description:") || line.startsWith("name:")) continue;
  check("source keeps the M10 behavior line", has(source, line), line.slice(0, 30));
}

// --- 5. Collection script / trigger stay untouched -------------------------
const packageFiles = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full);
    else packageFiles.push(relative(root, full));
  }
}
walk(root);
for (const banned of ["collect.mjs", "trigger-collector.mjs", "mail.mjs", "collector-cron"]) {
  check(
    `package ships no collection script: ${banned}`,
    !packageFiles.some((f) => f.endsWith(banned)),
  );
}
check(
  "package ships no collection workspace tree",
  !exists("files/home/raymond/.openclaw/workspace/collection"),
);
check(
  "deploy does not mention the collection adapter",
  !/collect\.mjs|trigger-collector|mail\.mjs/u.test(deploy),
);
check(
  "rollback does not mention the collection adapter",
  !/collect\.mjs|trigger-collector|mail\.mjs/u.test(rollback),
);

// --- 6. Deploy and rollback safety ----------------------------------------
for (const forbidden of [
  "--trigger-script",
  "--tools ",
  "--light-context",
  "--every",
  "--description",
  "--timeout-seconds",
  "--session-target",
  "--delivery",
  "--enabled",
]) {
  check(`deploy does not change ${forbidden.trim()}`, !has(deploy, forbidden));
  check(`rollback does not change ${forbidden.trim()}`, !has(rollback, forbidden));
}
check("deploy edits only payload.message", /cron edit "\$JOB_ID" --message/u.test(deploy));
check("rollback edits only payload.message", /cron edit "\$JOB_ID" --message/u.test(rollback));
check(
  "deploy names exactly the two mail skills",
  has(lib, "SKILL_NAMES=(collector-mail-triage collector-source-triage)"),
);
check(
  "lib records the M10 message baseline",
  has(lib, `BASELINE_MESSAGE_SHA256="${sha256(m10Payload)}"`),
);
check(
  "lib records the M10 source-triage baseline",
  has(lib, `BASELINE_SKILL_SHA256_collector_source_triage="${sha256(m10Source)}"`),
);
check(
  "lib records the mail skill as absent before deploy",
  has(lib, 'BASELINE_SKILL_SHA256_collector_mail_triage="missing"'),
);
check("lib snapshots toolsAllow", has(lib, "toolsAllow: j.payload?.toolsAllow ?? null"));
check("lib snapshots lightContext", has(lib, "lightContext: j.payload?.lightContext ?? null"));
check("lib snapshots the trigger hash", has(lib, "triggerSha256"));
check(
  "deploy verifies untouched fields",
  has(deploy, "an untouched job field changed unexpectedly"),
);
check(
  "deploy reports toolsAllow untouched",
  has(
    deploy,
    "toolsAllow: $(printf '%s' \"$current_facts\" | json_field toolsAllow) (left untouched)",
  ),
);
check(
  "deploy has a drift guard",
  has(deploy, "allow_drift") && has(deploy, "BASELINE_MESSAGE_SHA256"),
);
check(
  "deploy backs up before writing",
  deploy.indexOf("job.before.json") < deploy.indexOf("writing skill files"),
);
check("deploy restores on failure", has(deploy, "restore_previous"));
check("deploy verifies skill discovery", has(deploy, "verify_skill_discovery"));
check(
  "deploy never writes collector-notify",
  !/cp[^\n]*collector-notify/u.test(deploy) && !/>[^\n]*collector-notify\.md/u.test(deploy),
);
check(
  "deploy never writes schedule-sweep",
  !/cp[^\n]*SCHEDULE_SWEEP/u.test(deploy) && !/>[^\n]*SCHEDULE_SWEEP/u.test(deploy),
);
check("rollback protects post-deploy edits", has(rollback, "changed after deploy"));
check(
  "rollback restores source-triage from the backup",
  has(rollback, 'cp "$backup_dir/skills/$name/SKILL.md"'),
);
check(
  "status is read-only",
  !has(status, "cron edit") && !/\brm\b/u.test(status) && !/\bcp\b/u.test(status),
);

// --- 7. Verification scripts keep their promises --------------------------
check(
  "isolated check never uses the live database",
  has(isolated, 'NOTMUCH_CONFIG="$tmp/notmuch-config"'),
);
check(
  "isolated check asserts no tag change",
  has(isolated, "reading bodies leaves tags unchanged"),
);
check(
  "isolated check asserts no attachment bytes",
  has(isolated, "body read does not include attachment bytes"),
);
check(
  "isolated check asserts the 4000-byte cap",
  has(isolated, "body read is capped at 4000 bytes"),
);
check(
  "isolated check asserts the 10-message cap",
  has(isolated, "per-account query is limited to 10"),
);
check(
  "isolated check asserts timestamp-only watermark",
  has(isolated, "watermark only has account keys and updatedAt"),
);
check("live probe is read-only", !/notmuch\s+(tag|new|insert)/u.test(liveProbe));
check("live probe prints no message ids", !/printf[^\n]*\$q/u.test(liveProbe));
check("live probe asserts no tag change", has(liveProbe, "leaves tags and message ids unchanged"));
check(
  "simulator covers the M11 toolsAllow change",
  has(deploySim, "M11 parallel change") &&
    has(deploySim, "preserves M11 toolsAllow/lightContext changes"),
);
check(
  "simulator covers source-triage rollback",
  has(deploySim, "rollback restores the pre-deploy source-triage"),
);
check(
  "simulator leaves collector-notify untouched",
  has(deploySim, "deploy leaves collector-notify untouched"),
);

// --- 8. README completeness ------------------------------------------------
for (const [label, needle] of [
  ["deploy command", "./scripts/deploy.sh --yes"],
  ["rollback command", "./scripts/rollback.sh --yes"],
  ["status command", "./scripts/status.sh"],
  ["static verification", "verify/check-package.mjs"],
  ["isolated notmuch verification", "verify/notmuch-isolated.sh"],
  ["live read-only verification", "verify/live-readonly-probe.sh"],
  ["deploy simulation", "verify/deploy-sim.sh"],
  ["skill discovery", "verify/discover-skills.sh"],
  ["natural observation after deploy", "部署后自然观察"],
  ["M11 coordination", "M11"],
  ["M10 baseline", "M10"],
  ["live untouched by authoring", "本包未修改 live"],
]) {
  check(`README: ${label}`, has(readme, needle), needle);
}

// --- 9. Privacy and credential hygiene ------------------------------------
const textFiles = packageFiles.filter(
  (f) => /\.(md|mjs|sh|txt)$/u.test(f) && !f.endsWith("check-package.mjs"),
);
const everything = textFiles.map((f) => read(f)).join("\n");
const emails = everything.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu) ?? [];
for (const email of emails) {
  check(`only reserved .invalid test addresses: ${email}`, email.endsWith(".invalid"), email);
}
for (const secret of [
  "李婕",
  "李林平",
  "Jason Lee",
  "3000000000017120883",
  "DYmM",
  "openConversationId",
]) {
  check(`no real identifier: ${secret}`, !has(everything, secret));
}
check("no real account domain", !has(everything, "yungu.org") && !has(everything, "qq.com"));
check("no phone-like number", !/(?<!\d)1[3-9]\d{9}(?!\d)/u.test(everything));
check("no 15+ digit identifier", !/\d{15,}/u.test(everything));
check(
  "no token or password assignment",
  !/(token|password|secret)\s*[:=]\s*["'][^"']+["']/iu.test(everything),
);

// --- Report ----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS ${passed} checks`);
