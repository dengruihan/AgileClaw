#!/usr/bin/env node
// 统一收集入口。用法:
//   node collect.mjs all [源名...]     跑指定源（缺省全部，受每源间隔门）
//   node collect.mjs status            打印健康状态
// 选项: --force 忽略间隔门; --no-attach 跳过附件归档
// 每源输出一行 JSON 摘要（自动化触发脚本消费）；完整结果写 report.json。
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.mjs";
import { archiveAttachments } from "./lib/attach.mjs";
import { diffByKey } from "./lib/diff.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(ROOT, "state");
const REPORT = path.join(ROOT, "report.json");
const HEALTH = path.join(STATE_DIR, "health.json");
const HISTORY = path.join(STATE_DIR, "history");

const ADAPTERS = {
  "yungu-tasks": () => import("./sources/yungu-tasks.mjs"),
  "yungu-schedule": () => import("./sources/yungu-schedule.mjs"),
  osh: () => import("./sources/osh.mjs"),
  dingtalk: () => import("./sources/dingtalk.mjs"),
  mail: () => import("./sources/mail.mjs"),
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 1));
  renameSync(`${file}.tmp`, file);
}

function beijingDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}

function snapshotPath(source) {
  return path.join(STATE_DIR, `snapshot-${source}.json`);
}

function summarizeDelta(result) {
  if (result.counts) {
    const d = result.countsDelta || {};
    return `yungu ${d.yungu >= 0 ? "+" : ""}${d.yungu ?? "?"} qq ${d.qq >= 0 ? "+" : ""}${d.qq ?? "?"}`;
  }
  const { added, changed, removed } = result.delta || {};
  return `+${added?.length || 0} ~${changed?.length || 0} -${removed?.length || 0}`;
}

async function runSource(source, { force, attach }) {
  const cfg = CONFIG.sources[source];
  const health = readJson(HEALTH, {});
  const prevHealth = health[source] || {};
  const now = Date.now();

  const lastAttemptMs = Date.parse(prevHealth.lastAttemptAt || "");
  if (!force && Number.isFinite(lastAttemptMs) && now - lastAttemptMs < cfg.minIntervalMs) {
    const prevReport = readJson(REPORT, { sources: {} });
    const carried = prevReport.sources?.[source];
    return {
      line: {
        source,
        label: cfg.label,
        ok: carried ? carried.ok : true,
        skipped: true,
        streak: prevHealth.streak || 0,
      },
      entry: carried
        ? { ...carried, skipped: true }
        : { source, label: cfg.label, skipped: true, ok: null },
    };
  }

  const startedAt = Date.now();
  let result;
  try {
    const mod = await ADAPTERS[source]();
    result = mod.collect();
  } catch (e) {
    result = {
      ok: false,
      error: "ADAPTER_CRASH",
      detail: String(e && e.message ? e.message : e).slice(0, 200),
    };
  }
  const durationMs = Date.now() - startedAt;

  const streak = result.ok ? 0 : (Number(prevHealth.streak) || 0) + 1;
  let entry = {
    source,
    label: cfg.label,
    at: new Date(now).toISOString(),
    durationMs,
    ok: result.ok,
  };
  if (!result.ok) {
    entry.error = result.error;
    entry.detail = result.detail || null;
  } else {
    entry.coverage = result.coverage;
    if (result.items) {
      entry.items = result.items;
      entry.itemsCount = result.items.length;
      const prev = readJson(snapshotPath(source), null);
      entry.delta = diffByKey(prev?.items, result.items, (x) => x.key);
    }
    if (result.counts) {
      entry.counts = result.counts;
      const prev = readJson(snapshotPath(source), null);
      if (prev?.counts) {
        entry.countsDelta = {
          yungu: result.counts.yungu - prev.counts.yungu,
          qq: result.counts.qq - prev.counts.qq,
        };
      }
    }
  }

  // 附件归档挂在 yungu-tasks 成功抓取之后；失败不阻塞报告，记录在 entry.attach
  if (attach && source === "yungu-tasks" && result.ok && CONFIG.attach.enabled) {
    try {
      entry.attach = archiveAttachments({
        items: result.items,
        stateDir: STATE_DIR,
        maxTasks: CONFIG.attach.maxTasksPerRun,
        courseDirs: CONFIG.attach.courseDirs || {},
      });
    } catch (e) {
      entry.attach = [
        { error: `ATTACH_CRASH:${String(e && e.message ? e.message : e).slice(0, 120)}` },
      ];
    }
  }

  if (result.ok) {
    writeJsonAtomic(snapshotPath(source), {
      at: entry.at,
      ...(result.items ? { items: result.items } : {}),
      ...(result.counts ? { counts: result.counts } : {}),
    });
  }
  const nextHealth = {
    ...health,
    [source]: {
      lastOkAt: result.ok ? entry.at : prevHealth.lastOkAt || null,
      lastAttemptAt: entry.at,
      lastError: result.ok ? null : `${result.error}: ${result.detail || ""}`.slice(0, 200),
      streak,
      coverage: result.coverage || null,
    },
  };
  writeJsonAtomic(HEALTH, nextHealth);

  return {
    line: {
      source,
      label: cfg.label,
      ok: result.ok,
      streak,
      changed: result.ok ? summarizeDelta(entry) : null,
      ...(result.ok ? {} : { error: result.error }),
    },
    entry,
  };
}

function rotateHistory() {
  mkdirSync(HISTORY, { recursive: true });
  const today = `${beijingDay()}.json`;
  if (!existsSync(path.join(HISTORY, today)) && existsSync(REPORT)) {
    writeFileSync(path.join(HISTORY, today), readFileSync(REPORT));
  }
  const keep = new Set();
  const cursor = new Date();
  for (let i = 0; i < CONFIG.historyKeepDays; i++) {
    keep.add(`${beijingDay(cursor)}.json`);
    cursor.setDate(cursor.getDate() - 1);
  }
  for (const file of readdirSync(HISTORY)) {
    if (!keep.has(file)) rmSync(path.join(HISTORY, file));
  }
}

function printStatus() {
  const health = readJson(HEALTH, {});
  const report = readJson(REPORT, { sources: {} });
  const rows = Object.entries(CONFIG.sources).map(([source, cfg]) => {
    const h = health[source] || {};
    const r = report.sources?.[source] || {};
    return {
      source,
      label: cfg.label,
      ok: r.ok ?? null,
      streak: h.streak ?? null,
      lastOkAt: h.lastOkAt,
      lastError: h.lastError,
      coverage: r.coverage?.note || null,
    };
  });
  console.log(JSON.stringify(rows, null, 1));
}

async function main() {
  mkdirSync(STATE_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const attach = !args.includes("--no-attach");
  const names = args.filter((a) => !a.startsWith("--"));
  const command = names[0] || "all";

  if (command === "status") {
    printStatus();
    return;
  }

  const targets = command === "all" ? CONFIG.order : names;
  const unknown = targets.filter((t) => !CONFIG.sources[t]);
  if (unknown.length) {
    console.log(JSON.stringify({ ok: false, error: `unknown source: ${unknown.join(",")}` }));
    process.exit(2);
  }

  const prevReport = readJson(REPORT, { sources: {} });
  const sources = { ...prevReport.sources };
  for (const source of targets) {
    if (!CONFIG.sources[source].enabled) continue;
    const { line, entry } = await runSource(source, { force, attach });
    console.log(JSON.stringify(line));
    sources[source] = entry;
  }
  writeJsonAtomic(REPORT, { at: new Date().toISOString(), sources });
  rotateHistory();
}

main().catch((e) => {
  console.log(
    JSON.stringify({
      ok: false,
      error: "COLLECT_CRASH",
      detail: String(e && e.message ? e.message : e).slice(0, 200),
    }),
  );
  process.exit(1);
});
