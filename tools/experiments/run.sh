# Experiment harness: source it. xstart <cols> <rows>; xk keys...; xl "literal"; xcap; xlog
XR=${XR:-/tmp/spx-run}; mkdir -p $XR
X() { tmux -L spx "$@"; }
# The ostrakon plugin loads in every session (CLAUDE_CODE_PLUGIN_DIRS): no hub, and notes in $XR.
xoff='{"hubUrl":"","hubToken":""}'
echo "{\"pluginConfigs\":{\"ostrakon\":{\"options\":$xoff},\"ostrakon@inline\":{\"options\":$xoff}}}" > $XR/isolated.json
xstart() {
  X kill-session -t x 2>/dev/null; rm -f $XR/debug.log
  X new-session -d -s x -x $1 -y $2 -c "${SCREENS_CWD:-$HOME}" \
    "OSTRAKON_DIR=$XR/notes claude --plugin-dir ${XMOD:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spx} --debug-file $XR/debug.log --settings $XR/isolated.json"
  for i in $(seq 1 30); do X capture-pane -p -t x | grep -q "shift+tab" && break; sleep 1; done; sleep 2
}
xk() { for k in "$@"; do X send-keys -t x "$k"; sleep 0.4; done; sleep 1; }
xl() { X send-keys -t x -l "$1"; sleep 0.5; }
xcap() { X capture-pane -p -t x | grep -v '^\s*$'; }
xlog() { grep -E "SPX0?|SPC|spc:|ui\.open|ui\.focus|spx:|re-entry|refus" $XR/debug.log | sed -E 's/^[0-9T:.-]+Z //' | grep -v "^\[DEBUG\] Checking"; }
