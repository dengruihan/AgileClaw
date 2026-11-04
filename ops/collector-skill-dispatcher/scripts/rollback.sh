#!/usr/bin/env bash
# Roll back the collector skill dispatcher deployment.
#
# Restores the payload.message recorded by deploy.sh and removes the four skill
# files when their current content is still exactly what deploy.sh wrote.
# A skill file that changed after deployment is left in place with a warning;
# pass --force to restore the pre-deploy state anyway.
#
# Usage: rollback.sh [--yes] [--backup DIR] [--force] [--allow-drift]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
force=0
allow_drift=0
backup_dir=""

usage() {
  cat <<'EOF'
Usage: rollback.sh [--yes] [--backup DIR] [--force] [--allow-drift]

  --yes          apply the rollback (default: print the plan only)
  --backup DIR   use a specific deploy backup instead of the newest one
  --force        restore even when the live skills or message drifted since deploy
  --allow-drift  allow restoring the previous message when it differs from the
                 message this deployment installed
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --backup) [ "$#" -ge 2 ] || die "--backup needs a directory"; backup_dir="$2"; shift 2 ;;
    --force) force=1; shift ;;
    --allow-drift) allow_drift=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_package

if [ -z "$backup_dir" ]; then
  backup_dir="$(pick_backup_dir)" || die "no deploy backup under $BACKUP_BASE"
fi
[ -f "$backup_dir/deploy.json" ] || die "not a deploy backup: $backup_dir"
[ -f "$backup_dir/payload-message.before.txt" ] || die "backup message missing in $backup_dir"
[ -f "$backup_dir/job.before.json" ] || die "backup job snapshot missing in $backup_dir"

before_sha="$(json_field before.messageSha256 <"$backup_dir/deploy.json")"
deployed_sha="$(json_field desired.messageSha256 <"$backup_dir/deploy.json")"

current="$(cron_json)"
[ -n "$current" ] || die "openclaw cron get $JOB_ID returned nothing"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
before_facts="$(job_facts_json "$(cat "$backup_dir/job.before.json")")"

info "backup: $backup_dir"
info "current message:  sha256 $current_sha"
info "deployed message: sha256 $deployed_sha"
info "restore message:  sha256 $before_sha"

message_action="noop"
if [ "$current_sha" = "$before_sha" ]; then
  message_action="noop (already restored)"
elif [ "$current_sha" = "$deployed_sha" ]; then
  message_action="restore"
elif [ "$allow_drift" -eq 1 ] || [ "$force" -eq 1 ]; then
  message_action="restore (drift override)"
else
  die "live message differs from what this deployment installed.
Review the current payload first:
  $(cli_display) cron get $JOB_ID --json
Then rerun with --allow-drift if restoring the backup message is intended."
fi

# Skill plan: restore/remove only when the live file is still what deploy wrote.
declare -A skill_action=()
for name in "${SKILL_NAMES[@]}"; do
  existed="$(json_field "skills.$name.existed" <"$backup_dir/deploy.json")"
  expect_sha="$(json_field "skills.$name.deployedSha256" <"$backup_dir/deploy.json")"
  target_sha="$(skill_target_sha "$name")"
  if [ "$existed" = "true" ]; then
    if [ "$target_sha" = "$expect_sha" ]; then
      skill_action["$name"]="restore"
    elif [ "$force" -eq 1 ]; then
      skill_action["$name"]="restore (drift override)"
    else
      skill_action["$name"]="SKIP: changed after deploy (use --force)"
    fi
  else
    if [ "$target_sha" = "missing" ]; then
      skill_action["$name"]="noop (already absent)"
    elif [ "$target_sha" = "$expect_sha" ]; then
      skill_action["$name"]="remove"
    elif [ "$force" -eq 1 ]; then
      skill_action["$name"]="remove (drift override)"
    else
      skill_action["$name"]="SKIP: changed after deploy (use --force)"
    fi
  fi
done

info "message: $message_action"
for name in "${SKILL_NAMES[@]}"; do info "skill $name: ${skill_action[$name]}"; done

pending=0
case "$message_action" in restore*) pending=1 ;; esac
for name in "${SKILL_NAMES[@]}"; do
  case "${skill_action[$name]}" in restore* | remove*) pending=1 ;; esac
done
if [ "$pending" -eq 0 ]; then
  info "nothing to do"
  exit 0
fi

if [ "$yes" -eq 0 ]; then
  info "plan only. rerun with --yes to apply"
  exit 0
fi

case "$message_action" in
restore*)
  info "restoring payload.message"
  if ! openclaw_cli cron edit "$JOB_ID" --message "$(cat "$backup_dir/payload-message.before.txt")"; then
    die "cron edit failed; live state may be partially rolled back. Re-check with scripts/status.sh"
  fi
  ;;
esac

for name in "${SKILL_NAMES[@]}"; do
  case "${skill_action[$name]}" in
    restore*)
      mkdir -p "$(skill_target_dir "$name")"
      cp "$backup_dir/skills/$name/SKILL.md" "$(skill_target_file "$name")"
      ;;
    remove*)
      rm -f "$(skill_target_file "$name")"
      rmdir "$(skill_target_dir "$name")" 2>/dev/null || true
      ;;
  esac
done

after="$(cron_json)"
[ -n "$after" ] || die "after-get returned nothing"
after_message="$(printf '%s' "$after" | json_field payload.message)"
[ "$(sha256_text "$after_message")" = "$before_sha" ] ||
  die "rollback verification failed: payload.message does not match the backup"
[ "$(job_facts_json "$after")" = "$before_facts" ] ||
  die "rollback verification failed: an untouched job field differs from the backup"

for name in "${SKILL_NAMES[@]}"; do
  case "${skill_action[$name]}" in
    restore*)
      [ "$(skill_target_sha "$name")" = "$(sha256_file "$backup_dir/skills/$name/SKILL.md")" ] ||
        die "rollback verification failed: skill $name differs from the backup"
      ;;
    remove*)
      [ "$(skill_target_sha "$name")" = "missing" ] ||
        die "rollback verification failed: skill $name still present"
      ;;
  esac
done

info "verified: payload.message and skill files restored; trigger and untouched fields unchanged"
