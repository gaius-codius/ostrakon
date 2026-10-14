#!/usr/bin/env bash
# Installs ostrakon without cloning it first: clones the repo (or updates a clone made before),
# then runs its install.sh. Safe to run again.
#   curl -fsSL https://raw.githubusercontent.com/gaius-codius/ostrakon/main/get.sh | bash
#   ... | bash -s -- --hub    also set up the hub
#   ... | bash -s -- --keys   add the keybindings without asking (--no-keys: skip them)
#   ... | bash -s -- --main   follow main (the newest code) instead of releases
# Run again, it updates the clone and keeps what it follows; --main switches to main.
# The clone goes in ~/.local/share/ostrakon-src; set OSTRAKON_SRC to put it somewhere else, and
# OSTRAKON_REPO to install from a fork.
set -euo pipefail

# All in a function, called on the last line: a download cut off halfway runs nothing.
main() {
  local repo=${OSTRAKON_REPO:-https://github.com/gaius-codius/ostrakon.git}
  local src=${OSTRAKON_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/ostrakon-src}
  local track='' install=()
  for arg in "$@"; do
    case $arg in
      --hub) install+=(--hub) ;;
      --keys | --no-keys) install+=("$arg") ;;
      --main) track=--main ;;
      -h | --help) printf '%s\n' "usage: get.sh [--hub] [--keys | --no-keys] [--main]   (see the comment at the top of get.sh)"; return 0 ;;
      *) echo "get.sh: unknown option: $arg" >&2; return 1 ;;
    esac
  done

  command -v git >/dev/null || { echo "get.sh: git is needed; install it and run this again" >&2; return 1; }

  if [ -d "$src/.git" ]; then
    # Only ever run the scripts of a clone of the repo asked for, not whatever else is there.
    local origin
    origin=$(git -C "$src" remote get-url origin 2>/dev/null || true)
    if [ "${origin%.git}" != "${repo%.git}" ] || [ ! -x "$src/install.sh" ]; then
      echo "get.sh: $src is a clone of ${origin:-something else}, not $repo; move it or set OSTRAKON_SRC" >&2
      return 1
    fi
    echo "== ostrakon is already in $src; updating it"
    # With no flag, an update keeps what the clone follows (a release, or main).
    "$src/update.sh" ${track:+"$track"}
  elif [ -e "$src" ]; then
    echo "get.sh: $src exists but isn't a clone of ostrakon; move it or set OSTRAKON_SRC" >&2
    return 1
  else
    echo "== cloning ostrakon into $src"
    mkdir -p "$(dirname "$src")"
    if [ "$track" = --main ]; then
      git clone --quiet --branch main "$repo" "$src"
    else
      git clone --quiet "$repo" "$src"
      "$src/update.sh" --release
    fi
  fi
  "$src/install.sh" ${install[@]+"${install[@]}"}
}

main "$@"
