#!/usr/bin/env bash
# Shared helpers for the collector Agenda-wording fix (M15).
#
# Five live surfaces are reconciled by one owner:
#   - cron payload.message: the collector dispatcher route
#   - collector-notify:      notification wording (Agenda-only, real actions only)
#   - collector-source-triage: source triage wording
#   - workspace AGENTS.md:   the unified-todo master-list rule
#   - collection/dingtalk-notify.mjs: the script's dedupe comment
#
# The two SKILL.md files and the cron message are deployed from package copies;
# AGENTS.md and dingtalk-notify.mjs are narrow anchored line patches so the
# package never embeds the operator's full workspace files.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

JOB_ID="6a45be21-ce0b-4b8b-8986-4c885d1ea659"
JOB_NAME="collector"
PAYLOAD_FILE="$OPS_DIR/payload-message.txt"
MANIFEST_FILE="$OPS_DIR/manifest.json"
PACKAGE_FILES_DIR="$OPS_DIR/files"
BASELINES_DIR="$OPS_DIR/baselines"
# Empty TARGET_ROOT is the host root; the offline simulator points it at a temp tree.
TARGET_ROOT="${CAWF_TARGET_ROOT:-}"
BACKUP_BASE="${CAWF_BACKUP_BASE:-$HOME/.openclaw/backups/collector-agenda-wording-fix}"
OPENCLAW_ROOT="${OPENCLAW_ROOT:-$(cd "$OPS_DIR/../.." && pwd)}"

SKILL_NAMES=(collector-notify collector-source-triage)
PATCH_PATHS=(
  "home/raymond/.openclaw/workspace/AGENTS.md"
  "home/raymond/.openclaw/workspace/collection/dingtalk-notify.mjs"
)

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

sha256_file() {
  sha256sum "$1" | cut -d' ' -f1
}

sha256_text() {
  printf '%s' "$1" | sha256sum | cut -d' ' -f1
}

file_bytes() {
  wc -c <"$1" | tr -d ' '
}

# json_field <dotted.path> reads a JSON document from stdin and prints the field.
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

# manifest_field <dotted.path> prints a value from manifest.json.
manifest_field() {
  [ -f "$MANIFEST_FILE" ] || die "manifest missing: $MANIFEST_FILE"
  node -e '
    const fs = require("node:fs");
    let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const p of process.argv[2].split(".")) {
      if (v === null || v === undefined) break;
      v = v[p];
    }
    if (v === undefined || v === null) process.exit(1);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$MANIFEST_FILE" "$1"
}

# package_field <kind> <path> <field> prints a manifest entry field.
package_entry() {
  node -e '
    const fs = require("node:fs");
    const [kind, target, field] = process.argv.slice(2);
    const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const list = kind === "file" ? m.files : m.patches;
    const entry = list.find((e) => e.path === target);
    if (!entry) process.exit(1);
    const v = entry[field];
    if (v === undefined || v === null) process.exit(1);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$MANIFEST_FILE" "$1" "$2" "$3"
}

target_file() {
  printf '%s' "${TARGET_ROOT}/$1"
}

target_sha() {
  local file
  file="$(target_file "$1")"
  if [ -f "$file" ]; then sha256_file "$file"; else printf 'missing'; fi
}

package_file_for() {
  printf '%s' "$PACKAGE_FILES_DIR/$1"
}

# package_sha <path> prints the reviewed package hash only while the file still
# matches manifest.deployedSha256. Content changed after review is refused
# before any target or backup is written.
package_sha() {
  local rel="$1" file actual expected
  file="$(package_file_for "$rel")"
  [ -f "$file" ] || die "package file missing: $file"
  actual="$(sha256_file "$file")"
  expected="$(package_entry file "$rel" deployedSha256)" || die "cannot read deployedSha256 for $rel"
  if [ "$actual" != "$expected" ]; then
    die "package file does not match the reviewed manifest hash.
  package:  $file
  actual:   $actual
  expected: $expected
Refusing to continue: the reviewed content is fixed in manifest.json.
No target or backup was written."
  fi
  printf '%s' "$actual"
}

# package_payload_text prints the reviewed payload with the authored trailing
# newline stripped, matching how `openclaw cron edit --message "$(cat file)"`
# stores the message.
package_payload_text() {
  local text
  text="$(cat "$PAYLOAD_FILE")"
  printf '%s' "$text"
}

package_payload_sha() {
  local actual expected
  actual="$(sha256_text "$(package_payload_text)")"
  expected="$(manifest_field cron.desiredMessageSha256)" || die "cannot read cron.desiredMessageSha256"
  if [ "$actual" != "$expected" ]; then
    die "payload file does not match the reviewed manifest hash.
  actual:   $actual
  expected: $expected"
  fi
  printf '%s' "$actual"
}

require_package() {
  local name rel
  [ -f "$PAYLOAD_FILE" ] || die "payload file missing: $PAYLOAD_FILE"
  [ -f "$MANIFEST_FILE" ] || die "manifest missing: $MANIFEST_FILE"
  for name in "${SKILL_NAMES[@]}"; do
    rel="home/raymond/.openclaw/workspace/skills/$name/SKILL.md"
    [ -f "$(package_file_for "$rel")" ] || die "package skill missing: $name"
  done
  [ -f "$BASELINES_DIR/collector-notify.pre-m15.md" ] || die "baseline fixture missing: collector-notify"
  [ -f "$BASELINES_DIR/collector-source-triage.pre-m15.md" ] || die "baseline fixture missing: collector-source-triage"
  [ -f "$BASELINES_DIR/payload-message.pre-m15.txt" ] || die "baseline fixture missing: payload"
}

# check_tokens <file> fails when a positive 便单 claim survives or a required
# anchor disappeared. A line that contains 便单 is allowed only when the same
# line carries an explicit prohibition marker (便单已停用 / 不要登记到便单).
check_tokens() {
  local file="$1"
  [ -f "$file" ] || {
    echo "cannot check missing file: $file" >&2
    return 1
  }
  node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const text = fs.readFileSync(process.argv[2], "utf8");
    const lines = text.split("\n");
    const problems = [];
    for (const line of lines) {
      if (!line.includes("便单")) continue;
      if (manifest.prohibitionMarkers.some((m) => line.includes(m))) continue;
      problems.push(`positive 便单 wording: ${line}`);
    }
    for (const token of manifest.forbiddenPositive) {
      if (text.includes(token)) problems.push(`forbidden positive token: ${token}`);
    }
    if (problems.length) {
      for (const p of problems) console.error(p);
      process.exit(1);
    }
  ' "$MANIFEST_FILE" "$file"
}

# check_required <file> <json array of anchors> verifies every anchor.
check_required() {
  local file="$1" anchors="$2"
  node -e '
    const fs = require("node:fs");
    const text = fs.readFileSync(process.argv[1], "utf8");
    const anchors = JSON.parse(process.argv[2]);
    const missing = anchors.filter((a) => !text.includes(a));
    if (missing.length) {
      for (const m of missing) console.error(`required anchor missing: ${m}`);
      process.exit(1);
    }
  ' "$file" "$anchors"
}

# patch_state <rel> prints applied | baseline | drift for an anchored patch.
patch_state() {
  local rel="$1" file
  file="$(target_file "$rel")"
  [ -f "$file" ] || {
    printf 'missing'
    return 0
  }
  node -e '
    const fs = require("node:fs");
    const [manifestPath, target, targetPath] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const entry = m.patches.find((e) => e.path === target);
    if (!entry) { console.error("no patch entry for " + target); process.exit(2); }
    const text = fs.readFileSync(targetPath, "utf8");
    let allNew = true, allOld = true;
    for (const r of entry.replacements) {
      allNew = allNew && text.split(r.new).length - 1 === 1 && !text.includes(r.old);
      allOld = allOld && text.split(r.old).length - 1 === 1 && !text.includes(r.new);
    }
    process.stdout.write(allNew ? "applied" : allOld ? "baseline" : "drift");
  ' "$MANIFEST_FILE" "$rel" "$file"
}

# patch_apply <rel> <src> <dst> applies the anchored replacements exactly once.
patch_apply() {
  local rel="$1" src="$2" dst="$3"
  node -e '
    const fs = require("node:fs");
    const [manifestPath, target, srcPath, dstPath] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const entry = m.patches.find((e) => e.path === target);
    if (!entry) { console.error("no patch entry for " + target); process.exit(2); }
    let text = fs.readFileSync(srcPath, "utf8");
    for (const r of entry.replacements) {
      const count = text.split(r.old).length - 1;
      if (count !== 1) {
        console.error(`patch anchor count ${count} (expected 1) for ${target}`);
        process.exit(3);
      }
      text = text.replace(r.old, r.new);
    }
    fs.writeFileSync(dstPath, text);
  ' "$MANIFEST_FILE" "$rel" "$src" "$dst"
}

# Snapshot of the fields deploy/rollback must leave untouched. Values are read
# from the live job, never hard-coded, so a parallel change is preserved.
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
      displayName: j.displayName ?? null,
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

# verify_skill_discovery <name> <expected absolute path> checks that the CLI
# discovers the deployed skill for the main agent and resolves it to this file.
verify_skill_discovery() {
  local name="$1" expected="$2" json
  if [ "${CAWF_SKIP_DISCOVERY:-0}" = "1" ]; then
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

# patch_after_sha <rel> prints the sha256 the anchored patch produces from the
# current file (the patch is deterministic once the anchor matches once).
patch_after_sha() {
  local rel="$1" target tmp sha
  target="$(target_file "$rel")"
  if [ "$(patch_state "$rel")" = "applied" ]; then
    sha256_file "$target"
    return 0
  fi
  tmp="$(mktemp)"
  patch_apply "$rel" "$target" "$tmp"
  sha="$(sha256_file "$tmp")"
  rm -f "$tmp"
  printf '%s' "$sha"
}

# deploy_patch_after_sha <backup-dir> <rel> prints the post-deploy hash recorded
# in deploy.json for an anchored patch.
deploy_patch_after_sha() {
  node -e '
    const fs = require("node:fs");
    const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const entry = (doc.patches || []).find((p) => p.path === process.argv[2]);
    if (!entry) process.exit(1);
    process.stdout.write(entry.afterSha256);
  ' "$1/deploy.json" "$2"
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

deploy_field() {
  node -e '
    const fs = require("node:fs");
    let v = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const p of process.argv[2].split(".")) {
      if (v === null || v === undefined) break;
      v = v[p];
    }
    if (v === undefined || v === null) process.exit(1);
    process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$1/deploy.json" "$2"
}
