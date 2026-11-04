#!/usr/bin/env bash
# Deploy collector course sync + Agenda feedback wake contract.
# Backs up every target and the embedded cron payload/trigger before writing.
# Usage: ./scripts/deploy.sh [--yes] [--allow-missing-sync] [--allow-drift] [--skip-checks]
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
  (cd "$PKG_DIR" && node --test verify/trigger-feedback.test.mjs)
fi

if ! $allow_missing; then
  require_sync_endpoint
fi

# collect.mjs 是共享运行时：只允许覆盖“M19 前基线”或“本包版本”，防止并发任务被覆盖。
collect_rel="home/raymond/.openclaw/workspace/collection/collect.mjs"
collect_target="$(target_path "$collect_rel")"
if [[ -e "$collect_target" ]]; then
  live_hash="$(sha256_file "$collect_target")"
  baseline_hash="$(sha256_file "$PKG_DIR/baselines/collect.pre-m19.mjs.txt")"
  package_hash="$(sha256_file "$FILES_DIR/$collect_rel")"
  if [[ "$live_hash" != "$baseline_hash" && "$live_hash" != "$package_hash" ]] && ! $allow_drift; then
    echo "collect.mjs 已偏离 M19 基线（$live_hash）；确认后加 --allow-drift。" >&2
    exit 1
  fi
fi

# cron payload/trigger 也是共享状态：live 必须仍是 M19 前基线或本包版本。
job_before_now="$(cron_get)"
live_message_hash="$(printf '%s' "$job_before_now" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const crypto=require("node:crypto");let m="";try{m=JSON.parse(s)?.payload?.message??""}catch{};process.stdout.write(crypto.createHash("sha256").update(String(m).replace(/\n$/,"")).digest("hex"))})')"
live_trigger_hash="$(printf '%s' "$job_before_now" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const crypto=require("node:crypto");let t="";try{t=JSON.parse(s)?.trigger?.script??""}catch{};process.stdout.write(crypto.createHash("sha256").update(String(t).replace(/\n$/,"")).digest("hex"))})')"
baseline_message_hash="$(trim_hash "$PKG_DIR/baselines/payload-message.pre-m19.txt")"
package_message_hash="$(trim_hash "$PAYLOAD_FILE")"
baseline_trigger_hash="$(trim_hash "$PKG_DIR/baselines/trigger-collector.pre-m19.mjs.txt")"
package_trigger_hash="$(trim_hash "$FILES_DIR/$TRIGGER_REL")"
if [[ "$live_message_hash" != "$baseline_message_hash" && "$live_message_hash" != "$package_message_hash" ]] && ! $allow_drift; then
  echo "cron payload.message 已偏离 M19 基线；确认后加 --allow-drift。" >&2
  exit 1
fi
if [[ "$live_trigger_hash" != "$baseline_trigger_hash" && "$live_trigger_hash" != "$package_trigger_hash" ]] && ! $allow_drift; then
  echo "cron trigger.script 已偏离 M19 基线；确认后加 --allow-drift。" >&2
  exit 1
fi

echo "部署计划："
while read -r rel; do
  printf '  %s -> %s\n' "$rel" "$(target_path "$rel")"
done < <(package_files)
echo "  cron $JOB_ID: payload.message + trigger.script（其余字段不动）"
echo "不修改 toolsAllow、schedule、enabled、sessionTarget、wakeMode、delivery、Agenda 数据或 sentinel。"

if ! $apply; then
  echo "dry run：加 --yes 执行。"
  exit 0
fi

backup_dir="$BACKUP_ROOT/$(timestamp)"
mkdir -p "$backup_dir/files"
manifest="$backup_dir/manifest.tsv"
: >"$manifest"

# 完整 job 快照 + 被替换的文件
printf '%s\n' "$job_before_now" >"$backup_dir/job.before.json"
node -e 'const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],j.payload?.message??"");fs.writeFileSync(process.argv[3],j.trigger?.script??"")' \
  "$backup_dir/job.before.json" "$backup_dir/payload-message.before.txt" "$backup_dir/trigger-collector.before.mjs"

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

trigger_target="$(target_path "$TRIGGER_REL")"
if ! cron_edit --trigger-script "$trigger_target" --message "$(cat "$PAYLOAD_FILE")" >/dev/null; then
  echo "cron edit 失败；文件已落盘，备份在 $backup_dir" >&2
  exit 1
fi
cron_get >"$backup_dir/job.after.json"
if ! verify_job_files "$backup_dir/job.before.json" "$backup_dir/job.after.json" "$PAYLOAD_FILE" "$trigger_target"; then
  echo "cron 校验失败，自动恢复旧 payload/trigger" >&2
  cron_edit --trigger-script "$backup_dir/trigger-collector.before.mjs" --message "$(cat "$backup_dir/payload-message.before.txt")" >/dev/null || true
  exit 1
fi

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
