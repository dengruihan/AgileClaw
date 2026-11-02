#!/usr/bin/env node
// dingtalk-notify.mjs — collector 通知出口：私人钉钉机器人普通 Markdown 单聊（非 AI 卡片）。
//
// 发送通道：本机 Gateway 的插件 Gateway 方法 `dingtalk-connector.send`，
// 参数 useAICard:false + msgType:"markdown" → 钉钉 robot/oToMessages/batchSend
//（msgKey sampleMarkdown）。AI 卡片由连接器默认发送路径（useAICard 默认 true）产生，
// 本脚本显式关闭。
//
// 目标安全模型：只发本人单聊。部署时核验的本人 staffId 是唯一固定目标，钉在
// state/notify-owner.json（只能由 --set-owner 或 dws 自举写入）。
// --target / DINGTALK_NOTIFY_TARGET 仅允许精确等于已钉定的 user:<本人staffId>；
// group:、空 ID、他人 ID、损坏/陈旧状态一律拒绝。旧版 notify-target.json 不再被读取。
//
// 职责边界：只负责把一条通知送达本人钉钉单聊。去重（每源每日一次、便单/日程查重）
// 与是否需要通知由 collector 唤醒轮 Agent 按既有规则判断，本脚本不做。
// 不读取、不输出、不缓存任何凭据；认证由 Gateway 进程持有。
//
// 用法：
//   node dingtalk-notify.mjs --set-owner user:<staffId>   # 部署期钉定本人目标（一次性）
//   node dingtalk-notify.mjs --title "标题(≤20字)" --text "正文"
//   echo "正文" | node dingtalk-notify.mjs --title "标题" --text -
//   node dingtalk-notify.mjs --title "标题" --text "正文" --dry-run   # 只打印调用，不发送
//
// 退出码：0 全部块送达；1 发送失败（可能部分送达，stderr 写明进度与灯效回退命令）；
//         2 参数/目标解析错误（含目标安全拒绝）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.DINGTALK_NOTIFY_STATE_DIR || join(scriptDir, "state");
const ownerFile = join(stateDir, "notify-owner.json");
const OPENCLAW_BIN = process.env.DINGTALK_NOTIFY_OPENCLAW || "openclaw";
const DWS_BIN = process.env.DINGTALK_NOTIFY_DWS || "dws";
const MAX_CHARS = Number(process.env.DINGTALK_NOTIFY_MAX_CHARS || 1900);
const GATEWAY_METHOD = "dingtalk-connector.send";
const GATEWAY_TIMEOUT_MS = 30000;

const fail = (code, msg) => {
  process.stderr.write(`dingtalk-notify: ${msg}\n`);
  process.exit(code);
};

// ---- 本人目标解析与钉定 ----
// 唯一合法目标形态：user:<纯数字 ID>。staffId/unionId 均为纯数字串；
// 该正则同时拒绝 group:、cid、空 ID 与任意非本人形态。
const parseUserTarget = (raw) => {
  const m = /^user:([0-9]+)$/.exec(String(raw ?? "").trim());
  return m ? { id: m[1], target: m[0] } : null;
};

const dwsSelfId = () => {
  const r = spawnSync(DWS_BIN, ["auth", "status", "--format", "json"], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || "").trim() || "无输出" };
  try {
    const id = JSON.parse(String(r.stdout || "")).user_id;
    return typeof id === "string" && id ? { ok: true, id } : { ok: false, error: "缺少 user_id" };
  } catch {
    return { ok: false, error: "输出非 JSON" };
  }
};

const pinOwner = (parsed, verifiedVia) => {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      ownerFile,
      `${JSON.stringify({ ownerTarget: parsed.target, verifiedVia, pinnedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  } catch (err) {
    fail(2, `无法写入目标钉定文件 ${ownerFile}：${err.message}`);
  }
  return parsed;
};

const readPinnedOwner = () => {
  if (!existsSync(ownerFile)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(ownerFile, "utf8"));
  } catch {
    fail(2, `目标钉定文件 ${ownerFile} 损坏（非 JSON）；请重新执行 --set-owner user:<本人staffId>`);
  }
  const parsed = parseUserTarget(raw?.ownerTarget);
  if (!parsed) {
    fail(
      2,
      `目标钉定文件 ${ownerFile} 内容非法（${JSON.stringify(raw?.ownerTarget)}）；仅接受部署时核验的 user:<本人staffId>，请重新 --set-owner`,
    );
  }
  return parsed;
};

// 解析本次发送要用的目标。flag/env 只是「显式携带已钉定目标」的通道，
// 必须精确匹配钉定值；未钉定时唯一自举路径是 dws（其 user_id 由本人授权登录，天然是本人）。
const resolveSendTarget = (flagTarget, envTarget) => {
  const pinned = readPinnedOwner();
  const explicit = flagTarget ?? envTarget ?? "";
  if (explicit.toString().trim() !== "") {
    const parsed = parseUserTarget(explicit);
    if (!parsed)
      fail(
        2,
        `目标安全拒绝：--target/DINGTALK_NOTIFY_TARGET 只能是已核验的 user:<本人staffId>（收到 ${JSON.stringify(String(explicit))}）；group:、空 ID 与其他形态一律不接受`,
      );
    if (!pinned)
      fail(2, "目标尚未钉定：先执行 --set-owner user:<本人staffId>（部署时经 dws 核验）再发送");
    if (parsed.id !== pinned.id)
      fail(
        2,
        `目标安全拒绝：${parsed.target} 与部署时核验的本人目标 ${pinned.target} 不一致（stale/foreign 目标）`,
      );
    return pinned;
  }
  if (pinned) return pinned;
  const self = dwsSelfId();
  if (!self.ok) {
    fail(
      2,
      `目标尚未钉定，且无法通过 ${DWS_BIN} auth status 自举（${self.error}）。部署时先执行 --set-owner user:<本人staffId>`,
    );
  }
  const parsed = parseUserTarget(`user:${self.id}`);
  if (!parsed) fail(2, `${DWS_BIN} auth status 返回的 user_id 非法：${JSON.stringify(self.id)}`);
  return pinOwner(parsed, "dws-auth-status");
};

// ---- 参数 ----
const argv = process.argv.slice(2);
const args = {
  title: undefined,
  text: undefined,
  target: undefined,
  setOwner: undefined,
  dryRun: false,
};
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--title") args.title = argv[++i];
  else if (a === "--text") args.text = argv[++i];
  else if (a === "--target") args.target = argv[++i];
  else if (a === "--set-owner") args.setOwner = argv[++i];
  else if (a === "--dry-run") args.dryRun = true;
  else fail(2, `未知参数 ${a}（支持 --title/--text/--target/--set-owner/--dry-run）`);
}

if (args.setOwner !== undefined) {
  const parsed = parseUserTarget(args.setOwner);
  if (!parsed)
    fail(
      2,
      `--set-owner 只接受 user:<纯数字 staffId>（收到 ${JSON.stringify(args.setOwner)}）；拒绝 group:/空 ID/其他形态`,
    );
  const self = dwsSelfId();
  if (self.ok && self.id !== parsed.id) {
    fail(
      2,
      `目标安全拒绝：--set-owner ${parsed.target} 与 ${DWS_BIN} auth status 的本人 user_id 不一致（foreign 目标）`,
    );
  }
  pinOwner(parsed, self.ok ? "dws-auth-status" : "manual-deploy");
  process.stdout.write(
    `${JSON.stringify({ ok: true, ownerTarget: parsed.target, verifiedVia: self.ok ? "dws-auth-status" : "manual-deploy" })}\n`,
  );
  process.exit(0);
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

// ---- 分块（钉钉单条上限 2000 字符；按 code point 计并在 code point 边界硬切，
//       绝不拆开 UTF-16 代理对） ----
const chunkText = (body, limit) => {
  const chunks = [];
  let cur = "";
  const cpl = (s) => [...s].length;
  const flush = () => {
    if (cur) chunks.push(cur);
    cur = "";
  };
  for (const line of body.split("\n")) {
    if (cpl(line) > limit) {
      flush();
      const cps = Array.from(line);
      for (let i = 0; i < cps.length; i += limit) chunks.push(cps.slice(i, i + limit).join(""));
      continue;
    }
    const candidate = cur ? `${cur}\n${line}` : line;
    if (cpl(candidate) <= limit) cur = candidate;
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
  const params = { target: target.target, content, msgType: "markdown", useAICard: false };
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
  const target = resolveSendTarget(args.target, process.env.DINGTALK_NOTIFY_TARGET);
  const chunks = chunkText(text, MAX_CHARS);
  const plan = chunks.map((content, i) => ({
    content,
    title: i === 0 ? args.title : undefined,
  }));

  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify({ dryRun: true, target: target.target, verifiedVia: target.verifiedVia ?? "pinned", chunks: plan.length, maxChars: MAX_CHARS, sends: plan.map((p) => ({ method: GATEWAY_METHOD, params: { target: target.target, content: p.content, msgType: "markdown", useAICard: false, ...(p.title ? { title: p.title } : {}) } })) }, null, 2)}\n`,
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
  process.stdout.write(`${JSON.stringify({ ok: true, chunks: sent, target: target.target })}\n`);
  return 0;
};

process.exit(main());
