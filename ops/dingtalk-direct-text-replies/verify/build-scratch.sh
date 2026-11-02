#!/usr/bin/env bash
# Assemble offline verification trees under verify/.scratch/:
#   .scratch/pristine/node_modules/@dingtalk-real-ai/dingtalk-connector  — upstream 0.8.27 tarball bytes
#   .scratch/patched/node_modules/@dingtalk-real-ai/dingtalk-connector   — same bytes + direct-reply-mode patch
#
# Plugin bytes come from the integrity-pinned npm tarball (not from whatever is
# currently installed), so the harness keeps proving the patch against upstream
# even after the local package is deployed. Dependency resolution mirrors the
# real install (deps resolve from the project-root node_modules, openclaw peer
# from the connector's own node_modules) with one deliberate difference: axios
# is replaced by the offline stub in stub-axios/, which records every DingTalk
# HTTP call.
#
# Usage: ./build-scratch.sh [--upstream <0.8.27.tgz>]
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ops="$(cd "$here/.." && pwd)"
scratch_root="$here/.scratch"

upstream_name="@dingtalk-real-ai/dingtalk-connector"
upstream_version="0.8.27"
upstream_integrity="sha512-4RwylwBTTQpzIlNBOtfFnlbY/X2LFwULTbp6z1Eo3duTj86ZXy0Inilqkght+uZJgbU0/8K1kEbbwMDptagkQg=="

install_root="${DT_CONNECTOR_INSTALL:-/home/raymond/.openclaw/npm/projects/dingtalk-real-ai-dingtalk-connector-aa54111b45/node_modules/@dingtalk-real-ai/dingtalk-connector}"
proj_nm="$(cd "$install_root/../.." && pwd)" # projects/<slug>/node_modules

[ -d "$proj_nm" ] || { echo "dependency root not found: $proj_nm (set DT_CONNECTOR_INSTALL)" >&2; exit 1; }

upstream_tgz="${DT_UPSTREAM_TGZ:-}"
if [ -z "$upstream_tgz" ]; then
  for candidate in "$ops/build/upstream-$upstream_version.tgz" "$here/.cache/upstream-$upstream_version.tgz"; do
    if [ -f "$candidate" ]; then
      upstream_tgz="$candidate"
      break
    fi
  done
fi
if [ -z "$upstream_tgz" ]; then
  mkdir -p "$here/.cache"
  echo "downloading $upstream_name@$upstream_version from the npm registry"
  (cd "$here/.cache" && npm pack "$upstream_name@$upstream_version" --pack-destination "$here/.cache" >/dev/null 2>&1)
  upstream_tgz="$(find "$here/.cache" -maxdepth 1 -name '*.tgz' | head -1)"
fi
[ -n "$upstream_tgz" ] && [ -f "$upstream_tgz" ] || { echo "upstream tarball not found" >&2; exit 1; }

actual="sha512-$(openssl dgst -sha512 -binary "$upstream_tgz" | base64 -w0)"
[ "$actual" = "$upstream_integrity" ] || {
  echo "upstream tarball integrity mismatch: $actual" >&2
  exit 1
}

rm -rf "$scratch_root"
mkdir -p "$scratch_root"

for variant in pristine patched; do
  nm="$scratch_root/$variant/node_modules"
  mkdir -p "$nm/@dingtalk-real-ai"
  tar xzf "$upstream_tgz" -C "$nm/@dingtalk-real-ai" --strip-components=1 --one-top-level=dingtalk-connector
  pkg="$nm/@dingtalk-real-ai/dingtalk-connector"

  # Same peer layout as the real install: connector/node_modules/openclaw only.
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
    (cd "$pkg" && patch -p1 --forward <"$ops/patches/dingtalk-connector-0.8.27-direct-reply-mode.patch" >/dev/null)
  fi
done

node -e "console.log('scratch ready:', require('fs').existsSync('$scratch_root/patched/node_modules/@dingtalk-real-ai/dingtalk-connector/dist/message-handler-C8eu5xwl.mjs') ? 'ok' : 'missing')"
