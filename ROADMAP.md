# Roadmap

What might come next, roughly in order within each section. Nothing here is promised. The design behind what's built is in [`docs/SPEC.md`](docs/SPEC.md); this file is for what isn't. To suggest something, open an issue.

## Planned

- **Git adapter.** The folder adapter plus `git add`, `commit`, `pull --rebase` and `push`, with one lock per machine for the git work, so notes can sync through any git remote (SPEC §7.2).
- **Install from a marketplace.** A `.claude-plugin/marketplace.json` at the repo root, so the mod installs with `/plugin install` instead of a cloned folder (SPEC §11).
- **Notion, one way first.** An export of notes to a Notion database, before any two-way sync. Two-way sync is the only adapter with real upkeep (a separate data model and API), so it waits until an export shows it's wanted (SPEC §7.3).

## Under consideration

### Hub and security

- **Per-device tokens.** Today every device holds the one `HUB_TOKEN`, so a lost phone means rotating it everywhere. Instead, `ostrakon pair` would mint a token for that device only (a small table in the hub's SQLite, stored hashed), with `ostrakon devices` to list them and `ostrakon revoke <device>` to cut one off. The main token would stay on the hub host and in the mod's settings. Worth it once more than one person or several phones use a hub.
- **`ostrakon rotate`.** Replace `HUB_TOKEN` in one step: write a new one, restart the hub, and say what still holds the old one (each machine's `hubToken` option, the phone's Home Screen app).
- **Hub on macOS.** A launchd agent next to the systemd unit, and `install.sh --hub` choosing between them.

### Install and update

- **Keybindings.** `install.sh --keys` to merge the README's bindings into `~/.claude/keybindings.json`, refusing where a chord is already bound to something else.
- **Other plugin folders.** When `CLAUDE_CODE_PLUGIN_DIRS` already lists other folders, the installer prints what to add instead of adding it. It could add it once the variable's separator is documented.

### Development

- **Plugin tests in CI.** The mod's tests and type-check need the `claude` CLI, so CI runs only the hub's tests and shellcheck. They can move to CI once the mods test kit runs there.

## Known limitations

These wait on Claude Code rather than on ostrakon.

- **Long drafts in the capture and edit fields.** The mods interface's text field is one line and cuts the end of a long draft, where you type; ostrakon echoes the whole draft under the field as a stopgap. A real fix needs a field that scrolls to its cursor or wraps.
- **The mods interface is still changing.** Expect breakage across Claude Code versions until it settles.
- **Folder adapter edge cases.** A mirror holding a single note archives it when that file goes, and two machines naming a new note's file differently before the sync client carries either across leave two files for one note (both merge, nothing is lost). See SPEC §7.2.
