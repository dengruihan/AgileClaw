#!/usr/bin/env node
// dingtalk-notify.mjs — collector 通知出口：私人钉钉机器人普通 Markdown 单聊（非 AI 卡片）。
//
// 发送通道：本机 Gateway 的插件 Gateway 方法 `dingtalk-connector.send`，
// 参数 useAICard:false + msgType:"markdown" → 钉钉 robot/oToMessages/batchSend
//（msgKey sampleMarkdown）。AI 卡片由连接器默认发送路径（useAICard 默认 true）产生，
// 本脚本显式关闭。
//
// 目标安全模型：只发本人单聊。本人接收目标钉定在 state/notify-owner.json，
// 权威来源是连接器自己的消息上下文（~/.openclaw/dingtalk-connector/message-context.json）
// 里本人私人会话 inbound 记录的 senderId——这是机器人 oToMessages/batchSend 真正接受的
// staffId（2026-11-02 真实测试证实 dws auth status 的 user_id 并非该 ID，调用会返回
// staffId.notExisted）。解析规则 fail-closed：只有全部 inbound 记录恰好呈现同一个纯数字
// senderId 时才可用；多条身份、无 inbound、senderId 缺失/非数字、文件损坏一律拒绝。
// --target / DINGTALK_NOTIFY_TARGET 仅允许精确等于已钉定的 user:<本人staffId>；
// group:、空 ID、他人 ID、损坏/陈旧状态一律拒绝。旧版 notify-target.json 不再被读取。
// 兼容迁移：verifiedVia 不是 connector-context 的旧钉定（含已被真实测试证伪的
// dws-auth-status 版本）在预览/发送前一律用连接器上下文重新验证——上下文恰一身份时
// 以它为最终目标并安全迁移钉定（dry-run 只预览不写入）；上下文不可判定时 fail-closed。
//
// 职责边界：只负责把一条通知送达本人钉钉单聊。去重（每源每日一次、便单/日程查重）
// 与是否需要通知由 collector 唤醒轮 Agent 按既有规则判断，本脚本不做。
// 不读取、不输出、不缓存任何凭据；认证由 Gateway 进程持有；目标 ID 只在本地 state
// 文件保存，不写进日志输出。
//
// 用法：
//   node dingtalk-notify.mjs --set-owner user:<staffId>   # 部署期钉定本人目标（一次性，须与上下文身份一致）
//   node dingtalk-notify.mjs --title "标题(≤20字)" --text "正文"
//   echo "正文" | node dingtalk-notify.mjs --title "标题" --text -
//   node dingtalk-notify.mjs --title "标题" --text "正文" --dry-run   # 只打印调用，不发送
//
// 退出码：0 全部块送达；1 发送失败（可能部分送达，stderr 写明进度与灯效回退命令）；
//         2 参数/目标解析错误（含目标安全拒绝与上下文身份不可判定）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.DINGTALK_NOTIFY_STATE_DIR || join(scriptDir, "state");
const ownerFile = join(stateDir, "notify-owner.json");
const contextFile =
  process.env.DINGTALK_NOTIFY_CONTEXT_FILE ||
  join(scriptDir, "..", "..", "dingtalk-connector", "message-context.json");
const OPENCLAW_BIN = process.env.DINGTALK_NOTIFY_OPENCLAW || "openclaw";
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

// 连接器消息上下文 → 本人 staffId。真实测试（2026-11-02）证实：dws auth status 的
// user_id 不是 oToMessages 的合法 staffId；上下文里本人私人会话 inbound 的 senderId
// 才是。fail-closed：恰一个好身份才返回 ok。
const contextIdentity = () => {
  if (!existsSync(contextFile)) {
    return { ok: false, error: `连接器消息上下文不存在：${contextFile}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(contextFile, "utf8"));
  } catch {
    return { ok: false, error: "连接器消息上下文损坏（非 JSON）" };
  }
  if (!parsed || !Array.isArray(parsed.records)) {
    return { ok: false, error: "连接器消息上下文形态非法（缺少 records 数组）" };
  }
  const ids = new Set();
  for (const rec of parsed.records) {
    if (!rec || typeof rec !== "object") return { ok: false, error: "上下文存在无法解析的记录" };
    if (rec.direction !== "inbound") continue;
    const senderId = rec.senderId;
    if (typeof senderId !== "string" || !/^[0-9]+$/.test(senderId)) {
      return { ok: false, error: "存在 senderId 缺失或非数字的 inbound 记录（身份不明）" };
    }
    ids.add(senderId);
  }
  if (ids.size === 0) return { ok: false, error: "上下文中没有 inbound 记录，无法判定本人身份" };
  if (ids.size > 1) {
    return {
      ok: false,
      error: `上下文中出现 ${ids.size} 个不同 inbound 身份，拒绝在歧义下判定目标`,
    };
  }
  return { ok: true, id: [...ids][0] };
};

const pinOwner = (parsed, verifiedVia, extra = {}) => {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      ownerFile,
      `${JSON.stringify({ ownerTarget: parsed.target, verifiedVia, pinnedAt: new Date().toISOString(), ...extra }, null, 2)}\n`,
    );
  } catch (err) {
    fail(2, `无法写入目标钉定文件 ${ownerFile}：${err.message}`);
  }
  return { ...parsed, verifiedVia };
};

const readPinnedOwner = () => {
  if (!existsSync(ownerFile)) return null;
  let raw;
  try {
    raw = JSON.parse(readFileSync(ownerFile, "utf8"));
  } catch {
    fail(2, `目标钉定文件 ${ownerFile} 损坏（非 JSON）；请重新钉定本人目标`);
  }
  const parsed = parseUserTarget(raw?.ownerTarget);
  if (!parsed) {
    fail(
      2,
      `目标钉定文件 ${ownerFile} 内容非法（${JSON.stringify(raw?.ownerTarget)}）；仅接受部署时核验的 user:<本人staffId>，请重新钉定`,
    );
  }
  return { ...parsed, verifiedVia: typeof raw?.verifiedVia === "string" ? raw.verifiedVia : null };
};

// 解析本次发送要用的目标。flag/env 只是「显式携带已钉定目标」的通道，
// 必须精确匹配钉定值；未钉定时唯一自举路径是连接器上下文（其 inbound senderId
// 是机器人已实证接受的本人 staffId）。
// 兼容迁移：verifiedVia 不是 connector-context 的旧钉定（dws-auth-status/manual-deploy/
// 缺失，其中 dws 版已被真实测试证伪）一律视为未核验——发送前必须用连接器上下文
// 重新验证：上下文恰一身份时以它为最终目标（persist 时把钉定安全迁移为 connector-context，
// dry-run 只预览、不写）；上下文不可判定时 fail-closed，拒绝预览与发送。
const resolveSendTarget = (flagTarget, envTarget, { persist = true } = {}) => {
  const pinned = readPinnedOwner();
  let owner = pinned;
  if (!pinned || pinned.verifiedVia !== "connector-context") {
    const ctx = contextIdentity();
    if (!ctx.ok) {
      fail(
        2,
        `既有钉定（${pinned?.verifiedVia ?? "未知来源"}）未经连接器上下文核验，且上下文现在不可判定（${ctx.error}）；fail-closed，拒绝发送。请恢复连接器消息历史后重试，或删除 ${ownerFile} 后重新钉定`,
      );
    }
    const ctxParsed = parseUserTarget(`user:${ctx.id}`);
    if (!ctxParsed) fail(2, `连接器上下文身份非法：${JSON.stringify(ctx.id)}`);
    const migratedFrom = pinned ? pinned.target : null;
    owner = persist
      ? pinOwner(ctxParsed, "connector-context", migratedFrom ? { migratedFrom } : {})
      : { ...ctxParsed, verifiedVia: "connector-context" };
  }
  const explicit = flagTarget ?? envTarget ?? "";
  if (explicit.toString().trim() !== "") {
    const parsed = parseUserTarget(explicit);
    if (!parsed)
      fail(
        2,
        `目标安全拒绝：--target/DINGTALK_NOTIFY_TARGET 只能是已核验的 user:<本人staffId>（收到 ${JSON.stringify(String(explicit))}）；group:、空 ID 与其他形态一律不接受`,
      );
    if (parsed.id !== owner.id)
      fail(
        2,
        `目标安全拒绝：${parsed.target} 与连接器上下文核验的本人目标不一致（stale/foreign 目标）`,
      );
    return owner;
  }
  return owner;
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
  const ctx = contextIdentity();
  if (!ctx.ok)
    fail(
      2,
      `无法钉定目标：连接器消息上下文不可判定本人身份（${ctx.error}）；fail-closed，拒绝手工钉定`,
    );
  if (ctx.id !== parsed.id)
    fail(2, `目标安全拒绝：--set-owner 与连接器上下文中的本人身份不一致（foreign 目标）`);
  pinOwner(parsed, "connector-context");
  process.stdout.write(
    `${JSON.stringify({ ok: true, ownerTarget: parsed.target, verifiedVia: "connector-context" })}\n`,
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
  const clip = (s, n = 300) =>
    String(s || "")
      .trim()
      .slice(0, n);
  if (r.error) return { ok: false, error: `调用失败：${r.error.message}` };
  if (r.status !== 0) {
    // 非零退出时 stdout/stderr 都保留，便于诊断（如 staffId.notExisted 只出现在某一侧）。
    const parts = [`openclaw 退出码 ${r.status}`];
    if (clip(r.stderr)) parts.push(`stderr: ${clip(r.stderr)}`);
    if (clip(r.stdout)) parts.push(`stdout: ${clip(r.stdout)}`);
    return { ok: false, error: parts.join("；") };
  }
  let parsed;
  try {
    parsed = JSON.parse(String(r.stdout || "").trim());
  } catch {
    return { ok: false, error: `Gateway 返回非 JSON：${clip(r.stdout)}` };
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
  const target = resolveSendTarget(args.target, process.env.DINGTALK_NOTIFY_TARGET, {
    persist: !args.dryRun,
  });
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
  process.stdout.write(`${JSON.stringify({ ok: true, chunks: sent })}\n`);
  return 0;
};

process.exit(main());
