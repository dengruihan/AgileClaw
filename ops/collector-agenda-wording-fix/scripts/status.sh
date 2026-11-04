#!/usr/bin/env bash
# Read-only status for the M15 collector Agenda-wording fix.
#
# Reports each of the five surfaces as deployed / baseline / drift / missing
# and the live job fields this package must leave untouched. Writes nothing.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_package
package_payload_sha >/dev/null
for name in "${SKILL_NAMES[@]}"; do
  package_sha "home/raymond/.openclaw/workspace/skills/$name/SKILL.md" >/dev/null
done

echo "package: $OPS_DIR (reviewed hashes match manifest.json)"

if ! current="$(cron_json)"; then
  echo "cron: read failed for $JOB_ID"
else
  if [ -z "$current" ]; then
    echo "cron: $JOB_ID not found"
  else
    message="$(printf '%s' "$current" | json_field payload.message)"
    sha="$(sha256_text "$message")"
    baseline="$(manifest_field cron.baselineMessageSha256)"
    desired="$(manifest_field cron.desiredMessageSha256)"
    case "$sha" in
      "$desired") state="deployed" ;;
      "$baseline") state="baseline" ;;
      *) state="drift" ;;
    esac
    echo "cron payload.message: $state (sha256 $sha, $(printf '%s' "$message" | wc -c | tr -d ' ') bytes)"
    facts="$(job_facts_json "$current")"
    echo "cron trigger.script: sha256 $(printf '%s' "$facts" | json_field triggerSha256)"
    echo "cron untouched fields: toolsAllow=$(printf '%s' "$facts" | json_field toolsAllow) lightContext=$(printf '%s' "$facts" | json_field lightContext) sessionTarget=$(printf '%s' "$facts" | json_field sessionTarget)"
  fi
fi

for name in "${SKILL_NAMES[@]}"; do
  rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
  sha="$(target_sha "$rel")"
  baseline="$(package_entry file "$rel" baselineSha256)"
  desired="$(package_entry file "$rel" deployedSha256)"
  case "$sha" in
    "$desired") state="deployed" ;;
    "$baseline") state="baseline" ;;
    missing) state="missing" ;;
    *) state="drift" ;;
  esac
  echo "skill $name: $state (sha256 $sha)"
done

for rel in "${PATCH_PATHS[@]}"; do
  state="$(patch_state "$rel")"
  echo "patch $rel: $state"
done

if backup="$(pick_backup_dir)"; then
  echo "latest backup: $backup"
else
  echo "latest backup: none"
fi
