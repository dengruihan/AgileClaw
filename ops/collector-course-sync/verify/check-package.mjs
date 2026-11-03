#!/usr/bin/env node
// Static contract checks for M19 (collector deterministic course sync).
// Protects: per-week success/coverage, no direct DB writes, absence != cancellation,
// explicit-evidence cancellation, automatic sync without model involvement,
// no sentinel re-enable, deploy backups, and privacy/hygiene.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const exists = (rel) => existsSync(join(root, rel));

const FILES = "files/home/raymond/.openclaw";
const SOURCE = `${FILES}/workspace/collection/sources/yungu-schedule.mjs`;
const WEEKS = `${FILES}/workspace/collection/lib/course-weeks.mjs`;
const SYNC = `${FILES}/workspace/collection/lib/agenda-sync.mjs`;
const COLLECT = `${FILES}/workspace/collection/collect.mjs`;
const README = `${FILES}/workspace/collection/README.md`;
const TRIAGE = `${FILES}/workspace/skills/collector-source-triage/SKILL.md`;
const YUNGU_SKILL = `${FILES}/workspace/skills/yungu-schedule/SKILL.md`;
const SCHEDULE_SWEEP = `${FILES}/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md`;
const PKG_README = "README.md";

let passed = 0;
const failures = [];
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail ? `${label}: ${detail}` : label);
}
const has = (text, needle) => text.includes(needle);

// --- 1. Package shape --------------------------------------------------------
for (const path of [
  SOURCE,
  WEEKS,
  SYNC,
  COLLECT,
  README,
  TRIAGE,
  YUNGU_SKILL,
  SCHEDULE_SWEEP,
  PKG_README,
]) {
  check(`file exists: ${path}`, exists(path));
}
for (const script of ["deploy.sh", "rollback.sh", "status.sh", "lib.sh"]) {
  check(`script exists: ${script}`, exists(`scripts/${script}`));
}
for (const banned of [
  "payload-message.txt",
  "trigger-collector.mjs",
  "config.mjs",
  "dingtalk-notify.mjs",
]) {
  check(`package does not ship ${banned}`, !exists(`${FILES}/workspace/collection/${banned}`));
}
check("package ships no cron payload file", !exists("payload-message.txt"));

const norm = (text) => text.replace(/"/g, "'");
const source = norm(read(SOURCE));
const weeks = norm(read(WEEKS));
const sync = norm(read(SYNC));
const collect = norm(read(COLLECT));
const readme = read(README);
const triage = read(TRIAGE);
const yunguSkill = read(YUNGU_SKILL);
const scheduleSweep = read(SCHEDULE_SWEEP);
const pkgReadme = read(PKG_README);
const deploy = read("scripts/deploy.sh");
const rollback = read("scripts/rollback.sh");
const status = read("scripts/status.sh");
const lib = read("scripts/lib.sh");

// --- 2. Week normalization ---------------------------------------------------
for (const [label, needle] of [
  ["per-week success object", "normalizeWeek"],
  ["date mismatch rejection", "WEEK_DATE_MISMATCH"],
  ["empty week rejection", "EMPTY_WEEK"],
  ["same-start conflict rejection", "DUPLICATE_OCCURRENCE"],
  ["invalid slot rejection", "INVALID_SLOT"],
  ["invalid content rejection", "INVALID_CONTENT"],
  ["coverage from latest successful run only", "latestSuccessfulRun"],
  ["coverage carries weeks", "weeks: weeks.map(weekSummary)"],
  ["out-of-week detail names dates", "不属于请求周"],
  ["duplicates dropped", "counts.duplicates += 1"],
  ["Beijing Monday anchor", "beijingMondayMs"],
  ["Beijing ISO with offset", "beijingIso"],
  ["free labels excluded", "寄宿社区时间"],
  ["personal time excluded", "个人时间"],
  ["evening study excluded", "晚自修"],
  ["placeholder names excluded", "第\\d+节"],
  ["explicit cancellation field only", "status"],
]) {
  check(`weeks: ${label}`, has(weeks, needle), needle);
}
check(
  "weeks: no direct DB or tool access",
  !/sqlite|agenda\.sqlite|openAgendaStore|createAgendaTool/.test(weeks),
);

// --- 3. Source adapter -------------------------------------------------------
for (const [label, needle] of [
  ["imports pure normalization", "from '../lib/course-weeks.mjs'"],
  ["imports Agenda sync client", "from '../lib/agenda-sync.mjs'"],
  ["calls sync after successful fetch", "await sync(payload)"],
  ["does not call sync when all weeks fail", "if (!normalized.ok) return normalized;"],
  ["session relogin path", "RELOGIN_FAILED"],
  ["sync failure does not fail source", "normalized.coverage.sync = receipt"],
  ["no direct database", "sqlite"],
]) {
  if (label === "no direct database") {
    check("source: no direct database", !/sqlite|agenda\.sqlite|openAgendaStore/.test(source));
  } else {
    check(`source: ${label}`, has(source, needle), needle);
  }
}
check("source: no child_process database access", !/child_process/.test(source));
check("source: no notification sending", !/dingtalk-notify|sendMessage|message\s*\(/.test(source));

// --- 4. Agenda HTTP client ---------------------------------------------------
for (const [label, needle] of [
  ["sync path", "/agenda/api/sync"],
  ["session path", "/agenda/api/session"],
  ["csrf header", "X-Agenda-CSRF"],
  ["origin header", "Origin:"],
  ["content type", "application/json"],
  ["512 KiB body bound", "512 * 1024"],
  ["timeout", "AGENDA_SYNC_TIMEOUT"],
  ["unreachable error", "AGENDA_SYNC_UNREACHABLE"],
  ["session failure", "AGENDA_SYNC_SESSION_FAILED"],
  ["bad receipt", "AGENDA_SYNC_BAD_RECEIPT"],
  ["business rejection 409", "response.status === 400 || response.status === 409"],
  ["no cookie forwarding", "不转发 Set-Cookie"],
  ["payload too large", "AGENDA_SYNC_PAYLOAD_TOO_LARGE"],
  ["receipt ok check", "typeof parsed.ok !== 'boolean'"],
  ["deterministic operationId", "syncOperationId"],
  ["source id", "sourceId = 'yungu-schedule'"],
  ["label", "label: '云谷课表'"],
  ["window from successful run", "windowStart"],
  ["failed week message", "message: week.ok"],
  ["only course slots", "classification === 'course'"],
  ["explicit evidence kind", "kind: 'platform'"],
  ["unlisted semantics documented", "unlisted"],
]) {
  check(`sync: ${label}`, has(sync, needle), needle);
}
check(
  "sync: no filesystem or database writes",
  !/node:fs|node:sqlite|sqlite3|writeFile|appendFile|openAgendaStore/.test(sync),
);
check("sync: no outbound notification", !/dingtalk-notify|sendMessage|message\s*\(/.test(sync));

// --- 5. Collector runtime ----------------------------------------------------
check("collect: awaits adapters", has(collect, "result = await mod.collect();"));
check("collect: keeps report/health/snapshot flow", has(collect, "writeJsonAtomic"));
check(
  "collect: still one summary line per source",
  has(collect, "console.log(JSON.stringify(line))"),
);

// --- 6. Docs and guidance ----------------------------------------------------
for (const [label, needle] of [
  ["weekly coverage semantics", "coverage"],
  ["failed weeks excluded", "失败周"],
  ["automatic Agenda sync", "Agenda sync"],
  ["no direct DB writes", "SQLite 写入仍由 Agenda"],
  ["absence is unlisted", "unlisted"],
  ["explicit cancellation evidence", "显式取消"],
]) {
  check(`collection README: ${label}`, has(readme, needle), needle);
}
for (const [label, needle] of [
  ["courses already synced", "已直接调用 Agenda sync"],
  ["no manual import", "不需要模型判断是否导入"],
  ["failed weeks are not free", "不得当作空闲或已覆盖"],
  ["unlisted is not cancellation", "不删课、不改成取消"],
  ["explicit evidence only", "槽位消失不算取消"],
  ["next-cycle retry", "下一轮成功抓取会自动重试"],
  ["agenda range read before apply", "先读目标区间、再 apply"],
]) {
  check(`triage: ${label}`, has(triage, needle), needle);
}
for (const [label, needle] of [
  ["automatic collector sync", "collector 每 6 小时"],
  ["next-week copy is rejected", "把“下周”返回成本周"],
  ["date mismatch fails the week", "该周判失败"],
]) {
  check(`yungu skill: ${label}`, has(yunguSkill, needle), needle);
}
for (const [label, needle] of [
  ["collector is background entry", "后台收集/唤醒只有既有 `collector`"],
  ["sentinel disabled and not re-enabled", "`sentinel` 已停用，不重新启用"],
  ["no new synchronizer", "不得另建同步器或自动化"],
  ["courses auto-sync", "自动同步进 Agenda"],
  ["absence is unlisted", "缺席只算 unlisted"],
  ["cancellation evidence", "平台显式取消状态"],
  ["failed week not free", "失败周不当空闲"],
  ["replanner sentinel dependency honest", "自动重排依赖 `sentinel`"],
  ["no sentinel re-enable for feedback", "不因此重新启用 `sentinel`"],
]) {
  check(`schedule-sweep: ${label}`, has(scheduleSweep, needle), needle);
}
check(
  "schedule-sweep: does not claim sentinel is the live background owner",
  !has(scheduleSweep, "后台只有既有 `sentinel`"),
);

// --- 7. Deploy / rollback safety --------------------------------------------
for (const forbidden of ["cron edit", "--trigger-script", "--message", "--tools", "--enabled"]) {
  check(`deploy does not run ${forbidden}`, !has(deploy, forbidden));
  check(`rollback does not run ${forbidden}`, !has(rollback, forbidden));
}
check("deploy runs package checks", has(deploy, "verify/check-package.mjs"));
check("deploy runs isolated tests", has(deploy, "verify/course-sync.test.mjs"));
check("deploy requires the Agenda sync endpoint", has(deploy, "require_sync_endpoint"));
check(
  "preflight probes the POST sync route, not just session",
  has(lib, '-X POST "$SYNC_URL"') && has(lib, "200|400|403|409"),
);
check(
  "deploy backs up before copying",
  deploy.indexOf("manifest.tsv") < deploy.indexOf('cp -p "$FILES_DIR'),
);
check("deploy records absent targets", has(deploy, "printf 'absent"));
check("deploy verifies hashes after copy", has(deploy, "hash mismatch after deploy"));
check(
  "deploy has a collect.mjs drift guard",
  has(deploy, "--allow-drift") && has(deploy, "baselines/collect.pre-m19.mjs"),
);
check(
  "baseline collect.mjs is the pre-M19 copy",
  exists("baselines/collect.pre-m19.mjs") &&
    !has(read("baselines/collect.pre-m19.mjs"), "await mod.collect()"),
);
check("deploy supports dry run by default", has(deploy, "dry run"));
check("deploy does not delete anything", !/\brm\b/.test(deploy));
check("rollback restores from the backup", has(rollback, 'cp -p "$backup_dir/files/$rel"'));
check("rollback removes pre-deploy-absent files", has(rollback, 'rm -f "$target"'));
check("rollback verifies restored hashes", has(rollback, "回滚后 hash 不符"));
check("status is read-only", !/cron edit|cp |\brm\b/.test(status));
check("lib keeps DEPLOY_ROOT override", has(lib, "DEPLOY_ROOT="));
check(
  "lib keeps backup root under ~/.openclaw/backups",
  has(lib, ".openclaw/backups/collector-course-sync"),
);

// --- 8. Privacy and content hygiene -----------------------------------------
const textFiles = [
  source,
  weeks,
  sync,
  collect,
  readme,
  triage,
  yunguSkill,
  scheduleSweep,
  pkgReadme,
  deploy,
  rollback,
  status,
  lib,
].join("\n");
check("no private person names", !/(李婕|李林平|Jason Lee)/.test(textFiles));
check("no phone-like number", !/(?<!\d)1[3-9]\d{9}(?!\d)/.test(textFiles));
check("no 15+ digit identifier", !/\d{15,}/.test(textFiles));
check(
  "no token/password assignment",
  !/(token|password|secret)\s*[:=]\s*["'][A-Za-z0-9_\-]{12,}["']/i.test(
    [source, weeks, sync, readme, triage, yunguSkill, scheduleSweep, pkgReadme].join("\n"),
  ),
);
check("no credential file paths", !/\.ssh\/|(^|\/)\.env(?:\.|$)/m.test(textFiles));
check(
  "no real extension id or enrollment value",
  !/\b(?:oc_|on_)[A-Za-z0-9]{20,}\b/.test(textFiles),
);

// L4 anti-patterns in model-facing docs.
for (const [name, text] of [
  ["triage skill", triage],
  ["yungu skill", yunguSkill],
  ["schedule-sweep skill", scheduleSweep],
]) {
  check(
    `${name}: no changelog/version narration`,
    !/(最后修订[：:]|最后更新[：:]|^## ?(更新记录|Changelog|版本历史)|Skill 版本|首次验证[：:])/m.test(
      text,
    ),
  );
}

// --- 9. Package README completeness -----------------------------------------
for (const needle of [
  "./scripts/deploy.sh --yes",
  "./scripts/rollback.sh --yes",
  "./scripts/status.sh",
  "verify/check-package.mjs",
  "verify/course-sync.test.mjs",
  "WEEK_DATE_MISMATCH",
  "unlisted",
  "operationId",
  "部署后验证",
  "未完成/等待依赖",
]) {
  check(`package README mentions: ${needle}`, has(pkgReadme, needle), needle);
}

if (failures.length) {
  console.error(`FAIL ${failures.length} / ${passed + failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`PASS ${passed} checks`);
