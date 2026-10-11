#!/usr/bin/env bash
# Code-quality checks, the same here and in CI. The tools are pinned in mise.toml (`mise install`).
#   - biome: formats and lints the TypeScript, JavaScript, JSON and CSS (biome.json)
#   - shellcheck: every shell script, warnings included
#   - actionlint: the GitHub workflows
#   - typos: spelling in code and docs (_typos.toml)
#   - lychee: links between the docs, #section anchors included (offline: nothing is fetched)
# tools/lint.sh --fix lets biome format and fix what it safely can, then checks.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1
# Outside a mise-activated shell, run through mise so the pinned versions are the ones used.
if [ -z "${OSTRAKON_LINT_MISE:-}" ] && command -v mise >/dev/null; then
  OSTRAKON_LINT_MISE=1 exec mise exec -- "$0" "$@"
fi
for tool in biome shellcheck actionlint typos lychee; do
  command -v "$tool" >/dev/null || { echo "lint: $tool not found; install mise (https://mise.jdx.dev), then: mise install" >&2; exit 1; }
done

# Reported, but not failing yet: the code hasn't had its one-off format. Take a name out once its
# tool's findings are fixed.
PENDING=' biome '
failed='' pending=''
check() { # name command...
  local name=$1
  shift
  echo "== $name"
  case $PENDING in
    *" $name "*) "$@" >/dev/null 2>&1 || { pending+=" $name"; echo "has findings (not failing yet); to see them: $1 check ."; } ;;
    *) "$@" || failed+=" $name" ;;
  esac
}

[ "${1:-}" = --fix ] && biome check --write . >/dev/null 2>&1
# Every tracked shell script: *.sh and anything whose first line runs bash.
scripts=()
while IFS= read -r file; do
  case $file in *.sh) scripts+=("$file") ;; *) head -n 1 "$file" 2>/dev/null | grep -q '^#!.*bash' && scripts+=("$file") ;; esac
done < <(git ls-files)
docs=()
while IFS= read -r file; do docs+=("$file"); done < <(git ls-files '*.md')

check biome biome ci .
check shellcheck shellcheck -s bash -S warning "${scripts[@]}"
check actionlint actionlint
check typos typos
check lychee lychee --offline --include-fragments --no-progress "${docs[@]}"

echo
[ -n "$pending" ] && echo "not failing yet (see PENDING in tools/lint.sh):$pending"
if [ -n "$failed" ]; then echo "failed:$failed"; exit 1; fi
echo "lint ok"
