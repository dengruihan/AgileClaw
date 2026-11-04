#!/usr/bin/env bash
# Deploy the collector skill dispatcher: payload.message + four workspace skills.
#
# What this changes:
#   - the `collector` automation's embedded prompt (payload.message)
#   - four new SKILL.md files under <workspace>/skills
# What this never changes: trigger.script, schedule, timeout, description,
# toolsAllow, lightContext, sessionTarget, wakeMode, enabled, delivery.
#
# Without --yes the script only prints the plan. Every apply writes a backup
# first, then verifies the untouched fields and the new skill files. A failed
# verification restores the previous message and the previous skill state.
#
# Usage: deploy.sh [--yes] [--allow-drift] [--force-skills]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
allow_drift=0
force_skills=0

usage() {
  cat <<'EOF'
Usage: deploy.sh [--yes] [--allow-drift] [--force-skills]

  --yes          apply payload.message and the skill files (default: plan only)
  --allow-drift  proceed even though the live message differs from the
                 authoring baseline; review that difference first
  --force-skills replace an existing differing SKILL.md (backed up first)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=1; shift ;;
    --allow-drift) allow_drift=1; shift ;;
    --force-skills) force_skills=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_package

current="$(cron_json)"
[ -n "$current" ] || die "openclaw cron get $JOB_ID returned nothing"

job_id="$(printf '%s' "$current" | json_field id)"
[ "$job_id" = "$JOB_ID" ] || die "unexpected job id $job_id (expected $JOB_ID)"

# The live message is written with `--message "$(cat file)"`, so command
# substitution strips one trailing newline. Hash and measure that exact text.
desired_text="$(cat "$PAYLOAD_FILE")"
desired_sha="$(sha256_text "$desired_text")"
desired_chars="$(printf '%s' "$desired_text" | wc -m | tr -d ' ')"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_sha="$(sha256_text "$current_message")"
current_facts="$(job_facts_json "$current")"
trigger_sha="$(printf '%s' "$current_facts" | json_field triggerSha256)"

need_message=0
[ "$current_sha" = "$desired_sha" ] || need_message=1

skill_actions=()
for name in "${SKILL_NAMES[@]}"; do
  source_sha="$(sha256_file "$(skill_source_file "$name")")"
  target_sha="$(skill_target_sha "$name")"
  if [ "$target_sha" = "$source_sha" ]; then
    skill_actions+=("$name: up-to-date")
  elif [ "$target_sha" = "missing" ]; then
    skill_actions+=("$name: create")
  elif [ "$force_skills" -eq 1 ]; then
    skill_actions+=("$name: replace (backed up)")
  else
    die "skill $name already exists with different content: $(skill_target_file "$name")
Review it, then rerun with --force-skills to replace it (the old file is backed up)."
  fi
done

info "job: $JOB_NAME ($JOB_ID)"
info "current message: sha256 $current_sha"
info "desired message: sha256 $desired_sha (${desired_chars} chars)"
info "trigger script: sha256 $trigger_sha"
for action in "${skill_actions[@]}"; do info "skill $action"; done

if [ "$trigger_sha" = "$BASELINE_TRIGGER_SHA256" ]; then
  info "trigger matches the authoring baseline (left untouched)"
else
  echo "NOTE: trigger script differs from the authoring baseline; deploy leaves it untouched." >&2
fi

if [ "$need_message" -eq 0 ] && ! printf '%s\n' "${skill_actions[@]}" | grep -qv ': up-to-date'; then
  info "already deployed; nothing to do"
  exit 0
fi

if [ "$need_message" -eq 1 ] && [ "$current_sha" != "$BASELINE_MESSAGE_SHA256" ] &&
  [ "$allow_drift" -eq 0 ]; then
  die "live message is neither the baseline nor the desired prompt.
Review the current payload first:
  $(cli_display) cron get $JOB_ID --json
Then rerun with --allow-drift if replacing it is intended."
fi

if [ "$yes" -eq 0 ]; then
  info "plan only. Would:"
  [ "$need_message" -eq 1 ] &&
    echo "  - edit payload.message via $(cli_display) cron edit $JOB_ID --message \"\$(cat $PAYLOAD_FILE)\""
  echo "  - write ${#SKILL_NAMES[@]} SKILL.md files under $WORKSPACE_SKILLS_DIR"
  echo "  (schedule-sweep at $SCHEDULE_SWEEP_FILE is read, never written)"
  info "rerun with --yes to apply"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$BACKUP_BASE/$stamp"
mkdir -p "$backup_dir"
printf '%s\n' "$current" >"$backup_dir/job.before.json"
printf '%s' "$current_message" >"$backup_dir/payload-message.before.txt"

skills_json="{}"
for name in "${SKILL_NAMES[@]}"; do
  source_sha="$(sha256_file "$(skill_source_file "$name")")"
  target_file="$(skill_target_file "$name")"
  if [ -f "$target_file" ]; then
    mkdir -p "$backup_dir/skills/$name"
    cp "$target_file" "$backup_dir/skills/$name/SKILL.md"
    existed=true
    replaced_sha="$(sha256_file "$target_file")"
  else
    existed=false
    replaced_sha=null
  fi
  skills_json="$(SKILLS_JSON="$skills_json" NAME="$name" SOURCE_SHA="$source_sha" \
    EXISTED="$existed" REPLACED_SHA="$replaced_sha" node -e '
      const j = JSON.parse(process.env.SKILLS_JSON);
      j[process.env.NAME] = {
        deployedSha256: process.env.SOURCE_SHA,
        existed: process.env.EXISTED === "true",
        replacedSha256: process.env.REPLACED_SHA === "null" ? null : process.env.REPLACED_SHA,
      };
      process.stdout.write(JSON.stringify(j));
    ')"
done

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
    "chars": $desired_chars
  },
  "skills": $skills_json
}
EOF
info "backup: $backup_dir"

created_skills=()
replaced_skills=()
restore_previous() {
  local name
  echo "==> restoring previous message and skill files" >&2
  if [ "$need_message" -eq 1 ]; then
    if openclaw_cli cron edit "$JOB_ID" --message "$(cat "$backup_dir/payload-message.before.txt")" >&2; then
      echo "==> restore command succeeded; re-check with scripts/status.sh" >&2
    else
      echo "==> restore command FAILED; run scripts/rollback.sh --yes --backup $backup_dir" >&2
    fi
  fi
  for name in "${replaced_skills[@]}"; do
    cp "$backup_dir/skills/$name/SKILL.md" "$(skill_target_file "$name")"
  done
  for name in "${created_skills[@]}"; do
    rm -f "$(skill_target_file "$name")"
    rmdir "$(skill_target_dir "$name")" 2>/dev/null || true
  done
}

info "writing skill files"
for name in "${SKILL_NAMES[@]}"; do
  target_file="$(skill_target_file "$name")"
  if [ "$(sha256_file "$(skill_source_file "$name")")" = "$(skill_target_sha "$name")" ]; then
    continue
  fi
  if [ -f "$target_file" ]; then replaced_skills+=("$name"); else created_skills+=("$name"); fi
  mkdir -p "$(skill_target_dir "$name")"
  cp "$(skill_source_file "$name")" "$target_file"
done

if [ "$need_message" -eq 1 ]; then
  info "applying payload.message"
  # Command substitution strips the file's trailing newline, matching how the
  # live message is authored (no trailing newline).
  if ! openclaw_cli cron edit "$JOB_ID" --message "$(cat "$PAYLOAD_FILE")"; then
    echo "ERROR: cron edit failed; the live message may be partially applied." >&2
    restore_previous
    exit 1
  fi
fi

verify_fail=""

# Every read, parse and comparison after the edit is fallible. They run inside
# a function called from `if !`, and each step is checked explicitly, so a
# failed after-get or unparsable JSON reaches restore_previous instead of
# aborting on set -e with the new state left live.
verify_after() {
  local after after_message after_sha after_facts after_trigger_sha name
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
  [ "$after_sha" = "$desired_sha" ] || verify_fail="payload.message does not match $PAYLOAD_FILE"

  if ! after_facts="$(job_facts_json "$after")"; then
    verify_fail="${verify_fail:+$verify_fail; }after-get job facts unparsable"
  elif [ "$after_facts" != "$current_facts" ]; then
    verify_fail="${verify_fail:+$verify_fail; }an untouched job field changed unexpectedly"
  fi

  if ! after_trigger_sha="$(printf '%s' "$after_facts" | json_field triggerSha256)"; then
    verify_fail="${verify_fail:+$verify_fail; }after trigger sha unreadable"
  elif [ "$after_trigger_sha" != "$trigger_sha" ]; then
    verify_fail="${verify_fail:+$verify_fail; }trigger script changed unexpectedly"
  fi

  for name in "${SKILL_NAMES[@]}"; do
    if [ "$(skill_target_sha "$name")" != "$(sha256_file "$(skill_source_file "$name")")" ]; then
      verify_fail="${verify_fail:+$verify_fail; }skill $name content mismatch"
      continue
    fi
    if ! verify_skill_discovery "$name" "$(skill_target_file "$name")"; then
      verify_fail="${verify_fail:+$verify_fail; }skill $name not discovered/modelVisible at $WORKSPACE_SKILLS_DIR/$name/SKILL.md"
    fi
  done

  [ -z "$verify_fail" ]
}

if ! verify_after; then
  echo "ERROR: post-deploy verification failed: ${verify_fail:-unknown}" >&2
  restore_previous
  exit 1
fi

info "verified: message and skills updated; trigger, schedule, timeout, tools, lightContext, session, enabled, description and delivery unchanged"
info "backup for rollback: $backup_dir"
