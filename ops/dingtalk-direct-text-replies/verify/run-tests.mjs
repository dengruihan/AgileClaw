#!/usr/bin/env node
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// Offline verification for the DingTalk direct-reply-mode patch.
//
// Drives the real dist artifacts (pristine vs patched) of the installed
// @dingtalk-real-ai/dingtalk-connector through handleDingTalkMessage with a
// fake OpenClaw host runtime and the offline axios stub. No network access,
// no real DingTalk messages, no Gateway.
//
// Prereq: ./build-scratch.sh   Run: node run-tests.mjs
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const variants = {};
// Rolled-up chunks export under minified names (pinned for 0.8.27 by build
// output; asserted below so a rebuild that renames them fails loudly).
const RUNTIME_EXPORTS = { setDingtalkRuntime: "n", sendProactive: "c" };
for (const v of ["pristine", "patched"]) {
  const pkg = path.join(
    HERE,
    ".scratch",
    v,
    "node_modules",
    "@dingtalk-real-ai",
    "dingtalk-connector",
  );
  const runtime = await import(pathToFileURL(path.join(pkg, "dist", "runtime-CalLOr7V.mjs")).href);
  for (const [name, key] of Object.entries(RUNTIME_EXPORTS)) {
    if (typeof runtime[key] !== "function") {
      throw new Error(`runtime chunk export ${name} (as "${key}") missing in ${v} build`);
    }
  }
  variants[v] = {
    pkg,
    runtime,
    setDingtalkRuntime: (core) => runtime[RUNTIME_EXPORTS.setDingtalkRuntime](core),
    sendProactive: (...args) => runtime[RUNTIME_EXPORTS.sendProactive](...args),
    handler: await import(
      pathToFileURL(path.join(pkg, "dist", "message-handler-C8eu5xwl.mjs")).href
    ),
  };
}

const WEBHOOK = "https://mock.webhook.local/session";
// Synthetic fixture identity — deliberately not a real DingTalk user id.
const ALLOWED_SENDER = "1000000000000000001";
const workspaceDir = mkdtempSync(path.join(tmpdir(), "dt-verify-"));

const mockHttp = () => globalThis.__DT_MOCK_HTTP__;

function resetHttp() {
  globalThis.__DT_MOCK_HTTP__ = { calls: [], failOnce: new Map() };
}
resetHttp();

// Deterministic paragraph-first chunker mirroring the host contract:
// chunks concatenate back to the original text exactly.
function chunkText(text, limit) {
  if (text.length <= limit) return [text];
  const paras = text.split("\n\n");
  const chunks = [];
  let current = "";
  const push = () => {
    if (current) chunks.push(current);
    current = "";
  };
  for (const para of paras) {
    const piece = current ? `\n\n${para}` : para;
    if (piece.length > limit) {
      push();
      for (let i = 0; i < para.length; i += limit) chunks.push(para.slice(i, i + limit));
      continue;
    }
    if (current.length + piece.length > limit) push();
    current += piece;
  }
  push();
  return chunks;
}

// Per-scenario script read by the fake host runtime.
let script = {};
const runtimeErrors = [];

function makeCore() {
  return {
    channel: {
      text: {
        resolveTextChunkLimit: (_cfg, _channel, _accountId, opts) =>
          script.chunkLimit ?? opts?.fallbackLimit ?? 4000,
        resolveChunkMode: () => "paragraph",
        chunkTextWithMode: (text, limit) => chunkText(text, limit),
      },
      routing: {
        resolveAgentRoute: () => ({ agentId: "linglong", matchedBy: "mock-default" }),
        buildAgentSessionKey: ({ agentId, accountId, peer }) =>
          `dd:${accountId}:${agentId}:${peer?.id ?? "peer"}`,
      },
      reply: {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }) => body,
        dispatchReplyFromConfig: async () => ({}),
        dispatchReplyWithBufferedBlockDispatcher: async ({ dispatcherOptions, replyOptions }) => {
          await dispatcherOptions.onReplyStart?.();
          for (const partial of script.partials ?? []) {
            await replyOptions.onPartialReply?.({ text: partial });
          }
          const text = script.emptyFinal ? "" : script.finalText;
          await dispatcherOptions.deliver({ text }, { kind: "final" });
          if (script.duplicateFinal) await dispatcherOptions.deliver({ text }, { kind: "final" });
          await dispatcherOptions.onIdle?.();
          return { queuedFinal: text, counts: { final: 1 } };
        },
      },
    },
    agent: { resolveAgentWorkspaceDir: () => workspaceDir },
  };
}

function dmData(overrides = {}) {
  return {
    msgtype: "text",
    conversationType: "1",
    conversationId: "",
    senderStaffId: ALLOWED_SENDER,
    senderId: ALLOWED_SENDER,
    senderNick: "Verifier",
    msgId: `mock-msg-${mockHttp().calls.length}`,
    sessionWebhook: WEBHOOK,
    text: { content: "用一句话介绍你自己" },
    ...overrides,
  };
}

function groupData(overrides = {}) {
  return {
    msgtype: "text",
    conversationType: "2",
    conversationId: "mock-cid-001",
    conversationTitle: "验证群",
    senderStaffId: ALLOWED_SENDER,
    senderId: ALLOWED_SENDER,
    senderNick: "Verifier",
    msgId: `mock-msg-${mockHttp().calls.length}`,
    sessionWebhook: WEBHOOK,
    text: { content: "群聊回归检查" },
    ...overrides,
  };
}

const baseConfig = {
  clientId: "mock-client-id",
  clientSecret: "mock-client-secret",
  dmPolicy: "allowlist",
  allowFrom: [ALLOWED_SENDER],
};

async function runScenario({
  name,
  variant,
  config = baseConfig,
  data,
  script: sc = {},
  failOnce,
} = {}) {
  script = { finalText: "默认回复文本", ...sc };
  runtimeErrors.length = 0;
  resetHttp();
  if (failOnce) for (const [k, v] of failOnce) mockHttp().failOnce.set(k, v);
  const v = variants[variant];
  v.setDingtalkRuntime(makeCore());
  const runtime = {
    log: () => {},
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: (...a) => runtimeErrors.push(a.map(String).join(" ")),
  };
  await v.handler.handleDingTalkMessage({
    accountId: "default",
    config,
    cfg: { channels: { "dingtalk-connector": config } },
    data,
    sessionWebhook: WEBHOOK,
    runtime,
  });
  // Give fire-and-forget paths (emotion reply, proactive acks) a tick.
  await new Promise((resolve) => setImmediate(resolve));
  return { calls: mockHttp().calls.slice(), runtimeErrors: runtimeErrors.slice() };
}

// ---- call classifiers ------------------------------------------------------

const isCardCall = (c) => /\/v1\.0\/card\//.test(c.url);
const isWebhook = (c) => c.url === WEBHOOK;
const isProactiveNormal = (c) => /robot\/(oToMessages|groupMessages)/.test(c.url);
const webhookMarkdownTexts = (calls) =>
  calls
    .filter((c) => isWebhook(c) && c.body?.msgtype === "markdown")
    .map((c) => c.body?.markdown?.text ?? "");
const webhookTexts = (calls) =>
  calls
    .filter((c) => isWebhook(c) && c.body?.msgtype === "text")
    .map((c) => c.body?.text?.content ?? "");

// ---- tiny assert plumbing --------------------------------------------------

let failures = 0;
const results = [];
function check(scenario, statement, condition, detail = "") {
  const pass = Boolean(condition);
  if (!pass) failures += 1;
  results.push(`${pass ? "PASS" : "FAIL"} [${scenario}] ${statement}${pass ? "" : ` — ${detail}`}`);
}
const summary = () => {
  console.log(results.join("\n"));
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
};

// ---- scenarios -------------------------------------------------------------

// S1 — the fix: patched plugin, DM, directReplyMode=markdown → one markdown
// webhook reply, no AI Card, full text, no streaming partials.
{
  const finalText =
    "我是玲珑，可以直接用 **Markdown** 回复你，不再使用 AI 卡片。\n\n- 列表一\n- 列表二";
  const { calls } = await runScenario({
    name: "S1",
    variant: "patched",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData(),
    script: { finalText, partials: ["流式片段不应出现"] },
  });
  const md = webhookMarkdownTexts(calls);
  check(
    "S1",
    "direct reply uses plain markdown webhook",
    md.length === 1,
    JSON.stringify(calls.filter(isWebhook).map((c) => c.body?.msgtype)),
  );
  check(
    "S1",
    "no AI Card API calls",
    !calls.some(isCardCall),
    JSON.stringify(calls.filter(isCardCall)),
  );
  check(
    "S1",
    "body delivered in full",
    md.join("") === finalText,
    `len=${md.join("").length} vs ${finalText.length}`,
  );
  check("S1", "no proactive normal-message fallback for the reply", !calls.some(isProactiveNormal));
}

// S2 — duplicate final must not double-send.
{
  const { calls } = await runScenario({
    name: "S2",
    variant: "patched",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData(),
    script: { finalText: "唯一回复", duplicateFinal: true },
  });
  check(
    "S2",
    "duplicate final sends exactly one markdown",
    webhookMarkdownTexts(calls).length === 1,
  );
}

// S3 — long replies chunk, in order, losslessly.
{
  const para = "段落内容。".repeat(40); // 200 chars per paragraph
  const finalText = Array.from({ length: 6 }, (_, i) => `第${i + 1}段：${para}`).join("\n\n"); // >1000 chars
  const { calls } = await runScenario({
    name: "S3",
    variant: "patched",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData(),
    script: { finalText, chunkLimit: 500 },
  });
  const md = webhookMarkdownTexts(calls);
  check("S3", "long reply split into multiple chunks", md.length > 1, `chunks=${md.length}`);
  check("S3", "chunks reassemble losslessly", md.join("") === finalText);
  check(
    "S3",
    "no chunk exceeds the limit",
    md.every((t) => t.length <= 500),
  );
  check("S3", "still no AI Card", !calls.some(isCardCall));
}

// S4 — empty final falls back to the DM confirmation text, still markdown.
{
  const { calls } = await runScenario({
    name: "S4",
    variant: "patched",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData(),
    script: { emptyFinal: true },
  });
  const md = webhookMarkdownTexts(calls);
  check(
    "S4",
    "empty final still delivers one markdown reply",
    md.length === 1 && md[0].trim().length > 0,
    JSON.stringify(md),
  );
}

// S5 — webhook business failure is diagnosable: fallback error text + runtime.error surfaced.
{
  const { calls, runtimeErrors } = await runScenario({
    name: "S5",
    variant: "patched",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData(),
    script: { finalText: "会失败的一次回复" },
    failOnce: new Map([
      [`POST ${WEBHOOK}`, { body: { errcode: 310000, errmsg: "mock business failure" } }],
    ]),
  });
  const texts = webhookTexts(calls);
  check(
    "S5",
    "failed delivery surfaces runtime error",
    runtimeErrors.some((e) => e.includes("non-streaming delivery failed")),
    JSON.stringify(runtimeErrors),
  );
  check(
    "S5",
    "fallback error message sent as plain text",
    texts.some((t) => t.includes("消息发送失败")),
    JSON.stringify(texts),
  );
}

// S6 — default DM behavior unchanged on patched plugin (aicard, streaming).
{
  const { calls } = await runScenario({
    name: "S6",
    variant: "patched",
    config: baseConfig,
    data: dmData(),
    script: { finalText: "默认卡片回复", partials: ["流式前缀"] },
  });
  check(
    "S6",
    "default DM still uses AI Card",
    calls.some((c) => /card\/instances$/.test(c.url) && c.method === "POST"),
  );
  check(
    "S6",
    "default DM finalizes the card",
    calls.some(
      (c) =>
        c.method === "PUT" &&
        /card\/(instances|streaming)/.test(c.url) &&
        /"flowStatus":"3"/.test(JSON.stringify(c.body)),
    ),
    JSON.stringify(
      calls
        .filter((c) => c.method === "PUT")
        .map((c) => c.body?.cardData?.cardParamMap?.flowStatus),
    ),
  );
  check(
    "S6",
    "default DM sends no markdown webhook reply",
    webhookMarkdownTexts(calls).length === 0,
  );
}

// S7 — before behavior on pristine plugin: DM always AI Card, even with
// directReplyMode set (config has no effect pre-patch).
{
  const { calls } = await runScenario({
    name: "S7",
    variant: "pristine",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData(),
    script: { finalText: "补丁前的行为", partials: ["流式前缀"] },
  });
  check(
    "S7",
    "pristine DM keeps AI Card despite directReplyMode",
    calls.some((c) => /card\/instances$/.test(c.url) && c.method === "POST"),
  );
  check(
    "S7",
    "pristine DM sends no markdown webhook reply",
    webhookMarkdownTexts(calls).length === 0,
  );
}

// S8 — pristine default DM matches patched default DM (no unintended drift).
{
  const opSignature = (calls) =>
    calls.map((c) => `${c.method} ${c.url.replace(/mock-card-\d+|mock-carrier-\d+/g, "mock")}`);
  const a = await runScenario({
    name: "S8a",
    variant: "pristine",
    config: baseConfig,
    data: dmData(),
    script: { finalText: "一致性", partials: ["前"] },
  });
  const b = await runScenario({
    name: "S8b",
    variant: "patched",
    config: baseConfig,
    data: dmData(),
    script: { finalText: "一致性", partials: ["前"] },
  });
  check(
    "S8",
    "pristine/patched default DM call sequences identical",
    JSON.stringify(opSignature(a.calls)) === JSON.stringify(opSignature(b.calls)),
    `${opSignature(a.calls)} vs ${opSignature(b.calls)}`,
  );
}

// S9 — group markdown mode unchanged on both trees.
for (const variant of ["pristine", "patched"]) {
  const groupConfig = {
    ...baseConfig,
    groupPolicy: "open",
    requireMention: false,
    groupReplyMode: "markdown",
  };
  const { calls } = await runScenario({
    name: `S9-${variant}`,
    variant,
    config: groupConfig,
    data: groupData(),
    script: { finalText: "群聊 Markdown 回复" },
  });
  const md = webhookMarkdownTexts(calls);
  check(
    `S9-${variant}`,
    "group markdown reply still works",
    md.length === 1 && md[0] === "群聊 Markdown 回复",
    JSON.stringify(md),
  );
  check(`S9-${variant}`, "group markdown uses no AI Card", !calls.some(isCardCall));
}

// S10 — group aicard default unchanged on patched tree.
{
  const { calls } = await runScenario({
    name: "S10",
    variant: "patched",
    config: { ...baseConfig, groupPolicy: "open", requireMention: false },
    data: groupData(),
    script: { finalText: "群聊卡片回复" },
  });
  check(
    "S10",
    "group aicard default still uses AI Card",
    calls.some((c) => /card\/instances$/.test(c.url) && c.method === "POST"),
  );
  check("S10", "group aicard sends no markdown webhook", webhookMarkdownTexts(calls).length === 0);
}

// S11 — proactive sends (collector notifications, ACKs) unchanged:
// useAICard default still routes through cards; useAICard:false still uses
// the normal batchSend API. Identical on both trees.
for (const variant of ["pristine", "patched"]) {
  const v = variants[variant];
  resetHttp();
  v.setDingtalkRuntime(makeCore());
  await v.sendProactive(baseConfig, { userId: ALLOWED_SENDER }, "主动通知默认走卡片", {});
  const withCard = mockHttp().calls.slice();
  resetHttp();
  await v.sendProactive(baseConfig, { userId: ALLOWED_SENDER }, "主动通知显式纯文本", {
    msgType: "markdown",
    title: "通知",
    useAICard: false,
  });
  const withoutCard = mockHttp().calls.slice();
  check(
    `S11-${variant}`,
    "proactive default still uses AI Card",
    withCard.some((c) => /card\/instances$/.test(c.url) && c.method === "POST"),
    JSON.stringify(withCard.map((c) => c.url)),
  );
  check(
    `S11-${variant}`,
    "proactive useAICard:false still uses batchSend",
    withoutCard.some((c) => /robot\/oToMessages\/batchSend$/.test(c.url)) &&
      !withoutCard.some(isCardCall),
    JSON.stringify(withoutCard.map((c) => c.url)),
  );
  const mdBody = withoutCard.find((c) => /robot\/oToMessages\/batchSend$/.test(c.url))?.body;
  check(
    `S11-${variant}`,
    "proactive markdown body preserved",
    mdBody?.msgType === "markdown" ||
      mdBody?.msg === "markdown" ||
      JSON.stringify(mdBody).includes("主动通知显式纯文本"),
    JSON.stringify(mdBody),
  );
}

// S12 — DM policy boundary unchanged on patched tree: non-allowlisted sender
// gets the rejection notice only, no dispatch, no card.
{
  const { calls } = await runScenario({
    name: "S12",
    variant: "patched",
    config: { ...baseConfig, directReplyMode: "markdown" },
    data: dmData({ senderStaffId: "9999999999999999999", senderId: "9999999999999999999" }),
    script: { finalText: "不应出现" },
  });
  check(
    "S12",
    "blocked sender gets no reply dispatch",
    webhookMarkdownTexts(calls).length === 0 && !calls.some(isCardCall),
    JSON.stringify(calls.map((c) => c.url)),
  );
  check(
    "S12",
    "blocked sender gets proactive rejection text",
    calls.some(
      (c) =>
        /robot\/oToMessages\/batchSend$/.test(c.url) && JSON.stringify(c.body).includes("暂无权限"),
    ),
  );
}

// S13 — config schema boundary: patched dist accepts directReplyMode in the
// channel config schema the host validates against; pristine rejects it.
for (const [variant, expectKey] of [
  ["patched", true],
  ["pristine", false],
]) {
  const rt = variants[variant].runtime;
  rt.a(); // initDingtalkPluginConfigSchema
  const schema = rt.i?.configSchema; // dingtalkPlugin.configSchema
  const props = schema?.properties ?? schema?.schema?.properties;
  check(
    "S13",
    `${variant} config schema loaded`,
    Boolean(props),
    JSON.stringify(schema)?.slice(0, 120),
  );
  if (props) {
    check(
      "S13",
      `${variant} schema ${expectKey ? "defines" : "lacks"} directReplyMode`,
      Boolean(props.directReplyMode) === expectKey,
      `directReplyMode=${JSON.stringify(props.directReplyMode)}`,
    );
    if (!expectKey) {
      check(
        "S13",
        "pristine schema is strict (unknown keys rejected)",
        schema?.additionalProperties === false || schema?.schema?.additionalProperties === false,
        JSON.stringify(schema?.additionalProperties),
      );
    } else {
      const enumValues = props.directReplyMode?.enum ?? props.directReplyMode?.anyOf?.[0]?.enum;
      check(
        "S13",
        "directReplyMode enum is aicard/text/markdown",
        JSON.stringify(enumValues) === JSON.stringify(["aicard", "text", "markdown"]),
        JSON.stringify(enumValues),
      );
    }
  }
}

summary();
