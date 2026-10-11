# Changelog

What changed in each release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version (0.x) may break things; the mods interface it builds on is still changing too.

Add to **Unreleased** as you go; `tools/release.sh` turns it into the next version.

## [Unreleased]

## [0.2.0] - 2026-10-11

### Added

- `get.sh`: install with one command, without cloning the repo first (`curl -fsSL https://raw.githubusercontent.com/gaius-codius/ostrakon/main/get.sh | bash`). It clones into `~/.local/share/ostrakon-src` and runs `install.sh`.
- `ostrakon doctor`: checks that the mod loads, your notes folder, the hub and its token, and the tools ostrakon needs, and says what to fix. It changes nothing and never prints the token.
- A load report: each session start records which Claude Code version ran the mod, and what went wrong since, in `~/.cache/ostrakon/report.json`. `ostrakon doctor` shows it, so you can see the mod actually works in your version.

### Changed

- A quieter pane and band. The pane has no rules, a coloured dot per project, indented groups and a one-line footer that leads with the selected note's own actions; the band above the prompt gets an opener chip, cuts labels at word ends and marks the newest note. The capture cue and the "saved" confirmation sit on the prompt's hint line.
- Each project keeps the same colour in the pane and on the phone, from a fixed 8-colour palette readable in dark and light themes.
- The phone app, rebuilt: notes grouped under foldable projects, a `⋯` button on every note, Claude's proposals first with Keep and Dismiss, project chips when capturing, search, and swipe-to-archive that springs back unless you mean it. It works offline with its own fonts, follows the phone's light or dark setting, text size and Reduce Motion, and passes an accessibility audit in every state.
- `docs/DESIGN.md` records what the pane and the phone agree on (colours, symbols, wording, motion), and a check keeps it and the code in step.

### Fixed

- The hub no longer shows its internal error messages to callers. A request that isn't valid JSON now gets `invalid JSON body`, and any other failure gets a plain error, with the details in the hub's log.

## [0.1.0] - 2026-10-11

The first public release.

### Added

- The mod: `/jot` and `//` capture, the triage pane (search, list, edit, move, archive, bundle), the Pocket band of numbered chips above the prompt, and `sent` tracking.
- Harvest (opt-in): one review after each turn proposes side issues worth keeping, in `fork` or `light` mode.
- Notes as Markdown files with YAML front matter, merged with the same rules everywhere.
- Sync through the hub (Bun and SQLite, over Tailscale), through a plain folder (Dropbox, Syncthing, an Obsidian vault), or both.
- The phone app: an installable web page for capture and triage, and an iOS Shortcut.
- `ostrakon pair`: a QR code with a one-time code (5 minutes, works once) pairs a phone with the hub; `--token` prints the long-lived link instead.
- The `ostrakon` command (`pair`, `hub`, `update`, `version`), `install.sh` and `update.sh`.

[Unreleased]: https://github.com/gaius-codius/ostrakon/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/gaius-codius/ostrakon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gaius-codius/ostrakon/releases/tag/v0.1.0
