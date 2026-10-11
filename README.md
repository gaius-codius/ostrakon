# ostrakon

A scratchpad for Claude Code: capture thoughts and follow-ups from within claude code without breaking your flow, triage them across projects and machines, and turn them into prompts. An optional small hub keeps your notes in sync between machines and serves a phone app for capturing and triaging on the go.

## What it does

- **Capture** a note in under two seconds, even while Claude is working, without losing your prompt draft: `/jot text`, or `//` typed into an empty prompt.
- **Triage** open notes for this project or across all of them in a searchable pane: edit, move, archive, bundle several into one prompt.
- **Dispatch** a note into the prompt. This project's open notes sit in a row of numbered chips above the prompt (the "pocket"); press a note's number in an empty prompt to pull it in.
- **Harvest** (opt-in): after each turn, an extra review looks for side issues that came up and offers them as notes, which you keep or dismiss. It doesn't change what Claude is doing.
- **Sync** notes both ways between machines, through a small hub, a plain folder, or both ([Sync](#sync)).
- **Phone**: capture and triage from your phone with the hub's web app, installed to the Home Screen, or send a note from the share sheet or Siri with an iOS Shortcut.

Notes are plain Markdown files with some YAML. One per note, in `~/.local/share/ostrakon/` by default, so they are yours to read, grep and back up.

## Sync

Sync is optional and works both ways. Add, edit, move or archive a note on one machine or on your phone, and the change shows up everywhere else. If the same note changes in two places, the later change wins everywhere. There are a few ways to sync; use one or combine them:

- **The hub** (`server/`): a small service you run on one of your machines. Your other machines and your phone reach it over Tailscale (the easy option) or your own HTTPS proxy, tunnel or VPN. Changes show up in other sessions within seconds, and the hub also serves the phone app. Setup: [the hub and the phone app](#the-hub-and-the-phone-app-optional).
- **A folder** (the `mirrorDir` option): ostrakon keeps a copy of your notes in a folder, and whatever syncs that folder (Dropbox, Syncthing, any synced drive) carries them between machines. Point it at an Obsidian vault and you can edit notes there too; your edits come back. No server needed.
- **Both at once**: they work independently, so you can use the hub for your phone and a folder for Obsidian.

**On your phone**, the hub's web app installs to the Home Screen and opens straight to a note field. You can triage there too (edit, move, archive, mark sent), and anything you capture offline is kept until the hub is reachable again. To pair a phone, scan the QR code that `ostrakon pair` shows. An iOS Shortcut can send a note from the share sheet or Siri without opening the app. Details: [`docs/phone.md`](docs/phone.md).

## Install

### Requirements

- **Claude Code** with mods support (see the [mods docs](https://code.claude.com/docs/en/plugins/mods/overview)). Tested with 2.1.294; mods are still changing, so a much older or newer version may not work.
- **git**, and **python3** for the install script (without it, the script tells you the one line to add yourself).
- **For the hub:** [Bun](https://bun.sh) (tested with 1.4.2), and `qrencode` to pair a phone. `install.sh --hub` sets the hub up as a systemd service, so that part is Linux-only for now; elsewhere, run `ostrakon hub` however you like to keep things running.

Tested on Linux. macOS should work for the mod but hasn't been tried yet; reports are welcome.

### Install it

Clone this repo and run the install script:

```sh
git clone https://github.com/gaius-codius/ostrakon.git
cd ostrakon && ./install.sh --release
```

The script:

- switches to the newest [release](https://github.com/gaius-codius/ostrakon/releases) (leave out `--release` to run what's on `main`),
- loads the mod in every Claude Code session, by setting `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (only if it isn't set already, and it keeps a `.bak` copy),
- and adds the `ostrakon` command to `~/.local/bin`.

It's safe to run again. `./install.sh --hub` also sets up the hub (below).

To try it without installing anything, load it for a single session: `claude --plugin-dir ostrakon/plugin`. To install by hand, add the folder to `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/ostrakon/plugin" } }
```

### Updating

```sh
ostrakon update             # or ./update.sh in the repo
ostrakon update --main      # switch to the newest code on main instead of releases
ostrakon update --release   # switch back to releases
ostrakon version
```

If you installed a release, `update` moves you to the newest one; if you're on a branch, it pulls that branch (and stops rather than touch commits of your own). It restarts the hub if it's running and lists what changed. Restart any open Claude Code sessions to pick up the new version. Each release's changes are in [`CHANGELOG.md`](CHANGELOG.md).

### Keybindings

A mod can't add keyboard shortcuts of its own, so ostrakon borrows some existing Claude Code actions (which is why the names below look unrelated). Bind your keys to them in `~/.claude/keybindings.json`:

```json
{
  "bindings": [
    { "context": "Chat", "bindings": { "ctrl+x s": "app:cycleDiffBase" } },
    {
      "context": "Pane",
      "bindings": {
        "ctrl+x s": "app:cycleDiffBase", "ctrl+q": "pane:previous", "ctrl+f": "app:toggleDiffNoiseFilter",
        "ctrl+s": "app:toggleDiffPreSession", "ctrl+n": "pane:next", "ctrl+l": "app:toggleReplTab"
      }
    },
    {
      "context": "PaneField",
      "bindings": {
        "ctrl+x s": "app:cycleDiffBase", "ctrl+q": "pane:previous", "ctrl+f": "app:toggleDiffNoiseFilter",
        "ctrl+s": "app:toggleDiffPreSession", "ctrl+n": "pane:next", "ctrl+l": "app:toggleReplTab"
      }
    }
  ]
}
```

`ctrl+x s` opens and closes the pane; the other keys work inside it. `/jot` and `//` need no setup. The full key list is in [`docs/SPEC.md`](docs/SPEC.md) §4.

## Configuration

Set these under the plugin's options (`pluginConfigs.ostrakon.options` in your settings):

| Option | Default | What it does |
|---|---|---|
| `notesDir` | `~/.local/share/ostrakon` | Where notes are stored. The `OSTRAKON_DIR` environment variable overrides it. |
| `pocket` / `pocketMax` | on / 5 | The numbered chips above the prompt, and how many show. |
| `harvest` | off | Review each finished turn for side issues worth keeping. |
| `harvestMode` | `fork` | `fork` reviews the whole conversation, tool output included, so it sees more but costs more as the conversation grows. `light` has a small model read only your prompt and Claude's final answer: much cheaper, but it misses more. |
| `harvestMaxPerTurn` | 3 | The most notes harvest offers after one turn. |
| `hubUrl` / `hubToken` | empty | The hub to sync with, and its token. Empty: no hub. |
| `mirrorDir` | empty | A folder to keep a synced copy of your notes in, such as a Dropbox or Syncthing folder or part of an Obsidian vault. |

## The hub and the phone app (optional)

The hub is a single [Bun](https://bun.sh) file (`server/hub.ts`) that stores notes in SQLite. It only listens on the machine it runs on and needs a token for every request, so you choose how other devices reach it. We use Tailscale, the simplest option: `tailscale serve` gives it an HTTPS address only your devices can reach, and `install.sh` and `ostrakon pair` set it up for you.

```sh
./install.sh --hub
```

This creates a token in `~/.config/ostrakon-hub/env` (if there isn't one yet) and installs and starts the hub as a systemd user service (`server/ostrakon-hub.service`). It then prints the two steps left for you: `loginctl enable-linger`, so the hub keeps running when you log out, and `tailscale serve`, to put it on your tailnet.

To pair a phone, run `ostrakon pair` (it needs `qrencode`) and scan the QR code. The code in it works once and expires after 5 minutes, so the QR never contains the token itself; `--token` prints a link that does.

To run the hub in the foreground instead: `HUB_TOKEN=$(openssl rand -hex 24) ostrakon hub`. The `ostrakon` command reads `HUB_TOKEN` from the environment or from `~/.config/ostrakon-hub/env`.

Not using Tailscale? Any HTTPS reverse proxy, tunnel or VPN works too; see [Open it](docs/phone.md#open-it).

The service runs `~/.local/bin/ostrakon hub`, so it doesn't matter where the repo lives. Phone setup, the Home Screen app and the iOS Shortcut are covered in [`docs/phone.md`](docs/phone.md). Read [`SECURITY.md`](SECURITY.md) before making the hub reachable from other devices.

## Development

- How it's designed, and notes on the platform it builds on: [`docs/SPEC.md`](docs/SPEC.md). Ideas for what's next: [`ROADMAP.md`](ROADMAP.md).
- `tools/check.sh` runs every check: `claude plugin validate`, the type-check, `claude plugin test` and the hub's tests. The mod's tests and type-check need the `claude` CLI installed, because the mods test kit and types ship with it.
- The hub's tests need only [Bun](https://bun.sh): `cd server && bun test`.
- How to contribute, and how releases are made: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- `tools/` also has the screenshot pipeline and some experiment scripts; they write to `working-docs/`, which git ignores.

## License

[MIT](LICENSE)
