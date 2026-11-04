#!/usr/bin/env bash
# Minimal fake `openclaw` CLI for the offline deploy/rollback simulator.
# It only implements `cron get`, `cron edit --message` and `skills info --json`.
set -euo pipefail

job_file="${FAKE_JOB_FILE:?FAKE_JOB_FILE is required}"
state_dir="${FAKE_STATE_DIR:?FAKE_STATE_DIR is required}"
mkdir -p "$state_dir"

edits_count() {
  cat "$state_dir/edits" 2>/dev/null || printf '0'
}

cmd="${1:-}"
shift || true
case "$cmd" in
  cron)
    sub="${1:-}"
    shift || true
    case "$sub" in
      get)
        if [ "${FAKE_BAD_GET_AFTER_EDIT:-0}" = "1" ] && [ "$(edits_count)" -gt 0 ]; then
          printf '{not valid json'
          exit 0
        fi
        cat "$job_file"
        ;;
      edit)
        message=""
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --message)
              message="${2:-}"
              shift 2
              ;;
            *)
              shift
              ;;
          esac
        done
        if [ "${FAKE_EDIT_FAIL:-0}" = "1" ]; then
          echo "fake openclaw: cron edit failed" >&2
          exit 1
        fi
        MESSAGE="$message" node -e '
          const fs = require("node:fs");
          const file = process.argv[1];
          const job = JSON.parse(fs.readFileSync(file, "utf8"));
          job.payload.message = process.env.MESSAGE;
          fs.writeFileSync(file, JSON.stringify(job, null, 2) + "\n");
        ' "$job_file"
        printf '%s\n' "$(( $(edits_count) + 1 ))" >"$state_dir/edits"
        printf '{"ok":true}\n'
        ;;
      *)
        echo "fake openclaw: unsupported cron command: $sub" >&2
        exit 2
        ;;
    esac
    ;;
  skills)
    sub="${1:-}"
    shift || true
    case "$sub" in
      info)
        name="${1:-}"
        file="${CDMT_TARGET_ROOT:-}/home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
        if [ -f "$file" ]; then
          NAME="$name" FILE="$file" node -e '
            process.stdout.write(
              JSON.stringify({
                name: process.env.NAME,
                eligible: true,
                modelVisible: true,
                filePath: process.env.FILE,
              }) + "\n",
            );
          '
        else
          NAME="$name" node -e '
            process.stdout.write(
              JSON.stringify({ name: process.env.NAME, eligible: false, modelVisible: false }) + "\n",
            );
          '
        fi
        ;;
      *)
        echo "fake openclaw: unsupported skills command: $sub" >&2
        exit 2
        ;;
    esac
    ;;
  *)
    echo "fake openclaw: unsupported command: $cmd" >&2
    exit 2
    ;;
esac
