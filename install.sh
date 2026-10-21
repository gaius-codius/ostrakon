#!/usr/bin/env bash
# Installs ostrakon from this checkout. Safe to run again; it skips what is already done.
#   ./install.sh         the mod (in every Claude Code session) and the `ostrakon` command
#   ./install.sh --hub   also the hub: a token, the systemd user unit, started now and at login
#   --keys / --no-keys   add the README's keybindings without asking, or skip them (default: ask)
#   --release            first move this checkout to the newest release (what the README's install does)
set -euo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
BIN=$HOME/.local/bin
SETTINGS=$HOME/.claude/settings.json
ENV_FILE=$HOME/.config/ostrakon-hub/env
UNIT_DIR=$HOME/.config/systemd/user
KEYS_FILE=$HOME/.claude/keybindings.json

want_hub=0 want_release=0 want_keys=ask rest=()
for arg in "$@"; do
  case $arg in
    --hub) want_hub=1; rest+=("$arg") ;;
    --release) want_release=1 ;;
    --keys) want_keys=yes; rest+=("$arg") ;;
    --no-keys) want_keys=no; rest+=("$arg") ;;
    -h | --help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown option: $arg" >&2; exit 1 ;;
  esac
done

say() { printf '%s\n' "$*"; }
has() { command -v "$1" >/dev/null; }

# Checking out a release rewrites this file, so the move and the re-run are one command bash reads whole.
if [ $want_release = 1 ]; then
  {
    "$ROOT/update.sh" --release && exec "$ROOT/install.sh" ${rest[@]+"${rest[@]}"}
    exit 1
  }
fi

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
if settings.get('enabledPlugins', {}).get('ostrakon@ostrakon'):
    print("installed from the marketplace (ostrakon@ostrakon), so not loading it from here too")
elif plugin in current:
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

# The keybindings: the README's, added to ~/.claude/keybindings.json key by key. A key bound to
# something else, or an action the person already gave another key, is left as it is.
keys_py=$(cat <<'EOF'
import json, os, shutil, sys
mode, path = sys.argv[1], sys.argv[2]
pane = {"ctrl+x s": "app:cycleDiffBase", "ctrl+q": "pane:previous", "ctrl+f": "app:toggleDiffNoiseFilter",
        "ctrl+s": "app:toggleDiffPreSession", "ctrl+n": "pane:next", "ctrl+x i": "app:toggleReplTab"}
want = {"Chat": {"ctrl+x s": "app:cycleDiffBase"}, "Pane": pane, "PaneField": pane}
try:
    keys = json.load(open(path)) if os.path.exists(path) else {}
    blocks = keys.setdefault("bindings", [])
    assert isinstance(blocks, list)
except (ValueError, AssertionError):
    print(f"! {path} isn't valid keybindings JSON; add them yourself: README.md, Keybindings")
    sys.exit(1)
added, skipped = [], []
for context, chords in want.items():
    mine = [b for b in blocks if isinstance(b, dict) and b.get("context") == context]
    bound = {k: v for b in mine for k, v in b.get("bindings", {}).items()}
    for key, action in chords.items():
        if bound.get(key) == action:
            continue
        if key in bound:
            skipped.append(f"{context} {key} (bound to {bound[key]})")
        elif action in bound.values():
            skipped.append(f"{context} {action} (already on another key)")
        else:
            if not mine:
                mine = [{"context": context, "bindings": {}}]
                blocks.append(mine[0])
            mine[0].setdefault("bindings", {})[key] = action
            added.append(f"{context} {key}")
if mode == "check":
    if not added:
        print(f"already set in {path}" + (f"; left alone: {', '.join(skipped)}" if skipped else ""))
    sys.exit(0 if added else 1)
if os.path.exists(path):
    shutil.copy2(path, path + ".bak")
else:
    keys = {"$schema": "https://www.schemastore.org/claude-code-keybindings.json", **keys}
with open(path, "w") as out:
    json.dump(keys, out, indent=2)
    out.write("\n")
print(f"added {len(added)} keys to {path}" + (f" (backup: {path}.bak)" if os.path.exists(path + ".bak") else ""))
for s in skipped:
    print(f"  left alone: {s}")
EOF
)
say "== keybindings"
if [ $want_keys = no ]; then
  say "skipped; to add them later: ./install.sh --keys"
elif ! has python3; then
  say "! python3 not found; add them yourself: README.md, Keybindings"
elif python3 -I -c "$keys_py" check "$KEYS_FILE"; then
  answer=n
  if [ $want_keys = yes ]; then
    answer=y
  elif { : </dev/tty; } 2>/dev/null; then
    # From /dev/tty, so the question still works when get.sh is piped into bash.
    read -r -p "add ostrakon's keybindings (ctrl+x s opens the pane) to $KEYS_FILE? [Y/n] " answer </dev/tty || answer=n
    answer=${answer:-y}
  fi
  case $answer in
    [Yy]*) mkdir -p "$(dirname "$KEYS_FILE")"; python3 -I -c "$keys_py" apply "$KEYS_FILE" ;;
    *) say "not added; to add them later: ./install.sh --keys (or by hand: README.md, Keybindings)" ;;
  esac
fi

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
