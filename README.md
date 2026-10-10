# ostrakon

An ostrakon for Claude Code: capture thoughts and follow-ups mid-work, triage them across projects and machines, and turn them into prompts.

Ostrakon is a Claude Code **mod** (a plugin of function hooks that draws a pane and a band inside the terminal UI), plus an optional small hub that syncs notes between machines and serves a phone capture form.

> **Status:** experimental. It builds on Claude Code's mods interface, which is still changing, so expect rough edges and breakage across Claude Code versions.

## What it does

- **Capture** a note in under two seconds, even while Claude is working, without losing your prompt draft: `/jot text`, or `//` typed into an empty prompt.
- **Triage** open notes for this project or across all of them in a searchable pane: edit, move, archive, bundle several into one prompt.
- **Dispatch** a note into the prompt. A row of numbered chips above the prompt (the "pocket") shows this project's open notes; press its digit in an empty prompt to pull one in. A note is marked sent once the prompt carrying it goes in.
- **Harvest** (opt-in): after each turn, one review asks the model for side issues worth keeping and shows them above the prompt for you to keep or dismiss. Claude's own work is unchanged.
- **Sync** notes between machines through a small hub (Bun + SQLite, reached over Tailscale), through a plain folder (Dropbox, Syncthing, an Obsidian vault), or both. Capture from your phone with the hub's installable web page.

Notes are plain Markdown files with YAML front matter, one per note, in `~/.local/share/ostrakon/` by default, so they are yours to read, grep and back up.

## Install

You need Claude Code with mods support (see the [mods docs](https://code.claude.com/docs/en/plugins/mods/overview)).

Clone this repo and load the `plugin/` directory:

```sh
git clone https://github.com/gaius-codius/ostrakon.git
claude --plugin-dir ostrakon/plugin
```

To load it in every session, set `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/ostrakon/plugin" } }
```

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

## The hub and the phone form (optional)

The hub is a single Bun file (`server/hub.ts`) with SQLite storage. It listens on `127.0.0.1` only, requires a bearer token, and is meant to be put on your tailnet with `tailscale serve`.

```sh
HUB_TOKEN=$(openssl rand -hex 24) bun server/hub.ts
```

`bun server/hub.ts pair` prints a QR code that pairs a phone (needs `qrencode`).

A systemd user unit is in `server/ostrakon-hub.service`. Setup, the phone's Home Screen app, and an iOS Shortcut are in [`docs/phone.md`](docs/phone.md). See [`SECURITY.md`](SECURITY.md) before exposing it.

## Development

- Design and platform notes: [`docs/SPEC.md`](docs/SPEC.md).
- `tools/check.sh` runs `claude plugin validate`, the type-check, `claude plugin test` and the hub's tests. The plugin's tests and type-check need the `claude` CLI, because the mods test kit and type declarations ship inside it.
- The hub's tests need only [Bun](https://bun.sh): `cd server && bun test`.
- `tools/` also holds the screenshot pipeline and experiment harnesses; their output goes to `working-docs/`, which is git-ignored.

## License

[MIT](LICENSE)
