# Changelog

What changed in each release. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version (0.x) may break things; the mods interface it builds on is still changing too.

Add to **Unreleased** as you go; `tools/release.sh` turns it into the next version.

## [Unreleased]

### Added

- `ostrakon jot [--project <name>] <text>` saves a note of yours from outside Claude Code: into this machine's notes, and to the hub at once if the mod has one set. `ostrakon jot --ask` asks for the note in a small desktop prompt; bind it to a key (README, Notes from the desktop).
- The hub's `/api/jot` takes an optional `source`, for senders other than the phone (a Slack bot, a script): the note is yours, with the source as its origin. Without it, nothing changes.
- In the pane, `g` goes to the top of the list, and pressed again to the bottom.
- The key sheet (`i`) ends with what the row symbols mean (`◆ ▪ ● ○ ↗ · ▸`).

### Changed

- In a new note (`ctrl+n`), `ctrl+s` opens a project picker instead of stepping through every project: type part of a name and press Enter. The picked project now lasts until the pane closes; the next time it opens, new notes go to this session's project again.
- With nothing open in this project but some sent or archived notes, the pane shows the project's heading instead of the empty page: `↓` then `h` shows the history.
- The footer's `ctrl+s` says where it goes (`all projects` or `this project`) instead of `scope`.
- The edit card's `[ esc cancel ]` is now `[ esc back ]`: it keeps the draft.
- The move picker (`m`) is a field like the new-note project picker: type part of a project's name and press Enter to move the note there. It used to be a list you stepped through with the arrow keys.

### Fixed

- Two notes put into one prompt before you send it (two chips, `;1` then `;2`, or a chip and `t`) are both marked sent. Before, only the second was.
- After you leave an edit with Esc, the pane opens on the list again, not in the edit card. It opens in the edit card only if it closed while that was showing. `[ esc back ]` now keeps the draft as Esc does: `e` on that note picks it back up.

## [0.7.0] - 2026-10-22

### Added

- `ctrl+x tab` moves the keyboard between the pane and the prompt, and the pane stays open: write in the prompt with your notes beside it, then go back to where you were. A draft the pane was holding goes back into the prompt on the way. To get it, run `./install.sh --keys` from the checkout, or add `"ctrl+x tab": "app:openArtifact"` to the `Chat`, `Pane` and `PaneField` keybindings (README, Keybindings). It takes the place of Claude Code's `ctrl+x tab`, which focuses the band above the prompt; a click still does.
- `ctrl+x i` opens the key sheet from the search field, a new note or the edit card, where `i` is typed instead; closing the sheet goes back to that field. To get it, run `./install.sh --keys` from the checkout, or add `"ctrl+x i": "app:toggleReplTab"` to the `Pane` and `PaneField` keybindings (README, Keybindings).

### Changed

- Esc at the top of the pane (an empty search) hands the keyboard to the prompt and leaves the pane open, instead of closing it. `q`, `ctrl+q` and `ctrl+x s` still close it (`ctrl+x s` from the prompt too).
- The pane's footer shows as many keys as its width takes, not four at most: on a note, `m move` and `y copy` come after the note's own four, then `v pick`, `z fold` and `h history`.
- The band's notes are pulled into the prompt with two keys: type `;` and the note's number (`;2`) in an empty prompt. A lone number no longer does anything, so it answers Claude's numbered questions again. After a turn, `;1` keeps a proposal and `;0` keeps them all. To start a prompt with `;` and a digit, paste it.
- `;2`, or a press on a band chip, leaves an open pane open beside the prompt instead of closing it, so you can keep writing with your notes in view. `t` from the pane still closes it.
- The docked preview is indented so its `▎` bar starts in the same column as the notes' text, instead of at the pane's edge.

### Fixed

- Docked in a short body (8 to 11 rows), the bundle's `[ send ]` button stays on screen: the note list shows fewer notes, then the blank lines go.
- Docked in a short body, the footer stays on the pane's last row: the empty pane, a long search with no match and a new note with its saves no longer push it off.
- The `/jot` hint no longer says Claude won't see the note: Claude does see the command. A `/jot` also stops leaving an empty `ostrakon:` row, and Claude is told the note needs nothing from it, so it doesn't go checking the save.
- The empty pane shows the harvest line when harvest is on.
- The key sheet lists `a` keep and `r` dismiss, and leads with them on a proposed row; its last line is no longer cut off.
- A folded group's footer offers `z unfold`; sent and archived rows show `i keys`.
- The move picker starts on the first project the note can go to, and leaves out the one it's in (it read `move to: none`).
- The move picker and the edit card keep the keyboard when a note arrives, goes or moves in the list while they're open. The picker used to close and lose the destination chosen with the arrow keys, and the card's typing went to the list.
- The preview keeps the age when the path is long, and a long mirror problem leaves the queued count and the keys on the footer.
- With no notes, the band shows the project's whole name.
- The `pocket` setting's description names `;` and the digit.
- Docked, the pane's footer stays on the body's last row, with a short list, no match or no notes, instead of moving up under them. The no-match line is indented like the note rows.
- A folder that gets a git remote is no longer two projects: the notes saved there before the remote move to the remote's project once a session there has synced.

## [0.6.0] - 2026-10-14

### Added

- The install script asks whether to add ostrakon's keybindings to `~/.claude/keybindings.json`, leaving alone any key you've already bound to something else. `--keys` adds them without asking, `--no-keys` skips them.

## [0.5.0] - 2026-10-14

### Changed

- On the phone, the note menu and the project picker open and close faster.
- On the phone, Move to project is now a second page of the note menu instead of a separate picker: tap **Back**, or swipe right, to return to the note's actions.
- On the phone, swipe the note menu down to close it.
- On the phone, tapping a note opens its actions, showing the whole note, instead of editing it. To edit, hold the note and lift your finger, or tap **Edit**. A note is edited in a panel that fills the screen above the keyboard, with Cancel and Save at the top, instead of in the list.
- On the phone, project headings are larger and bolder, in the main text colour, with more space between projects.
- In the pane, a search that matches nothing no longer repeats your text twice below the field: one line says Enter saves it, and a query too long for the field shows once, whole, above that line.
- In the pane, the edit box's buttons name their keys (`esc cancel`, `⏎ save`).

### Fixed

- On the phone, the note menu (⋯ or a long press) and the project picker no longer jump up the screen before settling.
- In the pane, the search field's `⏎ to list` no longer wraps onto a second row, and it's gone when nothing matches, since Enter saves the query then.
- In the pane, Esc clears the search field fully: it used to leave a space behind, which hid the `search notes` placeholder and put what you typed next after it.

## [0.4.0] - 2026-10-12

### Changed

- The pane has one view instead of two: notes are always grouped by project, and typing filters within the groups, hiding projects with no match. Proposed notes show only while the search is empty. `l` and `ctrl+l` (list view) are gone, so you can drop the `ctrl+l` binding; `h` (history) and `z` (fold) work everywhere.

## [0.3.0] - 2026-10-12

### Added

- A logo: a pottery shard. The mark, lockups and icons are in `brand/`, the README opens with it, and the phone app uses it for its icons, its tab and beside its name.
- Install just the mod from Claude Code: `claude plugin marketplace add gaius-codius/ostrakon`, then `claude plugin install ostrakon@ostrakon`. `ostrakon doctor` recognises that install, and warns if the mod is also loaded through `CLAUDE_CODE_PLUGIN_DIRS`; `install.sh` doesn't load it a second time.
- Claude can read and close notes: a `notes` tool lists the notes waiting in this project, another or all of them, with their ids, and an `archive` tool archives one once its work is done (`u` in the pane undoes it).
- Claude's `jot` takes an optional project, so a note about another project lands there.

### Changed

- Claude's `jot` doesn't save a note that's already waiting in the project with the same text; it replies with that note's id. A saved jot's reply gives its id too.
- Harvest doesn't propose a note that's already waiting in the project, or the same note twice from one review.

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

[Unreleased]: https://github.com/gaius-codius/ostrakon/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/gaius-codius/ostrakon/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/gaius-codius/ostrakon/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gaius-codius/ostrakon/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gaius-codius/ostrakon/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gaius-codius/ostrakon/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gaius-codius/ostrakon/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gaius-codius/ostrakon/releases/tag/v0.1.0
