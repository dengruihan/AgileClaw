#!/usr/bin/env node
// dingtalk-notify.mjs — collector 通知出口：私人钉钉机器人普通 Markdown 单聊（非 AI 卡片）。
//
// 发送通道：本机 Gateway 的插件 Gateway 方法 `dingtalk-connector.send`，
// 参数 useAICard:false + msgType:"markdown" → 钉钉 robot/oToMessages/batchSend
//（msgKey sampleMarkdown）。AI 卡片由连接器默认发送路径（useAICard 默认 true）产生，
// 本脚本显式关闭。
//
// 职责边界：只负责把一条通知送达本人钉钉单聊。去重（每源每日一次、便单/日程查重）
// 与是否需要通知由 collector 唤醒轮 Agent 按既有规则判断，本脚本不做。
// 不读取、不输出、不缓存任何凭据；认证由 Gateway 进程持有。
//
// 用法：
//   node dingtalk-notify.mjs --title "标题(≤20字)" --text "正文"
//   echo "正文" | node dingtalk-notify.mjs --title "标题" --text -
//   node dingtalk-notify.mjs --title "标题" --text "正文" --dry-run   # 只打印调用，不发送
//
// 退出码：0 全部块送达；1 发送失败（可能部分送达，stderr 写明进度与灯效回退命令）；
//         2 参数/目标解析错误。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.DINGTALK_NOTIFY_STATE_DIR || join(scriptDir, "state");
const targetFile = join(stateDir, "notify-target.json");
const OPENCLAW_BIN = process.env.DINGTALK_NOTIFY_OPENCLAW || "openclaw";
const DWS_BIN = process.env.DINGTALK_NOTIFY_DWS || "dws";
const MAX_CHARS = Number(process.env.DINGTALK_NOTIFY_MAX_CHARS || 1900);
const GATEWAY_METHOD = "dingtalk-connector.send";
const GATEWAY_TIMEOUT_MS = 30000;

const fail = (code, msg) => {
  process.stderr.write(`dingtalk-notify: ${msg}\n`);
  process.exit(code);
};

// ---- 参数 ----
const argv = process.argv.slice(2);
const args = { title: undefined, text: undefined, target: undefined, dryRun: false };
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--title") args.title = argv[++i];
  else if (a === "--text") args.text = argv[++i];
  else if (a === "--target") args.target = argv[++i];
  else if (a === "--dry-run") args.dryRun = true;
  else fail(2, `未知参数 ${a}（支持 --title/--text/--target/--dry-run）`);
}
if (!args.title || !args.title.trim()) fail(2, "--title 必填（≤20 字，用于会话列表预览）");
if (args.title.length > 20) fail(2, `--title 超过 20 字（当前 ${args.title.length} 字）`);
if (args.text === undefined || args.text === null) fail(2, "--text 必填（传 - 则从 stdin 读取）");
let text = args.text;
if (text === "-") {
  try {
    text = readFileSync(0, "utf8");
  } catch {
    fail(2, "无法从 stdin 读取 --text 内容");
  }
}
text = String(text).trim();
if (!text) fail(2, "正文为空");

// ---- 目标会话解析 ----
// 优先级：--target / DINGTALK_NOTIFY_TARGET > state/notify-target.json > dws auth status（并缓存）。
// 目标只可能是本人单聊（user:<staffId>）；本脚本不面向第三方发送。
const normalizeTarget = (raw) => {
  const t = String(raw || "").trim();
  if (!t) return null;
  return t.includes(":") ? t : `user:${t}`;
};
const resolveTarget = () => {
  const fromFlag = normalizeTarget(args.target || process.env.DINGTALK_NOTIFY_TARGET);
  if (fromFlag) return { target: fromFlag, source: "flag" };
  try {
    if (existsSync(targetFile)) {
      const cached = JSON.parse(readFileSync(targetFile, "utf8"));
      const t = normalizeTarget(cached.target);
      if (t) return { target: t, source: "state-file" };
    }
  } catch {
    // 缓存损坏则回落到 dws 重新解析
  }
  const r = spawnSync(DWS_BIN, ["auth", "status", "--format", "json"], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (r.status !== 0) {
    fail(
      2,
      `无法解析通知目标：state/notify-target.json 不存在，且 \`${DWS_BIN} auth status\` 失败（${String(r.stderr || "").trim() || "无输出"}）。部署时先按 README 写入目标。`,
    );
  }
  let userId;
  try {
    userId = JSON.parse(String(r.stdout || "")).user_id;
  } catch {
    fail(2, `无法从 ${DWS_BIN} auth status 输出解析 user_id`);
  }
  const t = normalizeTarget(userId);
  if (!t) fail(2, `${DWS_BIN} auth status 未返回 user_id`);
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      targetFile,
      `${JSON.stringify({ target: t, resolvedVia: "dws-auth-status" }, null, 2)}\n`,
    );
  } catch {
    // 缓存写入失败不影响本次发送
  }
  return { target: t, source: "dws" };
};

// ---- 分块（钉钉单条上限 2000 字符，留余量按行切，超长行硬切） ----
const chunkText = (body, limit) => {
  const chunks = [];
  let cur = "";
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };
  for (const line of body.split("\n")) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length <= limit) cur = candidate;
    else {
      flush();
      cur = line;
    }
  }
  flush();
  return chunks;
};

// ---- 发送 ----
const sendChunk = (target, content, title) => {
  const params = { target, content, msgType: "markdown", useAICard: false };
  if (title) params.title = title;
  const r = spawnSync(
    OPENCLAW_BIN,
    [
      "gateway",
      "call",
      GATEWAY_METHOD,
      "--params",
      JSON.stringify(params),
      "--json",
      "--timeout",
      String(GATEWAY_TIMEOUT_MS),
    ],
    { encoding: "utf8", timeout: GATEWAY_TIMEOUT_MS + 10000 },
  );
  if (r.error) return { ok: false, error: `调用失败：${r.error.message}` };
  if (r.status !== 0) {
    return {
      ok: false,
      error: `openclaw 退出码 ${r.status}：${String(r.stderr || "")
        .trim()
        .slice(0, 300)}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(r.stdout || "").trim());
  } catch {
    return {
      ok: false,
      error: `Gateway 返回非 JSON：${String(r.stdout || "")
        .trim()
        .slice(0, 300)}`,
    };
  }
  // respond(false, {...}) 仍可能整体 RPC 成功（退出码 0），必须看 ok 字段。
  if (!parsed || parsed.ok !== true) {
    return {
      ok: false,
      error: `Gateway 拒绝：${JSON.stringify(parsed?.error ?? parsed).slice(0, 300)}`,
    };
  }
  return { ok: true };
};

const main = () => {
  const { target, source } = resolveTarget();
  const chunks = chunkText(text, MAX_CHARS);
  const plan = chunks.map((content, i) => ({
    content,
    title: i === 0 ? args.title : undefined,
  }));

  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, target, targetSource: source, chunks: plan.length, maxChars: MAX_CHARS, sends: plan.map((p) => ({ method: GATEWAY_METHOD, params: { target, content: p.content, msgType: "markdown", useAICard: false, ...(p.title ? { title: p.title } : {}) } })) }, null, 2)}\n`,
    );
    return 0;
  }

  let sent = 0;
  for (const p of plan) {
    const r = sendChunk(target, p.content, p.title);
    if (!r.ok) {
      process.stderr.write(
        `dingtalk-notify: 发送失败（第 ${sent + 1}/${plan.length} 块）：${r.error}\n` +
          `已送达 ${sent}/${plan.length} 块。灯效回退：node ~/.openclaw/extensions/phone-notifications/dist/bin/ntf.cjs light send --segments '<JSON>' --title <标题> --reason <30字内原因>\n`,
      );
      return 1;
    }
    sent += 1;
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, chunks: sent, target, targetSource: source })}\n`,
  );
  return 0;
};

process.exit(main());
