# Roadmap

Ideas for what might come next, roughly in order within each section. Nothing here is promised. What's already built is described in [`docs/SPEC.md`](docs/SPEC.md); this file covers what isn't. To suggest something, open an issue.

## Planned

- **Sync through git.** Like folder sync, but ostrakon also commits, pulls and pushes, so notes can sync through any git remote (GitHub, a server, anything). One lock per machine keeps two sessions from running git at once (SPEC §7.2).
- **Notion, one way first.** Export notes to a Notion database. Two-way Notion sync would take real upkeep (Notion has its own data model and API), so it waits until people show they want the export (SPEC §7.3).

## Under consideration

### Hub and security

- **A token per device.** Today every device holds the same `HUB_TOKEN`, so losing a phone means replacing the token everywhere. Instead, `ostrakon pair` would make a token just for that device (stored hashed in the hub's database), `ostrakon devices` would list them, and `ostrakon revoke <device>` would cut one off. The main token would stay on the hub's machine and in the mod's settings. Worth doing once more than one person, or several phones, use a hub.
- **`ostrakon rotate`.** Replace `HUB_TOKEN` in one step: write a new one, restart the hub, and list what still holds the old one (each machine's `hubToken` option, the phone's Home Screen app).
- **Hub on macOS.** A launchd agent alongside the systemd unit, with `install.sh --hub` picking the right one.

### Install and update

- **Other plugin folders.** When `CLAUDE_CODE_PLUGIN_DIRS` already lists other folders, the installer tells you what to add rather than adding it itself. It could do it for you once Claude Code documents how that list is separated.

### Development

- **The whole type-check in CI.** CI runs the mod's tests, but it type-checks only the hub and the mod's files that don't use the engine's types: Claude Code writes those types only when a logged-in session loads the mod. That part can move to CI once they can be written without a login.

## Known limitations

Mostly waiting on Claude Code rather than on ostrakon.

- **Rules instead of a frame around capture and edit.** Claude Code's multi-line text field draws right only across the pane's whole width: in a frame, beside a label or indented, it collapses to one cut line. So capture and the edit card sit between rules (SPEC §2.3). They can go back in a frame once the field works inside one.
- **Long search queries.** The search and picker fields are still one line that doesn't scroll. A search with no match shows the whole query under the field.
- **The mods interface is still changing.** Expect things to break between Claude Code versions until it settles.
- **Folder sync edge cases.** If the mirror folder holds a single note and that file disappears, the note is archived. And if two machines name a new note's file differently before your sync app has copied either one across, you get two files for one note (they merge, and nothing is lost). See SPEC §7.2.
