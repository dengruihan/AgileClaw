// 跨分支集成验证：M19 归一化/payload + M18 真实 store 与 sqlite worker。
// 需要 M18 的隔离 checkout（默认 ../wt-18/.external/agenda，可用 M18_AGENDA_ROOT 覆盖）。
// 只使用临时 SQLite；不访问 live 数据库、HTTP、cron 或消息。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildScheduleSyncPayload } from "../files/home/raymond/.openclaw/workspace/collection/lib/agenda-sync.mjs";
import {
  beijingMondayMs,
  normalizeWeek,
} from "../files/home/raymond/.openclaw/workspace/collection/lib/course-weeks.mjs";

register("./ts-resolve.mjs", import.meta.url);

const DAY = 86_400_000;
const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const m18Root =
  process.env.M18_AGENDA_ROOT ||
  path.resolve(packageRoot, "../../../../worktrees/wt-18/.external/agenda");
const storePath = path.join(m18Root, "src/store.ts");
const workerPath = path.join(m18Root, "dist/src/sqlite.worker.js");
const EXPECTED_M18_COMMIT = "53962ecd7b02c71aea7420401b2f2ef73b74d3e3";
const available = existsSync(storePath) && existsSync(workerPath);
let m18Commit = null;
if (available) {
  try {
    m18Commit = execFileSync("git", ["-C", m18Root, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {}
}
const skip = !available
  ? `M18 checkout not found (${m18Root}); set M18_AGENDA_ROOT`
  : m18Commit !== EXPECTED_M18_COMMIT && process.env.M18_ALLOW_ANY_TIP !== "1"
    ? `M18 checkout is ${m18Commit ?? "unknown"}, expected ${EXPECTED_M18_COMMIT}; set M18_ALLOW_ANY_TIP=1 to test another tip`
    : false;

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

function validWeek(monday, name = "数学") {
  return week(monday, {
    0: [slot(monday, 0, 8, 10, name)],
  });
}

function cancelledWeek(monday, name = "数学") {
  return week(monday, {
    0: [slot(monday, 0, 8, 10, name, { status: "cancelled", cancelReason: "老师通知停课" })],
  });
}

function payloadFor(firstContent, secondContent, checkedAt = NOW.toISOString()) {
  const weeks = [
    normalizeWeek(MONDAY, { monday: MONDAY, content: firstContent }, { now: NOW }),
    normalizeWeek(NEXT_MONDAY, { monday: NEXT_MONDAY, content: secondContent }, { now: NOW }),
  ];
  return buildScheduleSyncPayload({ checkedAt, weeks });
}

async function withStore(fn) {
  const [{ openAgendaStore }] = await Promise.all([import(pathToFileURL(storePath).href)]);
  const dir = mkdtempSync(path.join(tmpdir(), "m18-m19-integration-"));
  const store = openAgendaStore({
    databasePath: path.join(dir, "agenda.sqlite"),
    workerModuleUrl: pathToFileURL(workerPath),
  });
  try {
    return await fn(store);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const assertCurrent = () => {};

test("M18 真实 store：首次 sync 创建课程，数组回执完整", { skip }, async () => {
  const payload = payloadFor(validWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  await withStore(async (store) => {
    const receipt = await store.sync(payload, assertCurrent);
    assert.equal(receipt.ok, true);
    assert.equal(receipt.replayed, false);
    assert.equal(receipt.changed, true);
    assert.equal(receipt.created.length, 2);
    assert.ok(Array.isArray(receipt.updated));
    assert.ok(Array.isArray(receipt.unchanged));
    assert.ok(Array.isArray(receipt.adopted));
    assert.ok(Array.isArray(receipt.restored));
    assert.ok(Array.isArray(receipt.cancelled));
    assert.ok(Array.isArray(receipt.unlisted));
    assert.ok(Array.isArray(receipt.ignoredCancellations));
    assert.ok(Array.isArray(receipt.completedHistory));
    assert.ok(Array.isArray(receipt.failures));
  });
});

test("M18 真实 store：同 payload replay 不 bump revision 但刷新 checkedAt", { skip }, async () => {
  const payload = payloadFor(validWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  await withStore(async (store) => {
    const first = await store.sync(payload, assertCurrent);
    const before = (await store.read({ includeCompleted: true })).sources.find(
      (source) => source.id === "yungu-schedule",
    );
    assert.ok(before?.checkedAt);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const replay = await store.sync(payload, assertCurrent);
    const after = (await store.read({ includeCompleted: true })).sources.find(
      (source) => source.id === "yungu-schedule",
    );
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.changed, false);
    assert.equal(replay.revision, first.revision);
    assert.ok(
      Date.parse(after.checkedAt) > Date.parse(before.checkedAt),
      `checkedAt should refresh: ${before.checkedAt} -> ${after.checkedAt}`,
    );
  });
});

test("M18 真实 store：失败 message/detail 变化产生新 operationId 并被接受", { skip }, async () => {
  const empty = payloadFor(validWeek(MONDAY), week(NEXT_MONDAY), "2026-11-03T01:00:00.000Z");
  const mismatch = (() => {
    const weeks = [
      normalizeWeek(MONDAY, { monday: MONDAY, content: validWeek(MONDAY) }, { now: NOW }),
      normalizeWeek(
        NEXT_MONDAY,
        {
          err: "WEEK_DATE_MISMATCH",
          detail: "返回 2026-11-02..2026-11-08 的槽位不属于请求周",
        },
        { now: NOW },
      ),
    ];
    return buildScheduleSyncPayload({
      checkedAt: "2026-11-03T01:00:00.000Z",
      weeks,
    });
  })();
  assert.notEqual(empty.operationId, mismatch.operationId);
  await withStore(async (store) => {
    const first = await store.sync(empty, assertCurrent);
    assert.equal(first.ok, true);
    const second = await store.sync(mismatch, assertCurrent);
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.notEqual(second.code, "operation_id_reused");
    const source = (await store.read({ includeCompleted: true })).sources.find(
      (entry) => entry.id === "yungu-schedule",
    );
    assert.equal(source.status, "error");
    assert.match(source.message, /WEEK_DATE_MISMATCH/);
  });
});

test("M18 真实 store：显式课程取消按稳定 observedAt 生效并保留数组回执", { skip }, async () => {
  const initial = payloadFor(validWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  const firstCancel = payloadFor(cancelledWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  const secondCancel = payloadFor(cancelledWeek(MONDAY), validWeek(NEXT_MONDAY, "英语"));
  assert.equal(firstCancel.operationId, secondCancel.operationId);
  assert.equal(firstCancel.cancellations.length, 1);
  await withStore(async (store) => {
    const created = await store.sync(initial, assertCurrent);
    assert.equal(created.ok, true);
    const cancelled = await store.sync(firstCancel, assertCurrent);
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    assert.ok(Array.isArray(cancelled.cancelled));
    assert.equal(cancelled.cancelled.length, 1);
    const replay = await store.sync(secondCancel, assertCurrent);
    assert.equal(replay.replayed, true);
    assert.equal(replay.changed, false);
  });
});
