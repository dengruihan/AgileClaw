// dingtalk-notify 包装器的 fixture 干跑验证（不触碰真实 Gateway / 钉钉 / dws）。
// 用 Mock 的 openclaw / dws 可执行文件验证：调用参数、AI 卡片关闭、目标解析、
// 分块、失败与部分送达行为。退出码 0 = 全部通过。
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const WRAPPER = fileURLToPath(
  new URL(
    "../files/home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs",
    import.meta.url,
  ),
);
const STAFF_ID = "300000000000000000";

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
  dwsUserId = STAFF_ID,
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
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
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
if (process.env.MOCK_DWS_FAIL === "1") { process.stderr.write("dws auth expired\\n"); process.exit(1); }
process.stdout.write(JSON.stringify({ user_id: process.env.MOCK_DWS_USER_ID || "${STAFF_ID}" }) + "\\n");
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

const readCalls = (logFile) => {
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

const sendArgs = (text, extra = []) => ["--title", "测试标题", "--text", text, ...extra];

// 1. 短消息：单次调用，参数关闭 AI 卡片、Markdown、目标与标题正确
{
  const fx = makeEnv();
  const r = run(fx.env, sendArgs("云谷课堂新增 1 项作业，截止周日 22:00。"));
  check("短消息退出码 0", r.status === 0, `实际 ${r.status}：${r.stderr}`);
  const calls = readCalls(fx.logFile);
  check("短消息恰好 1 次 gateway 调用", calls.length === 1, `实际 ${calls.length}`);
  const argv = calls[0] ?? [];
  const pi = argv.indexOf("--params");
  const params = pi >= 0 ? JSON.parse(argv[pi + 1]) : {};
  check("方法为 dingtalk-connector.send", argv[2] === "dingtalk-connector.send", argv[2]);
  check("useAICard=false（非 AI 卡片）", params.useAICard === false, JSON.stringify(params));
  check("msgType=markdown", params.msgType === "markdown");
  check("目标为本人单聊 user:<staffId>", params.target === `user:${STAFF_ID}`, params.target);
  check("标题随首块传递", params.title === "测试标题");
  check("stdout 报 ok", r.stdout.includes('"ok":true'), r.stdout);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 2. 长消息：按行分块、每块 ≤1900、标题只在首块、顺序保持
{
  const fx = makeEnv();
  const para = "这是第N行内容，用来把消息撑过单块上限。".repeat(20);
  const text = Array.from({ length: 60 }, (_, i) => `${para} 行${i + 1}`).join("\n");
  check("fixture 文本超过单块上限", text.length > 1900, `长度 ${text.length}`);
  const r = run(fx.env, sendArgs(text));
  check("长消息退出码 0", r.status === 0, `实际 ${r.status}：${r.stderr}`);
  const calls = readCalls(fx.logFile);
  const paramsList = calls.map((argv) => JSON.parse(argv[argv.indexOf("--params") + 1]));
  check(
    "长消息产生多个块",
    calls.length >= 2,
    `实际 ${calls.length}；wrapper stderr: ${r.stderr.trim()}`,
  );
  check(
    "每块 ≤1900 字符",
    paramsList.every((p) => p.content.length <= 1900),
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
  const rejoined = paramsList.map((p) => p.content).join("\n");
  check(
    "拼接后等于原文",
    rejoined === text,
    `块数 ${paramsList.length}，stderr: ${r.stderr.trim()}`,
  );
  rmSync(fx.dir, { recursive: true, force: true });
}

// 3. Gateway 返回 ok:false → 退出 1 + 灯效回退提示
{
  const fx = makeEnv({ openclawStdout: '{"ok":false,"error":"DingTalk not configured"}' });
  const r = run(fx.env, sendArgs("故障告警测试"));
  check("ok:false 退出码 1", r.status === 1, `实际 ${r.status}`);
  check("ok:false 给出灯效回退提示", r.stderr.includes("ntf.cjs light send"), r.stderr);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 4. openclaw 进程非零退出 → 退出 1
{
  const fx = makeEnv({ openclawCode: 1, openclawStdout: "" });
  const r = run(fx.env, sendArgs("进程失败测试"));
  check("非零退出码透传为 1", r.status === 1, `实际 ${r.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 5. Gateway 返回非 JSON → 退出 1
{
  const fx = makeEnv({ openclawStdout: "<html>Gateway Error</html>" });
  const r = run(fx.env, sendArgs("非JSON测试"));
  check("非 JSON 输出退出码 1", r.status === 1, `实际 ${r.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 6. 目标解析：state 文件优先；缺失时 dws 解析并写缓存；dws 失败 → 退出 2
{
  const fx = makeEnv();
  writeFileSync(
    join(fx.stateDir, "notify-target.json"),
    JSON.stringify({ target: `user:${STAFF_ID}` }),
  );
  const r1 = run(fx.env, sendArgs("state 文件目标"));
  check("state 文件目标可用", r1.status === 0, r1.stderr);
  rmSync(join(fx.stateDir, "notify-target.json"), { force: true });
  const r2 = run(fx.env, sendArgs("dws 解析目标"));
  check("dws 解析目标可用", r2.status === 0, r2.stderr);
  check(
    "dws 解析写入缓存文件",
    (() => {
      try {
        return (
          JSON.parse(readFileSync(join(fx.stateDir, "notify-target.json"), "utf8")).target ===
          `user:${STAFF_ID}`
        );
      } catch {
        return false;
      }
    })(),
  );
  rmSync(join(fx.stateDir, "notify-target.json"), { force: true });
  const fxFailEnv = { ...fx.env, MOCK_DWS_FAIL: "1" };
  const r3 = run(fxFailEnv, sendArgs("无目标且 dws 失败"));
  check("无目标且 dws 失败 → 退出 2", r3.status === 2, `实际 ${r3.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 7. 参数校验：标题超长 / 空正文 → 退出 2
{
  const fx = makeEnv();
  const r1 = run(fx.env, ["--title", "这".repeat(21), "--text", "正文"]);
  check("标题 >20 字 → 退出 2", r1.status === 2, `实际 ${r1.status}`);
  const r2 = run(fx.env, ["--title", "标题", "--text", "   "]);
  check("空正文 → 退出 2", r2.status === 2, `实际 ${r2.status}`);
  const r3 = run(fx.env, ["--title", "标题"]);
  check("缺 --text → 退出 2", r3.status === 2, `实际 ${r3.status}`);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 8. --dry-run：打印计划、零调用
{
  const fx = makeEnv();
  const r = run(fx.env, sendArgs("干跑内容", ["--dry-run"]));
  check("dry-run 退出码 0", r.status === 0, r.stderr);
  check("dry-run 零 gateway 调用", !existsAnyCall(fx.logFile));
  check("dry-run 输出包含 useAICard=false", r.stdout.includes('"useAICard": false'));
  check("dry-run 输出包含目标", r.stdout.includes(`user:${STAFF_ID}`));
  rmSync(fx.dir, { recursive: true, force: true });
}

function existsAnyCall(logFile) {
  try {
    return readFileSync(logFile, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

// 9. stdin 正文（--text -）
{
  const fx = makeEnv();
  const r = run(fx.env, ["--title", "stdin测试", "--text", "-"], {
    stdin: "第一行\n\n**加粗** 第二行\n",
  });
  check("stdin 正文退出码 0", r.status === 0, r.stderr);
  const calls = readCalls(fx.logFile);
  const params = calls.length ? JSON.parse(calls[0][calls[0].indexOf("--params") + 1]) : {};
  check("stdin 内容原样送达", params.content?.includes("**加粗** 第二行"), r.stderr);
  rmSync(fx.dir, { recursive: true, force: true });
}

// 10. 多块中第 2 块失败 → 退出 1 且报告部分送达
{
  const fx = makeEnv();
  const para = "块内容。".repeat(400);
  const text = Array.from({ length: 8 }, (_, i) => `${para} 行${i + 1}`).join("\n");
  let n = 0;
  // 前一次成功、第二次失败：用一个可变 mock 太复杂，改为第二次调用直接非零退出。
  const mock = fx.env.DINGTALK_NOTIFY_OPENCLAW;
  writeFileSync(
    mock,
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.MOCK_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
const calls = fs.readFileSync(process.env.MOCK_LOG, "utf8").trim().split("\\n").length;
if (calls === 2) { process.stderr.write("second chunk boom\\n"); process.exit(1); }
process.stdout.write('{"ok":true}\\n');
`,
  );
  const r = run(fx.env, sendArgs(text));
  check("部分送达退出码 1", r.status === 1, `实际 ${r.status}`);
  check("部分送达报告进度", /已送达 1\/\d+ 块/.test(r.stderr), r.stderr);
  rmSync(fx.dir, { recursive: true, force: true });
}

console.log(results.join("\n"));
console.log(`\n${passed} 通过, ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
