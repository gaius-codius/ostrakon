# ostrakon

An ostrakon for Claude Code: capture thoughts and follow-ups from within Claude Code without breaking your flow, triage them across projects and machines, and turn them into prompts.

## What it does

- **Capture** a note in under two seconds, even while Claude is working, without losing your prompt draft: `/jot text`, or `//` typed into an empty prompt.
- **Triage** open notes for this project or across all of them in a searchable pane: edit, move, archive, bundle several into one prompt.
- **Dispatch** a note into the prompt. A row of numbered chips above the prompt (the "pocket") shows this project's open notes; press its digit in an empty prompt to pull one in. A note is marked sent once the prompt carrying it goes in.
- **Harvest** (opt-in): after each turn, one review asks the model for side issues worth keeping and shows them above the prompt for you to keep or dismiss. Claude's own work is unchanged.
- **Sync** notes both ways between machines, through a small hub, a plain folder, or both ([Sync](#sync)).
- **Phone**: capture and triage from your phone with the hub's web app, installed to the Home Screen, or send a note from the share sheet or Siri with an iOS Shortcut.

Notes are plain Markdown files with YAML front matter, one per note, in `~/.local/share/ostrakon/` by default, so they are yours to read, grep and back up.

## Sync

Sync is optional and two-way: a note captured, edited, moved or archived on one machine or on your phone shows up everywhere else, and when the same note changes in two places, every machine settles on the same winner (the later change). Use one way or combine them:

- **The hub** (`server/`): a small Bun + SQLite service on one always-on machine, reached over your tailnet with Tailscale. Changes reach other sessions within seconds, and the hub also serves the phone app. Setup: [the hub and the phone app](#the-hub-and-the-phone-app-optional).
- **A folder** (the `mirrorDir` option): ostrakon keeps a folder of readable Markdown notes in step, and whatever syncs that folder carries them between machines: Dropbox, Syncthing or any synced drive. Point it at an Obsidian vault and you can edit notes in Obsidian too; the edits come back. No server needed.
- **Both at once**: each runs on its own, so a hub for the phone and a folder for Obsidian work side by side.

**On your phone**, the hub's web app installs to the Home Screen and opens straight into a note field. It lists and triages your notes as well (edit, move, archive, mark sent), and keeps what you capture offline until the hub is back. Pair a phone by scanning the QR code from `ostrakon pair`. An iOS Shortcut can send a note from the share sheet or Siri without opening the app. Details: [`docs/phone.md`](docs/phone.md).

## Install

You need Claude Code with mods support (see the [mods docs](https://code.claude.com/docs/en/plugins/mods/overview)).

Clone this repo and run the install script:

```sh
git clone https://github.com/gaius-codius/ostrakon.git
cd ostrakon && ./install.sh --release
```

`--release` moves the checkout to the newest [release](https://github.com/gaius-codius/ostrakon/releases) first; leave it out to run what's on `main`. It loads the mod in every session (it sets `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`, keeping a `.bak` copy, and only when it isn't set yet) and links the `ostrakon` command into `~/.local/bin`. It's safe to run again. `./install.sh --hub` also sets up the hub (below).

To try it without installing anything, load the folder for one session: `claude --plugin-dir ostrakon/plugin`. To install by hand, put the folder in `~/.claude/settings.json`:

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

A checkout on a release moves to the newest release; one on a branch pulls that branch (fast-forward only, so local commits stop it). Then it restarts the hub if it's installed and running, and lists what changed. Restart running Claude Code sessions to load the new mod. What each release changed is in [`CHANGELOG.md`](CHANGELOG.md).

### Keybindings

A mod can't define global shortcuts. It borrows existing Claude Code actions, and you bind your chords to them in `~/.claude/keybindings.json`:

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

`ctrl+x s` opens and closes the pane. `/jot` and `//` work without any binding. The full key list is in [`docs/SPEC.md`](docs/SPEC.md) §4.

## Configuration

Set these under the plugin's options (`pluginConfigs.ostrakon.options` in your settings):

| Option | Default | What it does |
|---|---|---|
| `notesDir` | `~/.local/share/ostrakon` | Where notes are stored. The `OSTRAKON_DIR` environment variable overrides it. |
| `pocket` / `pocketMax` | on / 5 | The numbered chips above the prompt, and how many show. |
| `harvest` | off | Review each finished turn for side issues worth keeping. |
| `harvestMode` | `fork` | `fork` reads the whole cached conversation (also sees tool results; cost grows with it). `light` uses a small model on the prompt and final answer only (much cheaper, blinder). |
| `harvestMaxPerTurn` | 3 | Most proposals after one turn. |
| `hubUrl` / `hubToken` | empty | The hub to sync with, and its token. Empty: no hub. |
| `mirrorDir` | empty | A second folder kept in step with the notes: Dropbox, Syncthing, an Obsidian vault subfolder. |

## The hub and the phone app (optional)

The hub is a single Bun file (`server/hub.ts`) with SQLite storage. It listens on `127.0.0.1` only, requires a bearer token, and is meant to be put on your tailnet with `tailscale serve`.

```sh
./install.sh --hub
```

That makes a token in `~/.config/ostrakon-hub/env` (if there isn't one), and installs and starts the systemd user unit (`server/ostrakon-hub.service`). It prints the two steps left to you: `loginctl enable-linger` and `tailscale serve`. Then `ostrakon pair` prints a QR code that pairs a phone (needs `qrencode`); it carries a one-time code, good for 5 minutes, not the token (`--token` prints one that does). To run the hub in the foreground instead: `HUB_TOKEN=$(openssl rand -hex 24) ostrakon hub`. The `ostrakon` command reads `HUB_TOKEN` from the environment or from `~/.config/ostrakon-hub/env`.

The unit runs `~/.local/bin/ostrakon hub`, so it works wherever the repo is checked out. Setup, the phone's Home Screen app, and an iOS Shortcut are in [`docs/phone.md`](docs/phone.md). See [`SECURITY.md`](SECURITY.md) before exposing it.

## Development

- Design and platform notes: [`docs/SPEC.md`](docs/SPEC.md). What might come next: [`ROADMAP.md`](ROADMAP.md).
- `tools/check.sh` runs `claude plugin validate`, the type-check, `claude plugin test` and the hub's tests. The plugin's tests and type-check need the `claude` CLI, because the mods test kit and type declarations ship inside it.
- The hub's tests need only [Bun](https://bun.sh): `cd server && bun test`.
- Contributing, and how releases are cut: [`CONTRIBUTING.md`](CONTRIBUTING.md).
- `tools/` also holds the screenshot pipeline and experiment harnesses; their output goes to `working-docs/`, which is git-ignored.

## License

[MIT](LICENSE)
