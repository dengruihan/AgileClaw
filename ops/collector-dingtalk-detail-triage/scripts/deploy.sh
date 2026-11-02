#!/usr/bin/env bash
# Deploy the collector DingTalk detail-triage prompt (payload.message only).
#
# What this changes: the embedded Agent prompt of the `collector` automation.
# What this never changes: trigger.script, schedule, timeout, description,
# toolsAllow, sessionTarget, enabled state.
#
# Without --yes the script only prints the plan. Every apply first writes a
# backup (full job JSON + the previous message) and then verifies that the
# untouched fields are byte-identical. A failed verification restores the
# previous message automatically.
#
# Usage: deploy.sh [--yes] [--allow-drift]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
allow_drift=0

usage() {
  cat <<'EOF'
Usage: deploy.sh [--yes] [--allow-drift]

  --yes          apply payload.message (default: print the plan only)
  --allow-drift  proceed even though the live message differs from the
                 authoring baseline; review that difference first
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --allow-drift) allow_drift=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_payload

current="$(cron_json)"
[ -n "$current" ] || die "openclaw cron get $JOB_ID returned nothing"

job_id="$(printf '%s' "$current" | json_field id)"
[ "$job_id" = "$JOB_ID" ] || die "unexpected job id $job_id (expected $JOB_ID)"

desired_sha="$(sha256_file "$PAYLOAD_FILE")"
desired_bytes="$(wc -c <"$PAYLOAD_FILE" | tr -d ' ')"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
current_facts="$(job_facts_json "$current")"
trigger_sha="$(printf '%s' "$current_facts" | json_field triggerSha256)"

info "job: $JOB_NAME ($JOB_ID)"
info "current message: sha256 $current_sha"
info "desired message: sha256 $desired_sha (${desired_bytes} bytes)"
info "trigger script: sha256 $trigger_sha"

[ "$trigger_sha" = "$BASELINE_TRIGGER_SHA256" ] ||
  echo "NOTE: trigger script differs from the authoring baseline; deploy leaves it untouched." >&2

if [ "$current_sha" = "$desired_sha" ]; then
  info "already deployed; nothing to do"
  exit 0
fi

if [ "$current_sha" != "$BASELINE_MESSAGE_SHA256" ] && [ "$allow_drift" -eq 0 ]; then
  die "live message is neither the baseline nor the desired prompt.
Review the current payload first:
  $(cli_display) cron get $JOB_ID --json
Then rerun with --allow-drift if replacing it is intended."
fi

if [ "$yes" -eq 0 ]; then
  info "plan only. Would back up the current job and run:"
  echo "  $(cli_display) cron edit $JOB_ID --message \"\$(cat $PAYLOAD_FILE)\""
  info "rerun with --yes to apply"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$BACKUP_BASE/$stamp"
mkdir -p "$backup_dir"
printf '%s\n' "$current" >"$backup_dir/job.before.json"
printf '%s' "$current_message" >"$backup_dir/payload-message.before.txt"
cat >"$backup_dir/deploy.json" <<EOF
{
  "jobId": "$JOB_ID",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "before": {
    "messageSha256": "$current_sha",
    "triggerSha256": "$trigger_sha"
  },
  "desired": {
    "messageSha256": "$desired_sha",
    "bytes": $desired_bytes
  },
  "baselineMatch": $([ "$current_sha" = "$BASELINE_MESSAGE_SHA256" ] && echo true || echo false)
}
EOF
info "backup: $backup_dir"

restore_previous() {
  echo "==> restoring the previous message" >&2
  if openclaw_cli cron edit "$JOB_ID" --message "$(cat "$backup_dir/payload-message.before.txt")" >&2; then
    echo "==> restore command succeeded; re-check with scripts/status.sh" >&2
  else
    echo "==> restore command FAILED; run scripts/rollback.sh --yes --backup $backup_dir" >&2
  fi
}

info "applying payload.message"
# Command substitution strips the file's trailing newline, matching how the
# live message was authored (no trailing newline).
if ! openclaw_cli cron edit "$JOB_ID" --message "$(cat "$PAYLOAD_FILE")"; then
  echo "ERROR: cron edit failed; the live message may be partially applied." >&2
  restore_previous
  exit 1
fi

current_description="$(printf '%s' "$current_facts" | json_field description)"
verify_fail=""

# Every read, parse and comparison after the edit is fallible. They run inside
# a function called from `if !`, and each step is checked explicitly, so a
# failed after-get or unparsable JSON reaches restore_previous instead of
# aborting on set -e with the new prompt left live.
verify_after() {
  local after after_message after_sha after_facts before_compare after_compare
  local after_trigger_sha after_description

  if ! after="$(cron_json)"; then
    verify_fail="after-get failed"
    return 1
  fi
  if [ -z "$after" ]; then
    verify_fail="after-get returned nothing"
    return 1
  fi
  if ! after_message="$(printf '%s' "$after" | json_field payload.message)"; then
    verify_fail="after-get payload.message missing or unparsable"
    return 1
  fi
  after_sha="$(sha256_text "$after_message")"
  if ! after_facts="$(job_facts_json "$after")"; then
    verify_fail="after-get job facts unparsable"
    return 1
  fi
  if ! before_compare="$(printf '%s' "$current_facts" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);delete j.triggerSha256;delete j.description;process.stdout.write(JSON.stringify(j))})')"; then
    verify_fail="before facts unparsable"
    return 1
  fi
  if ! after_compare="$(printf '%s' "$after_facts" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);delete j.triggerSha256;delete j.description;process.stdout.write(JSON.stringify(j))})')"; then
    verify_fail="after facts unparsable"
    return 1
  fi

  [ "$after_sha" = "$desired_sha" ] || verify_fail="payload.message does not match $PAYLOAD_FILE"
  [ "$before_compare" = "$after_compare" ] ||
    verify_fail="${verify_fail:+$verify_fail; }schedule/timeout/tools/session/enabled changed unexpectedly"

  if ! after_trigger_sha="$(printf '%s' "$after_facts" | json_field triggerSha256)"; then
    verify_fail="${verify_fail:+$verify_fail; }after trigger sha unreadable"
  elif [ "$after_trigger_sha" != "$trigger_sha" ]; then
    verify_fail="${verify_fail:+$verify_fail; }trigger script changed unexpectedly"
  fi
  if ! after_description="$(printf '%s' "$after" | json_field description)"; then
    verify_fail="${verify_fail:+$verify_fail; }after description unreadable"
  elif [ "$after_description" != "$current_description" ]; then
    verify_fail="${verify_fail:+$verify_fail; }description changed unexpectedly"
  fi

  [ -z "$verify_fail" ]
}

if ! verify_after; then
  echo "ERROR: post-deploy verification failed: ${verify_fail:-unknown}" >&2
  restore_previous
  exit 1
fi

info "verified: message updated; trigger, schedule, timeout, tools, session, enabled and description unchanged"
info "backup for rollback: $backup_dir"
