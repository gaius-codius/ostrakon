#!/usr/bin/env bash
# Static checks for the mod: validate, design, type-check, tests, the phone in WebKit (tools/phone), lint
# (tools/lint.sh). Run from anywhere.
# Type-checking the mod needs .claude-plugin/types/, which the engine writes when it loads
# the mod (any `claude --plugin-dir plugin` session, e.g. tools/screens/lib.sh start). The hub
# and the mod's engine-free files are checked without it, as CI does (server/tsconfig.json).
set -euo pipefail
P=$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugin" && pwd)
echo "== validate"; claude plugin validate "$P" | grep -E '✔|✘|❯ .*(error|refus)' || true
claude plugin validate "$P" >/dev/null
echo "== names"; name=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$P/.claude-plugin/plugin.json")
grep -q "TOOL_PREFIX = 'mcp__${name}__'" "$P/tests/world.tsx" || { echo "tests/world.tsx TOOL_PREFIX doesn't match plugin.json's name ($name)"; exit 1; }
echo "names ok"
# docs/DESIGN.md against the code, and its changelog against origin/main's when there is one.
echo "== design"; bun "$P/../tools/check-design.ts" --base origin/main
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
