#!/usr/bin/env bash
# Read-only status for the collector mail-triage deployment.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_package

current="$(cron_json)"
[ -n "$current" ] || die "openclaw cron get $JOB_ID returned nothing"

desired_sha="$(sha256_text "$(cat "$PAYLOAD_FILE")")"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
facts="$(job_facts_json "$current")"

printf 'job:              %s (%s)\n' "$(printf '%s' "$current" | json_field name)" "$JOB_ID"
printf 'enabled:          %s\n' "$(printf '%s' "$facts" | json_field enabled)"
printf 'schedule:         %s\n' "$(printf '%s' "$facts" | json_field schedule)"
printf 'sessionTarget:    %s\n' "$(printf '%s' "$facts" | json_field sessionTarget)"
printf 'timeoutSeconds:   %s\n' "$(printf '%s' "$facts" | json_field timeoutSeconds)"
printf 'lightContext:     %s\n' "$(printf '%s' "$facts" | json_field lightContext)"
printf 'toolsAllow:       %s\n' "$(printf '%s' "$facts" | json_field toolsAllow)"
printf 'trigger sha256:   %s\n' "$(printf '%s' "$facts" | json_field triggerSha256)"
printf 'message sha256:   %s\n' "$current_sha"
printf 'desired sha256:   %s\n' "$desired_sha"
printf 'baseline sha256:  %s\n' "$BASELINE_MESSAGE_SHA256"

skills_ready=0
skills_baseline=0
for name in "${SKILL_NAMES[@]}"; do
  source_sha="$(sha256_file "$(skill_source_file "$name")")"
  target_sha="$(skill_target_sha "$name")"
  baseline_sha="$(skill_baseline_sha "$name")"
  if [ "$target_sha" = "$source_sha" ]; then
    skills_ready=$((skills_ready + 1))
    state="deployed"
  elif [ "$target_sha" = "missing" ]; then
    state="absent"
  elif [ "$target_sha" = "$baseline_sha" ]; then
    state="baseline"
  else
    state="differs"
  fi
  if [ "$target_sha" = "$baseline_sha" ]; then
    skills_baseline=$((skills_baseline + 1))
  fi
  if [ "${CDMT_SKIP_DISCOVERY:-0}" != "1" ]; then
    if discovered="$(openclaw_cli skills info "$name" --json 2>/dev/null)"; then
      visible="$(printf '%s' "$discovered" | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
          try { const j = JSON.parse(s); process.stdout.write(`${j.eligible === true && j.modelVisible === true ? "yes" : "no"}`); }
          catch { process.stdout.write("unparsable"); }
        });
      ')"
    else
      visible="not-found"
    fi
  else
    visible="skipped"
  fi
  printf 'skill %-26s %-8s discovered/modelVisible=%s\n' "$name" "$state" "$visible"
done

if [ "$current_sha" = "$desired_sha" ] && [ "$skills_ready" -eq "${#SKILL_NAMES[@]}" ]; then
  echo "state:            deployed"
elif [ "$current_sha" = "$BASELINE_MESSAGE_SHA256" ] && [ "$skills_baseline" -eq "${#SKILL_NAMES[@]}" ]; then
  echo "state:            not deployed"
else
  echo "state:            partial or drifted (message and skills disagree with the package)"
fi

if backup_dir="$(pick_backup_dir)"; then
  echo "newest backup:    $backup_dir"
  printf 'backup deployed:  %s\n' "$(json_field desired.messageSha256 <"$backup_dir/deploy.json")"
  printf 'backup previous:  %s\n' "$(json_field before.messageSha256 <"$backup_dir/deploy.json")"
else
  echo "newest backup:    none"
fi
