#!/usr/bin/env bash
# Shared helpers for the collector mail-triage deployment package (M12).
#
# The behavior owners after this cutover:
#   - automation payload.message: which skill to read for each wake reason
#   - collector-mail-triage:      notmuch read-only lookup + mail triage
#   - collector-source-triage:    Yungu/OSH triage only (no mail)
#   - collector-notify:           notification wording/channel (M11-owned, not written here)
#   - schedule-sweep:             agenda registration, scheduling and dedupe rules
#
# deploy/rollback only write payload.message and the two SKILL.md files above.
# The trigger script, schedule, timeout, toolsAllow, lightContext, description
# and delivery are captured from the live job before the edit and compared
# afterwards, so concurrent changes such as M11's toolsAllow cleanup survive.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

JOB_ID="6a45be21-ce0b-4b8b-8986-4c885d1ea659"
JOB_NAME="collector"
PAYLOAD_FILE="$OPS_DIR/payload-message.txt"
PACKAGE_SKILLS_DIR="$OPS_DIR/files/home/raymond/.openclaw/workspace/skills"
SKILL_NAMES=(collector-mail-triage collector-source-triage)
# Skills written by this package, with the live content they replace. Any
# other value means someone changed the file after M10; deploy refuses unless
# --force-skills is passed.
BASELINE_SKILL_SHA256_collector_mail_triage="missing"
BASELINE_SKILL_SHA256_collector_source_triage="34f128971ff4207b85799cfad7c666ae26f4373a37572b825316781a13e0a3c1"
# Empty TARGET_ROOT is the host root. The offline simulator sets it to a temp
# tree so no live file is ever touched.
TARGET_ROOT="${CDMT_TARGET_ROOT:-}"
WORKSPACE_SKILLS_DIR="${TARGET_ROOT}/home/raymond/.openclaw/workspace/skills"
SCHEDULE_SWEEP_FILE="${TARGET_ROOT}/home/raymond/.openclaw/agents/main/agent/workshop-skills/schedule-sweep/SKILL.md"
BACKUP_BASE="${CDMT_BACKUP_BASE:-$HOME/.openclaw/backups/collector-mail-agent-triage}"
OPENCLAW_ROOT="${OPENCLAW_ROOT:-$(cd "$OPS_DIR/../.." && pwd)}"

# Live values captured 2026-11-03 after the M10 skill-dispatcher cutover:
# payload.message is the M10 dispatcher (sha 7315a8...). A different live
# message means another change landed; deploy refuses unless --allow-drift is
# passed after reviewing the diff.
BASELINE_MESSAGE_SHA256="7315a8a3b51385bbbfb808ed52062ac966aa6bd181af3217bd82d336f22c44ea"

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

require_package() {
  [ -f "$PAYLOAD_FILE" ] || die "payload file missing: $PAYLOAD_FILE"
  [ -f "$SCHEDULE_SWEEP_FILE" ] || die "schedule-sweep skill missing: $SCHEDULE_SWEEP_FILE"
  local name
  for name in "${SKILL_NAMES[@]}"; do
    [ -f "$PACKAGE_SKILLS_DIR/$name/SKILL.md" ] || die "package skill missing: $name"
  done
}

skill_source_file() {
  printf '%s' "$PACKAGE_SKILLS_DIR/$1/SKILL.md"
}

skill_target_dir() {
  printf '%s' "$WORKSPACE_SKILLS_DIR/$1"
}

skill_target_file() {
  printf '%s' "$WORKSPACE_SKILLS_DIR/$1/SKILL.md"
}

# Prints the target SKILL.md hash, or "missing".
skill_target_sha() {
  local file
  file="$(skill_target_file "$1")"
  if [ -f "$file" ]; then
    sha256_file "$file"
  else
    printf 'missing'
  fi
}

skill_baseline_sha() {
  case "$1" in
    collector-mail-triage) printf '%s' "$BASELINE_SKILL_SHA256_collector_mail_triage" ;;
    collector-source-triage) printf '%s' "$BASELINE_SKILL_SHA256_collector_source_triage" ;;
    *) die "no baseline recorded for skill $1" ;;
  esac
}

# Snapshot of the fields deploy/rollback must leave untouched. Values are read
# from the live job, never hard-coded, so a parallel change (for example M11
# removing light_control from toolsAllow) is preserved byte-for-byte.
job_facts_json() {
  local doc="$1"
  JOB_DOC="$doc" node -e '
    const crypto = require("node:crypto");
    const j = JSON.parse(process.env.JOB_DOC);
    const out = {
      id: j.id,
      name: j.name ?? null,
      enabled: j.enabled ?? null,
      description: j.description ?? null,
      sessionTarget: j.sessionTarget ?? null,
      wakeMode: j.wakeMode ?? null,
      schedule: j.schedule ?? null,
      payloadKind: j.payload?.kind ?? null,
      timeoutSeconds: j.payload?.timeoutSeconds ?? null,
      toolsAllow: j.payload?.toolsAllow ?? null,
      lightContext: j.payload?.lightContext ?? null,
      delivery: j.delivery ?? null,
      triggerSha256: j.trigger?.script
        ? crypto.createHash("sha256").update(j.trigger.script).digest("hex")
        : null,
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

# verify_skill_discovery <name> <expected absolute path> checks that the running
# Gateway CLI discovers the newly deployed skill for the main agent, exposes it
# to the model, and resolves it to the file this package deployed.
# Skipped only by the offline simulator (CDMT_SKIP_DISCOVERY=1).
verify_skill_discovery() {
  local name="$1" expected="$2" json
  if [ "${CDMT_SKIP_DISCOVERY:-0}" = "1" ]; then
    return 0
  fi
  if ! json="$(openclaw_cli skills info "$name" --agent main --json)"; then
    echo "skills info failed for $name" >&2
    return 1
  fi
  printf '%s' "$json" | EXPECTED="$expected" node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      let j;
      try { j = JSON.parse(s); } catch { process.exit(2); }
      if (j.eligible !== true) { console.error("not eligible"); process.exit(3); }
      if (j.modelVisible !== true) { console.error("not modelVisible"); process.exit(4); }
      if (j.filePath !== process.env.EXPECTED) {
        console.error(`resolved to ${j.filePath}, expected ${process.env.EXPECTED}`);
        process.exit(5);
      }
    });
  '
}
