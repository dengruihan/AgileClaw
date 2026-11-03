#!/usr/bin/env bash
# Restore the latest collector course-sync deployment backup (files + cron payload/trigger).
# Refuses by default when files or cron drifted after deploy; pass --force to override.
# Usage: ./scripts/rollback.sh [--yes] [--force] [backup-dir]
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

apply=false
force=false
backup_dir=""
for arg in "$@"; do
  case "$arg" in
    --yes) apply=true ;;
    --force) force=true ;;
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

# 先核对当前状态仍是本包部署值；部署后的合法修改默认不覆盖。
drift=()
while IFS=$'\t' read -r state rel _; do
  target="$(target_path "$rel")"
  package_target="$FILES_DIR/$rel"
  if [[ "$state" == present ]]; then
    if [[ ! -e "$target" ]]; then
      drift+=("missing $target")
    elif [[ "$(sha256_file "$target")" != "$(sha256_file "$package_target")" ]]; then
      drift+=("file drift $target")
    fi
  elif [[ -e "$target" && "$(sha256_file "$target")" != "$(sha256_file "$package_target")" ]]; then
    drift+=("new-file drift $target")
  fi
done <"$backup_dir/manifest.tsv"

job_now="$(cron_get 2>/dev/null || true)"
if [[ -z "$job_now" ]]; then
  drift+=("cron unavailable")
else
  current_message_hash="$(printf '%s' "$job_now" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const crypto=require("node:crypto");let m="";try{m=JSON.parse(s)?.payload?.message??""}catch{};process.stdout.write(crypto.createHash("sha256").update(String(m).replace(/\n$/,"")).digest("hex"))})')"
  current_trigger_hash="$(printf '%s' "$job_now" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{const crypto=require("node:crypto");let t="";try{t=JSON.parse(s)?.trigger?.script??""}catch{};process.stdout.write(crypto.createHash("sha256").update(String(t).replace(/\n$/,"")).digest("hex"))})')"
  [[ "$current_message_hash" == "$(trim_hash "$PAYLOAD_FILE")" ]] || drift+=("cron payload.message drift")
  [[ "$current_trigger_hash" == "$(trim_hash "$FILES_DIR/$TRIGGER_REL")" ]] || drift+=("cron trigger.script drift")
fi

if [[ ${#drift[@]} -gt 0 ]]; then
  echo "回滚前检测到部署后变化：" >&2
  for item in "${drift[@]}"; do echo "  - $item" >&2; done
  if ! $force; then
    echo "默认拒绝覆盖；确认这些修改可丢弃后加 --force。" >&2
    exit 1
  fi
  echo "已指定 --force：继续回滚。" >&2
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
echo "  cron $JOB_ID: 恢复 payload.message 与 trigger.script"

if ! $apply; then
  echo "dry run：加 --yes 执行。"
  exit 0
fi

if [[ -z "$job_now" ]]; then
  job_now="$(cron_get)"
fi
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
