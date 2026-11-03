#!/usr/bin/env bash
# Shared helpers for the M20 visibility rollout.
#
# This package owns exactly one frontmatter line in six SKILL.md files. It does
# not copy skill bodies, touch cron/openclaw.json, change the skills budget or
# allowlist, or send messages.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$OPS_DIR/../.." && pwd)"
MANIFEST_FILE="$OPS_DIR/manifest.json"
APPLY_FLAG="$OPS_DIR/scripts/apply-flag.mjs"
COMPARE_CATALOG="$OPS_DIR/verify/compare-catalog.mjs"
CHECK_INFO="$OPS_DIR/verify/check-info.mjs"
NODE_BIN="${M20_NODE:-node}"
OPENCLAW_BIN="${M20_OPENCLAW_BIN:-openclaw}"

# Empty M20_OPENCLAW_HOME is the live ~/.openclaw; the simulator points it at a
# throwaway tree. Backups follow the same override so a simulation cannot write
# into the real backup directory.
OPENCLAW_HOME_DIR="${M20_OPENCLAW_HOME:-$HOME/.openclaw}"
BACKUP_BASE="${M20_BACKUP_BASE:-${M20_OPENCLAW_HOME:-$HOME/.openclaw}/backups/live-skill-visibility-simplification}"

die() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

warn() {
  echo "WARN: $*" >&2
}

sha256_file() {
  sha256sum "$1" | cut -d' ' -f1
}

file_bytes() {
  wc -c <"$1" | tr -d ' '
}

manifest_field() {
  [ -f "$MANIFEST_FILE" ] || die "manifest missing: $MANIFEST_FILE"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const part of process.argv[2].split(".")) {
      if (value === null || value === undefined) break;
      value = value[part];
    }
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(Array.isArray(value) ? JSON.stringify(value) : String(value));
  ' "$MANIFEST_FILE" "$1"
}

target_names() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const target of manifest.targets) process.stdout.write(`${target.name}\n`);
  ' "$MANIFEST_FILE"
}

target_field() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const target = manifest.targets.find((item) => item.name === process.argv[2]);
    if (!target) process.exit(1);
    let value = target;
    for (const part of process.argv[3].split(".")) {
      if (value === null || value === undefined) break;
      value = value[part];
    }
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(Array.isArray(value) ? JSON.stringify(value) : String(value));
  ' "$MANIFEST_FILE" "$1" "$2"
}

target_path() {
  printf '%s/%s' "$OPENCLAW_HOME_DIR" "$(target_field "$1" path)"
}

target_baseline_fixture() {
  printf '%s/%s' "$OPS_DIR" "$(target_field "$1" baselineFixture)"
}

# Prints a JSON field from a file (dot path).
json_file_field() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    let value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    for (const part of process.argv[2].split(".")) {
      if (value === null || value === undefined) break;
      value = value[part];
    }
    if (value === undefined || value === null) process.exit(1);
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  ' "$1" "$2"
}

# Prints a JSON field from stdin (dot path).
json_stream_field() {
  "$NODE_BIN" -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      let value = JSON.parse(text);
      for (const part of process.argv[1].split(".")) {
        if (value === null || value === undefined) break;
        value = value[part];
      }
      if (value === undefined || value === null) process.exit(1);
      process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
    });
  ' "$1"
}

json_set() {
  local file="$1" key="$2" value="$3"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const parts = process.argv[2].split(".");
    const value = process.argv[3];
    const root = JSON.parse(fs.readFileSync(file, "utf8"));
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      cursor[parts[i]] ??= {};
      cursor = cursor[parts[i]];
    }
    cursor[parts[parts.length - 1]] = value;
    fs.writeFileSync(file, `${JSON.stringify(root, null, 2)}\n`);
  ' "$file" "$key" "$value"
}

apply_check() {
  "$NODE_BIN" "$APPLY_FLAG" --file "$1" --name "$2" --check
}

apply_write() {
  "$NODE_BIN" "$APPLY_FLAG" --file "$1" --name "$2" --write
}

apply_verify() {
  "$NODE_BIN" "$APPLY_FLAG" --file "$1" --name "$2" --baseline "$3" --verify-insert-only
}

visible_count() {
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const skills = Array.isArray(parsed) ? parsed : parsed.skills;
    process.stdout.write(String(skills.filter((skill) => skill.modelVisible === true).length));
  ' "$1"
}

# True when the target's manifest list contains this repo-relative copy path.
list_has() {
  local name="$1" field="$2" relative="$3"
  "$NODE_BIN" -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const target = manifest.targets.find((item) => item.name === process.argv[2]);
    if (!target) process.exit(2);
    const list = target[process.argv[3]] ?? [];
    process.exit(list.includes(process.argv[4]) ? 0 : 1);
  ' "$MANIFEST_FILE" "$name" "$field" "$relative"
}

# Classifies a live hash against repository package copies.
#
# The six bodies have their own authors, so a repository copy is not automatically
# a stale copy: the target's currentOwnerCopies names the package that holds the
# current body (for collector-source-triage after M19 that is
# ops/collector-course-sync). Only copies outside that list are visibility
# restorations. Copies no list mentions still count as legacy so an unreviewed
# package copy cannot silently restore model visibility.
#
# Prints "owner<TAB>path" or "legacy<TAB>path"; returns 1 when no copy matches.
copy_match() {
  local name="$1" hash="$2" file relative declared_legacy="" other_legacy=""
  while IFS= read -r file; do
    [ "$(sha256_file "$file")" = "$hash" ] || continue
    relative="${file#"$REPO_ROOT"/}"
    if list_has "$name" currentOwnerCopies "$relative"; then
      printf 'owner\t%s\n' "$relative"
      return 0
    fi
    if list_has "$name" legacyCopies "$relative"; then
      [ -n "$declared_legacy" ] || declared_legacy="$relative"
    else
      [ -n "$other_legacy" ] || other_legacy="$relative"
    fi
  done < <(find "$REPO_ROOT/ops" -type f -path "*/files/*/$name/SKILL.md" 2>/dev/null | sort)
  if [ -n "$declared_legacy" ]; then
    printf 'legacy\t%s\n' "$declared_legacy"
    return 0
  fi
  if [ -n "$other_legacy" ]; then
    printf 'legacy\t%s\n' "$other_legacy"
    return 0
  fi
  return 1
}

# Classifies a visible target file. Prints one of:
#   baseline                      authoring baseline bytes, no owner copy matched
#   baseline-owner:<path>         authoring baseline bytes, current owner copy matches
#   owner:<path>                  current owner body, baseline moved on, flag absent
#   legacy:<path>                 bytes restored by an older package copy
#   drift                         none of the reviewed bodies
classify_visible_content() {
  local name="$1" path="$2" hash baseline_sha match kind="" copy_path=""
  hash="$(sha256_file "$path")"
  baseline_sha="$(target_field "$name" baselineSha256)"
  match="$(copy_match "$name" "$hash" || true)"
  if [ -n "$match" ]; then
    kind="${match%%$'\t'*}"
    copy_path="${match#*$'\t'}"
  fi
  if [ "$hash" = "$baseline_sha" ]; then
    if [ "$kind" = "owner" ]; then
      printf 'baseline-owner:%s' "$copy_path"
    else
      printf 'baseline'
    fi
    return 0
  fi
  case "$kind" in
    owner) printf 'owner:%s' "$copy_path" ;;
    legacy) printf 'legacy:%s' "$copy_path" ;;
    *) printf 'drift' ;;
  esac
}

new_backup_dir() {
  local ts dir n
  mkdir -p "$BACKUP_BASE"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  dir="$BACKUP_BASE/$ts"
  n=1
  while [ -e "$dir" ]; do
    dir="$BACKUP_BASE/$ts-$n"
    n=$((n + 1))
  done
  mkdir -p "$dir/targets"
  printf '%s' "$dir"
}

latest_backup_dir() {
  local candidate
  while IFS= read -r candidate; do
    if [ -f "$candidate/deploy.json" ]; then
      printf '%s' "${candidate%/}"
      return 0
    fi
  done < <(ls -1dt "$BACKUP_BASE"/*/ 2>/dev/null || true)
  return 1
}

# Restores all six targets from a backup directory. Returns nonzero if any file
# cannot be restored byte-for-byte to its recorded before hash.
restore_targets_from_backup() {
  local backup="$1" name path before before_sha restored_sha failed=0
  while IFS= read -r name; do
    path="$(target_path "$name")"
    before="$backup/targets/$name.before.md"
    if [ ! -f "$before" ]; then
      warn "backup missing before copy for $name"
      failed=1
      continue
    fi
    before_sha="$(sha256_file "$before")"
    cp -p "$before" "$path"
    restored_sha="$(sha256_file "$path")"
    if [ "$restored_sha" != "$before_sha" ]; then
      warn "restore hash mismatch for $name: $restored_sha != $before_sha"
      failed=1
    fi
  done < <(target_names)
  return "$failed"
}
