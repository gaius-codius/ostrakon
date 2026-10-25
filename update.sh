#!/usr/bin/env bash
# Updates this checkout and restarts what runs from it. Also `ostrakon update`.
#   ./update.sh            a checkout on a release moves to the newest release; one on a branch pulls it
#   ./update.sh --release  move to the newest release (from a branch too)
#   ./update.sh --main     move to main and pull it (the newest code, not yet released)
# Then the `ostrakon` link is kept and the hub restarted if it's installed and running: after new
# code, or when it still runs an older release than this checkout.
set -euo pipefail

# All in a function: git may rewrite this file mid-run, and bash reads a script as it goes.
main() {
  local root mode=auto before after target
  root=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
  for arg in "$@"; do
    case $arg in
      --release) mode=release ;;
      --main) mode=main ;;
      -h | --help) sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) echo "update.sh: unknown option: $arg" >&2; return 1 ;;
    esac
  done
  say() { printf '%s\n' "$*"; }
  g() { git -C "$root" "$@"; }

  if [ $mode = auto ]; then
    if g symbolic-ref -q HEAD >/dev/null; then mode=branch; else mode=release; fi
  fi
  before=$(g rev-parse HEAD)
  if [ $mode = branch ]; then
    say "following branch $(g symbolic-ref --short HEAD)"
    g pull --ff-only --quiet || { say "! git pull failed (local commits or changes in the way?); nothing restarted"; return 1; }
  else
    [ -z "$(g status --porcelain --untracked-files=no)" ] || { say "! local changes in $root; commit or stash them first"; return 1; }
    g fetch --quiet --tags origin
    if [ $mode = main ]; then
      g checkout --quiet main && g pull --ff-only --quiet
    else
      target=$(g tag -l 'v[0-9]*' --sort=-v:refname | head -n 1)
      [ -n "$target" ] || { say "! no releases yet; try --main"; return 1; }
      g -c advice.detachedHead=false checkout --quiet "$target"
    fi
  fi
  after=$(g rev-parse HEAD)

  local updated=yes
  if [ "$before" = "$after" ]; then
    say "already up to date ($(g describe --tags --always))"
    updated=
  else
    say "updated to $(g describe --tags --always):"
    g log --format='  %h %s' "$before..$after" | head -n 30
    local link=$HOME/.local/bin/ostrakon
    if [ -L "$link" ]; then ln -sfn "$root/bin/ostrakon" "$link"; fi
  fi

  # The hub restarts after new code, and also when it still runs an older release than this
  # checkout (it was never restarted after a pull, say), which /healthz tells.
  if command -v systemctl >/dev/null && systemctl --user cat ostrakon-hub >/dev/null 2>&1; then
    systemctl --user daemon-reload
    if systemctl --user is-active --quiet ostrakon-hub; then
      local port running version
      port=$(systemctl --user show ostrakon-hub -p Environment --value | tr ' ' '\n' | sed -n 's/^HUB_PORT=//p' | tail -n 1)
      running=$(curl -s -m 3 "http://127.0.0.1:${port:-8790}/healthz" 2>/dev/null | awk '$1 == "ok" {print $2}' || true)
      version=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$root/plugin/.claude-plugin/plugin.json" | head -n 1)
      if [ -n "$updated" ] || [ "$running" != "$version" ]; then
        [ -n "$updated" ] || say "the hub runs ${running:-an older version}, this checkout $version"
        systemctl --user restart ostrakon-hub
        if systemctl --user is-active --quiet ostrakon-hub; then say "hub restarted"; else say "! hub didn't come back: journalctl --user -u ostrakon-hub"; fi
      fi
    fi
  fi
  [ -n "$updated" ] || return 0
  say "Restart running Claude Code sessions to load the new mod. What changed: CHANGELOG.md"
}

main "$@"
exit
