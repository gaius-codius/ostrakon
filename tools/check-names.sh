#!/usr/bin/env bash
# plugin/tests/world.tsx's TOOL_PREFIX against the mod's name in plugin.json. The test kit loads no
# JSON, so a rename that misses world.tsx still passes the tests. Run by tools/check.sh and CI.
set -euo pipefail
P=$(cd "$(dirname "${BASH_SOURCE[0]}")/../plugin" && pwd)
echo "== names"
name=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$P/.claude-plugin/plugin.json")
grep -qxF "export const TOOL_PREFIX = 'mcp__${name}__'" "$P/tests/world.tsx" || { echo "tests/world.tsx TOOL_PREFIX doesn't match plugin.json's name ($name)"; exit 1; }
echo "names ok"
