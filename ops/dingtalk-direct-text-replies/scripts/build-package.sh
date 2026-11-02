#!/usr/bin/env bash
# Build the maintained local plugin package:
#
#   @dingtalk-real-ai/dingtalk-connector@0.8.27 (registry tarball, integrity
#   pinned)  +  patches/dingtalk-connector-0.8.27-direct-reply-mode.patch
#   ->  @dingtalk-real-ai/dingtalk-connector@0.8.27-claw.1 (local tarball)
#
# The package is a normal npm tarball with a distinct prerelease version, so
# `openclaw plugins install <tarball>` owns the install, its dependencies, and
# its removal. This script never reads or writes the npm-managed install under
# ~/.openclaw/npm/.../node_modules.
#
# Usage: build-package.sh [--from <upstream-0.8.27.tgz>] [--out <dir>]
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/lib.sh"

from=""
out="$OPS_DIR/build"

usage() {
  cat <<'EOF'
Usage: build-package.sh [--from <upstream-0.8.27.tgz>] [--out <dir>]

  --from  reuse an already-downloaded upstream tarball (integrity still checked)
  --out   output directory (default: <ops>/build)
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --from) from="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v npm >/dev/null 2>&1 || die "npm is required"
command -v patch >/dev/null 2>&1 || die "patch is required"
command -v openssl >/dev/null 2>&1 || die "openssl is required"
[ -f "$PATCH_FILE" ] || die "patch file missing: $PATCH_FILE"

mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

upstream_tgz=""
if [ -n "$from" ]; then
  [ -f "$from" ] || die "upstream tarball not found: $from"
  upstream_tgz="$(cd "$(dirname "$from")" && pwd -P)/$(basename "$from")"
else
  cached="$out/upstream-$UPSTREAM_VERSION.tgz"
  if [ -f "$cached" ]; then
    upstream_tgz="$cached"
  else
    info "downloading $UPSTREAM_NAME@$UPSTREAM_VERSION from the npm registry"
    (cd "$work" && npm pack "$UPSTREAM_NAME@$UPSTREAM_VERSION" --pack-destination "$work" >/dev/null 2>&1) ||
      die "npm pack failed; pass --from with a previously downloaded tarball for offline builds"
    upstream_tgz="$(find "$work" -maxdepth 1 -name '*.tgz' | head -1)"
    [ -n "$upstream_tgz" ] || die "npm pack produced no tarball"
  fi
fi

actual_integrity="$(sha512_integrity "$upstream_tgz")"
if [ "$actual_integrity" != "$UPSTREAM_INTEGRITY" ]; then
  die "upstream tarball integrity mismatch: got $actual_integrity, expected $UPSTREAM_INTEGRITY ($upstream_tgz)"
fi

# Keep the verified upstream bytes beside the local package so rollback can
# run offline and is bound to exactly the bytes this build used.
kept_upstream="$out/upstream-$UPSTREAM_VERSION.tgz"
if [ "$upstream_tgz" != "$kept_upstream" ]; then
  cp "$upstream_tgz" "$kept_upstream"
fi
upstream_tgz="$kept_upstream"

mkdir -p "$work/unpacked"
tar xzf "$upstream_tgz" -C "$work/unpacked" --strip-components=1
[ -f "$work/unpacked/package.json" ] || die "upstream tarball has no package.json"
[ -f "$work/unpacked/openclaw.plugin.json" ] || die "upstream tarball has no openclaw.plugin.json"

(cd "$work/unpacked" && patch -p1 --dry-run <"$PATCH_FILE" >/dev/null) ||
  die "patch does not apply to $UPSTREAM_NAME@$UPSTREAM_VERSION"
(cd "$work/unpacked" && patch -p1 <"$PATCH_FILE" >/dev/null)

for rel in \
  dist/message-handler-C8eu5xwl.mjs \
  dist/runtime-CalLOr7V.mjs \
  openclaw.plugin.json \
  src/config/schema.ts \
  src/reply-dispatcher.ts; do
  grep -q 'directReplyMode' "$work/unpacked/$rel" || die "patch marker missing in $rel"
done

node -e '
  const fs = require("node:fs");
  const [pkgPath, manifestPath, version] = process.argv.slice(1);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  const schema = manifest.channelConfigs?.["dingtalk-connector"]?.schema;
  const top = schema?.properties?.directReplyMode;
  const account = schema?.properties?.accounts?.additionalProperties?.properties?.directReplyMode;
  if (!top || !account) {
    console.error("manifest channel schema is missing directReplyMode");
    process.exit(1);
  }
' "$work/unpacked/package.json" "$work/unpacked/openclaw.plugin.json" "$LOCAL_VERSION" ||
  die "local package metadata rewrite failed"

tgz_name="$(cd "$work/unpacked" && npm pack --pack-destination "$out" 2>/dev/null | tail -1)"
[ -f "$out/$tgz_name" ] || die "npm pack did not produce $out/$tgz_name"
local_tgz="$out/$tgz_name"

node -e '
  const fs = require("node:fs");
  const [buildPath, localTgz, localVersion, upstreamTgz, upstreamVersion, upstreamIntegrity, patchFile, patchSha] =
    process.argv.slice(1);
  const build = {
    name: "@dingtalk-real-ai/dingtalk-connector",
    local: {
      version: localVersion,
      tarball: localTgz.split("/").pop(),
      sha256: null,
    },
    upstream: {
      version: upstreamVersion,
      tarball: upstreamTgz.split("/").pop(),
      integrity: upstreamIntegrity,
    },
    patch: { file: patchFile.split("/").pop(), sha256: patchSha },
    builtAt: new Date().toISOString(),
    node: process.version,
  };
  // sha256 of the built tarball is filled in by the caller (shell) below.
  fs.writeFileSync(buildPath, JSON.stringify(build, null, 2) + "\n");
' "$out/build.json" "$local_tgz" "$LOCAL_VERSION" "$upstream_tgz" "$UPSTREAM_VERSION" "$UPSTREAM_INTEGRITY" "$PATCH_FILE" "$(sha256_hex "$PATCH_FILE")"

node -e '
  const fs = require("node:fs");
  const [buildPath, sha] = process.argv.slice(1);
  const build = JSON.parse(fs.readFileSync(buildPath, "utf8"));
  build.local.sha256 = sha;
  fs.writeFileSync(buildPath, JSON.stringify(build, null, 2) + "\n");
' "$out/build.json" "$(sha256_hex "$local_tgz")"

printf '%s\n' "$local_tgz"
