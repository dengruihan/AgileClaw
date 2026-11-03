#!/usr/bin/env bash
# Read-only classification of the six targets.
#
# No argument: report baseline/hidden/restored state and the live visible count.
# --expect-hidden: fail unless every target is hidden and the CLI reports
# modelVisible=false. Use this after deployment and after any legacy package
# might have been redeployed.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=scripts/lib.sh
source "$OPS_DIR/scripts/lib.sh"

mode="report"
case "${1:-}" in
  --expect-hidden) mode="expect-hidden" ;;
  "") ;;
  *) echo "Usage: $0 [--expect-hidden]" >&2; exit 2 ;;
esac

failures=0
failed() {
  failures=$((failures + 1))
  echo "FAIL $1"
}

info "M20 visibility status (read-only)"
info "target root: $OPENCLAW_HOME_DIR"
echo

visible=0
while IFS= read -r name; do
  path="$(target_path "$name")"
  if [ ! -f "$path" ]; then
    failed "$name: missing at $path"
    continue
  fi
  if ! result="$(apply_check "$path" "$name")"; then
    failed "$name: invalid frontmatter ($path)"
    continue
  fi
  state="$(printf '%s' "$result" | json_stream_field status)"
  case "$state" in
    hidden)
      echo "PASS $name: hidden (disable-model-invocation: true)"
      ;;
    visible)
      visible=$((visible + 1))
      hash="$(sha256_file "$path")"
      baseline_sha="$(target_field "$name" baselineSha256)"
      if [ "$hash" = "$baseline_sha" ]; then
        if [ "$mode" = "expect-hidden" ]; then
          failed "$name: visible (authoring baseline; expected hidden)"
        else
          echo "PASS $name: visible (authoring baseline; ready to hide)"
        fi
      elif legacy="$(legacy_lookup "$name" "$hash")"; then
        failed "$name: VISIBILITY-RESTORED by $legacy"
      else
        if [ "$mode" = "expect-hidden" ]; then
          failed "$name: visible (content differs from authoring baseline; expected hidden)"
        else
          echo "PASS $name: visible (content differs from authoring baseline; flag absent)"
        fi
      fi
      ;;
    *)
      failed "$name: unexpected state $state"
      ;;
  esac
done < <(target_names)

echo
if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' EXIT
  if "$OPENCLAW_BIN" skills list --json >"$tmp" 2>/dev/null && "$NODE_BIN" -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$tmp" >/dev/null 2>&1; then
    count="$(visible_count "$tmp")"
    echo "visible skills (CLI): $count"
    echo "expected: $(manifest_field surfaces.expectedVisibleBefore) before / $(manifest_field surfaces.expectedVisibleAfter) after"
    if [ "$mode" = "expect-hidden" ] && [ -z "${M20_OPENCLAW_HOME:-}" ] && [ "$count" != "$(manifest_field surfaces.expectedVisibleAfter)" ]; then
      failed "visible count is $count, expected $(manifest_field surfaces.expectedVisibleAfter)"
    fi
    if [ "$mode" = "expect-hidden" ]; then
      for name in $(target_names); do
        info_json="$("$OPENCLAW_BIN" skills info "$name" --agent main --json 2>/dev/null || true)"
        if [ -z "$info_json" ]; then
          failed "$name: skills info failed"
          continue
        fi
        model_visible="$(printf '%s' "$info_json" | json_stream_field modelVisible || true)"
        eligible="$(printf '%s' "$info_json" | json_stream_field eligible || true)"
        if [ "$model_visible" = "false" ]; then
          echo "PASS $name: CLI modelVisible=false"
        else
          failed "$name: CLI modelVisible=$model_visible, expected false"
        fi
        if [ "$eligible" = "true" ]; then
          echo "PASS $name: CLI eligible=true (file still readable)"
        else
          failed "$name: CLI eligible=$eligible, expected true"
        fi
      done
    fi
  else
    warn "openclaw skills list --json failed; live count not checked"
    [ "$mode" = "expect-hidden" ] && failed "cannot verify live catalog without the CLI"
  fi
else
  warn "openclaw CLI not found: $OPENCLAW_BIN"
  [ "$mode" = "expect-hidden" ] && failed "cannot verify live catalog without the CLI"
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "$failures failure(s)"
  exit 1
fi
echo "All checks passed."
if [ "$mode" = "report" ]; then
  echo "Run '$OPS_DIR/scripts/deploy.sh --yes' only after M15 and M19 are merged."
fi
