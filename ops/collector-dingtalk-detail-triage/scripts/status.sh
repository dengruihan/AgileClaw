#!/usr/bin/env bash
# Read-only status for the collector detail-triage prompt deployment.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_payload

current="$(cron_json)"
[ -n "$current" ] || die "openclaw cron get $JOB_ID returned nothing"

desired_sha="$(sha256_file "$PAYLOAD_FILE")"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
facts="$(job_facts_json "$current")"

printf 'job:              %s (%s)\n' "$(printf '%s' "$current" | json_field name)" "$JOB_ID"
printf 'enabled:          %s\n' "$(printf '%s' "$facts" | json_field enabled)"
printf 'schedule:         %s\n' "$(printf '%s' "$facts" | json_field schedule)"
printf 'timeoutSeconds:   %s\n' "$(printf '%s' "$facts" | json_field timeoutSeconds)"
printf 'toolsAllow:       %s\n' "$(printf '%s' "$facts" | json_field toolsAllow)"
printf 'trigger sha256:   %s\n' "$(printf '%s' "$facts" | json_field triggerSha256)"
printf 'message sha256:   %s\n' "$current_sha"
printf 'desired sha256:   %s\n' "$desired_sha"
printf 'baseline sha256:  %s\n' "$BASELINE_MESSAGE_SHA256"

if [ "$current_sha" = "$desired_sha" ]; then
  echo "state:            deployed (live message matches payload-message.txt)"
elif [ "$current_sha" = "$BASELINE_MESSAGE_SHA256" ]; then
  echo "state:            not deployed (live message is the authoring baseline)"
else
  echo "state:            drifted (live message is neither baseline nor desired)"
fi

if backup_dir="$(pick_backup_dir)"; then
  echo "newest backup:    $backup_dir"
  printf 'backup deployed:  %s\n' "$(json_field desired.messageSha256 <"$backup_dir/deploy.json")"
  printf 'backup previous:  %s\n' "$(json_field before.messageSha256 <"$backup_dir/deploy.json")"
else
  echo "newest backup:    none"
fi
