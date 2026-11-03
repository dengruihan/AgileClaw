#!/usr/bin/env bash
# Roll back the M15 collector Agenda-wording fix from a recorded backup.
#
# Restores the cron payload.message, the two SKILL.md files and the two
# anchored patches from the backup's full before copies. A surface changed
# after deployment is refused unless --force is passed (the backup still
# overwrites it after confirmation).
#
# Usage: rollback.sh [--yes] [--force] [--backup DIR]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
force=0
backup=""

usage() {
  cat <<'EOF'
Usage: rollback.sh [--yes] [--force] [--backup DIR]

  --yes         write the recorded before state (default: plan only)
  --force       restore even when a surface changed after deployment
  --backup DIR  use a specific backup directory (default: newest)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --force) force=1; shift ;;
    --backup)
      shift
      [ "$#" -gt 0 ] || die "--backup needs a directory"
      backup="$1"
      shift
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_package
package_payload_sha >/dev/null

if [ -z "$backup" ]; then
  backup="$(pick_backup_dir)" || die "no backup with deploy.json under $BACKUP_BASE"
fi
[ -f "$backup/deploy.json" ] || die "not a deployment backup: $backup"
[ -f "$backup/payload-message.before.txt" ] || die "backup missing payload-message.before.txt"

before_message="$(cat "$backup/payload-message.before.txt")"
before_message_sha="$(sha256_text "$before_message")"
deployed_message_sha="$(deploy_field "$backup" desired.messageSha256)"
current_facts=""
current_sha=""

current="$(cron_json)"
[ -n "$current" ] || die "$(cli_display) cron get $JOB_ID returned nothing"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
current_facts="$(job_facts_json "$current")"

actions=()
message_action="restore"
if [ "$current_sha" = "$before_message_sha" ]; then
  message_action="already rolled back"
elif [ "$current_sha" != "$deployed_message_sha" ]; then
  message_action="restore (drift)"
fi
actions+=("payload.message: $message_action")

for name in "${SKILL_NAMES[@]}"; do
  rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
  target="$(target_file "$rel")"
  current_file_sha="$(target_sha "$rel")"
  deployed="$(package_entry file "$rel" deployedSha256)"
  if [ ! -f "$backup/files/$name/SKILL.md.before" ]; then
    actions+=("$name: no before copy (missing at deploy)")
    continue
  fi
  before_sha="$(sha256_file "$backup/files/$name/SKILL.md.before")"
  if [ "$current_file_sha" = "$before_sha" ]; then
    actions+=("$name: already rolled back")
  elif [ "$current_file_sha" != "$deployed" ]; then
    actions+=("$name: restore (drift)")
  else
    actions+=("$name: restore")
  fi
done

for rel in "${PATCH_PATHS[@]}"; do
  target="$(target_file "$rel")"
  key="$(printf '%s' "$rel" | tr '/' '_')"
  if [ ! -f "$backup/patches/$key.before" ]; then
    actions+=("patch $rel: no before copy (missing at deploy)")
    continue
  fi
  before_sha="$(sha256_file "$backup/patches/$key.before")"
  current_file_sha="$(sha256_file "$target")"
  deployed="$(deploy_patch_after_sha "$backup" "$rel")"
  if [ "$current_file_sha" = "$before_sha" ]; then
    actions+=("patch $rel: already rolled back")
  elif [ "$current_file_sha" != "$deployed" ]; then
    actions+=("patch $rel: restore (drift)")
  else
    actions+=("patch $rel: restore")
  fi
done

echo "backup: $backup"
for action in "${actions[@]}"; do echo "  $action"; done
echo "  trigger/schedule/timeout/tools/lightContext/session/enabled/description/delivery: untouched"

if printf '%s\n' "${actions[@]}" | grep -q '(drift)'; then
  if [ "$force" -eq 0 ]; then
    die "a surface changed after deployment. Review it, then rerun with --force if the backup should still be restored."
  fi
fi

if [ "$yes" -eq 0 ]; then
  info "plan only"
  info "rerun with --yes to restore"
  exit 0
fi

restore_fail=""
if [ "$message_action" != "already rolled back" ]; then
  if ! openclaw_cli cron edit "$JOB_ID" --message "$before_message" >/dev/null; then
    restore_fail="payload.message restore failed"
  fi
fi

for name in "${SKILL_NAMES[@]}"; do
  rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
  target="$(target_file "$rel")"
  before="$backup/files/$name/SKILL.md.before"
  if [ -f "$before" ]; then
    cp "$before" "$target"
  fi
done

for rel in "${PATCH_PATHS[@]}"; do
  target="$(target_file "$rel")"
  key="$(printf '%s' "$rel" | tr '/' '_')"
  before="$backup/patches/$key.before"
  if [ -f "$before" ]; then
    cp "$before" "$target"
  fi
done

verify_after() {
  local after after_message after_sha after_facts name rel key target
  if ! after="$(cron_json)"; then
    restore_fail="${restore_fail:+$restore_fail; }after-get failed"
    return 1
  fi
  if ! after_message="$(printf '%s' "$after" | json_field payload.message)"; then
    restore_fail="${restore_fail:+$restore_fail; }payload.message unreadable"
    return 1
  fi
  after_sha="$(sha256_text "$after_message")"
  [ "$after_sha" = "$before_message_sha" ] ||
    restore_fail="${restore_fail:+$restore_fail; }payload.message does not match the backup"
  if ! after_facts="$(job_facts_json "$after")"; then
    restore_fail="${restore_fail:+$restore_fail; }job facts unparsable"
  elif [ "$after_facts" != "$current_facts" ]; then
    restore_fail="${restore_fail:+$restore_fail; }an untouched job field changed unexpectedly"
  fi
  for name in "${SKILL_NAMES[@]}"; do
    rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
    target="$(target_file "$rel")"
    [ -f "$backup/files/$name/SKILL.md.before" ] || continue
    [ "$(sha256_file "$target")" = "$(sha256_file "$backup/files/$name/SKILL.md.before")" ] ||
      restore_fail="${restore_fail:+$restore_fail; }skill $name not restored"
  done
  for rel in "${PATCH_PATHS[@]}"; do
    target="$(target_file "$rel")"
    key="$(printf '%s' "$rel" | tr '/' '_')"
    [ -f "$backup/patches/$key.before" ] || continue
    [ "$(sha256_file "$target")" = "$(sha256_file "$backup/patches/$key.before")" ] ||
      restore_fail="${restore_fail:+$restore_fail; }patch $rel not restored"
  done
  [ -z "$restore_fail" ]
}

if ! verify_after; then
  echo "ERROR: rollback verification failed: ${restore_fail:-unknown}" >&2
  exit 1
fi

info "restored the five surfaces from $backup; untouched job fields unchanged"
