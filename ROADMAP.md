# Roadmap

Ideas for what might come next, roughly in order within each section. Nothing here is promised. What's already built is described in [`docs/SPEC.md`](docs/SPEC.md); this file covers what isn't. To suggest something, open an issue.

## Planned

- **Sync through git.** Like folder sync, but ostrakon also commits, pulls and pushes, so notes can sync through any git remote (GitHub, a server, anything). One lock per machine keeps two sessions from running git at once (SPEC §7.2).
- **Install from a marketplace.** Add a `.claude-plugin/marketplace.json` at the repo root, so the mod installs with `/plugin install` instead of from a cloned folder (SPEC §11).
- **Notion, one way first.** Export notes to a Notion database. Two-way Notion sync would take real upkeep (Notion has its own data model and API), so it waits until people show they want the export (SPEC §7.3).

## Under consideration

### Hub and security

- **A token per device.** Today every device holds the same `HUB_TOKEN`, so losing a phone means replacing the token everywhere. Instead, `ostrakon pair` would make a token just for that device (stored hashed in the hub's database), `ostrakon devices` would list them, and `ostrakon revoke <device>` would cut one off. The main token would stay on the hub's machine and in the mod's settings. Worth doing once more than one person, or several phones, use a hub.
- **`ostrakon rotate`.** Replace `HUB_TOKEN` in one step: write a new one, restart the hub, and list what still holds the old one (each machine's `hubToken` option, the phone's Home Screen app).
- **Hub on macOS.** A launchd agent alongside the systemd unit, with `install.sh --hub` picking the right one.

### Install and update

- **Keybindings.** `install.sh --keys` would add the README's key bindings to `~/.claude/keybindings.json`, skipping any key that's already bound to something else.
- **Other plugin folders.** When `CLAUDE_CODE_PLUGIN_DIRS` already lists other folders, the installer tells you what to add rather than adding it itself. It could do it for you once Claude Code documents how that list is separated.

### Development

- **The mod's tests in CI.** The mod's tests and type-check need the `claude` CLI, so CI runs only the hub's tests, shellcheck and the security scans. They can move to CI once the mods test kit runs there.

## Known limitations

Mostly waiting on Claude Code rather than on ostrakon.

- **Long drafts in the capture and edit fields.** The text field mods get is a single line that doesn't scroll: past its end, the text disappears while the cursor keeps moving, and can drop to an empty second line. As a stopgap, ostrakon shows the whole draft under the field. A real fix needs a field that wraps or scrolls to the cursor, from Claude Code.
- **The mods interface is still changing.** Expect things to break between Claude Code versions until it settles.
- **Folder sync edge cases.** If the mirror folder holds a single note and that file disappears, the note is archived. And if two machines name a new note's file differently before your sync app has copied either one across, you get two files for one note (they merge, and nothing is lost). See SPEC §7.2.
