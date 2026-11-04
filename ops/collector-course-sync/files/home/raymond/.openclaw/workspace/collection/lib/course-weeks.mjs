// 云谷课表归一化（纯函数，无网络/文件/数据库依赖）。
// 每个请求周单独判定成功/失败与实际覆盖；槽位日期不属于请求周（平台把下周返回成本周
// 副本）、整周为空或槽位无效时该周判失败，且不计入 coverage。coverage 只取最新连续成功周。
const DAY = 86_400_000;

// 北京时区周一 00:00 对应的毫秒值（锚定正午判定星期，再扣回当天零点=UTC 前一日 16:00）。
export function beijingMondayMs(weeksAhead = 0, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const noonBeijing = Date.UTC(get("year"), get("month") - 1, get("day"), 4, 0, 0);
  const dow = (new Date(noonBeijing).getUTCDay() + 6) % 7;
  return noonBeijing - dow * DAY - 43_200_000 + weeksAhead * 7 * DAY;
}

export function beijingDate(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function beijingIso(ms) {
  return new Date(ms + 8 * 3600_000).toISOString().replace("Z", "+08:00");
}

// 作息/空闲标签：保留在报告与快照里供分诊，但不作为课程同步进 Agenda。
const LABEL_PATTERNS = [
  /^起床$/,
  /^出寝$/,
  /^整理$/,
  /^午餐(?:\/午休)?$/,
  /^晚餐$/,
  /^放学$/,
  /^熄灯就寝$/,
  /晚自修$/,
  /^寄宿社区时间$/,
  /^个人时间$/,
  /^留白时光/,
];

function isPlaceholderName(name) {
  return name === "（未命名）" || /(?:待确认|待定|^TBD$)/i.test(name) || /^第\d+节$/.test(name);
}

export function classifySlot(name) {
  const text = String(name ?? "").trim();
  if (!text || isPlaceholderName(text)) return "placeholder";
  if (LABEL_PATTERNS.some((pattern) => pattern.test(text))) return "label";
  return "course";
}

function explicitCancellation(slot) {
  if (slot?.cancelled === true) {
    return { evidence: "platform_cancelled", reason: String(slot.cancelReason ?? "平台标记取消") };
  }
  if (String(slot?.status ?? "").toLowerCase() === "cancelled") {
    return { evidence: "platform_status", reason: String(slot.cancelReason ?? "平台状态取消") };
  }
  return null;
}

function emptyCounts() {
  return { slots: 0, courses: 0, labels: 0, placeholders: 0, cancelled: 0, duplicates: 0 };
}

export function normalizeWeek(monday, fetched, options = {}) {
  const startAt = monday;
  const endAt = monday + 7 * DAY - 1;
  const base = {
    monday,
    startAt,
    endAt,
    start: beijingDate(startAt),
    end: beijingDate(endAt),
  };
  if (fetched?.err) {
    return {
      ...base,
      ...emptyCounts(),
      ok: false,
      reason: fetched.err,
      detail: fetched.detail || null,
    };
  }
  const content = fetched?.content;
  if (!Array.isArray(content) || content.length !== 7) {
    return {
      ...base,
      ...emptyCounts(),
      ok: false,
      reason: "INVALID_CONTENT",
      detail: `期望 7 天槽位数组，收到 ${Array.isArray(content) ? content.length : typeof content}`,
    };
  }

  const observedNow = (
    options.now instanceof Date ? options.now : options.now ? new Date(options.now) : new Date()
  ).toISOString();
  const previousCancellations = options.previousCancellations ?? new Map();
  const items = [];
  const seen = new Set();
  const starts = new Map();
  const counts = emptyCounts();
  const outside = [];
  const conflicts = [];
  let invalid = 0;

  content.forEach((slots, dayIndex) => {
    if (!Array.isArray(slots)) {
      invalid += 1;
      return;
    }
    for (const slot of slots) {
      const start = Number(slot?.startTime);
      const end = Number(slot?.endTime);
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        invalid += 1;
        continue;
      }
      if (start < startAt || start > endAt) {
        outside.push({ dayIndex, start, name: String(slot?.name ?? "") });
        continue;
      }
      const name = String(slot?.name ?? "").trim() || "（未命名）";
      const key = `ys:${monday}:${start}:${end}:${name}`;
      if (seen.has(key)) {
        counts.duplicates += 1;
        continue;
      }
      seen.add(key);
      // 只有原本是课程的槽位才允许生成取消；标签/占位即使带取消字段也不进 Agenda cancellations。
      const baseClassification = classifySlot(name);
      const cancellation = baseClassification === "course" ? explicitCancellation(slot) : null;
      const classification = cancellation ? "cancelled" : baseClassification;
      // 课程 occurrence 必须 start < end（M18 schema）；作息标签允许零时长（平台常见）。
      const durationOk =
        classification === "course" || classification === "cancelled" ? start < end : start <= end;
      if (!durationOk) {
        invalid += 1;
        continue;
      }
      if (classification === "course" || classification === "cancelled") {
        if (starts.has(start)) {
          conflicts.push({ start, name, first: starts.get(start) });
          continue;
        }
        starts.set(start, name);
      }
      const countKey =
        classification === "course"
          ? "courses"
          : classification === "label"
            ? "labels"
            : classification === "placeholder"
              ? "placeholders"
              : "cancelled";
      counts[countKey] += 1;
      items.push({
        key,
        kind: "slot",
        classification,
        weekMonday: monday,
        dayIndex,
        start,
        end,
        name,
        sourceDate: beijingDate(start),
        ...(cancellation
          ? {
              cancelEvidence: cancellation.evidence,
              cancelReason: cancellation.reason,
              cancelObservedAt: previousCancellations.get(start) || observedNow,
            }
          : {}),
      });
    }
  });

  if (conflicts.length) {
    return {
      ...base,
      ...counts,
      ok: false,
      reason: "DUPLICATE_OCCURRENCE",
      detail: `${conflicts.length} 个槽位与同一 start 的另一门课程冲突（如 ${conflicts[0].first}/${conflicts[0].name}），整周不导入`,
    };
  }
  if (outside.length) {
    const dates = [...new Set(outside.map((slot) => beijingDate(slot.start)))].sort();
    const first = dates[0];
    const last = dates[dates.length - 1];
    return {
      ...base,
      ...counts,
      ok: false,
      reason: "WEEK_DATE_MISMATCH",
      detail: `返回 ${first}${first === last ? "" : `..${last}`} 的 ${outside.length} 个槽位不属于请求周 ${base.start}..${base.end}`,
    };
  }
  if (invalid) {
    return {
      ...base,
      ...counts,
      ok: false,
      reason: "INVALID_SLOT",
      detail: `${invalid} 个槽位缺少有效时间、非正时长或不是数组`,
    };
  }
  if (items.length === 0) {
    return {
      ...base,
      ...counts,
      ok: false,
      reason: "EMPTY_WEEK",
      detail: "响应没有任何课表槽位（可能是未发布模板，不作为已覆盖）",
    };
  }
  return { ...base, ...counts, slots: items.length, ok: true, items };
}

// coverage 只覆盖最新的一段连续成功周；更早的周或断开后的失败周只记录在 weeks 里。
function latestSuccessfulRun(weeks) {
  const sorted = [...weeks].sort((a, b) => a.monday - b.monday);
  let latest = [];
  let current = [];
  for (const week of sorted) {
    if (!week.ok) {
      current = [];
      continue;
    }
    const previous = current[current.length - 1];
    current = previous && week.monday - previous.monday === 7 * DAY ? [...current, week] : [week];
    latest = [...current];
  }
  return latest;
}

function weekSummary(week) {
  const summary = {
    start: week.start,
    end: week.end,
    ok: week.ok,
    slots: week.slots,
    courses: week.courses,
    labels: week.labels,
    placeholders: week.placeholders,
    cancelled: week.cancelled,
    duplicates: week.duplicates,
  };
  if (!week.ok) {
    summary.reason = week.reason;
    if (week.detail) summary.detail = week.detail;
  }
  return summary;
}

function failureDetail(weeks) {
  return weeks
    .map(
      (week) =>
        `${week.start}..${week.end} ${week.ok ? "成功" : `失败 ${week.reason}${week.detail ? `（${week.detail}）` : ""}`}`,
    )
    .join("；");
}

function successNote(run, weeks) {
  const covered = run
    .map(
      (week) =>
        `${week.start}..${week.end} 成功（${week.courses} 课程/${week.labels + week.placeholders} 非课程）`,
    )
    .join("；");
  const failed = weeks.filter((week) => !week.ok);
  const gaps = failed.length
    ? `；未覆盖：${failed.map((week) => `${week.start}..${week.end} ${week.reason}`).join("、")}`
    : "";
  return `${covered}${gaps}；覆盖只含连续成功周，失败周不视为空闲或已覆盖`;
}

export function normalizeSchedule(weeks, { now = new Date() } = {}) {
  const run = latestSuccessfulRun(weeks);
  if (!run.length) {
    return {
      ok: false,
      error: weeks.find((week) => !week.ok)?.reason || "NO_SCHEDULE_DATA",
      detail: failureDetail(weeks),
      weeks,
    };
  }
  const items = run.flatMap((week) => week.items || []);
  const coverage = {
    start: new Date(run[0].startAt).toISOString(),
    end: new Date(run[run.length - 1].endAt).toISOString(),
    dateStart: run[0].start,
    dateEnd: run[run.length - 1].end,
    weeks: weeks.map(weekSummary),
    note: successNote(run, weeks),
  };
  return { ok: true, checkedAt: now.toISOString(), items, weeks, coverage };
}
