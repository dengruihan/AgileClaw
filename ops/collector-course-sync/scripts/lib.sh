#!/usr/bin/env bash
# Shared paths for the collector course-sync deployment package.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES_DIR="$PKG_DIR/files"
BACKUP_ROOT="${HOME}/.openclaw/backups/collector-course-sync"
JOB_ID="6a45be21-ce0b-4b8b-8986-4c885d1ea659"
PAYLOAD_FILE="$PKG_DIR/payload-message.txt"
TRIGGER_REL="home/raymond/.openclaw/workspace/collection/trigger-collector.mjs"
SYNC_URL="${AGENDA_SYNC_URL:-http://127.0.0.1:18810/agenda/api/sync}"
SESSION_URL="${AGENDA_SESSION_URL:-http://127.0.0.1:18810/agenda/api/session}"
AGENDA_SYNC_ORIGIN="${AGENDA_SYNC_ORIGIN:-http://127.0.0.1:18810}"
DEPLOY_ROOT="${DEPLOY_ROOT:-/}"

timestamp() {
  date -u +%Y%m%dT%H%M%SZ
}

# files/home/raymond/... -> ${DEPLOY_ROOT}/home/raymond/...
target_path() {
  local rel="${1#"$FILES_DIR"/}"
  printf '%s/%s\n' "${DEPLOY_ROOT%/}" "${rel#files/}"
}

# 包内所有部署文件（相对 files/ 的路径）
package_files() {
  (cd "$FILES_DIR" && find . -type f -print | sed 's|^\./||' | sort)
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

cron_get() {
  "$OPENCLAW_BIN" cron get "$JOB_ID" --json
}

cron_edit() {
  "$OPENCLAW_BIN" cron edit "$JOB_ID" "$@"
}

# Verify the embedded cron copy matches the deployed files and untouched fields did not move.
# Usage: verify_job_files <before.json> <after.json> <payload-file> <trigger-file>
verify_job_files() {
  node - "$1" "$2" "$3" "$4" <<'NODE'
const fs = require('node:fs');
const [beforePath, afterPath, payloadPath, triggerPath] = process.argv.slice(2);
const before = JSON.parse(fs.readFileSync(beforePath, 'utf8'));
const after = JSON.parse(fs.readFileSync(afterPath, 'utf8'));
const payload = fs.readFileSync(payloadPath, 'utf8').replace(/\n$/, '');
const trigger = fs.readFileSync(triggerPath, 'utf8').replace(/\n$/, '');
const failures = [];
if (String(after?.payload?.message ?? '').replace(/\n$/, '') !== payload) failures.push('payload.message');
if (String(after?.trigger?.script ?? '').replace(/\n$/, '') !== trigger) failures.push('trigger.script');
const pick = (job) => ({
  enabled: job.enabled,
  schedule: job.schedule,
  sessionTarget: job.sessionTarget,
  wakeMode: job.wakeMode,
  delivery: job.delivery,
  payloadKind: job.payload?.kind,
  timeoutSeconds: job.payload?.timeoutSeconds,
  lightContext: job.payload?.lightContext,
  toolsAllow: job.payload?.toolsAllow,
});
const expected = JSON.stringify(pick(before));
const actual = JSON.stringify(pick(after));
if (expected !== actual) failures.push(`untouched fields changed\n  before=${expected}\n  after=${actual}`);
if (failures.length) {
  console.error(`cron job verification failed: ${failures.join(', ')}`);
  process.exit(1);
}
NODE
}

require_sync_endpoint() {
  local token code
  token="$(curl -fsS --max-time 3 "$SESSION_URL" 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(JSON.parse(s).csrfToken||"")}catch{process.stdout.write("")}})')"
  if [[ -z "$token" ]]; then
    echo "Agenda session 接口不可用或缺少 csrfToken：$SESSION_URL" >&2
    echo "M18 部署后再执行；仅暂存文件可加 --allow-missing-sync。" >&2
    return 1
  fi
  # 空 body 只用于探测路由是否存在：400/403/409 都说明 sync 路由已部署且会拒绝非法请求。
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST "$SYNC_URL" \
    -H 'Content-Type: application/json' \
    -H "Origin: ${AGENDA_SYNC_ORIGIN:-http://127.0.0.1:18810}" \
    -H "X-Agenda-CSRF: $token" \
    --data '{}' 2>/dev/null || true)"
  case "$code" in
    200|400|403|409) return 0 ;;
    *)
      echo "Agenda sync 路由未就绪（HTTP ${code:-unreachable}）：$SYNC_URL" >&2
      echo "M18 部署后再执行；仅暂存文件可加 --allow-missing-sync。" >&2
      return 1
      ;;
  esac
}
