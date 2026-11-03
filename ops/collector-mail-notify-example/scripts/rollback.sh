#!/usr/bin/env bash
# Roll back the collector-notify mail example (M13) from the latest backup.
#
# Restores only workspace/skills/collector-notify/SKILL.md; never touches the
# dispatcher payload, cron, toolsAllow, trigger, openclaw.json or other skills.
# The restore applies only while the live file still equals this package's
# content; a later manual change is left alone unless --force is passed.
#
# Usage: rollback.sh [--yes] [--force] [--backup DIR]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
force=0
backup_dir=""

usage() {
  cat <<'EOF'
Usage: rollback.sh [--yes] [--force] [--backup DIR]

  --yes         restore the backed-up SKILL.md (default: plan only)
  --force       restore even though the live file differs from this package
  --backup DIR  use a specific backup directory (default: newest under
                ~/.openclaw/backups/collector-mail-notify-example)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --force) force=1; shift ;;
    --backup)
      [ "$#" -ge 2 ] || die "--backup needs a directory"
      backup_dir="$2"
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -z "$backup_dir" ]; then
  backup_dir="$(latest_backup_dir)" || die "no backup with deploy.json under $BACKUP_BASE"
fi
[ -f "$backup_dir/deploy.json" ] || die "backup missing deploy.json: $backup_dir"
[ -f "$backup_dir/SKILL.md.before" ] || die "backup missing SKILL.md.before: $backup_dir"

before_sha="$(deploy_field "$backup_dir" before.sha256)"
deployed_sha="$(deploy_field "$backup_dir" after.sha256)"
backup_sha="$(sha256_file "$backup_dir/SKILL.md.before")"
current_sha="$(target_sha)"

[ "$backup_sha" = "$before_sha" ] || die "backup file hash $backup_sha does not match deploy.json $before_sha"

if [ "$current_sha" = "$before_sha" ]; then
  info "already rolled back: $TARGET_FILE matches the backup"
  exit 0
fi

case "$current_sha" in
  "$deployed_sha") action="restore" ;;
  missing) die "target skill is missing; restore manually from $backup_dir/SKILL.md.before" ;;
  *)
    if [ "$force" -eq 0 ]; then
      die "live skill was changed after deployment (sha256 $current_sha).
Review it, then rerun with --force to overwrite from $backup_dir."
    fi
    action="restore (force over drift)"
    ;;
esac

info "backup: $backup_dir"
info "target: $TARGET_FILE"
info "current: sha256 $current_sha"
info "restore to: sha256 $before_sha"
info "action: $action"
info "not touched: dispatcher payload.message, cron, toolsAllow, trigger, openclaw.json, other skills"

if [ "$yes" -eq 0 ]; then
  info "plan only"
  echo "  - copy $backup_dir/SKILL.md.before -> $TARGET_FILE"
  echo "  - verify sha256 $before_sha"
  info "rerun with --yes to roll back"
  exit 0
fi

info "restoring"
tmp="$(mktemp "$(dirname "$TARGET_FILE")/.SKILL.md.XXXXXX")"
cp "$backup_dir/SKILL.md.before" "$tmp"
chmod --reference="$TARGET_FILE" "$tmp"
mv "$tmp" "$TARGET_FILE"

restored_sha="$(sha256_file "$TARGET_FILE")"
[ "$restored_sha" = "$before_sha" ] || die "restore verification failed: $restored_sha != $before_sha"

info "verified: collector-notify/SKILL.md restored to the pre-deploy content"
