#!/usr/bin/env bash
# Isolated deploy/rollback simulation using a temporary DEPLOY_ROOT and HOME.
# No live path, cron, Gateway, Agenda database or message channel is touched.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export DEPLOY_ROOT="$tmp/root"
mkdir -p "$HOME" "$DEPLOY_ROOT"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

files=()
while IFS= read -r rel; do files+=("$rel"); done < <(
  cd "$PKG_DIR/files" && find . -type f -print | sed 's|^\./||' | sort
)

# 预置“旧 live”：collect.mjs 用 M19 基线，其余已存在文件用旧内容；两个新 lib 文件缺省。
for rel in "${files[@]}"; do
  target="$DEPLOY_ROOT/${rel#files/}"
  case "$rel" in
    */lib/agenda-sync.mjs|*/lib/course-weeks.mjs) continue ;;
    */collection/collect.mjs)
      mkdir -p "$(dirname "$target")"
      cp -p "$PKG_DIR/baselines/collect.pre-m19.mjs" "$target"
      continue
      ;;
  esac
  mkdir -p "$(dirname "$target")"
  printf 'live-old:%s\n' "$rel" >"$target"
done

# 共享 collect.mjs 偏离基线时拒绝部署（需 --allow-drift）。
collect_target="$DEPLOY_ROOT/home/raymond/.openclaw/workspace/collection/collect.mjs"
printf 'drifted\n' >"$collect_target"
if (cd "$PKG_DIR" && ./scripts/deploy.sh --yes --skip-checks --allow-missing-sync >/dev/null 2>&1); then
  bad "deploy should refuse a drifted collect.mjs"
else
  ok "deploy refuses a drifted collect.mjs"
fi
[[ "$(cat "$collect_target")" == drifted ]] && ok "drifted collect.mjs is left untouched" || bad "drifted collect.mjs was overwritten"
cp -p "$PKG_DIR/baselines/collect.pre-m19.mjs" "$collect_target"

# dry run 不写入、不备份
(cd "$PKG_DIR" && ./scripts/deploy.sh --skip-checks --allow-missing-sync >/dev/null)
if cmp -s "$PKG_DIR/baselines/collect.pre-m19.mjs" "$DEPLOY_ROOT/home/raymond/.openclaw/workspace/collection/collect.mjs"; then
  ok "dry run leaves live untouched"
else
  bad "dry run wrote live"
fi
if [[ ! -d "$HOME/.openclaw/backups/collector-course-sync" ]]; then
  ok "dry run creates no backup"
else
  bad "dry run created a backup"
fi

# 实际部署
(cd "$PKG_DIR" && ./scripts/deploy.sh --yes --skip-checks --allow-missing-sync >/dev/null)
mismatch=0
for rel in "${files[@]}"; do
  target="$DEPLOY_ROOT/${rel#files/}"
  cmp -s "$PKG_DIR/files/$rel" "$target" || mismatch=$((mismatch + 1))
done
[[ $mismatch -eq 0 ]] && ok "deploy writes every package file byte-identically" || bad "deploy mismatched $mismatch files"

backup="$(find "$HOME/.openclaw/backups/collector-course-sync" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -f "$backup/manifest.tsv" ]] && ok "backup manifest exists" || bad "backup manifest missing"
grep -q $'^absent\t.*lib/agenda-sync.mjs\t-$' "$backup/manifest.tsv" && ok "backup records pre-existing absence" || bad "backup misses absent marker"
grep -q $'^present\t.*collection/collect.mjs\t' "$backup/manifest.tsv" && ok "backup records existing file" || bad "backup misses present marker"

status_out="$(cd "$PKG_DIR" && ./scripts/status.sh)"
[[ "$(printf '%s\n' "$status_out" | grep -c '^deployed ')" -eq "${#files[@]}" ]] && ok "status reports all files deployed" || bad "status mismatch"
[[ "$(printf '%s\n' "$status_out" | grep -c '^drifted ')" -eq 0 ]] && ok "status reports no drift" || bad "status reports drift"

# 回滚 dry run 不改动
(cd "$PKG_DIR" && ./scripts/rollback.sh >/dev/null)
cmp -s "$PKG_DIR/files/home/raymond/.openclaw/workspace/collection/collect.mjs" "$DEPLOY_ROOT/home/raymond/.openclaw/workspace/collection/collect.mjs" \
  && ok "rollback dry run leaves deployment in place" || bad "rollback dry run changed files"

# 实际回滚
(cd "$PKG_DIR" && ./scripts/rollback.sh --yes >/dev/null)
for rel in "${files[@]}"; do
  target="$DEPLOY_ROOT/${rel#files/}"
  case "$rel" in
    */lib/agenda-sync.mjs|*/lib/course-weeks.mjs)
      [[ ! -e "$target" ]] || bad "rollback did not remove new file $rel" ;;
    */collection/collect.mjs)
      cmp -s "$PKG_DIR/baselines/collect.pre-m19.mjs" "$target" || bad "rollback did not restore $rel" ;;
    *)
      [[ "$(cat "$target")" == "live-old:$rel" ]] || bad "rollback did not restore $rel" ;;
  esac
done
ok "rollback restores old files and removes new files"

status_after="$(cd "$PKG_DIR" && ./scripts/status.sh)"
[[ "$(printf '%s\n' "$status_after" | grep -c '^missing ')" -ge 2 ]] && ok "status reports new files missing after rollback" || bad "status after rollback unexpected"
[[ "$(printf '%s\n' "$status_after" | grep -c '^drifted ')" -ge 1 ]] && ok "status reports old files drifted after rollback" || bad "status after rollback shows no drift"

echo
echo "$pass pass, $fail fail"
exit $((fail > 0))
