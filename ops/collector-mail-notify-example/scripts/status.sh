#!/usr/bin/env bash
# Read-only status for the collector-notify mail example (M13).
#
# Prints the live sha256 and classifies it as up-to-date, baseline (needs
# deploy) or drift (neither). Writes nothing and calls no modifying command.
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

desired_sha="$(package_sha)"
current_sha="$(target_sha)"

info "package: sha256 $desired_sha ($(file_bytes "$PACKAGE_FILE") bytes)"
info "target: $TARGET_FILE"

if [ "$current_sha" = "missing" ]; then
  info "state: missing (expected the recorded baseline)"
elif [ "$current_sha" = "$desired_sha" ]; then
  info "state: up-to-date (sha256 $current_sha)"
elif [ "$current_sha" = "$BASELINE_SHA256" ]; then
  info "state: baseline (sha256 $current_sha, $(file_bytes "$TARGET_FILE") bytes) — needs deploy"
else
  info "state: drift (sha256 $current_sha, $(file_bytes "$TARGET_FILE") bytes)"
  info "neither the recorded baseline nor this package's content; review before deploying"
fi

if [ "$current_sha" != "missing" ]; then
  stale=()
  for token in "${FORBIDDEN_AFTER[@]}"; do
    if grep -Fq -- "$token" "$TARGET_FILE"; then
      stale+=("$token")
    fi
  done
  if [ "${#stale[@]}" -eq 0 ]; then
    info "stale tokens: none"
  else
    info "stale tokens: ${stale[*]}"
  fi
fi

if backup_dir="$(latest_backup_dir)"; then
  info "latest backup: $backup_dir"
else
  info "latest backup: none"
fi
