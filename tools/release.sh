#!/usr/bin/env bash
# Cuts a release in two steps, because main takes changes only through pull requests:
#   tools/release.sh prepare 0.2.0   on an up-to-date main: a release-v0.2.0 branch whose one commit
#                                    sets plugin.json's version and moves CHANGELOG.md's Unreleased
#                                    notes under 0.2.0. Push it and merge its PR.
#   tools/release.sh tag             on main after the merge: tags v<plugin.json's version>. Pushing
#                                    the tag makes the GitHub release (.github/workflows/release.yml).
# It never pushes; it prints the commands that publish.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
MANIFEST=$ROOT/plugin/.claude-plugin/plugin.json
g() { git -C "$ROOT" "$@"; }
die() { echo "release: $*" >&2; exit 1; }
version_of() { sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$MANIFEST" | head -n 1; }

on_fresh_main() {
  [ "$(g symbolic-ref --short -q HEAD)" = main ] || die "switch to main first"
  [ -z "$(g status --porcelain --untracked-files=no)" ] || die "commit or stash your changes first"
  g fetch --quiet --tags origin
  g merge --ff-only --quiet origin/main || die "main has commits origin/main doesn't; sort that out first"
}

case ${1:-} in
  prepare)
    v=${2:-}
    [[ $v =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || die "usage: tools/release.sh prepare <x.y.z>"
    on_fresh_main
    [ -z "$(g tag -l "v$v")" ] || die "v$v is already tagged"
    previous=$(version_of)
    g switch --quiet -c "release-v$v"
    sed -i.bak "s/^\( *\"version\": *\"\)[^\"]*\"/\1$v\"/" "$MANIFEST" && rm -f "$MANIFEST.bak"
    python3 -I - "$ROOT/CHANGELOG.md" "$v" "v$previous" "$(date +%F)" <<'EOF' || { g switch --quiet main; g branch --quiet -D "release-v$v"; g checkout --quiet -- "$MANIFEST"; exit 1; }
import re, sys
path, v, previous, day = sys.argv[1:]
text = open(path).read()
head, sep, rest = text.partition('## [Unreleased]\n')
if not sep:
    sys.exit('release: CHANGELOG.md has no "## [Unreleased]" heading')
notes, nxt, tail = rest.partition('\n## [')
if not notes.strip():
    sys.exit('release: nothing under Unreleased in CHANGELOG.md; add the notes first')
text = f'{head}## [Unreleased]\n\n## [{v}] - {day}\n\n{notes.strip()}\n{nxt}{tail}'
repo = 'https://github.com/gaius-codius/ostrakon'
text = re.sub(r'^\[Unreleased\]: .*$', f'[Unreleased]: {repo}/compare/v{v}...HEAD\n[{v}]: {repo}/compare/{previous}...v{v}', text, count=1, flags=re.M)
open(path, 'w').write(text)
EOF
    g commit --quiet -am "Release v$v"
    echo "release-v$v is ready. Publish it with:"
    echo "  git push -u origin release-v$v && gh pr create --fill"
    echo "then, once the PR is merged: git switch main && tools/release.sh tag"
    ;;
  tag)
    on_fresh_main
    v=$(version_of)
    [ -n "$v" ] || die "no version in $MANIFEST"
    [ -z "$(g tag -l "v$v")" ] || die "v$v is already tagged; run prepare for the next version"
    grep -q "^## \[$v\] - " "$ROOT/CHANGELOG.md" || die "CHANGELOG.md has no section for $v"
    g tag -a "v$v" -m "ostrakon v$v"
    echo "tagged v$v at $(g rev-parse --short HEAD). Publish it with:"
    echo "  git push origin v$v"
    ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
