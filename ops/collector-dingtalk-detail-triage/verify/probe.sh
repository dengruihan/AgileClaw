#!/usr/bin/env bash
# Read-only proof of the triage lookup for one conversation.
#
# Runs the same dws calls the new prompt prescribes and prints a redacted
# decision summary: no message text, no full conversation id, no personal
# userId. Nothing is sent, no conversation is marked read.
#
# Usage: verify/probe.sh --cid <openConversationId> [--pretty]
set -euo pipefail

cid=""
pretty=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --cid) cid="${2:-}"; shift 2 ;;
    --pretty) pretty=1; shift ;;
    -h|--help)
      echo "Usage: verify/probe.sh --cid <openConversationId> [--pretty]"
      exit 0
      ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ -n "$cid" ] || { echo "ERROR: --cid is required" >&2; exit 1; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

failed=""
record() { # record <name> <command...>
  local name="$1"
  shift
  if dws "$@" >"$tmp/$name.json" 2>"$tmp/$name.err"; then
    return 0
  fi
  failed="${failed:+$failed,}$name"
  return 1
}

user_id=""
if record me contact +me --format json; then
  user_id="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j?.data?.userId||"")' "$tmp/me.json")"
fi
if [ -z "$user_id" ] && record me-current contact user current --format json; then
  user_id="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j?.result?.[0]?.orgEmployeeModel?.userId||"")' "$tmp/me-current.json")"
fi
[ -n "$user_id" ] || { echo "ERROR: could not resolve the current userId" >&2; exit 1; }

# Primary mapping: userId -> openDingTalkId via the contact directory.
record search contact user search --query "$user_id" --format json || true
record chat-list chat +chat-list --types group,p2p --page-size 100 --sort active_time --format json || true
record unread-chats chat +unread-chats --count 100 --format json || true
record messages chat +chat-messages --group "$cid" --limit 15 --format json || true
# Fallback mapping: resolvedFilters is returned even when a group sender
# filter yields zero messages, so never use the message count as the signal.
record self-messages chat +chat-messages --group "$cid" --sender "$user_id" --limit 1 --format json || true

CID="$cid" USER_ID="$user_id" TMP="$tmp" FAILED="$failed" PRETTY="$pretty" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const cid = process.env.CID;
const userId = process.env.USER_ID;
const dir = process.env.TMP;
const failed = (process.env.FAILED || "").split(",").filter(Boolean);
const read = (name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
  } catch {
    return null;
  }
};
const cidMask = (value) => (value && value.length > 9 ? `${value.slice(0, 9)}…` : value ?? null);
const idSuffix = (value) => (value && value.length > 8 ? `…${value.slice(-8)}` : value ?? null);

const chats = read("chat-list")?.chats ?? [];
const unreadDoc = read("unread-chats");
const messages = read("messages")?.messages ?? [];
const searchHits = read("search")?.result ?? [];
const fallbackHits = read("self-messages")?.resolvedFilters?.senders ?? [];

const chat = chats.find((c) => c.openConversationId === cid) || null;
const unreadListed = JSON.stringify(unreadDoc ?? {}).includes(cid);
const newest = messages[0] ?? null;

const searchHit = searchHits.find((u) => u.userId === userId) ?? null;
const fallbackHit =
  fallbackHits.find((s) => s.selected?.userId === userId)?.selected ?? null;
const selfSenderId = searchHit?.openDingTalkId ?? fallbackHit?.openDingTalkId ?? null;
const selfSenderIdSource = searchHit?.openDingTalkId
  ? "contact-user-search"
  : fallbackHit?.openDingTalkId
    ? "resolvedFilters"
    : null;

const newestFromSelf = Boolean(
  newest && selfSenderId && newest.senderId === selfSenderId,
);
const unread = Boolean((chat && Number(chat.unreadPoint) > 0) || unreadListed);
const totalTextChars = messages.reduce(
  (sum, m) => sum + (typeof m.text === "string" ? m.text.length : 0),
  0,
);

const out = {
  readOnly: true,
  cid: cidMask(cid),
  conversationFound: Boolean(chat),
  queriesFailed: failed,
  selfSenderId: {
    resolved: Boolean(selfSenderId),
    source: selfSenderIdSource,
    suffix: idSuffix(selfSenderId),
  },
  newest: newest
    ? {
        createTime: newest.createTime ?? null,
        senderIdSuffix: idSuffix(newest.senderId ?? null),
        hasText: typeof newest.text === "string" && newest.text.length > 0,
      }
    : null,
  messageCount: messages.length,
  totalTextChars,
  selfSenderIdMatchesNewest: newestFromSelf,
  unreadPoint: chat?.unreadPoint ?? null,
  listedInUnreadChats: unreadListed,
  decision: {
    activityFromSelf: newestFromSelf,
    unreplied: !newestFromSelf,
    unread,
    action: newestFromSelf
      ? "skip: newest activity is from the user"
      : "triage: read the body, @/question/deadline and unread state",
  },
};

const allowPartial =
  Boolean(selfSenderId) &&
  !failed.includes("messages") &&
  Boolean(newest) &&
  !(failed.includes("chat-list") && failed.includes("unread-chats"));
console.log(JSON.stringify(out, null, process.env.PRETTY === "1" ? 2 : 0));
if (!allowPartial) process.exit(1);
NODE
