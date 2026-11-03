#!/usr/bin/env bash
# Read-only status: package vs live hashes and Agenda sync endpoint health.
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

echo "--- Agenda sync endpoint"
if curl -fsS --max-time 3 "$SESSION_URL" >/dev/null 2>&1; then
  echo "session: ok（$SESSION_URL）"
else
  echo "session: unavailable（$SESSION_URL）"
fi

echo "--- latest backup"
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1 || true
