// 隔离验证：课表周判定/覆盖、同步 payload、Agenda HTTP 客户端。
// 不访问真实云谷、Agenda、SQLite、网络或文件；只使用合成周数据与假 fetch。
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildScheduleSyncPayload,
  requestCourseSync,
  syncOperationId,
} from "../files/home/raymond/.openclaw/workspace/collection/lib/agenda-sync.mjs";
import {
  beijingDate,
  beijingIso,
  beijingMondayMs,
  classifySlot,
  normalizeSchedule,
  normalizeWeek,
} from "../files/home/raymond/.openclaw/workspace/collection/lib/course-weeks.mjs";

const DAY = 86_400_000;
const PACKAGE_COLLECTION = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "files/home/raymond/.openclaw/workspace/collection",
);

// 2026-11-03 10:00 北京 = 周二；本周一 2026-11-02 00:00 北京。
const NOW = new Date("2026-11-03T02:00:00Z");
const MONDAY = beijingMondayMs(0, NOW);
const NEXT_MONDAY = MONDAY + 7 * DAY;

function slot(monday, dayIndex, hour, minute, name, extra = {}) {
  const startTime = monday + dayIndex * DAY + (hour * 60 + minute) * 60_000;
  return { startTime, endTime: startTime + 40 * 60_000, name, ...extra };
}

function week(monday, slotsByDay = {}) {
  return Array.from({ length: 7 }, (_, dayIndex) => slotsByDay[dayIndex] ?? []);
}

function validWeek(monday, label = "数学") {
  return week(monday, {
    0: [slot(monday, 0, 7, 0, "起床"), slot(monday, 0, 8, 10, label)],
    1: [slot(monday, 1, 14, 0, "第5节")],
  });
}

function normalizedPair(firstContent, secondContent) {
  return [
    normalizeWeek(MONDAY, { monday: MONDAY, content: firstContent }),
    normalizeWeek(NEXT_MONDAY, { monday: NEXT_MONDAY, content: secondContent }),
  ];
}

test("北京时间周一锚点与日期格式", () => {
  assert.equal(MONDAY, Date.UTC(2026, 10, 1, 16, 0, 0));
  assert.equal(beijingDate(MONDAY), "2026-11-02");
  assert.equal(beijingDate(NEXT_MONDAY + 6 * DAY), "2026-11-15");
  assert.equal(beijingIso(MONDAY), "2026-11-02T00:00:00.000+08:00");
});

test("标签/占位/课程分类保持既有过滤规则", () => {
  for (const label of [
    "起床",
    "出寝",
    "整理",
    "午餐/午休",
    "晚餐",
    "放学",
    "熄灯就寝",
    "G12 晚自修",
    "寄宿社区时间",
    "个人时间",
    "留白时光（系统）",
  ]) {
    assert.equal(classifySlot(label), "label", label);
  }
  assert.equal(classifySlot("第5节"), "placeholder");
  assert.equal(classifySlot("课程待确认"), "placeholder");
  assert.equal(classifySlot("（未命名）"), "placeholder");
  assert.equal(classifySlot("数学"), "course");
  assert.equal(classifySlot("HS-Club 计算机社"), "course");
});

test("两周都成功：覆盖两周，只有课程进 sync", () => {
  const weeks = normalizedPair(validWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  assert.equal(weeks[0].ok, true);
  assert.equal(weeks[1].ok, true);
  assert.equal(weeks[0].slots, 3);
  assert.equal(weeks[0].courses, 1);
  assert.equal(weeks[0].labels, 1);
  assert.equal(weeks[0].placeholders, 1);
  const result = normalizeSchedule(weeks, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.dateStart, "2026-11-02");
  assert.equal(result.coverage.dateEnd, "2026-11-15");
  assert.equal(result.items.length, 6);
  const payload = buildScheduleSyncPayload({ checkedAt: result.checkedAt, weeks });
  assert.equal(payload.window.start, "2026-11-02T00:00:00.000+08:00");
  assert.equal(payload.window.end, "2026-11-16T00:00:00.000+08:00");
  assert.deepEqual(
    payload.weeks.map((w) => w.ok),
    [true, true],
  );
  assert.deepEqual(
    payload.weeks[0].slots.map((s) => s.title),
    ["数学"],
  );
  assert.deepEqual(
    payload.weeks[1].slots.map((s) => s.title),
    ["英语"],
  );
  assert.deepEqual(payload.cancellations, []);
  assert.match(payload.operationId, /^ys-sync-[0-9a-f]{32}$/);
});

test("下周返回本周日期：该周判失败，覆盖只到本周日，不合并下周条目", () => {
  const duplicate = validWeek(MONDAY, "下周副本");
  const weeks = normalizedPair(validWeek(MONDAY), duplicate);
  assert.equal(weeks[1].ok, false);
  assert.equal(weeks[1].reason, "WEEK_DATE_MISMATCH");
  assert.match(weeks[1].detail, /2026-11-02/);
  const result = normalizeSchedule(weeks, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.dateStart, "2026-11-02");
  assert.equal(result.coverage.dateEnd, "2026-11-08");
  assert.equal(result.coverage.weeks[1].ok, false);
  assert.equal(
    result.items.some((item) => item.name === "下周副本"),
    false,
  );
  const payload = buildScheduleSyncPayload({ checkedAt: result.checkedAt, weeks });
  assert.equal(payload.window.end, "2026-11-09T00:00:00.000+08:00");
  assert.equal(payload.weeks[1].ok, false);
  assert.match(payload.weeks[1].message, /WEEK_DATE_MISMATCH/);
  assert.deepEqual(payload.weeks[1].slots, []);
});

test("空周判失败且不覆盖；另一周成功仍返回 ok", () => {
  const weeks = normalizedPair(validWeek(MONDAY), week(NEXT_MONDAY));
  assert.equal(weeks[1].ok, false);
  assert.equal(weeks[1].reason, "EMPTY_WEEK");
  const result = normalizeSchedule(weeks, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.dateEnd, "2026-11-08");
  assert.match(result.coverage.note, /EMPTY_WEEK/);
});

test("两周都失败：source 失败且没有 coverage", () => {
  const weeks = normalizedPair(week(MONDAY), week(NEXT_MONDAY));
  const result = normalizeSchedule(weeks, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.error, "EMPTY_WEEK");
  assert.match(result.detail, /2026-11-02/);
  assert.equal(result.coverage, undefined);
});

test("槽位时间非法判 INVALID_SLOT；非 7 天判 INVALID_CONTENT", () => {
  const badSlot = week(MONDAY, { 0: [{ startTime: "x", endTime: "y", name: "数学" }] });
  assert.equal(normalizeWeek(MONDAY, { monday: MONDAY, content: badSlot }).reason, "INVALID_SLOT");
  assert.equal(
    normalizeWeek(MONDAY, { monday: MONDAY, content: [1, 2] }).reason,
    "INVALID_CONTENT",
  );
});

test("多周时覆盖取最新连续成功周，不把更早的孤立周拼进来", () => {
  const thirdMonday = MONDAY + 14 * DAY;
  const weeks = [
    normalizeWeek(MONDAY, { monday: MONDAY, content: validWeek(MONDAY) }),
    normalizeWeek(NEXT_MONDAY, { monday: NEXT_MONDAY, content: week(NEXT_MONDAY) }),
    normalizeWeek(thirdMonday, { monday: thirdMonday, content: validWeek(thirdMonday, "物理") }),
  ];
  const result = normalizeSchedule(weeks, { now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.dateStart, beijingDate(thirdMonday));
  assert.equal(result.coverage.dateEnd, beijingDate(thirdMonday + 6 * DAY));
  assert.equal(
    result.items.some((item) => item.name === "数学"),
    false,
  );
});

test("显式取消证据进入 cancellations；缺席不产生取消", () => {
  const cancelled = week(MONDAY, {
    0: [slot(MONDAY, 0, 8, 10, "数学", { status: "cancelled", cancelReason: "老师通知停课" })],
  });
  const weeks = normalizedPair(cancelled, validWeek(NEXT_MONDAY));
  assert.equal(weeks[0].items[0].classification, "cancelled");
  assert.equal(weeks[0].cancelled, 1);
  const payload = buildScheduleSyncPayload({ checkedAt: NOW.toISOString(), weeks });
  assert.equal(payload.cancellations.length, 1);
  assert.equal(payload.cancellations[0].evidence.kind, "platform");
  assert.equal(payload.cancellations[0].evidence.detail, "老师通知停课");
  assert.equal(payload.weeks[0].slots.length, 0, "取消条目不再作为课程写入");
  assert.deepEqual(
    payload.weeks[1].slots.map((s) => s.title),
    ["数学"],
    "缺席的下周课程不会变成取消",
  );
});

test("同一 start 重复槽位去重，不产生重复 occurrence", () => {
  const duplicated = week(MONDAY, {
    0: [slot(MONDAY, 0, 8, 10, "数学"), slot(MONDAY, 0, 8, 10, "数学")],
  });
  const normalized = normalizeWeek(MONDAY, { monday: MONDAY, content: duplicated });
  assert.equal(normalized.items.length, 1);
  assert.equal(normalized.duplicates, 1);
  const payload = buildScheduleSyncPayload({
    checkedAt: NOW.toISOString(),
    weeks: [normalized],
  });
  assert.equal(payload.weeks[0].slots.length, 1);
});

test("同一 start 的两门课程判 DUPLICATE_OCCURRENCE；标签与课程同 start 不冲突", () => {
  const conflict = week(MONDAY, {
    0: [slot(MONDAY, 0, 8, 10, "数学"), slot(MONDAY, 0, 8, 10, "物理")],
  });
  const normalized = normalizeWeek(MONDAY, { monday: MONDAY, content: conflict });
  assert.equal(normalized.ok, false);
  assert.equal(normalized.reason, "DUPLICATE_OCCURRENCE");

  const labelNextToCourse = week(MONDAY, {
    0: [slot(MONDAY, 0, 8, 10, "数学"), slot(MONDAY, 0, 8, 10, "起床")],
  });
  assert.equal(normalizeWeek(MONDAY, { monday: MONDAY, content: labelNextToCourse }).ok, true);
});

test("operationId 同内容稳定、内容变化即变化", () => {
  const a = normalizedPair(validWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  const p1 = buildScheduleSyncPayload({ checkedAt: "2026-11-03T00:00:00Z", weeks: a });
  const p2 = buildScheduleSyncPayload({ checkedAt: "2026-11-03T01:00:00Z", weeks: a });
  assert.equal(p1.operationId, p2.operationId, "同一窗口+槽位在重试时复用 operationId");
  assert.equal(syncOperationId(p1), p1.operationId);
  const b = normalizedPair(validWeek(MONDAY), validWeek(NEXT_MONDAY, "物理"));
  const p3 = buildScheduleSyncPayload({ checkedAt: "2026-11-03T00:00:00Z", weeks: b });
  assert.notEqual(p1.operationId, p3.operationId);
});

// ---- collectWith：用包内源码 + 临时 stub 依赖，不触碰真实抓取/登录 ----
function makeFixtureTree() {
  const dir = mkdtempSync(join(tmpdir(), "course-sync-"));
  mkdirSync(join(dir, "sources"));
  mkdirSync(join(dir, "lib"));
  cpSync(
    join(PACKAGE_COLLECTION, "sources/yungu-schedule.mjs"),
    join(dir, "sources/yungu-schedule.mjs"),
  );
  for (const file of ["course-weeks.mjs", "agenda-sync.mjs"]) {
    cpSync(join(PACKAGE_COLLECTION, "lib", file), join(dir, "lib", file));
  }
  writeFileSync(
    join(dir, "lib/run.mjs"),
    'export function run() { throw new Error("real run must not execute in tests"); }\nexport function summarize() { return ""; }\n',
  );
  writeFileSync(
    join(dir, "lib/secrets.mjs"),
    'export function getSecrets() { throw new Error("real secrets must not execute in tests"); }\n',
  );
  return dir;
}

const fixtureDir = makeFixtureTree();
const sourceModule = await import(
  pathToFileURL(join(fixtureDir, "sources/yungu-schedule.mjs")).href
);
process.on("exit", () => rmSync(fixtureDir, { recursive: true, force: true }));

function fetchOk(contents) {
  return async (monday) => ({
    monday,
    content: contents.get(monday) ?? validWeek(monday),
  });
}

test("collectWith：抓取成功自动同步，不在失败时调用 sync", async () => {
  const calls = [];
  const seen = new Map([
    [MONDAY, validWeek(MONDAY)],
    [NEXT_MONDAY, validWeek(NEXT_MONDAY, "英语")],
  ]);
  const result = await sourceModule.collectWith({
    now: NOW,
    sessionExists: () => true,
    fetchWeek: fetchOk(seen),
    sync: async (payload) => {
      calls.push(payload);
      return { ok: true, revision: 9, created: 2, updated: 0, unchanged: 0, unlisted: 0 };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceId, "yungu-schedule");
  assert.equal(result.coverage.sync.ok, true);
  assert.match(result.coverage.note, /Agenda 同步成功/);
});

test("collectWith：sync 失败不影响抓取结果，下一轮可重试", async () => {
  const result = await sourceModule.collectWith({
    now: NOW,
    sessionExists: () => true,
    fetchWeek: fetchOk(new Map()),
    sync: async () => ({ ok: false, error: "AGENDA_SYNC_UNREACHABLE", detail: "ECONNREFUSED" }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.items.length > 0, true);
  assert.equal(result.coverage.sync.ok, false);
  assert.match(result.coverage.note, /Agenda 同步失败：AGENDA_SYNC_UNREACHABLE/);
});

test("collectWith：sync 抛异常也保留抓取结果并标记 AGENDA_SYNC_CRASH", async () => {
  const result = await sourceModule.collectWith({
    now: NOW,
    sessionExists: () => true,
    fetchWeek: fetchOk(new Map()),
    sync: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.coverage.sync.ok, false);
  assert.equal(result.coverage.sync.error, "AGENDA_SYNC_CRASH");
  assert.match(result.coverage.sync.detail, /boom/);
});

test("collectWith：全部周失败不调用 sync", async () => {
  let called = 0;
  const result = await sourceModule.collectWith({
    now: NOW,
    sessionExists: () => true,
    fetchWeek: async (monday) => ({ monday, content: week(monday) }),
    sync: async () => {
      called += 1;
      return { ok: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(called, 0);
});

test("collectWith：会话缺失且重登失败直接 RELOGIN_FAILED", async () => {
  let fetched = 0;
  const result = await sourceModule.collectWith({
    now: NOW,
    sessionExists: () => false,
    relogin: () => "密钥库缺少凭据",
    fetchWeek: async () => {
      fetched += 1;
      return { err: "SHOULD_NOT_FETCH" };
    },
    sync: async () => ({ ok: true }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "RELOGIN_FAILED");
  assert.equal(fetched, 0);
});

test("collectWith：会话过期时重登一次后重抓", async () => {
  const seen = new Map();
  let logins = 0;
  let first = true;
  const result = await sourceModule.collectWith({
    now: NOW,
    sessionExists: () => true,
    relogin: () => {
      logins += 1;
      return null;
    },
    fetchWeek: async (monday) => {
      if (first) {
        first = false;
        return { err: "NO_SCHEDULE_DATA" };
      }
      return { monday, content: validWeek(monday) };
    },
    sync: async () => ({ ok: true }),
  });
  assert.equal(logins, 1);
  assert.equal(seen.size, 0);
  assert.equal(result.ok, true);
});

// ---- Agenda HTTP 客户端 ----
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function fakeFetch({
  session = { csrfToken: "csrf-1" },
  receipt = { ok: true, revision: 3 },
  status = 200,
} = {}) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith("/agenda/api/session")) {
      return jsonResponse(session, 200, { "Set-Cookie": "agenda_session=abc; Path=/; HttpOnly" });
    }
    return jsonResponse(receipt, status);
  };
  return { fetchFn, calls };
}

test("HTTP sync：取 csrf、带 Origin/CSRF、不转发 cookie、解析 receipt", async () => {
  const { fetchFn, calls } = fakeFetch();
  const receipt = await requestCourseSync(
    { operationId: "op-1", sourceId: "yungu-schedule" },
    { fetch: fetchFn },
  );
  assert.equal(receipt.ok, true);
  assert.equal(receipt.revision, 3);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[1].init.method, "POST");
  const headers = calls[1].init.headers;
  assert.equal(headers["X-Agenda-CSRF"], "csrf-1");
  assert.equal(headers.Origin, "http://127.0.0.1:18810");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Cookie, undefined, "合约不要求 cookie，客户端不转发 Set-Cookie");
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    operationId: "op-1",
    sourceId: "yungu-schedule",
  });
});

test("HTTP sync：业务拒绝 ok:false 保留 code；HTTP400/409 报对应业务码", async () => {
  const rejected = await requestCourseSync(
    { operationId: "op-2" },
    {
      fetch: fakeFetch({
        receipt: { ok: false, code: "slot_outside_week", details: [{ week: 0 }] },
        status: 409,
      }).fetchFn,
    },
  );
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "slot_outside_week");
  assert.match(rejected.detail, /week/);

  const bad = await requestCourseSync(
    { operationId: "op-3" },
    {
      fetch: async (url) =>
        url.endsWith("/session")
          ? jsonResponse({ csrfToken: "t" })
          : jsonResponse({ code: "schema_invalid" }, 400),
    },
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error, "schema_invalid");

  const reused = await requestCourseSync(
    { operationId: "op-3b" },
    {
      fetch: fakeFetch({ receipt: { ok: false, code: "operation_id_reused" }, status: 409 })
        .fetchFn,
    },
  );
  assert.equal(reused.ok, false);
  assert.equal(reused.error, "operation_id_reused");
});

test("HTTP sync：不可达/超时/过大 payload 都返回可行动错误", async () => {
  const unreachable = await requestCourseSync(
    { operationId: "op-4" },
    {
      fetch: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    },
  );
  assert.equal(unreachable.error, "AGENDA_SYNC_UNREACHABLE");

  const timeout = await requestCourseSync(
    { operationId: "op-5" },
    {
      fetch: async () => {
        const error = new Error("timeout");
        error.name = "TimeoutError";
        throw error;
      },
    },
  );
  assert.equal(timeout.error, "AGENDA_SYNC_TIMEOUT");

  let calls = 0;
  const tooLarge = await requestCourseSync(
    { operationId: "op-6", filler: "x".repeat(520 * 1024) },
    {
      fetch: async () => {
        calls += 1;
        return jsonResponse({ ok: true });
      },
    },
  );
  assert.equal(tooLarge.error, "AGENDA_SYNC_PAYLOAD_TOO_LARGE");
  assert.equal(calls, 0);
});
