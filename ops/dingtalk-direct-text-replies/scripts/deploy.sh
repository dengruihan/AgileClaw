#!/usr/bin/env bash
# Deploy the local direct-reply-mode plugin through the plugin owner.
#
# Order matters:
#   1. build the local package (pinned upstream tarball + patch)
#   2. `openclaw plugins install <tarball>` — the plugin manager copies it into
#      the managed extensions directory, installs its dependencies, and updates
#      the installed-plugin index. The npm-managed connector copy is untouched.
#   3. set channels.dingtalk-connector.directReplyMode=markdown (only valid once
#      the patched manifest schema is the installed one)
#
# The script never restarts the Gateway. Without --yes it prints the plan and
# leaves everything untouched.
#
# Usage: deploy.sh [--yes] [--package <local-tarball>] [--dry-run]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
package=""

usage() {
  cat <<'EOF'
Usage: deploy.sh [--yes] [--package <local-tarball>] [--dry-run]

  --yes      apply the deployment (default: print the plan only)
  --package  use a prebuilt local tarball instead of building one
  --dry-run  print the plan only (same as the default)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --package) package="${2:-}"; shift 2 ;;
    --dry-run) yes=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

facts="$(plugin_facts_json)"
[ "$facts" != "null" ] || die "plugin $PLUGIN_ID is not installed; install the upstream plugin first"

installed_version="$(json_field "$facts" version)"
installed_root="$(json_field "$facts" rootDir)"
config_mode="$(config_direct_reply_mode)"

case "$installed_version" in
  "$UPSTREAM_VERSION" | "$LOCAL_VERSION") ;;
  *) die "installed $PLUGIN_ID is version $installed_version; this deployment targets $UPSTREAM_VERSION or $LOCAL_VERSION. Refusing." ;;
esac

if [ "$installed_version" = "$UPSTREAM_VERSION" ] && [ -n "$config_mode" ]; then
  die "config already sets $CHANNEL_DIRECT_MODE_PATH=$config_mode but the installed plugin is unpatched. Remove it first: pnpm openclaw config unset $CHANNEL_DIRECT_MODE_PATH"
fi

if [ "$installed_version" = "$LOCAL_VERSION" ] && [ "$config_mode" = "markdown" ] && plugin_marker_present "$installed_root"; then
  info "already deployed: $PLUGIN_ID@$LOCAL_VERSION with $CHANNEL_DIRECT_MODE_PATH=markdown"
  exit 0
fi

config_file_display="$CONFIG_FILE"
cat <<EOF
Plan:
  1. build $UPSTREAM_NAME@$LOCAL_VERSION from the pinned $UPSTREAM_VERSION tarball + patch
  2. openclaw plugins install <tarball> --force --accept-capabilities
  3. openclaw config set $CHANNEL_DIRECT_MODE_PATH markdown
  config file: $config_file_display
  service:     $(service_state)
EOF

if [ "$yes" -ne 1 ]; then
  echo
  echo "Dry run only. Re-run with --yes to apply (the Gateway is not restarted by this script)."
  exit 0
fi

ts="$(date +%Y%m%d-%H%M%S)"
backup_dir="$BACKUP_BASE/$ts"
mkdir -p "$backup_dir"

if [ -z "$package" ]; then
  info "building local package into $backup_dir"
  package="$("$OPS_DIR/scripts/build-package.sh" --out "$backup_dir" | tail -1)"
else
  [ -f "$package" ] || die "package not found: $package"
  package_dir="$(cd "$(dirname "$package")" && pwd -P)"
  package="$(cd "$package_dir" && pwd -P)/$(basename "$package")"
  cp "$package" "$backup_dir/"
  if [ -f "$package_dir/build.json" ]; then
    cp "$package_dir/build.json" "$backup_dir/build.json"
  elif [ ! -f "$backup_dir/build.json" ]; then
    node -e '
      const fs = require("node:fs");
      const [out, tarball, localVersion, upstreamVersion, upstreamIntegrity] = process.argv.slice(1);
      fs.writeFileSync(
        out,
        JSON.stringify(
          {
            name: "@dingtalk-real-ai/dingtalk-connector",
            local: { version: localVersion, tarball: tarball.split("/").pop(), sha256: null },
            upstream: { version: upstreamVersion, tarball: "", integrity: upstreamIntegrity },
            patch: { file: "", sha256: "" },
            builtAt: new Date().toISOString(),
            node: process.version,
            note: "synthesized from --package; offline rollback needs the upstream tarball",
          },
          null,
          2,
        ) + "\n",
      );
    ' "$backup_dir/build.json" "$package" "$LOCAL_VERSION" "$UPSTREAM_VERSION" "$UPSTREAM_INTEGRITY"
    node -e '
      const fs = require("node:fs");
      const [buildPath, sha] = process.argv.slice(1);
      const build = JSON.parse(fs.readFileSync(buildPath, "utf8"));
      build.local.sha256 = sha;
      fs.writeFileSync(buildPath, JSON.stringify(build, null, 2) + "\n");
    ' "$backup_dir/build.json" "$(sha256_hex "$package")"
  fi
fi
[ -f "$backup_dir/build.json" ] || die "build manifest missing in $backup_dir"

printf '%s\n' "$facts" >"$backup_dir/plugin-before.json"
node -e '
  const fs = require("node:fs");
  const [buildPath, beforePath, outPath, configMode, serviceUnit, configFile] =
    process.argv.slice(1);
  const build = JSON.parse(fs.readFileSync(buildPath, "utf8"));
  const before = JSON.parse(fs.readFileSync(beforePath, "utf8"));
  const deploy = {
    createdAt: new Date().toISOString(),
    serviceUnit,
    configFile,
    local: build.local,
    upstream: build.upstream,
    patch: build.patch,
    before: {
      version: before.version ?? null,
      source: before.source ?? null,
      rootDir: before.rootDir ?? null,
      directReplyMode: configMode || null,
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(deploy, null, 2) + "\n");
' "$backup_dir/build.json" "$backup_dir/plugin-before.json" "$backup_dir/deploy.json" "$config_mode" "$SERVICE_UNIT" "$CONFIG_FILE"

info "installing $package"
openclaw_cli plugins install "$package" --force --accept-capabilities ||
  die "plugin install failed; the previous plugin install is still recorded (see $backup_dir)"

facts_after="$(plugin_facts_json)"
version_after="$(json_field "$facts_after" version)"
root_after="$(json_field "$facts_after" rootDir)"
[ "$version_after" = "$LOCAL_VERSION" ] ||
  die "install verification failed: installed version is '$version_after', expected $LOCAL_VERSION"
plugin_marker_present "$root_after" ||
  die "install verification failed: patch marker missing under $root_after"

info "setting $CHANNEL_DIRECT_MODE_PATH=markdown"
if ! openclaw_cli config set "$CHANNEL_DIRECT_MODE_PATH" markdown; then
  die "config set failed after the plugin install. The patched plugin stays installed but dormant (default aicard). Retry: pnpm openclaw config set $CHANNEL_DIRECT_MODE_PATH markdown"
fi
[ "$(config_direct_reply_mode)" = "markdown" ] ||
  die "config verification failed: $CHANNEL_DIRECT_MODE_PATH is not markdown"

info "deployed $PLUGIN_ID@$LOCAL_VERSION (backup: $backup_dir)"

cat <<EOF

Verify after restart:
  1. A DM from an allowlisted user arrives as plain Markdown, not an AI Card.
  2. Gateway log shows: [DingTalk] 回复模式(单聊): markdown
     and no POST /v1.0/card/instances for that reply.
  3. Proactive collector notifications are unchanged.
  4. (If group chat is enabled) group replies keep their existing mode.
EOF
print_restart_steps
