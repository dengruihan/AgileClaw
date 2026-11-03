#!/usr/bin/env bash
# Restore a previous Agenda build from a deploy backup. The live database is
# never restored automatically; the snapshot is evidence only.
set -euo pipefail
backup="${1:?usage: rollback.sh <backup directory>}"
install="${HOME}/.openclaw/extensions/agenda"
for entry in dist assets skills openclaw.plugin.json; do
  if [ ! -e "${backup}/${entry}" ]; then
    echo "missing ${backup}/${entry}" >&2
    exit 1
  fi
done
echo "Restoring ${backup} into ${install}"
for entry in dist assets openclaw.plugin.json; do
  rm -rf "${install:?}/${entry}"
  cp -R "${backup}/${entry}" "${install}/${entry}"
done
rm -rf "${install}/skills"
cp -R "${backup}/skills" "${install}/skills"
openclaw plugins reload agenda --wait --json
curl -fsS -m 5 http://127.0.0.1:18810/agenda/api/status && echo
echo "Restored. The database was not modified; snapshot: ${backup}/agenda.sqlite.snapshot"
