#!/usr/bin/env bash
# Deploy the reviewed collector-notify mail example (M13).
#
# Writes exactly one file: workspace/skills/collector-notify/SKILL.md.
# It does not touch the dispatcher payload, cron, toolsAllow, trigger,
# openclaw.json or any other skill, and it sends no message or mail.
#
# Without --yes the script only prints the plan. An apply backs up the current
# file, writes atomically, then verifies the new content; a failed verification
# restores the backup.
#
# Usage: deploy.sh [--yes] [--allow-drift]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
allow_drift=0

usage() {
  cat <<'EOF'
Usage: deploy.sh [--yes] [--allow-drift]

  --yes          replace the live collector-notify SKILL.md (default: plan only)
  --allow-drift  proceed even though the live file is neither the recorded
                 baseline nor this package's content; review the diff first
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --allow-drift) allow_drift=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

desired_sha="$(package_sha)"
current_sha="$(target_sha)"
check_tokens "$PACKAGE_FILE" || die "package content failed token checks"

if [ "$current_sha" = "$desired_sha" ]; then
  info "already deployed: $TARGET_FILE"
  check_tokens "$TARGET_FILE" || die "deployed content failed token checks"
  info "content verified; nothing to do"
  exit 0
fi

case "$current_sha" in
  "$BASELINE_SHA256") action="replace" ;;
  missing) die "target skill is missing: $TARGET_FILE (expected the recorded baseline)" ;;
  *)
    if [ "$allow_drift" -eq 0 ]; then
      die "live skill is neither the recorded baseline ($BASELINE_SHA256) nor this package's content.
Review the current file:
  $TARGET_FILE
Then rerun with --allow-drift if replacing it is intended (the current file is backed up first)."
    fi
    action="replace (drift accepted)"
    ;;
esac

info "target: $TARGET_FILE"
info "current: sha256 $current_sha ($(file_bytes "$TARGET_FILE") bytes)"
info "desired: sha256 $desired_sha ($(file_bytes "$PACKAGE_FILE") bytes)"
info "action: $action"
info "not touched: dispatcher payload.message, cron, toolsAllow, trigger, openclaw.json, other skills"

if [ "$yes" -eq 0 ]; then
  info "plan only"
  echo "  - back up the current SKILL.md"
  echo "  - write $PACKAGE_FILE -> $TARGET_FILE"
  echo "  - verify sha256, required anchors and absence of stale/light-effect tokens"
  info "rerun with --yes to apply"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
backup_dir="$BACKUP_BASE/$stamp"
# Two deploys can land in the same second; keep each backup distinct so a
# rollback always restores the immediately preceding content.
suffix=1
while [ -e "$backup_dir" ]; do
  suffix=$((suffix + 1))
  backup_dir="$BACKUP_BASE/$stamp-$suffix"
done
mkdir -p "$backup_dir"
cp "$TARGET_FILE" "$backup_dir/SKILL.md.before"
cat >"$backup_dir/deploy.json" <<EOF
{
  "target": "$SKILL_REL",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "before": { "sha256": "$current_sha" },
  "after": { "sha256": "$desired_sha" }
}
EOF
info "backup: $backup_dir"

restore_previous() {
  echo "==> restoring the previous collector-notify SKILL.md" >&2
  cp "$backup_dir/SKILL.md.before" "$TARGET_FILE"
  if [ "$(sha256_file "$TARGET_FILE")" = "$current_sha" ]; then
    echo "==> restore verified" >&2
  else
    echo "==> WARNING: restore hash mismatch; recover from $backup_dir/SKILL.md.before" >&2
  fi
}

info "writing $TARGET_FILE"
tmp="$(mktemp "$(dirname "$TARGET_FILE")/.SKILL.md.XXXXXX")"
cp "$PACKAGE_FILE" "$tmp"
chmod --reference="$TARGET_FILE" "$tmp"
mv "$tmp" "$TARGET_FILE"

verify_after() {
  local file_sha
  file_sha="$(sha256_file "$TARGET_FILE")"
  [ "$file_sha" = "$desired_sha" ] || { echo "sha256 mismatch: $file_sha" >&2; return 1; }
  check_tokens "$TARGET_FILE" || return 1
  [ "$(file_bytes "$TARGET_FILE")" = "$(file_bytes "$PACKAGE_FILE")" ] || {
    echo "byte length mismatch" >&2
    return 1
  }
}

if ! verify_after; then
  echo "ERROR: post-deploy verification failed" >&2
  restore_previous
  exit 1
fi

info "verified: only collector-notify/SKILL.md changed; stale mail example removed"
info "backup for rollback: $backup_dir"
