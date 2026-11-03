// 云谷课表：包装 yungu-schedule.mjs 抓本周+下周（--json 输出，脚本已加该标志）。
// 每周成功/失败与实际覆盖由 lib/course-weeks.mjs 判定；抓取成功后直接调用 Agenda 的
// loopback sync（SQLite 写入仍由 Agenda 完成）。缺席只算 unlisted，不取消。
import { existsSync, readFileSync } from "node:fs";
import { buildScheduleSyncPayload, requestCourseSync } from "../lib/agenda-sync.mjs";
import { beijingMondayMs, normalizeSchedule, normalizeWeek } from "../lib/course-weeks.mjs";
import { run, summarize } from "../lib/run.mjs";
import { getSecrets } from "../lib/secrets.mjs";

const SCRIPT = "/home/raymond/.openclaw/workspace/skills/yungu-schedule/scripts/yungu-schedule.mjs";
const LOGIN = "/home/raymond/.openclaw/workspace/skills/yungu-tasks/scripts/yungu-login.mjs";
const SESSION = `${process.env.HOME}/.yungu/state.json`;
const SNAPSHOT = "/home/raymond/.openclaw/workspace/collection/state/snapshot-yungu-schedule.json";
const DAY = 86_400_000;

function fetchWeek(monday) {
  const r = run("node", [SCRIPT, String(monday), "--json"], { timeoutMs: 120_000 });
  try {
    const j = JSON.parse(r.stdout);
    if (j.ok === false) return { err: j.error || "FETCH_FAILED", detail: j.detail || null };
    if (j.ok !== true || !Array.isArray(j.content)) return { err: "NO_SCHEDULE_DATA" };
    return { monday, content: j.content };
  } catch {
    return { err: "PARSE_FAILED", detail: summarize(r) };
  }
}

function relogin() {
  const env = getSecrets({ YU_USER: "YUNGU_USERNAME", YU_PASS: "YUNGU_PASSWORD" });
  if (!env) return "密钥库缺少 YUNGU_USERNAME/YUNGU_PASSWORD";
  const login = run("node", [LOGIN], { timeoutMs: 120_000, env });
  try {
    if (JSON.parse(login.stdout).ok === true) return null;
  } catch {}
  return summarize(login);
}

function sessionExists() {
  return existsSync(SESSION);
}

// 取消 evidence 的首次观察时间取自上一轮快照，保证同一条取消在后续轮次复用同一 operationId。
function readPreviousCancellations() {
  try {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    return new Map(
      (snapshot.items || [])
        .filter((item) => item.cancelObservedAt)
        .map((item) => [item.start, item.cancelObservedAt]),
    );
  } catch {
    return new Map();
  }
}

export async function collectWith({
  now = new Date(),
  fetchWeek: fetch = fetchWeek,
  relogin: login = relogin,
  sessionExists: hasSession = sessionExists,
  previousCancellations: readPrevious = () => new Map(),
  sync = requestCourseSync,
} = {}) {
  const thisMonday = beijingMondayMs(0, now);
  const nextMonday = thisMonday + 7 * DAY;

  // 会话文件缺失时脚本起不来，先补登录再抓
  if (!hasSession()) {
    const fail = login();
    if (fail) return { ok: false, error: "RELOGIN_FAILED", detail: fail };
  }

  let fetched = [await fetch(thisMonday), await fetch(nextMonday)];
  const expired = fetched.some((x) => x.err === "NO_SCHEDULE_DATA" || x.err === "SESSION_EXPIRED");
  if (expired) {
    const fail = login();
    if (fail) return { ok: false, error: "RELOGIN_FAILED", detail: fail };
    fetched = [await fetch(thisMonday), await fetch(nextMonday)];
  }

  const previous = readPrevious();
  const weeks = [
    normalizeWeek(thisMonday, fetched[0], { now, previousCancellations: previous }),
    normalizeWeek(nextMonday, fetched[1], { now, previousCancellations: previous }),
  ];
  const normalized = normalizeSchedule(weeks, { now });
  if (!normalized.ok) return normalized;

  const payload = buildScheduleSyncPayload({
    checkedAt: normalized.checkedAt,
    weeks: normalized.weeks,
  });
  let receipt;
  try {
    receipt = await sync(payload);
  } catch (error) {
    receipt = {
      ok: false,
      error: "AGENDA_SYNC_CRASH",
      detail: String(error?.message || error).slice(0, 300),
    };
  }
  normalized.coverage.sync = receipt;
  normalized.coverage.note += receipt?.ok
    ? "；Agenda 同步成功"
    : `；Agenda 同步失败：${receipt?.error || "未知错误"}`;
  return normalized;
}

export function collect() {
  return collectWith({ previousCancellations: readPreviousCancellations });
}
