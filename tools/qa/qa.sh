# QA harness for the folder adapter. Source it.
#   qstart NAME MIRROR [HUBURL]   launch an isolated claude session (own notes folder Q/NAME)
#   qjot NAME "text"               /jot a note in that session
#   qkeys NAME k1 k2 ...           send tmux keys;  qlit NAME "text"  literal text
#   qshot NAME shotname "caption"  capture the session to $Q/shots/<shotname>.png
#   qwait SECONDS 'test command'   poll until the test passes; prints elapsed ms or TIMEOUT
#   qstop NAME / qstopall
# Isolation: CLAUDE_CODE_PLUGIN_DIRS empty, settings with hubUrl empty unless given (a test hub only).
Q=${QA_DIR:-/tmp/ostrakon-qa}
P=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../plugin" && pwd)
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
VAULT="${QA_VAULT:-$HOME/Documents/vault/ostrakon}"
DBX=${QA_DROPBOX:-$HOME/Dropbox/ostrakon-qa}
mkdir -p $Q/shots
QT() { tmux -L qa "$@"; }
qstart() { # name mirror [hub]
  local name=$1 mirror=$2 hub=${3:-} tok=${3:+test}
  mkdir -p $Q/$name
  python3 - "$Q/settings-$name.json" "$mirror" "$hub" "$tok" <<'EOF'
import json, sys
path, mirror, hub, tok = sys.argv[1:5]
opts = {"hubUrl": hub, "hubToken": tok, "mirrorDir": mirror}
json.dump({"theme": "dark", "env": {"CLAUDE_CODE_PLUGIN_DIRS": ""},
           "pluginConfigs": {"ostrakon": {"options": opts}, "ostrakon@inline": {"options": opts}}}, open(path, "w"))
EOF
  QT kill-session -t $name 2>/dev/null
  QT new-session -d -s $name -x 160 -y 40 -c "${QA_CWD:-$HOME}" \
    "CLAUDE_CODE_PLUGIN_DIRS= OSTRAKON_DIR=$Q/$name COLORTERM=truecolor claude --plugin-dir $P --debug-file $Q/debug-$name.log --settings $Q/settings-$name.json"
  for i in $(seq 1 40); do QT capture-pane -p -t $name | grep -q "shift+tab" && break; sleep 1; done; sleep 3
}
qkeys() { local n=$1; shift; for k in "$@"; do QT send-keys -t $n "$k"; sleep 0.35; done; sleep 1; }
qlit() { QT send-keys -t $1 -l "$2"; sleep 0.5; }
qjot() { QT send-keys -t $1 -l "/jot $2"; sleep 0.4; QT send-keys -t $1 Enter; sleep 0.5; }
qshot() { # name shot caption
  QT capture-pane -e -N -p -t $1 > $Q/shots/$2.ans
  SHOT_THEME=dark python3 -I $TOOLS/gallery/ansi2html.py $Q/shots/$2.ans $Q/shots/$2.html "$3"
  chromium --headless=new --disable-gpu --hide-scrollbars --screenshot=$Q/shots/$2.png --window-size=1400,770 file://$Q/shots/$2.html >/dev/null 2>&1
}
qwait() { # seconds 'test'
  local t0=$(date +%s%N) limit=$(( $1 * 20 ))
  for i in $(seq 1 $limit); do if eval "$2" >/dev/null 2>&1; then echo "$(( ($(date +%s%N) - t0) / 1000000 ))ms"; return 0; fi; sleep 0.05; done
  echo TIMEOUT; return 1
}
qstop() { QT kill-session -t $1 2>/dev/null; }
qstopall() { QT kill-server 2>/dev/null; }
# The note file holding some text, in a folder.
qfind() { local f; f=$(grep -l -F -- "$2" "$1"/*.md 2>/dev/null | head -1); [ -n "$f" ] && echo "$f"; }
