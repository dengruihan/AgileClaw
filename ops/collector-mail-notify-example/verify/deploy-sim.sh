#!/usr/bin/env bash
# Offline end-to-end simulation for the M13 collector-notify mail example.
#
# Runs deploy/status/rollback against a temporary root and backup base, so no
# live file is read or written. Covers the plan-only default, backup contents,
# idempotency, drift refusal, --allow-drift, rollback and double rollback.
#
# Usage: ./verify/deploy-sim.sh
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$OPS_DIR/manifest.json"
PACKAGE_FILE="$OPS_DIR/files/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export CMNE_TARGET_ROOT="$TMP/root"
export CMNE_BACKUP_BASE="$TMP/backups"

TARGET="$CMNE_TARGET_ROOT/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md"
OTHER_SKILL="$CMNE_TARGET_ROOT/home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md"
CONFIG="$CMNE_TARGET_ROOT/home/raymond/.openclaw/openclaw.json"
mkdir -p "$(dirname "$TARGET")" "$(dirname "$OTHER_SKILL")"

baseline_sha="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.target.baselineSha256)' "$MANIFEST")"
deployed_sha="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.target.deployedSha256)' "$MANIFEST")"

# Reconstruct the live post-M11 baseline from the package + manifest replacement.
node -e '
  const fs = require("node:fs");
  const [manifestPath, packagePath, targetPath] = process.argv.slice(1);
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const skill = fs.readFileSync(packagePath, "utf8");
  if (!skill.includes(m.replacement.new)) throw new Error("new example missing from package");
  fs.writeFileSync(targetPath, skill.replace(m.replacement.new, m.replacement.old));
' "$MANIFEST" "$PACKAGE_FILE" "$TARGET"

printf 'another skill stays untouched\n' >"$OTHER_SKILL"
printf '{"tools":{"allow":[]}}\n' >"$CONFIG"
other_sha="$(sha256sum "$OTHER_SKILL" | cut -d' ' -f1)"
config_sha="$(sha256sum "$CONFIG" | cut -d' ' -f1)"
target_mode="$(stat -c %a "$TARGET")"

passed=0
failures=0
ok() {
  passed=$((passed + 1))
}
bad() {
  failures=$((failures + 1))
  echo "FAIL: $*" >&2
}
assert_eq() {
  if [ "$1" = "$2" ]; then ok; else bad "$3 (got '$1', expected '$2')"; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -Fq -- "$2"; then ok; else bad "$3 (missing '$2')"; fi
}
assert_not_contains() {
  if printf '%s' "$1" | grep -Fq -- "$2"; then bad "$3 (unexpected '$2')"; else ok; fi
}
sha() {
  sha256sum "$1" | cut -d' ' -f1
}
backup_count() {
  ls -1d "$CMNE_BACKUP_BASE"/*/ 2>/dev/null | wc -l | tr -d ' '
}
latest_backup() {
  ls -1dt "$CMNE_BACKUP_BASE"/*/ 2>/dev/null | head -1 | sed 's:/$::'
}

# --- 1. Baseline and read-only status ---------------------------------------
assert_eq "$(sha "$TARGET")" "$baseline_sha" "sim baseline reconstruction"
if out="$("$OPS_DIR/scripts/status.sh" 2>&1)"; then
  assert_contains "$out" "state: baseline (sha256 $baseline_sha" "status detects baseline"
  assert_contains "$out" "stale tokens: 邮箱净增" "status reports stale mail token"
else
  bad "status.sh failed on baseline: $out"
fi

# --- 2. Plan-only deploy changes nothing ------------------------------------
if out="$("$OPS_DIR/scripts/deploy.sh" 2>&1)"; then
  assert_contains "$out" "plan only" "deploy default is plan-only"
  assert_contains "$out" "sha256 $deployed_sha" "plan shows desired hash"
  assert_eq "$(sha "$TARGET")" "$baseline_sha" "plan leaves the target untouched"
  assert_eq "$(backup_count)" "0" "plan writes no backup"
else
  bad "deploy plan failed: $out"
fi

# --- 3. Apply ---------------------------------------------------------------
if out="$("$OPS_DIR/scripts/deploy.sh" --yes 2>&1)"; then
  assert_contains "$out" "verified" "deploy verifies after writing"
  assert_eq "$(sha "$TARGET")" "$deployed_sha" "deploy writes the package content"
  assert_eq "$(backup_count)" "1" "deploy writes one backup"
  assert_eq "$(stat -c %a "$TARGET")" "$target_mode" "deploy preserves the file mode"
else
  bad "deploy --yes failed: $out"
fi
backup1="$(latest_backup)"
assert_eq "$(sha "$backup1/SKILL.md.before")" "$baseline_sha" "backup holds the baseline"
assert_eq "$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.before.sha256)' "$backup1/deploy.json")" "$baseline_sha" "backup records the before hash"
assert_eq "$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.after.sha256)' "$backup1/deploy.json")" "$deployed_sha" "backup records the after hash"
assert_eq "$(sha "$OTHER_SKILL")" "$other_sha" "another skill is untouched"
assert_eq "$(sha "$CONFIG")" "$config_sha" "openclaw.json is untouched"

# --- 4. Idempotency ---------------------------------------------------------
if out="$("$OPS_DIR/scripts/deploy.sh" --yes 2>&1)"; then
  assert_contains "$out" "already deployed" "second deploy is a no-op"
  assert_eq "$(backup_count)" "1" "second deploy writes no extra backup"
else
  bad "idempotent deploy failed: $out"
fi

# --- 5. Drift is refused, then accepted with a backup -----------------------
printf '\n<!-- manual tweak -->\n' >>"$TARGET"
drifted_sha="$(sha "$TARGET")"
if out="$("$OPS_DIR/scripts/status.sh" 2>&1)"; then
  assert_contains "$out" "state: drift" "status detects drift"
else
  bad "status failed on drift: $out"
fi
if out="$("$OPS_DIR/scripts/deploy.sh" --yes 2>&1)"; then
  bad "deploy accepted unrecorded drift without --allow-drift"
else
  assert_contains "$out" "neither the recorded baseline" "deploy refuses unrecorded drift"
  assert_eq "$(sha "$TARGET")" "$drifted_sha" "refused deploy leaves drift in place"
fi
if out="$("$OPS_DIR/scripts/rollback.sh" --yes 2>&1)"; then
  bad "rollback overwrote post-deploy drift without --force"
else
  assert_contains "$out" "changed after deployment" "rollback refuses post-deploy drift"
  assert_eq "$(sha "$TARGET")" "$drifted_sha" "refused rollback leaves drift in place"
fi

if out="$("$OPS_DIR/scripts/rollback.sh" --yes --force --backup "$backup1" 2>&1)"; then
  assert_contains "$out" "restored" "forced rollback restores the baseline"
  assert_eq "$(sha "$TARGET")" "$baseline_sha" "forced rollback writes the baseline"
else
  bad "forced rollback failed: $out"
fi

# --- 6. --allow-drift keeps a backup before replacing -----------------------
printf '\n<!-- second manual tweak -->\n' >>"$TARGET"
drifted2_sha="$(sha "$TARGET")"
if out="$("$OPS_DIR/scripts/deploy.sh" --yes --allow-drift 2>&1)"; then
  assert_contains "$out" "drift accepted" "allow-drift is reported"
  assert_eq "$(sha "$TARGET")" "$deployed_sha" "allow-drift deploys the package"
  assert_eq "$(backup_count)" "2" "allow-drift writes a second backup"
else
  bad "deploy --allow-drift failed: $out"
fi
backup2="$(latest_backup)"
assert_eq "$(sha "$backup2/SKILL.md.before")" "$drifted2_sha" "second backup holds the drifted content"

# --- 7. Rollback and double rollback ----------------------------------------
if out="$("$OPS_DIR/scripts/rollback.sh" 2>&1)"; then
  assert_contains "$out" "plan only" "rollback default is plan-only"
  assert_eq "$(sha "$TARGET")" "$deployed_sha" "rollback plan leaves the target untouched"
else
  bad "rollback plan failed: $out"
fi
if out="$("$OPS_DIR/scripts/rollback.sh" --yes 2>&1)"; then
  assert_contains "$out" "verified" "rollback verifies the restore"
  assert_eq "$(sha "$TARGET")" "$drifted2_sha" "rollback restores the backed-up content"
  assert_eq "$(stat -c %a "$TARGET")" "$target_mode" "rollback preserves the file mode"
else
  bad "rollback --yes failed: $out"
fi
if out="$("$OPS_DIR/scripts/rollback.sh" --yes 2>&1)"; then
  assert_contains "$out" "already rolled back" "second rollback is a no-op"
else
  bad "double rollback failed: $out"
fi
assert_eq "$(sha "$OTHER_SKILL")" "$other_sha" "another skill is still untouched"
assert_eq "$(sha "$CONFIG")" "$config_sha" "openclaw.json is still untouched"

if [ "$failures" -ne 0 ]; then
  echo "FAILED $failures of $((passed + failures)) checks" >&2
  exit 1
fi
echo "PASS $passed checks"
