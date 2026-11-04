#!/usr/bin/env bash
# Replay the reviewed commit on top of the recorded base in a detached worktree
# and run the authoritative repository's standard build and test commands.
set -euo pipefail
repo="${1:-$HOME/repos/agenda}"
here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"
base="$(sed -n 's/^base: //p' "${package}/external/commit.txt")"
commit="$(sed -n 's/^commit: //p' "${package}/external/commit.txt")"
target="$(mktemp -d)"
cleanup() {
  git -C "${repo}" worktree remove --force "${target}" >/dev/null 2>&1 || true
  rm -rf "${target}"
}
trap cleanup EXIT
git -C "${repo}" worktree add --detach "${target}" "${base}"
git -C "${target}" am "${package}/external/source.patch"
applied="$(git -C "${target}" rev-parse HEAD)"
applied_tree="$(git -C "${target}" rev-parse HEAD^{tree})"
expected_tree="$(git -C "${repo}" rev-parse "${commit}^{tree}")"
if [ "${applied_tree}" != "${expected_tree}" ]; then
  echo "replayed tree ${applied_tree} but expected ${expected_tree}" >&2
  exit 1
fi
ln -s "${repo}/node_modules" "${target}/node_modules"
echo "node_modules" >> "$(git -C "${target}" rev-parse --git-path info/exclude)"
cd "${target}"
node build.mjs
npx vitest run
echo "replayed ${commit} (as ${applied}, identical tree): build and tests passed"
