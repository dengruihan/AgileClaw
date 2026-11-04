#!/usr/bin/env node
import { readFile, mkdir } from "node:fs/promises";
// Serves synthetic Agenda data against a built asset directory and captures
// sanitized before/after screenshots. No live database, Gateway, or personal data.
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
const playwrightRoot =
  args.get("--playwright-root") ?? "/home/raymond/repos/AgileClaw/package.json";
if (!args.get("--assets") || !args.get("--out")) {
  throw new Error("Usage: screenshot.mjs --assets <dir> --out <dir> [--label before]");
}

const DAY = 86_400_000;
const OFFSET = 8 * 3_600_000;
const beijing = (value) => new Date(new Date(value).getTime() + OFFSET).toISOString().slice(0, 10);
const today = beijing(Date.now());
const dayStart = (date) => Date.parse(`${date}T00:00:00+08:00`);
const addDays = (date, count) => beijing(dayStart(date) + count * DAY);
const at = (date, time) => new Date(`${date}T${time}:00+08:00`).toISOString();
const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
const monday = addDays(today, -(weekday === 0 ? 6 : weekday - 1));
const sunday = addDays(monday, 6);
const yesterday = addDays(today, -1);
const daysAgo = new Date(Date.now() - 9 * DAY).toISOString();

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
const snapshot = {
  revision: 42,
  updatedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  items: [...courses.map((entry) => entry.item), task, undated, meeting],
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
const server = createServer((req, res) => {
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
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const shots = [
    ["desktop-light", "?display=desktop&theme=light"],
    ["week-light", "?view=week&theme=light"],
    ["desktop-dark", "?display=desktop&theme=dark"],
  ];
  for (const [name, search] of shots) {
    await page.goto(`${origin}/agenda/${search}`, { waitUntil: "networkidle" });
    await page.waitForSelector(".app-shell");
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${label}-${name}.png`), fullPage: true });
  }
  // A dedicated sidebar capture in a tall viewport: open every group so the
  // history/undated distinction is visible without a clipped panel.
  const sidePage = await browser.newPage({ viewport: { width: 1440, height: 2000 } });
  await sidePage.goto(`${origin}/agenda/?view=week&theme=light`, { waitUntil: "networkidle" });
  await sidePage.waitForSelector(".app-shell");
  await sidePage.evaluate(() => {
    for (const details of document.querySelectorAll("details.task-group")) {
      details.setAttribute("open", "");
    }
  });
  await sidePage.waitForTimeout(300);
  await sidePage.locator(".sidebar").screenshot({
    path: path.join(outDir, `${label}-sidebar.png`),
  });
  await sidePage.close();
} finally {
  await browser.close();
  server.close();
}
console.log(`captured ${label} screenshots in ${outDir}`);
