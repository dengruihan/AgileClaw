import { readFileSync } from "node:fs";
const src = readFileSync(
  "/home/raymond/repos/AgileClaw/.tower/worktrees/wt-1/ops/collector-phase2/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs",
  "utf8",
);

const L = (o) => JSON.stringify(o);
const base = (changed) => L({ source: "x", label: "X", ok: true, streak: 0, changed });
const noChange5 = [
  L({ source: "yungu-tasks", label: "云谷课堂", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  L({ source: "yungu-schedule", label: "云谷课表", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  L({ source: "osh", label: "One Schoolhouse", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  L({ source: "dingtalk", label: "钉钉", ok: true, streak: 0, changed: "+0 ~0 -0" }),
  L({ source: "mail", label: "邮件", ok: true, streak: 0, changed: "yungu +0 qq +0" }),
];
const withDelta = (idx, changed) =>
  noChange5.map((l, i) =>
    i === idx ? l.replace(/"changed":"[^"]*"/, `"changed":"${changed}"`) : l,
  );

const scenarios = [
  { name: "无变化 → 不唤醒", lines: noChange5, expectFire: false },
  {
    name: "yungu-tasks +1 → 唤醒(事项)",
    lines: withDelta(0, "+1 ~0 -0"),
    expectFire: true,
    expectMsg: "事项变化",
  },
  {
    name: "changed/removed 非零 → 唤醒",
    lines: withDelta(2, "+0 ~2 -1"),
    expectFire: true,
    expectMsg: "One Schoolhouse +0 ~2 -1",
  },
  {
    name: "钉钉会话列表变化 → 唤醒",
    lines: withDelta(3, "+1 ~3 -0"),
    expectFire: true,
    expectMsg: "钉钉 +1 ~3 -0",
  },
  {
    name: "邮件净增 → 唤醒",
    lines: withDelta(4, "yungu +2 qq +1"),
    expectFire: true,
    expectMsg: "净新增邮件",
  },
  { name: "邮件净减 → 不唤醒", lines: withDelta(4, "yungu -2 qq -1"), expectFire: false },
  { name: "邮件首跑 +? → 不唤醒", lines: withDelta(4, "yungu +? qq +?"), expectFire: false },
  {
    name: "skipped 源 → 不当作 delta",
    lines: [
      ...noChange5.slice(0, 4),
      L({ source: "mail", label: "邮件", ok: true, skipped: true, streak: 0 }),
    ],
    expectFire: false,
  },
  {
    name: "源故障 streak=2 → 唤醒(故障)",
    lines: [
      ...noChange5.slice(0, 4),
      L({ source: "osh", label: "One Schoolhouse", ok: false, streak: 2, error: "RELOGIN_FAILED" }),
    ],
    expectFire: true,
    expectMsg: "收集层故障",
  },
  {
    name: "skipped 故障源 → 不唤醒",
    lines: [
      ...noChange5.slice(0, 4),
      L({ source: "osh", label: "OSH", ok: false, skipped: true, streak: 2 }),
    ],
    expectFire: false,
  },
  {
    name: "delta+故障 同轮 → 单条唤醒双原因",
    lines: [
      ...withDelta(0, "+1 ~0 -0").slice(0, 4),
      L({ source: "osh", label: "One Schoolhouse", ok: false, streak: 3, error: "RELOGIN_FAILED" }),
    ],
    expectFire: true,
    expectMsg: "事项变化",
  },
  {
    name: "输出行数不对 → 累计 collectFails",
    lines: noChange5.slice(0, 3),
    expectFire: false,
    expectFails: 1,
  },
];

async function run(lines, state, { execThrows = false } = {}) {
  const exec = execThrows
    ? async () => {
        throw new Error("boom");
      }
    : async () => ({ aggregated: lines.join("\n") });
  const fn = new Function(
    "exec",
    "trigger",
    `return (async () => { ${src.replace(/^\/\/[^\n]*\n/gm, "")} })()`,
  );
  return await fn(exec, { state });
}

let pass = 0,
  fail = 0;
for (const s of scenarios) {
  const r = await run(s.lines, s.state || {});
  const checks = [
    ["fire", r.fire === s.expectFire],
    ...(s.expectMsg ? [["msg contains", String(r.message || "").includes(s.expectMsg)]] : []),
    ...(s.expectFails !== undefined
      ? [["collectFails", r.state.collectFails === s.expectFails]]
      : []),
  ];
  const bad = checks.filter(([, ok]) => !ok);
  if (bad.length) {
    fail++;
    console.log(
      `FAIL ${s.name}: ${bad.map(([k]) => k).join(",")}; got fire=${r.fire} msg=${JSON.stringify(r.message || "").slice(0, 120)} fails=${r.state.collectFails}`,
    );
  } else {
    pass++;
    console.log(`ok   ${s.name}`);
  }
}

// 故障去重：同故障源同日第二次评估不唤醒
const st1 = {};
const failLines = [
  ...noChange5.slice(0, 4),
  L({ source: "osh", label: "One Schoolhouse", ok: false, streak: 2, error: "RELOGIN_FAILED" }),
];
const r1 = await run(failLines, st1);
const r2 = await run(failLines, r1.state);
if (r1.fire && !r2.fire && r2.state.alerted.osh) {
  pass++;
  console.log("ok   故障同日复评 → 去重不唤醒");
} else {
  fail++;
  console.log(`FAIL 故障去重: r1.fire=${r1.fire} r2.fire=${r2.fire}`);
}

// collect.mjs 连续两次异常 → 唤醒
const emptyExec = async () => ({ aggregated: "" });
const fn = new Function(
  "exec",
  "trigger",
  `return (async () => { ${src.replace(/^\/\/[^\n]*\n/gm, "")} })()`,
);
const c1 = await fn(emptyExec, { state: {} });
const c2 = await fn(emptyExec, { state: c1.state });
if (!c1.fire && c2.fire && /连续 2 次输出异常/.test(c2.message)) {
  pass++;
  console.log("ok   collect.mjs 连续异常 ×2 → 唤醒");
} else {
  fail++;
  console.log(
    `FAIL collectFails: c1.fire=${c1.fire} c2.fire=${c2.fire} msg=${JSON.stringify(c2.message || "").slice(0, 100)}`,
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
