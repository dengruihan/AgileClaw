#!/usr/bin/env bash
# Deploy the M15 collector Agenda-wording fix.
#
# Five surfaces, one cutover:
#   - two workspace SKILL.md files (collector-notify, collector-source-triage)
#   - the `collector` automation's payload.message (dispatcher route)
#   - an anchored line patch in workspace/AGENTS.md (master-list rule)
#   - an anchored comment patch in collection/dingtalk-notify.mjs
#
# deploy never touches trigger.script, schedule, timeout, toolsAllow,
# lightContext, sessionTarget, wakeMode, enabled, description or delivery, and
# it sends no DingTalk message, mail, or test notification.
#
# Without --yes the script only prints the plan. An apply backs up every
# surface first, writes atomically, verifies, and restores on any failure.
#
# Usage: deploy.sh [--yes] [--allow-drift]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

yes=0
allow_drift=0

usage() {
  cat <<'EOF'
Usage: deploy.sh [--yes] [--allow-drift]

  --yes          apply the five surfaces (default: plan only)
  --allow-drift  proceed even though a live surface differs from the recorded
                 baseline; review that difference first
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

require_package

desired_message="$(package_payload_text)"
desired_message_sha="$(package_payload_sha)"
desired_message_chars="$(printf '%s' "$desired_message" | wc -m | tr -d ' ')"
baseline_message_sha="$(manifest_field cron.baselineMessageSha256)"

current="$(cron_json)"
[ -n "$current" ] || die "$(cli_display) cron get $JOB_ID returned nothing"
job_id="$(printf '%s' "$current" | json_field id)"
[ "$job_id" = "$JOB_ID" ] || die "unexpected job id $job_id (expected $JOB_ID)"
current_message="$(printf '%s' "$current" | json_field payload.message)"
current_message_sha="$(sha256_text "$current_message")"
current_facts="$(job_facts_json "$current")"

need_message=0
[ "$current_message_sha" = "$desired_message_sha" ] || need_message=1
message_action="unchanged"
if [ "$need_message" -eq 1 ]; then
  if [ "$current_message_sha" = "$baseline_message_sha" ]; then
    message_action="replace"
  else
    message_action="replace (drift)"
  fi
fi

skill_actions=()
for name in "${SKILL_NAMES[@]}"; do
  rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
  desired="$(package_sha "$rel")"
  baseline="$(package_entry file "$rel" baselineSha256)"
  current_sha="$(target_sha "$rel")"
  if [ "$current_sha" = "$desired" ]; then
    skill_actions+=("$name: unchanged")
  elif [ "$current_sha" = "$baseline" ]; then
    skill_actions+=("$name: replace")
  elif [ "$current_sha" = "missing" ]; then
    skill_actions+=("$name: create")
  else
    skill_actions+=("$name: replace (drift)")
  fi
  check_tokens "$(package_file_for "$rel")" || die "package content failed token checks: $name"
  check_required "$(package_file_for "$rel")" "$(package_entry file "$rel" requiredAfter)" ||
    die "package content missing a required anchor: $name"
done

patch_actions=()
for rel in "${PATCH_PATHS[@]}"; do
  state="$(patch_state "$rel")"
  patch_actions+=("$state")
done

info "job: $JOB_NAME ($JOB_ID)"
info "message: $message_action (sha256 $current_message_sha -> $desired_message_sha, ${desired_message_chars} chars)"
for i in "${!SKILL_NAMES[@]}"; do info "skill ${skill_actions[$i]}"; done
for i in "${!PATCH_PATHS[@]}"; do info "patch ${PATCH_PATHS[$i]}: ${patch_actions[$i]}"; done

needs_apply=0
[ "$need_message" -eq 1 ] && needs_apply=1
for action in "${skill_actions[@]}"; do
  case "$action" in *": unchanged") ;; *) needs_apply=1 ;; esac
done
for state in "${patch_actions[@]}"; do
  [ "$state" = "applied" ] || needs_apply=1
done

if [ "$needs_apply" -eq 0 ]; then
  info "already deployed on all five surfaces; nothing to do"
  exit 0
fi

if [ "$allow_drift" -eq 0 ]; then
  if [ "$need_message" -eq 1 ] && [ "$current_message_sha" != "$baseline_message_sha" ] &&
    [ "$current_message_sha" != "$desired_message_sha" ]; then
    die "live message is neither the baseline nor the desired dispatcher.
Review it first:
  $(cli_display) cron get $JOB_ID --json
Then rerun with --allow-drift if replacing it is intended."
  fi
  for action in "${skill_actions[@]}"; do
    case "$action" in *"(drift)") die "a live skill differs from both the baseline and the package.
Review the file under $TARGET_ROOT/home/raymond/.openclaw/workspace/skills, then rerun with --allow-drift." ;; esac
  done
  for i in "${!PATCH_PATHS[@]}"; do
    if [ "${patch_actions[$i]}" = "drift" ]; then
      die "anchored patch drift in ${PATCH_PATHS[$i]}.
The recorded old text is no longer present exactly once (or the new text is already mixed in).
Review the file, then rerun with --allow-drift if the patch should still be applied."
    fi
    if [ "${patch_actions[$i]}" = "missing" ]; then
      die "patch target missing: $(target_file "${PATCH_PATHS[$i]}")"
    fi
  done
fi

if [ "$yes" -eq 0 ]; then
  info "plan only. Would:"
  [ "$need_message" -eq 1 ] &&
    echo "  - edit payload.message via $(cli_display) cron edit $JOB_ID --message \"\$(cat $PAYLOAD_FILE)\""
  echo "  - replace ${#SKILL_NAMES[@]} SKILL.md files under $TARGET_ROOT/home/raymond/.openclaw/workspace/skills"
  echo "  - apply ${#PATCH_PATHS[@]} anchored line patches (AGENTS.md master-list rule, notify comment)"
  echo "  (trigger, schedule, timeout, toolsAllow, lightContext, sessionTarget, wakeMode, enabled, description, delivery stay untouched)"
  info "rerun with --yes to apply"
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="$BACKUP_BASE/$stamp"
suffix=1
while [ -e "$backup_dir" ]; do
  suffix=$((suffix + 1))
  backup_dir="$BACKUP_BASE/$stamp-$suffix"
done
mkdir -p "$backup_dir/files" "$backup_dir/patches"

printf '%s\n' "$current" >"$backup_dir/job.before.json"
printf '%s' "$current_message" >"$backup_dir/payload-message.before.txt"

file_backups=()
for name in "${SKILL_NAMES[@]}"; do
  rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
  target="$(target_file "$rel")"
  mkdir -p "$backup_dir/files/$name"
  if [ -f "$target" ]; then
    cp "$target" "$backup_dir/files/$name/SKILL.md.before"
  fi
  file_backups+=("$name")
done
for rel in "${PATCH_PATHS[@]}"; do
  target="$(target_file "$rel")"
  key="$(printf '%s' "$rel" | tr '/' '_')"
  if [ -f "$target" ]; then
    cp "$target" "$backup_dir/patches/$key.before"
  fi
done

patches_json="[]"
for rel in "${PATCH_PATHS[@]}"; do
  after_sha="$(patch_after_sha "$rel")"
  patches_json="$(PATCHES_JSON="$patches_json" PATH_REL="$rel" AFTER="$after_sha" node -e '
    const list = JSON.parse(process.env.PATCHES_JSON);
    list.push({ path: process.env.PATH_REL, afterSha256: process.env.AFTER });
    process.stdout.write(JSON.stringify(list));
  ')"
done

cat >"$backup_dir/deploy.json" <<EOF
{
  "jobId": "$JOB_ID",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "before": {
    "messageSha256": "$current_message_sha",
    "triggerSha256": "$(printf '%s' "$current_facts" | json_field triggerSha256)"
  },
  "desired": {
    "messageSha256": "$desired_message_sha",
    "chars": $desired_message_chars
  },
  "skills": $(node -e '
    const fs = require("node:fs");
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const out = {};
    for (const p of m.files) out[p.path.split("/").slice(-2)[0]] = p.deployedSha256;
    process.stdout.write(JSON.stringify(out));
  ' "$MANIFEST_FILE"),
  "patches": $patches_json
}
EOF
info "backup: $backup_dir"

restore_previous() {
  local name rel target key
  echo "==> restoring the previous five surfaces" >&2
  if [ "$need_message" -eq 1 ]; then
    if openclaw_cli cron edit "$JOB_ID" --message "$(cat "$backup_dir/payload-message.before.txt")" >/dev/null 2>&1; then
      echo "==> message restore command succeeded; re-check with scripts/status.sh" >&2
    else
      echo "==> message restore FAILED; run scripts/rollback.sh --yes --backup $backup_dir" >&2
    fi
  fi
  for name in "${SKILL_NAMES[@]}"; do
    rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
    target="$(target_file "$rel")"
    if [ -f "$backup_dir/files/$name/SKILL.md.before" ]; then
      cp "$backup_dir/files/$name/SKILL.md.before" "$target"
    else
      rm -f "$target"
      rmdir "$(dirname "$target")" 2>/dev/null || true
    fi
  done
  for rel in "${PATCH_PATHS[@]}"; do
    target="$(target_file "$rel")"
    key="$(printf '%s' "$rel" | tr '/' '_')"
    if [ -f "$backup_dir/patches/$key.before" ]; then
      cp "$backup_dir/patches/$key.before" "$target"
    fi
  done
}

apply_all() {
  local name rel target tmp
  info "writing skill files"
  for name in "${SKILL_NAMES[@]}"; do
    rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
    target="$(target_file "$rel")"
    if [ "$(package_sha "$rel")" = "$(target_sha "$rel")" ]; then
      continue
    fi
    mkdir -p "$(dirname "$target")"
    tmp="$(mktemp "$(dirname "$target")/.SKILL.md.XXXXXX")"
    cp "$(package_file_for "$rel")" "$tmp"
    if [ -f "$target" ]; then
      chmod --reference="$target" "$tmp"
    fi
    mv "$tmp" "$target"
  done

  info "applying anchored patches"
  for rel in "${PATCH_PATHS[@]}"; do
    target="$(target_file "$rel")"
    if [ "$(patch_state "$rel")" = "applied" ]; then
      continue
    fi
    tmp="$(mktemp "$(dirname "$target")/.patch.XXXXXX")"
    patch_apply "$rel" "$target" "$tmp"
    chmod --reference="$target" "$tmp"
    mv "$tmp" "$target"
  done

  if [ "$need_message" -eq 1 ]; then
    info "applying payload.message"
    openclaw_cli cron edit "$JOB_ID" --message "$desired_message" >/dev/null
  fi
}

if ! apply_all; then
  echo "ERROR: apply failed; restoring the previous five surfaces." >&2
  restore_previous
  exit 1
fi

# Every read and comparison after the edits is fallible; failures reach
# restore_previous instead of aborting on set -e with the new state live.
verify_fail=""
verify_after() {
  local after after_message after_sha after_facts name rel
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
  [ "$after_sha" = "$desired_message_sha" ] || verify_fail="payload.message does not match $PAYLOAD_FILE"
  if ! after_facts="$(job_facts_json "$after")"; then
    verify_fail="${verify_fail:+$verify_fail; }after-get job facts unparsable"
  elif [ "$after_facts" != "$current_facts" ]; then
    verify_fail="${verify_fail:+$verify_fail; }an untouched job field changed unexpectedly"
  fi

  for name in "${SKILL_NAMES[@]}"; do
    rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
    if [ "$(target_sha "$rel")" != "$(package_sha "$rel")" ]; then
      verify_fail="${verify_fail:+$verify_fail; }skill $name content mismatch"
      continue
    fi
    if ! check_tokens "$(target_file "$rel")"; then
      verify_fail="${verify_fail:+$verify_fail; }skill $name contains positive 便单 wording"
      continue
    fi
    if ! check_required "$(target_file "$rel")" "$(package_entry file "$rel" requiredAfter)"; then
      verify_fail="${verify_fail:+$verify_fail; }skill $name missing an anchor"
      continue
    fi
    if ! verify_skill_discovery "$name" "$(target_file "$rel")"; then
      verify_fail="${verify_fail:+$verify_fail; }skill $name not discovered/modelVisible"
    fi
  done

  for rel in "${PATCH_PATHS[@]}"; do
    if [ "$(patch_state "$rel")" != "applied" ]; then
      verify_fail="${verify_fail:+$verify_fail; }patch not applied: $rel"
      continue
    fi
    if ! check_tokens "$(target_file "$rel")"; then
      verify_fail="${verify_fail:+$verify_fail; }patch left positive 便单 wording: $rel"
      continue
    fi
    if ! check_required "$(target_file "$rel")" "$(package_entry patch "$rel" requiredAfter)"; then
      verify_fail="${verify_fail:+$verify_fail; }patch missing an anchor: $rel"
    fi
  done

  [ -z "$verify_fail" ]
}

if ! verify_after; then
  echo "ERROR: post-deploy verification failed: ${verify_fail:-unknown}" >&2
  restore_previous
  exit 1
fi

info "verified: five surfaces updated; trigger, schedule, timeout, tools, lightContext, session, enabled, description and delivery unchanged"
info "backup for rollback: $backup_dir"
