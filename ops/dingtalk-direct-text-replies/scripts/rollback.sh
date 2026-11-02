#!/usr/bin/env bash
# Roll back the local direct-reply-mode plugin to stock upstream 0.8.27.
#
# The rollback is bound to the deploy manifest written by deploy.sh:
#   - the installed plugin must be exactly <manifest.local.version>; anything
#     else is refused instead of mixing files from two versions
#   - the upstream artifact must be the pinned 0.8.27 tarball (integrity check)
#   - the directReplyMode config key must be removed first, because the stock
#     manifest schema is strict and rejects it at Gateway startup
#
# The script never restarts the Gateway. Without --yes it prints the plan.
#
# Usage: rollback.sh [--yes] [--offline] [--backup <dir>]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
offline=0
backup_dir=""

usage() {
  cat <<'EOF'
Usage: rollback.sh [--yes] [--offline] [--backup <dir>]

  --yes      apply the rollback (default: print the plan only)
  --offline  reinstall the upstream tarball saved by deploy.sh instead of
             resolving npm:<name>@<version> from the registry
  --backup   backup directory written by deploy.sh (default: newest under
             ~/.openclaw/backups/dingtalk-direct-text-replies)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --offline) offline=1; shift ;;
    --backup) backup_dir="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

config_mode="$(config_direct_reply_mode)"
if [ -n "$config_mode" ]; then
  die "$CHANNEL_DIRECT_MODE_PATH is still set to '$config_mode'. Unset it before restoring the stock plugin, or the strict upstream config schema will reject it at Gateway startup:
  pnpm openclaw config unset $CHANNEL_DIRECT_MODE_PATH"
fi

facts="$(plugin_facts_json)"
[ "$facts" != "null" ] || die "plugin $PLUGIN_ID is not installed"

installed_version="$(json_field "$facts" version)"
if [ "$installed_version" = "$UPSTREAM_VERSION" ]; then
  info "already on stock $UPSTREAM_NAME@$UPSTREAM_VERSION; nothing to roll back"
  exit 0
fi
if [ "$installed_version" != "$LOCAL_VERSION" ]; then
  die "installed $PLUGIN_ID is version $installed_version; expected $LOCAL_VERSION. Refusing to mix versions — inspect with scripts/status.sh first."
fi

if [ -z "$backup_dir" ]; then
  backup_dir="$(ls -1dt "$BACKUP_BASE"/*/ 2>/dev/null | head -1 || true)"
fi
[ -n "$backup_dir" ] || die "no deploy backup found under $BACKUP_BASE; pass --backup <dir>"
backup_dir="${backup_dir%/}"
manifest="$backup_dir/deploy.json"
[ -f "$manifest" ] || die "deploy manifest missing: $manifest"

node -e '
  const fs = require("node:fs");
  const [manifestPath, installedVersion, upstreamVersion, upstreamIntegrity] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.local?.version !== installedVersion) {
    console.error(
      `manifest local version ${manifest.local?.version} does not match installed ${installedVersion}`,
    );
    process.exit(1);
  }
  if (manifest.upstream?.version !== upstreamVersion || manifest.upstream?.integrity !== upstreamIntegrity) {
    console.error("manifest upstream identity does not match the pinned upstream artifact");
    process.exit(1);
  }
' "$manifest" "$installed_version" "$UPSTREAM_VERSION" "$UPSTREAM_INTEGRITY" ||
  die "deploy manifest does not bind to the installed artifact; refusing rollback"

cat <<EOF
Plan:
  1. reinstall stock $UPSTREAM_NAME@$UPSTREAM_VERSION (${offline:+offline }via plugin manager)
  2. verify the installed version is $UPSTREAM_VERSION and the patch marker is gone
  backup:  $backup_dir
  service: $(service_state)
EOF

if [ "$yes" -ne 1 ]; then
  echo
  echo "Dry run only. Re-run with --yes to apply (the Gateway is not restarted by this script)."
  exit 0
fi

upstream_tarball_name="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.upstream?.tarball ?? "")' "$manifest")"

if [ "$offline" -eq 1 ]; then
  tgz="$backup_dir/$upstream_tarball_name"
  [ -f "$tgz" ] || die "saved upstream tarball missing: $tgz (run without --offline to use the registry)"
  actual_integrity="$(sha512_integrity "$tgz")"
  [ "$actual_integrity" = "$UPSTREAM_INTEGRITY" ] ||
    die "saved upstream tarball integrity mismatch: got $actual_integrity, expected $UPSTREAM_INTEGRITY"
  info "installing stock plugin from $tgz"
  openclaw_cli plugins install "$tgz" --force --accept-capabilities ||
    die "offline rollback install failed; plugin records left unchanged"
else
  info "installing stock plugin from npm:$UPSTREAM_NAME@$UPSTREAM_VERSION"
  openclaw_cli plugins install "npm:$UPSTREAM_NAME@$UPSTREAM_VERSION" --force --accept-capabilities ||
    die "rollback install failed; retry with --offline using the saved upstream tarball"
fi

facts_after="$(plugin_facts_json)"
version_after="$(json_field "$facts_after" version)"
root_after="$(json_field "$facts_after" rootDir)"
[ "$version_after" = "$UPSTREAM_VERSION" ] ||
  die "rollback verification failed: installed version is '$version_after', expected $UPSTREAM_VERSION"
if plugin_marker_present "$root_after"; then
  die "rollback verification failed: patch marker still present under $root_after"
fi

info "rolled back to $UPSTREAM_NAME@$UPSTREAM_VERSION (DM replies use AI Cards again)"
print_restart_steps
