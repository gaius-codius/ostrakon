# Screenshot pipeline for ostrakon v2. Source it, then:
#   start <fixture> <cols> <rows>   generate fixture, launch claude in tmux (cwd $SCREENS_CWD)
#   keys k1 k2 ...                  send tmux keys; lit "text"  send literal text
#   shot <name> "<caption>"         capture pane -> $R/shots/<name>.{ans,html,png}
# Env: SCREENS_DIR (default /tmp/ostrakon-screens), SCREENS_CWD (session cwd), SCREENS_SESSION (a
#      session id for claude, so fixtures can name the session),
#      SCREENS_THEME=light for a light-theme session (per session, no global config touched),
#      SCREENS_SETTINGS=<file> a settings file for the session instead (it carries the theme then),
#      SCREENS_KEY / SCREENS_PATH the project key and path the fixture gives this session's notes.
# Uses a private tmux socket (-L ostrakon-shots), so it never touches your tmux.
# Fixture dir: $R/fixture-<name>/ (OSTRAKON_DIR); claude debug log: $R/debug.log.
# Needs: tmux, chromium, python3.
R=${SCREENS_DIR:-/tmp/ostrakon-screens}; mkdir -p $R/shots; TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# The plugin of the checkout this script is in (a worktree screenshots its own work).
PLUGIN=$(cd "$TOOLS/../../plugin" && pwd)
SCREENS_CWD=${SCREENS_CWD:-$R/project}; mkdir -p "$SCREENS_CWD"
# Set DEBUG_LOG empty (after sourcing) for a session without the debug banner.
DEBUG_LOG=$R/debug.log
T() { tmux -L ostrakon-shots "$@"; }
# Settings for a fixture session: the theme, and no hub. The person's own settings configure their
# real hub; a fixture session must never sync its notes into it (P4: it did, once).
isolated() {
  local f=$R/isolated-${SCREENS_THEME:-dark}.json
  # CLAUDE_CODE_PLUGIN_DIRS emptied: the person's settings load their installed plugin, which must
  # not load beside the one under test. SCREENS_OPTIONS adds options (e.g. '"harvest":true').
  local opts="{\"hubUrl\":\"\",\"hubToken\":\"\"${SCREENS_OPTIONS:+,$SCREENS_OPTIONS}}"
  echo "{\"theme\":\"${SCREENS_THEME:-dark}\",\"env\":{\"CLAUDE_CODE_PLUGIN_DIRS\":\"\"},\"pluginConfigs\":{\"ostrakon\":{\"options\":$opts},\"ostrakon@inline\":{\"options\":$opts}}}" > $f
  echo $f
}
start() { # fixture cols rows
  local fx=$R/fixture-$1
  python3 -I $TOOLS/fixture.py $1 $fx --cwd "$SCREENS_CWD" ${SCREENS_KEY:+--key "$SCREENS_KEY"} ${SCREENS_PATH:+--path "$SCREENS_PATH"} || return 1
  T kill-session -t rv 2>/dev/null
  [ -z "$DEBUG_LOG" ] || rm -f "$DEBUG_LOG"
  T new-session -d -s rv -x $2 -y $3 -c "$SCREENS_CWD" \
    "CLAUDE_CODE_PLUGIN_DIRS= OSTRAKON_DIR=$fx COLORTERM=truecolor claude --plugin-dir $PLUGIN ${DEBUG_LOG:+--debug-file $DEBUG_LOG} ${SCREENS_SESSION:+--session-id $SCREENS_SESSION} --settings ${SCREENS_SETTINGS:-$(isolated)}"
  for _ in $(seq 1 30); do
    T capture-pane -p -t rv | grep -q "shift+tab" && break
    # A folder Claude Code hasn't seen asks to be trusted first, defaulting to No: the screenshot
    # folder is this script's own, so say yes.
    if T capture-pane -p -t rv | grep -q "Yes, I trust this folder"; then T send-keys -t rv Down; sleep 0.3; T send-keys -t rv Enter; fi
    sleep 1
  done; sleep 3
  COLS=$2; ROWS=$3
}
keys() { for k in "$@"; do T send-keys -t rv "$k"; sleep 0.35; done; sleep 1.2; }
lit() { T send-keys -t rv -l "$1"; sleep 0.8; }
shot() { # name "caption"
  T capture-pane -e -N -p -t rv > $R/shots/$1.ans
  SHOT_THEME=${SCREENS_THEME:-dark} python3 -I $TOOLS/../gallery/ansi2html.py $R/shots/$1.ans $R/shots/$1.html "$2"
  w=$(( COLS * 85 / 10 + 40 )); h=$(( ROWS * 175 / 10 + 70 ))
  chromium --headless=new --disable-gpu --hide-scrollbars --screenshot=$R/shots/$1.png --window-size=$w,$h file://$R/shots/$1.html >/dev/null 2>&1
  echo "$1.png"
}
