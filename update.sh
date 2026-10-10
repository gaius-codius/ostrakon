#!/usr/bin/env bash
# Updates this checkout and restarts what runs from it. Also `ostrakon update`.
#   git pull (fast-forward only), the `ostrakon` link kept, the hub restarted if it's installed.
set -euo pipefail

ROOT=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)
say() { printf '%s\n' "$*"; }

before=$(git -C "$ROOT" rev-parse HEAD)
git -C "$ROOT" pull --ff-only --quiet || { say "! git pull failed (local commits or changes in the way?); nothing restarted"; exit 1; }
after=$(git -C "$ROOT" rev-parse HEAD)

if [ "$before" = "$after" ]; then
  say "already up to date ($(git -C "$ROOT" log -1 --format='%h %s'))"
  exit 0
fi
say "updated $(git -C "$ROOT" rev-parse --short "$before")..$(git -C "$ROOT" rev-parse --short "$after"):"
git -C "$ROOT" log --format='  %h %s' "$before..$after"

link=$HOME/.local/bin/ostrakon
if [ -L "$link" ]; then ln -sfn "$ROOT/bin/ostrakon" "$link"; fi

if command -v systemctl >/dev/null && systemctl --user cat ostrakon-hub >/dev/null 2>&1; then
  systemctl --user daemon-reload
  if systemctl --user is-active --quiet ostrakon-hub; then
    systemctl --user restart ostrakon-hub
    if systemctl --user is-active --quiet ostrakon-hub; then say "hub restarted"; else say "! hub didn't come back: journalctl --user -u ostrakon-hub"; fi
  fi
fi
say "Restart running Claude Code sessions to load the new mod."
