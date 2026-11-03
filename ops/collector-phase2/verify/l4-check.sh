#!/usr/bin/env bash
# L4 反模式自检（AGENTS.md）：任何命中即为失败。
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
check() {
  local label="$1"; shift
  if "$@" > /tmp/l4-check.out 2>&1; then
    echo "L4 FAIL ($label):"; cat /tmp/l4-check.out; fail=1
  else
    echo "L4 ok ($label)"
  fi
}

FILES=(
  payload-message.txt
  files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs
  files/home/raymond/.openclaw/workspace/collection/README.md
  README.md
  verify/harness.mjs
  verify/agent-boundary.mjs
)

check "时间戳/更新记录段" grep -n -E "(最后修订[：:]|最后更新[：:]|^## ?(更新记录|Changelog|版本历史))" "${FILES[@]}"
check "版本号/v字头" grep -n -E "(##.*v[0-9]|Skill 版本|首次验证[：:]|未来[：:].*v[0-9])" "${FILES[@]}"
check "修复/升级叙述" grep -n -E "用户.{0,15}(指出|纠正|纠错|触发.{0,5}升级)" "${FILES[@]}"

exit "$fail"
