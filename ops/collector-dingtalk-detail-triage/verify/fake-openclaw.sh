#!/usr/bin/env bash
# Minimal fake of the `openclaw cron get/edit` surface used by scripts/*.sh.
# Test-only: never touches the real Gateway. State lives in FAKE_STATE.
set -euo pipefail

state="${FAKE_STATE:?FAKE_STATE is required}"
[ -f "$state" ] || { echo "fake state missing: $state" >&2; exit 2; }

cmd="${1:-}"
shift || true
[ "$cmd" = "cron" ] || { echo "fake: unsupported command $cmd" >&2; exit 2; }
sub="${1:-}"
shift || true

case "$sub" in
  get)
    if [ -f "$state.nextget" ]; then
      mode="$(cat "$state.nextget")"
      case "$mode" in
        fail)
          echo "fake: simulated cron get failure" >&2
          exit 3
          ;;
        badjson)
          printf '{"broken":'
          exit 0
          ;;
      esac
    fi
    cat "$state"
    ;;
  edit)
    message=""
    has_message=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --message)
          message="${2:-}"
          has_message=1
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    [ "$has_message" -eq 1 ] || { echo "fake: only --message is supported" >&2; exit 2; }
    FAKE_STATE="$state" FAKE_MESSAGE="$message" node -e '
      const fs = require("node:fs");
      const job = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, "utf8"));
      job.payload.message = process.env.FAKE_MESSAGE;
      if (process.env.FAKE_CORRUPT === "1") job.trigger.script += "\n// simulated trigger drift";
      fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(job));
    '
    if [ -n "${FAKE_FAIL_NEXT_GET:-}" ]; then
      printf 'fail' >"$state.nextget"
    elif [ -n "${FAKE_BAD_JSON_NEXT_GET:-}" ]; then
      printf 'badjson' >"$state.nextget"
    fi
    ;;
  *)
    echo "fake: unsupported cron subcommand $sub" >&2
    exit 2
    ;;
esac
