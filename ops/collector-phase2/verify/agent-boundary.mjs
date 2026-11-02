// Agent 行动边界验证（mock Agenda / 通知 / 对外消息，隔离 fixture，不触线上）。
// 验证 payload-message.txt 的两类唤醒路径在工具边界内的行为契约：
//   A. 无需行动：零 agenda 写入、零通知、零文件写入、零对外消息，直接结束；
//   B. 需要行动：agenda read（查重）→ 仅对未登记条目 apply 一次 → 至多一条通知；
//   C. 工具门控：toolsAllow 不含 agenda 时登记动作必须失败（复现 r1 P1 的阻塞形态）。
// 注意：本 harness 用脚本化决策执行提示词的控制流不变量；决策智能本身由线上模型轮承担，
// 部署后仍需自然周期观察一轮真实 delta 分诊。

let pass = 0,
  fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`ok   ${name}`);
  } else {
    fail++;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// ---- mock 环境：工具调用全部记录；agenda 受 toolsAllow 门控（复刻线上 cron toolsAllow 语义）----
function makeEnv({ report, agendaEntries, toolsAllow }) {
  const calls = { agendaRead: 0, agendaApply: [], light: [], message: [], fsWrites: 0, order: [] };
  const agendaSet = new Set(agendaEntries.map((e) => e.key));
  const tools = {
    read: () => {
      calls.order.push("read");
      return JSON.stringify(report);
    },
    write: () => {
      calls.fsWrites++;
    },
    agenda: {
      read: () => {
        if (!toolsAllow.includes("agenda")) throw new Error("tool not allowed: agenda");
        calls.agendaRead++;
        calls.order.push("agenda.read");
        return agendaEntries.map((e) => ({ ...e }));
      },
      apply: (op) => {
        if (!toolsAllow.includes("agenda")) throw new Error("tool not allowed: agenda");
        calls.agendaApply.push(op);
        calls.order.push("agenda.apply");
        agendaSet.add(op.key);
      },
    },
    light: {
      send: (p) => {
        calls.light.push(p);
        calls.order.push("light");
      },
    },
    message: {
      send: (p) => {
        calls.message.push(p);
      },
    },
  };
  return { calls, tools, agendaSet };
}

// ---- 提示词控制流的脚本化执行（判定规则：有截止且未提交且未登记 = 需要行动）----
function triageAgent(tools) {
  const report = JSON.parse(tools.read());
  const actionable = [];
  for (const [source, entry] of Object.entries(report.sources)) {
    if (entry.skipped) continue;
    for (const item of entry.delta?.added || []) {
      const due = Date.parse(item.due || "");
      const nearDue = Number.isFinite(due) && due - Date.now() < 7 * 24 * 3600 * 1000;
      if (nearDue && item.status !== "submitted") actionable.push({ source, ...item });
    }
  }
  if (actionable.length === 0) return "silent"; // 分支一：无需行动 → 静默结束

  const existing = tools.agenda.read(); // 查重
  const fresh = actionable.filter((a) => !existing.some((e) => e.key === a.key));
  if (fresh.length === 0) return "silent"; // 查重后无可做 → 静默
  for (const a of fresh) tools.agenda.apply({ op: "add", key: a.key, title: a.title, due: a.due });
  tools.light.send({ title: fresh[0].title, reason: `新事项 ${fresh.length} 条已登记` });
  return "acted";
}

const NOW = Date.now();
const day = 24 * 3600 * 1000;
const TOOLS_WITH_AGENDA = [
  "ls",
  "read",
  "edit",
  "write",
  "apply_patch",
  "exec",
  "process",
  "light_control",
  "agenda",
];
const TOOLS_R1_BROKEN = TOOLS_WITH_AGENDA.filter((t) => t !== "agenda");

// 场景 A：delta 里一条已登记（查重命中）、一条无截止的信息项 → 无需行动
const reportA = {
  sources: {
    "yungu-tasks": {
      skipped: false,
      delta: {
        added: [
          {
            key: "task-known",
            title: "已登记作业",
            due: new Date(NOW + 2 * day).toISOString(),
            status: "pending",
          },
          { key: "task-info", title: "通知类变更", due: null, status: "pending" },
        ],
      },
    },
    mail: { skipped: false, countsDelta: { yungu: 1, qq: 0 }, delta: {} }, // 邮件只有计数，无条目可分诊
  },
};
const envA = makeEnv({
  report: reportA,
  agendaEntries: [{ key: "task-known", title: "已登记作业" }],
  toolsAllow: TOOLS_WITH_AGENDA,
});
const rA = triageAgent(envA.tools);
ok("A 无需行动：静默结束", rA === "silent");
ok("A 零 agenda 写入", envA.calls.agendaApply.length === 0);
ok("A 零通知", envA.calls.light.length === 0);
ok("A 零文件写入", envA.calls.fsWrites === 0);
ok("A 零对外消息", envA.calls.message.length === 0);

// 场景 B：新作业明天截止、未登记 → 需要行动：read 查重 → 一次 apply → 一条通知
const reportB = {
  sources: {
    osh: {
      skipped: false,
      delta: {
        added: [
          {
            key: "osh-new",
            title: "新作业",
            due: new Date(NOW + day).toISOString(),
            status: "pending",
          },
        ],
      },
    },
  },
};
const envB = makeEnv({ report: reportB, agendaEntries: [], toolsAllow: TOOLS_WITH_AGENDA });
const rB = triageAgent(envB.tools);
ok("B 需要行动：执行登记", rB === "acted");
ok(
  "B 先 read 查重再 apply",
  envB.calls.order.indexOf("agenda.read") !== -1 &&
    envB.calls.order.indexOf("agenda.read") < envB.calls.order.indexOf("agenda.apply"),
  envB.calls.order.join(","),
);
ok(
  "B 仅 apply 一次且字段正确",
  envB.calls.agendaApply.length === 1 && envB.calls.agendaApply[0].key === "osh-new",
);
ok("B 至多一条通知", envB.calls.light.length <= 1);
ok("B 零对外消息", envB.calls.message.length === 0);
ok("B 零文件写入", envB.calls.fsWrites === 0);

// 场景 C：复现 r1 P1——toolsAllow 缺 agenda 时需要行动路径在登记处失败
const envC = makeEnv({ report: reportB, agendaEntries: [], toolsAllow: TOOLS_R1_BROKEN });
let threw = false;
try {
  triageAgent(envC.tools);
} catch {
  threw = true;
}
ok(
  "C toolsAllow 缺 agenda 时登记被拒绝（P1 阻塞形态）",
  threw && envC.calls.agendaApply.length === 0,
);

// 场景 D：B 的去重变体——两条 delta 一条已登记 → 只对未登记那条 apply
const reportD = {
  sources: {
    "yungu-tasks": {
      skipped: false,
      delta: {
        added: [
          {
            key: "task-known",
            title: "已登记作业",
            due: new Date(NOW + day).toISOString(),
            status: "pending",
          },
          {
            key: "task-new",
            title: "新作业二",
            due: new Date(NOW + 2 * day).toISOString(),
            status: "pending",
          },
        ],
      },
    },
  },
};
const envD = makeEnv({
  report: reportD,
  agendaEntries: [{ key: "task-known", title: "已登记作业" }],
  toolsAllow: TOOLS_WITH_AGENDA,
});
const rD = triageAgent(envD.tools);
ok(
  "D 查重后只对未登记条目 apply 一次",
  rD === "acted" &&
    envD.calls.agendaApply.length === 1 &&
    envD.calls.agendaApply[0].key === "task-new",
);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
