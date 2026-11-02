#!/usr/bin/env node
// verify.mjs — collector payload 语言表达改版的 L4 静态自检。
// 基准：baseline-message.txt（2026-11-02 从线上 `openclaw cron get 6a45be21-ce0b-4b8b-8986-4c885d1ea659`
// 捕获的 payload.message）。目标：payload-message.txt。
// 检查三类不变量：
//   A. 功能锚点——命令、规则、边界语句必须原样保留（防功能漂移）
//   B. 禁用措辞——用户可见表达不得出现内部/公文/身份词
//   C. 风格标记——新风格块与五类示例齐全
// 用法：node verify.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const next = readFileSync(join(dir, "payload-message.txt"), "utf8");
const base = readFileSync(join(dir, "baseline-message.txt"), "utf8");

const ANCHORS = [
  // 唤醒与总原则
  "收集自动化唤醒。先看唤醒消息里的唤醒原因，只处置本轮唤醒点明的内容。",
  // 事项变化处置规则
  "逐项判断是否值得行动（需要提醒、排程、登记便单或跟进）。",
  "无需行动：不通知、不登记，直接结束本轮。",
  "按 schedule-sweep skill 的既有规则登记/排程",
  "登记或排程前先查重，已有同条目便单/日程只更新、不重复创建",
  // 通知命令与出口（完整保留，含灯效回退）
  "node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>",
  "私人钉钉机器人 Markdown 单聊，非 AI 卡片",
  "node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <标题> --reason <30字内原因>",
  // 能力边界（不扩大）
  "邮件源只有收件箱净计数",
  "会话列表变化（cid/name/lastMsgAt）",
  "不得声称读过或总结正文",
  "忽略 report.json 里 skipped 的条目",
  // 故障修障流程
  "读 /home/raymond/.openclaw/workspace/collection/README.md 与 state/health.json 定位",
  "node /home/raymond/.openclaw/workspace/collection/collect.mjs <源> --force",
  "dws 认证失效需提示用户重新 dws auth login，不代登",
  "修复后重跑验证 streak 归零",
  "失败退回灯效推送，每源每日一次",
  "不动 agenda 数据、不做排程、不动其他自动化",
  "无法修复时写明阻塞点并保持现状",
];

// 基准里有、但为消除内部措辞而按批准改写过的行（人工核对过功能等价）
const REWRITTEN = [
  {
    from: "report.json 里对应来源存在 added/changed/removed delta",
    to: "report.json 里对应来源有新增、变化或移除的事项",
  },
  { from: "只发本人，失败会退出码 1", to: "只发给用户自己，失败会退出码 1" },
  { from: "需要正文时提示用户本人查看", to: "需要正文时请用户到对应应用查看原文" },
  { from: "两者都没有消息正文", to: "两边都没有消息正文" },
  { from: "优先走收集层登录自愈", to: "优先走登录自愈" },
  {
    from: "云谷课堂/课表与 One Schoolhouse 的 delta 带完整条目，可直接阅读",
    to: "云谷课堂/课表与 One Schoolhouse 的事项带完整条目，可直接阅读",
  },
];

const BANNED = ["收集层", "delta", "分诊", "本人", "未读内容", "贾维斯", "Jarvis", "jarvis"];

const STYLE_MARKERS = [
  "【通知语言】",
  "普通变化：",
  "需要行动：",
  "紧急事项：",
  "收集故障：",
  "无法读取内容：",
  "1–3 句",
  "紧急事项第一句先说该做什么",
  "不自称或模仿任何影视角色",
];

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error(`FAIL  ${msg}`);
};
const pass = (msg) => console.log(`ok    ${msg}`);

for (const a of ANCHORS) {
  if (!base.includes(a)) fail(`锚点不在基准中（锚点清单过期？）：${a.slice(0, 40)}…`);
  else if (!next.includes(a)) fail(`功能锚点丢失：${a.slice(0, 40)}…`);
  else pass(`锚点保留：${a.slice(0, 40)}…`);
}

for (const r of REWRITTEN) {
  if (base.includes(r.from) && next.includes(r.to))
    pass(`批准改写：「${r.from.slice(0, 30)}…」→「${r.to.slice(0, 30)}…」`);
  else fail(`批准改写不成立：${r.from.slice(0, 40)}…`);
}

for (const b of BANNED) {
  if (next.includes(b)) fail(`新文案含禁用措辞：${b}`);
  else pass(`禁用措辞缺席：${b}`);
}

for (const s of STYLE_MARKERS) {
  if (!next.includes(s)) fail(`风格标记缺失：${s}`);
  else pass(`风格标记存在：${s}`);
}

// 示例审查：五类示例每条 1–3 句，且不含禁用措辞（已在上文全局检查），此处核对引号成对。
const examples = next
  .split("\n")
  .filter((l) => /^- (普通变化|需要行动|紧急事项|收集故障|无法读取内容)：「/.test(l));
if (examples.length === 5) pass("五类示例齐全");
else fail(`示例条数不对：${examples.length}`);
for (const e of examples) {
  const open = (e.match(/「/g) || []).length;
  const close = (e.match(/」/g) || []).length;
  if (open !== 1 || close !== 1) fail(`示例引号不成对：${e.slice(0, 40)}…`);
}
pass("示例引号核对完成");

if (failures) {
  console.error(`\n${failures} 项检查失败`);
  process.exit(1);
}
console.log("\n全部检查通过：功能锚点未漂移，能力边界未扩大，禁用措辞缺席，风格块齐全。");
