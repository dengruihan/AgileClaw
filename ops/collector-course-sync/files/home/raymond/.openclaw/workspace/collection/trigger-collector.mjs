// OpenClaw 自动化 `collector` 的触发脚本（看门狗 + 事项 delta 唤醒）。
// 每次评估跑一次收集器（占 1 次 exec 预算）；四种情况唤醒模型轮：
//   1) 任一来源存在事项 delta：任务类源（云谷课堂/课表、OSH、钉钉）+A ~C -R 非全零；
//      邮件源净新增 > 0（净减少视为已处理，不唤醒）；
//   2) 某源连续故障 ≥2 次（streak>=2），每源每天最多唤醒一次；
//   3) collect.mjs 自身连续异常 ≥2 次（输出行数不对/不可解析/无法执行）；
//   4) Agenda 有 pending/queued/running 的桌面完成反馈（sentinel 停用时由 replanner 唤起 collector）。
// delta 由快照 diff 产生，每轮成功抓取只出现一次，无需额外去重。
// 修改本文件后需 openclaw cron edit --trigger-script 同步进任务。
const COLLECT_CMD = "node /home/raymond/.openclaw/workspace/collection/collect.mjs all";
const AGENDA_SNAPSHOT_CMD =
  "curl -fsS --max-time 3 'http://127.0.0.1:18810/agenda/api/snapshot?includeCompleted=true'";
const EXPECTED_SOURCES = 5;
const FEEDBACK_STATUSES = new Set(["pending", "queued", "running"]);
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
const st = { collectFails: 0, alerted: {}, ...(trigger.state || {}) };

let lines = [];
try {
  const out = await exec({ command: COLLECT_CMD });
  lines = String(out?.aggregated ?? "")
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"));
} catch (e) {
  lines = [];
}

const parsed = [];
let parseOk = true;
for (const line of lines) {
  try {
    parsed.push(JSON.parse(line));
  } catch {
    parseOk = false;
  }
}

const failures = [];
const deltas = [];
if (lines.length !== EXPECTED_SOURCES || !parseOk || parsed.some((j) => j.source === undefined)) {
  st.collectFails += 1;
} else {
  st.collectFails = 0;
  for (const j of parsed) {
    if (j.ok === false) {
      if (j.skipped !== true && Number(j.streak) >= 2) failures.push(j);
      continue;
    }
    if (j.skipped === true || typeof j.changed !== "string") continue;
    const m = j.changed.match(/^\+(\d+) ~(\d+) -(\d+)$/);
    if (m) {
      if (Number(m[1]) + Number(m[2]) + Number(m[3]) > 0) deltas.push(`${j.label} ${j.changed}`);
      continue;
    }
    const mc = j.changed.match(/^yungu \+?(-?\d+) qq \+?(-?\d+)$/);
    if (mc && (Number(mc[1]) > 0 || Number(mc[2]) > 0)) {
      deltas.push(`${j.label} 净新增邮件（${j.changed}）`);
    }
  }
}

// Agenda 完成反馈：只读 snapshot，不写 Agenda；失败只记 state，不额外唤醒。
let agendaFeedback = [];
let agendaReadFailed = false;
try {
  const out = await exec({ command: AGENDA_SNAPSHOT_CMD });
  const snapshot = JSON.parse(String(out?.aggregated ?? "").trim());
  agendaFeedback = (Array.isArray(snapshot.feedback) ? snapshot.feedback : []).filter(
    (entry) => !entry.undoneBy && FEEDBACK_STATUSES.has(entry.status),
  );
} catch {
  agendaReadFailed = true;
}
st.agendaReadFails = agendaReadFailed ? (Number(st.agendaReadFails) || 0) + 1 : 0;

let fire = false;
const reasons = [];
if (st.collectFails >= 2) {
  fire = true;
  reasons.push(
    `收集层故障：collect.mjs 连续 ${st.collectFails} 次输出异常（期望 ${EXPECTED_SOURCES} 行源摘要，本次 ${lines.length} 行）。处置：读 /home/raymond/.openclaw/workspace/collection/README.md 排障，修复后运行 collect.mjs <源> 验证（streak 自动清零）；按既有渠道推送一条通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title <标题≤20字> --text <正文>；发送失败就在本轮结果写明失败与原因，不换通道重发，每源每日一次）。不动 agenda 数据、不做排程、不改其他自动化。`,
  );
} else {
  if (failures.length) {
    const fresh = failures.filter((f) => st.alerted[f.source] !== day);
    if (fresh.length) {
      fire = true;
      reasons.push(
        `收集层故障：${fresh.map((f) => `${f.label} 连续 ${f.streak} 次（${f.error || "未知错误"}）`).join("；")}。处置：读 /home/raymond/.openclaw/workspace/collection/README.md 与 state/health.json 排障，优先走登录自愈（node collect.mjs <源> --force）；dws 认证失效提示用户重新 dws auth login，不代登。修复后重跑验证 streak 归零；按既有渠道推送一条简短通知（node /home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs --title=故障源 --text=修复结果；发送失败就在本轮结果写明失败与原因，不换通道重发，每源每日一次）。不动 agenda 数据、不做排程、不动其他自动化。`,
      );
      for (const f of fresh) st.alerted[f.source] = day;
    }
  }
  if (deltas.length) {
    fire = true;
    reasons.push(
      `事项变化：${deltas.join("；")}。处置：读 /home/raymond/.openclaw/workspace/collection/report.json 对应来源条目（skipped 条目忽略）逐项分诊——需要行动则按 schedule-sweep 既有规则登记/排程/提醒（先查重，不重复建单）；无需行动则静默结束，不通知、不登记。`,
    );
  }
}

// 桌面完成反馈：Agenda 只负责把反馈标成 queued/running 并唤起 collector；
// 重排与 feedbackResults 提交必须在本轮完成，否则 finished 钩子会诚实记为“未收到调整结果”。
if (agendaFeedback.length) {
  fire = true;
  const kinds = [...new Set(agendaFeedback.map((entry) => entry.kind))].join("/");
  reasons.push(
    `Agenda 完成反馈：${agendaFeedback.length} 条待重排（${kinds}）。处置：读 /home/raymond/.openclaw/extensions/agenda/skills/agenda/SKILL.md 的 Desktop feedback 段与 /home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md；先 agenda read（includeCompleted:true）取 revision 和 feedback，只调整受影响部分，并在同一 apply 提交 feedbackResults（adjusted/unchanged/error + 简短中文 summary）；不发送消息、不新建自动化、不启用 sentinel、不改课程。`,
  );
}

// 告警去重表只保留今天的键
st.alerted = Object.fromEntries(Object.entries(st.alerted).filter(([, d]) => d === day));
return { fire, ...(fire ? { message: reasons.join("\n") } : {}), state: st };
