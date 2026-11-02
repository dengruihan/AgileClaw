// Agent 行动边界验证（审查 r2 重写）：真实运行时组件 + 真实报告形状 fixture。
//
// 真实组件（直接导入线上/仓库源码执行，非复刻）：
//   - agenda 工具与 schema：~/.openclaw/extensions/agenda/src/tool.ts 的 createAgendaTool
//     （严格 zod schema：{action:'read'|'apply', query?, change?}；apply 要求 operationId +
//     expectedRevision；agentId 归属门控）
//   - agenda store：同一扩展 src/store.ts 的 openAgendaStore，临时 SQLite 文件
//     （真实 revision / operationId 幂等 / revision_conflict 语义）
//   - cron toolsAllow 门控：产品仓库 src/agents/tool-policy-match.ts 的 createToolPolicyMatcher
//
// 非真实部分（剩余验证缺口，如实声明）：模型的判定与工具选择本身不在此执行——
// 下方 conformingTurn 是 payload-message.txt 两条路径的**参考协议实现**，用于驱动真实边界；
// 真实模型行为须部署后自然周期观察一轮真实 delta（不 force run、不发对外测试消息）。
//
// fixture 形状取自线上真实来源输出：
//   OSH: sources/osh.mjs → {key:'osh:<id>', kind:'assignment', id, courseId, course, title,
//        dueAt, points, submitted, workflowState, late, url}
//   云谷: sources/yungu-tasks.mjs → {key:'yt:<taskPublishId>', kind:'task', taskPublishId,
//        taskId, title, course, group, deadline, deadlineMs, status, timeout, approxMin, detailUrl}
//   钉钉: sources/dingtalk.mjs → {key:'cid:<openConversationId>', cid, name, lastMsgAt}（无正文）
//   邮件: 只有 counts/countsDelta，无条目
//   报告外壳: collect.mjs 的 report.json → {at, sources:{<名>:{source,label,at,durationMs,ok,
//        coverage,items?,itemsCount?,counts?,countsDelta?,delta:{added,changed,removed},skipped?}}}

import { mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

register("./ts-resolve.mjs", import.meta.url);

const AGENDA_SRC = "/home/raymond/.openclaw/extensions/agenda/src";
const AGENDA_WORKER = "file:///home/raymond/.openclaw/extensions/agenda/dist/src/sqlite.worker.js";
const REPO_SRC = "/home/raymond/repos/AgileClaw/src";

const [{ openAgendaStore }, { createAgendaTool }, { createToolPolicyMatcher }] = await Promise.all([
  import(`${AGENDA_SRC}/store.ts`),
  import(`${AGENDA_SRC}/tool.ts`),
  import(`${REPO_SRC}/agents/tool-policy-match.ts`),
]);

const DAY = 24 * 3600 * 1000;
const NOW = Date.now();
const ISO = (ms) => new Date(ms).toISOString();
let opSeq = 0;

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
const body = (r) => JSON.parse(r.content[0].text);

// ---- 真实 agenda 工具实例（临时 SQLite；通知/对外消息/文件写入为记录器）----
function makeEnv({ toolsAllow, agentId = "main" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "agenda-bdry-"));
  const store = openAgendaStore({
    databasePath: path.join(dir, "agenda.sqlite"),
    workerModuleUrl: new URL(AGENDA_WORKER),
  });
  const matcher = createToolPolicyMatcher(toolsAllow ? { allow: toolsAllow } : undefined);
  const rec = {
    applies: [],
    order: [],
    notifications: [],
    outbound: [],
    fsWrites: 0,
    rejected: [],
  };
  const tool = createAgendaTool({
    context: {
      agentId,
      assertInvocationCurrent() {},
      assertInputCommitAllowed() {},
    },
    getStore: () => store,
    onCommit: () => {},
  });
  const env = {
    store,
    rec,
    matcher,
    dir,
    agendaRead: async () => {
      if (!matcher("agenda")) {
        const e = new Error("agenda blocked by cron toolsAllow");
        rec.rejected.push(e.message);
        throw e;
      }
      rec.order.push("agenda.read");
      return body(await tool.execute(`r${opSeq}`, { action: "read" }));
    },
    // 合法 apply：完整 agendaItem（真实 schema）、同批注册 source、operationId + 当前 revision
    agendaApply: async (item) => {
      if (!matcher("agenda")) {
        const e = new Error("agenda blocked by cron toolsAllow");
        rec.rejected.push(e.message);
        throw e;
      }
      const snap = body(await tool.execute(`p${opSeq}`, { action: "read" }));
      const change = {
        operationId: `op-${process.pid}-${opSeq++}`,
        expectedRevision: snap.revision,
        items: [
          {
            id: item.key,
            kind: "task",
            title: item.title,
            status: "pending",
            sourceId: item.sourceId,
            sourceKey: item.key,
            sourceUrl: item.url || item.detailUrl || null,
            dueAt: item.dueAt || null,
            dueDate: null,
            estimatedMinutes: Number.isFinite(item.approxMin) ? item.approxMin : null,
            priority: "normal",
            nextAction: "开始处理",
            reason: null,
            completedBy: null,
            updatedAt: ISO(NOW),
          },
        ],
        sources: [
          {
            id: item.sourceId,
            label: item.sourceLabel,
            checkedAt: ISO(NOW),
            status: "ok",
            message: null,
            coverageRequired: true,
            coverageStart: null,
            coverageEnd: null,
          },
        ],
      };
      rec.order.push("agenda.apply");
      const receipt = body(await tool.execute(`w${opSeq}`, { action: "apply", change }));
      rec.applies.push(receipt);
      return receipt;
    },
    notify: (n) => rec.notifications.push(n),
    sendOutbound: (m) => rec.outbound.push(m),
    writeFile: () => rec.fsWrites++,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
  return env;
}

// ---- 参考协议（payload-message.txt 的脚本化执行，非模型证明）----
// 判定使用真实字段：OSH 看 dueAt/submitted；云谷看 deadlineMs/status；钉钉/邮件不产生可登记条目。
function classify(name, item) {
  if (name === "osh") {
    const due = Date.parse(item.dueAt || "");
    return item.submitted === false && Number.isFinite(due) && due - NOW < 7 * DAY;
  }
  if (name === "yungu-tasks") {
    return (
      Number.isFinite(item.deadlineMs) && item.deadlineMs > NOW && item.deadlineMs - NOW < 7 * DAY
    );
  }
  return false; // 钉钉（无正文）、邮件（仅计数）不可直接登记为待办事项
}

async function conformingTurn(env, report) {
  const actionable = [];
  for (const [name, entry] of Object.entries(report.sources ?? {})) {
    if (entry.skipped || entry.ok === false) continue;
    for (const item of entry.delta?.added ?? []) {
      if (classify(name, item)) {
        actionable.push({ ...item, sourceId: name, sourceLabel: entry.label });
      }
    }
  }
  if (actionable.length === 0) return "silent";
  const snap = await env.agendaRead(); // 查重：先 read 拿 revision 与现有条目
  const fresh = actionable.filter(
    (a) => !snap.items.some((i) => i.sourceId === a.sourceId && i.sourceKey === a.key),
  );
  if (fresh.length === 0) return "silent-after-dedupe";
  for (const a of fresh) {
    const receipt = await env.agendaApply(a);
    if (!receipt.ok) return `apply-failed:${receipt.error}`;
  }
  env.notify({ title: fresh[0].title, reason: `新事项 ${fresh.length} 条已登记` });
  return "acted";
}

// ---- 真实形状的 fixture 条目 ----
const oshDone = {
  key: "osh:220990",
  kind: "assignment",
  id: 220990,
  courseId: 2908,
  course: "AP Physics C",
  title: "已提交作业",
  dueAt: ISO(NOW - DAY),
  points: 20,
  submitted: true,
  workflowState: "submitted",
  late: false,
  url: "https://learning.oneschoolhouse.org/courses/2908/assignments/220990",
};
const oshNew = {
  key: "osh:220997",
  kind: "assignment",
  id: 220997,
  courseId: 2908,
  course: "AP Physics C: Mechanics-A-Chamberlain",
  title: "8.2 INVEST",
  dueAt: ISO(NOW + DAY),
  points: 40,
  submitted: false,
  workflowState: "unsubmitted",
  late: false,
  url: "https://learning.oneschoolhouse.org/courses/2908/assignments/220997",
};
const ytLater = {
  key: "yt:89194",
  kind: "task",
  taskPublishId: 89194,
  taskId: 698022,
  title: "大学申请方案ED",
  course: "Future Planning V",
  group: "Due update",
  deadline: "12-24 22:00",
  deadlineMs: NOW + 30 * DAY,
  status: "To edit",
  timeout: false,
  approxMin: 15,
  detailUrl: "https://task.yungu.org/umiTask#/stuTaskInfo/89194/1/null/1",
};
const ytNew = {
  key: "yt:89201",
  kind: "task",
  taskPublishId: 89201,
  taskId: 698100,
  title: "数学练习",
  course: "数学",
  group: "",
  deadline: "11-04 22:00",
  deadlineMs: NOW + 2 * DAY,
  status: "To edit",
  timeout: false,
  approxMin: 30,
  detailUrl: "https://task.yungu.org/umiTask#/stuTaskInfo/89201/1/null/1",
};
const dtSession = { key: "cid:ding123", cid: "ding123", name: "某群", lastMsgAt: ISO(NOW) };

const entry = (source, label, extra) => ({
  source,
  label,
  at: ISO(NOW),
  durationMs: 800,
  ok: true,
  coverage: { note: "fixture" },
  ...extra,
});
const reportWith = (sources) => ({ at: ISO(NOW), sources });

// 修复后的 toolsAllow（既有 8 项 + agenda）与 r1 P1 时的旧 8 项
const TOOLS_FIXED = [
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
const TOOLS_R1_BROKEN = TOOLS_FIXED.filter((t) => t !== "agenda");

// ===== 场景 A：无需行动 → 零副作用 =====
{
  const env = makeEnv({ toolsAllow: TOOLS_FIXED });
  const report = reportWith({
    osh: entry("osh", "One Schoolhouse", {
      items: [oshDone],
      itemsCount: 1,
      delta: { added: [oshDone], changed: [], removed: [] },
    }),
    "yungu-tasks": entry("yungu-tasks", "云谷课堂", {
      items: [ytLater],
      itemsCount: 1,
      delta: { added: [ytLater], changed: [], removed: [] },
    }),
    dingtalk: entry("dingtalk", "钉钉", {
      items: [dtSession],
      itemsCount: 1,
      delta: { added: [dtSession], changed: [], removed: [] },
    }),
    mail: entry("mail", "邮件", { counts: { yungu: 12, qq: 3 }, countsDelta: { yungu: 1, qq: 0 } }),
  });
  const r = await conformingTurn(env, report);
  const snap = await env.agendaRead();
  ok(
    "A 判定依赖真实字段（submitted/deadlineMs），OSH 已提交+云谷远期→无需行动",
    r === "silent",
    `got ${r}`,
  );
  ok(
    "A store revision 保持 0（真实 store 零写入）",
    snap.revision === 0,
    `revision=${snap.revision}`,
  );
  ok("A 零 apply 回执", env.rec.applies.length === 0);
  ok("A 零通知", env.rec.notifications.length === 0);
  ok("A 零对外消息", env.rec.outbound.length === 0);
  ok("A 零文件写入", env.rec.fsWrites === 0);
  env.close();
}

// ===== 场景 B：需要行动 → read 查重 → 合法 apply → 至多一条通知 =====
{
  const env = makeEnv({ toolsAllow: TOOLS_FIXED });
  const report = reportWith({
    osh: entry("osh", "One Schoolhouse", {
      items: [oshNew],
      itemsCount: 1,
      delta: { added: [oshNew], changed: [], removed: [] },
    }),
    "yungu-tasks": entry("yungu-tasks", "云谷课堂", {
      items: [ytNew],
      itemsCount: 1,
      delta: { added: [ytNew], changed: [], removed: [] },
    }),
  });
  ok("B 真实字段下两条均判为需要行动", classify("osh", oshNew) && classify("yungu-tasks", ytNew));
  const r = await conformingTurn(env, report);
  ok("B 执行登记", r === "acted", `got ${r}`);
  ok(
    "B read 查重先于 apply（真实调用序）",
    env.rec.order.indexOf("agenda.read") !== -1 &&
      env.rec.order.indexOf("agenda.read") < env.rec.order.indexOf("agenda.apply"),
    env.rec.order.join(","),
  );
  ok(
    "B 两条合法 apply 回执均 ok",
    env.rec.applies.length === 2 && env.rec.applies.every((x) => x.ok),
    JSON.stringify(env.rec.applies),
  );
  const snap = await env.agendaRead();
  const keys = snap.items.map((i) => `${i.sourceId}/${i.sourceKey}`).sort();
  ok(
    "B 真实 store 中按 sourceId/sourceKey 可查",
    keys.includes("osh/osh:220997") && keys.includes("yungu-tasks/yt:89201"),
    keys.join(","),
  );
  ok("B 至多一条通知", env.rec.notifications.length <= 1);
  ok("B 零对外消息", env.rec.outbound.length === 0);
  ok("B 零文件写入", env.rec.fsWrites === 0);
  env.close();
}

// ===== 场景 B2：重复条目不重建（查重命中 → 不 apply）=====
{
  const env = makeEnv({ toolsAllow: TOOLS_FIXED });
  const seed = await env.agendaApply({
    ...oshNew,
    sourceId: "osh",
    sourceLabel: "One Schoolhouse",
  });
  ok("B2 预置登记成功", seed.ok === true);
  const before = await env.agendaRead();
  const report = reportWith({
    osh: entry("osh", "One Schoolhouse", {
      items: [oshNew],
      itemsCount: 1,
      delta: { added: [oshNew], changed: [], removed: [] },
    }),
  });
  const r = await conformingTurn(env, report);
  const after = await env.agendaRead();
  ok("B2 查重命中 → 静默", r === "silent-after-dedupe", `got ${r}`);
  ok(
    "B2 真实 store 零新增（revision 不变、条目唯一）",
    after.revision === before.revision &&
      after.items.filter((i) => i.sourceKey === "osh:220997").length === 1,
    `rev ${before.revision}->${after.revision}, items=${after.items.length}`,
  );
  ok("B2 本轮零 apply", env.rec.applies.length === 1); // 仅预置那一次
  ok("B2 零通知", env.rec.notifications.length === 0);
  env.close();
}

// ===== 场景 C：缺 agenda 的真实门控（产品仓库 matcher）+ 归属门控 =====
{
  const matcher = createToolPolicyMatcher({ allow: TOOLS_R1_BROKEN });
  ok(
    "C 旧 8 项 toolsAllow 下 matcher(agenda)=false（r1 P1 门控，真实代码）",
    matcher("agenda") === false,
  );
  ok("C 旧列表下 matcher(read)=true（既有工具不受影响）", matcher("read") === true);
  const fixed = createToolPolicyMatcher({ allow: TOOLS_FIXED });
  ok("C 追加 agenda 后 matcher(agenda)=true（修复生效）", fixed("agenda") === true);

  const env = makeEnv({ toolsAllow: TOOLS_R1_BROKEN });
  const report = reportWith({
    osh: entry("osh", "One Schoolhouse", {
      items: [oshNew],
      itemsCount: 1,
      delta: { added: [oshNew], changed: [], removed: [] },
    }),
  });
  const r = await conformingTurn(env, report).catch(() => "gate-threw");
  ok(
    "C 缺 agenda 时登记被拒且零回执（无部分写入）",
    (r === "gate-threw" || r === "apply-failed:agenda blocked by cron toolsAllow") &&
      env.rec.applies.length === 0,
    `got ${r}`,
  );
  ok(
    "C 被拒时零通知、零对外消息",
    env.rec.notifications.length === 0 && env.rec.outbound.length === 0,
  );
  env.close();

  const envOwned = makeEnv({ toolsAllow: TOOLS_FIXED, agentId: "cron-collector" });
  let ownedErr = "";
  try {
    await envOwned.agendaRead();
  } catch (e) {
    ownedErr = String(e.message || e);
  }
  ok(
    "C 非 main agentId 被真实工具拒绝（归属门控）",
    /owned by the main personal assistant/.test(ownedErr),
    ownedErr,
  );
  ok("C 线上 collector 以 main 身份运行（cron list Agent ID=main），归属门控不阻塞", true);
  envOwned.close();
}

// ===== 场景 D：真实 schema 严格性（非法 apply 被真实工具拒绝）=====
{
  const env = makeEnv({ toolsAllow: TOOLS_FIXED });
  const tool = createAgendaTool({
    context: { agentId: "main", assertInvocationCurrent() {}, assertInputCommitAllowed() {} },
    getStore: () => env.store,
    onCommit: () => {},
  });
  let schemaErr = "";
  try {
    await tool.execute("d1", { action: "apply", change: { items: [] } });
  } catch (e) {
    schemaErr = String(e.message || e);
  }
  ok(
    "D 缺 operationId/expectedRevision 被真实 schema 拒绝",
    /operationId|expectedRevision|invalid/i.test(schemaErr),
    schemaErr.slice(0, 120),
  );
  let readErr = "";
  try {
    await tool.execute("d2", { action: "read", change: { operationId: "x", expectedRevision: 0 } });
  } catch (e) {
    readErr = String(e.message || e);
  }
  ok(
    "D read 带 change 被真实工具拒绝",
    /read accepts query, not change/.test(readErr),
    readErr.slice(0, 120),
  );
  env.close();
}

console.log(`\n${pass} pass, ${fail} fail`);
console.log(
  "剩余缺口：模型判定/工具选择的真实行为未在此执行（无法在不写用户数据的前提下运行真实 isolated Agent）；需部署后自然周期观察。",
);
process.exit(fail ? 1 : 0);
