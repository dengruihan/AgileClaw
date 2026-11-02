#!/usr/bin/env node
// Static contract checks for the collector DingTalk detail-triage prompt.
//
// These checks protect the properties the mission is about:
//   - the prompt requires a read-only dws lookup before any DingTalk reminder
//   - self-replies / self-authored activity suppress the reminder
//   - a failed lookup never falls back to a "collection layer has no body" ping
//   - language, notification command, other sources and the fault flow survive
//   - the deploy/rollback scripts never touch the trigger script
//   - no real conversation ids, message ids or personal identifiers leak into
//     the deliverable
//
// Usage: node verify/check-prompt.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");
const prompt = read("payload-message.txt");
const deploy = read("scripts/deploy.sh");
const rollback = read("scripts/rollback.sh");
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
const has = (haystack, needle) => haystack.includes(needle);

// 1. Read-only lookups are mandatory and come before the reminder decision.
check("prompt requires self userId", has(prompt, "dws contact +me --format json"));
check(
  "prompt has self userId fallback",
  has(prompt, "dws contact user current --format json") &&
    has(prompt, ".result[0].orgEmployeeModel.userId"),
);
check(
  "prompt resolves the self senderId from userId",
  has(prompt, 'dws contact user search --query "<本人 userId>" --format json') &&
    has(prompt, "取 openDingTalkId 作为本人 senderId"),
);
check(
  "prompt reads conversation detail with dws",
  has(prompt, 'dws chat +chat-messages --group "<cid>" --limit 15 --format json'),
);
check(
  "prompt keeps the --sender mapping fallback",
  has(
    prompt,
    'dws chat +chat-messages --group "<cid>" --sender "<本人 userId>" --limit 1 --format json',
  ) && has(prompt, "resolvedFilters"),
);
check(
  "prompt warns the group sender filter can return no messages",
  has(prompt, "群聊按 sender 过滤可能返回空消息"),
);
check("prompt compares the stable sender field", has(prompt, "messages[0].senderId"));
check("prompt forbids name-based identity", has(prompt, "不比较展示名"));
check(
  "prompt reads unread state",
  has(prompt, "dws chat +chat-list --types group,p2p --page-size 100 --sort active_time"),
);
check("prompt uses unreadPoint", has(prompt, "unreadPoint"));
check("prompt has unread-chats cross-check", has(prompt, "dws chat +unread-chats --count 100"));
check("prompt treats read-but-unreplied as actionable", has(prompt, "已读不等于不用管"));

// 2. Self-authored newest activity suppresses the reminder.
check(
  "prompt skips self-authored conversations",
  has(prompt, "最后一条是本人发的（已回复或本人动态）→ 不提醒、不登记、不排程"),
);
check(
  "prompt explains the mapping fallback instead of inferring from empty results",
  has(prompt, "不能用返回条数判断本人是否发过言"),
);

// 3. Unreplied triage inputs.
for (const needle of ["是否 @ 我", "是否提问", "截止时间", "明确请求", "未读状态"]) {
  check(`prompt triage input: ${needle}`, has(prompt, needle));
}

// 4. Lookup failure must not degrade to a content-less reminder.
check("prompt retries a failed lookup once", has(prompt, "同一会话重试一次"));
check("prompt forbids the old no-body reminder", has(prompt, "不发「收集层无正文」这类提醒"));
check("prompt forbids guessing content", has(prompt, "不猜内容"));
check(
  "prompt never claims it cannot read DingTalk bodies",
  !has(prompt, "钉钉源只有会话列表变化（cid/name/lastMsgAt），两边都没有消息正文"),
);
check("prompt drops the old dynamics-only example", !has(prompt, "钉钉这边只能看到会话动态"));
check(
  "prompt drops the old mail+DingTalk capability boundary",
  !has(prompt, "不得声称读过或总结正文"),
);

// 5. Preserved behavior.
const preserved = [
  "体贴周到但不越界、条理清楚、简单易懂",
  "node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>",
  "失败会退出码 1 并打印灯效回退命令",
  "schedule-sweep skill 的既有规则登记/排程",
  "云谷课堂/课表与 One Schoolhouse：事项带完整条目，可直接阅读。",
  "邮件：只有收件箱净计数，没有正文，不得声称读过或总结邮件正文；需要时请用户打开邮箱查看。",
  "忽略 report.json 里 skipped 的条目。",
  "dws 认证失效需提示用户重新 dws auth login，不代登。",
  "失败退回灯效推送，每源每日一次",
  "不动 agenda 数据、不做排程、不动其他自动化",
];
for (const needle of preserved) check(`preserved: ${needle.slice(0, 24)}`, has(prompt, needle));

// 6. The prompt only uses read-only dws commands.
const mutating = [
  "+messages-send",
  "+send-",
  "+dm ",
  "+broadcast",
  "mark-read",
  "+messages-reply",
  "+flag-create",
  "+flag-cancel",
  "+chat-update",
];
for (const needle of mutating) check(`no mutating dws command: ${needle}`, !has(prompt, needle));

// 7. Deployment leaves the trigger script alone.
check("deploy never passes --trigger-script", !has(deploy, "--trigger-script"));
check("rollback never passes --trigger-script", !has(rollback, "--trigger-script"));
check(
  "deploy backs up the current message",
  has(deploy, "payload-message.before.txt") && has(deploy, "job.before.json"),
);
check("deploy supports a drift guard", has(deploy, "--allow-drift"));
check("deploy auto-restores on failed verification", has(deploy, "restore_previous"));
check(
  "rollback refuses unknown live state",
  has(rollback, "--force") && has(rollback, "not the one this deployment wrote"),
);
check(
  "baseline hashes are recorded",
  has(lib, "3422e6ed8a38d0e1169f508c16d951991ef9aaa6fd0d5436b0cea4d4845dd311") &&
    has(lib, "2fefcf25abc694c645c1e856ec85433f2b5bff25ce72d938e2be92b8f53e3a91"),
);

// 8. No real identifiers or message content in the deliverable.
const leakPatterns = [
  [/cid(?!\/name)[A-Za-z0-9+/=]{12,}/, "real conversation id"],
  [/msg[A-Za-z0-9+/=]{12,}/, "real message id"],
  [/3000000000017120883/, "personal userId"],
  [/1[3-9]\d{9}/, "phone number"],
];
const deliverables = {
  "payload-message.txt": prompt,
  "scripts/deploy.sh": deploy,
  "scripts/rollback.sh": rollback,
  "scripts/lib.sh": lib,
  "README.md": read("README.md"),
};
for (const [name, text] of Object.entries(deliverables)) {
  for (const [pattern, label] of leakPatterns) {
    check(`no ${label} in ${name}`, !pattern.test(text));
  }
}

// 9. The prompt stays a single deployment unit (no accidental truncation).
check("prompt starts with the wake line", prompt.startsWith("收集自动化唤醒。"));
check(
  "prompt ends with the fault-flow closing line",
  prompt.trimEnd().endsWith("写明阻塞点并保持现状。"),
);
check("prompt is not suspiciously short", prompt.length > 2500, `length=${prompt.length}`);

if (failures.length) {
  console.error(`FAIL ${failures.length}/${passed + failures.length}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`PASS ${passed}/${passed}`);
