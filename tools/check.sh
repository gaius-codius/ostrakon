#!/usr/bin/env bash
# Static checks for the mod: validate, names (tools/check-names.sh), design, type-check, tests, the
# phone in WebKit (tools/phone), lint (tools/lint.sh). Run from anywhere.
# Type-checking the mod needs .claude-plugin/types/, which the engine writes when it loads
# the mod (any `claude --plugin-dir plugin` session, e.g. tools/screens/lib.sh start). The hub
# and the mod's engine-free files are checked without it, as CI does (server/tsconfig.json).
set -euo pipefail
P=$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugin" && pwd)
echo "== validate"; claude plugin validate "$P" | grep -E '✔|✘|❯ .*(error|refus)' || true
claude plugin validate "$P" >/dev/null
"$P/../tools/check-names.sh"
# docs/DESIGN.md against the code, and its changelog against the one where this branch left
# origin/main, when there is one: a branch that is only behind main isn't removing main's entries.
# CI checks the branch merged into main, so it catches two branches taking the same version.
base=$(git -C "$P" merge-base origin/main HEAD 2>/dev/null || echo origin/main)
echo "== design"; bun "$P/../tools/check-design.ts" --base "$base"
bun test "$P/../tools/check-design.test.ts"
# The TypeScript server/package.json pins, for both configs. The mod's on its own line: set -e
# ignores a failure on the left of &&.
echo "== tsc"; (cd "$P/../server" && bun install --frozen-lockfile >/dev/null && bun run typecheck)
"$P/../server/node_modules/.bin/tsc" -p "$P"
echo "tsc ok"
echo "== test"; claude plugin test "$P"
echo "== hub test"; (cd "$P/../server" && bun test)
echo "== phone"; "$P/../tools/phone/run.sh"
echo "== lint"; "$P/../tools/lint.sh"
