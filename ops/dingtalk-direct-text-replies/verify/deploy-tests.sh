#!/usr/bin/env bash
# Isolated-state deployment tests for the direct-reply local plugin package.
#
# Proves the deployment owner end to end without touching the live install,
# the live config, or the Gateway:
#   - build a local package from the integrity-pinned upstream tarball + patch
#   - `openclaw plugins install <tarball>` into a temporary state dir
#   - config set is accepted by the host channel schema
#   - rollback refuses config-without-patch, version mismatch, and corrupted
#     upstream bytes; then restores stock 0.8.27 offline
#   - the npm-managed connector install bytes are unchanged throughout
#
# Usage: OPENCLAW_ROOT=/path/to/built/checkout ./deploy-tests.sh [--keep]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ops="$(cd "$here/.." && pwd)"
openclaw_root="${OPENCLAW_ROOT:-$(cd "$ops/../.." && pwd)}"
keep=0
[ "${1:-}" = "--keep" ] && keep=1

[ -f "$openclaw_root/dist/index.js" ] ||
  { echo "OPENCLAW_ROOT=$openclaw_root has no dist/index.js; point OPENCLAW_ROOT at a built checkout" >&2; exit 1; }

real_install="${DT_CONNECTOR_INSTALL:-/home/raymond/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector}"

work="$(mktemp -d /tmp/dt-deploy-XXXXXX)"
state="$work/state"
mkdir -p "$state" "$work/backups"
cleanup() {
  if [ "$keep" -eq 1 ]; then
    echo "kept: $work"
  else
    rm -rf "$work"
  fi
}
trap cleanup EXIT

cat >"$state/openclaw.json" <<'JSON'
{
  "channels": { "dingtalk-connector": { "enabled": true, "dmPolicy": "allowlist", "allowFrom": ["1000000000000000001"] } },
  "plugins": { "entries": { "dingtalk-connector": { "enabled": true } } }
}
JSON

export OPENCLAW_STATE_DIR="$state"
export OPENCLAW_CONFIG_PATH="$state/openclaw.json"
export OPENCLAW_GATEWAY_PORT=19987
export OPENCLAW_ROOT="$openclaw_root"
# Tests drive the built CLI entry directly: `pnpm openclaw` refuses to publish
# over a running Gateway when the checkout's dist is stale, which is unrelated
# to the plugin install path under test.
export OPENCLAW_CLI="${OPENCLAW_CLI:-node $openclaw_root/dist/index.js}"
export DT_BACKUP_BASE="$work/backups"
export OPENCLAW_SERVICE_UNIT="dt-deploy-tests-absent.service"

results=()
failures=0
check() { # check <label> <condition-command...>
  local label="$1"
  shift
  if "$@"; then
    results+=("PASS $label")
  else
    results+=("FAIL $label")
    failures=$((failures + 1))
  fi
}

cli() {
  if [ -n "${OPENCLAW_CLI:-}" ]; then
    # shellcheck disable=SC2086
    (cd "$openclaw_root" && $OPENCLAW_CLI "$@")
  else
    (cd "$openclaw_root" && pnpm openclaw "$@")
  fi
}

plugin_json() {
  cli plugins list --json 2>/dev/null | node -e '
    let input = "";
    process.stdin.on("data", (c) => (input += c));
    process.stdin.on("end", () => {
      const start = input.indexOf("{");
      const parsed = JSON.parse(input.slice(start));
      const plugin = (parsed.plugins ?? []).find((p) => p.id === "dingtalk-connector");
      process.stdout.write(JSON.stringify(plugin ?? null));
    });
  '
}

field() {
  node -e '
    const [raw, dotted] = process.argv.slice(1);
    let v = JSON.parse(raw);
    for (const k of dotted.split(".")) v = v == null ? v : v[k];
    process.stdout.write(v == null ? "" : String(v));
  ' "$1" "$2"
}

config_mode() {
  node -e '
    const fs = require("node:fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(c.channels?.["dingtalk-connector"]?.directReplyMode ?? "");
  ' "$OPENCLAW_CONFIG_PATH"
}

install_fingerprint() {
  if [ -d "$real_install/dist" ]; then
    (cd "$real_install" && find dist src openclaw.plugin.json package.json -type f -print0 |
      sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
  else
    echo "absent"
  fi
}

run_expect_fail() { # run_expect_fail <label> <cmd...>
  local label="$1"
  shift
  if "$@" >"$work/last.log" 2>&1; then
    results+=("FAIL $label (command unexpectedly succeeded)")
    failures=$((failures + 1))
  else
    results+=("PASS $label")
  fi
}

before_fingerprint="$(install_fingerprint)"

# ---------------------------------------------------------------------------
# 0. Seed the isolated state with the real-world precondition: the stock
#    upstream plugin installed from npm.
# ---------------------------------------------------------------------------
cli plugins install "npm:@dingtalk-real-ai/dingtalk-connector@0.8.27" --force --accept-capabilities \
  >"$work/seed.log" 2>&1 || {
  cat "$work/seed.log" >&2
  echo "seeding the upstream plugin failed" >&2
  exit 1
}
check "seed installed stock 0.8.27" test "$(field "$(plugin_json)" version)" = "0.8.27"

# ---------------------------------------------------------------------------
# 1. Build the local package.
# ---------------------------------------------------------------------------
package="$("$ops/scripts/build-package.sh" --out "$work/build" | tail -1)"
check "build produced a local tarball" test -f "$package"
check "build saved the verified upstream tarball" test -f "$work/build/upstream-0.8.27.tgz"
check "build wrote build.json" test -f "$work/build/build.json"

pkg_version="$(tar -xOf "$package" package/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).version))')"
check "local package version is 0.8.27-claw.1" test "$pkg_version" = "0.8.27-claw.1"

manifest_json="$(tar -xOf "$package" package/openclaw.plugin.json)"
check "local package manifest defines directReplyMode" node -e '
  const m = JSON.parse(process.argv[1]);
  const s = m.channelConfigs["dingtalk-connector"].schema;
  process.exit(s.properties.directReplyMode && s.properties.accounts.additionalProperties.properties.directReplyMode ? 0 : 1);
' "$manifest_json"

check "local package dist carries the patch marker" bash -c "tar -xOf '$package' package/dist/message-handler-C8eu5xwl.mjs | grep -q directReplyMode"

# ---------------------------------------------------------------------------
# 2. Dry run leaves state untouched.
# ---------------------------------------------------------------------------
run_dry() { "$ops/scripts/deploy.sh"; }
if run_dry >"$work/last.log" 2>&1; then
  results+=("PASS deploy dry run exits 0")
else
  results+=("FAIL deploy dry run exits 0")
  failures=$((failures + 1))
fi
check "dry run did not install the local package" bash -c "! test -d '$state/extensions/dingtalk-connector'"

# ---------------------------------------------------------------------------
# 3. Deploy through the plugin owner.
# ---------------------------------------------------------------------------
"$ops/scripts/deploy.sh" --yes >"$work/deploy.log" 2>&1 || {
  cat "$work/deploy.log" >&2
  echo "deploy failed" >&2
  exit 1
}

facts="$(plugin_json)"
check "installed plugin version is 0.8.27-claw.1" test "$(field "$facts" version)" = "0.8.27-claw.1"
check "plugin installed under the managed extensions dir" test "$(field "$facts" rootDir)" = "$state/extensions/dingtalk-connector"
check "installed plugin carries the patch marker" grep -q directReplyMode "$state/extensions/dingtalk-connector/dist/message-handler-C8eu5xwl.mjs"
check "required dependencies installed" test "$(field "$facts" dependencyStatus.requiredInstalled)" = "true"
check "config directReplyMode is markdown" test "$(config_mode)" = "markdown"
check "deploy manifest written" test -f "$work/backups/$(ls -1 "$work/backups" | head -1)/deploy.json"
check "deploy did not touch the npm-managed install bytes" test "$(install_fingerprint)" = "$before_fingerprint"

status_json="$("$ops/scripts/status.sh" --json)"
check "status reports a consistent deployment" test "$(field "$status_json" state)" = "consistent"

backup_dir="$(ls -1dt "$work/backups"/*/ | head -1)"
backup_dir="${backup_dir%/}"

# ---------------------------------------------------------------------------
# 4. Rollback guards.
# ---------------------------------------------------------------------------
run_expect_fail "rollback refuses while directReplyMode is set" "$ops/scripts/rollback.sh" --yes --offline --backup "$backup_dir"

cli config unset channels.dingtalk-connector.directReplyMode >/dev/null 2>&1
check "config key removed for rollback tests" test -z "$(config_mode)"

status_after_unset="$("$ops/scripts/status.sh" --json || true)"
check "status flags patched-but-dormant after unset" test "$(field "$status_after_unset" state)" = "patched-but-dormant"

cp "$backup_dir/deploy.json" "$work/deploy.json.good"
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  const m = JSON.parse(fs.readFileSync(p, "utf8"));
  m.local.version = "0.8.27-claw.999";
  fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
' "$backup_dir/deploy.json"
run_expect_fail "rollback refuses a manifest that does not bind the installed version" "$ops/scripts/rollback.sh" --yes --offline --backup "$backup_dir"
cp "$work/deploy.json.good" "$backup_dir/deploy.json"

bad_backup="$work/backups/bad"
cp -R "$backup_dir" "$bad_backup"
node -e 'const fs=require("node:fs");const p=process.argv[1];fs.appendFileSync(p,"corrupt")' "$bad_backup/$(field "$(cat "$bad_backup/deploy.json")" upstream.tarball)"
run_expect_fail "rollback refuses corrupted upstream tarball bytes" "$ops/scripts/rollback.sh" --yes --offline --backup "$bad_backup"

# A config key written by hand (bypassing config set) must be caught before install.
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.channels["dingtalk-connector"].directReplyMode = "markdown";
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$OPENCLAW_CONFIG_PATH"
# The installed package is still patched here, so this state is valid; the
# guard that matters is deploy refusing config-without-patch. Unset again for
# the rollback run and simulate the unpatched case after rollback instead.
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  delete c.channels["dingtalk-connector"].directReplyMode;
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$OPENCLAW_CONFIG_PATH"

# ---------------------------------------------------------------------------
# 5. Offline rollback to stock 0.8.27.
# ---------------------------------------------------------------------------
"$ops/scripts/rollback.sh" --yes --offline --backup "$backup_dir" >"$work/rollback.log" 2>&1 || {
  cat "$work/rollback.log" >&2
  echo "rollback failed" >&2
  exit 1
}
facts_after="$(plugin_json)"
check "rollback installed stock 0.8.27" test "$(field "$facts_after" version)" = "0.8.27"
check "rollback removed the patch marker" bash -c "! grep -q directReplyMode '$(field "$facts_after" rootDir)/dist/message-handler-C8eu5xwl.mjs'"
check "rollback left the config key unset" test -z "$(config_mode)"
check "rollback did not touch the npm-managed install bytes" test "$(install_fingerprint)" = "$before_fingerprint"

# ---------------------------------------------------------------------------
# 6. Deploy refuses a config key that the stock plugin cannot validate.
# ---------------------------------------------------------------------------
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  const c = JSON.parse(fs.readFileSync(p, "utf8"));
  c.channels["dingtalk-connector"].directReplyMode = "markdown";
  fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n");
' "$OPENCLAW_CONFIG_PATH"
run_expect_fail "deploy refuses config-without-patch" "$ops/scripts/deploy.sh" --yes --package "$package"

# ---------------------------------------------------------------------------
# 7. Scripts never address the npm-managed install path.
# ---------------------------------------------------------------------------
check "deploy/rollback/build scripts do not reference node_modules paths" bash -c \
  "! grep -R -q 'node_modules/@dingtalk-real-ai' '$ops/scripts'"

echo
for line in "${results[@]}"; do echo "$line"; done
echo
pass_count=$(printf '%s\n' "${results[@]}" | grep -c '^PASS')
echo "RESULT: $pass_count/${#results[@]} passed, $failures failed"
[ "$failures" -eq 0 ]
