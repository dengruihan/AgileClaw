#!/usr/bin/env bash
# Deploy collector course normalization + Agenda sync client. Backs up every target first.
# Usage: ./scripts/deploy.sh [--yes] [--allow-missing-sync] [--skip-checks]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

apply=false
allow_missing=false
allow_drift=false
skip_checks=false
for arg in "$@"; do
  case "$arg" in
    --yes) apply=true ;;
    --allow-missing-sync) allow_missing=true ;;
    --allow-drift) allow_drift=true ;;
    --skip-checks) skip_checks=true ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! $skip_checks; then
  (cd "$PKG_DIR" && node verify/check-package.mjs)
  (cd "$PKG_DIR" && node --test verify/course-sync.test.mjs)
fi

if ! $allow_missing; then
  require_sync_endpoint
fi

# collect.mjs 是共享运行时：只允许覆盖“M19 前基线”或“本包版本”，防止并发任务被覆盖。
collect_rel="home/raymond/.openclaw/workspace/collection/collect.mjs"
collect_target="$(target_path "$collect_rel")"
if [[ -e "$collect_target" ]]; then
  live_hash="$(sha256_file "$collect_target")"
  baseline_hash="$(sha256_file "$PKG_DIR/baselines/collect.pre-m19.mjs")"
  package_hash="$(sha256_file "$FILES_DIR/$collect_rel")"
  if [[ "$live_hash" != "$baseline_hash" && "$live_hash" != "$package_hash" ]] && ! $allow_drift; then
    echo "collect.mjs 已偏离 M19 基线（$live_hash）；确认后加 --allow-drift。" >&2
    exit 1
  fi
fi

echo "部署计划："
while read -r rel; do
  printf '  %s -> %s\n' "$rel" "$(target_path "$rel")"
done < <(package_files)
echo "不修改 cron、trigger、toolsAllow、sentinel、消息渠道或 Agenda 数据。"

if ! $apply; then
  echo "dry run：加 --yes 执行。"
  exit 0
fi

backup_dir="$BACKUP_ROOT/$(timestamp)"
mkdir -p "$backup_dir/files"
manifest="$backup_dir/manifest.tsv"
: >"$manifest"

while read -r rel; do
  target="$(target_path "$rel")"
  if [[ -e "$target" ]]; then
    mkdir -p "$backup_dir/files/$(dirname "$rel")"
    cp -p "$target" "$backup_dir/files/$rel"
    printf 'present\t%s\t%s\n' "$rel" "$(sha256_file "$target")" >>"$manifest"
  else
    printf 'absent\t%s\t-\n' "$rel" >>"$manifest"
  fi
done < <(package_files)

while read -r rel; do
  target="$(target_path "$rel")"
  mkdir -p "$(dirname "$target")"
  cp -p "$FILES_DIR/$rel" "$target"
done < <(package_files)

fail=0
while read -r rel; do
  target="$(target_path "$rel")"
  if [[ "$(sha256_file "$target")" != "$(sha256_file "$FILES_DIR/$rel")" ]]; then
    echo "hash mismatch after deploy: $target" >&2
    fail=1
  fi
done < <(package_files)

if [[ $fail -ne 0 ]]; then
  echo "部署校验失败；备份在 $backup_dir，可执行 ./scripts/rollback.sh --yes" >&2
  exit 1
fi

echo "部署完成。备份：$backup_dir"
echo "下一步（由 tower 执行）："
echo "  node /home/raymond/.openclaw/workspace/collection/collect.mjs yungu-schedule --force --no-attach"
echo "  node /home/raymond/.openclaw/workspace/collection/collect.mjs status"
echo "  curl -fsS http://127.0.0.1:18810/agenda/api/snapshot | head -c 400"
