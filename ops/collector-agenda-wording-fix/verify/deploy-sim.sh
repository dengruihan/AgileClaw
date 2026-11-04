#!/usr/bin/env bash
# Offline end-to-end simulation for the M15 collector Agenda-wording fix.
#
# Runs the real scripts against a temporary root, temporary backups and a fake
# openclaw CLI. It never reads or writes live cron state, the live workspace or
# the Gateway, and it sends no message.
#
# Usage: ./verify/deploy-sim.sh
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$OPS_DIR/manifest.json"
BASELINE_NOTIFY="$OPS_DIR/baselines/collector-notify.pre-m15.md"
BASELINE_SOURCE="$OPS_DIR/baselines/collector-source-triage.pre-m15.md"
BASELINE_PAYLOAD="$OPS_DIR/baselines/payload-message.pre-m15.txt"
PACKAGE_NOTIFY="$OPS_DIR/files/home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md"

for file in "$MANIFEST" "$BASELINE_NOTIFY" "$BASELINE_SOURCE" "$BASELINE_PAYLOAD" "$PACKAGE_NOTIFY"; do
  [ -f "$file" ] || {
    echo "ERROR: package file missing: $file" >&2
    exit 1
  }
done

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

export CAWF_TARGET_ROOT="$tmp/target"
export CAWF_BACKUP_BASE="$tmp/backups"
export CAWF_SKIP_DISCOVERY=1
export OPENCLAW_CLI="$OPS_DIR/verify/fake-openclaw.sh"
export FAKE_JOB_FILE="$tmp/job.json"
export FAKE_STATE_DIR="$tmp/fake-state"

ROOT_DIR="$CAWF_TARGET_ROOT/home/raymond/.openclaw"
SKILLS_DIR="$ROOT_DIR/workspace/skills"
AGENTS_FILE="$ROOT_DIR/workspace/AGENTS.md"
MJS_FILE="$ROOT_DIR/workspace/collection/dingtalk-notify.mjs"
OTHER_SKILL="$SKILLS_DIR/collector-dingtalk-triage/SKILL.md"
CONFIG="$ROOT_DIR/openclaw.json"

passed=0
failed=0
pass() { passed=$((passed + 1)); }
fail() {
  failed=$((failed + 1))
  printf 'FAIL %s\n' "$1" >&2
}
assert_eq() {
  if [ "$1" = "$2" ]; then pass; else fail "$3 (got '$1', want '$2')"; fi
}
assert_contains() {
  case "$1" in *"$2"*) pass ;; *) fail "$3 (missing '$2')" ;; esac
}
assert_not_contains() {
  case "$1" in *"$2"*) fail "$3 (unexpected '$2')" ;; *) pass ;; esac
}
sha_file() { sha256sum "$1" | cut -d' ' -f1; }
sha_text() { printf '%s' "$1" | sha256sum | cut -d' ' -f1; }
backup_count() {
  ls -1d "$CAWF_BACKUP_BASE"/*/ 2>/dev/null | wc -l | tr -d ' '
}
latest_backup() {
  ls -1dt "$CAWF_BACKUP_BASE"/*/ 2>/dev/null | head -1 | sed 's:/$::'
}
job_message() {
  node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).payload.message)' \
    "$FAKE_JOB_FILE"
}
job_sha() { sha_text "$(job_message)"; }
projection() {
  node -e '
    const j = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    delete j.payload.message;
    delete j.state;
    process.stdout.write(JSON.stringify(j));
  ' "$FAKE_JOB_FILE"
}
run_script() {
  local script="$1"
  shift
  set +e
  output="$("$OPS_DIR/scripts/$script" "$@" 2>&1)"
  code=$?
  set -e
}

dummy_agents() {
  node -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = m.patches.find((p) => p.path.endsWith("AGENTS.md"));
    const body = ["# synthetic workspace AGENTS.md", "", "## 前文", "", "无关内容保持原样。", "", ...entry.replacements.map((r) => r.old), "", "## 后文", "继续保留。", ""].join("\n");
    fs.writeFileSync(process.argv[2], body);
  ' "$MANIFEST" "$AGENTS_FILE"
}

dummy_mjs() {
  node -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = m.patches.find((p) => p.path.endsWith("dingtalk-notify.mjs"));
    const body = ["#!/usr/bin/env node", ...entry.replacements.map((r) => r.old), "console.log(\"synthetic\");", ""].join("\n");
    fs.writeFileSync(process.argv[2], body);
  ' "$MANIFEST" "$MJS_FILE"
}

write_job() {
  MESSAGE="$1" OUT="$FAKE_JOB_FILE" node -e '
    const fs = require("node:fs");
    const job = {
      id: "6a45be21-ce0b-4b8b-8986-4c885d1ea659",
      name: "collector",
      displayName: "统一事项收集",
      description: "来源收集看门狗+事项分诊：每10分钟跑 collection/collect.mjs；有事项delta唤醒Agent分诊",
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
        toolsAllow: ["ls", "read", "edit", "write", "apply_patch", "exec", "process", "agenda"],
      },
      delivery: { mode: "none", channel: "last" },
      trigger: { script: "// fake trigger for the offline simulator\n" },
      state: { triggerEvalCount: 7, triggerState: { collectFails: 0, alerted: {} } },
    };
    fs.writeFileSync(process.env.OUT, JSON.stringify(job, null, 2) + "\n");
  '
}

reset_all() {
  rm -rf "$CAWF_TARGET_ROOT" "$CAWF_BACKUP_BASE" "$FAKE_STATE_DIR"
  mkdir -p "$SKILLS_DIR/collector-notify" "$SKILLS_DIR/collector-source-triage" \
    "$SKILLS_DIR/collector-dingtalk-triage" "$(dirname "$MJS_FILE")" "$CAWF_BACKUP_BASE" "$FAKE_STATE_DIR"
  cp "$BASELINE_NOTIFY" "$SKILLS_DIR/collector-notify/SKILL.md"
  cp "$BASELINE_SOURCE" "$SKILLS_DIR/collector-source-triage/SKILL.md"
  printf 'another skill stays untouched\n' >"$OTHER_SKILL"
  printf '{"tools":{"allow":[]}}\n' >"$CONFIG"
  dummy_agents
  dummy_mjs
  write_job "$(cat "$BASELINE_PAYLOAD")"
  unset FAKE_EDIT_FAIL FAKE_BAD_GET_AFTER_EDIT || true
}

baseline_payload_sha() { sha_text "$(cat "$BASELINE_PAYLOAD")"; }
desired_payload_sha() { sha_text "$(cat "$OPS_DIR/payload-message.txt")"; }

# --- 1. Baseline status and projected plan ---------------------------------
reset_all
before_projection="$(projection)"
agents_before="$(sha_file "$AGENTS_FILE")"
mjs_before="$(sha_file "$MJS_FILE")"
other_before="$(sha_file "$OTHER_SKILL")"
config_before="$(sha_file "$CONFIG")"

run_script status.sh
assert_eq "$code" 0 "status succeeds on the baseline"
assert_contains "$output" "cron payload.message: baseline" "status detects the baseline message"
assert_contains "$output" "skill collector-notify: baseline" "status detects the baseline notify skill"
assert_contains "$output" "skill collector-source-triage: baseline" "status detects the baseline source skill"
assert_contains "$output" "AGENTS.md: baseline" "status detects the AGENTS patch baseline"
assert_contains "$output" "dingtalk-notify.mjs: baseline" "status detects the comment patch baseline"

run_script deploy.sh
assert_eq "$code" 0 "deploy plan succeeds"
assert_contains "$output" "plan only" "deploy default is plan-only"
assert_eq "$(job_sha)" "$(baseline_payload_sha)" "plan leaves the message untouched"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$BASELINE_NOTIFY")" "plan leaves the skill untouched"
assert_eq "$(backup_count)" 0 "plan writes no backup"

# --- 2. Apply ---------------------------------------------------------------
run_script deploy.sh --yes
assert_eq "$code" 0 "deploy --yes succeeds"
assert_contains "$output" "verified" "deploy verifies after writing"
assert_eq "$(job_sha)" "$(desired_payload_sha)" "deploy writes the desired message"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$PACKAGE_NOTIFY")" "deploy writes the notify package copy"
assert_eq "$(sha_file "$SKILLS_DIR/collector-source-triage/SKILL.md")" \
  "$(node -e 'const m=require(process.argv[1]);const p=m.files.find(f=>f.path.includes("source-triage"));process.stdout.write(p.deployedSha256)' "$MANIFEST")" \
  "deploy writes the source package copy"
assert_contains "$(cat "$AGENTS_FILE")" "Agenda 是行动主清单，日程是执行安排" "AGENTS patch applied"
assert_contains "$(cat "$AGENTS_FILE")" "无关内容保持原样" "AGENTS unrelated text preserved"
assert_contains "$(cat "$MJS_FILE")" "agenda 事项查重" "notify comment patched"
assert_not_contains "$(cat "$MJS_FILE")" "便单/日程" "stale comment removed"
assert_eq "$(sha_file "$OTHER_SKILL")" "$other_before" "another skill untouched"
assert_eq "$(sha_file "$CONFIG")" "$config_before" "openclaw.json untouched"
assert_eq "$(projection)" "$before_projection" "untouched job fields unchanged"
assert_eq "$(backup_count)" 1 "deploy writes one backup"

backup1="$(latest_backup)"
assert_eq "$(sha_file "$backup1/files/collector-notify/SKILL.md.before")" "$(sha_file "$BASELINE_NOTIFY")" "backup holds the notify baseline"
assert_eq "$(sha_file "$backup1/files/collector-source-triage/SKILL.md.before")" "$(sha_file "$BASELINE_SOURCE")" "backup holds the source baseline"
assert_eq "$(sha_file "$backup1/patches/home_raymond_.openclaw_workspace_AGENTS.md.before")" "$agents_before" "backup holds the AGENTS baseline"
assert_eq "$(sha_file "$backup1/patches/home_raymond_.openclaw_workspace_collection_dingtalk-notify.mjs.before")" "$mjs_before" "backup holds the mjs baseline"
assert_eq "$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.before.messageSha256)' "$backup1/deploy.json")" \
  "$(baseline_payload_sha)" "backup records the before message hash"
assert_eq "$(node -e 'const d=require(process.argv[1]);process.stdout.write(d.desired.messageSha256)' "$backup1/deploy.json")" \
  "$(desired_payload_sha)" "backup records the desired message hash"

# --- 3. Idempotency ---------------------------------------------------------
run_script deploy.sh --yes
assert_eq "$code" 0 "second deploy succeeds"
assert_contains "$output" "already deployed on all five surfaces" "second deploy is a no-op"
assert_eq "$(backup_count)" 1 "second deploy writes no extra backup"

# --- 4. Drift is refused ----------------------------------------------------
printf '\n<!-- manual tweak -->\n' >>"$SKILLS_DIR/collector-notify/SKILL.md"
run_script deploy.sh --yes
assert_eq "$code" 1 "deploy refuses skill drift"
assert_contains "$output" "differs from both the baseline and the package" "drift message names the conflict"
assert_eq "$(backup_count)" 1 "drift refusal writes no backup"

reset_all
node -e '
  const fs = require("node:fs");
  fs.writeFileSync(process.argv[1], fs.readFileSync(process.argv[1], "utf8").replace("便单是行动主清单", "便单是别的措辞"));
' "$AGENTS_FILE"
run_script deploy.sh --yes
assert_eq "$code" 1 "deploy refuses anchor drift"
assert_contains "$output" "anchored patch drift" "anchor drift message"
assert_eq "$(job_sha)" "$(baseline_payload_sha)" "anchor drift leaves the message untouched"

# --- 5. Unreviewed package change is refused before any write --------------
reset_all
cp "$PACKAGE_NOTIFY" "$tmp/package-notify.keep"
printf '\n<!-- unreviewed append -->\n' >>"$PACKAGE_NOTIFY"
run_script deploy.sh --yes
assert_eq "$code" 1 "deploy refuses an unreviewed package change"
assert_contains "$output" "does not match the reviewed manifest hash" "package lock message"
assert_eq "$(backup_count)" 0 "unreviewed package writes no backup"
assert_eq "$(job_sha)" "$(baseline_payload_sha)" "unreviewed package leaves the message untouched"
cp "$tmp/package-notify.keep" "$PACKAGE_NOTIFY"
run_script status.sh
assert_eq "$code" 0 "status recovers after restoring the package file"

# --- 6. Rollback ------------------------------------------------------------
reset_all
run_script deploy.sh --yes
assert_eq "$code" 0 "deploy before rollback"
run_script rollback.sh
assert_eq "$code" 0 "rollback plan succeeds"
assert_contains "$output" "plan only" "rollback default is plan-only"
run_script rollback.sh --yes
assert_eq "$code" 0 "rollback --yes succeeds"
assert_eq "$(job_sha)" "$(baseline_payload_sha)" "rollback restores the message"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$BASELINE_NOTIFY")" "rollback restores the notify skill"
assert_eq "$(sha_file "$SKILLS_DIR/collector-source-triage/SKILL.md")" "$(sha_file "$BASELINE_SOURCE")" "rollback restores the source skill"
assert_eq "$(sha_file "$AGENTS_FILE")" "$agents_before" "rollback restores AGENTS.md byte-for-byte"
assert_eq "$(sha_file "$MJS_FILE")" "$mjs_before" "rollback restores the mjs byte-for-byte"
assert_eq "$(projection)" "$before_projection" "rollback leaves untouched fields unchanged"
run_script rollback.sh --yes
assert_contains "$output" "already rolled back" "second rollback is a no-op"

# --- 7. Rollback refuses post-deploy drift unless forced -------------------
reset_all
run_script deploy.sh --yes
printf '\n<!-- manual tweak -->\n' >>"$SKILLS_DIR/collector-notify/SKILL.md"
run_script rollback.sh --yes
assert_eq "$code" 1 "rollback refuses drift"
assert_contains "$output" "changed after deployment" "rollback drift message"
run_script rollback.sh --yes --force
assert_eq "$code" 0 "rollback --force succeeds"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$BASELINE_NOTIFY")" "forced rollback restores the skill"

# --- 8. A skill missing before deploy is deleted by rollback ---------------
reset_all
rm -rf "$SKILLS_DIR/collector-notify"
run_script deploy.sh --yes
assert_eq "$code" 0 "deploy creates a skill missing before deploy"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$PACKAGE_NOTIFY")" "created skill matches the package"
backup_created="$(latest_backup)"
assert_eq "$(node -e 'const d=require(process.argv[1]);process.stdout.write(String(d.skillState["collector-notify"].existed))' "$backup_created/deploy.json")" \
  "false" "backup records that the skill did not exist"
assert_eq "$(node -e 'const d=require(process.argv[1]);process.stdout.write(String(d.skillState["collector-notify"].dirExisted))' "$backup_created/deploy.json")" \
  "false" "backup records that the skill directory did not exist"
run_script rollback.sh
assert_eq "$code" 0 "rollback plan for a created skill succeeds"
assert_contains "$output" "collector-notify: delete (created at deploy)" "rollback plan declares the delete"
run_script rollback.sh --yes
assert_eq "$code" 0 "rollback deletes the created skill"
assert_eq "$(if [ -e "$SKILLS_DIR/collector-notify/SKILL.md" ]; then echo present; else echo absent; fi)" \
  "absent" "created skill file is gone after rollback"
assert_eq "$(if [ -d "$SKILLS_DIR/collector-notify" ]; then echo present; else echo absent; fi)" \
  "absent" "created skill directory is gone after rollback"
assert_eq "$(sha_file "$SKILLS_DIR/collector-source-triage/SKILL.md")" "$(sha_file "$BASELINE_SOURCE")" "existing skill is restored"
assert_eq "$(sha_file "$AGENTS_FILE")" "$agents_before" "AGENTS.md is restored"
assert_eq "$(sha_file "$MJS_FILE")" "$mjs_before" "notify script is restored"
assert_eq "$(job_sha)" "$(baseline_payload_sha)" "message is restored"
run_script rollback.sh --yes
assert_contains "$output" "already rolled back (absent before and now)" "second rollback keeps the created file absent"

reset_all
rm -rf "$SKILLS_DIR/collector-notify"
run_script deploy.sh --yes
printf '\n<!-- drift on the created file -->\n' >>"$SKILLS_DIR/collector-notify/SKILL.md"
run_script rollback.sh --yes
assert_eq "$code" 1 "rollback refuses to delete a drifted created skill"
assert_contains "$output" "changed after deployment" "drifted delete requires --force"
assert_eq "$(if [ -f "$SKILLS_DIR/collector-notify/SKILL.md" ]; then echo present; else echo absent; fi)" \
  "present" "drifted created skill is kept without --force"
run_script rollback.sh --yes --force
assert_eq "$code" 0 "rollback --force deletes the drifted created skill"
assert_eq "$(if [ -e "$SKILLS_DIR/collector-notify/SKILL.md" ]; then echo present; else echo absent; fi)" \
  "absent" "forced rollback removes the created file"

# --- 9. Failed apply restores every surface --------------------------------
reset_all
export FAKE_EDIT_FAIL=1
run_script deploy.sh --yes
unset FAKE_EDIT_FAIL
assert_eq "$code" 1 "cron edit failure fails the deploy"
assert_contains "$output" "restoring the previous five surfaces" "failure path restores"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$BASELINE_NOTIFY")" "failure restores the notify skill"
assert_eq "$(sha_file "$AGENTS_FILE")" "$agents_before" "failure restores AGENTS.md"
assert_eq "$(sha_file "$MJS_FILE")" "$mjs_before" "failure restores the mjs"

reset_all
export FAKE_BAD_GET_AFTER_EDIT=1
run_script deploy.sh --yes
unset FAKE_BAD_GET_AFTER_EDIT
assert_eq "$code" 1 "unreadable after-get fails the deploy"
assert_contains "$output" "post-deploy verification failed" "verification failure message"
assert_contains "$output" "restoring the previous five surfaces" "verification failure restores"
assert_eq "$(sha_file "$SKILLS_DIR/collector-notify/SKILL.md")" "$(sha_file "$BASELINE_NOTIFY")" "verification failure restores the notify skill"
assert_eq "$(sha_file "$AGENTS_FILE")" "$agents_before" "verification failure restores AGENTS.md"
assert_eq "$(job_sha)" "$(baseline_payload_sha)" "verification failure restores the message"

# --- 10. Missing patch target is refused -----------------------------------
reset_all
rm -f "$AGENTS_FILE"
run_script deploy.sh --yes
assert_eq "$code" 1 "missing patch target is refused"
assert_contains "$output" "patch target missing" "missing target message"
assert_eq "$(backup_count)" 0 "missing target writes no backup"

printf 'PASS %s checks\n' "$passed"
if [ "$failed" -gt 0 ]; then
  printf 'FAIL %s checks\n' "$failed" >&2
  exit 1
fi
