#!/usr/bin/env bash
# Recover from "config-without-patch": a stock plugin is installed but
# channels.dingtalk-connector.directReplyMode was left in openclaw.json.
#
# In that state every CLI config mutation refuses, because the whole config is
# invalid against the stock plugin's strict manifest schema:
#   openclaw config unset / set / patch  -> "must not have additional properties"
#   openclaw doctor --fix                -> asks for hand editing
#   openclaw plugins install <patched>   -> same invalid-config refusal
#
# This script edits the canonical config file at its file owner: it backs the
# file up first, removes the stale key(s) atomically, then validates. On a
# validation failure it restores the backup. It can also restore a saved config
# copy (deploy.sh writes openclaw.json.before into every deploy backup).
#
# Usage: recover-config.sh [--yes] [--restore <openclaw.json>] [--backup-base <dir>]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
restore_from=""

usage() {
  cat <<'EOF'
Usage: recover-config.sh [--yes] [--restore <openclaw.json>] [--backup-base <dir>]

  --yes          apply the recovery (default: print the plan only)
  --restore      replace the config with a saved copy (for example
                 ~/.openclaw/backups/dingtalk-direct-text-replies/<ts>/openclaw.json.before)
  --backup-base  where to write the pre-recovery backup
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --restore) restore_from="${2:-}"; shift 2 ;;
    --backup-base) BACKUP_BASE="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -f "$CONFIG_FILE" ] || die "config file not found: $CONFIG_FILE"

if [ -n "$restore_from" ]; then
  [ -f "$restore_from" ] || die "restore source not found: $restore_from"
fi

# What is stale? Top-level key and per-account overrides (the patched manifest
# schema allowed both).
key_report="$(node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const channel = config?.channels?.["dingtalk-connector"];
  const found = [];
  if (channel && Object.hasOwn(channel, "directReplyMode")) {
    found.push({ path: "channels.dingtalk-connector.directReplyMode", value: channel.directReplyMode });
  }
  for (const [id, account] of Object.entries(channel?.accounts ?? {})) {
    if (account && Object.hasOwn(account, "directReplyMode")) {
      found.push({ path: `channels.dingtalk-connector.accounts.${id}.directReplyMode`, value: account.directReplyMode });
    }
  }
  process.stdout.write(JSON.stringify({ found, includes: Boolean(config?.$include) }));
' "$CONFIG_FILE")"

found_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).found.length))' "$key_report")"
has_include="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).includes ? "yes" : "no")' "$key_report")"

if [ -z "$restore_from" ] && [ "$found_count" = "0" ]; then
  info "no directReplyMode key found in $CONFIG_FILE; nothing to recover"
  exit 0
fi

cat <<EOF
Plan:
  config:  $CONFIG_FILE
  $( [ -n "$restore_from" ] && echo "restore: $restore_from" || echo "remove:  $(node -e 'process.stdout.write(JSON.parse(process.argv[1]).found.map((e) => e.path).join(", "))' "$key_report")" )
  backup:  $BACKUP_BASE/<timestamp>-config/
EOF
if [ "$has_include" = "yes" ]; then
  echo "note: this config uses \$include; included files are not edited — check them too."
fi

if [ "$yes" -ne 1 ]; then
  echo
  echo "Dry run only. Re-run with --yes to apply."
  exit 0
fi

ts="$(date +%Y%m%d-%H%M%S)"
backup_dir="$BACKUP_BASE/$ts-config"
mkdir -p "$backup_dir"
cp -p "$CONFIG_FILE" "$backup_dir/openclaw.json"
node -e '
  const fs = require("node:fs");
  const [out, configFile, backupFile, report] = process.argv.slice(1);
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        configFile,
        backupFile,
        sha256Before: require("node:crypto").createHash("sha256").update(fs.readFileSync(backupFile)).digest("hex"),
        found: JSON.parse(report).found,
        restoredFrom: process.argv[5] || null,
      },
      null,
      2,
    ) + "\n",
  );
' "$backup_dir/recovery.json" "$CONFIG_FILE" "$backup_dir/openclaw.json" "$key_report" "$restore_from"

if [ -n "$restore_from" ]; then
  cp -p "$restore_from" "$CONFIG_FILE"
  info "restored $CONFIG_FILE from $restore_from"
else
  node -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const file = process.argv[1];
    const stat = fs.statSync(file);
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    const channel = config?.channels?.["dingtalk-connector"];
    const removed = [];
    if (channel && Object.hasOwn(channel, "directReplyMode")) {
      delete channel.directReplyMode;
      removed.push("channels.dingtalk-connector.directReplyMode");
    }
    for (const [id, account] of Object.entries(channel?.accounts ?? {})) {
      if (account && Object.hasOwn(account, "directReplyMode")) {
        delete account.directReplyMode;
        removed.push(`channels.dingtalk-connector.accounts.${id}.directReplyMode`);
      }
    }
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.recover.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: stat.mode });
    fs.renameSync(tmp, file);
    process.stdout.write(removed.join(", "));
  ' "$CONFIG_FILE" >"$backup_dir/removed.txt"
  info "removed $(cat "$backup_dir/removed.txt")"
fi

# Validate with the CLI. A failure that still names directReplyMode means the
# file edit did not fix validity and must be rolled back. A failure to run at
# all (for example the stale-dist publication guard) cannot be judged here, so
# keep the fix and say so.
validate_output=""
if validate_output="$(openclaw_cli config validate 2>&1)"; then
  info "config validates"
else
  printf '%s\n' "$validate_output" >&2
  if printf '%s' "$validate_output" | grep -q 'directReplyMode'; then
    cp -p "$backup_dir/openclaw.json" "$CONFIG_FILE"
    die "recovery did not validate; restored the backup at $backup_dir/openclaw.json"
  fi
  echo "WARNING: config validate could not run to completion (see output above)." >&2
  echo "         The key is removed and the pre-recovery file is at $backup_dir/openclaw.json." >&2
  echo "         Re-run with OPENCLAW_CLI=\"node $OPENCLAW_ROOT/dist/index.js\" to confirm validation." >&2
fi

cat <<EOF

Recovered config state. Next:
  1. Confirm: ./scripts/status.sh
  2. Restart the Gateway when approved: systemctl --user restart $SERVICE_UNIT
  3. Deploy again if DM text replies are still wanted: ./scripts/deploy.sh --yes
EOF
