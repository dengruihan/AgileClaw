// dingtalk-notify 包装器的 fixture 干跑验证（不触碰真实 Gateway / 钉钉 / dws）。
// 用 Mock 的 openclaw / dws 验证：调用参数、AI 卡片关闭、本人目标强制、
// code-point 安全分块、失败与部分送达行为。退出码 0 = 全部通过。
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

// 每个用例一个独立 tmp 目录：mock bin/（openclaw、dws）、state/、调用日志。
function makeEnv({
  dwsUserId = SELF_ID,
  dwsFail = false,
  openclawStdout = '{"ok":true,"processQueryKey":"pqk-1"}',
  openclawCode = 0,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dt-notify-"));
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "state");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  const logFile = join(dir, "calls.jsonl");

  const openclawMock = join(binDir, "openclaw");
  writeFileSync(
    openclawMock,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ bin: "openclaw", argv: process.argv.slice(2) }) + "\\n");
const out = process.env.MOCK_OPENCLAW_STDOUT || "";
const code = Number(process.env.MOCK_OPENCLAW_CODE || 0);
if (out) process.stdout.write(out + "\\n");
process.exit(code);
`,
  );
  const dwsMock = join(binDir, "dws");
  writeFileSync(
    dwsMock,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify({ bin: "dws", argv: process.argv.slice(2) }) + "\\n");
if (process.env.MOCK_DWS_FAIL === "1") { process.stderr.write("dws auth expired\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ user_id: process.env.MOCK_DWS_USER_ID || "${SELF_ID}" }) + "\\n");
`,
  );
  chmodSync(openclawMock, 0o755);
  chmodSync(dwsMock, 0o755);

  return {
    dir,
    stateDir,
    logFile,
    env: {
      ...process.env,
      DINGTALK_NOTIFY_OPENCLAW: openclawMock,
      DINGTALK_NOTIFY_DWS: dwsMock,
      DINGTALK_NOTIFY_STATE_DIR: stateDir,
      MOCK_LOG: logFile,
      MOCK_OPENCLAW_STDOUT: openclawStdout,
      MOCK_OPENCLAW_CODE: String(openclawCode),
      MOCK_DWS_FAIL: dwsFail ? "1" : "0",
      MOCK_DWS_USER_ID: dwsUserId,
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
const dwsCalls = (logFile) =>
  readLog(logFile)
    .filter((e) => e.bin === "dws")
    .map((e) => e.argv);
const paramsOf = (argv) => JSON.parse(argv[argv.indexOf("--params") + 1]);
const ownerFileOf = (stateDir) => join(stateDir, "notify-owner.json");
const pinOwner = (fx, id = SELF_ID) => {
  writeFileSync(
    ownerFileOf(fx.stateDir),
    `${JSON.stringify({ ownerTarget: `user:${id}`, verifiedVia: "test-pin", pinnedAt: "2026-11-02T00:00:00.000Z" }, null, 2)}\n`,
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
  check("钉定后不再调用 dws", dwsCalls(fx.logFile).length === 0);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 2. 长消息：按行分块、每块 ≤1900、标题只在首块、顺序保持
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

// 3. emoji 边界：超长单行在 emoji 上硬切不拆代理对；多块含 emoji 可无损还原
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

// 4. Gateway 返回 ok:false → 退出 1 + 灯效回退提示
{
  const fx = makeEnv({ openclawStdout: '{"ok":false,"error":"DingTalk not configured"}' });
  pinOwner(fx);
  const r = run(fx.env, sendArgs("故障告警测试"));
  check("ok:false 退出码 1", r.status === 1, `实际 ${r.status}`);
  check("ok:false 给出灯效回退提示", r.stderr.includes("ntf.cjs light send"), r.stderr);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 5. openclaw 进程非零退出 / 非 JSON 输出 → 退出 1
{
  const fx = makeEnv({ openclawCode: 1, openclawStdout: "" });
  pinOwner(fx);
  const r1 = run(fx.env, sendArgs("进程失败测试"));
  check("非零退出码透传为 1", r1.status === 1, `实际 ${r1.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
  const fx2 = makeEnv({ openclawStdout: "<html>Gateway Error</html>" });
  pinOwner(fx2);
  const r2 = run(fx2.env, sendArgs("非JSON测试"));
  check("非 JSON 输出退出码 1", r2.status === 1, `实际 ${r2.status}`);
  rmSync(fx2.dir, { recursive: true, force: true });
}

// 6. --set-owner：dws 核验、foreign 拒绝、dws 不可用时手工钉定
{
  const fx = makeEnv();
  const r1 = run(fx.env, ["--set-owner", `user:${SELF_ID}`]);
  check(
    "set-owner 与 dws 一致 → 钉定成功",
    r1.status === 0 && r1.stdout.includes('"verifiedVia":"dws-auth-status"'),
    `${r1.status} ${r1.stderr} ${r1.stdout}`,
  );
  check("set-owner 写入 owner 文件", existsSync(ownerFileOf(fx.stateDir)));
  rmSync(fx.dir, { recursive: true, force: true });

  const fx2 = makeEnv({ dwsUserId: FOREIGN_ID });
  const r2 = run(fx2.env, ["--set-owner", `user:${SELF_ID}`]);
  check(
    "set-owner 与 dws 不一致 → 拒绝 foreign（退出 2）",
    r2.status === 2 && r2.stderr.includes("foreign"),
    `${r2.status} ${r2.stderr}`,
  );
  check("foreign set-owner 不写文件", !existsSync(ownerFileOf(fx2.stateDir)));
  rmSync(fx2.dir, { recursive: true, force: true });

  const fx3 = makeEnv({ dwsFail: true });
  const r3 = run(fx3.env, ["--set-owner", `user:${SELF_ID}`]);
  check(
    "dws 不可用时手工 set-owner → 钉定（manual-deploy）",
    r3.status === 0 && r3.stdout.includes('"verifiedVia":"manual-deploy"'),
    `${r3.status} ${r3.stderr} ${r3.stdout}`,
  );
  check(
    "手工钉定后发送无需 dws/其他来源",
    (() => {
      const r = run(fx3.env, sendArgs("钉定后发送"));
      return (
        r.status === 0 &&
        openclawCalls(fx3.logFile).length === 1 &&
        paramsOf(openclawCalls(fx3.logFile)[0]).target === `user:${SELF_ID}`
      );
    })(),
  );
  rmSync(fx3.dir, { recursive: true, force: true });
}

// 7. 目标安全负例：group:、空 ID、他人 ID、stale flag、损坏 owner 文件、旧缓存被忽略
{
  const fx = makeEnv();
  pinOwner(fx);
  const r1 = run(fx.env, sendArgs("x", ["--target", `group:cidabc`]));
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

  // 损坏的 owner 文件（group: 污染）→ 拒绝
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

  // owner 文件非 JSON → 拒绝
  const fx3 = makeEnv();
  writeFileSync(ownerFileOf(fx3.stateDir), "not-json");
  const r6 = run(fx3.env, sendArgs("x"));
  check("owner 文件损坏（非 JSON）→ 退出 2", r6.status === 2, `${r6.status} ${r6.stderr}`);
  rmSync(fx3.dir, { recursive: true, force: true });

  // 旧版 notify-target.json（foreign）存在但不得被读取
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

  // env 变量与钉定不一致 → 拒绝
  const fx5 = makeEnv();
  pinOwner(fx5);
  const r8 = run({ ...fx5.env, DINGTALK_NOTIFY_TARGET: `user:${FOREIGN_ID}` }, sendArgs("x"));
  check("env foreign 目标 → 退出 2", r8.status === 2, `${r8.status} ${r8.stderr}`);
  rmSync(fx5.dir, { recursive: true, force: true });
}

// 8. 自举：无钉定时 dws 可用 → 解析并钉定；dws 不可用 → 退出 2
{
  const fx = makeEnv();
  const r = run(fx.env, sendArgs("自举发送"));
  check("无钉定 + dws 可用 → 自举发送成功", r.status === 0, `${r.status} ${r.stderr}`);
  check("自举写入 owner 文件", existsSync(ownerFileOf(fx.stateDir)));
  const r2 = run(fx.env, sendArgs("再次发送"));
  check(
    "自举后第二次发送不依赖 dws",
    r2.status === 0 && dwsCalls(fx.logFile).length === 1,
    `${r2.status} ${r2.stderr}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });

  const fx2 = makeEnv({ dwsFail: true });
  const r3 = run(fx2.env, sendArgs("无钉定 dws 挂"));
  check("无钉定 + dws 不可用 → 退出 2", r3.status === 2, `实际 ${r3.status}`);
  rmSync(fx2.dir, { recursive: true, force: true });
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

// 10. --dry-run：打印计划、零调用；钉定后可复现同一计划
{
  const fx = makeEnv();
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
