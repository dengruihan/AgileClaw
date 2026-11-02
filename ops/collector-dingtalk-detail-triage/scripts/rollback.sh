#!/usr/bin/env bash
# Roll back the collector prompt to the message saved by deploy.sh.
#
# Refuses unless the live message still equals the message this deployment
# wrote (manifest desired.messageSha256). Use --force only after inspecting a
# later change you intend to replace.
#
# Usage: rollback.sh [--yes] [--backup <dir>] [--force]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
force=0
backup_dir=""

usage() {
  cat <<'EOF'
Usage: rollback.sh [--yes] [--backup <dir>] [--force]

  --yes          apply the rollback (default: print the plan only)
  --backup       deploy backup directory (default: newest under
                 ~/.openclaw/backups/collector-dingtalk-detail-triage)
  --force        roll back even though the live message is not the deployed one
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --force) force=1; shift ;;
    --backup) backup_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -z "$backup_dir" ]; then
  backup_dir="$(pick_backup_dir)" || die "no deploy backup found under $BACKUP_BASE; pass --backup <dir>"
fi
backup_dir="${backup_dir%/}"
manifest="$backup_dir/deploy.json"
before_file="$backup_dir/payload-message.before.txt"
[ -f "$manifest" ] || die "deploy manifest missing: $manifest"
[ -f "$before_file" ] || die "previous message missing: $before_file"

deployed_sha="$(json_field desired.messageSha256 <"$manifest")"
before_sha="$(json_field before.messageSha256 <"$manifest")"
before_trigger_sha="$(json_field before.triggerSha256 <"$manifest")"

current="$(cron_json)"
[ -n "$current" ] || die "openclaw cron get $JOB_ID returned nothing"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
current_facts="$(job_facts_json "$current")"

info "backup: $backup_dir"
info "current message: sha256 $current_sha"
info "deployed message: sha256 $deployed_sha"
info "rollback message: sha256 $before_sha"

if [ "$current_sha" = "$before_sha" ]; then
  info "already rolled back; nothing to do"
  exit 0
fi

if [ "$current_sha" != "$deployed_sha" ] && [ "$force" -eq 0 ]; then
  die "live message is not the one this deployment wrote. Inspect it first:
  $(cli_display) cron get $JOB_ID --json
Then rerun with --force if replacing it is intended."
fi

if [ "$yes" -eq 0 ]; then
  info "plan only. Would run:"
  echo "  $(cli_display) cron edit $JOB_ID --message \"\$(cat $before_file)\""
  info "rerun with --yes to apply"
  exit 0
fi

openclaw_cli cron edit "$JOB_ID" --message "$(cat "$before_file")"

after="$(cron_json)"
after_sha="$(sha256_text "$(printf '%s' "$after" | json_field payload.message)")"
after_facts="$(job_facts_json "$after")"
after_trigger_sha="$(printf '%s' "$after_facts" | json_field triggerSha256)"

[ "$after_sha" = "$before_sha" ] || die "rollback verification failed: message sha256 is $after_sha, expected $before_sha"
[ "$after_trigger_sha" = "$before_trigger_sha" ] ||
  die "rollback verification failed: trigger script changed (was $before_trigger_sha, now $after_trigger_sha)"
info "verified: previous message restored; trigger script unchanged"
