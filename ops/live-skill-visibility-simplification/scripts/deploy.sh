#!/usr/bin/env bash
# Applies the six frontmatter lines with backup and post-checks.
#
#   ./scripts/deploy.sh          # plan only, writes nothing
#   ./scripts/deploy.sh --yes    # back up, insert the flag, verify, roll back on failure
#
# It never edits cron, openclaw.json, the skills budget, the allowlist, or any
# other skill, and never sends messages or force-runs cron.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "$OPS_DIR/scripts/lib.sh"

write=0
case "${1:-}" in
  --yes) write=1 ;;
  "") ;;
  *) echo "Usage: $0 [--yes]" >&2; exit 2 ;;
esac

[ -f "$MANIFEST_FILE" ] || die "manifest missing: $MANIFEST_FILE"
[ -f "$APPLY_FLAG" ] || die "apply-flag missing: $APPLY_FLAG"

mapfile -t names < <(target_names)
[ "${#names[@]}" -eq 6 ] || die "manifest must list exactly six targets, found ${#names[@]}"

planned=()
already=()
for name in "${names[@]}"; do
  path="$(target_path "$name")"
  [ -f "$path" ] || die "$name: missing target $path"
  if ! result="$(apply_check "$path" "$name")"; then
    printf '%s\n' "$result" >&2
    die "$name: invalid frontmatter; refusing to edit $path"
  fi
  state="$(printf '%s' "$result" | json_stream_field status)"
  case "$state" in
    visible) planned+=("$name") ;;
    hidden) already+=("$name") ;;
    *) die "$name: unexpected state $state" ;;
  esac
done

info "M20 target root: $OPENCLAW_HOME_DIR"
info "planned inserts: ${#planned[@]} (${planned[*]:-none})"
info "already hidden: ${#already[@]} (${already[*]:-none})"
info "expected live visibility: $(manifest_field surfaces.expectedVisibleBefore) -> $(manifest_field surfaces.expectedVisibleAfter)"

if [ "$write" -eq 0 ]; then
  echo
  echo "Dry run only. Re-run with --yes after M15 and M19 are merged."
  exit 0
fi

command -v "$OPENCLAW_BIN" >/dev/null 2>&1 || die "openclaw CLI not found: $OPENCLAW_BIN"

backup="$(new_backup_dir)"
info "backup directory: $backup"
deploy_json="$backup/deploy.json"
cat >"$deploy_json" <<EOF
{
  "status": "started",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "openclawHome": "$OPENCLAW_HOME_DIR",
  "package": "ops/live-skill-visibility-simplification",
  "targets": {}
}
EOF

# Snapshot every target and the full catalog before writing anything.
for name in "${names[@]}"; do
  path="$(target_path "$name")"
  cp -p "$path" "$backup/targets/$name.before.md"
  before_sha="$(sha256_file "$path")"
  json_set "$deploy_json" "targets.$name.beforeSha256" "$before_sha"
  json_set "$deploy_json" "targets.$name.beforeBytes" "$(file_bytes "$path")"
  json_set "$deploy_json" "targets.$name.preState" "$(printf '%s' "$(apply_check "$path" "$name")" | json_stream_field status)"
  if ! "$OPENCLAW_BIN" skills info "$name" --agent main --json >"$backup/info-before-$name.json"; then
    die "$name: skills info failed before writing; nothing was changed"
  fi
  if ! "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$backup/info-before-$name.json" >/dev/null 2>&1; then
    die "$name: skills info returned invalid JSON before writing; nothing was changed"
  fi
done

if ! "$OPENCLAW_BIN" skills list --json >"$backup/skills-before.json"; then
  die "skills list failed before writing; nothing was changed"
fi
if ! "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$backup/skills-before.json" >/dev/null 2>&1; then
  die "skills list returned invalid JSON before writing; nothing was changed"
fi
visible_before="$(visible_count "$backup/skills-before.json")"
json_set "$deploy_json" "visibleBefore" "$visible_before"
info "live visible skills before: $visible_before"

post_failed=0
failure_reason=""
fail_post() {
  post_failed=1
  failure_reason="$1"
  echo "FAIL $1" >&2
}

for name in "${names[@]}"; do
  path="$(target_path "$name")"
  if ! output="$(apply_write "$path" "$name")"; then
    fail_post "$name: frontmatter write failed"
    break
  fi
  state="$(printf '%s' "$output" | json_stream_field status)"
  info "$name: $state"
  json_set "$deploy_json" "targets.$name.postState" "$state"
  json_set "$deploy_json" "targets.$name.afterSha256" "$(sha256_file "$path")"
  json_set "$deploy_json" "targets.$name.afterBytes" "$(file_bytes "$path")"
done

if [ "$post_failed" -eq 0 ]; then
  for name in "${names[@]}"; do
    path="$(target_path "$name")"
    before="$backup/targets/$name.before.md"
    if ! apply_verify "$path" "$name" "$before" >/dev/null; then
      fail_post "$name: file is not exactly before+one inserted line"
      continue
    fi
    if ! "$OPENCLAW_BIN" skills info "$name" --agent main --json >"$backup/info-after-$name.json"; then
      fail_post "$name: skills info failed after writing"
      continue
    fi
    if ! "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$backup/info-after-$name.json" >/dev/null 2>&1; then
      fail_post "$name: skills info returned invalid JSON after writing"
    fi
  done
fi

if [ "$post_failed" -eq 0 ]; then
  if ! "$NODE_BIN" "$CHECK_INFO" --before-dir "$backup" --after-dir "$backup" $(
    for name in "${names[@]}"; do printf -- '--name %s ' "$name"; done
  ); then
    fail_post "per-skill info contract failed"
  fi
fi

if [ "$post_failed" -eq 0 ]; then
  if ! "$OPENCLAW_BIN" skills list --json >"$backup/skills-after.json"; then
    fail_post "skills list failed after writing"
  elif ! "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$backup/skills-after.json" >/dev/null 2>&1; then
    fail_post "skills list returned invalid JSON after writing"
  else
    visible_after="$(visible_count "$backup/skills-after.json")"
    json_set "$deploy_json" "visibleAfter" "$visible_after"
    compare_args=(--before "$backup/skills-before.json" --after "$backup/skills-after.json" --mode hide --targets "$(IFS=,; echo "${names[*]}")")
    expected_before="$(manifest_field surfaces.expectedVisibleBefore)"
    expected_after="$(manifest_field surfaces.expectedVisibleAfter)"
    if [ "$visible_before" = "$expected_before" ]; then
      compare_args+=(--expected-before "$expected_before" --expected-after "$expected_after")
    fi
    if ! "$NODE_BIN" "$COMPARE_CATALOG" "${compare_args[@]}"; then
      fail_post "catalog comparison failed"
    fi
  fi
fi

if [ "$post_failed" -eq 0 ]; then
  if ! health="$("$OPENCLAW_BIN" gateway health 2>&1)"; then
    fail_post "gateway health command failed"
  elif ! printf '%s' "$health" | grep -qi '^OK'; then
    fail_post "gateway health is not OK: $health"
  else
    info "gateway health: $health"
  fi
fi

if [ "$post_failed" -ne 0 ]; then
  echo "Post-check failed: $failure_reason" >&2
  echo "Restoring all six targets from $backup" >&2
  if restore_targets_from_backup "$backup"; then
    json_set "$deploy_json" "status" "restored-after-failure"
    echo "Restored before hashes. See $deploy_json" >&2
  else
    json_set "$deploy_json" "status" "restore-failed"
    echo "MANUAL ACTION REQUIRED: restore did not verify; see $backup" >&2
  fi
  exit 1
fi

json_set "$deploy_json" "status" "deployed"
info "deployed six signatures; backup: $backup"
info "verify with: $OPS_DIR/scripts/status.sh --expect-hidden"
