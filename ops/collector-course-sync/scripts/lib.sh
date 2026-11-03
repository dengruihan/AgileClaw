#!/usr/bin/env bash
# Shared paths for the collector course-sync deployment package.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES_DIR="$PKG_DIR/files"
BACKUP_ROOT="${HOME}/.openclaw/backups/collector-course-sync"
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
