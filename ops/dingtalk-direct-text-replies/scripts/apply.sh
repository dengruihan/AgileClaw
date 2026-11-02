#!/usr/bin/env bash
# Apply the direct-reply-mode patch to the installed @dingtalk-real-ai/dingtalk-connector.
#
# What it does:
#   1. Verifies the installed package is exactly 0.8.27 (the patch is version-pinned).
#   2. Dry-runs the patch; exits 0 if it is already applied.
#   3. Backs up src/ and dist/ to ~/.openclaw/backups/dingtalk-direct-text-replies/<ts>/.
#   4. Applies the patch and verifies the marker line is present afterwards.
#
# It does NOT: edit openclaw.json, restart the Gateway, or send any message.
# Required follow-up (printed at the end): set the config key, then restart the Gateway.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
patch_file="$here/../patches/dingtalk-connector-0.8.27-direct-reply-mode.patch"
install_root="${DT_CONNECTOR_INSTALL:-/home/raymond/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector}"
backup_base="${DT_BACKUP_BASE:-$HOME/.openclaw/backups/dingtalk-direct-text-replies}"

[ -f "$patch_file" ] || { echo "patch file missing: $patch_file" >&2; exit 1; }
[ -d "$install_root/dist" ] || { echo "connector install not found: $install_root (override with DT_CONNECTOR_INSTALL)" >&2; exit 1; }

version="$(node -p "require('$install_root/package.json').version")"
if [ "$version" != "0.8.27" ]; then
  echo "REFUSING: installed connector is $version, patch is pinned to 0.8.27." >&2
  echo "A different version needs a rebased patch — do not force-apply." >&2
  exit 1
fi

cd "$install_root"

if grep -q 'directReplyMode' dist/message-handler-C8eu5xwl.mjs; then
  echo "Already applied (marker present in dist/message-handler-C8eu5xwl.mjs). Nothing to do."
  exit 0
fi

if ! patch -p1 --dry-run < "$patch_file" >/dev/null 2>&1; then
  echo "REFUSING: patch does not apply cleanly — installed files differ from upstream 0.8.27." >&2
  echo "If a previous patch was applied, restore the backup first or re-generate the patch." >&2
  exit 1
fi

ts="$(date +%Y%m%d-%H%M%S)"
backup_dir="$backup_base/$ts"
mkdir -p "$backup_dir"
cp -a src dist "$backup_dir/"
echo "Backup written to $backup_dir"

patch -p1 < "$patch_file"

grep -q 'directReplyMode' dist/message-handler-C8eu5xwl.mjs \
  || { echo "verification failed: marker missing after apply" >&2; exit 1; }
echo "Patch applied and verified."

config_file="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
if command -v node >/dev/null && [ -f "$config_file" ]; then
  if node -e "process.exit(require('$config_file').channels?.['dingtalk-connector']?.directReplyMode ? 0 : 1)" 2>/dev/null; then
    echo "Config already has channels.dingtalk-connector.directReplyMode set."
  else
    echo "NOTE: config does not set directReplyMode yet — the patch is dormant until you run:"
    echo "  pnpm openclaw config set channels.dingtalk-connector.directReplyMode markdown"
  fi
fi

cat <<'EOF'

Remaining steps (run manually):
  1. pnpm openclaw config set channels.dingtalk-connector.directReplyMode markdown
  2. Restart the Gateway (launchctl bootout + bootstrap per repo AGENTS.md), then:
     pnpm openclaw gateway health
  3. Verify in DingTalk: a DM reply must arrive as plain markdown text, no AI Card.

Upgrade warning: any plugin reinstall/update to an unpatched build silently reverts
this behavior AND the strict config schema will reject directReplyMode, blocking
Gateway startup. Always unset the config key before upgrading the plugin:
  pnpm openclaw config unset channels.dingtalk-connector.directReplyMode
EOF
