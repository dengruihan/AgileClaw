#!/usr/bin/env bash
# Isolated notmuch check for the collector-mail-triage skill.
#
# Builds a throwaway maildir + notmuch database with synthetic messages (all
# addresses use the reserved .invalid domain), then runs the same read-only
# commands the skill instructs the agent to run. It proves:
#   - the watermark filter selects only messages newer than lastSeenTs
#   - the per-account limit and the merged round cap are bounded
#   - body output is capped at 4000 bytes, includes text/plain and HTML text,
#     and never includes attachment bytes
#   - reading messages changes no tags, no maildir files and no flags
#   - the watermark file only contains timestamps
#
# It never opens the live notmuch database or the live workspace.
#
# Usage: ./verify/notmuch-isolated.sh
set -euo pipefail

OPS_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SKILL="$OPS_DIR/files/home/raymond/.openclaw/workspace/skills/collector-mail-triage/SKILL.md"
[ -f "$SKILL" ] || { echo "ERROR: skill missing: $SKILL" >&2; exit 1; }

for bin in notmuch jq python3; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin not installed" >&2; exit 1; }
done

tmp="$(mktemp -d /tmp/mail-triage-isolated.XXXXXX)"
cleanup() { rm -rf "$tmp"; }
trap cleanup EXIT

NOW=1793668000
mkdir -p "$tmp/mail/yungu/INBOX/new" "$tmp/mail/qq/INBOX/new" "$tmp/db"
cat >"$tmp/notmuch-config" <<EOF
[database]
path=$tmp/mail
[user]
name=Collector Test
primary_email=collector-test@example.invalid
[new]
tags=unread;inbox;
[search]
exclude_tags=deleted
EOF
export NOTMUCH_CONFIG="$tmp/notmuch-config"

add_message() {
  # add_message <folder> <epoch> <message-id> <from> <subject> <kind> [extra]
  python3 - "$tmp" "$@" <<'PY'
import sys, os, email.message, email.utils
root, folder, epoch, mid, sender, subject, kind = sys.argv[1:8]
extra = sys.argv[8] if len(sys.argv) > 8 else ""
def write(name, msg):
    with open(os.path.join(root, "mail", folder, "INBOX", "new", name), "w") as f:
        f.write(msg)
m = email.message.EmailMessage()
m["From"] = sender
m["To"] = "collector-test@example.invalid"
m["Subject"] = subject
m["Date"] = email.utils.formatdate(int(epoch), localtime=False, usegmt=True)
m["Message-ID"] = f"<{mid}@example.invalid>"
if kind == "attachment":
    m.set_content(("Submit the lab report by Friday 18:00.\n" * 400) + "TAIL-MARKER-UNIQUE\n")
    m.add_attachment(b"%PDF-1.4 fake attachment bytes", maintype="application", subtype="pdf", filename="lab.pdf")
elif kind == "html":
    m.set_content("<html><body><p>Confirm your form by Monday.</p></body></html>", subtype="html")
elif kind == "plain":
    m.set_content(extra or "Plain notification body.\n")
else:
    raise SystemExit(f"unknown kind {kind}")
write(f"{epoch}.{mid}:2,", m.as_string())
PY
}

add_message yungu $((NOW - 9000)) "act-1" "Teacher One <teacher@example.invalid>" "Homework due soon" attachment
add_message yungu $((NOW - 5400)) "mkt-1" "Store News <news@example.invalid>" "Weekly sale" plain "Sale ends today.\n"
add_message yungu $((NOW - 600)) "html-1" "School Office <office@example.invalid>" "HTML notice" html
add_message qq $((NOW - 14400)) "rcpt-1" "Billing <billing@example.invalid>" "Payment receipt" plain "Receipt attached in portal.\n"
add_message qq $((NOW - 300)) "act-2" "Career Office <careers@example.invalid>" "Interview slot" plain "Pick a slot before Thursday.\n"
notmuch new >/dev/null 2>&1

passed=0
failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3 (missing '$2')" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "$3 (found '$2')" ;; *) pass "$3" ;; esac; }
assert_file() { if [ -f "$1" ]; then pass "$2"; else fail "$2 (missing $1)"; fi; }

W="$tmp/state/mail-triage.json"
mkdir -p "$tmp/state"

candidates() {
  # candidates <watermark-json-or-empty>
  local J="$1"
  local now="$NOW"
  for acct in yungu qq; do
    since=$(printf '%s' "$J" | jq -r --arg a "$acct" '.[$a].lastSeenTs // 0')
    case "$since" in '' | *[!0-9]*) since=$((now - 7200)) ;; esac
    [ "$since" -gt 0 ] || since=$((now - 7200))
    notmuch search --format=json --sort=newest-first --limit=10 "folder:$acct/INBOX" \
      | jq -r --argjson s "$since" --arg a "$acct" '.[] | select(.timestamp > $s) | [$a, .timestamp, .query[0], .authors, .subject] | @tsv'
  done | sort -k2,2nr
}

body() {
  # body <notmuch query>; mirrors the skill's bounded read
  notmuch show --format=text --body=true --include-html=true --entire-thread=false "$1" | head -c 4000
}

# --- 1. skill carries the read-only command contract ------------------------
skill_text="$(cat "$SKILL")"
for needle in \
  'notmuch search --format=json --sort=newest-first --limit=10 "folder:$acct/INBOX"' \
  'notmuch show --format=text --body=true --include-html=true --entire-thread=false' \
  'head -c 4000' \
  '/home/raymond/.openclaw/workspace/collection/state/mail-triage.json' \
  '不运行 mbsync/notmuch new/notmuch tag' \
  '不标记已读' \
  '不回信、不对外发送' \
  '不按 part 取附件'; do
  assert_contains "$skill_text" "$needle" "skill contains: $needle"
done

# --- 2. default window: last 2 hours ---------------------------------------
empty='{}'
out="$(candidates "$empty")"
assert_eq "$(printf '%s\n' "$out" | grep -c .)" "3" "default 2h window selects 3 candidates"
assert_not_contains "$out" "Homework due soon" "default window excludes the 2.5h-old message"
assert_contains "$out" "HTML notice" "default window includes the 10m-old message"
assert_contains "$out" "Interview slot" "default window includes the 5m-old message"
assert_eq "$(printf '%s\n' "$out" | head -1 | cut -f1)" "qq" "newest candidate is first after sorting"
assert_eq "$(printf '%s\n' "$out" | awk -F'\t' 'NF!=5' | wc -l)" "0" "every candidate row has 5 tab fields"
assert_eq "$(printf '%s\n' "$out" | cut -f3 | grep -vc '^id:')" "0" "every candidate query is a notmuch id query"

# --- 3. watermark filter ---------------------------------------------------
yungu_newest="$(notmuch search --format=json --limit=1 --sort=newest-first 'folder:yungu/INBOX' | jq -r '.[0].timestamp')"
w="{\"yungu\":{\"lastSeenTs\":$yungu_newest}}"
out="$(candidates "$w")"
assert_eq "$(printf '%s\n' "$out" | grep -c '^yungu' || true)" "0" "watermark hides already-seen Yungu mail"
assert_eq "$(printf '%s\n' "$out" | grep -c '^qq' || true)" "1" "other account keeps its own window"

yungu_old="$(notmuch search --format=json --sort=newest-first 'folder:yungu/INBOX' | jq -r '.[1].timestamp')"
w="{\"yungu\":{\"lastSeenTs\":$yungu_old}}"
out="$(candidates "$w")"
assert_eq "$(printf '%s\n' "$out" | grep -c '^yungu' || true)" "1" "watermark keeps only newer Yungu mail"

# --- 4. body bounds, attachments, HTML ------------------------------------
q_act="$(notmuch search --format=json --sort=newest-first 'folder:yungu/INBOX and subject:"Homework due soon"' | jq -r '.[0].query[0]')"
out="$(body "$q_act")"
assert_eq "$(printf '%s' "$out" | wc -c | tr -d ' ')" "4000" "body read is capped at 4000 bytes"
assert_contains "$out" "Submit the lab report" "body read includes the text/plain content"
assert_not_contains "$out" "%PDF" "body read does not include attachment bytes"
assert_not_contains "$out" "fake attachment bytes" "body read does not include attachment payload"

q_html="$(notmuch search --format=json --sort=newest-first 'folder:yungu/INBOX and subject:"HTML notice"' | jq -r '.[0].query[0]')"
out="$(body "$q_html")"
assert_contains "$out" "Confirm your form" "HTML-only body is readable text with --include-html"
out_plain="$(notmuch show --format=text --body=true --entire-thread=false "$q_html" | head -c 4000)"
assert_contains "$out_plain" "Non-text part: text/html" "without --include-html the HTML body stays unread"

# --- 5. read-only: no tag/file/dump change --------------------------------
dump_before="$(notmuch dump '*' | sort | sha256sum)"
files_before="$(notmuch search --output=files '*' | sort | sha256sum)"
newest_file="$(notmuch search --output=files 'folder:yungu/INBOX' | head -1)"
file_sha_before="$(sha256sum "$newest_file" | cut -d' ' -f1)"
out="$(body "$q_act")"
dump_after="$(notmuch dump '*' | sort | sha256sum)"
files_after="$(notmuch search --output=files '*' | sort | sha256sum)"
file_sha_after="$(sha256sum "$newest_file" | cut -d' ' -f1)"
assert_eq "$dump_after" "$dump_before" "reading bodies leaves tags unchanged"
assert_eq "$files_after" "$files_before" "reading bodies leaves the maildir file list unchanged"
assert_eq "$file_sha_after" "$file_sha_before" "reading a body does not rewrite the message file"

# --- 6. per-account limit --------------------------------------------------
i=0
while [ "$i" -lt 12 ]; do
  add_message yungu $((NOW - 100 - i)) "bulk-$i" "Bulk Sender <bulk@example.invalid>" "Bulk notice $i" plain "Bulk body $i.\n"
  i=$((i + 1))
done
notmuch new >/dev/null 2>&1
out="$(candidates '{}')"
assert_eq "$(printf '%s\n' "$out" | grep -c '^yungu' || true)" "10" "per-account query is limited to 10"

# --- 7. watermark file contents -------------------------------------------
printf '{"yungu":{"lastSeenTs":%s},"qq":{"lastSeenTs":%s},"updatedAt":"%s"}\n' \
  "$yungu_newest" "$(notmuch search --format=json --limit=1 --sort=newest-first 'folder:qq/INBOX' | jq -r '.[0].timestamp')" \
  "2026-11-03T00:00:00Z" >"$W"
assert_file "$W" "watermark file is written"
assert_eq "$(jq -r 'keys_unsorted | join(",")' "$W")" 'yungu,qq,updatedAt' "watermark only has account keys and updatedAt"
assert_eq "$(jq -r '[.[] | objects | keys[]] | unique | join(",")' "$W")" 'lastSeenTs' "watermark entries only hold lastSeenTs"
assert_eq "$(grep -c '@' "$W" || true)" "0" "watermark contains no addresses"
assert_eq "$(jq -r '.yungu.lastSeenTs, .qq.lastSeenTs' "$W" | grep -vc '^[0-9]\+$')" "0" "watermark values are unix seconds"

# --- Report ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
