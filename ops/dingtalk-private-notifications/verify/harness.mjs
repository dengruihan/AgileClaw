// dingtalk-notify 包装器的 fixture 干跑验证（不触碰真实 Gateway / 钉钉 / 连接器上下文）。
// 用 Mock 的 openclaw 与临时上下文文件验证：调用参数、AI 卡片关闭、本人目标强制
//（连接器上下文 inbound senderId 为权威）、code-point 安全分块、失败与部分送达行为。
// 退出码 0 = 全部通过。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = fileURLToPath(
  new URL(
    "../files/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs",
    import.meta.url,
  ),
);
const SELF_ID = "300000000000000000";
const FOREIGN_ID = "399999999999999999";

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed += 1;
    results.push(`ok   ${name}`);
  } else {
    failed += 1;
    results.push(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const inboundRec = (senderId, id = "msg1") => ({
  scope: { accountId: "__default__", conversationId: "cidSelf=" },
  id,
  direction: "inbound",
  senderId,
  text: "hi",
  createdAt: 1,
});
const outboundRec = (id = "card_1") => ({
  scope: { accountId: "__default__", conversationId: "cidSelf=" },
  id,
  direction: "outbound",
  text: "reply",
  createdAt: 2,
});

// 上下文 fixture 形态：
//  valid            → 两条同身份 inbound + 一条 outbound（真实形态）
//  empty            → 只有 outbound，无 inbound
//  multi            → 两个不同 inbound 身份
//  corrupt          → 非 JSON
//  badshape         → records 非数组
//  missing-sender   → inbound 缺 senderId
//  nonnumeric-sender→ inbound senderId 非纯数字
//  absent           → 文件不存在
function contextFixture(mode) {
  switch (mode) {
    case "valid":
      return JSON.stringify({
        version: 1,
        records: [inboundRec(SELF_ID, "m1"), outboundRec(), inboundRec(SELF_ID, "m2")],
      });
    case "empty":
      return JSON.stringify({ version: 1, records: [outboundRec("o1"), outboundRec("o2")] });
    case "multi":
      return JSON.stringify({
        version: 1,
        records: [inboundRec(SELF_ID, "m1"), inboundRec(FOREIGN_ID, "m2")],
      });
    case "corrupt":
      return "not-json{";
    case "badshape":
      return JSON.stringify({ version: 1, records: "nope" });
    case "missing-sender": {
      const r = inboundRec(SELF_ID);
      delete r.senderId;
      return JSON.stringify({ version: 1, records: [r] });
    }
    case "nonnumeric-sender":
      return JSON.stringify({ version: 1, records: [inboundRec("unionIdXyz")] });
    case "absent":
      return null;
    default:
      throw new Error(`未知 fixture 形态 ${mode}`);
  }
}

// 每个用例一个独立 tmp 目录：mock bin/openclaw、上下文文件、state/、调用日志。
function makeEnv({
  context = "valid",
  openclawStdout = '{"ok":true,"processQueryKey":"pqk-1"}',
  openclawCode = 0,
  openclawStderr = "",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dt-notify-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "state");
  const contextDir = join(dir, "context");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  mkdirSync(contextDir);
  const logFile = join(dir, "calls.jsonl");
  const contextFile = join(contextDir, "message-context.json");

  const openclawMock = join(binDir, "openclaw");
  writeFileSync(
    openclawMock,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ bin: "openclaw", argv: process.argv.slice(2) }) + "\\n");
const out = process.env.MOCK_OPENCLAW_STDOUT || "";
const err = process.env.MOCK_OPENCLAW_STDERR || "";
const code = Number(process.env.MOCK_OPENCLAW_CODE || 0);
if (out) process.stdout.write(out + "\\n");
if (err) process.stderr.write(err + "\\n");
process.exit(code);
`,
  );
  chmodSync(openclawMock, 0o755);

  const fixture = contextFixture(context);
  if (fixture !== null) writeFileSync(contextFile, fixture);

  return {
    dir,
    stateDir,
    logFile,
    env: {
      ...process.env,
      DINGTALK_NOTIFY_OPENCLAW: openclawMock,
      DINGTALK_NOTIFY_CONTEXT_FILE: contextFile,
      DINGTALK_NOTIFY_STATE_DIR: stateDir,
      MOCK_LOG: logFile,
      MOCK_OPENCLAW_STDOUT: openclawStdout,
      MOCK_OPENCLAW_STDERR: openclawStderr,
      MOCK_OPENCLAW_CODE: String(openclawCode),
      DINGTALK_NOTIFY_TARGET: "",
    },
  };
}

const run = (env, args, { stdin } = {}) =>
  spawnSync("node", [WRAPPER, ...args], {
    env,
    encoding: "utf8",
    input: stdin,
    timeout: 30000,
  });

const readLog = (logFile) => {
  try {
    return readFileSync(logFile, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const openclawCalls = (logFile) =>
  readLog(logFile)
    .filter((e) => e.bin === "openclaw")
    .map((e) => e.argv);
const paramsOf = (argv) => JSON.parse(argv[argv.indexOf("--params") + 1]);
const ownerFileOf = (stateDir) => join(stateDir, "notify-owner.json");
const pinOwner = (fx, id = SELF_ID, verifiedVia = "connector-context") => {
  writeFileSync(
    ownerFileOf(fx.stateDir),
    `${JSON.stringify({ ownerTarget: `user:${id}`, verifiedVia, pinnedAt: "2026-11-02T00:00:00.000Z" }, null, 2)}\n`,
  );
};

const sendArgs = (text, extra = []) => ["--title", "测试标题", "--text", text, ...extra];
const hasLoneSurrogate = (s) => {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length || s.charCodeAt(i + 1) < 0xdc00 || s.charCodeAt(i + 1) > 0xdfff)
        return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
};

// 1. 短消息：单次调用，参数关闭 AI 卡片、Markdown、目标与标题正确
{
  const fx = makeEnv();
  pinOwner(fx);
  const r = run(fx.env, sendArgs("云谷课堂新增 1 项作业，截止周日 22:00。"));
  check("短消息退出码 0", r.status === 0, `实际 ${r.status}：${r.stderr}`);
  const calls = openclawCalls(fx.logFile);
  check("短消息恰好 1 次 gateway 调用", calls.length === 1, `实际 ${calls.length}`);
  const argv = calls[0] ?? [];
  const params = argv.length ? paramsOf(argv) : {};
  check("方法为 dingtalk-connector.send", argv[2] === "dingtalk-connector.send", argv[2]);
  check("useAICard=false（非 AI 卡片）", params.useAICard === false, JSON.stringify(params));
  check("msgType=markdown", params.msgType === "markdown");
  check("目标为钉定的本人单聊", params.target === `user:${SELF_ID}`, params.target);
  check("标题随首块传递", params.title === "测试标题");
  check("stdout 报 ok", r.stdout.includes('"ok":true'), r.stdout);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 2. 钉定后上下文损坏/缺失也不影响发送（钉定值是发送期唯一权威）
{
  const fx = makeEnv({ context: "corrupt" });
  pinOwner(fx);
  const r = run(fx.env, sendArgs("钉定后发送"));
  check(
    "钉定后上下文损坏仍可发本人",
    r.status === 0 && openclawCalls(fx.logFile).length === 1,
    `${r.status} ${r.stderr}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });
  const fx2 = makeEnv({ context: "absent" });
  pinOwner(fx2);
  const r2 = run(fx2.env, sendArgs("钉定后发送(无上下文)"));
  check("钉定后上下文缺失仍可发本人", r2.status === 0, `${r2.status} ${r2.stderr}`);
  rmSync(fx2.dir, { recursive: true, force: true });
}

// 3. 长消息：按行分块、每块 ≤1900、标题只在首块、顺序保持
{
  const fx = makeEnv();
  pinOwner(fx);
  const para = "这是第N行内容，用来把消息撑过单块上限。".repeat(20);
  const text = Array.from({ length: 60 }, (_, i) => `${para} 行${i + 1}`).join("\n");
  check("fixture 文本超过单块上限", [...text].length > 1900, `长度 ${[...text].length}`);
  const r = run(fx.env, sendArgs(text));
  check("长消息退出码 0", r.status === 0, `实际 ${r.status}：${r.stderr}`);
  const calls = openclawCalls(fx.logFile);
  const paramsList = calls.map(paramsOf);
  check("长消息产生多个块", calls.length >= 2, `实际 ${calls.length}；stderr: ${r.stderr.trim()}`);
  check(
    "每块 ≤1900 字符",
    paramsList.every((p) => [...p.content].length <= 1900),
  );
  check(
    "标题只在首块",
    paramsList.length > 0 &&
      paramsList[0].title === "测试标题" &&
      paramsList.slice(1).every((p) => p.title === undefined),
  );
  check(
    "块顺序保持（首块开头一致）",
    paramsList.length > 0 && paramsList[0].content.startsWith("这是第N行内容"),
  );
  check("拼接后等于原文", paramsList.map((p) => p.content).join("\n") === text);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 4. emoji 边界：超长单行在 emoji 上硬切不拆代理对；多块含 emoji 内容精确
{
  const fx = makeEnv();
  pinOwner(fx);
  const line = `${"a".repeat(1899)}😀${"b".repeat(100)}`;
  const text = `${line}\n第二行 😀😀 结尾`;
  const r = run(fx.env, sendArgs(text));
  check("emoji 边界消息退出码 0", r.status === 0, `实际 ${r.status}：${r.stderr}`);
  const calls = openclawCalls(fx.logFile);
  const paramsList = calls.map(paramsOf);
  // 硬切边界会在下一块开头续行（跨消息无法保留原换行），逐块内容须精确符合预期：
  const expected = [`${"a".repeat(1899)}😀`, "b".repeat(100), "第二行 😀😀 结尾"];
  check(
    "emoji 场景恰好在 code point 边界硬切（3 块，逐块精确）",
    paramsList.length === expected.length && paramsList.every((p, i) => p.content === expected[i]),
    `实际 ${paramsList.length} 块：${JSON.stringify(paramsList.map((p) => p.content.slice(0, 12)))}`,
  );
  check(
    "无任何块含孤立代理对",
    paramsList.every((p) => !hasLoneSurrogate(p.content)),
  );
  check(
    "每块 ≤1900 code point",
    paramsList.every((p) => [...p.content].length <= 1900),
  );
  rmSync(fx.dir, { recursive: true, force: true });
}

// 5. 失败行为：ok:false / 非零退出（stdout+stderr 都保留）/ 非 JSON → 退出 1
{
  const fx = makeEnv({ openclawStdout: '{"ok":false,"error":"staffId.notExisted"}' });
  pinOwner(fx);
  const r = run(fx.env, sendArgs("故障告警测试"));
  check("ok:false 退出码 1", r.status === 1, `实际 ${r.status}`);
  check("ok:false 给出灯效回退提示", r.stderr.includes("ntf.cjs light send"), r.stderr);
  check("ok:false 错误带 Gateway 细节", r.stderr.includes("staffId.notExisted"), r.stderr);
  rmSync(fx.dir, { recursive: true, force: true });

  const fx2 = makeEnv({ openclawCode: 7, openclawStderr: "boom detail", openclawStdout: "" });
  pinOwner(fx2);
  const r2 = run(fx2.env, sendArgs("进程失败测试"));
  check("非零退出码透传为 1", r2.status === 1, `实际 ${r2.status}`);
  check("非零退出保留 stderr", r2.stderr.includes("boom detail"), r2.stderr);
  rmSync(fx2.dir, { recursive: true, force: true });

  const fx3 = makeEnv({ openclawCode: 7, openclawStderr: "", openclawStdout: "exit-side-detail" });
  pinOwner(fx3);
  const r3 = run(fx3.env, sendArgs("stdout 保留测试"));
  check(
    "非零退出保留 stdout",
    r3.status === 1 && r3.stderr.includes("exit-side-detail"),
    `${r3.status} ${r3.stderr}`,
  );
  rmSync(fx3.dir, { recursive: true, force: true });

  const fx4 = makeEnv({ openclawStdout: "<html>Gateway Error</html>" });
  pinOwner(fx4);
  const r4 = run(fx4.env, sendArgs("非JSON测试"));
  check("非 JSON 输出退出码 1", r4.status === 1, `实际 ${r4.status}`);
  rmSync(fx4.dir, { recursive: true, force: true });
}

// 6. legacy dws 钉定迁移（真实回归：线上留有 verifiedVia=dws-auth-status 的错误 ID 钉定）
{
  // a) dry-run：预览以上下文身份为准，零写副作用、零调用
  const fx = makeEnv({ context: "valid" });
  pinOwner(fx, FOREIGN_ID, "dws-auth-status");
  const r0 = run(fx.env, sendArgs("迁移预览", ["--dry-run"]));
  check(
    "legacy dws 钉定 dry-run → 预览目标=上下文身份",
    r0.status === 0 &&
      r0.stdout.includes(`user:${SELF_ID}`) &&
      !r0.stdout.includes(`user:${FOREIGN_ID}`),
    `${r0.status} ${r0.stderr} ${r0.stdout.slice(0, 200)}`,
  );
  check(
    "legacy dws 钉定 dry-run 零调用零写入",
    openclawCalls(fx.logFile).length === 0 &&
      (() => {
        try {
          const o = JSON.parse(readFileSync(ownerFileOf(fx.stateDir), "utf8"));
          return o.verifiedVia === "dws-auth-status" && o.ownerTarget === `user:${FOREIGN_ID}`;
        } catch {
          return false;
        }
      })(),
  );
  rmSync(fx.dir, { recursive: true, force: true });

  // b) 正式发送：自动迁移到上下文身份并送达
  const fx2 = makeEnv({ context: "valid" });
  pinOwner(fx2, FOREIGN_ID, "dws-auth-status");
  const r1 = run(fx2.env, sendArgs("迁移后发送"));
  check(
    "legacy dws 钉定发送 → 目标=上下文身份",
    r1.status === 0 && paramsOf(openclawCalls(fx2.logFile)[0]).target === `user:${SELF_ID}`,
    `${r1.status} ${r1.stderr}`,
  );
  check(
    "legacy dws 钉定发送后自动迁移 owner 文件",
    (() => {
      try {
        const o = JSON.parse(readFileSync(ownerFileOf(fx2.stateDir), "utf8"));
        return (
          o.ownerTarget === `user:${SELF_ID}` &&
          o.verifiedVia === "connector-context" &&
          o.migratedFrom === `user:${FOREIGN_ID}`
        );
      } catch {
        return false;
      }
    })(),
    readFileSync(ownerFileOf(fx2.stateDir), "utf8"),
  );
  rmSync(fx2.dir, { recursive: true, force: true });

  // c) legacy 钉定与上下文一致：同样升级为 connector-context
  const fx3 = makeEnv({ context: "valid" });
  pinOwner(fx3, SELF_ID, "dws-auth-status");
  const r2 = run(fx3.env, sendArgs("同身份迁移"));
  check("legacy 同身份发送成功", r2.status === 0, `${r2.status} ${r2.stderr}`);
  check(
    "legacy 同身份 owner 升级为 connector-context",
    (() => {
      try {
        const o = JSON.parse(readFileSync(ownerFileOf(fx3.stateDir), "utf8"));
        return o.verifiedVia === "connector-context" && o.ownerTarget === `user:${SELF_ID}`;
      } catch {
        return false;
      }
    })(),
  );
  rmSync(fx3.dir, { recursive: true, force: true });

  // d) 上下文歧义/损坏时 fail-closed：不发送、不迁移
  for (const [mode, label] of [
    ["multi", "多身份"],
    ["corrupt", "损坏"],
    ["empty", "无 inbound"],
  ]) {
    const fxA = makeEnv({ context: mode });
    pinOwner(fxA, FOREIGN_ID, "dws-auth-status");
    const ra = run(fxA.env, sendArgs("x"));
    check(
      `legacy 钉定 + 上下文${label} → 退出 2 不发送`,
      ra.status === 2 && openclawCalls(fxA.logFile).length === 0,
      `${ra.status} ${ra.stderr}`,
    );
    check(
      `legacy 钉定 + 上下文${label} → 不迁移文件`,
      (() => {
        try {
          const o = JSON.parse(readFileSync(ownerFileOf(fxA.stateDir), "utf8"));
          return o.verifiedVia === "dws-auth-status";
        } catch {
          return false;
        }
      })(),
    );
    rmSync(fxA.dir, { recursive: true, force: true });
  }

  // e) legacy 钉定下显式 --target：只能等于上下文身份，不能等于旧错误钉定
  const fx4 = makeEnv({ context: "valid" });
  pinOwner(fx4, FOREIGN_ID, "dws-auth-status");
  const r3 = run(fx4.env, sendArgs("x", ["--target", `user:${SELF_ID}`]));
  check("legacy 钉定 + --target=上下文身份 → 允许", r3.status === 0, `${r3.status} ${r3.stderr}`);
  const r4 = run(fx4.env, sendArgs("x", ["--target", `user:${FOREIGN_ID}`]));
  check("legacy 钉定 + --target=旧错误 ID → 拒绝", r4.status === 2, `${r4.status} ${r4.stderr}`);
  rmSync(fx4.dir, { recursive: true, force: true });
}

// 7. 权威来源：其他 ID 来源（dws 形态）不等于 staffId 时必须以连接器上下文为准
{
  // 真实回归（2026-11-02 真实测试）：某 ID 来源给出 FOREIGN_ID，上下文身份是 SELF_ID → 必须发 SELF_ID
  const fx = makeEnv({ context: "valid" });
  writeFileSync(
    join(fx.stateDir, "..", "dws-decoy.json"),
    JSON.stringify({ note: "dws user_id 形态", user_id: FOREIGN_ID }),
  );
  const r = run(fx.env, sendArgs("自举发送"));
  check(
    "自举目标=上下文身份而非其他 ID 来源",
    r.status === 0 && paramsOf(openclawCalls(fx.logFile)[0]).target === `user:${SELF_ID}`,
    `${r.status} ${r.stderr}`,
  );
  check(
    "自举写入 owner 文件且标记 connector-context",
    (() => {
      try {
        const o = JSON.parse(readFileSync(ownerFileOf(fx.stateDir), "utf8"));
        return o.ownerTarget === `user:${SELF_ID}` && o.verifiedVia === "connector-context";
      } catch {
        return false;
      }
    })(),
    r.stdout,
  );
  rmSync(fx.dir, { recursive: true, force: true });
}

// 7. --set-owner：与上下文一致才钉定；上下文歧义/损坏时 fail-closed
{
  const fx = makeEnv({ context: "valid" });
  const r1 = run(fx.env, ["--set-owner", `user:${SELF_ID}`]);
  check(
    "set-owner 与上下文一致 → 钉定成功",
    r1.status === 0 && r1.stdout.includes('"verifiedVia":"connector-context"'),
    `${r1.status} ${r1.stderr} ${r1.stdout}`,
  );
  const r2 = run(fx.env, ["--set-owner", `user:${FOREIGN_ID}`]);
  check(
    "set-owner foreign → 拒绝（退出 2）",
    r2.status === 2 && r2.stderr.includes("foreign"),
    `${r2.status} ${r2.stderr}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });

  for (const [mode, label] of [
    ["multi", "上下文多身份"],
    ["corrupt", "上下文损坏"],
    ["badshape", "上下文形态非法"],
    ["empty", "上下文无 inbound"],
    ["missing-sender", "inbound 缺 senderId"],
    ["nonnumeric-sender", "senderId 非数字"],
    ["absent", "上下文文件缺失"],
  ]) {
    const fxA = makeEnv({ context: mode });
    const ra = run(fxA.env, sendArgs("x"));
    check(`${label} → 自举拒绝（退出 2）`, ra.status === 2, `${ra.status} ${ra.stderr}`);
    const rb = run(fxA.env, ["--set-owner", `user:${SELF_ID}`]);
    check(`${label} → set-owner 拒绝（退出 2）`, rb.status === 2, `${rb.status} ${rb.stderr}`);
    check(`${label} → 不写 owner 文件`, !existsSync(ownerFileOf(fxA.stateDir)));
    rmSync(fxA.dir, { recursive: true, force: true });
  }
}

// 8. 目标安全负例：group:、空 ID、他人 ID、非数字 ID、损坏 owner 文件、旧缓存被忽略、env foreign
{
  const fx = makeEnv();
  pinOwner(fx);
  const r1 = run(fx.env, sendArgs("x", ["--target", "group:cidabc"]));
  check(
    "group: 目标 → 退出 2",
    r1.status === 2 && r1.stderr.includes("目标安全拒绝"),
    `${r1.status} ${r1.stderr}`,
  );
  const r2 = run(fx.env, sendArgs("x", ["--target", ""]));
  check(
    "空 --target 按未携带处理（发给钉定本人）",
    r2.status === 0 && paramsOf(openclawCalls(fx.logFile).at(-1)).target === `user:${SELF_ID}`,
    `${r2.status} ${r2.stderr}`,
  );
  const r3 = run(fx.env, sendArgs("x", ["--target", `user:${FOREIGN_ID}`]));
  check(
    "他人 user:<id> → 退出 2",
    r3.status === 2 && r3.stderr.includes("不一致"),
    `${r3.status} ${r3.stderr}`,
  );
  const r4 = run(fx.env, sendArgs("x", ["--target", "user:abc"]));
  check("非数字 ID → 退出 2", r4.status === 2, `${r4.status} ${r4.stderr}`);
  rmSync(fx.dir, { recursive: true, force: true });

  const fx2 = makeEnv();
  writeFileSync(
    ownerFileOf(fx2.stateDir),
    `${JSON.stringify({ ownerTarget: "group:cidpolluted" })}\n`,
  );
  const r5 = run(fx2.env, sendArgs("x"));
  check(
    "owner 文件被污染（group:）→ 退出 2",
    r5.status === 2 && r5.stderr.includes("非法"),
    `${r5.status} ${r5.stderr}`,
  );
  rmSync(fx2.dir, { recursive: true, force: true });

  const fx3 = makeEnv();
  writeFileSync(ownerFileOf(fx3.stateDir), "not-json");
  const r6 = run(fx3.env, sendArgs("x"));
  check("owner 文件损坏（非 JSON）→ 退出 2", r6.status === 2, `${r6.status} ${r6.stderr}`);
  rmSync(fx3.dir, { recursive: true, force: true });

  const fx4 = makeEnv();
  pinOwner(fx4);
  writeFileSync(
    join(fx4.stateDir, "notify-target.json"),
    `${JSON.stringify({ target: `user:${FOREIGN_ID}` })}\n`,
  );
  const r7 = run(fx4.env, sendArgs("x"));
  check(
    "旧缓存 foreign 目标被忽略（仍发钉定本人）",
    r7.status === 0 && paramsOf(openclawCalls(fx4.logFile)[0]).target === `user:${SELF_ID}`,
    `${r7.status} ${r7.stderr}`,
  );
  rmSync(fx4.dir, { recursive: true, force: true });

  const fx5 = makeEnv();
  pinOwner(fx5);
  const r8 = run({ ...fx5.env, DINGTALK_NOTIFY_TARGET: `user:${FOREIGN_ID}` }, sendArgs("x"));
  check("env foreign 目标 → 退出 2", r8.status === 2, `${r8.status} ${r8.stderr}`);
  rmSync(fx5.dir, { recursive: true, force: true });
}

// 9. 参数校验：标题超长 / 空正文 / 缺 --text / set-owner 形态非法 → 退出 2
{
  const fx = makeEnv();
  pinOwner(fx);
  const r1 = run(fx.env, ["--title", "这".repeat(21), "--text", "正文"]);
  check("标题 >20 字 → 退出 2", r1.status === 2, `实际 ${r1.status}`);
  const r2 = run(fx.env, ["--title", "标题", "--text", "   "]);
  check("空正文 → 退出 2", r2.status === 2, `实际 ${r2.status}`);
  const r3 = run(fx.env, ["--title", "标题"]);
  check("缺 --text → 退出 2", r3.status === 2, `实际 ${r3.status}`);
  const r4 = run(fx.env, ["--set-owner", "group:cidabc"]);
  check("set-owner group: → 退出 2", r4.status === 2, `实际 ${r4.status}`);
  const r5 = run(fx.env, ["--set-owner", "user:"]);
  check("set-owner 空 ID → 退出 2", r5.status === 2, `实际 ${r5.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 10. --dry-run：打印计划、零调用、无副作用（不写钉定）
{
  const fx = makeEnv();
  const r0 = run(fx.env, sendArgs("钉定前干跑", ["--dry-run"]));
  check(
    "未钉定 dry-run 预览上下文身份",
    r0.status === 0 && r0.stdout.includes(`user:${SELF_ID}`),
    `${r0.status} ${r0.stderr}`,
  );
  check("dry-run 不写钉定文件", !existsSync(ownerFileOf(fx.stateDir)));
  pinOwner(fx);
  const r = run(fx.env, sendArgs("干跑内容", ["--dry-run"]));
  check("dry-run 退出码 0", r.status === 0, r.stderr);
  check("dry-run 零 gateway 调用", openclawCalls(fx.logFile).length === 0);
  check("dry-run 输出包含 useAICard=false", r.stdout.includes('"useAICard": false'));
  check("dry-run 输出包含钉定目标", r.stdout.includes(`user:${SELF_ID}`));
  rmSync(fx.dir, { recursive: true, force: true });
}

// 11. stdin 正文（--text -）
{
  const fx = makeEnv();
  pinOwner(fx);
  const r = run(fx.env, ["--title", "stdin测试", "--text", "-"], {
    stdin: "第一行\n\n**加粗** 第二行\n",
  });
  check("stdin 正文退出码 0", r.status === 0, r.stderr);
  const calls = openclawCalls(fx.logFile);
  check(
    "stdin 内容原样送达",
    calls.length === 1 && paramsOf(calls[0]).content.includes("**加粗** 第二行"),
    r.stderr,
  );
  rmSync(fx.dir, { recursive: true, force: true });
}

// 12. 多块中第 2 块失败 → 退出 1 且报告部分送达
{
  const fx = makeEnv();
  pinOwner(fx);
  const para = "块内容。".repeat(400);
  const text = Array.from({ length: 8 }, (_, i) => `${para} 行${i + 1}`).join("\n");
  const mock = fx.env.DINGTALK_NOTIFY_OPENCLAW;
  writeFileSync(
    mock,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ bin: "openclaw", argv: process.argv.slice(2) }) + "\\n");
const calls = fs.readFileSync(process.env.MOCK_LOG, "utf8").trim().split("\\n").filter((l) => l.includes("\\"bin\\":\\"openclaw\\"")).length;
if (calls === 2) { process.stderr.write("second chunk boom\\n"); process.exit(1); }
process.stdout.write('{"ok":true}\\n');
`,
  );
  chmodSync(mock, 0o755);
  const r = run(fx.env, sendArgs(text));
  check("部分送达退出码 1", r.status === 1, `实际 ${r.status}`);
  check("部分送达报告进度", /已送达 1\/\d+ 块/.test(r.stderr), r.stderr);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
