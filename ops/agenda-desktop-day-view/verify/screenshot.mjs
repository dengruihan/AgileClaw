#!/usr/bin/env node
// Serves synthetic Agenda data against a built asset directory and captures
// sanitized before/after screenshots. No live database, Gateway, or personal data.
// With --verify unified it also asserts the desktop day page is one whole-day
// table and that details, completion, all-day items, and deadlines stay wired.
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const assets = path.resolve(args.get("--assets") ?? "");
const outDir = path.resolve(args.get("--out") ?? "");
const label = args.get("--label") ?? "agenda";
const verifyUnifiedDay = args.get("--verify") === "unified";
const playwrightRoot =
  args.get("--playwright-root") ?? "/home/raymond/repos/AgileClaw/package.json";
if (!args.get("--assets") || !args.get("--out")) {
  throw new Error(
    "Usage: screenshot.mjs --assets <dir> --out <dir> [--label before|after] [--verify unified]",
  );
}

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const beijing = (value) => new Date(new Date(value).getTime() + OFFSET).toISOString().slice(0, 10);
const today = beijing(Date.now());
const tomorrow = beijing(Date.now() + DAY);
const dayStart = (date) => Date.parse(`${date}T00:00:00+08:00`);
const addDays = (date, count) => beijing(dayStart(date) + count * DAY);
const at = (date, time) => new Date(`${date}T${time}:00+08:00`).toISOString();
const fixedNow = at(today, "11:30");
const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
const monday = addDays(today, -(weekday === 0 ? 6 : weekday - 1));
const sunday = addDays(monday, 6);
const yesterday = addDays(today, -1);
const daysAgo = new Date(Date.parse(fixedNow) - 9 * DAY).toISOString();

const course = (id, title, date, start, end) => ({
  item: {
    id,
    kind: "event",
    title,
    status: "pending",
    sourceId: "yungu-schedule",
    sourceKey: at(date, start),
    sourceUrl: null,
    dueAt: null,
    dueDate: null,
    estimatedMinutes: null,
    priority: "normal",
    nextAction: "",
    reason: null,
    completedBy: null,
    updatedAt: daysAgo,
  },
  block: {
    id: `${id}-block`,
    itemId: id,
    start: at(date, start),
    end: at(date, end),
    allDay: false,
    locked: true,
    reason: "来源课表",
  },
});
const courses = [
  course("course-math", "数学", today, "08:10", "08:50"),
  course("course-physics", "物理", today, "10:00", "10:40"),
  course("course-english", "英语", today, "14:00", "14:40"),
  course("course-chem", "化学", yesterday, "08:10", "08:50"),
  course("course-bio", "生物", yesterday, "10:00", "10:40"),
];
const task = {
  id: "task-notes",
  kind: "task",
  title: "整理研究笔记",
  status: "pending",
  sourceId: "local",
  sourceKey: null,
  sourceUrl: null,
  dueAt: null,
  dueDate: null,
  estimatedMinutes: 60,
  priority: "important",
  nextAction: "整理第一部分",
  reason: null,
  completedBy: null,
  updatedAt: daysAgo,
};
const undated = { ...task, id: "task-weekly", title: "写周报", nextAction: "汇总本周进展" };
const meeting = {
  ...task,
  id: "meeting-group",
  kind: "event",
  title: "小组会议",
  priority: "normal",
  nextAction: "",
};
const allDayEvent = { ...meeting, id: "event-openday", title: "校园开放日" };
const deadlineTask = {
  ...task,
  id: "task-report",
  title: "提交实验报告",
  dueAt: at(today, "21:00"),
  nextAction: "上传最终版",
};
const snapshot = {
  revision: 42,
  updatedAt: new Date(Date.parse(fixedNow) - 10 * 60_000).toISOString(),
  items: [...courses.map((entry) => entry.item), task, undated, meeting, allDayEvent, deadlineTask],
  blocks: [
    ...courses.map((entry) => entry.block),
    {
      id: "block-notes",
      itemId: task.id,
      start: at(today, "16:00"),
      end: at(today, "17:00"),
      allDay: false,
      locked: false,
      reason: "下午整理",
    },
    {
      id: "block-meeting",
      itemId: meeting.id,
      start: at(today, "19:00"),
      end: at(today, "19:30"),
      allDay: false,
      locked: true,
      reason: "固定会议",
    },
    {
      id: "block-openday",
      itemId: allDayEvent.id,
      start: at(today, "00:00"),
      end: at(tomorrow, "00:00"),
      allDay: true,
      locked: false,
      reason: "全天活动",
    },
  ],
  sources: [
    {
      id: "yungu-schedule",
      label: "云谷课表",
      checkedAt: daysAgo,
      status: "ok",
      message: null,
      coverageRequired: true,
      coverageStart: monday,
      coverageEnd: sunday,
      managedBy: "source",
    },
    {
      id: "local",
      label: "本地任务",
      checkedAt: null,
      status: "ok",
      message: null,
      coverageRequired: false,
      coverageStart: null,
      coverageEnd: null,
      managedBy: "agent",
    },
  ],
  blockProgress: [],
  feedback: [],
};

const types = new Map([
  ["/agenda/", ["index.html", "text/html; charset=utf-8"]],
  ["/agenda/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/agenda/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/agenda/app.css", ["app.css", "text/css; charset=utf-8"]],
]);
const files = new Map();
for (const [route, [name, contentType]] of types) {
  files.set(route, { content: await readFile(path.join(assets, name)), contentType });
}
let feedbackRequest = null;
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/agenda/api/snapshot") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(snapshot));
    return;
  }
  if (url.pathname === "/agenda/api/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ revision: snapshot.revision }));
    return;
  }
  if (url.pathname === "/agenda/api/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`event: revision\ndata: ${JSON.stringify({ revision: snapshot.revision })}\n\n`);
    return;
  }
  if (url.pathname === "/agenda/api/session") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ csrfToken: "synthetic" }));
    return;
  }
  if (url.pathname === "/agenda/api/feedback" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    feedbackRequest = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, operationId: feedbackRequest.operationId, revision: 43 }));
    return;
  }
  const asset = files.get(url.pathname);
  if (!asset) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "Content-Type": asset.contentType });
  res.end(asset.content);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const require = createRequire(playwrightRoot);
const { chromium } = require("playwright");
const browser = await chromium.launch();
await mkdir(outDir, { recursive: true });
const assert = (condition, message) => {
  if (!condition) throw new Error(`unified day view check failed: ${message}`);
};
try {
  const shots = [
    { name: "desktop-light", width: 1440, height: 900 },
    { name: "desktop-dark", width: 1440, height: 900 },
    { name: "desktop-light-1280", width: 1280, height: 800 },
    { name: "desktop-light-1280-bottom", width: 1280, height: 800, scrollBottom: true },
  ];
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } });
    await page.clock.setFixedTime(new Date(fixedNow));
    const theme = shot.name.includes("dark") ? "dark" : "light";
    await page.goto(`${origin}/agenda/?display=desktop&theme=${theme}`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".app-shell");
    await page.waitForTimeout(400);
    if (shot.scrollBottom) {
      await page.evaluate(() => {
        const scroll = document.querySelector(".timeline-scroll");
        if (scroll) scroll.scrollTop = scroll.scrollHeight;
      });
      await page.waitForTimeout(200);
    }
    await page.screenshot({
      path: path.join(outDir, `${label}-${shot.name}.png`),
      fullPage: true,
    });
    await page.close();
  }
  if (verifyUnifiedDay) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.clock.setFixedTime(new Date(fixedNow));
    await page.goto(`${origin}/agenda/?display=desktop&theme=light`, {
      waitUntil: "networkidle",
    });
    await page.waitForSelector(".app-shell");
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
      tables: document.querySelectorAll(".day-table-timeline").length,
      rows: document.querySelectorAll(".agenda-rows").length,
      periodSwitch: Boolean(document.querySelector(".period-switch")),
      heading: document.querySelector(".calendar-toolbar h2")?.textContent?.trim() ?? "",
      titles: [...document.querySelectorAll(".agenda-entry-title")].map((node) =>
        node.textContent?.trim(),
      ),
      times: [...document.querySelectorAll(".agenda-entry-time strong")].map((node) =>
        node.textContent?.trim(),
      ),
      allDay: [...document.querySelectorAll(".all-day-event")].map((node) =>
        node.textContent?.trim(),
      ),
      deadlines: [...document.querySelectorAll(".deadline-chip")].map((node) =>
        node.textContent?.trim(),
      ),
      now: document.querySelector(".agenda-now")?.textContent?.trim() ?? null,
      completions: document.querySelectorAll(".agenda-entry .block-completion input").length,
    }));
    assert(state.tables === 1, `expected one full-day table, saw ${state.tables}`);
    assert(state.rows === 1, `expected one row container, saw ${state.rows}`);
    assert(!state.periodSwitch, "the morning/afternoon switch is still rendered");
    assert(state.heading.includes("全天"), `heading did not say 全天: ${state.heading}`);
    assert(
      JSON.stringify(state.times) === JSON.stringify(["08:10", "10:00", "14:00", "16:00", "19:00"]),
      `timed rows span both halves: ${state.times.join(", ")}`,
    );
    for (const title of ["数学", "物理", "英语", "整理研究笔记", "小组会议"]) {
      assert(
        state.titles.some((rendered) => rendered?.includes(title)),
        `missing event ${title}`,
      );
    }
    assert(
      state.allDay.some((title) => title?.includes("校园开放日")),
      "missing all-day item",
    );
    assert(
      state.deadlines.some((title) => title?.includes("提交实验报告")),
      "missing deadline item",
    );
    assert(state.now === "现在 11:30", `current-time marker was ${state.now}`);
    assert(state.completions === 5, `expected 5 completion controls, saw ${state.completions}`);

    await page.locator(".agenda-entry-open").first().click();
    await page.waitForSelector(".detail-dialog[open]");
    const dialog = await page.locator(".detail-dialog").textContent();
    assert(dialog?.includes("数学"), "detail dialog did not open the selected event");
    assert(dialog?.includes("执行安排"), "detail dialog lost its block section");
    await page.locator(".detail-dialog .icon-button").click();

    const [request] = await Promise.all([
      page.waitForRequest((candidate) => candidate.url().includes("/agenda/api/feedback")),
      page.locator(".agenda-entry .block-completion input").first().click(),
    ]);
    const body = request.postDataJSON();
    assert(body.kind === "complete_block", `completion sent ${body.kind}`);
    assert(body.targetId === "course-math-block", `completion targeted ${body.targetId}`);
    assert(feedbackRequest?.operationId === body.operationId, "feedback receipt did not match");
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`captured ${label} screenshots in ${outDir}`);
if (verifyUnifiedDay) console.log("verified one full-day table with details and completion intact");
