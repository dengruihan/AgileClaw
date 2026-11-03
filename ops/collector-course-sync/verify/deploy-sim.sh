#!/usr/bin/env bash
# Isolated deploy/rollback simulation using a temporary DEPLOY_ROOT, HOME and fake openclaw CLI.
# No live path, cron, Gateway, Agenda database or message channel is touched.
set -euo pipefail
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export HOME="$tmp/home"
export DEPLOY_ROOT="$tmp/root"
export FAKE_STATE="$tmp/state"
export PATH="$tmp/bin:$PATH"
mkdir -p "$HOME" "$DEPLOY_ROOT" "$FAKE_STATE" "$tmp/bin"

pass=0
fail=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf 'FAIL %s\n' "$1"; }

cat >"$tmp/bin/openclaw" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
state="$FAKE_STATE/job.json"
case "${1:-} ${2:-}" in
  "cron get") cat "$state" ;;
  "cron edit")
    shift 2
    python3 - "$state" "$@" <<'PY'
import json, sys
state, args = sys.argv[1], sys.argv[2:]
message = None
trigger = None
i = 0
while i < len(args):
    if args[i] == "--message":
        message = args[i + 1]
        i += 2
    elif args[i] == "--trigger-script":
        trigger = open(args[i + 1], encoding="utf-8").read()
        i += 2
    else:
        i += 1
job = json.load(open(state, encoding="utf-8"))
if message is not None:
    job["payload"]["message"] = message
if trigger is not None:
    job["trigger"]["script"] = trigger
json.dump(job, open(state, "w", encoding="utf-8"), ensure_ascii=False)
PY
    ;;
  *)
    echo "unsupported fake openclaw call: $*" >&2
    exit 2
    ;;
esac
SH
chmod +x "$tmp/bin/openclaw"

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
      cp -p "$PKG_DIR/baselines/collect.pre-m19.mjs.txt" "$target"
      continue
      ;;
  esac
  mkdir -p "$(dirname "$target")"
  printf 'live-old:%s\n' "$rel" >"$target"
done

# 预置 cron job（基线的 message/trigger，其它字段应保持不变）。
python3 - "$PKG_DIR" "$FAKE_STATE/job.json" <<'PY'
import json, sys
pkg, out = sys.argv[1], sys.argv[2]
job = {
    "id": "6a45be21-ce0b-4b8b-8986-4c885d1ea659",
    "name": "collector",
    "enabled": True,
    "schedule": {"kind": "every", "everyMs": 600000, "anchorMs": 1},
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "payload": {
        "kind": "agentTurn",
        "message": open(f"{pkg}/baselines/payload-message.pre-m19.txt", encoding="utf-8").read().rstrip("\n"),
        "timeoutSeconds": 600,
        "lightContext": True,
        "toolsAllow": ["ls", "read", "edit", "write", "apply_patch", "exec", "process", "light_control", "agenda"],
    },
    "delivery": {"mode": "none", "channel": "last"},
    "trigger": {"script": open(f"{pkg}/baselines/trigger-collector.pre-m19.mjs.txt", encoding="utf-8").read()},
}
json.dump(job, open(out, "w", encoding="utf-8"), ensure_ascii=False)
PY

# 共享 collect.mjs 偏离基线时拒绝部署（需 --allow-drift）。
collect_target="$DEPLOY_ROOT/home/raymond/.openclaw/workspace/collection/collect.mjs"
printf 'drifted\n' >"$collect_target"
if (cd "$PKG_DIR" && ./scripts/deploy.sh --yes --skip-checks --allow-missing-sync >/dev/null 2>&1); then
  bad "deploy should refuse a drifted collect.mjs"
else
  ok "deploy refuses a drifted collect.mjs"
fi
[[ "$(cat "$collect_target")" == drifted ]] && ok "drifted collect.mjs is left untouched" || bad "drifted collect.mjs was overwritten"
cp -p "$PKG_DIR/baselines/collect.pre-m19.mjs.txt" "$collect_target"

# cron payload 偏离基线时拒绝部署。
python3 - "$FAKE_STATE/job.json" <<'PY'
import json, sys
p = sys.argv[1]
job = json.load(open(p, encoding="utf-8"))
job["payload"]["message"] = "drifted payload"
json.dump(job, open(p, "w", encoding="utf-8"), ensure_ascii=False)
PY
if (cd "$PKG_DIR" && ./scripts/deploy.sh --yes --skip-checks --allow-missing-sync >/dev/null 2>&1); then
  bad "deploy should refuse a drifted cron payload"
else
  ok "deploy refuses a drifted cron payload"
fi
python3 - "$PKG_DIR" "$FAKE_STATE/job.json" <<'PY'
import json, sys
pkg, p = sys.argv[1], sys.argv[2]
job = json.load(open(p, encoding="utf-8"))
job["payload"]["message"] = open(f"{pkg}/baselines/payload-message.pre-m19.txt", encoding="utf-8").read().rstrip("\n")
json.dump(job, open(p, "w", encoding="utf-8"), ensure_ascii=False)
PY

# dry run 不写入、不备份
(cd "$PKG_DIR" && ./scripts/deploy.sh --skip-checks --allow-missing-sync >/dev/null)
if cmp -s "$PKG_DIR/baselines/collect.pre-m19.mjs.txt" "$collect_target"; then
  ok "dry run leaves live files untouched"
else
  bad "dry run wrote live files"
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

if python3 - "$PKG_DIR" "$FAKE_STATE/job.json" <<'PY'
import json, sys
pkg, p = sys.argv[1], sys.argv[2]
job = json.load(open(p, encoding="utf-8"))
payload = open(f"{pkg}/payload-message.txt", encoding="utf-8").read().rstrip("\n")
trigger = open(f"{pkg}/files/home/raymond/.openclaw/workspace/collection/trigger-collector.mjs", encoding="utf-8").read()
assert job["payload"]["message"] == payload, "cron payload not updated"
assert job["trigger"]["script"].rstrip("\n") == trigger.rstrip("\n"), "cron trigger not updated"
assert job["payload"]["toolsAllow"] == ["ls", "read", "edit", "write", "apply_patch", "exec", "process", "light_control", "agenda"], "toolsAllow changed"
assert job["schedule"]["everyMs"] == 600000 and job["enabled"] is True, "schedule/enabled changed"
PY
then
  ok "deploy updates payload/trigger and preserves untouched job fields"
else
  bad "deploy corrupted job fields"
fi

backup="$(find "$HOME/.openclaw/backups/collector-course-sync" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -f "$backup/manifest.tsv" && -f "$backup/job.before.json" && -f "$backup/payload-message.before.txt" && -f "$backup/trigger-collector.before.mjs" ]] \
  && ok "backup includes files and cron payload/trigger" || bad "backup incomplete"
grep -q $'^absent\t.*lib/agenda-sync.mjs\t-$' "$backup/manifest.tsv" && ok "backup records pre-existing absence" || bad "backup misses absent marker"
grep -q $'^present\t.*collection/collect.mjs\t' "$backup/manifest.tsv" && ok "backup records existing file" || bad "backup misses present marker"

status_out="$(cd "$PKG_DIR" && ./scripts/status.sh)"
[[ "$(printf '%s\n' "$status_out" | grep -c '^deployed ')" -eq "${#files[@]}" ]] && ok "status reports all files deployed" || bad "status mismatch"
[[ "$(printf '%s\n' "$status_out" | grep -c '^drifted ')" -eq 0 ]] && ok "status reports no file drift" || bad "status reports drift"

# 回滚 dry run 不改动
(cd "$PKG_DIR" && ./scripts/rollback.sh >/dev/null)
cmp -s "$PKG_DIR/files/home/raymond/.openclaw/workspace/collection/collect.mjs" "$collect_target" \
  && ok "rollback dry run leaves deployment in place" || bad "rollback dry run changed files"

# 部署后修改文件与 cron：默认拒绝回滚，--force 才覆盖。
printf 'post-deploy-edit\n' >>"$collect_target"
python3 - "$FAKE_STATE/job.json" <<'PY'
import json, sys
p = sys.argv[1]
job = json.load(open(p, encoding="utf-8"))
job["payload"]["message"] = "post-deploy cron edit"
json.dump(job, open(p, "w", encoding="utf-8"), ensure_ascii=False)
PY
if (cd "$PKG_DIR" && ./scripts/rollback.sh --yes >/dev/null 2>&1); then
  bad "rollback should refuse post-deploy drift"
else
  ok "rollback refuses post-deploy file/cron drift"
fi
[[ "$(tail -1 "$collect_target")" == post-deploy-edit ]] && ok "drift refusal leaves files untouched" || bad "drift refusal changed files"

# 实际回滚（显式 --force 覆盖已确认的部署后修改）
(cd "$PKG_DIR" && ./scripts/rollback.sh --yes --force >/dev/null)
for rel in "${files[@]}"; do
  target="$DEPLOY_ROOT/${rel#files/}"
  case "$rel" in
    */lib/agenda-sync.mjs|*/lib/course-weeks.mjs)
      [[ ! -e "$target" ]] || bad "rollback did not remove new file $rel" ;;
    */collection/collect.mjs)
      cmp -s "$PKG_DIR/baselines/collect.pre-m19.mjs.txt" "$target" || bad "rollback did not restore $rel" ;;
    *)
      [[ "$(cat "$target")" == "live-old:$rel" ]] || bad "rollback did not restore $rel" ;;
  esac
done
ok "rollback restores old files and removes new files"

if python3 - "$PKG_DIR" "$FAKE_STATE/job.json" <<'PY'
import json, sys
pkg, p = sys.argv[1], sys.argv[2]
job = json.load(open(p, encoding="utf-8"))
baseline = open(f"{pkg}/baselines/payload-message.pre-m19.txt", encoding="utf-8").read().rstrip("\n")
trigger = open(f"{pkg}/baselines/trigger-collector.pre-m19.mjs.txt", encoding="utf-8").read()
assert job["payload"]["message"] == baseline, "cron payload not restored"
assert job["trigger"]["script"].rstrip("\n") == trigger.rstrip("\n"), "cron trigger not restored"
assert job["payload"]["toolsAllow"] == ["ls", "read", "edit", "write", "apply_patch", "exec", "process", "light_control", "agenda"], "toolsAllow changed"
PY
then
  ok "rollback restores cron payload/trigger"
else
  bad "rollback did not restore cron"
fi

status_after="$(cd "$PKG_DIR" && ./scripts/status.sh)"
[[ "$(printf '%s\n' "$status_after" | grep -c '^missing ')" -ge 2 ]] && ok "status reports new files missing after rollback" || bad "status after rollback unexpected"
[[ "$(printf '%s\n' "$status_after" | grep -c '^drifted ')" -ge 1 ]] && ok "status reports old files drifted after rollback" || bad "status after rollback shows no drift"

echo
echo "$pass pass, $fail fail"
exit $((fail > 0))
