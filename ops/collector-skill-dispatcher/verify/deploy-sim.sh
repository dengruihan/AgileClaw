#!/usr/bin/env bash
# Offline simulator for deploy.sh / rollback.sh / status.sh.
#
# Runs the real scripts against a temp target tree and a fake openclaw CLI.
# It never reads or writes live cron state, the live workspace or the Gateway.
#
# Usage: ./verify/deploy-sim.sh
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE_FILE="$OPS_DIR/../collector-dingtalk-detail-triage/payload-message.txt"
PAYLOAD_FILE="$OPS_DIR/payload-message.txt"
SKILLS=(collector-dingtalk-triage collector-source-triage collector-health-repair collector-notify)

[ -f "$BASELINE_FILE" ] || {
  echo "ERROR: baseline payload missing: $BASELINE_FILE" >&2
  exit 1
}

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

export CDSD_TARGET_ROOT="$tmp/target"
export CDSD_BACKUP_BASE="$tmp/backups"
export CDSD_SKIP_DISCOVERY=1
export OPENCLAW_CLI="$OPS_DIR/verify/fake-openclaw.sh"
export FAKE_JOB_FILE="$tmp/job.json"
export FAKE_STATE_DIR="$tmp/fake-state"
mkdir -p "$CDSD_TARGET_ROOT/home/raymond/.openclaw/workspace/skills"
mkdir -p "$CDSD_TARGET_ROOT/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep"
printf '%s\n' '---' 'name: schedule-sweep' '---' 'stub' \
  >"$CDSD_TARGET_ROOT/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md"

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

write_job() {
  MESSAGE="$1" OUT="$FAKE_JOB_FILE" BASELINE="$BASELINE_FILE" node -e '
    const fs = require("node:fs");
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
        lightContext: true,
        toolsAllow: [
          "ls", "read", "edit", "write", "apply_patch", "exec", "process", "light_control", "agenda",
        ],
      },
      delivery: { mode: "none", channel: "last" },
      trigger: { script: "// fake trigger for the offline simulator\n" },
      state: { triggerEvalCount: 0, triggerState: { collectFails: 0, alerted: {} } },
    };
    fs.writeFileSync(process.env.OUT, JSON.stringify(job, null, 2) + "\n");
    void process.env.BASELINE;
  '
}

job_message() {
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).payload.message)' \
    "$FAKE_JOB_FILE"
}
job_sha() { sha_text "$(job_message)"; }

reset_all() {
  rm -rf "$CDSD_TARGET_ROOT/home/raymond/.openclaw/workspace/skills"
  mkdir -p "$CDSD_TARGET_ROOT/home/raymond/.openclaw/workspace/skills"
  rm -rf "$CDSD_BACKUP_BASE" "$FAKE_STATE_DIR"
  mkdir -p "$CDSD_BACKUP_BASE" "$FAKE_STATE_DIR"
  write_job "$(baseline_text)"
  unset FAKE_EDIT_FAIL FAKE_BAD_GET_AFTER_EDIT || true
}

skill_file() {
  printf '%s' "$CDSD_TARGET_ROOT/home/raymond/.openclaw/workspace/skills/$1/SKILL.md"
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
for name in "${SKILLS[@]}"; do
  assert_no_file "$(skill_file "$name")" "deploy dry run does not create $name"
done

# --- 3. apply ----------------------------------------------------------------
reset_all
cp "$FAKE_JOB_FILE" "$tmp/job.before-deploy.json"
run_script deploy.sh --yes
assert_eq "$code" "0" "deploy --yes exits 0"
assert_contains "$output" "verified: message and skills updated" "deploy verifies the apply"
assert_eq "$(job_sha)" "$(desired_sha)" "deploy writes the dispatcher payload"
for name in "${SKILLS[@]}"; do
  assert_file "$(skill_file "$name")" "deploy writes $name/SKILL.md"
  assert_eq "$(sha_file "$(skill_file "$name")")" \
    "$(sha_file "$OPS_DIR/files/home/raymond/.openclaw/workspace/skills/$name/SKILL.md")" \
    "deploy writes $name byte-for-byte"
done
projection() {
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    delete j.payload.message;
    process.stdout.write(JSON.stringify(j));
  ' "$1"
}
assert_eq "$(projection "$FAKE_JOB_FILE")" "$(projection "$tmp/job.before-deploy.json")" \
  "deploy leaves every untouched job field stable"

# --- 4. idempotent apply -----------------------------------------------------
run_script deploy.sh --yes
assert_eq "$code" "0" "second deploy exits 0"
assert_contains "$output" "already deployed" "second deploy reports nothing to do"

# --- 5. status deployed ------------------------------------------------------
run_script status.sh
assert_contains "$output" "state:            deployed" "status reports deployed"
assert_contains "$output" "lightContext:     true" "status shows lightContext unchanged"

# --- 6. drift refusal --------------------------------------------------------
reset_all
write_job "some other prompt"
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy refuses a drifted live message"
assert_contains "$output" "neither the baseline nor the desired prompt" "deploy explains the drift refusal"
assert_eq "$(job_sha)" "$(sha_text "some other prompt")" "drift refusal leaves the live message alone"

# --- 7. skill conflict refusal ----------------------------------------------
reset_all
mkdir -p "$(dirname "$(skill_file collector-notify)")"
printf '%s\n' "hand-written skill" >"$(skill_file collector-notify)"
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy refuses an existing differing skill"
assert_contains "$output" "already exists with different content" "deploy explains the skill conflict"
assert_eq "$(job_sha)" "$(baseline_sha)" "skill conflict refusal leaves the live message alone"
assert_eq "$(cat "$(skill_file collector-notify)")" "hand-written skill" "skill conflict leaves the file alone"

# --- 8. edit failure restores skill state -----------------------------------
reset_all
export FAKE_EDIT_FAIL=1
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy fails when cron edit fails"
assert_eq "$(job_sha)" "$(baseline_sha)" "edit failure leaves the live message alone"
for name in "${SKILLS[@]}"; do
  assert_no_file "$(skill_file "$name")" "edit failure removes created $name"
done
unset FAKE_EDIT_FAIL

# --- 9. failed verification restores message and skills ---------------------
reset_all
export FAKE_BAD_GET_AFTER_EDIT=1
run_script deploy.sh --yes
assert_eq "$code" "1" "deploy fails on a bad after-get"
assert_contains "$output" "post-deploy verification failed" "deploy reports the verification failure"
assert_eq "$(job_sha)" "$(baseline_sha)" "failed verification restores the live message"
for name in "${SKILLS[@]}"; do
  assert_no_file "$(skill_file "$name")" "failed verification removes created $name"
done
unset FAKE_BAD_GET_AFTER_EDIT

# --- 10. deploy then rollback -----------------------------------------------
reset_all
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
for name in "${SKILLS[@]}"; do
  assert_no_file "$(skill_file "$name")" "rollback removes $name"
done

# --- 11. rollback refuses a drifted message, --allow-drift overrides ---------
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
for name in "${SKILLS[@]}"; do
  assert_no_file "$(skill_file "$name")" "rollback --allow-drift removes $name"
done

# --- Report ------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
