#!/usr/bin/env bash
# Shared helpers for the collector-notify mail-example sync (M13).
#
# This package owns exactly one file: the live collector-notify SKILL.md.
# It never edits the dispatcher payload, the cron job, toolsAllow, trigger,
# openclaw.json or any other skill.
set -euo pipefail

OPS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SKILL_REL="home/raymond/.openclaw/workspace/skills/collector-notify/SKILL.md"
PACKAGE_FILE="$OPS_DIR/files/$SKILL_REL"
MANIFEST_FILE="$OPS_DIR/manifest.json"
# Empty TARGET_ROOT is the host root; the offline simulator points it at a temp tree.
TARGET_ROOT="${CMNE_TARGET_ROOT:-}"
TARGET_FILE="${TARGET_ROOT}/${SKILL_REL}"
BACKUP_BASE="${CMNE_BACKUP_BASE:-$HOME/.openclaw/backups/collector-mail-notify-example}"

# Live content on 2026-11-03 after M11 (light-effect fallback removed) and
# M12 (mail triage deployed): sha256 6be95ab3…, 2216 bytes. A different live
# sha means someone else changed the skill; deploy refuses unless --allow-drift.
BASELINE_SHA256="6be95ab380d8435300d5401e40639440814662849f623c778180fa3718d857dc"

# The replacement in manifest.json reconstructs this exact baseline; keep both
# lists in sync with verify/check-package.mjs.
FORBIDDEN_AFTER=(邮箱净增 "邮件正文不在收集范围" 打开邮箱查看 无法读取内容 灯效 light_control lightrules "ntf.cjs" "light send")
REQUIRED_AFTER=("- 邮件提醒：" 英语老师发来邮件 正文确实读不到就跳过那封 "collection/dingtalk-notify.mjs" "命令退出码 1 并打印失败原因")

die() {
  echo "ERROR: $*" >&2
  exit 1
}

info() {
  echo "==> $*"
}

sha256_file() {
  sha256sum "$1" | cut -d' ' -f1
}

file_bytes() {
  wc -c <"$1" | tr -d ' '
}

# manifest_field <dotted.path> prints a fixed value from manifest.json.
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

# package_sha prints the reviewed package hash only while the file still
# matches manifest.target.deployedSha256. A package changed after review is
# refused before deploy can write the target or create a backup.
package_sha() {
  [ -f "$PACKAGE_FILE" ] || die "package skill missing: $PACKAGE_FILE"
  local actual expected
  actual="$(sha256_file "$PACKAGE_FILE")"
  expected="$(manifest_field target.deployedSha256)" || die "cannot read manifest.target.deployedSha256"
  if [ "$actual" != "$expected" ]; then
    die "package file does not match the reviewed manifest hash.
  package:  $PACKAGE_FILE
  actual:   $actual
  expected: $expected
Refusing to continue: the reviewed content is fixed in manifest.json.
No target or backup was written."
  fi
  printf '%s' "$actual"
}

# Prints the target hash, or "missing".
target_sha() {
  if [ -f "$TARGET_FILE" ]; then
    sha256_file "$TARGET_FILE"
  else
    printf 'missing'
  fi
}

# check_tokens <file> fails when a stale or light-effect token survives, or a
# required anchor from the reviewed content disappeared. Returns 1 (without
# exiting) so deploy can restore its backup on failure.
check_tokens() {
  local file="$1" token
  [ -f "$file" ] || {
    echo "cannot check missing file: $file" >&2
    return 1
  }
  for token in "${FORBIDDEN_AFTER[@]}"; do
    if grep -Fq -- "$token" "$file"; then
      echo "forbidden token in $file: $token" >&2
      return 1
    fi
  done
  for token in "${REQUIRED_AFTER[@]}"; do
    if ! grep -Fq -- "$token" "$file"; then
      echo "required token missing from $file: $token" >&2
      return 1
    fi
  done
}

# Prints the newest backup directory that has a deploy.json, if any.
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

# deploy_field <backup-dir> <dotted.path> prints a field from deploy.json.
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
