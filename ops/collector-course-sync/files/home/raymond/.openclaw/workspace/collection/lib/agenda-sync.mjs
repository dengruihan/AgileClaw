// Agenda 课表同步客户端：调用 Agenda 插件的 loopback sync 接口，SQLite 写入仍由 Agenda 完成。
// 契约（M18）：GET /agenda/api/session 取 csrfToken；POST /agenda/api/sync，body ≤512KiB，
// 带 Content-Type/Origin/X-Agenda-CSRF；返回 receipt。本模块不做任何数据库或文件写入。
import { createHash } from "node:crypto";
import { beijingIso } from "./course-weeks.mjs";

export const SYNC_URL = process.env.AGENDA_SYNC_URL || "http://127.0.0.1:18810/agenda/api/sync";
export const SESSION_URL =
  process.env.AGENDA_SESSION_URL || "http://127.0.0.1:18810/agenda/api/session";
export const SYNC_ORIGIN = process.env.AGENDA_SYNC_ORIGIN || "http://127.0.0.1:18810";
const MAX_BODY_BYTES = 512 * 1024;
const TIMEOUT_MS = 30_000;

function occurrenceStart(item) {
  return beijingIso(item.start);
}

function payloadWeeks(weeks) {
  return weeks.map((week) => ({
    start: week.start,
    end: week.end,
    ok: week.ok,
    message: week.ok
      ? null
      : `${week.reason}${week.detail ? `: ${week.detail}` : ""}`.slice(0, 500),
    slots: week.ok
      ? (week.items || [])
          .filter((item) => item.classification === "course")
          .slice()
          .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name))
          .map((item) => ({
            title: item.name,
            start: beijingIso(item.start),
            end: beijingIso(item.end),
            sourceUrl: null,
          }))
      : [],
  }));
}

function payloadCancellations(weeks, checkedAt) {
  return weeks
    .flatMap((week) => (week.ok ? week.items || [] : []))
    .filter((item) => item.classification === "cancelled")
    .map((item) => ({
      start: occurrenceStart(item),
      evidence: {
        kind: "platform",
        detail: item.cancelReason || "平台显式取消标记",
        observedAt: checkedAt,
        url: null,
      },
    }));
}

// operationId 只由窗口+槽位内容决定：同 id + 完全相同 body 幂等 replay；内容变化才换新 id。
// Agenda 的 no-op replay 仍会刷新 checkedAt、不 bump revision，changed:false 是成功。
export function syncOperationId(payload) {
  const identity = {
    sourceId: payload.sourceId,
    window: payload.window,
    weeks: payload.weeks.map((week) => ({
      start: week.start,
      end: week.end,
      ok: week.ok,
      slots: week.slots,
    })),
    cancellations: payload.cancellations,
  };
  return `ys-sync-${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32)}`;
}

export function buildScheduleSyncPayload({ checkedAt, weeks, sourceId = "yungu-schedule" }) {
  const run = weeks.filter((week) => week.ok);
  const windowStart = run[0].startAt;
  const windowEnd = run[run.length - 1].endAt + 1;
  const payload = {
    operationId: "",
    sourceId,
    label: "云谷课表",
    window: { start: beijingIso(windowStart), end: beijingIso(windowEnd) },
    weeks: payloadWeeks(weeks),
    cancellations: payloadCancellations(weeks, checkedAt),
  };
  payload.operationId = syncOperationId(payload);
  return payload;
}

function pickReceipt(body) {
  const numeric = [
    "revision",
    "created",
    "updated",
    "unchanged",
    "adopted",
    "cancelled",
    "unlisted",
  ];
  const receipt = { ok: body.ok === true };
  for (const key of numeric) {
    if (Number.isFinite(body[key])) receipt[key] = body[key];
  }
  for (const key of [
    "operationId",
    "replayed",
    "changed",
    "coverage",
    "code",
    "details",
    "failures",
  ]) {
    if (body[key] !== undefined) receipt[key] = body[key];
  }
  if (typeof body.error === "string") receipt.error = body.error;
  return receipt;
}

function failure(error, detail) {
  return { ok: false, error, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 300) };
  }
}

export async function requestCourseSync(payload, options = {}) {
  const syncUrl = options.syncUrl || SYNC_URL;
  const sessionUrl = options.sessionUrl || SESSION_URL;
  const origin = options.origin || SYNC_ORIGIN;
  const fetchFn = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return failure(
      "AGENDA_SYNC_PAYLOAD_TOO_LARGE",
      `${Buffer.byteLength(body, "utf8")} bytes > ${MAX_BODY_BYTES}`,
    );
  }

  try {
    const session = await fetchFn(sessionUrl, {
      method: "GET",
      headers: { Origin: origin },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (session.status !== 200) {
      return failure("AGENDA_SYNC_SESSION_FAILED", `HTTP ${session.status}`);
    }
    const sessionBody = await readJson(session);
    if (typeof sessionBody.csrfToken !== "string" || !sessionBody.csrfToken) {
      return failure("AGENDA_SYNC_SESSION_FAILED", "响应缺少 csrfToken");
    }
    // 合约：GET session 无 origin/cookie 绑定，不转发 Set-Cookie；sync 只校验同 host Origin + X-Agenda-CSRF。
    const headers = {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Agenda-CSRF": sessionBody.csrfToken,
    };
    const response = await fetchFn(syncUrl, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const parsed = await readJson(response);
    if (response.status === 400 || response.status === 409) {
      return failure(
        parsed.code || parsed.error || "AGENDA_SYNC_BAD_REQUEST",
        parsed.details ? JSON.stringify(parsed.details) : parsed.__raw,
      );
    }
    if (response.status !== 200) {
      return failure(`AGENDA_SYNC_HTTP_${response.status}`, parsed.__raw || parsed.error);
    }
    if (typeof parsed.ok !== "boolean") {
      return failure("AGENDA_SYNC_BAD_RECEIPT", parsed.__raw || "响应缺少 ok");
    }
    const receipt = pickReceipt(parsed);
    if (!receipt.ok) {
      receipt.error = receipt.code || parsed.error || "AGENDA_SYNC_REJECTED";
      if (!receipt.detail && receipt.details)
        receipt.detail = JSON.stringify(receipt.details).slice(0, 300);
      if (!receipt.detail && parsed.__raw) receipt.detail = parsed.__raw;
    }
    return receipt;
  } catch (error) {
    const name = String(error?.name || "");
    if (name === "TimeoutError" || name === "AbortError") {
      return failure("AGENDA_SYNC_TIMEOUT", `超过 ${timeoutMs}ms`);
    }
    return failure("AGENDA_SYNC_UNREACHABLE", String(error?.message || error));
  }
}
