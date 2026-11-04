#!/usr/bin/env bash
# Prove that the skills are discovered and model-visible, without touching live
# state or the Gateway.
#
# Default mode copies the package skills into a throwaway workspace + state +
# config and asks the real `openclaw skills info` command about them.
# `--live` checks the already-deployed skills for the main agent (read-only).
#
# Usage: ./verify/discover-skills.sh [--live]
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_ROOT="$(cd "$OPS_DIR/../.." && pwd)"
SKILLS=(collector-dingtalk-triage collector-source-triage collector-health-repair collector-notify)

mode="temp"
case "${1:-}" in
  --live) mode="live" ;;
  "") ;;
  *) echo "Usage: $0 [--live]" >&2; exit 2 ;;
esac

tmp=""
cleanup() { [ -n "$tmp" ] && rm -rf "$tmp"; }
trap cleanup EXIT

passed=0
failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }

verify_one() {
  local name="$1" agent="$2" json
  if ! json="$(openclaw skills info "$name" --agent "$agent" --json)"; then
    fail "$name: skills info failed"
    return 1
  fi
  if printf '%s' "$json" | NAME="$name" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { console.error("unparsable json"); process.exit(2); }
      if (j.eligible !== true) { console.error("not eligible"); process.exit(3); }
      if (j.modelVisible !== true) { console.error("not modelVisible"); process.exit(4); }
      if (typeof j.filePath !== "string" || !j.filePath.endsWith(`/skills/${process.env.NAME}/SKILL.md`)) {
        console.error(`unexpected filePath ${j.filePath}`);
        process.exit(5);
      }
    });
  '; then
    pass "$name: discovered, eligible, modelVisible"
    return 0
  fi
  fail "$name: discovery contract not met"
  return 1
}

if [ "$mode" = "live" ]; then
  for name in "${SKILLS[@]}"; do
    verify_one "$name" main || true
  done
else
  tmp="$(mktemp -d)"
  mkdir -p "$tmp/workspace/skills" "$tmp/state"
  cp -R "$OPS_DIR/files/home/raymond/.openclaw/workspace/skills/." "$tmp/workspace/skills/"
  # Use the same agent id as the live collector (main) so the check exercises
  # the same agent filter and workspace-relative discovery rules.
  printf '{"agents":{"entries":{"main":{"workspace":"%s/workspace"}}}}\n' "$tmp" \
    >"$tmp/state/openclaw.json"
  export OPENCLAW_HOME="$tmp"
  export OPENCLAW_STATE_DIR="$tmp/state"
  export OPENCLAW_CONFIG_DIR="$tmp/state"
  cd "$OPENCLAW_ROOT"
  for name in "${SKILLS[@]}"; do
    verify_one "$name" main || true
  done
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
