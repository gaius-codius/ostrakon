#!/usr/bin/env bash
# The phone app in WebKit at iPhone size (tools/phone/README.md): starts a test hub on a free port
# with its own data and token, then runs the tests here against it.
#   PHONE_IN=docker  WebKit in Playwright's Ubuntu image (the default where docker is; WebKit's
#                    Linux build wants Ubuntu's libraries)
#   PHONE_IN=host    WebKit on this machine (CI, after `playwright-core install --with-deps webkit`)
# Extra arguments go to `node --test` (e.g. --test-name-pattern=picker).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
# The same version as package.json's playwright-core: the image's browsers are built for it.
IMAGE=mcr.microsoft.com/playwright:v1.64.0-noble
PHONE_IN=${PHONE_IN:-$(command -v docker >/dev/null && echo docker || echo host)}

[ -d "$HERE/node_modules/playwright-core" ] || (cd "$HERE" && bun install --frozen-lockfile)

DATA=$(mktemp -d)
PORT=$(bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop()')
TOKEN=phone-test
HUB_PORT=$PORT HUB_DATA=$DATA HUB_TOKEN=$TOKEN bun "$ROOT/server/hub.ts" >"$DATA/hub.log" 2>&1 &
HUB_PID=$!
trap 'kill $HUB_PID 2>/dev/null || true; rm -rf "$DATA"' EXIT
for _ in $(seq 1 50); do
  curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null || { cat "$DATA/hub.log"; exit 1; }

if [ "$PHONE_IN" = docker ]; then
  # Host networking, so the browser reaches the hub at 127.0.0.1 as a phone on the tailnet would
  # reach it at its own address.
  docker run --rm --network host --ipc host --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -e PHONE_HUB="http://127.0.0.1:$PORT" -e PHONE_TOKEN=$TOKEN -e PHONE_DEBUG="${PHONE_DEBUG:-}" \
    -v "$HERE:/phone:ro" -w /phone "$IMAGE" node --test "$@" sheet.test.mjs
else
  cd "$HERE"
  PHONE_HUB="http://127.0.0.1:$PORT" PHONE_TOKEN=$TOKEN node --test "$@" sheet.test.mjs
fi
