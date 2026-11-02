#!/usr/bin/env bash
# Assemble offline verification trees under verify/.scratch/:
#   .scratch/pristine/node_modules/@dingtalk-real-ai/dingtalk-connector  — byte-identical copy of the installed plugin
#   .scratch/patched/node_modules/@dingtalk-real-ai/dingtalk-connector   — same copy + direct-reply-mode patch applied
#
# Dependency resolution mirrors the real install (deps resolve from the
# project-root node_modules, openclaw peer from the connector's own
# node_modules) with one deliberate difference: axios is replaced by the
# offline stub in stub-axios/, which records every DingTalk HTTP call.
#
# Usage: DT_CONNECTOR_INSTALL=/path/to/connector ./build-scratch.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
install_root="${DT_CONNECTOR_INSTALL:-/home/raymond/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector}"
scratch_root="$here/.scratch"
proj_nm="$(cd "$install_root/../.." && pwd)" # projects/<slug>/node_modules

[ -d "$install_root/dist" ] || { echo "connector install not found: $install_root" >&2; exit 1; }

rm -rf "$scratch_root"
mkdir -p "$scratch_root/pristine/node_modules" "$scratch_root/patched/node_modules"

for variant in pristine patched; do
  nm="$scratch_root/$variant/node_modules"
  mkdir -p "$nm/@dingtalk-real-ai"
  cp -R "$install_root" "$nm/@dingtalk-real-ai/dingtalk-connector"
  pkg="$nm/@dingtalk-real-ai/dingtalk-connector"

  # Same peer layout as the real install: connector/node_modules/openclaw only.
  rm -rf "$pkg/node_modules"
  mkdir -p "$pkg/node_modules"
  ln -s "$install_root/node_modules/openclaw" "$pkg/node_modules/openclaw"

  # Everything else resolves from the project root, like the real install —
  # except axios, which points at the offline stub.
  for dep in "$proj_nm"/*; do
    name="$(basename "$dep")"
    case "$name" in
      axios|@dingtalk-real-ai|.bin|.package-lock.json) continue ;;
    esac
    ln -s "$dep" "$nm/$name"
  done
  ln -s "$here/stub-axios" "$nm/axios"

  if [ "$variant" = "patched" ]; then
    (cd "$pkg" && patch -p1 --forward < "$here/../patches/dingtalk-connector-0.8.27-direct-reply-mode.patch" >/dev/null)
  fi
done

node -e "console.log('scratch ready:', require('fs').existsSync('$scratch_root/patched/node_modules/@dingtalk-real-ai/dingtalk-connector/dist/message-handler-C8eu5xwl.mjs') ? 'ok' : 'missing')"
