#!/usr/bin/env bash
# Shared paths and helpers for the DingTalk direct-reply deployment scripts.
#
# The deployment owner is OpenClaw's plugin manager: a local package built from
# the pinned upstream tarball plus our patch is installed with
# `openclaw plugins install`, which copies it into the managed extensions
# directory and records it in the installed-plugin index. Nothing under
# ~/.openclaw/npm/.../node_modules is edited directly.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLUGIN_ID="dingtalk-connector"
CHANNEL_PATH="channels.dingtalk-connector"
CHANNEL_DIRECT_MODE_PATH="$CHANNEL_PATH.directReplyMode"

UPSTREAM_NAME="@dingtalk-real-ai/dingtalk-connector"
UPSTREAM_VERSION="0.8.27"
# sha512 of the immutable registry tarball. Copied from the install's
# package-lock.json entry when this deployment was authored; the build script
# refuses any other bytes.
UPSTREAM_INTEGRITY="sha512-4RwylwBTTQpzIlNBOtfFnlbY/X2LFwULTbp6z1Eo3duTj86ZXy0Inilqkght+uZJgbU0/8K1kEbbwMDptagkQg=="
LOCAL_VERSION="0.8.27-claw.1"
PATCH_FILE="$OPS_DIR/patches/dingtalk-connector-0.8.27-direct-reply-mode.patch"

BACKUP_BASE="${DT_BACKUP_BASE:-$HOME/.openclaw/backups/dingtalk-direct-text-replies}"
OPENCLAW_ROOT="${OPENCLAW_ROOT:-$(cd "$OPS_DIR/../.." && pwd)}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_FILE="${OPENCLAW_CONFIG_PATH:-$STATE_DIR/openclaw.json}"
# systemd --user owner on the operator host; overridable for other hosts.
SERVICE_UNIT="${OPENCLAW_SERVICE_UNIT:-openclaw-gateway.service}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

openclaw_cli() {
  if [ -n "${OPENCLAW_CLI:-}" ]; then
    # Deliberate word splitting: OPENCLAW_CLI is a command plus optional args
    # (for example "node /path/to/dist/index.js").
    # shellcheck disable=SC2086
    (cd "$OPENCLAW_ROOT" && $OPENCLAW_CLI "$@")
  else
    (cd "$OPENCLAW_ROOT" && pnpm openclaw "$@")
  fi
}

sha512_integrity() {
  printf 'sha512-%s' "$(openssl dgst -sha512 -binary "$1" | base64 -w0)"
}

sha256_hex() {
  sha256sum "$1" | cut -d' ' -f1
}

# Current installed-plugin facts as compact JSON (version, source, rootDir,
# status, dependencyStatus). Prints "null" when the plugin is not installed.
#
# CLI failures are surfaced verbatim: the common one on this host is
# UpdatePreMutationError when `pnpm openclaw` refuses to publish stale dist
# artifacts over a running Gateway. Swallowing it produced a misleading
# "plugins list produced no JSON".
plugin_facts_json() {
  local output
  if ! output="$(openclaw_cli plugins list --json 2>&1)"; then
    printf '%s\n' "$output" >&2
    if printf '%s' "$output" | grep -q 'UpdatePreMutationError\|Runtime artifacts changed'; then
      cat >&2 <<EOF
The CLI refused before touching plugins: the checkout's dist is stale while its
Gateway is running. Rebuild on the host, or drive the existing build directly:
  OPENCLAW_CLI="node $OPENCLAW_ROOT/dist/index.js" $0 ...
EOF
    fi
    die "openclaw plugins list failed (output above)"
  fi
  printf '%s' "$output" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const start = input.indexOf("{");
      if (start < 0) {
        process.stderr.write(input + "\nplugins list produced no JSON\n");
        process.exit(1);
      }
      const parsed = JSON.parse(input.slice(start));
      const plugin = (parsed.plugins ?? []).find((entry) => entry.id === process.argv[1]);
      process.stdout.write(JSON.stringify(plugin ?? null));
    });
  ' "$PLUGIN_ID"
}

json_field() {
  node -e '
    const [raw, dotted] = process.argv.slice(1);
    let value = JSON.parse(raw);
    for (const key of dotted.split(".")) {
      value = value == null ? value : value[key];
    }
    process.stdout.write(value == null ? "" : String(value));
  ' "$1" "$2"
}

# Value of channels.dingtalk-connector.directReplyMode, or empty when unset.
config_direct_reply_mode() {
  node -e '
    const fs = require("node:fs");
    const [file, key] = process.argv.slice(1);
    let value = null;
    try {
      value = JSON.parse(fs.readFileSync(file, "utf8"))?.channels?.["dingtalk-connector"]?.[key] ?? null;
    } catch {
      value = null;
    }
    process.stdout.write(value == null ? "" : String(value));
  ' "$CONFIG_FILE" directReplyMode
}

plugin_marker_present() {
  local root="$1"
  [ -f "$root/dist/message-handler-C8eu5xwl.mjs" ] &&
    grep -q 'directReplyMode' "$root/dist/message-handler-C8eu5xwl.mjs"
}

service_state() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user cat "$SERVICE_UNIT" >/dev/null 2>&1; then
    printf 'systemd --user %s (%s)' "$SERVICE_UNIT" "$(systemctl --user is-active "$SERVICE_UNIT" 2>/dev/null || true)"
  else
    printf 'no systemd --user unit named %s' "$SERVICE_UNIT"
  fi
}

print_restart_steps() {
  local health_cmd
  if [ -n "${OPENCLAW_CLI:-}" ]; then
    health_cmd="(cd $OPENCLAW_ROOT && $OPENCLAW_CLI gateway health)"
  else
    health_cmd="(cd $OPENCLAW_ROOT && pnpm openclaw gateway health)"
  fi
  cat <<EOF

Restart (operator action; this script never restarts the Gateway):
  systemctl --user restart $SERVICE_UNIT
  $health_cmd
  journalctl --user -u $SERVICE_UNIT -n 50 --no-pager
EOF
}
