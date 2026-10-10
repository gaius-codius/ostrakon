#!/usr/bin/env bash
# Installs ostrakon from this checkout. Safe to run again; it skips what is already done.
#   ./install.sh         the mod (in every Claude Code session) and the `ostrakon` command
#   ./install.sh --hub   also the hub: a token, the systemd user unit, started now and at login
set -euo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
BIN=$HOME/.local/bin
SETTINGS=$HOME/.claude/settings.json
ENV_FILE=$HOME/.config/ostrakon-hub/env
UNIT_DIR=$HOME/.config/systemd/user

want_hub=0
for arg in "$@"; do
  case $arg in
    --hub) want_hub=1 ;;
    -h | --help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
has() { command -v "$1" >/dev/null; }

has claude || say "! claude not found: install Claude Code (with mods support) to use the mod"

# The mod: CLAUDE_CODE_PLUGIN_DIRS in ~/.claude/settings.json, set only when it isn't already.
say "== mod"
if ! has python3; then
  say "! python3 not found; add this to $SETTINGS yourself:"
  say "  { \"env\": { \"CLAUDE_CODE_PLUGIN_DIRS\": \"$ROOT/plugin\" } }"
else
  mkdir -p "$(dirname "$SETTINGS")"
  python3 -I - "$SETTINGS" "$ROOT/plugin" <<'EOF'
import json, os, shutil, sys
path, plugin = sys.argv[1], sys.argv[2]
try:
    settings = json.load(open(path)) if os.path.exists(path) else {}
except ValueError:
    print(f"! {path} isn't valid JSON; add env.CLAUDE_CODE_PLUGIN_DIRS = {plugin} yourself")
    sys.exit(0)
env = settings.setdefault('env', {})
current = env.get('CLAUDE_CODE_PLUGIN_DIRS', '').strip()
if plugin in current:
    print(f"already loaded from {plugin}")
elif current:
    print(f"! CLAUDE_CODE_PLUGIN_DIRS already names other folders ({current}); add {plugin} to it yourself")
else:
    if os.path.exists(path):
        shutil.copy2(path, path + '.bak')
    env['CLAUDE_CODE_PLUGIN_DIRS'] = plugin
    with open(path, 'w') as out:
        json.dump(settings, out, indent=2)
        out.write('\n')
    print(f"set CLAUDE_CODE_PLUGIN_DIRS in {path}" + (f" (backup: {path}.bak)" if os.path.exists(path + '.bak') else ''))
EOF
fi
say "  keybindings are yours to add: README.md, Keybindings"

# The command: a link in ~/.local/bin, never over a file that isn't one of ours.
say "== ostrakon command"
mkdir -p "$BIN"
if [ -e "$BIN/ostrakon" ] && [ ! -L "$BIN/ostrakon" ]; then
  say "! $BIN/ostrakon exists and isn't a link; left alone"
else
  ln -sfn "$ROOT/bin/ostrakon" "$BIN/ostrakon"
  say "linked $BIN/ostrakon"
fi
case ":$PATH:" in *":$BIN:"*) ;; *) say "! $BIN isn't on your PATH; add it to use \`ostrakon\`" ;; esac
has bun || say "! bun not found: the command and the hub need it (https://bun.sh)"

[ $want_hub = 1 ] || { say "done. Restart Claude Code to load the mod. For the hub: ./install.sh --hub"; exit 0; }

say "== hub"
has bun || { say "! the hub needs bun"; exit 1; }
has systemctl || { say "! no systemctl: run the hub yourself with \`ostrakon hub\`"; exit 1; }
if [ -s "$ENV_FILE" ]; then
  say "token kept in $ENV_FILE"
else
  mkdir -p "$(dirname "$ENV_FILE")"
  token=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
  (umask 077; printf 'HUB_TOKEN=%s\n' "$token" > "$ENV_FILE")
  say "new token in $ENV_FILE"
fi
mkdir -p "$UNIT_DIR"
ln -sfn "$ROOT/server/ostrakon-hub.service" "$UNIT_DIR/ostrakon-hub.service"
systemctl --user daemon-reload
# Restart rather than start, so a hub already running picks up the current unit and code.
systemctl --user enable ostrakon-hub >/dev/null 2>&1 || true
systemctl --user restart ostrakon-hub || true
if systemctl --user is-active --quiet ostrakon-hub; then say "ostrakon-hub is running"; else say "! ostrakon-hub didn't start: journalctl --user -u ostrakon-hub"; fi
say "Next, by hand (they change what's reachable, so they're yours to run):"
say "  loginctl enable-linger \"\$USER\"                                     # keep it running while logged out"
say "  tailscale serve --bg --https=8443 http://127.0.0.1:8790             # put it on your tailnet"
say "  ostrakon pair                                                     # then scan with the phone"
