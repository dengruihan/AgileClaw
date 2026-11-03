#!/usr/bin/env bash
# Read-only status: package vs live file hashes, cron payload/trigger, Agenda sync health.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

while read -r rel; do
  target="$(target_path "$rel")"
  want="$(sha256_file "$FILES_DIR/$rel")"
  if [[ ! -e "$target" ]]; then
    printf 'missing  %s\n' "$target"
  elif [[ "$(sha256_file "$target")" == "$want" ]]; then
    printf 'deployed %s\n' "$target"
  else
    printf 'drifted  %s\n' "$target"
  fi
done < <(package_files)

if job="$(cron_get 2>/dev/null)"; then
  printf '%s' "$job" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const j=JSON.parse(s);const crypto=require("node:crypto");const h=(x)=>crypto.createHash("sha256").update(String(x??"").replace(/\n$/,"")).digest("hex");process.stdout.write(JSON.stringify({enabled:j.enabled,messageSha256:h(j.payload?.message),triggerSha256:h(j.trigger?.script),toolsAllow:j.payload?.toolsAllow,schedule:j.schedule},null,1)+"\n")})'
else
  echo "cron: unavailable"
fi

echo "--- Agenda sync endpoint"
if curl -fsS --max-time 3 "$SESSION_URL" >/dev/null 2>&1; then
  echo "session: ok（$SESSION_URL）"
else
  echo "session: unavailable（$SESSION_URL）"
fi

echo "--- latest backup"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1 || true
