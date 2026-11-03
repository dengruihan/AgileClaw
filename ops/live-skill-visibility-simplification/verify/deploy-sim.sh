#!/usr/bin/env bash
# End-to-end deploy/rollback simulation against a throwaway OpenClaw home.
# It never reads or writes the live ~/.openclaw tree.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$OPS_DIR/manifest.json"
FIXTURES="$OPS_DIR/verify/fixtures"
BACKUP_BASE_ROOT=""

passes=0
failures=0
pass() {
  passes=$((passes + 1))
  echo "PASS sim: $1"
}
fail() {
  failures=$((failures + 1))
  echo "FAIL sim: $1"
}

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT
BACKUP_BASE_ROOT="$tmp/backups"

root="$tmp/openclaw"
workspace="$root/workspace/skills"
workshop="$root/agents/main/agent/workshop-skills"
mkdir -p "$workspace" "$workshop"
cp -R "$FIXTURES/baseline/workspace/skills/." "$workspace/"
cp -R "$FIXTURES/baseline/agents/main/agent/workshop-skills/." "$workshop/"
cp -R "$FIXTURES/control-visible" "$workspace/control-visible"
cp -R "$FIXTURES/control-disabled" "$workspace/control-disabled"
cat >"$root/openclaw.json" <<EOF
{
  "skills": { "entries": { "control-disabled": { "enabled": false } } }
}
EOF

export M20_OPENCLAW_HOME="$root"
export M20_BACKUP_BASE="$BACKUP_BASE_ROOT"
export M20_OPENCLAW_BIN="$OPS_DIR/verify/fake-openclaw"
export M20_FAKE_OPENCLAW_HOME="$root"
export M20_FAKE_STATE_DIR="$tmp/fake-state"
export M20_FAKE_DISABLED="control-disabled"
export M20_NODE="${M20_NODE:-node}"

names=(collector-dingtalk-triage collector-mail-triage collector-source-triage collector-health-repair collector-notify biandan-todo)

target_file() {
  case "$1" in
    biandan-todo) printf '%s/biandan-todo/SKILL.md' "$workshop" ;;
    *) printf '%s/%s/SKILL.md' "$workspace" "$1" ;;
  esac
}

baseline_file() {
  case "$1" in
    biandan-todo) printf '%s/baseline/agents/main/agent/workshop-skills/biandan-todo/SKILL.md' "$FIXTURES" ;;
    *) printf '%s/baseline/workspace/skills/%s/SKILL.md' "$FIXTURES" "$1" ;;
  esac
}

# collector-source-triage's current body is owned by the M19 package, so the
# simulator seeds that target from the owner copy. Live holds exactly these bytes
# and the fixture baseline must track them.
source_triage_owner_copy="$OPS_DIR/../collector-course-sync/files/home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md"
[ -f "$source_triage_owner_copy" ] || {
  echo "missing M19 owner copy: $source_triage_owner_copy" >&2
  exit 1
}

seed_file() {
  case "$1" in
    collector-source-triage) printf '%s' "$source_triage_owner_copy" ;;
    *) baseline_file "$1" ;;
  esac
}

hash_file() {
  sha256sum "$1" | cut -d' ' -f1
}

reset_fake_state() {
  rm -rf "$M20_FAKE_STATE_DIR"
  mkdir -p "$M20_FAKE_STATE_DIR"
}

reset_tree() {
  local name
  for name in "${names[@]}"; do
    cp -p "$(seed_file "$name")" "$(target_file "$name")"
  done
}

declare -A baseline_hash
for name in "${names[@]}"; do
  baseline_hash["$name"]="$(hash_file "$(seed_file "$name")")"
done
control_hash="$(hash_file "$workspace/control-visible/SKILL.md")"
disabled_hash="$(hash_file "$workspace/control-disabled/SKILL.md")"

latest_backup() {
  ls -1dt "$BACKUP_BASE_ROOT"/*/ 2>/dev/null | head -1 | sed 's:/$::'
}

json_get() {
  "$M20_NODE" -e '
    const fs=require("node:fs");let v=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    for (const p of process.argv[2].split(".")) v = v?.[p];
    process.stdout.write(v === undefined ? "" : String(v));
  ' "$1" "$2"
}

run_ok() {
  local label="$1"
  shift
  local log="$tmp/run.log"
  if "$@" >"$log" 2>&1; then
    pass "$label"
  else
    fail "$label"
    sed 's/^/    /' "$log" | tail -20
  fi
  LAST_LOG="$log"
}

run_fail() {
  local label="$1"
  shift
  local log="$tmp/run-fail.log"
  if "$@" >"$log" 2>&1; then
    fail "$label (command unexpectedly succeeded)"
    sed 's/^/    /' "$log" | tail -20
  else
    pass "$label"
  fi
  LAST_LOG="$log"
}

status_count() {
  "$OPS_DIR/scripts/status.sh" 2>/dev/null | sed -n 's/^visible skills (CLI): //p' | head -1
}

# Baseline state.
reset_fake_state
run_ok "status reports baseline" "$OPS_DIR/scripts/status.sh"
[ "$(status_count)" = "7" ] && pass "baseline visible count is 7" || fail "baseline visible count is $(status_count), expected 7"
run_fail "status --expect-hidden rejects baseline" "$OPS_DIR/scripts/status.sh" --expect-hidden
run_ok "deploy dry-run prints plan" "$OPS_DIR/scripts/deploy.sh"
grep -q "planned inserts: 6" "$LAST_LOG" && pass "plan inserts six lines" || fail "plan did not report six inserts"
[ ! -d "$BACKUP_BASE_ROOT" ] && pass "dry run created no backup" || fail "dry run created a backup"

# Ownership regression: live collector-source-triage holds the reviewed M19 body
# from ops/collector-course-sync. It must classify as current owner content, not
# as a visibility restoration, and the fixture baseline must track those bytes.
reset_tree
reset_fake_state
owner_sha="$(hash_file "$source_triage_owner_copy")"
fixture_sha="$(hash_file "$FIXTURES/baseline/workspace/skills/collector-source-triage/SKILL.md")"
manifest_sha="$("$M20_NODE" -e '
  const manifest = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const target = manifest.targets.find((item) => item.name === "collector-source-triage");
  process.stdout.write(target.baselineSha256);
' "$MANIFEST")"
if [ "$owner_sha" = "$fixture_sha" ] && [ "$owner_sha" = "$manifest_sha" ]; then
  pass "source-triage baseline tracks the M19 owner body"
else
  fail "source-triage baseline does not track the M19 owner body"
fi
run_ok "status accepts the M19 owner body" "$OPS_DIR/scripts/status.sh"
grep -q "collector-source-triage: visible (authoring baseline; current owner ops/collector-course-sync/" "$LAST_LOG" \
  && pass "status names ops/collector-course-sync as the current owner" \
  || fail "status did not name the current owner"
grep -q "collector-source-triage: VISIBILITY-RESTORED" "$LAST_LOG" \
  && fail "status reported the current owner body as restored" \
  || pass "current owner body is not reported as restored"

# A genuinely stale copy (the M15 agenda wording body) still trips the
# protection, and deploy refuses to hide a restored body.
cp -p "$OPS_DIR/../collector-agenda-wording-fix/files/home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md" \
  "$(target_file collector-source-triage)"
stale_sha="$(hash_file "$(target_file collector-source-triage)")"
run_fail "status rejects the legacy M15 source-triage body" "$OPS_DIR/scripts/status.sh"
grep -q "VISIBILITY-RESTORED by ops/collector-agenda-wording-fix" "$LAST_LOG" \
  && pass "status names the legacy source-triage package" \
  || fail "status did not name the legacy source-triage package"
run_fail "deploy refuses a legacy-restored body" "$OPS_DIR/scripts/deploy.sh" --yes
grep -q "VISIBILITY-RESTORED by ops/collector-agenda-wording-fix" "$LAST_LOG" \
  && pass "deploy refuses to hide a restored body" \
  || fail "deploy did not refuse the restored body"
[ "$(hash_file "$(target_file collector-source-triage)")" = "$stale_sha" ] \
  && pass "refused deploy wrote nothing" \
  || fail "refused deploy changed the target"
reset_tree
reset_fake_state
run_ok "status passes after restoring the owner body" "$OPS_DIR/scripts/status.sh"

# First deploy.
reset_fake_state
run_ok "deploy --yes" "$OPS_DIR/scripts/deploy.sh" --yes
backup1="$(latest_backup)"
[ -n "$backup1" ] && pass "first backup exists" || fail "first backup missing"
[ "$(json_get "$backup1/deploy.json" status)" = "deployed" ] && pass "deploy.json status deployed" || fail "deploy.json status is $(json_get "$backup1/deploy.json" status)"
[ "$(json_get "$backup1/deploy.json" visibleBefore)" = "7" ] && pass "backup records 7 visible before" || fail "backup visibleBefore wrong"
[ "$(json_get "$backup1/deploy.json" visibleAfter)" = "1" ] && pass "backup records 1 visible after" || fail "backup visibleAfter wrong"
for name in "${names[@]}"; do
  file="$(target_file "$name")"
  "$M20_NODE" "$OPS_DIR/scripts/apply-flag.mjs" --file "$file" --name "$name" --baseline "$(seed_file "$name")" --verify-insert-only >/dev/null 2>&1 \
    && pass "$name: exactly one line inserted" || fail "$name: body changed beyond one line"
  [ "$(hash_file "$file")" != "${baseline_hash[$name]}" ] && pass "$name: target hash changed" || fail "$name: target hash unchanged"
done
"$M20_NODE" "$OPS_DIR/scripts/apply-flag.mjs" --file "$(target_file collector-source-triage)" --name collector-source-triage --baseline "$source_triage_owner_copy" --verify-insert-only >/dev/null 2>&1 \
  && pass "source-triage: one line inserted onto the M19 body" \
  || fail "source-triage: M19 body changed beyond the inserted line"
[ "$(hash_file "$workspace/control-visible/SKILL.md")" = "$control_hash" ] && pass "visible control unchanged" || fail "visible control changed"
[ "$(hash_file "$workspace/control-disabled/SKILL.md")" = "$disabled_hash" ] && pass "disabled control unchanged" || fail "disabled control changed"
[ "$(status_count)" = "1" ] && pass "visible count dropped to 1 in the fixture catalog" || fail "visible count after deploy is $(status_count)"
run_ok "status --expect-hidden passes" "$OPS_DIR/scripts/status.sh" --expect-hidden

# Idempotent second deploy: a backup of an already-hidden tree.
before_second=()
for name in "${names[@]}"; do before_second+=("$(hash_file "$(target_file "$name")")"); done
reset_fake_state
run_ok "second deploy --yes is idempotent" "$OPS_DIR/scripts/deploy.sh" --yes
grep -q "planned inserts: 0" "$LAST_LOG" && pass "second plan inserts nothing" || fail "second plan inserted again"
grep -q "already hidden: 6" "$LAST_LOG" && pass "second plan sees six hidden" || fail "second plan did not see six hidden"
backup2="$(latest_backup)"
[ "$backup2" != "$backup1" ] && pass "second backup is distinct" || fail "second backup reused first"
i=0
for name in "${names[@]}"; do
  [ "$(hash_file "$(target_file "$name")")" = "${before_second[$i]}" ] && pass "$name: idempotent hash" || fail "$name: idempotent hash changed"
  i=$((i+1))
done
[ "$(status_count)" = "1" ] && pass "second deploy keeps visible count at 1" || fail "second deploy changed visible count"

# Rollback of the already-hidden backup restores hidden state, not baseline.
reset_fake_state
run_ok "rollback --yes restores second backup pre-state" "$OPS_DIR/scripts/rollback.sh" --yes --backup "$backup2"
for name in "${names[@]}"; do
  "$M20_NODE" "$OPS_DIR/scripts/apply-flag.mjs" --file "$(target_file "$name")" --name "$name" --check >/dev/null 2>&1 \
    && pass "$name: hidden state restored from second backup" || fail "$name: did not restore hidden state"
done
[ "$(status_count)" = "1" ] && pass "rollback of hidden backup stays at 1 visible" || fail "rollback of hidden backup changed count"

# Rollback of the first backup returns the original baseline.
reset_fake_state
run_ok "rollback --yes restores first backup" "$OPS_DIR/scripts/rollback.sh" --yes --backup "$backup1"
for name in "${names[@]}"; do
  file="$(target_file "$name")"
  [ "$(hash_file "$file")" = "${baseline_hash[$name]}" ] && pass "$name: baseline bytes restored" || fail "$name: baseline bytes not restored"
  "$M20_NODE" "$OPS_DIR/scripts/apply-flag.mjs" --file "$file" --name "$name" --check >/dev/null 2>&1 || fail "$name: restored file invalid"
done
[ "$(status_count)" = "7" ] && pass "visible count restored to 7" || fail "visible count after rollback is $(status_count)"

# A legacy copy redeployed over one target is detected by name, not silently ignored.
reset_fake_state
run_ok "third deploy for restore detection" "$OPS_DIR/scripts/deploy.sh" --yes
backup3="$(latest_backup)"
cp -p "$OPS_DIR/../collector-mail-notify-example/files/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md" "$(target_file collector-notify)"
run_fail "status --expect-hidden rejects a restored legacy copy" "$OPS_DIR/scripts/status.sh" --expect-hidden
grep -q "VISIBILITY-RESTORED by ops/collector-mail-notify-example" "$LAST_LOG" \
  && pass "status names the legacy package that restored visibility" \
  || fail "status did not name the legacy package"
run_fail "status report also exits nonzero on restore" "$OPS_DIR/scripts/status.sh"
cp -p "$backup3/targets/collector-notify.before.md" "$(target_file collector-notify)"
# Reapply the flag to the one target reset above; the other five are still hidden.
"$M20_NODE" "$OPS_DIR/scripts/apply-flag.mjs" --file "$(target_file collector-notify)" --name collector-notify --write >/dev/null
run_ok "status --expect-hidden passes after repair" "$OPS_DIR/scripts/status.sh" --expect-hidden

# Drift after deploy: default rollback refuses, --force restores.
reset_tree
run_ok "fourth deploy for drift test" "$OPS_DIR/scripts/deploy.sh" --yes
backup4="$(latest_backup)"
printf '\n# drift added after deploy\n' >>"$(target_file collector-mail-triage)"
run_fail "rollback refuses drifted target" "$OPS_DIR/scripts/rollback.sh" --yes --backup "$backup4"
grep -q "content changed after deploy" "$LAST_LOG" && pass "rollback names the drift refusal" || fail "rollback drift message missing"
grep -q "drift added after deploy" "$(target_file collector-mail-triage)" && pass "refused rollback wrote nothing" || fail "refused rollback overwrote the drifted file"
run_ok "rollback --force restores drifted target" "$OPS_DIR/scripts/rollback.sh" --yes --force --backup "$backup4"
for name in "${names[@]}"; do
  [ "$(hash_file "$(target_file "$name")")" = "${baseline_hash[$name]}" ] && pass "$name: force rollback restored baseline" || fail "$name: force rollback mismatch"
done

# Malformed frontmatter and a non-true flag are refused before any write.
reset_tree
printf '%s\n' '---' 'name: collector-notify' >"$(target_file collector-notify)"
run_fail "deploy refuses malformed frontmatter" "$OPS_DIR/scripts/deploy.sh" --yes
grep -q "invalid frontmatter" "$LAST_LOG" && pass "malformed frontmatter error is actionable" || fail "malformed frontmatter error missing"
reset_tree
"$M20_NODE" -e '
  const fs=require("node:fs");const file=process.argv[1];const text=fs.readFileSync(file,"utf8");
  fs.writeFileSync(file,text.replace("name: collector-health-repair\n","name: collector-health-repair\ndisable-model-invocation: false\n"));
' "$(target_file collector-health-repair)"
run_fail "deploy refuses disable-model-invocation: false" "$OPS_DIR/scripts/deploy.sh" --yes
grep -q "non-true value" "$LAST_LOG" && pass "non-true flag error is actionable" || fail "non-true flag error missing"
reset_tree

# Post-check failure restores every target.
reset_fake_state
M20_FAKE_INFO_HIDE_FAIL=collector-mail-triage run_fail "deploy restores on info contract failure" "$OPS_DIR/scripts/deploy.sh" --yes
for name in "${names[@]}"; do
  [ "$(hash_file "$(target_file "$name")")" = "${baseline_hash[$name]}" ] && pass "$name: info-failure rollback restored baseline" || fail "$name: info-failure left changed bytes"
done
[ "$(status_count)" = "7" ] && pass "info-failure rollback restores visible count 7" || fail "info-failure rollback count is $(status_count)"

# Unrelated catalog change after deploy restores every target.
reset_fake_state
M20_FAKE_LIST_FLIP_AFTER=control-visible run_fail "deploy restores on unrelated catalog change" "$OPS_DIR/scripts/deploy.sh" --yes
for name in "${names[@]}"; do
  [ "$(hash_file "$(target_file "$name")")" = "${baseline_hash[$name]}" ] && pass "$name: catalog-failure rollback restored baseline" || fail "$name: catalog-failure left changed bytes"
done

echo
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
