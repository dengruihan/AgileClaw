#!/usr/bin/env bash
# Shared helpers for the collector DingTalk detail-triage prompt deployment.
#
# The owner of the runtime behavior is the automation's embedded payload.message
# (`openclaw cron edit --message`). The trigger script, schedule, timeout, tool
# allow-list and description are not touched by deploy/rollback; they are only
# recorded before the edit and compared afterwards.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

JOB_ID="6a45be21-ce0b-4b8b-8986-4c885d1ea659"
JOB_NAME="collector"
PAYLOAD_FILE="$OPS_DIR/payload-message.txt"
BACKUP_BASE="${CDT_BACKUP_BASE:-$HOME/.openclaw/backups/collector-dingtalk-detail-triage}"
OPENCLAW_ROOT="${OPENCLAW_ROOT:-$(cd "$OPS_DIR/../.." && pwd)}"

# The live message and trigger at authoring time (2026-11-02, M4 language style
# already deployed). A mismatch means another change landed in between; deploy
# refuses unless the operator passes --allow-drift after reviewing the diff.
BASELINE_MESSAGE_SHA256="3422e6ed8a38d0e1169f508c16d951991ef9aaa6fd0d5436b0cea4d4845dd311"
BASELINE_TRIGGER_SHA256="2fefcf25abc694c645c1e856ec85433f2b5bff25ce72d938e2be92b8f53e3a91"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

openclaw_cli() {
  if [ -n "${OPENCLAW_CLI:-}" ]; then
    # Deliberate word splitting: OPENCLAW_CLI is a command plus optional args.
    # shellcheck disable=SC2086
    (cd "$OPENCLAW_ROOT" && $OPENCLAW_CLI "$@")
  else
    (cd "$OPENCLAW_ROOT" && openclaw "$@")
  fi
}

cli_display() {
  printf '%s' "${OPENCLAW_CLI:-openclaw}"
}

cron_json() {
  openclaw_cli cron get "$JOB_ID" --json 2>/dev/null || openclaw_cli cron get "$JOB_ID"
}

# json_field <dotted.path> reads a JSON document from stdin and prints the field.
# Arrays use numeric segments (payload.toolsAllow.0). Exits 1 when missing.
json_field() {
  node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let v;
      try { v = JSON.parse(s); } catch { process.exit(2); }
      for (const p of process.argv[1].split(".")) {
        if (v === null || v === undefined) break;
        v = v[p];
      }
      if (v === undefined || v === null) process.exit(1);
      process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
    });
  ' "$1"
}

sha256_text() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

sha256_file() {
  sha256sum "$1" | cut -d' ' -f1
}

require_payload() {
  [ -f "$PAYLOAD_FILE" ] || die "payload file missing: $PAYLOAD_FILE"
}

# Snapshot of the fields deploy/rollback must leave untouched.
job_facts_json() {
  local doc="$1"
  JOB_DOC="$doc" node -e '
    const j = JSON.parse(process.env.JOB_DOC);
    const out = {
      id: j.id,
      name: j.name ?? null,
      enabled: j.enabled ?? null,
      description: j.description ?? null,
      sessionTarget: j.sessionTarget ?? null,
      schedule: j.schedule ?? null,
      timeoutSeconds: j.payload?.timeoutSeconds ?? null,
      toolsAllow: j.payload?.toolsAllow ?? null,
      triggerSha256: j.trigger?.script ? require("node:crypto").createHash("sha256").update(j.trigger.script).digest("hex") : null,
    };
    process.stdout.write(JSON.stringify(out));
  '
}

pick_backup_dir() {
  local candidate
  while IFS= read -r candidate; do
    if [ -f "$candidate/deploy.json" ]; then
      printf '%s' "${candidate%/}"
      return 0
    fi
  done < <(ls -1dt "$BACKUP_BASE"/*/ 2>/dev/null || true)
  return 1
}
