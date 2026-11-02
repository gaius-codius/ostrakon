---
name: verify
description: See an ostrakon change working in the real thing, not only in tests - the pane in a live Claude Code session, the hub over HTTP, the phone app in WebKit, the hub's systemd unit. Use after tools/check.sh passes and before the final review of a change, again after review fixes that changed what was verified, and whenever asked to verify, try or screenshot a change.
---

# Verify a change

`tools/check.sh` proves the tests pass. This proves the change works where people use it: the pane in a real session, the hub over HTTP, the phone app in a browser. Do the parts the change touches, then write down what you saw.

**When:** after `tools/check.sh` passes, before the final review, so the reviewers see the evidence and a bug found here costs one fix. Again after the review only if its fixes changed something you verified.

## Rules

- **Never touch the real setup.** No real notes folder, hub, mirror, Obsidian vault, systemd unit or GitHub repo. Every session gets its own notes folder and no hub unless it's a test hub. The harnesses below do this; don't start `claude --plugin-dir` by hand.
- **Own names, for parallel runs.** Other runs may be verifying at the same time. Set `QA_DIR=/tmp/ostrakon-qa-<branch>` and `SCREENS_DIR=/tmp/ostrakon-screens-<branch>`, and start session names with the branch.
- **The engine's store is shared.** Claude Code keeps the mod's `$.store` and folder trust in your own `~/.claude`. `qstopall` says what QA changed there and how to put it back; report that, don't restore it yourself.
- **Look, don't assume.** Read the screen capture (`.ans`, or the `.png` with the Read tool) after each step and say what it shows.

## The pane, in a live session

`tools/qa/qa.sh` starts isolated sessions in a private tmux server (`tmux -L qa`) with this checkout's mod.

```bash
export QA_DIR=/tmp/ostrakon-qa-<branch>
source tools/qa/qa.sh
qstart <branch>-a ""                 # name, mirror ("" none), [hub URL]
qjot <branch>-a "a test note"        # /jot
qkeys <branch>-a C-x s               # open the pane (ctrl+x s); then the keys the change adds
qlit <branch>-a "literal text"
qshot <branch>-a step1 "pane open"   # $QA_DIR/shots/step1.{ans,html,png}
qfind $QA_DIR/<branch>-a "a test note"   # the note's file, to check what was written
qstopall                             # stop every QA session; reports store changes
```

- Walk the behaviour the issue describes, one acceptance criterion at a time, with a shot at each step that shows it.
- Check `$QA_DIR/debug-<name>.log` for errors from the mod.
- For a fixed set of notes (a crowded list, several projects), use the screenshot fixtures instead: `source tools/screens/lib.sh`, then `start <fixture> 160 40`, `keys`, `shot` (fixtures are in `tools/screens/fixture.py`).

## The hub

Start a test hub with its own data, port and token, the way `tools/phone/run.sh` does:

```bash
DATA=$(mktemp -d)
PORT=$(bun -e 'const s = Bun.serve({ port: 0, fetch: () => new Response() }); console.log(s.port); s.stop()')
HUB_PORT=$PORT HUB_DATA=$DATA HUB_TOKEN=test bun server/hub.ts >"$DATA/hub.log" 2>&1 &
curl -fsS http://127.0.0.1:$PORT/healthz
curl -fsS -H 'Authorization: Bearer test' "http://127.0.0.1:$PORT/api/changes?since=0"
```

- Exercise each new or changed endpoint with `curl`, including the refusals, and show the responses.
- Hub and pane together: `qstart <branch>-a "" http://127.0.0.1:$PORT` (QA sessions send the token `test`).
- Stop the hub and remove `$DATA` when done.

## The phone app

- `tools/phone/run.sh` runs the WebKit tests against a test hub (Docker, or `PHONE_IN=host`).
- For new or changed phone UI, add a test to `tools/phone/sheet.test.mjs` that drives it the way a finger would, and take a screenshot from that test (`page.screenshot`) into the run's folder. Read it: layout, copy, both themes if colours changed.
- Desktop WebKit isn't iOS. Say what still needs a real phone.

## The hub's systemd unit

- Don't restart or edit the installed `ostrakon-hub` unit. Copy `server/ostrakon-hub.service` to a unit with another name (`ostrakon-hub-verify-<branch>.service`) with its own `HUB_PORT`, `HUB_DATA` and env file, start that, and stop and remove it after.
- Probe from inside the sandbox, not only with `systemd-analyze --user security`: run the checks as a sibling unit with the same `[Service]` limits (`systemd-run --user --wait --pipe -p <each limit> sh -c '<probe>'`) and show each result.

## Outside services (GitHub, Claude)

- Use fakes: put stub `gh` and `claude` scripts first on `PATH` that record their arguments and print canned answers, then check the recorded arguments.
- A live check against GitHub only with the user's approval, only on a private scratch repo they name, and never with their own `gh` login when the feature is meant to use a narrow token.

## Report

Put a **Verified** section in the PR body (and the tracker record's `how_to_verify`):

- each step: what you did, and what you saw, with the shot's path or the response;
- what you couldn't verify here and why (needs a real phone, a real GitHub repo, another OS);
- anything `qstopall` reported.

A step that showed a bug goes back to the work before the review, not into the PR as a known issue.
