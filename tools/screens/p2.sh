#!/usr/bin/env bash
# P2 screenshots: every §13 pane state, dark docked (160x44), inline (100x40) and light.
# Output: working-docs/screens/p2/<name>.png (full frames) and working-docs/screens/p2/crops/ (the pane alone).
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
source $HERE/lib.sh
OUT=$ROOT/working-docs/screens/p2; mkdir -p $OUT/crops
keep() { cp $R/shots/$1.png $OUT/$1.png
  case $1 in
    *-100) magick $OUT/$1.png -crop 850x350+16+405 +repage $OUT/crops/$1.png ;;
    *) magick $OUT/$1.png -crop 612x700+752+30 +repage $OUT/crops/$1.png ;;
  esac; }
open_pane() { lit "/jot"; keys Enter; sleep 1.5; }
close_pane() { keys Escape; sleep 0.5; }
snap() { shot $1 "$2" >/dev/null; keep $1; echo $1; }

dark160() {
  export SCREENS_THEME=dark
  start few 160 44
  open_pane; snap search-empty-160 "search · empty query"
  lit "cache"; sleep 1; snap search-typing-160 "search · typing"
  keys BSpace BSpace BSpace BSpace BSpace; lit "kubernetes"; sleep 1; snap search-nomatch-160 "search · no match"
  close_pane

  start many 160 44
  open_pane; keys Enter l; sleep 1; snap list-grouped-160 "list · grouped"
  keys Down z; sleep 1; snap list-folded-160 "list · folded"
  keys h; sleep 1; snap list-history-160 "list · history"
  keys h z; keys v Down Down v Down v; sleep 1; snap picked-160 "list · 3 picked"
  keys b; sleep 1; snap bundle-160 "bundle preview"
  keys x x; sleep 0.5; keys i; sleep 1; snap keysheet-160 "key sheet"
  keys i; keys e; sleep 1; snap edit-160 "edit"
  keys Tab Enter; sleep 0.5
  keys n; lit "check the arm runner minutes"; keys Enter; lit "the inline pane has 11 rows"; sleep 1; snap capture-160 "capture"
  close_pane
  open_pane; keys Enter l; for i in $(seq 1 26); do T send-keys -t rv Down; sleep 0.3; done; sleep 1; snap paging-160 "list · paged, sentinels"
  close_pane
  echo 'not a note' > $R/fixture-many/notes/broken.md; sleep 2.5
  open_pane; snap problem-160 "storage problem row"
  T send-keys -t rv C-x Tab; sleep 1; snap unfocused-160 "pane open, prompt has the keys"
  close_pane

  start empty 160 44
  open_pane; snap empty-160 "empty inbox"
}

inline100() {
  export SCREENS_THEME=dark
  start many 100 40
  open_pane; lit "cache"; sleep 1; snap search-typing-100 "inline · typing"
  keys Enter l; sleep 1; snap list-grouped-100 "inline · list"
  keys n; lit "jot from the inline pane"; sleep 1; snap capture-100 "inline · capture"
}

light160() {
  export SCREENS_THEME=light
  start many 160 44
  open_pane; lit "cache"; sleep 1; snap search-typing-light-160 "light · typing"
  keys Enter l; sleep 1; snap list-grouped-light-160 "light · list"
  keys v Down Down v; sleep 1; snap picked-light-160 "light · picked"
  keys x n; lit "a light-theme note"; sleep 1; snap capture-light-160 "light · capture"
}

[ $# -eq 0 ] && set -- dark160 inline100 light160
for part in "$@"; do $part; done
T kill-server
