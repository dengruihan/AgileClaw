#!/usr/bin/env bash
# Prove the isolated Gotenberg deployment: conversions, page geometry, and the
# isolation guarantees of deploy/gotenberg/compose.yaml + compose.host.yaml.
#
#   deploy/gotenberg/verify.sh          run the checks and remove the stack
#   deploy/gotenberg/verify.sh --keep   leave the stack running on
#                                       127.0.0.1:3000 for a live Gateway
#
# Requires Docker Engine with Compose v2, curl, Node.js, and a free
# 127.0.0.1:3000. The stack is project-scoped and never touches another
# container.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="$ROOT/deploy/gotenberg/compose.yaml"
HOST_OVERLAY="$ROOT/deploy/gotenberg/compose.host.yaml"
FIXTURES="$ROOT/deploy/gotenberg/fixtures"
PROJECT="${GOTENBERG_VERIFY_PROJECT:-openclaw-gotenberg-verify}"
API="http://127.0.0.1:3000"
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/gotenberg-verify.XXXXXX")"
COMPOSE_PROJECT="$PROJECT-compose"
LISTENER_PID=""
cleanup() {
  [[ -n "$LISTENER_PID" ]] && kill "$LISTENER_PID" 2>/dev/null || true
  docker compose -p "$COMPOSE_PROJECT" -f "$ROOT/docker-compose.yml" down --volumes >/dev/null 2>&1 || true
  if [[ "$KEEP" == 0 ]]; then
    docker compose -p "$PROJECT" -f "$BASE" -f "$HOST_OVERLAY" down --volumes >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

pass=0
fail=0
check() {
  local label="$1" ok="$2" detail="${3:-}"
  if [[ "$ok" == "1" ]]; then
    printf 'PASS  %s%s\n' "$label" "${detail:+ ($detail)}"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s%s\n' "$label" "${detail:+ ($detail)}"
    fail=$((fail + 1))
  fi
}

http_code() { curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@"; }

echo "== Compose definitions"
check "base compose validates" "$(docker compose -f "$BASE" config --quiet >/dev/null 2>&1 && echo 1 || echo 0)"
check "base+host overlay validates" "$(docker compose -f "$BASE" -f "$HOST_OVERLAY" config --quiet >/dev/null 2>&1 && echo 1 || echo 0)"
check "root compose validates" "$(docker compose -f "$ROOT/docker-compose.yml" config --quiet >/dev/null 2>&1 && echo 1 || echo 0)"

BASE_JSON="$WORK/base.json"
ROOT_JSON="$WORK/root.json"
docker compose -f "$BASE" config --format json >"$BASE_JSON"
docker compose -f "$ROOT/docker-compose.yml" config --format json >"$ROOT_JSON"
if diff_detail="$(node - "$BASE_JSON" "$ROOT_JSON" <<'NODE'
const [basePath, rootPath] = process.argv.slice(2);
const base = require(basePath).services.gotenberg;
const root = require(rootPath).services.gotenberg;
const keys = [
  "image", "command", "entrypoint", "environment", "read_only", "tmpfs",
  "cap_drop", "security_opt", "pids_limit", "mem_limit", "memswap_limit",
  "user", "working_dir", "stdin_open", "tty",
];
const normalize = (svc) => {
  const pick = (src, key) => {
    if (key === "command" || key === "entrypoint") return src[key] ?? null;
    if (key === "environment") return Object.entries(src[key] ?? {}).sort(([a], [b]) => a.localeCompare(b));
    if (key === "tmpfs") return [...(src[key] ?? [])].sort();
    if (key === "cap_drop" || key === "security_opt") return [...(src[key] ?? [])].sort();
    return src[key] ?? null;
  };
  return Object.fromEntries(keys.map((key) => [key, pick(svc, key)]));
};
const a = JSON.stringify(normalize(base));
const b = JSON.stringify(normalize(root));
if (a === b) process.exit(0);
console.log(`service differs: base=${a}\nroot=${b}`);
process.exit(1);
NODE
)"; then
  check "root gotenberg service matches deploy/gotenberg" 1
else
  check "root gotenberg service matches deploy/gotenberg" 0 "$diff_detail"
fi

echo
echo "== Start the hardened stack"
docker compose -p "$PROJECT" -f "$BASE" -f "$HOST_OVERLAY" up -d --wait
CID="$(docker compose -p "$PROJECT" -f "$BASE" -f "$HOST_OVERLAY" ps --quiet gotenberg)"
IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CID")"
DIGEST="$(docker image inspect gotenberg/gotenberg:9 --format '{{index .RepoDigests 0}}')"
VERSION="$(curl --silent --fail "$API/version")"
echo "image=$DIGEST version=$VERSION"

echo
echo "== Conversions"
convert() {
  local name="$1" out="$WORK/$1.pdf"
  local code type
  read -r code type <<<"$(curl --silent --show-error --output "$out" --write-out '%{http_code} %{content_type}' \
    -F "files=@$FIXTURES/$name" "$API/forms/libreoffice/convert")"
  check "$name converts to application/pdf" "$([[ "$code" == 200 && "$type" == application/pdf ]] && echo 1 || echo 0)" "http=$code type=$type"
  check "$name returns %PDF magic" "$([[ "$(head -c 5 "$out")" == '%PDF-' ]] && echo 1 || echo 0)"
}
convert synthetic-letter.docx
convert synthetic-print-area.xlsx
convert synthetic-wide-slide.pptx

mediabox() { grep -a -o -E "$2" "$WORK/$1.pdf" | head -1; }
check "DOCX keeps US Letter page size" "$([[ -n "$(mediabox synthetic-letter.docx '/MediaBox\[0 0 612 792\]')" ]] && echo 1 || echo 0)"
check "XLSX keeps A4 landscape print settings" "$([[ -n "$(mediabox synthetic-print-area.xlsx '/MediaBox\[0 0 841\.88[0-9]+ 595\.30[0-9]+\]')" ]] && echo 1 || echo 0)"
check "XLSX print area limits the PDF to one page" "$(grep -a -c -E '/Count 1([^0-9]|$)' "$WORK/synthetic-print-area.xlsx.pdf" | awk '{print ($1 > 0) ? 1 : 0}')"
check "PPTX keeps the 16:9 slide canvas" "$([[ -n "$(mediabox synthetic-wide-slide.pptx '/MediaBox\[0 0 960\.[0-9]+ 540\]')" ]] && echo 1 || echo 0)"

echo
echo "== Container isolation"
check "no persistent mounts" "$([[ "$(docker inspect --format '{{len .Mounts}}' "$CID")" == 0 ]] && echo 1 || echo 0)"
check "root filesystem is read-only" "$([[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$CID")" == true ]] && echo 1 || echo 0)"
check "all capabilities dropped" "$(docker inspect --format '{{json .HostConfig.CapDrop}}' "$CID" | grep -q 'ALL' && echo 1 || echo 0)"
check "no-new-privileges set" "$(docker inspect --format '{{json .HostConfig.SecurityOpt}}' "$CID" | grep -q 'no-new-privileges' && echo 1 || echo 0)"
TMP_KB="$(docker exec "$CID" df -k /tmp | awk 'NR==2 {print $2}')"
check "temporary space capped at 512 MiB" "$([[ "$TMP_KB" -gt 500000 && "$TMP_KB" -le 524288 ]] && echo 1 || echo 0)" "df=$TMP_KB KiB"
check "memory bounded to 2 GiB" "$([[ "$(docker inspect --format '{{.HostConfig.Memory}}' "$CID")" == 2147483648 ]] && echo 1 || echo 0)"
check "queue/timeout/body/outbound flags applied" \
  "$(docker inspect --format '{{json .Config.Cmd}}' "$CID" | grep -q -- '--libreoffice-max-queue-size=4' \
    && docker inspect --format '{{json .Config.Cmd}}' "$CID" | grep -q -- '--api-timeout=60s' \
    && docker inspect --format '{{json .Config.Cmd}}' "$CID" | grep -q -- '--api-body-limit=18MB' \
    && docker inspect --format '{{json .Config.Cmd}}' "$CID" | grep -q -- '--api-disable-download-from=true' \
    && docker inspect --format '{{json .Config.Cmd}}' "$CID" | grep -q -- '--pdf-disable-routes=true' \
    && echo 1 || echo 0)"
if docker exec "$CID" curl --silent --max-time 5 --output /dev/null https://example.com; then
  check "container cannot reach the public internet" 0 "request succeeded"
else
  check "container cannot reach the public internet" 1
fi
if docker exec "$CID" curl --silent --max-time 5 --output /dev/null http://1.1.1.1; then
  check "container has no public IP route" 0 "request succeeded"
else
  check "container has no public IP route" 1
fi

echo
echo "== Remote download and webhook refusal"
# A listener on the loopback bridge proves what the container could reach: the
# container reaches it directly, so an attempt by Gotenberg would be recorded.
GATEWAY_IP="$(docker network inspect "${PROJECT}_gotenberg-loopback" --format '{{(index .IPAM.Config 0).Gateway}}')"
LISTENER_LOG="$WORK/listener.log"
cat >"$WORK/listener.mjs" <<'NODE'
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const [host, port, logPath] = process.argv.slice(2);
createServer((request, response) => {
  appendFileSync(logPath, `${request.method} ${request.url}\n`);
  response.writeHead(200, { "content-type": "application/octet-stream" });
  response.end("%PDF-1.4 test");
}).listen(Number(port), host);
NODE
node "$WORK/listener.mjs" "$GATEWAY_IP" 18081 "$LISTENER_LOG" &
LISTENER_PID=$!
sleep 1
check "listener reachable from the container" \
  "$([[ "$(docker exec "$CID" curl --silent --output /dev/null --write-out '%{http_code}' "http://$GATEWAY_IP:18081/probe" || true)" == 200 ]] && echo 1 || echo 0)"
BEFORE="$(grep -c . "$LISTENER_LOG" 2>/dev/null || echo 0)"
REMOTE_CODE="$(http_code -F "downloadFrom=http://$GATEWAY_IP:18081/remote.docx" \
  -F "files=@$FIXTURES/synthetic-letter.docx" "$API/forms/libreoffice/convert")"
WEBHOOK_CODE="$(http_code -H "Gotenberg-Webhook-Url: http://$GATEWAY_IP:18081/hook" \
  -F "files=@$FIXTURES/synthetic-letter.docx" "$API/forms/libreoffice/convert")"
AFTER="$(grep -c . "$LISTENER_LOG" 2>/dev/null || echo 0)"
check "downloadFrom rejected or ignored" "$([[ "$REMOTE_CODE" == 4* || "$REMOTE_CODE" == 200 ]] && echo 1 || echo 0)" "http=$REMOTE_CODE"
check "no remote fetch was attempted" "$([[ "$AFTER" == "$BEFORE" ]] && echo 1 || echo 0)" "listener requests $BEFORE -> $AFTER"
check "webhook callback not attempted" "$([[ "$AFTER" == "$BEFORE" ]] && echo 1 || echo 0)" "http=$WEBHOOK_CODE"

echo
echo "== Body limit"
head -c 20971520 /dev/zero >"$WORK/oversize.bin"
check "oversized request rejected with 413" \
  "$([[ "$(http_code -F "files=@$WORK/oversize.bin" "$API/forms/libreoffice/convert")" == 413 ]] && echo 1 || echo 0)"

echo
echo "== Compose deployment shape (docker-compose.yml)"
check "Gateway joins the conversion network" \
  "$(node -e 'const c=require(process.argv[1]); const nets=Object.keys(c.services["openclaw-gateway"].networks ?? {}); process.exit(nets.includes("openclaw-gotenberg") ? 0 : 1)' "$ROOT_JSON" >/dev/null 2>&1 && echo 1 || echo 0)"
docker compose -p "$COMPOSE_PROJECT" -f "$ROOT/docker-compose.yml" up -d --wait gotenberg >/dev/null
COMPOSE_CID="$(docker compose -p "$COMPOSE_PROJECT" -f "$ROOT/docker-compose.yml" ps --quiet gotenberg)"
COMPOSE_NET="${COMPOSE_PROJECT}_openclaw-gotenberg"
check "Compose publishes no host port" "$([[ -z "$(docker port "$COMPOSE_CID")" ]] && echo 1 || echo 0)"
check "conversion network is internal" \
  "$([[ "$(docker network inspect "$COMPOSE_NET" --format '{{.Internal}}')" == true ]] && echo 1 || echo 0)"
check "service name gotenberg resolves from another container" \
  "$([[ "$(docker run --rm --network "$COMPOSE_NET" --entrypoint curl gotenberg/gotenberg:9 \
    --silent --output /dev/null --write-out '%{http_code}' http://gotenberg:3000/health)" == 200 ]] && echo 1 || echo 0)"
COMPOSE_CONVERT="$(docker run --rm --network "$COMPOSE_NET" --volume "$FIXTURES:/fixtures:ro" \
  --entrypoint curl gotenberg/gotenberg:9 --silent --output /dev/null \
  --write-out '%{http_code} %{content_type}' \
  -F "files=@/fixtures/synthetic-letter.docx" http://gotenberg:3000/forms/libreoffice/convert)"
check "conversion through gotenberg:3000" \
  "$([[ "$COMPOSE_CONVERT" == "200 application/pdf" ]] && echo 1 || echo 0)" "$COMPOSE_CONVERT"

echo
echo "== Result"
echo "passed=$pass failed=$fail"
if [[ "$KEEP" == 1 && "$fail" == 0 ]]; then
  echo "stack left running: project=$PROJECT api=$API (stop with:"
  echo "  docker compose -p $PROJECT -f $BASE -f $HOST_OVERLAY down)"
fi
[[ "$fail" == 0 ]]