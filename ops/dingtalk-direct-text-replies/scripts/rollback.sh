#!/usr/bin/env bash
# Roll back the direct-reply-mode patch by restoring the backup taken by apply.sh.
#
# ORDERING MATTERS: the patched config schema accepts the directReplyMode key,
# the stock 0.8.27 schema does not (strict). If the key stays in openclaw.json
# while unpatched files are restored, the next Gateway start fails validation.
# This script therefore refuses to restore while the config key is still set,
# unless --force is given.
#
# Usage: ./rollback.sh [backup-dir] [--force]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
install_root="${DT_CONNECTOR_INSTALL:-/home/raymond/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector}"
backup_base="${DT_BACKUP_BASE:-$HOME/.openclaw/backups/dingtalk-direct-text-replies}"
force=0
backup_dir=""

for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) backup_dir="$arg" ;;
  esac
done

if [ -z "$backup_dir" ]; then
  backup_dir="$(ls -1dt "$backup_base"/*/ 2>/dev/null | head -1 || true)"
  [ -n "$backup_dir" ] || { echo "No backup found under $backup_base — nothing to roll back." >&2; exit 1; }
fi
backup_dir="${backup_dir%/}"
[ -d "$backup_dir/src" ] && [ -d "$backup_dir/dist" ] || { echo "Backup incomplete: $backup_dir" >&2; exit 1; }

config_file="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
if [ "$force" -ne 1 ] && [ -f "$config_file" ]; then
  if node -e "process.exit(require('$config_file').channels?.['dingtalk-connector']?.directReplyMode ? 0 : 1)" 2>/dev/null; then
    echo "REFUSING: channels.dingtalk-connector.directReplyMode is still set in $config_file." >&2
    echo "Remove it first or the restored (strict) plugin schema will reject the config at startup:" >&2
    echo "  pnpm openclaw config unset channels.dingtalk-connector.directReplyMode" >&2
    echo "Then re-run rollback.sh. Use --force only if you accept a failed Gateway start." >&2
    exit 1
  fi
fi

version="$(node -p "require('$install_root/package.json').version")"
[ "$version" = "0.8.27" ] || echo "WARNING: installed version is $version (backup was taken from 0.8.27)." >&2

cp -a "$backup_dir/src" "$backup_dir/dist" "$install_root/"
grep -q 'directReplyMode' "$install_root/dist/message-handler-C8eu5xwl.mjs" \
  && { echo "rollback verification failed: marker still present" >&2; exit 1; }

echo "Restored $install_root from $backup_dir"
cat <<'EOF'

Remaining steps (run manually):
  1. Ensure the config key is gone:
     pnpm openclaw config unset channels.dingtalk-connector.directReplyMode
  2. Restart the Gateway (launchctl bootout + bootstrap), then:
     pnpm openclaw gateway health
  3. DM replies are back to streaming AI Cards.
EOF
