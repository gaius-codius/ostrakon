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
# Claude Code names your editor under a multi-line prompt (ctrl+g to edit in …): name a plain one.
export EDITOR=vim VISUAL=vim
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

# The GIF, in a session of its own with no hub or mirror (lib.sh's settings), so their
# note goes nowhere. record <name> starts it, frame <centiseconds> adds a frame, gif writes it.
record() {
  SCREENS_KEY=github.com/me/cc SCREENS_PATH=/home/me/code/cc start few 120 26
  gifname=$1; frames=$R/gif-$1; rm -rf "$frames"; mkdir -p "$frames"; n=0; delays=()
}
frame() {
  shot gif "" >/dev/null
  n=$((n + 1)); delays+=("$1")
  magick "$R/shots/gif.png" -fill "$bg" -draw 'rectangle 0,30 600,135' "$frames/$(printf %02d $n).png"
}
typed() { # text, centiseconds to hold the last frame; a few words to a frame
  local words; read -ra words <<<"$1"; local i
  for ((i = 0; i < ${#words[@]}; i += 3)); do
    if ((i + 3 < ${#words[@]})); then lit "${words[*]:i:3} "; frame 25; else lit "${words[*]:i:3}"; frame "$2"; fi
  done
}
gif() {
  T kill-session -t rv
  local args=() i=0 f
  for f in "$frames"/*.png; do args+=(-delay "${delays[i]}" "$f"); i=$((i + 1)); done
  magick "${args[@]}" -loop 0 -layers Optimize "$OUT/$gifname.gif"
}

# The demo: half a prompt typed, a note captured in the pane and the prompt back as it was, then a
# note Claude jotted found in the pane and added under the draft with t.
record demo
frame 80
typed "refactor the session store so each request gets its own" 150
keys C-x s; sleep 1; frame 150
keys C-n; frame 80
typed "the retry test leaks a timer, fix after this" 100
keys Enter; sleep 0.5; frame 180
keys C-q; sleep 1; frame 250
# No frame of the pane reopening: its preview names the session's folder, /tmp/….
keys C-x s; sleep 1
typed "401" 100
keys Enter; frame 150
keys t; sleep 1; frame 400
gif
ls -l "$OUT"
