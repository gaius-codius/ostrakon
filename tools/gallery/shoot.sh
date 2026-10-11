#!/usr/bin/env bash
# Gallery screenshots: tools/gallery/shoot.sh <dark|light> <cols> <rows>
# Own tmux socket (-L spgallery). Light theme: claude --settings '{"theme":"light"}' (per session, no global config touched).
# Extra shots (hover via SGR mouse motion, select popup, client keys, band + decorations) are scripted below.
set -u
THEME=$1; COLS=$2; ROWS=$3
HERE=$(cd "$(dirname "$0")" && pwd); OUT=${OUT:-$(cd "$HERE/../.." && pwd)/working-docs/design/gallery}; mkdir -p "$OUT"
TMP=${TMPD:-/tmp/spgallery-shots}; mkdir -p $TMP
G() { tmux -L spgallery "$@"; }
SET=""; [ "$THEME" = light ] && SET="--settings '{\"theme\":\"light\"}'"
G kill-session -t g 2>/dev/null
G new-session -d -s g -x $COLS -y $ROWS -c "${SCREENS_CWD:-$HOME}" "COLORTERM=truecolor claude --plugin-dir $HERE --debug-file $TMP/debug.log $SET"
for _ in $(seq 1 40); do G capture-pane -p -t g | grep -q "shift+tab" && break; sleep 1; done; sleep 3
shot() { # name
  local n=$1-$THEME-$COLS
  G capture-pane -e -N -p -t g > $TMP/$n.ans
  SHOT_THEME=$THEME python3 -I $HERE/ansi2html.py $TMP/$n.ans $TMP/$n.html "$1 / $THEME / ${COLS}x${ROWS}"
  chromium --headless=new --disable-gpu --hide-scrollbars --screenshot=$OUT/$n.png --window-size=$(( COLS * 85 / 10 + 40 )),$(( ROWS * 175 / 10 + 70 )) file://$TMP/$n.html >/dev/null 2>&1
  echo $n.png
}
cmd() { G send-keys -t g -l "$1"; sleep 0.6; G send-keys -t g Enter; sleep 2.5; }
mouse() { G send-keys -t g -l "$1"; sleep 1; }
close() { G send-keys -t g Escape; sleep 0.6; G send-keys -t g C-u; sleep 0.3; }
for p in boxes overlay colours text wrap controls rich code graphics client; do
  cmd "/gallery $p"; shot $p
  case $p in
    overlay) # pointer motion: needs the pane's cell coordinates (docked: x 95; inline differs) so only at 160
      if [ $COLS -ge 144 ]; then
        mouse $'\e[<35;95;6M'; mouse $'\e[<35;96;6M'; shot overlay-hover-box
        mouse $'\e[<35;95;17M'; mouse $'\e[<35;96;18M'; shot overlay-hover-reveal
      fi;;
    controls)
      G send-keys -t g Tab; G send-keys -t g Tab; G send-keys -t g Tab; sleep 0.5; G send-keys -t g Enter; sleep 1; shot controls-selectopen
      G send-keys -t g Escape; sleep 0.5;;
    client)
      if [ $COLS -ge 144 ]; then
        mouse $'\e[<0;95;6M\e[<0;95;6m'; G send-keys -t g -l "aZ"; sleep 0.4; G send-keys -t g Up Enter Tab C-a; sleep 1; shot client-keys
      fi;;
  esac
  close
done
cmd "/gallery hint tree"; cmd "/gallery band on"; shot band-hinttree
cmd "/gallery hint tail"; G send-keys -t g -l "//note this"; sleep 1.5; shot band
G kill-server
