#!/usr/bin/env node
// Static contract checks for the collector skill-dispatcher cutover.
//
// These checks protect the properties the mission is about:
//   - the payload is a short dispatcher that routes by wake reason and reads
//     skills by absolute path with the `read` tool (not $skill / skills_read)
//   - every currently live behavior survives in exactly one skill: DingTalk
//     triage, other-source triage, fault repair, notification language
//   - schedule-sweep stays the only owner of agenda registration rules
//   - skill discovery metadata is valid for the main agent
//   - deploy/rollback never touch trigger, schedule, tools or lightContext
//   - no real conversation ids, message ids or personal identifiers leak into
//     the deliverable
//
// Usage: node verify/check-package.mjs
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(join(root, relative), "utf8");
const exists = (relative) => existsSync(join(root, relative));

const SKILL_DIR = "files/home/raymond/.openclaw/workspace/skills";
const SKILLS = {
  dingtalk: `${SKILL_DIR}/collector-dingtalk-triage/SKILL.md`,
  source: `${SKILL_DIR}/collector-source-triage/SKILL.md`,
  repair: `${SKILL_DIR}/collector-health-repair/SKILL.md`,
  notify: `${SKILL_DIR}/collector-notify/SKILL.md`,
};
const TARGETS = {
  dingtalk: "/home/raymond/.openclaw/workspace/skills/collector-dingtalk-triage/SKILL.md",
  source: "/home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md",
  repair: "/home/raymond/.openclaw/workspace/skills/collector-health-repair/SKILL.md",
  notify: "/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md",
};
const SCHEDULE_SWEEP =
  "/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md";

const payload = read("payload-message.txt").replace(/\n$/u, "");
const texts = Object.fromEntries(Object.entries(SKILLS).map(([key, path]) => [key, read(path)]));
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

// --- 1. Dispatcher payload ---------------------------------------------------
check(
  "payload stays short",
  payload.length >= 300 && payload.length <= 900,
  `${payload.length} chars`,
);
check("payload routes only by the wake reason", has(payload, "只处置唤醒消息末尾点明的原因"));
check("payload requires the read tool", has(payload, "用 read 工具读对应 skill 的绝对路径"));
check(
  "payload stops the class on a failed skill read",
  has(payload, "读不到就停用该类处置") && has(payload, "不凭记忆操作"),
);
check("payload keeps silence for no action", has(payload, "无需行动就静默结束，不发消息"));
for (const [key, target] of Object.entries(TARGETS)) {
  check(`payload route ${key}`, has(payload, target), target);
}
check("payload routes scheduling to schedule-sweep", has(payload, SCHEDULE_SWEEP));
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
check("payload reads skills once per class", has(payload, "每类 skill 每轮只读一次"));

// --- 2. Skill files and frontmatter -----------------------------------------
const found = readdirSync(join(root, SKILL_DIR)).sort();
check(
  "exactly four package skills",
  JSON.stringify(found) ===
    JSON.stringify(
      Object.keys(SKILLS)
        .map((k) => SKILLS[k].split("/")[6])
        .sort(),
    ),
  found.join(","),
);
for (const [key, path] of Object.entries(SKILLS)) {
  check(`skill ${key} exists`, exists(path));
  const body = texts[key];
  const dirName = path.split("/")[6];
  const front = /^---\nname: ([^\n]+)\ndescription: "([^"\n]+)"\n---\n/u.exec(body);
  check(`skill ${key} frontmatter`, front !== null);
  if (front) {
    check(`skill ${key} name matches directory`, front[1] === dirName, front[1]);
    check(`skill ${key} description is short`, front[2].length <= 90, `${front[2].length} chars`);
  }
  check(`skill ${key} has no platform gate`, !/^platforms:/mu.test(body));
  check(`skill ${key} stays small`, body.length <= 6000, `${body.length} chars`);
  check(`skill ${key} does not disable model invocation`, !has(body, "disable-model-invocation"));
}

// --- 3. DingTalk triage behavior (live payload steps 1-8) -------------------
const dingtalk = texts.dingtalk;
for (const [label, needle] of [
  ["self userId", "dws contact +me --format json"],
  ["self userId fallback", "dws contact user current --format json"],
  ["self userId fallback field", ".result[0].orgEmployeeModel.userId"],
  ["userId to senderId map", 'dws contact user search --query "<本人 userId>" --format json'],
  ["senderId is openDingTalkId", "取 `openDingTalkId` 作为本人 senderId"],
  ["stable identity only", "不比较展示名"],
  ["conversation detail", 'dws chat +chat-messages --group "<cid>" --limit 15 --format json'],
  ["cid quoting", "cid 原样加双引号"],
  [
    "sender mapping fallback",
    'dws chat +chat-messages --group "<cid>" --sender "<本人 userId>" --limit 1 --format json',
  ],
  ["resolvedFilters fallback", ".resolvedFilters.senders[]"],
  ["empty group filter is not proof", "群聊按 sender 过滤可能返回空消息"],
  ["empty result is not proof", "不能用返回条数判断本人是否发过言"],
  ["compares messages[0].senderId", "`messages[0].senderId`"],
  ["self reply skips", "最后一条是本人发的（已回复或本人动态）→ 不提醒、不登记、不排程"],
  [
    "unread list",
    "dws chat +chat-list --types group,p2p --page-size 100 --sort active_time --format json",
  ],
  ["unreadPoint", "`unreadPoint`"],
  ["unread cross-check", "dws chat +unread-chats --count 100 --format json"],
  ["read is still triaged", "已读不等于不用管"],
  ["mention input", "是否 @ 我"],
  ["question input", "是否提问"],
  ["deadline input", "截止时间"],
  ["request input", "明确请求"],
  ["unread is an input", "未读状态"],
  ["summarize the message, not the boundary", "提醒可以准确概括钉钉消息"],
  ["no dynamics-only phrasing", "不要再写「只能看到会话动态」"],
  ["only the gist", "只提炼要点，不复述大段原文，不展开隐私细节"],
  ["one retry", "同一会话重试一次"],
  ["no bodyless reminder", "不发「收集层无正文」这类提醒"],
  ["no guessing", "不猜内容"],
  ["auth error codes", "DWS_AUTH"],
  ["auth error wording", "auth/token/401/403"],
  ["user logs in", "dws auth login"],
  ["never logs in for the user", "不代登"],
  ["bound: 10 conversations", "最多补查 10 个"],
  ["excess conversations skipped", "本轮超出上限的会话完全跳过"],
  ["unread alone is not an action basis", "不能只凭未读状态行动"],
  ["unread is only an input", "未读只是补查后的判断输入，不是提醒依据"],
  ["prefer a miss over a wrong reminder", "宁可本轮漏报，也不做无正文误报"],
  ["schedule-sweep route", SCHEDULE_SWEEP],
  ["notify route", TARGETS.notify],
]) {
  check(`dingtalk: ${label}`, has(dingtalk, needle), needle);
}

// --- 4. Other-source triage behavior --------------------------------------
const source = texts.source;
for (const [label, needle] of [
  ["mail has no body", "只有收件箱净计数，没有正文，不得声称读过或总结邮件正文"],
  ["mail asks the user to open it", "需要时请用户打开邮箱查看"],
  ["Yungu/OSH entries are readable", "云谷课堂/课表与 One Schoolhouse：事项带完整条目，可直接阅读"],
  ["skipped entries ignored", "忽略 report.json 里 skipped 的条目"],
  ["no action is silent", "无需行动：不通知、不登记，直接结束本轮"],
  ["schedule-sweep route", SCHEDULE_SWEEP],
  ["schedule-sweep owns agenda rules", "agenda 字段、查重、去重、优先级只在那里"],
  ["notify route", TARGETS.notify],
]) {
  check(`source: ${label}`, has(source, needle), needle);
}

// --- 5. Fault repair behavior ---------------------------------------------
const repair = texts.repair;
for (const [label, needle] of [
  ["collection README", "读 `/home/raymond/.openclaw/workspace/collection/README.md`"],
  ["health state", "`state/health.json`"],
  ["login self-heal", "node /home/raymond/.openclaw/workspace/collection/collect.mjs <源> --force"],
  ["dws login stays with the user", "dws 认证失效需提示用户重新 `dws auth login`，不代登"],
  ["streak verification", "修复后重跑验证 streak 归零"],
  [
    "same notify command",
    "node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <修复结果>",
  ],
  ["fallback and per-source daily limit", "失败退回灯效推送，每源每日一次"],
  ["fault boundary", "不动 agenda 数据、不做排程、不动其他自动化；无法修复时写明阻塞点并保持现状"],
  ["notify route", TARGETS.notify],
]) {
  check(`repair: ${label}`, has(repair, needle), needle);
}

// --- 6. Notification language and channel ---------------------------------
const notify = texts.notify;
for (const [label, needle] of [
  ["no role imitation", "不自称或模仿任何影视角色"],
  ["1-3 sentences", "每条通知通常 1–3 句"],
  ["urgent first sentence is the action", "紧急事项第一句先说该做什么"],
  ["humor boundaries", "幽默不拿人、不拿失误、不拿紧急事项开玩笑"],
  ["fault notifications stay factual", "故障通知只陈述事实和下一步"],
  ["example: ordinary change", "G12 Academic English 3 群 17:22 有新消息"],
  [
    "example: action needed",
    "云谷课堂新布置了英语阅读练习，周三 23:00 截止。已登记便单并排到今晚主块",
  ],
  ["example: urgent", "请先完成物理作业，今晚 23:00 截止，目前还未提交；我已把它排到待办最前。"],
  [
    "example: fault",
    "钉钉消息抓取连续失败，原因是 DWS 认证失效。需要你在终端跑一次 dws auth login，我不能代登",
  ],
  ["example: unreadable content", "邮箱净增 2 封。邮件正文不在收集范围，需要的话打开邮箱查看"],
  [
    "dingtalk notify command",
    "node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>",
  ],
  ["private markdown single chat", "私人钉钉机器人 Markdown 单聊（非 AI 卡片），只发给用户自己"],
  ["failure exit code", "退出码 1 并打印灯效回退命令"],
  [
    "light fallback command",
    "node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <标题> --reason <30字内原因>",
  ],
  ["per-source daily dedupe stays owned elsewhere", "每源每日一次"],
  ["lightContext self-containment", "collector 唤醒轮读不到 SOUL.md（lightContext）"],
]) {
  check(`notify: ${label}`, has(notify, needle), needle);
}

// Every example line from the live baseline must be preserved byte-for-byte.
const baselinePath = join(root, "../collector-dingtalk-detail-triage/payload-message.txt");
if (existsSync(baselinePath)) {
  const baseline = readFileSync(baselinePath, "utf8");
  const language = baseline.slice(
    baseline.indexOf("【通知语言】"),
    baseline.indexOf("\n\n一、事项变化"),
  );
  const examples = language
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2));
  check("baseline exposes five notification examples", examples.length === 5, `${examples.length}`);
  for (const example of examples) {
    check("notify keeps a baseline example verbatim", has(notify, example), example.slice(0, 24));
  }
} else {
  failures.push("baseline payload not found for example comparison");
}

// --- 7. schedule-sweep stays the single owner ------------------------------
for (const key of ["dingtalk", "source"]) {
  check(`skill ${key} points at schedule-sweep`, has(texts[key], SCHEDULE_SWEEP));
}
check("repair does not schedule", !has(texts.repair, "schedule-sweep"));
check(
  "notify delegates dedupe instead of scheduling",
  has(texts.notify, "属于发起通知的分诊/修障 skill 与 schedule-sweep 的职责") &&
    !has(texts.notify, "agenda 工具"),
);
for (const token of [
  "important_urgent",
  "expectedRevision",
  "operationId",
  "unlockBlockIds",
  "22:00",
]) {
  for (const [key, body] of Object.entries(texts)) {
    check(`skill ${key} does not copy schedule-sweep rule ${token}`, !has(body, token));
  }
}
check("schedule-sweep live file exists on this host", existsSync(SCHEDULE_SWEEP));

// --- 8. No new features / old boundaries stay out -------------------------
const everything = [payload, ...Object.values(texts)].join("\n");
for (const banned of [
  "imap",
  "邮件正文抓取",
  "固定巡检",
  "cron create",
  "钉钉这边只能看到会话动态",
  "收集层无正文，未读内容",
]) {
  check(`no new feature or retired phrasing: ${banned}`, !has(everything, banned));
}

// --- 9. Privacy and credential hygiene ------------------------------------
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
check(
  "no 15+ digit identifier",
  !/\d{15,}/u.test(everything.replace(/--page-size 100|--count 100|--limit 15/gu, "")),
);
check("no phone-like number", !/(?<!\d)1[3-9]\d{9}(?!\d)/u.test(everything));
check("no dingtalk target id", !/user:\d+/u.test(everything));
check(
  "no token or password assignment",
  !/(token|password|secret)\s*[:=]\s*["'][^"']+["']/iu.test(everything),
);

// --- 10. Deploy and rollback safety ---------------------------------------
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
check("deploy edits payload.message", /cron edit "\$JOB_ID" --message/u.test(deploy));
check("rollback edits payload.message", /cron edit "\$JOB_ID" --message/u.test(rollback));
check(
  "deploy never writes schedule-sweep",
  !/cp[^\n]*SCHEDULE_SWEEP/u.test(deploy) && !/>[^\n]*SCHEDULE_SWEEP/u.test(deploy),
);
check(
  "deploy verifies untouched fields",
  has(deploy, "an untouched job field changed unexpectedly"),
);
check("deploy verifies lightContext", has(lib, "lightContext"));
check("deploy verifies discovery", has(deploy, "verify_skill_discovery"));
check(
  "deploy has a drift guard",
  has(deploy, "allow_drift") && has(deploy, "BASELINE_MESSAGE_SHA256"),
);
check(
  "deploy backs up before writing",
  deploy.indexOf("job.before.json") < deploy.indexOf("writing skill files"),
);
check("deploy restores on failure", has(deploy, "restore_previous"));
check("rollback protects post-deploy edits", has(rollback, "changed after deploy"));
check(
  "status is read-only",
  !has(status, "cron edit") && !/\brm\b/u.test(status) && !/\bcp\b/u.test(status),
);
check("lib owns the four skill names", (lib.match(/collector-[a-z-]+/gu) ?? []).length >= 4);
check(
  "lib records the authoring baseline",
  has(lib, "fa8537795b3b7bcda4b1feb2dcf7b9a5edbb24ed80401c295a7812e11e7ca25c"),
);
check(
  "rollback is offered in the README",
  has(readme, "rollback.sh --yes") && has(readme, "deploy.sh --yes") && has(readme, "status.sh"),
);
check("README records the verification commands", has(readme, "verify/check-package.mjs"));
check("README states live was not modified", /未修改 live|live 未修改|未部署/u.test(readme));

// --- Report -----------------------------------------------------------------
if (failures.length > 0) {
  console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS ${passed} checks`);
