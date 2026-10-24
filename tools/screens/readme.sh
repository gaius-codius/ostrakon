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
# The pane opens on all projects only if all was chosen before, and that choice lives in the mod's
# store, which your own sessions share. Choose all for the shot, and choose again after to put the
# store back.
rescope=; T capture-pane -p -t rv | grep -q 'this project ·' && { keys C-s; rescope=1; }
# The header sits left of the docked pane, and a notice (login expiry) can sit under it: paint both
# over with the background instead of cropping.
shot readme-pane "" >/dev/null
bg=$(magick "$R/shots/readme-pane.png" -format '%[pixel:p{4,4}]' info:)
magick "$R/shots/readme-pane.png" -fill "$bg" -draw 'rectangle 0,30 705,135' "$OUT/pane.png"
[ -z "$rescope" ] || keys C-s
keys Escape; sleep 1
T kill-session -t rv

# The phone: the same notes, synced through the hub, at an iPhone's width.
# A fixed wait, not "until the network is idle": the page holds a long poll open, so it never is.
# --force-dark-mode: the page follows prefers-color-scheme, which headless Chromium takes from the
# desktop, so a light desktop gave a light shot beside the dark pane.
rm -rf "$R/chromium-readme"
timeout 60 chromium --headless=new --disable-gpu --hide-scrollbars --force-dark-mode --force-device-scale-factor=3 --window-size=390,780 \
  --timeout=6000 --user-data-dir="$R/chromium-readme" \
  --screenshot="$OUT/phone.png" "http://127.0.0.1:$PORT/?token=$TOKEN" >/dev/null 2>&1
T kill-session -t hub

# The GIF, in a session of its own with no hub or mirror (lib.sh's settings), so its note goes
# nowhere. Over each frame, a strip names the four steps, the current one lit, and the last key
# pressed. A frame a character typed, and a cursor that blinks through the holds.
record() {
  SCREENS_KEY=github.com/me/cc SCREENS_PATH=/home/me/code/cc start few 120 26
  gifname=$1; frames=$R/gif-$1; rm -rf "$frames"; mkdir -p "$frames"; n=0; delays=(); step=1; key=
}
font=$(fc-match -f '%{file}' 'JetBrainsMono Nerd Font'); fg='#d8dee9'; dim='#5c6370'; accent='#d97757'
steps=("Halfway through a prompt" "Note something" "The prompt is back" "Add a note to it")
strip() { # width: $R/strip.png for $step and $key. The font is 15px, 9px a character.
  local w=$1 x=16 i draw=()
  for i in 0 1 2 3; do
    if ((i + 1 == step)); then draw+=(-fill "$accent" -annotate "+$x+29" "$((i + 1))" -fill "$fg")
    else draw+=(-fill "$dim" -annotate "+$x+29" "$((i + 1))"); fi
    draw+=(-annotate +$((x + 18))+29 "${steps[i]}"); x=$((x + 18 + ${#steps[i]} * 9 + 36))
  done
  if [ -n "$key" ]; then
    local kw=$((${#key} * 9 + 20))
    draw+=(-fill none -stroke "$dim" -draw "roundrectangle $((w - 16 - kw)),11 $((w - 16)),38 5,5"
      -stroke none -fill "$fg" -annotate +$((w - 6 - kw))+29 "$key")
  fi
  magick -size "${w}x48" xc:"$bg" -font "$font" -pointsize 15 "${draw[@]}" "$R/strip.png"
}
frame() { # centiseconds to hold it
  local on cx cy x y w left=$1 lit=1 d base=$R/frame.png
  read -r on cx cy < <(T display -p -t rv '#{cursor_flag} #{cursor_x} #{cursor_y}')
  shot gif "" >/dev/null
  magick "$R/shots/gif.png" -fill "$bg" -draw 'rectangle 0,30 600,135' "$base"
  w=$(magick identify -format %w "$base"); strip "$w"
  # Where ansi2html puts a cell: 16px in, 24px down, 8.4px by 17.5px.
  x=$(awk "BEGIN { printf \"%d\", 16 + $cx * 8.4 }"); y=$(awk "BEGIN { printf \"%d\", 24 + $cy * 17.5 }")
  while ((left > 0)); do
    d=$((left > 60 ? 50 : left)); n=$((n + 1)); delays+=("$d")
    if ((lit && on)); then
      magick "$R/strip.png" \( "$base" -fill "$fg" -draw "rectangle $x,$((y + 1)) $((x + 1)),$((y + 16))" \) -append +repage "$frames/$(printf %03d $n).png"
    else magick "$R/strip.png" "$base" -append +repage "$frames/$(printf %03d $n).png"; fi
    left=$((left - d)); lit=$((1 - lit))
  done
}
typed() { # text, centiseconds to hold the last frame
  local i
  for ((i = 0; i < ${#1}; i++)); do
    T send-keys -t rv -l "${1:i:1}"; sleep 0.15
    if ((i + 1 < ${#1})); then frame 7; else frame "$2"; fi
  done
}
press() { key=$1; shift; keys "$@"; }
gif() {
  T kill-session -t rv
  local args=() i=0 f
  for f in "$frames"/*.png; do args+=(-delay "${delays[i]}" "$f"); i=$((i + 1)); done
  magick "${args[@]}" -loop 0 -layers Optimize "$OUT/$gifname.gif"
  # The last frame, for people who turn motion off.
  cp "$f" "$OUT/$gifname.png"
}

# The demo: half a prompt typed, a note captured in the pane and the prompt back as it was, then a
# note Claude jotted found in the pane and added under the draft with t.
record demo
frame 100
typed "refactor the session store so each request gets its own" 150
step=2; press "ctrl+x s" C-x s; sleep 1; frame 150
press "ctrl+n" C-n; frame 80
typed "retry test leaks a timer" 100
press "enter" Enter; sleep 0.5; frame 180
step=3; press "ctrl+q" C-q; sleep 1; frame 250
# No frame of the pane reopening: its preview names the session's folder, /tmp/….
step=4; press "ctrl+x s" C-x s; sleep 1
typed "401" 100
press "enter" Enter; frame 120
press "t" t; sleep 1; frame 400
gif
ls -l "$OUT"
