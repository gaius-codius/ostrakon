#!/usr/bin/env bash
# P4 screenshots, mod side: a phone note arriving in the open pane, the footer while the hub is
# unreachable, and after it's back. Runs its own hub (server/hub.ts) on 127.0.0.1:8793 with a
# throwaway database. Output: working-docs/screens/p4/<name>.png and working-docs/screens/p4/crops/ (the pane).
# The phone form's own screenshots (phone-*.png) come from the PWA run, not this script.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); ROOT=$(cd "$HERE/../.." && pwd)
source $HERE/lib.sh
OUT=$ROOT/working-docs/screens/p4; mkdir -p $OUT/crops
PORT=8793; TOKEN=screens; HUBDATA=$R/hub-p4
keep() { cp $R/shots/$1.png $OUT/$1.png; [ -n "${2:-}" ] && magick $OUT/$1.png -crop $2 +repage $OUT/crops/$1.png; }
snap() { sleep 1; shot $1 "$2" >/dev/null; keep $1 "${3:-}"; echo $1; }
DOCKED=612x700+752+30; INLINE=850x350+16+405

hub_up() { T kill-session -t hub 2>/dev/null; T new-session -d -s hub -c $ROOT "HUB_PORT=$PORT HUB_DATA=$HUBDATA HUB_TOKEN=$TOKEN bun server/hub.ts"
  for _ in $(seq 1 20); do curl -sf 127.0.0.1:$PORT/healthz >/dev/null && return; sleep 0.25; done; echo "hub didn't start" >&2; }
hub_down() { T kill-session -t hub 2>/dev/null; sleep 0.5; }
jot() { curl -sf -XPOST -H "Authorization: Bearer $TOKEN" 127.0.0.1:$PORT/api/jot -d "{\"text\":\"$1\"}" >/dev/null; }
settings() { # theme
  local f=$R/p4-settings-$1.json
  local opts="{\"hubUrl\":\"http://127.0.0.1:$PORT\",\"hubToken\":\"$TOKEN\"}"
  echo "{\"theme\":\"$1\",\"pluginConfigs\":{\"ostrakon\":{\"options\":$opts},\"ostrakon@inline\":{\"options\":$opts}}}" > $f
  echo $f
}

rm -rf $HUBDATA; hub_up
SCREENS_SETTINGS=$(settings dark); export SCREENS_SETTINGS
start few 160 44
lit "/jot"; keys Enter; sleep 1.5; keys C-l; sleep 1
jot "pick up the long USB-C cable on the way home"; sleep 1.5
snap phone-arrives-160 "hub · a note saved on the phone appears in the open pane (▪ = phone)" $DOCKED
hub_down; keys d; sleep 3
snap hub-offline-160 "hub · unreachable: the archive waits, the footer counts it" $DOCKED
hub_up; sleep 4
snap hub-back-160 "hub · back: the queue went out, the footer is quiet again" $DOCKED

hub_down
start few 100 40
lit "/jot"; keys Enter; sleep 1.5; keys C-l; sleep 1; keys d; sleep 3
snap hub-offline-100 "hub · unreachable, inline at 100 columns" $INLINE

hub_up
SCREENS_SETTINGS=$(settings light); export SCREENS_SETTINGS
start few 160 44
lit "/jot"; keys Enter; sleep 1.5; keys C-l; sleep 1
hub_down; keys d; sleep 3
snap hub-offline-light-160 "hub · unreachable, light theme" $DOCKED

hub_down; T kill-session -t rv 2>/dev/null
