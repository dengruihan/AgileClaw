#!/usr/bin/env bash
# Report the direct-reply deployment state and flag inconsistent pairings.
#
# Exit 0 when the state is consistent (deployed, or cleanly not deployed).
# Exit 1 when config and plugin bytes disagree — the pairing that can block
# Gateway startup or silently revert DM replies.
#
# Usage: status.sh [--json]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

json=0
[ "${1:-}" = "--json" ] && json=1

facts="$(plugin_facts_json)"
if [ "$facts" = "null" ]; then
  die "plugin $PLUGIN_ID is not installed"
fi

version="$(json_field "$facts" version)"
source="$(json_field "$facts" source)"
root="$(json_field "$facts" rootDir)"
install_source="$(json_field "$facts" trust.installSource)"
deps_ok="$(json_field "$facts" dependencyStatus.requiredInstalled)"
status="$(json_field "$facts" status)"
mode="$(config_direct_reply_mode)"

patched="false"
plugin_marker_present "$root" && patched="true"

state="consistent"
if [ "$patched" = "true" ] && [ "$mode" != "markdown" ]; then
  state="patched-but-dormant"
elif [ "$patched" = "false" ] && [ -n "$mode" ]; then
  state="config-without-patch"
elif [ "$patched" = "true" ] && [ "$version" != "$LOCAL_VERSION" ]; then
  state="unexpected-version"
fi

if [ "$json" -eq 1 ]; then
  node -e '
    const [root, version, source, installSource, depsOk, status, mode, patched, state, service] =
      process.argv.slice(1);
    process.stdout.write(
      JSON.stringify(
        {
          pluginId: "dingtalk-connector",
          installedVersion: version,
          expectedLocalVersion: "0.8.27-claw.1",
          expectedUpstreamVersion: "0.8.27",
          patched: patched === "true",
          directReplyMode: mode || null,
          installSource: installSource || null,
          pluginStatus: status || null,
          dependenciesInstalled: depsOk === "true",
          rootDir: root || null,
          source: source || null,
          service: service || null,
          state,
        },
        null,
        2,
      ) + "\n",
    );
  ' "$root" "$version" "$source" "$install_source" "$deps_ok" "$status" "$mode" "$patched" "$state" "$(service_state)"
  [ "$state" = "consistent" ] && exit 0 || exit 1
fi

echo "plugin:        $PLUGIN_ID@$version ($install_source)"
echo "root:          $root"
echo "patched:       $patched"
echo "config:        $CHANNEL_DIRECT_MODE_PATH=${mode:-(unset)}"
echo "status:        $status, dependencies ok=$deps_ok"
echo "service:       $(service_state)"
echo "backups:       $(ls -1dt "$BACKUP_BASE"/*/ 2>/dev/null | tr '\n' ' ' || echo none)"
echo "state:         $state"

case "$state" in
  consistent) ;;
  patched-but-dormant)
    echo "note: patch is installed but dormant; set: pnpm openclaw config set $CHANNEL_DIRECT_MODE_PATH markdown" >&2
    exit 1
    ;;
  config-without-patch)
    echo "risk: the installed plugin is unpatched but the config key is set — Gateway startup will fail." >&2
    echo "      unset it now: pnpm openclaw config unset $CHANNEL_DIRECT_MODE_PATH" >&2
    exit 1
    ;;
  unexpected-version)
    echo "risk: patch marker found under an unexpected version $version; rebuild/reinstall the local package." >&2
    exit 1
    ;;
esac

echo "note: any plugin update/upgrade replaces this local package; re-check with scripts/status.sh and redeploy if needed."
