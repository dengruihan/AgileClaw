#!/usr/bin/env bash
# Report the current deployment state of the direct-reply-mode change.
set -euo pipefail

install_root="${DT_CONNECTOR_INSTALL:-/home/raymond/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector}"
backup_base="${HOME}/.openclaw/backups/dingtalk-direct-text-replies"
config_file="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
backup_base="${DT_BACKUP_BASE:-$HOME/.openclaw/backups/dingtalk-direct-text-replies}"

echo "install: $install_root"
echo "version: $(node -p "require('$install_root/package.json').version")"

if grep -q 'directReplyMode' "$install_root/dist/message-handler-C8eu5xwl.mjs" 2>/dev/null; then
  echo "patch:   APPLIED"
else
  echo "patch:   not applied"
fi

if [ -f "$config_file" ]; then
  mode="$(node -e "console.log(require('$config_file').channels?.['dingtalk-connector']?.directReplyMode ?? '(unset)')" 2>/dev/null || echo '(unreadable)')"
  echo "config:  channels.dingtalk-connector.directReplyMode = $mode"
fi

echo "backups: $(ls -1dt "$backup_base"/*/ 2>/dev/null | tr '\n' ' ' || echo none)"
echo "schema note: unpatched 0.8.27 + directReplyMode set => Gateway config validation fails; keep patch and config in sync."
