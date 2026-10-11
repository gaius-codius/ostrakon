# Changelog

What changed in each release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version (0.x) may break things; the mods interface it builds on is still changing too.

Add to **Unreleased** as you go; `tools/release.sh` turns it into the next version.

## [Unreleased]

### Added

- `get.sh`: install with one command, without cloning the repo first (`curl -fsSL https://raw.githubusercontent.com/gaius-codius/ostrakon/main/get.sh | bash`). It clones into `~/.local/share/ostrakon-src` and runs `install.sh`.

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

[Unreleased]: https://github.com/gaius-codius/ostrakon/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gaius-codius/ostrakon/releases/tag/v0.1.0
