#!/usr/bin/env bash
# Restore the latest collector course-sync deployment backup (files + cron payload/trigger).
# Usage: ./scripts/rollback.sh [--yes] [backup-dir]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

apply=false
backup_dir=""
for arg in "$@"; do
  case "$arg" in
    --yes) apply=true ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) backup_dir="$arg" ;;
  esac
done

if [[ -z "$backup_dir" ]]; then
  backup_dir="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort | tail -1)"
fi
if [[ -z "$backup_dir" || ! -f "$backup_dir/manifest.tsv" ]]; then
  echo "没有可用备份：$BACKUP_ROOT" >&2
  exit 1
fi
for required in job.before.json payload-message.before.txt trigger-collector.before.mjs; do
  if [[ ! -f "$backup_dir/$required" ]]; then
    echo "备份缺少 $required：$backup_dir" >&2
    exit 1
  fi
done

echo "回滚计划（$backup_dir）："
while IFS=$'\t' read -r state rel _; do
  target="$(target_path "$rel")"
  if [[ "$state" == present ]]; then
    printf '  restore %s\n' "$target"
  else
    printf '  remove  %s（部署前不存在）\n' "$target"
  fi
done <"$backup_dir/manifest.tsv"
echo "  cron $JOB_ID: 恢复 payload.message 与 trigger.script"

if ! $apply; then
  echo "dry run：加 --yes 执行。"
  exit 0
fi

job_now="$(cron_get)"
printf '%s\n' "$job_now" >"$backup_dir/job.before-rollback.json"

while IFS=$'\t' read -r state rel expected; do
  target="$(target_path "$rel")"
  if [[ "$state" == present ]]; then
    if [[ ! -f "$backup_dir/files/$rel" ]]; then
      echo "备份缺少 $rel" >&2
      exit 1
    fi
    mkdir -p "$(dirname "$target")"
    cp -p "$backup_dir/files/$rel" "$target"
    if [[ "$(sha256_file "$target")" != "$expected" ]]; then
      echo "回滚后 hash 不符：$target" >&2
      exit 1
    fi
  else
    if [[ -e "$target" ]]; then
      rm -f "$target"
    fi
  fi
done <"$backup_dir/manifest.tsv"

trigger_target="$(target_path "$TRIGGER_REL")"
if ! cron_edit --trigger-script "$backup_dir/trigger-collector.before.mjs" --message "$(cat "$backup_dir/payload-message.before.txt")" >/dev/null; then
  echo "cron 回滚失败；文件已恢复，可用 job.before.json 手工核对" >&2
  exit 1
fi
cron_get >"$backup_dir/job.after-rollback.json"
if ! verify_job_files \
  "$backup_dir/job.before-rollback.json" \
  "$backup_dir/job.after-rollback.json" \
  "$backup_dir/payload-message.before.txt" \
  "$backup_dir/trigger-collector.before.mjs"; then
  echo "cron 回滚校验失败；备份保留在 $backup_dir" >&2
  exit 1
fi

echo "回滚完成：$backup_dir"
