#!/usr/bin/env bash
# The README's screenshots: the docked pane (with the pocket's chips under it) and the phone app,
# on the same fixture notes. Runs a throwaway hub on 127.0.0.1:8794 and a real Claude Code session that syncs
# the fixture to it, then shoots the phone page in headless Chromium. Output: docs/images/*.png.
# Re-run before a release when the pane, the band or the phone look different (docs/releasing.md).
# Claude Code's header names the account and the folder, so it's painted over.
# Needs: tmux, chromium, python3, bun, and ImageMagick (magick).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
# The session runs in a git repo with a remote, so the mod names its project cc the way it would
# for real code; no debug log, so no banner. Set before lib.sh, which reads SCREENS_CWD.
export SCREENS_CWD=${SCREENS_DIR:-/tmp/ostrakon-screens}/cc
mkdir -p "$SCREENS_CWD" && git -C "$SCREENS_CWD" init -q 2>/dev/null
git -C "$SCREENS_CWD" remote add origin git@github.com:me/cc.git 2>/dev/null
source "$HERE/lib.sh"
# shellcheck disable=SC2034  # read by lib.sh's start
DEBUG_LOG=
OUT=$ROOT/docs/images; mkdir -p "$OUT"
PORT=8794; TOKEN=screens; HUBDATA=$R/hub-readme

T kill-session -t hub 2>/dev/null; rm -rf "$HUBDATA"
T new-session -d -s hub -c "$ROOT" "HUB_PORT=$PORT HUB_DATA=$HUBDATA HUB_TOKEN=$TOKEN bun server/hub.ts"
for _ in $(seq 1 20); do curl -sf 127.0.0.1:$PORT/healthz >/dev/null && break; sleep 0.25; done
settings=$R/readme-settings.json
# mirrorDir emptied: left out, the person's own settings set it, and the session syncs the fixture
# into their vault and their vault's notes into the screenshot.
opts="{\"hubUrl\":\"http://127.0.0.1:$PORT\",\"hubToken\":\"$TOKEN\",\"mirrorDir\":\"\"}"
echo "{\"theme\":\"dark\",\"env\":{\"CLAUDE_CODE_PLUGIN_DIRS\":\"\"},\"pluginConfigs\":{\"ostrakon\":{\"options\":$opts},\"ostrakon@inline\":{\"options\":$opts}}}" > "$settings"
SCREENS_KEY=github.com/me/cc SCREENS_PATH=/home/me/code/cc SCREENS_SETTINGS=$settings start few 150 40

# The pane, docked beside the conversation (ctrl+x s, the README's binding).
keys C-x s; sleep 2
# The header sits left of the docked pane, and a notice (login expiry) can sit under it: paint both
# over with the background instead of cropping.
shot readme-pane "" >/dev/null
bg=$(magick "$R/shots/readme-pane.png" -format '%[pixel:p{4,4}]' info:)
magick "$R/shots/readme-pane.png" -fill "$bg" -draw 'rectangle 0,30 705,135' "$OUT/pane.png"
keys Escape; sleep 1
T kill-session -t rv

# The phone: the same notes, synced through the hub, at an iPhone's width.
# A fixed wait, not "until the network is idle": the page holds a long poll open, so it never is.
rm -rf "$R/chromium-readme"
timeout 60 chromium --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=3 --window-size=390,780 \
  --timeout=6000 --user-data-dir="$R/chromium-readme" \
  --screenshot="$OUT/phone.png" "http://127.0.0.1:$PORT/?token=$TOKEN" >/dev/null 2>&1
T kill-session -t hub
ls -l "$OUT"
