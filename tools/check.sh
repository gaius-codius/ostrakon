#!/usr/bin/env bash
# Static checks for the mod: validate, type-check, tests. Run from anywhere.
# Type-checking needs .claude-plugin/types/, which the engine writes when it loads
# the mod (any `claude --plugin-dir plugin` session, e.g. tools/screens/lib.sh start).
set -euo pipefail
P=$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugin" && pwd)
echo "== validate"; claude plugin validate "$P" | grep -E '✔|✘|❯ .*(error|refus)' || true
claude plugin validate "$P" >/dev/null
echo "== names"; name=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$P/.claude-plugin/plugin.json")
grep -q "TOOL_PREFIX = 'mcp__${name}__'" "$P/tests/world.tsx" || { echo "tests/world.tsx TOOL_PREFIX doesn't match plugin.json's name ($name)"; exit 1; }
echo "names ok"
# On its own line: set -e ignores a failure on the left of &&.
echo "== tsc"; npx -y -p typescript@5.6.3 tsc -p "$P"
echo "tsc ok"
echo "== test"; claude plugin test "$P"
echo "== hub test"; (cd "$P/../server" && bun test)
