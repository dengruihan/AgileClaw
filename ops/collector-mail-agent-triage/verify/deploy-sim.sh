#!/usr/bin/env bash
# Offline simulator for deploy.sh / rollback.sh / status.sh.
#
# Runs the real scripts against a temp target tree and a fake openclaw CLI.
# It never reads or writes live cron state, the live workspace or the Gateway.
#
# Usage: ./verify/deploy-sim.sh
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
M10_DIR="$OPS_DIR/../collector-skill-dispatcher"
BASELINE_FILE="$M10_DIR/payload-message.txt"
BASELINE_SOURCE_FILE="$M10_DIR/files/home/raymond/.openclaw/workspace/skills/collector-source-triage/SKILL.md"
NOTIFY_SENTINEL_FILE="$M10_DIR/files/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md"
PAYLOAD_FILE="$OPS_DIR/payload-message.txt"
SKILLS=(collector-mail-triage collector-source-triage)

for file in "$BASELINE_FILE" "$BASELINE_SOURCE_FILE" "$NOTIFY_SENTINEL_FILE"; do
  [ -f "$file" ] || {
    echo "ERROR: M10 reference file missing: $file" >&2
    exit 1
  }
done

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

export CDMT_TARGET_ROOT="$tmp/target"
export CDMT_BACKUP_BASE="$tmp/backups"
export CDMT_SKIP_DISCOVERY=1
export OPENCLAW_CLI="$OPS_DIR/verify/fake-openclaw.sh"
export FAKE_JOB_FILE="$tmp/job.json"
export FAKE_STATE_DIR="$tmp/fake-state"
mkdir -p "$CDMT_TARGET_ROOT/home/raymond/.openclaw/workspace/skills"
mkdir -p "$CDMT_TARGET_ROOT/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep"
printf '%s\n' '---' 'name: schedule-sweep' '---' 'stub' \
  >"$CDMT_TARGET_ROOT/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md"

passed=0
failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
assert_eq() {
  if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi
}
assert_contains() {
  case "$1" in *"$2"*) pass "$3" ;; *) fail "$3 (missing '$2')" ;; esac
}
assert_file() {
  if [ -f "$1" ]; then pass "$2"; else fail "$2 (missing $1)"; fi
}
assert_no_file() {
  if [ -f "$1" ]; then fail "$2 (unexpected $1)"; else pass "$2"; fi
}

sha_text() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
sha_file() { sha256sum "$1" | cut -d' ' -f1; }

baseline_text() { cat "$BASELINE_FILE"; }
desired_text() { cat "$PAYLOAD_FILE"; }
desired_sha() { sha_text "$(desired_text)"; }
baseline_sha() { sha_text "$(baseline_text)"; }

# write_job <message> [tools_json] [light_context]
# The defaults mirror the live M10 job; the optional arguments let the test
# simulate M11 changing toolsAllow/lightContext before this package deploys.
write_job() {
  MESSAGE="$1" TOOLS="${2:-}" LIGHT="${3:-}" OUT="$FAKE_JOB_FILE" node -e '
    const fs = require("node:fs");
    const tools = process.env.TOOLS
      ? JSON.parse(process.env.TOOLS)
      : ["ls", "read", "edit", "write", "apply_patch", "exec", "process", "light_control", "agenda"];
    const job = {
      id: "6a45be21-ce0b-4b8b-8986-4c885d1ea659",
      name: "collector",
      displayName: "统一事项收集",
      description:
        "来源收集看门狗+事项分诊：每10分钟跑 collection/collect.mjs；有事项delta唤醒Agent分诊（无需行动静默结束）；源连续故障>=2或收集器连续异常唤醒修障",
      enabled: true,
      createdAtMs: 1793596151999,
      schedule: { kind: "every", everyMs: 600000, anchorMs: 1793596151999 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: process.env.MESSAGE,
        timeoutSeconds: 600,
        lightContext: process.env.LIGHT ? process.env.LIGHT === "true" : true,
        toolsAllow: tools,
      },
      delivery: { mode: "none", channel: "last" },
      trigger: { script: "// fake trigger for the offline simulator\n" },
      state: { triggerEvalCount: 0, triggerState: { collectFails: 0, alerted: {} } },
    };
    fs.writeFileSync(process.env.OUT, JSON.stringify(job, null, 2) + "\n");
  '
}

job_message() {
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).payload.message)' \
    "$FAKE_JOB_FILE"
}
job_sha() { sha_text "$(job_message)"; }

reset_all() {
  rm -rf "$CDMT_TARGET_ROOT/home/raymond/.openclaw/workspace/skills"
  mkdir -p "$CDMT_TARGET_ROOT/home/raymond/.openclaw/workspace/skills/collector-source-triage" \
    "$CDMT_TARGET_ROOT/home/raymond/.openclaw/workspace/skills/collector-notify"
  cp "$BASELINE_SOURCE_FILE" "$(skill_file collector-source-triage)"
  cp "$NOTIFY_SENTINEL_FILE" "$(skill_file collector-notify)"
  rm -rf "$CDMT_BACKUP_BASE" "$FAKE_STATE_DIR"
  mkdir -p "$CDMT_BACKUP_BASE" "$FAKE_STATE_DIR"
  write_job "$(baseline_text)"
  unset FAKE_EDIT_FAIL FAKE_BAD_GET_AFTER_EDIT || true
}

skill_file() {
  printf '%s' "$CDMT_TARGET_ROOT/home/raymond/.openclaw/workspace/skills/$1/SKILL.md"
}

run_script() {
  # run_script <script> [args...]; captures stdout+stderr and the exit status.
  local script="$1"
  shift
  set +e
  output="$("$OPS_DIR/scripts/$script" "$@" 2>&1)"
  code=$?
  set -e
}

projection() {
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    delete j.payload.message;
    process.stdout.write(JSON.stringify(j));
  ' "$1"
}

notify_sha() { sha_file "$(skill_file collector-notify)"; }

# --- 1. not deployed ---------------------------------------------------------
reset_all
run_script status.sh
assert_eq "$code" "0" "status exits 0 before deployment"
assert_contains "$output" "state:            not deployed" "status reports not deployed"
assert_contains "$output" "discovered/modelVisible=skipped" "status skips discovery in the simulator"

# --- 2. dry run --------------------------------------------------------------
reset_all
run_script deploy.sh
assert_eq "$code" "0" "deploy dry run exits 0"
assert_contains "$output" "plan only" "deploy dry run prints the plan"
assert_eq "$(job_sha)" "$(baseline_sha)" "deploy dry run leaves payload.message alone"
assert_no_file "$(skill_file collector-mail-triage)" "deploy dry run does not create the mail skill"
assert_eq "$(sha_file "$(skill_file collector-source-triage)")" "$(sha_file "$BASELINE_SOURCE_FILE")" \
  "deploy dry run leaves source-triage alone"

# --- 3. apply ----------------------------------------------------------------
reset_all
cp "$FAKE_JOB_FILE" "$tmp/job.before-deploy.json"
notify_before="$(notify_sha)"
run_script deploy.sh --yes
assert_eq "$code" "0" "deploy --yes exits 0"
assert_contains "$output" "verified: message and mail skills updated" "deploy verifies the apply"
assert_contains "$output" "collector-notify and schedule-sweep were not written" "deploy names untouched skills"
assert_eq "$(job_sha)" "$(desired_sha)" "deploy writes the mail-routed dispatcher payload"
for name in "${SKILLS[@]}"; do
  assert_file "$(skill_file "$name")" "deploy writes $name/SKILL.md"
  assert_eq "$(sha_file "$(skill_file "$name")")" \
    "$(sha_file "$OPS_DIR/files/home/raymond/.openclaw/workspace/skills/$name/SKILL.md")" \
    "deploy writes $name byte-for-byte"
done
assert_eq "$(projection "$FAKE_JOB_FILE")" "$(projection "$tmp/job.before-deploy.json")" \
  "deploy leaves every untouched job field stable"
assert_eq "$(notify_sha)" "$notify_before" "deploy leaves collector-notify untouched"

# --- 4. idempotent apply -----------------------------------------------------
run_script deploy.sh --yes
assert_eq "$code" "0" "second deploy exits 0"
assert_contains "$output" "already deployed" "second deploy reports nothing to do"

# --- 5. status deployed ------------------------------------------------------
run_script status.sh
assert_contains "$output" "state:            deployed" "status reports deployed"
assert_contains "$output" "lightContext:     true" "status shows lightContext unchanged"
assert_contains "$output" "skill collector-mail-triage      deployed" "status shows the mail skill deployed"

# --- 6. M11 parallel change: toolsAllow/lightContext preserved --------------
reset_all
# Simulate M11 landing first: light_control removed, lightContext dropped.
write_job "$(baseline_text)" '["ls","read","edit","write","apply_patch","exec","process","agenda"]' "false"
cp "$FAKE_JOB_FILE" "$tmp/job.m11.json"
run_script deploy.sh --yes
assert_eq "$code" "0" "deploy succeeds after an M11-style toolsAllow change"
assert_eq "$(job_sha)" "$(desired_sha)" "deploy still updates payload.message"
assert_eq "$(projection "$FAKE_JOB_FILE")" "$(projection "$tmp/job.m11.json")" \
  "deploy preserves M11 toolsAllow/lightContext changes byte-for-byte"
assert_contains "$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).payload.toolsAllow))' "$FAKE_JOB_FILE")" \
  '"agenda"' "M11 toolsAllow survives"
assert_contains "$output" 'toolsAllow: ["ls","read","edit","write","apply_patch","exec","process","agenda"] (left untouched)' \
  "deploy reports the live toolsAllow as untouched"

# --- 7. drift refusal --------------------------------------------------------
reset_all
write_job "some other prompt"
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy refuses a drifted live message"
assert_contains "$output" "neither the M10 dispatcher baseline nor the desired prompt" \
  "deploy explains the drift refusal"
assert_eq "$(job_sha)" "$(sha_text "some other prompt")" "drift refusal leaves the live message alone"

# --- 8. skill conflict refusal ----------------------------------------------
reset_all
printf '%s\n' "hand-written source skill" >"$(skill_file collector-source-triage)"
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy refuses a differing source-triage skill"
assert_contains "$output" "neither the recorded baseline nor this package" \
  "deploy explains the skill conflict"
assert_eq "$(job_sha)" "$(baseline_sha)" "skill conflict refusal leaves the live message alone"
assert_eq "$(cat "$(skill_file collector-source-triage)")" "hand-written source skill" \
  "skill conflict leaves the file alone"

reset_all
mkdir -p "$(dirname "$(skill_file collector-mail-triage)")"
printf '%s\n' "hand-written mail skill" >"$(skill_file collector-mail-triage)"
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy refuses an existing differing mail skill"
assert_eq "$(cat "$(skill_file collector-mail-triage)")" "hand-written mail skill" \
  "mail skill conflict leaves the file alone"

# --- 9. edit failure restores skill state -----------------------------------
reset_all
export FAKE_EDIT_FAIL=1
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy fails when cron edit fails"
assert_eq "$(job_sha)" "$(baseline_sha)" "edit failure leaves the live message alone"
assert_no_file "$(skill_file collector-mail-triage)" "edit failure removes the created mail skill"
assert_eq "$(sha_file "$(skill_file collector-source-triage)")" "$(sha_file "$BASELINE_SOURCE_FILE")" \
  "edit failure restores source-triage"
unset FAKE_EDIT_FAIL

# --- 10. failed verification restores message and skills --------------------
reset_all
export FAKE_BAD_GET_AFTER_EDIT=1
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy fails on a bad after-get"
assert_contains "$output" "post-deploy verification failed" "deploy reports the verification failure"
assert_eq "$(job_sha)" "$(baseline_sha)" "failed verification restores the live message"
assert_no_file "$(skill_file collector-mail-triage)" "failed verification removes the created mail skill"
assert_eq "$(sha_file "$(skill_file collector-source-triage)")" "$(sha_file "$BASELINE_SOURCE_FILE")" \
  "failed verification restores source-triage"
unset FAKE_BAD_GET_AFTER_EDIT

# --- 11. deploy then rollback ----------------------------------------------
reset_all
notify_before="$(notify_sha)"
run_script deploy.sh --yes
assert_eq "$code" "0" "deploy before rollback exits 0"
run_script rollback.sh
assert_eq "$code" "0" "rollback dry run exits 0"
assert_contains "$output" "plan only" "rollback dry run prints the plan"
assert_eq "$(job_sha)" "$(desired_sha)" "rollback dry run leaves the deployed message"
run_script rollback.sh --yes
assert_eq "$code" "0" "rollback --yes exits 0"
assert_contains "$output" "verified: payload.message and skill files restored" "rollback verifies"
assert_eq "$(job_sha)" "$(baseline_sha)" "rollback restores the baseline message"
assert_no_file "$(skill_file collector-mail-triage)" "rollback removes the mail skill"
assert_eq "$(sha_file "$(skill_file collector-source-triage)")" "$(sha_file "$BASELINE_SOURCE_FILE")" \
  "rollback restores the pre-deploy source-triage"
assert_eq "$(notify_sha)" "$notify_before" "rollback leaves collector-notify untouched"

# --- 12. rollback refuses a drifted message, --allow-drift overrides --------
reset_all
run_script deploy.sh --yes
assert_eq "$code" "0" "deploy for drift rollback exits 0"
write_job "drifted after deploy"
run_script rollback.sh --yes
assert_eq "$code" "1" "rollback refuses a drifted message"
assert_contains "$output" "differs from what this deployment installed" "rollback explains the refusal"
assert_eq "$(job_sha)" "$(sha_text "drifted after deploy")" "refused rollback leaves the message"
run_script rollback.sh --yes --allow-drift
assert_eq "$code" "0" "rollback --allow-drift exits 0"
assert_eq "$(job_sha)" "$(baseline_sha)" "rollback --allow-drift restores the baseline"
assert_no_file "$(skill_file collector-mail-triage)" "rollback --allow-drift removes the mail skill"

# --- 13. rollback with an M11 field change after deploy ---------------------
reset_all
run_script deploy.sh --yes
assert_eq "$code" "0" "deploy before M11 drift rollback exits 0"
write_job "$(desired_text)" '["ls","read","edit","write","apply_patch","exec","process","agenda"]' "false"
cp "$FAKE_JOB_FILE" "$tmp/job.after-m11.json"
run_script rollback.sh --yes
assert_eq "$code" "0" "rollback succeeds after an M11 field change"
assert_eq "$(job_sha)" "$(baseline_sha)" "rollback restores the message"
assert_eq "$(projection "$FAKE_JOB_FILE")" "$(projection "$tmp/job.after-m11.json")" \
  "rollback preserves the M11 field change"

# --- Report ------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
