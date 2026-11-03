#!/usr/bin/env bash
# Restore the latest collector course-sync deployment backup.
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

echo "回滚计划（$backup_dir）："
while IFS=$'\t' read -r state rel _; do
  target="$(target_path "$rel")"
  if [[ "$state" == present ]]; then
    printf '  restore %s\n' "$target"
  else
    printf '  remove  %s（部署前不存在）\n' "$target"
  fi
done <"$backup_dir/manifest.tsv"

if ! $apply; then
  echo "dry run：加 --yes 执行。"
  exit 0
fi

while IFS=$'\t' read -r state rel expected; do
  target="$(target_path "$rel")"
  if [[ "$state" == present ]]; then
    if [[ ! -f "$backup_dir/files/$rel" ]]; then
      echo "备份缺少 $rel" >&2
      exit 1
    fi
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

echo "回滚完成：$backup_dir"
