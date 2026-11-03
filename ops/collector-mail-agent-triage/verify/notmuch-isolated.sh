#!/usr/bin/env bash
# Isolated notmuch check for the collector-mail-triage skill (stateless design).
#
# Builds a throwaway maildir + notmuch database with synthetic messages (all
# addresses use the reserved .invalid domain), then runs the same read-only
# commands the skill instructs the agent to run. It proves:
#   - lookup is stateless: no progress/watermark file is created or read
#   - the per-account query is bounded (20) and every returned candidate is
#     processed, with no top-N round cap that could starve older mail
#   - messages that failed a body read are still returned by the next lookup
#   - a failed notmuch search/show is reported as a failure, not an empty result
#   - body output is capped at 4000 bytes, includes text/plain and HTML text,
#     and never includes attachment bytes
#   - reading messages changes no tags, no maildir files and no flags
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
  # add_message <folder> <epoch> <message-id> <from> <subject> <kind> [body]
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

# Mirrors the skill block: stateless, per-account limit 20, all returned rows
# processed (no top-N round cut), and explicit notmuch/jq failure detection.
candidates() (
  set -o pipefail
  rows=$(for acct in yungu qq; do
    raw=$(notmuch search --format=json --sort=newest-first --limit=20 "folder:$acct/INBOX") || { echo "NOTMUCH_SEARCH_FAILED:$acct" >&2; exit 2; }
    printf '%s' "$raw" | jq -r --arg a "$acct" '.[] | [$a, .timestamp, .query[0], .authors, .subject] | @tsv' || { echo "JQ_FAILED:$acct" >&2; exit 2; }
  done | sort -k2,2nr) || exit 2
  printf '%s\n' "$rows"
)

body() (
  set +o pipefail
  out=$(notmuch show --format=text --body=true --include-html=true --entire-thread=false "$1") || { echo 'NOTMUCH_SHOW_FAILED' >&2; exit 3; }
  printf '%s' "$out" | head -c 4000
)

passed=0
failed=0
pass() { passed=$((passed + 1)); printf 'PASS %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf 'FAIL %s\n' "$1"; }
assert_eq() { if [ "$1" = "$2" ]; then pass "$3"; else fail "$3 (got '$1', want '$2')"; fi; }
assert_contains() { case "$1" in *"$2"*) pass "$3" ;; *) fail "$3 (missing '$2')" ;; esac; }
assert_not_contains() { case "$1" in *"$2"*) fail "$3 (found '$2')" ;; *) pass "$3" ;; esac; }
assert_ne() { if [ "$1" != "$2" ]; then pass "$3"; else fail "$3 (both '$1')"; fi; }

ids() { cut -f3 | sort; }
count_rows() { grep -c . || true; }

# --- 1. skill contract: stateless, bounded, failure-detecting ----------------
skill_text="$(cat "$SKILL")"
for needle in \
  'set -o pipefail' \
  'raw=$(notmuch search --format=json --sort=newest-first --limit=20 "folder:$acct/INBOX")' \
  'NOTMUCH_SEARCH_FAILED' \
  'JQ_FAILED' \
  'body=$(notmuch show --format=text --body=true --include-html=true --entire-thread=false' \
  'NOTMUCH_SHOW_FAILED' \
  'head -c 4000' \
  '逐项判断' \
  '不额外按排序截断候选' \
  '不创建、不读取、不写入任何水位/进度/缓存文件' \
  '不新增数据库或表' \
  '下一次唤醒时仍在候选里' \
  '同一封邮件可能在相邻轮次重复出现' \
  '登记前按 schedule-sweep 查重' \
  '不运行 mbsync/notmuch new/notmuch tag' \
  '不标记已读' \
  '不回信、不对外发送' \
  '不按 part 取附件'; do
  assert_contains "$skill_text" "$needle" "skill contains: $needle"
done
assert_not_contains "$skill_text" "lastSeenTs" "skill has no watermark field"
assert_not_contains "$skill_text" "mail-triage.json" "skill has no sidecar state file"
assert_not_contains "$skill_text" "collection/state/mail-triage" "skill has no collection state path"
assert_eq "$(printf '%s' "$skill_text" | grep -Ec 'notmuch[[:space:]]+tag[[:space:]]+[+-]' || true)" "0" "skill never tags"
assert_eq "$(printf '%s' "$skill_text" | grep -Ec '> *\/home\/[^ ]*collection\/state' || true)" "0" "skill never writes collection state"

# --- 2. stateless lookup over the base mailbox ------------------------------
full="$(candidates)"
assert_eq "$(printf '%s\n' "$full" | count_rows)" "5" "initial lookup returns all 5 messages"
assert_eq "$(printf '%s\n' "$full" | awk -F'\t' 'NF!=5' | count_rows)" "0" "every candidate row has 5 tab fields"
assert_eq "$(printf '%s\n' "$full" | cut -f3 | grep -vc '^id:' || true)" "0" "every candidate query is a notmuch id query"
assert_eq "$(printf '%s\n' "$full" | tail -1 | cut -f1)" "qq" "rows are sorted newest-first"
[ ! -e "$tmp/state" ] && pass "lookup creates no state directory" || fail "lookup created a state directory"

# --- 3. body bounds, attachments, HTML ------------------------------------
q_act="$(notmuch search --format=json --sort=newest-first 'folder:yungu/INBOX and subject:"Homework due soon"' | jq -r '.[0].query[0]')"
out="$(body "$q_act")"
assert_eq "$(printf '%s' "$out" | wc -c | tr -d ' ')" "4000" "body read is capped at 4000 bytes"
assert_contains "$out" "Submit the lab report" "body read includes the text/plain content"
assert_not_contains "$out" "%PDF" "body read does not include attachment bytes"
assert_not_contains "$out" "fake attachment bytes" "body read does not include attachment payload"

q_html="$(notmuch search --format=json --sort=newest-first 'folder:yungu/INBOX and subject:"HTML notice"' | jq -r '.[0].query[0]')"
out="$(body "$q_html")"
assert_contains "$out" "Confirm your form" "HTML-only body is readable text with --include-html"
out_plain="$(notmuch show --format=text --body=true --entire-thread=false "$q_html" | cut -b1-4000)"
assert_contains "$out_plain" "Non-text part: text/html" "without --include-html the HTML body stays unread"

# --- 4. read-only: no tag/file/dump change --------------------------------
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

# --- 5. >8 candidates: every candidate is returned, none truncated --------
i=0
while [ "$i" -lt 6 ]; do
  add_message yungu $((NOW - 1000 - i)) "cap8-$i" "Bulk Sender <bulk@example.invalid>" "Bulk notice $i" plain "Bulk body $i.\n"
  i=$((i + 1))
done
notmuch new >/dev/null 2>&1
first="$(candidates)"
assert_eq "$(printf '%s\n' "$first" | count_rows)" "11" "lookup returns all 11 candidates (no >8 round cut)"
second="$(candidates)"
assert_eq "$(printf '%s\n' "$second" | count_rows)" "11" "next lookup still returns all 11 candidates"
missing="$(comm -23 <(printf '%s\n' "$first" | ids) <(printf '%s\n' "$second" | ids))"
assert_eq "$missing" "" "no candidate disappears between lookups"

# --- 6. >10 candidates: every candidate is returned, none truncated -------
i=0
while [ "$i" -lt 10 ]; do
  add_message yungu $((NOW - 500 + i)) "cap10-$i" "Bulk Sender <bulk@example.invalid>" "More bulk $i" plain "More body $i.\n"
  i=$((i + 1))
done
notmuch new >/dev/null 2>&1
first="$(candidates)"
assert_eq "$(printf '%s\n' "$first" | count_rows)" "21" "lookup returns all 21 candidates (no >10 round cut)"
second="$(candidates)"
assert_eq "$(printf '%s\n' "$second" | count_rows)" "21" "next lookup still returns all 21 candidates"
missing="$(comm -23 <(printf '%s\n' "$first" | ids) <(printf '%s\n' "$second" | ids))"
assert_eq "$missing" "" "no candidate disappears between lookups"

# --- 7. body read failure does not hide or consume the message ------------
out="$(body "$q_act")"
assert_contains "$out" "Submit the lab report" "healthy body read succeeds before the failure test"
set +e
out_bad="$(NOTMUCH_CONFIG="$tmp/no-such-config" body "$q_act" 2>&1)"
code_bad=$?
set -e
assert_ne "$code_bad" "0" "body read failure exits non-zero"
assert_contains "$out_bad" "NOTMUCH_SHOW_FAILED" "body read failure is reported explicitly"
full_after="$(candidates)"
assert_eq "$(printf '%s\n' "$full_after" | cut -f3 | grep -Fxc "$q_act" || true)" "1" "failed message is still returned next lookup"

# --- 8. search/jq failure is not an empty success -------------------------
set +e
out_bad="$(NOTMUCH_CONFIG="$tmp/no-such-config" candidates 2>&1)"
code_bad=$?
set -e
assert_ne "$code_bad" "0" "candidate search failure exits non-zero"
assert_contains "$out_bad" "NOTMUCH_SEARCH_FAILED" "candidate search failure is reported explicitly"

# --- 9. per-account query cap --------------------------------------------
i=0
while [ "$i" -lt 5 ]; do
  add_message yungu $((NOW - 400 - i)) "cap20-$i" "Bulk Sender <bulk@example.invalid>" "Cap20 notice $i" plain "Cap20 body $i.\n"
  i=$((i + 1))
done
notmuch new >/dev/null 2>&1
full="$(candidates)"
assert_eq "$(printf '%s\n' "$full" | grep -c '^yungu' || true)" "20" "per-account lookup is capped at 20"
assert_eq "$(printf '%s\n' "$full" | grep -c '^qq' || true)" "2" "the other account keeps its own rows"
assert_eq "$(printf '%s\n' "$full" | count_rows)" "22" "lookup stays bounded across accounts"

# --- 10. still no state after all lookups/reads ---------------------------
[ ! -e "$tmp/state" ] && pass "no state directory was created by any lookup/read" || fail "a state directory appeared"
[ ! -e "$tmp/mail-triage.json" ] && pass "no sidecar progress file was created" || fail "a sidecar progress file appeared"

# --- Report ----------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
