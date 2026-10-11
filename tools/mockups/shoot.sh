#!/usr/bin/env bash
# Mockup screenshots: tools/mockups/shoot.sh <dark|light> <cols> <rows> <dirs...> -- <views...>
# Own tmux socket (-L spmock). Light theme per session via --settings (no global config touched).
set -u
THEME=$1; COLS=$2; ROWS=$3; shift 3
DIRS=(); while [ $# -gt 0 ] && [ "$1" != -- ]; do DIRS+=("$1"); shift; done; shift
VIEWS=("$@")
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
OUT=${OUT:-$ROOT/working-docs/design/mockups}; mkdir -p "$OUT"
TMP=${TMPD:-/tmp/spmock-shots}; mkdir -p $TMP
M() { tmux -L spmock "$@"; }
SET=""; [ "$THEME" = light ] && SET="--settings '{\"theme\":\"light\"}'"
M kill-server 2>/dev/null
M new-session -d -s m -x $COLS -y $ROWS -c "${SCREENS_CWD:-$HOME}" "COLORTERM=truecolor claude --plugin-dir $HERE --debug-file $TMP/debug.log $SET"
for _ in $(seq 1 40); do M capture-pane -p -t m | grep -q "shift+tab" && break; sleep 1; done; sleep 3
# A clean transcript column: clear once, then every command's row scrolls under the pane.
shot() {
  local n=$1
  M capture-pane -e -N -p -t m > $TMP/$n.ans
  SHOT_THEME=$THEME python3 -I $ROOT/tools/gallery/ansi2html.py $TMP/$n.ans $TMP/$n.html "$2"
  chromium --headless=new --disable-gpu --hide-scrollbars --screenshot=$OUT/$n.png --window-size=$(( COLS * 85 / 10 + 40 )),$(( ROWS * 175 / 10 + 70 )) file://$TMP/$n.html >/dev/null 2>&1
  echo $n.png
}
cmd() { M send-keys -t m -l "$1"; sleep 0.5; M send-keys -t m Enter; sleep 2; }
for d in "${DIRS[@]}"; do
  for v in "${VIEWS[@]}"; do
    case $v in
      band-*) # band-<a|b>-<pocket0|pocket3|pocket9|harvest>
        IFS=- read -r _ style which <<< "$v"
        M send-keys -t m Escape; sleep 0.3
        cmd "/mockband $style $which"; M send-keys -t m C-u; sleep 0.8
        shot "$v-$THEME-$COLS" "band $style · $which · $THEME · ${COLS}x${ROWS}"
        cmd "/mockband off";;
      *)
        cmd "/mock $d $v"
        shot "$d-$v-$THEME-$COLS" "$d · $v · $THEME · ${COLS}x${ROWS}";;
    esac
  done
done
M kill-server
