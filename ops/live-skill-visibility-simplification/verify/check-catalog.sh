#!/usr/bin/env bash
# Proves the loader contract on a throwaway copy of the six target skills plus
# two controls. It does not read or write live skill state.
#
#   before: six targets + visible control are model-visible; disabled control is not
#   apply:  insert exactly one disable-model-invocation line in the six temp copies
#   after:  six targets leave the catalog, stay eligible/readable, controls unchanged
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="$(cd "$OPS_DIR/../.." && pwd)"
MANIFEST="$OPS_DIR/manifest.json"
APPLY_FLAG="$OPS_DIR/scripts/apply-flag.mjs"
COMPARE="$OPS_DIR/verify/compare-catalog.mjs"
FIXTURES="$OPS_DIR/verify/fixtures/baseline"
NODE_BIN="${M20_NODE:-node}"

if [ -f "$REPO_ROOT/dist/index.js" ]; then
  cli=("$NODE_BIN" "$REPO_ROOT/dist/index.js")
else
  cli=(openclaw)
fi

tmp="$(mktemp -d)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

workspace="$tmp/workspace"
state="$tmp/state"
mkdir -p "$workspace/skills" "$state/agents/main/agent/workshop-skills"
cp -R "$FIXTURES/workspace/skills/." "$workspace/skills/"
cp -R "$FIXTURES/agents/main/agent/workshop-skills/." "$state/agents/main/agent/workshop-skills/"
cp -R "$OPS_DIR/verify/fixtures/control-visible" "$workspace/skills/control-visible"
cp -R "$OPS_DIR/verify/fixtures/control-disabled" "$workspace/skills/control-disabled"
cat >"$state/openclaw.json" <<EOF
{
  "agents": { "entries": { "main": { "workspace": "$workspace" } } },
  "skills": { "entries": { "control-disabled": { "enabled": false } } }
}
EOF

export OPENCLAW_HOME="$tmp"
export OPENCLAW_STATE_DIR="$state"
export OPENCLAW_CONFIG_DIR="$state"

passes=0
failures=0
pass() {
  passes=$((passes + 1))
  echo "PASS catalog-check: $1"
}
fail() {
  failures=$((failures + 1))
  echo "FAIL catalog-check: $1"
}
field() {
  printf '%s' "$1" | "$NODE_BIN" -e '
    let text=""; process.stdin.on("data", d => text += d).on("end", () => {
      let value = JSON.parse(text);
      for (const part of process.argv[1].split(".")) {
        if (value === null || value === undefined) break;
        value = value[part];
      }
      process.stdout.write(value === undefined ? "" : String(value));
    });
  ' "$2"
}

names=(collector-dingtalk-triage collector-mail-triage collector-source-triage collector-health-repair collector-notify biandan-todo)
for name in "${names[@]}"; do
  info_json="$("${cli[@]}" skills info "$name" --agent main --json)"
  visible="$(field "$info_json" modelVisible)"
  eligible="$(field "$info_json" eligible)"
  if [ "$visible" = "true" ]; then pass "$name: modelVisible=true before"; else fail "$name: modelVisible=$visible before, expected true"; fi
  if [ "$eligible" = "true" ]; then pass "$name: eligible=true before"; else fail "$name: eligible=$eligible before"; fi
done

before_list="$tmp/skills-before.json"
"${cli[@]}" skills list --json >"$before_list"
control_visible="$("${cli[@]}" skills info control-visible --agent main --json)"
control_disabled="$("${cli[@]}" skills info control-disabled --agent main --json)"
[ "$(field "$control_visible" modelVisible)" = "true" ] && pass "control-visible: visible before" || fail "control-visible: not visible before"
[ "$(field "$control_disabled" disabled)" = "true" ] && pass "control-disabled: disabled before" || fail "control-disabled: not disabled before"
[ "$(field "$control_disabled" modelVisible)" = "false" ] && pass "control-disabled: hidden before" || fail "control-disabled: visible before"

before_visible="$("$NODE_BIN" -e '
  const fs=require("node:fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  process.stdout.write(String((j.skills||j).filter(s=>s.modelVisible===true).length));
' "$before_list")"
[ "$before_visible" -ge 7 ] && pass "catalog: $before_visible visible before (six targets + controls + bundled skills)" || fail "catalog: only $before_visible visible before, expected at least 7"

for name in "${names[@]}"; do
  if [ "$name" = "biandan-todo" ]; then
    file="$state/agents/main/agent/workshop-skills/$name/SKILL.md"
  else
    file="$workspace/skills/$name/SKILL.md"
  fi
  if ! "$NODE_BIN" "$APPLY_FLAG" --file "$file" --name "$name" --write >/dev/null; then
    fail "$name: apply-flag write failed"
  else
    pass "$name: flag inserted"
  fi
done

for name in "${names[@]}"; do
  if [ "$name" = "biandan-todo" ]; then
    file="$state/agents/main/agent/workshop-skills/$name/SKILL.md"
    baseline="$FIXTURES/agents/main/agent/workshop-skills/$name/SKILL.md"
  else
    file="$workspace/skills/$name/SKILL.md"
    baseline="$FIXTURES/workspace/skills/$name/SKILL.md"
  fi
  [ -r "$file" ] && pass "$name: file readable after hiding" || fail "$name: file not readable"
  if "$NODE_BIN" "$APPLY_FLAG" --file "$file" --name "$name" --baseline "$baseline" --verify-insert-only >/dev/null; then
    pass "$name: body byte-identical to baseline (only one line inserted)"
  else
    fail "$name: body changed beyond the inserted flag"
  fi
  info_json="$("${cli[@]}" skills info "$name" --agent main --json)"
  [ "$(field "$info_json" modelVisible)" = "false" ] && pass "$name: modelVisible=false after" || fail "$name: still modelVisible after"
  [ "$(field "$info_json" eligible)" = "true" ] && pass "$name: eligible=true after" || fail "$name: not eligible after"
  [ "$(field "$info_json" userInvocable)" = "true" ] && pass "$name: userInvocable=true after" || fail "$name: userInvocable changed"
  file_path="$(field "$info_json" filePath)"
  [ -n "$file_path" ] && [ -f "$file_path" ] && pass "$name: filePath resolves after" || fail "$name: filePath does not resolve"
done

after_list="$tmp/skills-after.json"
"${cli[@]}" skills list --json >"$after_list"
if "$NODE_BIN" "$COMPARE" --before "$before_list" --after "$after_list" --mode hide \
  --targets "$(IFS=,; echo "${names[*]}")" --expected-before "$before_visible" --expected-after "$((before_visible - 6))"; then
  pass "catalog: six targets hidden, controls and unrelated states unchanged"
else
  fail "catalog comparison failed"
fi

for name in "${names[@]}"; do
  info_json="$("${cli[@]}" skills info "$name" --agent main --json)"
  file_path="$(field "$info_json" filePath)"
  [ -n "$file_path" ] && [ -f "$file_path" ] && pass "$name: filePath resolves after" || fail "$name: filePath does not resolve"
done

control_after="$("${cli[@]}" skills info control-visible --agent main --json)"
[ "$(field "$control_after" modelVisible)" = "true" ] && pass "control-visible: still visible after" || fail "control-visible: changed after"
control_disabled_after="$("${cli[@]}" skills info control-disabled --agent main --json)"
[ "$(field "$control_disabled_after" disabled)" = "true" ] && pass "control-disabled: still disabled after" || fail "control-disabled: changed after"
[ "$(field "$control_disabled_after" modelVisible)" = "false" ] && pass "control-disabled: still hidden after" || fail "control-disabled: changed after"

echo
echo "$passes passed, $failures failed"
[ "$failures" -eq 0 ]
