#!/usr/bin/env bash
# Offline simulation of deploy/status/rollback using verify/fake-openclaw.sh.
# Proves the guards and the auto-restore path without touching the live job.
#
# Usage: verify/deploy-sim.sh
set -uo pipefail

ops="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export OPENCLAW_CLI="$ops/verify/fake-openclaw.sh"
export OPENCLAW_ROOT="$tmp"
export FAKE_STATE="$tmp/job.json"
export CDT_BACKUP_BASE="$tmp/backups"

passed=0
failures=0
check() { # check <label> <condition-exit-code>
  local label="$1" code="$2"
  if [ "$code" -eq 0 ]; then
    passed=$((passed + 1))
    echo "PASS $label"
  else
    failures=$((failures + 1))
    echo "FAIL $label"
  fi
}

fixture() {
  rm -rf "$tmp/backups"
  rm -f "$FAKE_STATE.nextget"
  cat >"$FAKE_STATE" <<'EOF'
{
  "id": "6a45be21-ce0b-4b8b-8986-4c885d1ea659",
  "name": "collector",
  "enabled": true,
  "description": "fixture description",
  "sessionTarget": "isolated",
  "schedule": { "kind": "every", "everyMs": 600000, "anchorMs": 1 },
  "payload": {
    "kind": "agentTurn",
    "message": "BASELINE PROMPT FIXTURE",
    "timeoutSeconds": 600,
    "lightContext": true,
    "toolsAllow": ["ls", "read", "exec"]
  },
  "trigger": { "script": "return { fire: false };" }
}
EOF
}

message_is() { # message_is <expected>
  FAKE_STATE="$FAKE_STATE" EXPECTED="$1" node -e '
    const fs = require("node:fs");
    const job = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
    process.exit(job.payload.message === process.env.EXPECTED ? 0 : 1);
  '
}

fields_unchanged() {
  FAKE_STATE="$FAKE_STATE" node -e '
    const fs = require("node:fs");
    const job = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
    const ok =
      job.trigger.script === "return { fire: false };" &&
      job.description === "fixture description" &&
      job.schedule.kind === "every" &&
      job.schedule.everyMs === 600000 &&
      job.payload.timeoutSeconds === 600 &&
      job.payload.lightContext === true &&
      JSON.stringify(job.payload.toolsAllow) === JSON.stringify(["ls", "read", "exec"]) &&
      job.sessionTarget === "isolated" &&
      job.enabled === true;
    process.exit(ok ? 0 : 1);
  '
}

desired="$(cat "$ops/payload-message.txt")"

fixture
if "$ops/scripts/deploy.sh" --allow-drift >/dev/null 2>&1; then code=0; else code=$?; fi
check "dry run exits 0" "$([ "$code" -eq 0 ] && echo 0 || echo 1)"
message_is "BASELINE PROMPT FIXTURE"; check "dry run leaves the message alone" "$?"

fixture
if "$ops/scripts/deploy.sh" --yes >/dev/null 2>&1; then code=0; else code=$?; fi
check "drift guard refuses without --allow-drift" "$([ "$code" -ne 0 ] && echo 0 || echo 1)"
message_is "BASELINE PROMPT FIXTURE"; check "refused deploy leaves the message alone" "$?"

fixture
if "$ops/scripts/deploy.sh" --yes --allow-drift >"$tmp/deploy.log" 2>&1; then code=0; else code=$?; fi
check "deploy applies with --allow-drift" "$([ "$code" -eq 0 ] && echo 0 || echo 1)"
message_is "$desired"; check "deployed message equals payload-message.txt" "$?"
fields_unchanged; check "trigger/schedule/tools/session/description unchanged" "$?"
[ -f "$(ls -1d "$tmp"/backups/*/ | head -1)deploy.json" ]; check "backup manifest written" "$?"

"$ops/scripts/status.sh" >/dev/null 2>&1; check "status succeeds after deploy" "$?"
status_out="$("$ops/scripts/status.sh")"
grep -q "state:.*deployed" <<<"$status_out"; check "status reports deployed" "$?"

if "$ops/scripts/rollback.sh" >/dev/null 2>&1; then code=0; else code=$?; fi
check "rollback dry run exits 0" "$([ "$code" -eq 0 ] && echo 0 || echo 1)"
message_is "$desired"; check "rollback dry run leaves the message alone" "$?"

if "$ops/scripts/rollback.sh" --yes >/dev/null 2>&1; then code=0; else code=$?; fi
check "rollback applies" "$([ "$code" -eq 0 ] && echo 0 || echo 1)"
message_is "BASELINE PROMPT FIXTURE"; check "rollback restores the previous message" "$?"
fields_unchanged; check "rollback leaves trigger/schedule/tools untouched" "$?"

fixture
"$ops/scripts/deploy.sh" --yes --allow-drift >/dev/null 2>&1
"$OPENCLAW_CLI" cron edit "6a45be21-ce0b-4b8b-8986-4c885d1ea659" --message "LATER CHANGE" >/dev/null 2>&1
if "$ops/scripts/rollback.sh" --yes >/dev/null 2>&1; then code=0; else code=$?; fi
check "rollback refuses an unknown live message" "$([ "$code" -ne 0 ] && echo 0 || echo 1)"
message_is "LATER CHANGE"; check "refused rollback leaves the later change alone" "$?"
if "$ops/scripts/rollback.sh" --yes --force >/dev/null 2>&1; then code=0; else code=$?; fi
check "rollback --force restores the backup" "$([ "$code" -eq 0 ] && echo 0 || echo 1)"
message_is "BASELINE PROMPT FIXTURE"; check "forced rollback restores the message" "$?"

fixture
if FAKE_CORRUPT=1 "$ops/scripts/deploy.sh" --yes --allow-drift >"$tmp/corrupt.log" 2>&1; then code=0; else code=$?; fi
check "failed post-deploy verification exits nonzero" "$([ "$code" -ne 0 ] && echo 0 || echo 1)"
grep -q "trigger script changed unexpectedly" "$tmp/corrupt.log"; check "corruption is reported" "$?"
message_is "BASELINE PROMPT FIXTURE"; check "failed verification auto-restores the message" "$?"

# Regression r1-2: the edit succeeds but the next read fails / returns bad JSON.
# Both must reach restore_previous instead of aborting on set -e.
fixture
if FAKE_FAIL_NEXT_GET=1 "$ops/scripts/deploy.sh" --yes --allow-drift >"$tmp/getfail.log" 2>&1; then code=0; else code=$?; fi
check "after-get failure exits nonzero" "$([ "$code" -ne 0 ] && echo 0 || echo 1)"
grep -q "after-get failed" "$tmp/getfail.log"; check "after-get failure is reported" "$?"
message_is "BASELINE PROMPT FIXTURE"; check "after-get failure auto-restores the message" "$?"

fixture
if FAKE_BAD_JSON_NEXT_GET=1 "$ops/scripts/deploy.sh" --yes --allow-drift >"$tmp/badjson.log" 2>&1; then code=0; else code=$?; fi
check "after-get JSON parse failure exits nonzero" "$([ "$code" -ne 0 ] && echo 0 || echo 1)"
grep -q "unparsable" "$tmp/badjson.log"; check "after-get parse failure is reported" "$?"
message_is "BASELINE PROMPT FIXTURE"; check "after-get parse failure auto-restores the message" "$?"

echo "RESULT: $passed passed, $failures failed"
[ "$failures" -eq 0 ]
