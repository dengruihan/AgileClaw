#!/usr/bin/env bash
# Restores the six targets from a deploy backup.
#
#   ./scripts/rollback.sh                 # plan only, newest backup
#   ./scripts/rollback.sh --yes           # restore
#   ./scripts/rollback.sh --yes --force   # restore even if content moved after deploy
#
# The default refuses when any target no longer matches the deployed shape, so a
# later M15/M19 body edit is not silently discarded.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "$OPS_DIR/scripts/lib.sh"

write=0
force=0
backup_arg=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) write=1 ;;
    --force) force=1 ;;
    --backup)
      backup_arg="${2:-}"
      [ -n "$backup_arg" ] || die "--backup requires a directory"
      shift
      ;;
    *)
      echo "Usage: $0 [--yes] [--force] [--backup DIR]" >&2
      exit 2
      ;;
  esac
  shift
done

if [ -n "$backup_arg" ]; then
  backup="$backup_arg"
else
  backup="$(latest_backup_dir)" || die "no deployment backup found under $BACKUP_BASE"
fi
[ -f "$backup/deploy.json" ] || die "missing deploy.json in $backup"

mapfile -t names < <(target_names)
[ "${#names[@]}" -eq 6 ] || die "manifest must list exactly six targets"

plan=()
noop=()
refusals=()
for name in "${names[@]}"; do
  path="$(target_path "$name")"
  before="$backup/targets/$name.before.md"
  if [ ! -f "$before" ]; then
    refusals+=("$name: backup before copy missing")
    continue
  fi
  if [ ! -f "$path" ]; then
    refusals+=("$name: live target missing")
    continue
  fi
  before_sha="$(sha256_file "$before")"
  current_sha="$(sha256_file "$path")"
  if [ "$current_sha" = "$before_sha" ]; then
    state="$(printf '%s' "$(apply_check "$path" "$name")" | json_stream_field status || true)"
    if [ "$state" = "visible" ]; then
      noop+=("$name")
      continue
    fi
  fi
  if ! result="$(apply_check "$path" "$name")"; then
    refusals+=("$name: invalid frontmatter; refusing to overwrite")
    continue
  fi
  state="$(printf '%s' "$result" | json_stream_field status)"
  after_sha="$(json_file_field "$backup/deploy.json" "targets.$name.afterSha256" 2>/dev/null || true)"
  exact=0
  if [ -n "$after_sha" ] && [ "$current_sha" = "$after_sha" ]; then
    exact=1
  elif apply_verify "$path" "$name" "$before" >/dev/null 2>&1; then
    exact=1
  fi
  if [ "$state" = "hidden" ] && [ "$exact" = "1" ]; then
    plan+=("$name")
  elif [ "$force" -eq 1 ]; then
    plan+=("$name")
  else
    refusals+=("$name: content changed after deploy (sha $current_sha); use --force to restore")
  fi
done

info "backup: $backup"
info "restore: ${#plan[@]} (${plan[*]:-none})"
info "already before: ${#noop[@]} (${noop[*]:-none})"
if [ "${#refusals[@]}" -gt 0 ]; then
  for refusal in "${refusals[@]}"; do
    echo "REFUSE $refusal" >&2
  done
  die "rollback preflight refused; no target was written"
fi
if [ "$write" -eq 0 ]; then
  echo
  echo "Plan only. Re-run with --yes to restore."
  exit 0
fi
if [ "${#plan[@]}" -eq 0 ]; then
  info "nothing to restore"
  exit 0
fi

safety="$backup/rollback-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$safety/targets"
for name in "${names[@]}"; do
  cp -p "$(target_path "$name")" "$safety/targets/$name.before-rollback.md"
done
cat >"$safety/rollback.json" <<EOF
{
  "status": "started",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "sourceBackup": "$backup",
  "restored": $(printf '%s\n' "${plan[@]}" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split("\n").filter(Boolean))))')
}
EOF

for name in "${plan[@]}"; do
  path="$(target_path "$name")"
  before="$backup/targets/$name.before.md"
  cp -p "$before" "$path"
  expected="$(sha256_file "$before")"
  actual="$(sha256_file "$path")"
  [ "$actual" = "$expected" ] || die "$name: restored hash mismatch $actual != $expected"
  if ! result="$(apply_check "$path" "$name")"; then
    die "$name: restored file has invalid frontmatter"
  fi
  state="$(printf '%s' "$result" | json_stream_field status)"
  pre_state="$(json_file_field "$backup/deploy.json" "targets.$name.preState" 2>/dev/null || true)"
  if [ -n "$pre_state" ] && [ "$state" != "$pre_state" ]; then
    die "$name: restored state $state, expected pre-deploy $pre_state"
  fi
  info "$name: restored ($state)"
done

if [ -f "$backup/skills-before.json" ] && "$OPENCLAW_BIN" skills list --json >"$safety/skills-after-rollback.json" 2>/dev/null; then
  if ! "$NODE_BIN" "$COMPARE_CATALOG" \
    --before "$backup/skills-before.json" \
    --after "$safety/skills-after-rollback.json" \
    --mode restore \
    --targets "$(IFS=,; echo "${names[*]}")"; then
    die "catalog did not return to the pre-deploy snapshot; see $safety"
  fi
else
  warn "catalog snapshot unavailable; skipped full catalog restore comparison"
fi

for name in "${names[@]}"; do
  info_json="$("$OPENCLAW_BIN" skills info "$name" --agent main --json 2>/dev/null || true)"
  [ -n "$info_json" ] || die "$name: skills info failed after rollback"
  model_visible="$(printf '%s' "$info_json" | json_stream_field modelVisible || true)"
  eligible="$(printf '%s' "$info_json" | json_stream_field eligible || true)"
  pre_state="$(json_file_field "$backup/deploy.json" "targets.$name.preState" 2>/dev/null || true)"
  expected_visible="false"
  [ "$pre_state" = "visible" ] && expected_visible="true"
  [ "$model_visible" = "$expected_visible" ] || die "$name: modelVisible=$model_visible after rollback, expected $expected_visible"
  [ "$eligible" = "true" ] || die "$name: eligible=$eligible after rollback"
done

json_set "$safety/rollback.json" "status" "restored"
info "rollback complete; safety copies: $safety"
