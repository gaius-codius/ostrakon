#!/usr/bin/env bash
# Installs ostrakon without cloning it first: clones the repo (or updates a clone made before),
# then runs its install.sh. Safe to run again.
#   curl -fsSL https://raw.githubusercontent.com/gaius-codius/ostrakon/main/get.sh | bash
#   ... | bash -s -- --hub    also set up the hub
#   ... | bash -s -- --main   follow main (the newest code) instead of releases
# The clone goes in ~/.local/share/ostrakon-src; set OSTRAKON_SRC to put it somewhere else, and
# OSTRAKON_REPO to install from a fork.
set -euo pipefail

# All in a function, called on the last line: a download cut off halfway runs nothing.
main() {
  local repo=${OSTRAKON_REPO:-https://github.com/gaius-codius/ostrakon.git}
  local src=${OSTRAKON_SRC:-${XDG_DATA_HOME:-$HOME/.local/share}/ostrakon-src}
  local track=--release install=()
  for arg in "$@"; do
    case $arg in
      --hub) install+=(--hub) ;;
      --main) track=--main ;;
      -h | --help) printf '%s\n' "usage: get.sh [--hub] [--main]   (see the comment at the top of get.sh)"; return 0 ;;
      *) echo "get.sh: unknown option: $arg" >&2; return 1 ;;
    esac
  done

  command -v git >/dev/null || { echo "get.sh: git is needed; install it and run this again" >&2; return 1; }

  if [ -d "$src/.git" ]; then
    echo "== ostrakon is already in $src; updating it"
    "$src/update.sh" "$track"
  elif [ -e "$src" ]; then
    echo "get.sh: $src exists but isn't a clone of ostrakon; move it or set OSTRAKON_SRC" >&2
    return 1
  else
    echo "== cloning ostrakon into $src"
    mkdir -p "$(dirname "$src")"
    git clone --quiet "$repo" "$src"
    [ "$track" = --main ] || "$src/update.sh" --release
  fi
  "$src/install.sh" ${install[@]+"${install[@]}"}
}

main "$@"
