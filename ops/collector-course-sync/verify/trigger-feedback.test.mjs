// 隔离验证 collector 触发脚本的 Agenda 完成反馈唤醒契约。
// 不访问真实 Agenda/collect.mjs/cron；exec 是记录器，返回合成源摘要与 snapshot。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(
  join(root, "files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs"),
  "utf8",
);

const line = (o) => JSON.stringify(o);
const noChange = [
  line({ source: "yungu-tasks", label: "云谷课堂", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  line({ source: "yungu-schedule", label: "云谷课表", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  line({ source: "osh", label: "One Schoolhouse", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  line({ source: "dingtalk", label: "钉钉", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  line({ source: "mail", label: "邮件", ok: true, streak: 0, changed: "yungu +0 qq +0" }),
];
const withDelta = (idx, changed) =>
  noChange.map((value, i) =>
    i === idx ? value.replace(/"changed":"[^"]*"/, `"changed":"${changed}"`) : value,
  );

function feedback(overrides = {}) {
  return {
    id: "fb-1",
    kind: "complete_block",
    itemId: "item-1",
    targetId: "block-1",
    status: "pending",
    undoneBy: null,
    ...overrides,
  };
}

function makeExec({ lines = noChange, snapshot = { feedback: [] }, agendaError = false } = {}) {
  const calls = [];
  return {
    calls,
    exec: async ({ command }) => {
      calls.push(command);
      if (command.includes("collect.mjs")) return { aggregated: lines.join("\n") };
      if (command.includes("api/snapshot")) {
        if (agendaError) throw new Error("ECONNREFUSED");
        return { aggregated: JSON.stringify(snapshot) };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
}

async function run(exec, state = {}) {
  const fn = new Function("exec", "trigger", `return (async () => { ${src} })()`);
  return await fn(exec, { state });
}

test("无 delta 且无反馈：不唤醒", async () => {
  const { exec, calls } = makeExec();
  const result = await run(exec);
  assert.equal(result.fire, false);
  assert.equal(result.state.agendaReadFails, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /api\/snapshot\?includeCompleted=true/);
});

test("只有 pending 桌面反馈：唤醒并给出重排与 feedbackResults 指引", async () => {
  const { exec } = makeExec({ snapshot: { feedback: [feedback()] } });
  const result = await run(exec);
  assert.equal(result.fire, true);
  assert.match(result.message, /Agenda 完成反馈：1 条待重排（complete_block）/);
  assert.match(result.message, /extensions\/agenda\/skills\/agenda\/SKILL\.md/);
  assert.match(result.message, /feedbackResults/);
  assert.match(result.message, /includeCompleted:true/);
  assert.match(result.message, /不启用 sentinel/);
  assert.match(result.message, /不改课程/);
});

test("queued/running 也唤醒，已处理/已撤销不唤醒", async () => {
  const active = makeExec({
    snapshot: {
      feedback: [
        feedback({ id: "fb-1", status: "queued" }),
        feedback({ id: "fb-2", status: "running", kind: "complete_task" }),
      ],
    },
  });
  const activeResult = await run(active.exec);
  assert.equal(activeResult.fire, true);
  assert.match(activeResult.message, /2 条待重排（complete_block\/complete_task）/);

  const inactive = makeExec({
    snapshot: {
      feedback: [
        feedback({ id: "fb-3", status: "adjusted" }),
        feedback({ id: "fb-4", status: "unchanged" }),
        feedback({ id: "fb-5", status: "error" }),
        feedback({ id: "fb-6", status: "pending", undoneBy: "fb-7" }),
      ],
    },
  });
  const inactiveResult = await run(inactive.exec);
  assert.equal(inactiveResult.fire, false);
});

test("反馈与源 delta 同轮：单次唤醒、双原因合并", async () => {
  const { exec } = makeExec({
    lines: withDelta(0, "+1 ~0 -0"),
    snapshot: { feedback: [feedback({ status: "running" })] },
  });
  const result = await run(exec);
  assert.equal(result.fire, true);
  assert.equal(result.message.split("\n").length >= 2, true);
  assert.match(result.message, /事项变化：云谷课堂 \+1 ~0 -0/);
  assert.match(result.message, /Agenda 完成反馈/);
});

test("反馈读取失败：不单独唤醒，计数保留；恢复后清零", async () => {
  const failed = makeExec({ agendaError: true });
  const first = await run(failed.exec, { agendaReadFails: 1 });
  assert.equal(first.fire, false);
  assert.equal(first.state.agendaReadFails, 2);

  const recovered = makeExec({ snapshot: { feedback: [] } });
  const second = await run(recovered.exec, first.state);
  assert.equal(second.fire, false);
  assert.equal(second.state.agendaReadFails, 0);
});

test("反馈唤醒只读 Agenda，不调用写接口/工具", async () => {
  const { exec, calls } = makeExec({ snapshot: { feedback: [feedback()] } });
  await run(exec);
  const agendaCalls = calls.filter((command) => command.includes("/agenda/"));
  assert.equal(agendaCalls.length, 1);
  assert.doesNotMatch(agendaCalls[0], /-X\s*POST|api\/sync|api\/feedback/);
  assert.doesNotMatch(agendaCalls[0], /sqlite|agenda\.sqlite|openclaw cron edit/);
});

test("现有源故障与 delta 行为保持", async () => {
  const failure = makeExec({
    lines: [
      ...noChange.slice(0, 4),
      line({
        source: "osh",
        label: "One Schoolhouse",
        ok: false,
        streak: 2,
        error: "RELOGIN_FAILED",
      }),
    ],
  });
  const failureResult = await run(failure.exec);
  assert.equal(failureResult.fire, true);
  assert.match(failureResult.message, /收集层故障/);

  const delta = makeExec({ lines: withDelta(4, "yungu +2 qq +0") });
  const deltaResult = await run(delta.exec);
  assert.equal(deltaResult.fire, true);
  assert.match(deltaResult.message, /净新增邮件/);
});
