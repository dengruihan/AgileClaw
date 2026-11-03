#!/usr/bin/env bash
# Live read-only probe for the collector-mail-triage path (stateless design).
#
# Runs only notmuch read commands (config/count/search/show/dump) against the
# real local index to prove the skill's lookup shape works on this host. It
# prints counts, lengths and hashes only: no sender, subject, address, message
# id or body text ever leaves this script.
#
# It does not sync mail, tag messages, create a database, write progress state
# or touch the collector workspace. Run it on the collector host.
#
# Usage: ./verify/live-readonly-probe.sh
set -euo pipefail

for bin in notmuch jq sha256sum; do
  command -v "$bin" >/dev/null 2>&1 || { echo "FAIL: $bin not installed" >&2; exit 1; }
done

passed=0
failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_ge() { if [ "$1" -ge "$2" ]; then pass "$3"; else fail "$3 (got '$1', want >= $2)"; fi; }

db="$(notmuch config get database.path 2>/dev/null || true)"
[ -n "$db" ] && [ -d "$db" ] && pass "notmuch database path resolves and exists" ||
  { fail "notmuch database path missing"; exit 1; }

hidden_tags="$(notmuch config get search.exclude_tags 2>/dev/null || true)"
printf 'INFO database=%s exclude_tags=%s\n' "$db" "${hidden_tags:-none}"

# Bounded lookup mirroring the skill: newest 20 per account, explicit notmuch
# status before parsing, no progress state and no time watermark.
lookup_count() {
  local acct="$1" raw
  raw=$(notmuch search --format=json --sort=newest-first --limit=20 "folder:$acct/INBOX") || return 2
  printf '%s' "$raw" | jq 'length'
}
newest_query() {
  local raw
  raw=$(notmuch search --format=json --sort=newest-first --limit=1 "folder:$1/INBOX") || return 2
  printf '%s' "$raw" | jq -r '.[0].query[0] // empty'
}
header_bytes() {
  local out
  out=$(notmuch show --format=text --body=false --entire-thread=false "$1") || return 3
  printf '%s' "$out" | wc -c | tr -d ' '
}
body_bytes() {
  local out n
  out=$(notmuch show --format=text --body=true --include-html=true --entire-thread=false "$1") || return 3
  # Disable pipefail only for the truncation pipeline: head exits early by
  # design, while the notmuch failure above is already checked explicitly.
  n=$(set +o pipefail; printf '%s' "$out" | head -c 4000 | wc -c)
  printf '%s' "$n" | tr -d ' '
}

for acct in yungu qq; do
  total="$(notmuch count "folder:$acct/INBOX")"
  assert_ge "$total" 0 "$acct inbox count readable"
  if ! c="$(lookup_count "$acct")"; then
    fail "$acct bounded lookup failed"
    c=0
  else
    pass "$acct bounded lookup runs"
  fi
  if [ "$c" -le 20 ]; then pass "$acct lookup is bounded (<=20)"; else fail "$acct lookup exceeded 20 rows"; fi
  printf 'INFO %s inbox=%s lookup_rows=%s\n' "$acct" "$total" "$c"

  q="$(newest_query "$acct")"
  if [ -n "$q" ]; then
    if hb="$(header_bytes "$q")"; then
      assert_ge "$hb" 1 "$acct header read returns bytes"
    else
      fail "$acct header read failed with an explicit notmuch error"
      hb=0
    fi
    if bb="$(body_bytes "$q")"; then
      assert_ge "$bb" 1 "$acct bounded body read returns bytes"
      if [ "$bb" -le 4000 ]; then pass "$acct body read stays within 4000 bytes"; else fail "$acct body read exceeded 4000 bytes"; fi
    else
      fail "$acct body read failed with an explicit notmuch error"
    fi
    printf 'INFO %s newest header_bytes=%s body_bytes<=4000\n' "$acct" "$hb"
  else
    printf 'INFO %s inbox is empty; read path skipped\n' "$acct"
  fi
done

# Read-only proof of the collection contract: mail report/snapshot keep counts
# only. Only key names are inspected; no values are printed.
report="/home/raymond/.openclaw/workspace/collection/report.json"
snapshot="/home/raymond/.openclaw/workspace/collection/state/snapshot-mail.json"
sidecar="/home/raymond/.openclaw/workspace/collection/state/mail-triage.json"
if [ -f "$report" ]; then
  if jq -e '["items","messages","threads","authors","subject","from","body","preview"] - (.sources.mail | keys) | length == 8' "$report" >/dev/null 2>&1; then
    pass "report.json mail entry has no content fields"
  else
    fail "report.json mail entry exposes content fields"
  fi
  if jq -e '.sources.mail | has("counts") and has("countsDelta")' "$report" >/dev/null 2>&1; then
    pass "report.json mail entry is count-based"
  else
    fail "report.json mail entry lacks counts"
  fi
fi
if [ -f "$snapshot" ]; then
  if jq -e '(keys_unsorted - ["at","counts"]) | length == 0' "$snapshot" >/dev/null 2>&1; then
    pass "snapshot-mail.json only contains at/counts"
  else
    fail "snapshot-mail.json contains unexpected fields"
  fi
fi
[ ! -e "$sidecar" ] && pass "collection state has no mail-triage progress sidecar" ||
  fail "collection state contains a mail-triage progress sidecar"

# Read-only proof: same index dump and same newest file bytes before/after.
dump_before="$(notmuch dump '*' | sort | sha256sum)"
counts_before="$(notmuch count '*')"
newest_file="$(notmuch search --output=files 'folder:yungu/INBOX' | head -1)"
file_sha_before=""
[ -n "$newest_file" ] && file_sha_before="$(sha256sum "$newest_file" | cut -d' ' -f1)"

q="$(newest_query yungu)"
if [ -n "$q" ]; then
  body_bytes "$q" >/dev/null
fi

dump_after="$(notmuch dump '*' | sort | sha256sum)"
counts_after="$(notmuch count '*')"
file_sha_after=""
[ -n "$newest_file" ] && file_sha_after="$(sha256sum "$newest_file" | cut -d' ' -f1)"

assert_eq "$dump_after" "$dump_before" "read-only probe leaves tags and message ids unchanged"
assert_eq "$counts_after" "$counts_before" "read-only probe leaves the message count unchanged"
if [ -n "$newest_file" ]; then
  assert_eq "$file_sha_after" "$file_sha_before" "read-only probe does not rewrite the message file"
fi

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
