# Ostrakon: design

Status: in development · Last revised 2026-10-11

How ostrakon works: what it does, the data model, sync, and the platform facts it depends on. Code comments cite sections of this file as `SPEC §n`.

| Path | What it is |
|---|---|
| `plugin/` | The mod (Claude Code plugin): store, merge, sync adapters, pane and band UI |
| `server/` | The hub (Bun + SQLite) and the phone form (PWA); setup in `docs/phone.md` |
| `bin/ostrakon`, `install.sh`, `update.sh` | The command line (`pair`, `hub`, `update`, `version`) and the install and update scripts |
| `tools/` | Development tooling: screenshot pipeline, mockups, QA and experiment harnesses (their output goes to the gitignored `working-docs/`) |

---

## 1. Product

An ostrakon inside Claude Code for the thoughts, follow-ups and ideas that come up while working with Claude, so they get written down instead of derailing the current task or being forgotten.

Three jobs, in priority order:

1. **Capture**: get a thought down in under 2 s, even mid-turn, without losing your place or your prompt draft.
2. **Triage**: see what's pending in this project and across every project and machine; find, edit, tidy and decide.
3. **Dispatch**: turn one note, or a hand-picked set, into a prompt. Never lose a note if dispatch fails.

Goals: keyboard-first, calm when idle, quick.

### Shape
- **Pane = Launcher**: search-first, fzf-style, with multi-pick and bundle.
- **List view** inside the pane: a grouped browse view reached by a hotkey. No tab bar.
- **Resting state = Pocket**: numbered note chips above the prompt. A digit in an empty prompt pulls that note in (§10).
- **Harvest** (opt-in): after a turn, side issues worth keeping are proposed above the prompt, with **no change to how Claude works** (§8).
- **Sync**: pluggable adapters. A Tailscale hub with a phone capture form, and a folder adapter for Dropbox, Syncthing and Obsidian (§7).

### Non-goals
A full task manager (due dates, priorities, assignees). A board view. Sharing notes with other people. Pointer drag-and-drop.

---

## 2. Platform facts

What the mods interface does that shaped the design. Marked *unverified* where untested.

### 2.1 Loading, checks and tests
- A mod is a plugin folder: `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{"modules":["./register.tsx"]}`), the hooks module, and `types/index.d.ts` (required when using `$.state`; named by `"types"` in `plugin.json`).
- Load it with `claude --plugin-dir <dir>` or `CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`. Interactive sessions watch the folder and hot-reload on save.
- The engine writes types to `<mod>/.claude-plugin/types/` on load. Type-check with `npx -y -p typescript@5.6.3 tsc -p <mod>`.
- `claude plugin validate <dir>` checks statically; `claude plugin test <dir>` runs `*.test.ts`. Validation requires:
  - helpers that take `$` are **top-level** functions or consts, not closures inside `register`;
  - `$.state` keys are literals declared in the contract;
  - `$.env.get` names are literals.
- Runtime errors show as dim transcript lines. `claude --debug-file <path>` logs every refusal (`ui.open … asked|unasked`, `ui.focus … moved|denied`).
- A rejected `$` promise that nothing catches fails tests, so `.catch` fire-and-forget calls (especially `$.ui.focus`).
- Test kit (`claude-code/testing`): mock every noun you touch (`mock.clock`, `mock.env`, `mock.store`); op events answer `{ value }`; `session.start` needs a bottom (`on('session.start', ($, e) => ({ cwd: e.cwd }))`); `$.fs` has no implementation, so tests use an in-memory one (`plugin/tests/memdir.ts`); `$.clock.sleep` blocks until `clock.advance(ms)`.

### 2.2 Focus, keys and opening
- **When a pane appears:** one opened in direct response to the person's input (a command, a button press) is placed at any width. One the mod opens "on its own" (a timer, a delayed call) only appears from **144 columns** (110 once the person has opened it). So open inside the triggering handler and check `isPlaced`.
- **When focus is granted:** `focus: true` is honoured only while the prompt is empty and nothing else holds the keys. A band Button press holds the keys, so `onPress` must return the open's promise for the pane to count as asked.
- **Inputs swallow keys:** while an Input has focus every printable key goes to it, so letter hotkeys only work when a Button has focus. The UI therefore always shows which mode you're in and which keys work now.
- **Hotkeys:** a Button `hotkey` is a single lowercase letter or digit and only works while the pane or band holds focus. Tab/Shift+Tab and Up/Down move between controls natively.
- **Esc:** with `closeOnEscape: true`, Esc raises `ui.close` with origin `person`, the same as the close mark, `ctrl+x x` and the engine's `pane:close`. A `ui.close` hook may refuse it (answer without `next`); the keys still go to the prompt, so take them back with `$.ui.open({ id, focus: true })` a moment later. This is how Esc means "back".
- **Ctrl chords:** mods can't define global shortcuts. A Button's `action` prop names an *existing* keybinding action, and the person's chord for it presses the button while it's mounted. Ostrakon borrows actions with no default key (table in §4.5). Contexts: `Pane` (a pane control has focus), `PaneField` (a pane Input or Select has focus), `Chat` (the main prompt).
- A bare `ctrl+x` can't be bound (it prefixes every engine chord), and `ctrl+x x` only closes a pane that holds the keyboard.

### 2.3 Drawing
- **Elements** come from `$.ui.resolve(e)`: Box, Text, Button, Input, Select, Link, Code, Markdown and Client; Raster and Image are terminal-only; mobile has no Input or Select.
- **Button** `plain` draws `k: label` with the hotkey in the accent colour; without `plain` the terminal shows `[ label ]` and no hotkey. A digit hotkey on a band Button also fires when the person types that digit alone into an empty prompt and pauses; that is what makes Pocket possible.
- **The band is shared:** compose other mods' bands with `await next(e)` inside your Box.
- **`$.ui.status`** gets an orange `⚠ <plugin>:` prefix, so it reads like a warning. Avoid it for calm counts.
- **Placement:** docked beside the transcript (`placement: 'dock'`, fullscreen and wide) or inline above the prompt. Size to `e.props.bodyColumns` and `scroll.bodyRows`.
- **Redraws:** `$.state` (`atom`, `read`, `update`) redraws its readers; `ui.render` hooks may read state but never write it. Redraws are capped at about 10 per second.
- **First paint lags `ui.open`** by up to about 1 s on a cold module (matters for screenshots).

### 2.4 Prompts
- `$.prompt.fill({ text, mode })` sets the draft; `$.prompt.read()` returns `{ text, cursor }`.
- `$.prompt.submit({ text })` is framed for Claude as the plugin's message; `asUser: true` sends it as the person's words. Either way, **`@file` mentions and pasted images are not expanded** for a mod's prompt. A dispatch that must behave exactly like typing goes through `fill` and the person pressing Enter.
- A `prompt.submit` hook returning `{ drop: '…' }` prints "Prompt dropped by a hook" in warning colour. A plugin's own submit has `e.origin.kind === 'plugin'`; the person's has `'composer'`.

### 2.5 State and storage
- **`$.state` resets** on `/clear`, `/resume` and `/branch`, and `session.start` does not refire. Reload on `session.start` and after `session.end` with reasons `clear` and `resume`; a poll also restores lost state. `classic.SessionStart` is not reliable (an organization's policy plugin can bypass user plugins' classic hooks).
- **`$.store`** is per config dir. Fine for preferences, not for notes.
- **`$.fs.write` is not atomic:** a reader can see a half-written file. Rule: **a file that fails to parse aborts the operation; never write a default over it.** For atomic replacement, write a temp file and `$.process.run(['mv', tmp, final])`.
- Writing inside the plugin folder triggers hot reloads, so keep data outside it.
- There are no file-change events, so poll `$.fs.stat` mtimes.
- `$.session.root()` is the project root; `$.session.repo()` returns `{ root, remote }`, and the remote is the project key that is the same on every machine.
- `$.env.get('NAME')` takes literal names; `OSTRAKON_DIR` points a session at fixture data.

---

## 3. Information architecture

### 3.1 Note lifecycle
```
            capture (you / phone / harvest-accepted)
                 │
 harvest ──▶ proposed ──keep──▶ open ──dispatch ok──▶ sent ──(kept as history)
                 │               │
              dismiss         archive (d) ──▶ archived
                 ▼               ▲ undo (u)
             dismissed           └─────────────┘
```
- `open` is the inbox. `sent` and `archived` are history; you can browse and restore them. `dismissed` covers rejected harvest proposals.
- Nothing is hard-deleted from the UI. A purge sets a tombstone (§6) after 60 days in history.

### 3.2 Scopes
- **This project**: notes whose `projectKey` matches the session's.
- **All**: every note on every machine.
- **Unfiled**: notes with no project (phone captures by default). They show in All with an `unfiled` chip and can be assigned a project (`m`).

---

## 4. The pane: Launcher

`plugin/src/ui/look.ts` holds every visual constant (glyphs, theme keys, widths, rules, footer and toast wording, the chord table), so a change of look is a one-file edit. The mockup mod (`tools/mockups`, `/mock mix <view>`) draws every state. This text is the reference for keys, wording and behaviour; the renders are the reference for spacing and colour.

### 4.1 Visual language
- Colour comes only from theme keys, never hex, so both themes work.
- The accent (`claude`) marks the current project, row numbers, picks, `◆` and search hits (bold, no underline). The selected row has a `subtle` background and a focus block in column 0. Metadata (age, preview meta, footer labels) is dim. Other projects get a deterministic colour from a hash of their key, drawn on a `●` before their dim name, never on the name; `unfiled` is a grey `○`. `warning` and `error` are kept for real problems.
- No rules: one blank row separates the search row, the rows, the preview and the footer. Docked, capture is the one framed element (a `round` accent box).
- Glyphs: `❯` search, `✎` capture, `⇢` bundle, `◆` from Claude, `▪` from the phone, `●`/`○` picked or not (and project dots), `↗` sent, `·` archived, `▸` group folded, `▎` quoted text, `↑`/`↓` more rows, `⚠` storage problem, `✓` saved, `⏎` Enter.
- Draw to `bodyColumns - 1`: a tree exactly `bodyColumns` wide overflowed by a column.
- Project labels are the repo basename; two projects with one basename get parent segments until they differ.

### 4.2 Search view
Focus starts in the search field; no row is selected and the top result is previewed.
```
❯ cache▏ ⏎ to list                                  all · 3 of 12   ← search row
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 1   check why the cache test is flaky on CI. started…      cc  12m   ← rows
 2   add a cache invalidation metric to the hub dash…    infra   1h
 3   document the cache-key format in the api readme        api   2d
──────────────────────────────────────────────────────────────────────
check why the cache test is flaky on CI. started after the redis     ← preview
bump, only on the arm runners
you · ~/Work/cc · main · 12m ago                                      ← meta
──────────────────────────────────────────────────────────────────────
ctrl+l list view  ctrl+s scope  ctrl+n new  ctrl+q close             ← footer
```
- **Rows** are one line: selection bar, the row's number in the window (1–9, then `·`), a marker (`◆`, `▪`, `●`/`○`, `↗`), the text with search hits highlighted, then the project (`● name`) and age (`now`, `12m`, `3h`, `2d`, `5w`, `1y`).
- **Preview** (docked only): the selected note's text, capped at 6 lines, then a meta line `who · path · branch · age ago`, all behind a dim `▎` bar.
- **Ordering:** search results by rank, everything else newest `updated` first, ties by id. Ranking is a fuzzy subsequence score with bonuses for word starts, the current project and recency. Query tokens: `@infra`, `is:sent`, `is:archived`, `by:claude`.
- **Scope** is explicit state, shown at the right of the search row. The pane opens on this project; the first typed character switches to all, and clearing the query switches back, unless the person chose a scope with `ctrl+s`. Choosing all is remembered across sessions (`$.store`).
- **No match:** `No notes match “kubernetes” in cc.` and, dim, `⏎ saves “kubernetes” as a new note in cc`. Enter saves the query as a note.

### 4.3 List view
Reached with `l` on a row or `ctrl+l`; it keeps the query and scope.
- **Groups** have a header at the left edge: the project's dot and its label, dim, with the group's open count dim on the right and `▸` when folded. `proposed` (with `◆`) and the current project are bold accent. The notes under a header are indented two columns, so note text is the brightest thing in the list. Order: `proposed` first when harvest has any, then the current project, then others by latest activity, then `unfiled`. Within a group: open notes newest first, then history when shown.
- **Headers are focusable;** `z` folds or unfolds a group.
- **History:** `h` adds `sent` and `archived` notes (dimmed); `u` on one restores it.
- **Picking:** `v` picks or unpicks an open or proposed note. Once one is picked every row shows `●`/`○` and the footer leads with `3 picked`. Picks live in `$.state` until sent, cleared (`x`) or the session ends; a picked note that stops being open drops out with a toast. Bundles keep pick order.
- Search and list are one model with two renderers: a query filters the list too.

### 4.4 Capture, `//` and the draft stash
- **In the pane:** `n` on a row or `ctrl+n` turns the search row into the capture row (`✎ new note`, the text, the target project at the right). Enter saves and stays in capture; Enter on an empty line returns to search; `ctrl+s` cycles the target project. The draft shows whole underneath, wrapped. A failed save keeps the text and shows `Couldn't save: <reason>`.
- **From the prompt:** a prompt that becomes exactly `//` is rewritten to `/jot ` (cursor at the end). `/jot` runs at once even mid-turn. `/jot` is painted in the accent and bold, the note after it italic. `/jot text` saves to this project; `/jot` alone opens the pane on search, where Enter on a query that matches nothing saves it as a note and `ctrl+n` turns to capture. To send a literal `//` prompt, start with a space or paste it: only one typed `/` after a lone `/` triggers the rewrite.
- **Hint line:** the dim line under the prompt gets a tail after ` · `. While the draft leads with `/jot `: `✎ ⏎ saves to cc, Claude won't see it`. For 3 s after a save from the prompt (or a search with no match, saved from the pane): `✓ saved to cc`, in place of a toast. A failed save still says `Couldn't save: <reason>`.
- **Draft stash.** Every open that asks for focus (`ctrl+x s`, `/jot`) first reads the prompt. If it holds a draft, the draft is kept in `$.state` as the *stash*, the prompt is emptied, and the pane opens focused. Exactly one exit then decides what the prompt holds, and clears the stash:

| Exit | Prompt afterwards |
|---|---|
| `t`, or `t` in the bundle | the non-empty parts of: stash, whatever was typed into the prompt meanwhile, the note text, joined by blank lines; the pane closes |
| `s`, or ⏎ in the bundle | the note is submitted; on close the stash goes back. A failed or dropped submit leaves the note `open`, toasts `Not sent: <reason>`, and keeps the pane and stash |
| close (`q`, `ctrl+q`, `ctrl+x s`, Esc at the top) | the stash goes back |
| open refused or not placed | the stash goes straight back |

  The `ui.close` hook restores the stash only if the prompt is still empty; otherwise it appends it after a blank line, so nothing is overwritten.
- The capture draft and the edit draft live in `$.state` and are restored when the pane reopens.

### 4.5 Keys and actions
Letter and digit keys work only while a row, header or Button has focus (an Input takes every printable key). `ctrl+` chords work anywhere in the pane.

| Key | Action |
|---|---|
| ↑ ↓ / Tab / `j` `k` | move; selection follows focus |
| `1`–`9` | jump to that row in the window |
| ⏎ | in search: focus the first result. On a row: same as `t` |
| `v` | pick or unpick |
| `x` | clear the picks (in the bundle: back to the list) |
| `t` | **to prompt**: fill the prompt (stash rules above) and close the pane. A note from another project is prefixed `[label] `. It becomes `sent` only when a submit containing that text is seen (§5) |
| `s` | **send** as the person (`asUser: true`), with the same prefix. If the text contains `@` mentions it behaves as `t` instead and says so. It becomes `sent` only after the submit resolves without a drop |
| `b` | bundle preview of the picked notes (§4.7) |
| `e` | edit inline (§4.7) |
| `d` | archive (`u` undoes) |
| `u` | on a history row: restore to open. Otherwise undo this session's last mutation (archive, edit, restore, pick-clear, move). A send can't be undone |
| `m` | move to a project (or `unfiled`) |
| `y` | copy the full text |
| `l` / `ctrl+l` | list view on/off |
| `h` | history on/off (list view) |
| `z` | fold or unfold the group (list view) |
| `f` / `ctrl+f` | focus search |
| `n` / `ctrl+n` | new note |
| `ctrl+s` | scope (search, list) or target project (capture) |
| `i` | key sheet on/off |
| Esc | **back** one step: edit → the row (draft kept), move / key sheet / bundle → the list, capture → search, a row → the search field, a query → empty, list view → search view; at the top it closes |
| `q` / `ctrl+q` / `ctrl+x s` | close the pane from anywhere; drafts are kept |

**Borrowed chords** (the person binds them in their keybindings; the table lives in `look.ts`):
- `ctrl+x s` → `app:cycleDiffBase`
- `ctrl+f` → `app:toggleDiffNoiseFilter`
- `ctrl+s` → `app:toggleDiffPreSession`
- `ctrl+q` → `pane:previous` (not the engine's `pane:close`, which the mod reads as Esc)
- `ctrl+l` → `app:toggleReplTab`
- `ctrl+n` → `pane:next`

### 4.6 Contextual footer
One blank row, then one line: at most four key/label pairs for the focus (key bold, label dim, two spaces between) and `i keys` on the right; pairs drop from the right until the line fits. A status leads in bold: `3 picked`, `2 unreadable files` (error), `hub offline · 3 queued` (warning). The legend `◆ from Claude` trails while a `◆` row is drawn. **The footer never advertises a key that doesn't work in the current focus**, so it changes with the focus (search field, search row, list row, picks held, history, proposed, group header, capture, edit, bundle, empty inbox). A pane that isn't holding the keyboard shows only `ctrl+x tab focus  ctrl+x s close`.

**Storage problems** also draw a focusable problem row above the first result, in `error` (`⚠ 2 unreadable files · ⏎ details`); ⏎ opens a card listing each file and reason.

### 4.7 Other states
- **Bundle:** `⇢ bundle  3 notes into one prompt`, then the exact prompt in a quote box: `Please look at these notes from my ostrakon:`, a blank line, one `- ` line per note in pick order (other projects prefixed `[label] `). Focus goes to a `[ send ]` button; ⏎ sends and `t` fills the prompt instead. Picked notes are marked sent only once the prompt goes in.
- **Edit:** the row becomes a `round` box with a one-line Input prefilled with the text. Newlines show as `↵` and turn back into newlines on save (a note that already contains `↵` can't round-trip, so `e` points you to the file). `[ cancel ]` and `[ save ]` sit below; the draft is kept if the pane closes.
- **Empty inbox:** `Nothing pending in cc.` (scope all: `Nothing pending in any project.`) and the ways in (`//`, `ctrl+n` new note, and the phone and harvest lines when those are configured) in a fixed key column. Docked, a small dim shard sits beside them.
- **Toasts** are short and calm (`Archived · u undo`, `Copied`, `note 2 in your prompt · ⏎ to send`). Never `$.ui.status`.

### 4.8 Paging and the inline pane
**The mod pages the rows, never the engine.** It draws only the rows that fit in `scroll.bodyRows` minus the chrome, so content always fits. (Arrows walk controls only while content fits, so this is what makes selection-follows-focus work.)
- Numbers 1–9 count from the top of the window.
- **Edge sentinels:** when rows exist below the window a dim `↓ 4 more` button sits under the last row; above, `↑ 2 more`. Focus arriving on one shifts the window by a row and moves focus to the new edge row; `j`/`k` page directly.
- **Zero results:** no rows and no sentinels; focus stays in the search field.
- **When the selected row disappears** (filtered, archived, synced away), selection moves to the row now at the same index, or the last row.

**Inline layout.** Switch on `e.props.placement === 'inline'`, not on a column count. The inline body is about 11 rows and keeps the search row, the rows and a one-line footer; it drops the preview. The scope and counts stay at the right of the search row in every focus; with a row selected, its meta leads them (`◆ claude` or `phone` when not yours, then path, branch, age), dropping the path, then the age, then the branch when the room runs short. Footer pairs drop from the right until the line fits.

### 4.9 Construction
- The search field is an `Input` with no `label` (the terminal would draw `label: `); the glyph is a `Text` before it.
- A row is a keyed `Box` whose focus target is a one-space `plain` Button in column 0; focus inverts it into the selection bar. Rows are keyed by *slot in the window*, not by note, so paging doesn't move the ring.
- Keys with no visible control (letter actions, digits, borrowed chords) are Buttons in an **action layer**, a `display: 'none'` Box drawn last. A `ui.focus` hook redirects any move onto it. While a row, the bundle or the key sheet holds the ring, the layer also answers every other letter and digit by doing nothing, because an unanswered printable key would go to the prompt and take the keyboard with it.
- Docked, the preview and footer have fixed heights, so the window never changes size as the selection moves.
- Each open draws exactly one `autoFocus` element. Every in-pane view change calls `$.ui.focus` on its target (search → first result, list toggle → selected row, capture, edit, bundle → `[ send ]`, back out → the row it came from, fold → the header).

---

## 5. Dispatch semantics
- **Detecting a sent note:** in `prompt.submit` (origin `composer`), if the text contains the exact text the mod last filled for a note or bundle, those notes are marked `sent`, with `sentAt` and `context.sentSessionId`. A prompt submitted while idle is marked at once; one submitted mid-turn only waits in the queue (the person can take it back) and is marked when it is delivered.
- **Failure-safe:** a note is never removed or altered before the submit is known to have entered. `sent` notes stay in history and can be restored.
- **Cross-project dispatch:** when a note's project differs from the session's it is prefixed `[label] ` in `t`, `s`, Pocket fills and bundle lines.

---

## 6. Data model and storage

### 6.1 One file per note
Directory: `~/.local/share/ostrakon/` by default (override with `OSTRAKON_DIR` or the `notesDir` option).
```
~/.local/share/ostrakon/
  notes/<id>.md          ← one note per file
  index.json             ← optional cache, always rebuildable
  sync/<adapter>.json    ← per-adapter cursor and state
```
One file per note means concurrent captures from different sessions never collide, files map 1:1 to Obsidian notes or a folder in Dropbox, and each file is small enough that a partial read is rare and cheap to retry.

### 6.2 File format (Markdown with YAML front matter)
```markdown
---
id: 01JA7K2M3Q9X4ZB6C8D0EFGHJK      # ULID: time-sortable, unique across machines
status: open                         # open | proposed | sent | archived | dismissed
by: you                              # you | claude | phone
created: 2026-10-09T14:02:11.000Z
updated: 2026-10-09T14:02:11.000Z    # last-writer-wins clock (see 6.3)
origin: laptop                       # hostname that made the last change
project: cc                          # the project's name, or null for none
projectKey: github.com/example/cc    # normalized git remote; falls back to "path:/home/user/work/cc"
projectPath: /home/user/work/cc      # display only; differs per machine
sessionId: 0463fee3-…                # context, all optional
branch: main
turnId: …
harvestOf: "fix auth tests"          # turn summary for harvested notes
sentSessionId: 32896f8f-…            # where a sent note went (§5)
sentAt: null
deleted: false                       # tombstone, only set by purge
---
check why the cache test is flaky on CI. started after the redis bump, only on the arm runners
```
- **Flat keys:** the project and context are written as flat keys because Obsidian's Properties shows nested blocks as raw JSON. Older nested `project:`/`context:` blocks are still read.
- **Parsing:** a strict, small YAML subset with its own parser and serializer (no dependency). An unparseable file is **skipped and reported**, never overwritten. Keys this mod doesn't own are kept verbatim.
- **Writes:** to a temp file of the write's own, then `mv` (atomic). Read back after the rename; if another writer replaced the file meanwhile, re-read it on the next poll.
- **Changing a note** takes a per-note lock, reads every copy of that id fresh, merges them, applies the change and writes `<id>.md`.
- **Locks** coordinate the sessions on one machine only; machines reconcile through copies and the merge, never through locks on a synced folder. They live in `~/.cache/ostrakon/locks/<id>/` (`mkdir` plus an `owner` file with a random token, the owning process id and its start time).
  - A lock is taken over **only when that exact process is confirmed gone**; a failed lookup never counts as gone. A live owner keeps its lock however long it stalls, and waiters give up after about 3 s.
  - Recovery runs under a guard so one session recovers each abandoned lock. An ownerless lock (a crash between `mkdir` and the owner write) is cleared after 60 s.
  - Note ids are restricted to `[0-9A-Za-z_-]` because they name files and locks.

### 6.3 Merge rules (local, and every sync adapter)
- Notes are matched by `id`.
- **Winner** (`plugin/src/merge.ts`, shared by the mod, the hub and every adapter): the later `updated` wins. On a tie, the more final status wins: `deleted` > `archived` > `sent` > `dismissed` > `open` > `proposed`. Then the higher `origin`, then the whole serialized file, so the order is total and every machine picks the same winner.
- **Clock:** `updated = max(now, previous.updated + 1ms)` on every local change, a hybrid-logical-clock-style step against skew.
- **Purge:** tombstones are removed 60 days after `updated`.

### 6.4 Live updates between sessions
- Poll the `notes/` listing every 2 s, comparing names, sizes and mtimes, and re-read only what changed. Recently modified files are re-read on the next poll too (coarse mtimes), and every file once a minute.
- **Edits in place by other tools** (Obsidian, an editor): a known file whose content changed while its `updated` didn't is a change made at its mtime; the store writes the bumped stamp back so every machine agrees. A new file (a copy, a sync conflict copy) keeps its own stamp, so a stale copy can't win by mtime.
- Reload everything on `session.start` and after `session.end` with reasons `clear` and `resume`.

---

## 7. Sync

### 7.1 Adapter interface (in the mod)
```ts
type SyncAdapter = {
  name: string
  // Changes after `cursor` (null: everything), waiting up to `waitS` for one (the long poll).
  pull(cursor: string | null, waitS: number): Promise<{ notes: Note[]; cursor: string }>
  // Resolves the other side's copy of each note after its merge.
  push(changed: Note[]): Promise<Note[]>
}
```
- **The core** (`plugin/src/sync/core.ts`) owns everything else: merge (§6.3), the change queue, backoff and status (shown in the pane footer, not the status line).
- **What the other side holds:** a fingerprint per note id, cached per machine (`~/.cache/ostrakon/`). A local note whose fingerprint matches is never sent. Each session's first pull is a full one, so a note missing locally comes back.
- **Push timing:** after every local change, with a 1 s debounce. Pull is a long poll.
- **Offline first:** the local directory is always the truth for the UI; adapters only reconcile.

### 7.2 Adapters
- **Hub adapter:** HTTP to the Tailscale service (§9).
- **Folder adapter** (`plugin/src/sync/folder.ts`, option `mirrorDir`): mirrors notes to another directory and merges back. One adapter covers **Dropbox**, **Obsidian** (point it at a vault subfolder; Obsidian then edits the very same files), **Syncthing** and any synced drive. It can run alongside the hub, each with its own sync core.
  - **The mirror is a store of its own** (`plugin/src/mirror.ts`): the plain store plus what only the mirror needs. Writes are whole files renamed into place, with per-note locks between this machine's sessions; conflict copies merge by id; edits made in place count as changes at their mtime.
  - **File names:** a note's first file in the mirror is named after its first line (`Buy milk.md`, then `Buy milk 2.md`), placed with a hard link so it never replaces a file (falling back to `mv -n` where there are none). The name stays when the text changes, and a note renamed in Obsidian lives on under its new name. The notes folder keeps `<id>.md`.
  - **Archive:** archived notes live in the mirror's `Archive/` folder, so deleting a note in Obsidian archives it. A file that disappears with no copy in `Archive/` to explain it archives the note once it has stayed gone 6 s (a sync client may deliver a rename as a delete plus a create). If more than 5 notes vanish at once and more than are left, or the folder loses every note it held, that looks like a sync client's trouble and they are put back instead.
  - **Conflict copies** (Dropbox's "conflicted copy", Syncthing's `.sync-conflict-`) are folded into the note's file and removed, using the same safe move-aside.
  - **The folder is made only the first time, and only when its parent exists.** A missing parent (a drive not mounted, Dropbox not installed) shows in the footer as `mirror folder missing: <path> · N queued`; so does a folder this machine has used before, so it is never re-created empty and refilled. A mirror set to the notes folder itself is refused.
  - **Remembered between sessions:** each store keeps the folder's resolved path and an id, `updated` and fingerprint per file in `~/.cache/ostrakon/seen-<tag>.json`, so an edit made while no session ran is still told apart from the revision it changed.
  - **Safety:** a note whose mirror file won't parse is never written over; files that aren't notes are left alone; a mirror that moves back to an older revision gets the newer one pushed again.
  - **Known gaps:** a mirror holding just one note archives it when that file goes (the same as deleting your only note), and two machines writing a note's first file under different titles before the sync client carries either across leave two files for one note (both merge by id, nothing is lost).
- **Git adapter** (not built): the folder adapter plus `git add/commit/pull --rebase/push` through `$.process.run`.

### 7.3 Notion
Not built; the only adapter with real ongoing maintenance (a separate data model and API). Two routes: the Notion API through `$.http.fetch` with a token in a `sensitive` option, or the claude.ai Notion connector through `$.mcp.call` (declared in the API but *unverified* at runtime). Last writer wins on Notion's `last_edited_time` mapped into `updated`. A one-way export is the cheap first step.

---

## 8. Harvest (opt-in)

**Rule:** harvest must not change how Claude works. If Claude would have pursued or fixed something, it still does. The ostrakon is a *place to put* ideas, follow-ups and observations that would otherwise be mentioned in passing or never said.

- **Options:** `harvest` (boolean, default `false`), `harvestMaxPerTurn` (default 3, 1 to 9) and `harvestMode`, `fork` (default) or `light`.
- **The `jot` tool** (`mcp__ostrakon__jot`) is registered always and is the same with harvest on or off: it is what "jot that down" calls. A jot is an `open` note of Claude's (`by: claude`) in this project, with a toast `◆ Claude jotted: …`.
- **Mechanism:** when a main turn ends (`turn.complete`, an answer, not interrupted, at least 5 s), the mod asks one tool-less question over the session's own transcript (`$.model.fork`, served from the prompt cache): the turn's final reply, the notes Claude already jotted in it, and a request for up to `harvestMaxPerTurn` side issues worth keeping, as a JSON array of strings in a fenced block (`[]` for none). The array becomes `proposed` notes (`by: claude`) in this project. Claude's own requests are identical with harvest on and off.
  - **Why a review rather than prompt text:** the engine's security default skips a user-tier plugin's `prompt.compose` and `prompt.context` hooks (only a tool's description reaches the model), and in live turns no wording in the tool's description got Claude to jot on its own.
  - **Cost:** one fork per reviewed turn, mostly cache reads (about 45k cached, 0.5k new input, 0.1k output tokens, 2 s, after the turn).
  - **`light` mode** replaces the fork with one `$.model.complete` on a small model, shown only the turn's prompt, its final reply (cut in the middle beyond a limit) and the notes already jotted, and told it can't see files or tool output. It costs about a sixtieth as much but finds fewer proposals and none that depend on files or tool results.
- **End of turn:** once the proposals land the band shows them as digit chips (§10). Unhandled proposals stay `proposed` and show in the pane under a "proposed" group; they never clutter Pocket. A review's proposals are kept with their turn, and the band shows them only while that turn is still the latest and none is running, so a review landing after the next prompt or `/clear` leaves its proposals in the pane only.

---

## 9. The hub: Tailscale service plus the phone form

### 9.1 Requirements
A host that is always on, on the tailnet: Bun installed, systemd (for the unit in `server/`), `tailscale serve` allowed by the tailnet policy, and a free port.

### 9.2 Service (`server/`)
- **Runtime:** Bun, a single file (`server/hub.ts`), and `bun:sqlite` (table `notes(id PRIMARY KEY, doc TEXT, updated TEXT, origin TEXT, seq INTEGER)`; `seq` is a server-assigned, monotonic change counter used as the pull cursor).
- **API:**
  - `GET /api/changes?since=<seq>&wait=25`: long poll. Returns `{ notes, cursor }`.
  - `POST /api/notes`: a batch upsert. The server applies §6.3 per note and returns the winners.
  - `GET /api/projects`: known projects, for the phone's picker.
  - `POST /api/jot`: `{ text, project? }` makes one phone note; what an iOS Shortcut or `curl` sends.
  - `GET /` and `/app.js`: the phone form (§9.3).
  - Notes travel as JSON; the hub holds each to the file format and refuses the rest per note.
- **Network and auth:** bind only to `127.0.0.1` and expose with `tailscale serve --bg --https=8443 http://127.0.0.1:8790` (HTTPS is needed for a PWA; its own port leaves anything on 443 alone). Every `/api` call carries a bearer token (`HUB_TOKEN`). `HUB_LOGIN` can additionally allow a Tailscale login without the token, but tagged devices carry no `Tailscale-User-Login` header, so the token is the auth. `POST /api/pair` (authorized) mints a one-time code, kept in memory for 5 minutes; `POST /api/pair/claim` (the one call without auth, own origin only) trades it for the token. `ostrakon pair` puts the code, not the token, in its QR.
- **Ops:** a systemd user unit, a daily SQLite backup (7 kept), and `GET /healthz` (answers `ok <version>`). No framework.

### 9.3 Phone form (PWA)
- **Capture first:** one big autofocused text field, a project picker (default `unfiled`; recent projects first), and Save.
- **Inbox below:** open notes, filterable, grouped as the pane's list view: a heading per project in the pane's colour for it, projects by latest note, newest first within each. A heading sticks while its group scrolls under it and a tap folds the group; folds are kept on the phone. Rows carry the pane's markers. A long press opens an action sheet (Edit, Copy text, Move to project, Mark sent, Archive) and a swipe left archives.
- **Offline:** captures queue in `localStorage` and flush when the hub is reachable, with the queue count shown.
- **Look:** dark and light themes, big tap targets, vanilla JS, no framework.
- **Add to Home Screen:** a manifest and an icon. iOS gives a Home Screen app storage apart from Safari's, so the token travels in the app's start URL (`docs/phone.md`).
- **Shortcut:** an iOS Shortcut can POST to `/api/jot` from the share sheet or Siri (`docs/phone.md`).
- Notes from the phone have `by: phone`.

### 9.4 Mod side
- Options `hubUrl` and `hubToken`; the folder adapter's is `mirrorDir` (§7.2).
- The hub adapter uses `$.http.fetch` with a long-poll `pull`. When the hub is unreachable the mod keeps working locally and the footer shows `hub offline · N queued` (or `hub refused the token · N queued`). While sync works the footer says nothing.
- **Hub runs:** every response names the hub's run (a random id per start). A client that sees it change drops its cursor and what it knew the hub held and does a full pull, so a restored or wiped hub gets every note back from the machines that have them.
- **Several sessions on one machine** each run the loop. Pushes and absorbs are idempotent (merge, per-note locks); the cost is N long polls and repeated identical pushes.

---

## 10. Resting state: Pocket (band above the prompt)

```
✎ cc   1: check why the cache…   2: rename the store helpers   3: ◆ login returns…   +2
```
- **Opener:** `✎ <project>` leads the row, dim; it carries the borrowed `ctrl+x s` action and opens the launcher.
- **Chips:** up to `pocketMax` (default 5, max 9) open notes of the current project, newest `updated` first. Each chip is a `plain` Button whose digit is its hotkey. The label is the note's text on one line, cut to 24 terminal cells with `…`, with `◆ ` in front for Claude's notes. The cut falls at the last word that fits, unless that leaves under 10 cells; then mid-word. Chips sit 3 columns apart.
- **`+N`** (dim) shows when more open notes exist than chips; it and the opener open the launcher. Opened by their chord the pane gets focus; opened by a click, or after `ctrl+x tab`, the band holds the keys, so the pane opens unfocused.
- **Width:** fit to `e.props.bodyColumns`, the opener included. First shorten every label, down to 10 columns, then drop chips from the right into `+N`. The opener and `+N` always stay.
- **While a turn runs** (`e.props.isWorking`) the whole row draws dim; the digits still work.
- **Fresh chip:** a note the person just saved (`/jot text`, the pane) stands out for 2 s: its chip at full strength, the other chips dim. A Button label takes no bold or colour.
- **Digit from an empty prompt:** type `2` and pause. Note 2 is filled into the prompt (prefixed per §4.5) and a toast says `note 2 in your prompt · ⏎ to send`. Submitting marks it `sent` (§5). A chip never opens the pane.
- **Zero notes:** the opener alone. `pocket: false` keeps only the opener.
- **Composition:** draw `await next(e)` first, inside a column Box, then the chip row.
- **Harvest** takes the chip row's place while the last turn has proposals:
  - One line: the opener, `◆ from this turn` in bold, the proposals as digit chips, `+N`, then `0: keep all`. Too narrow for a chip beside the title, the title shortens to `◆`. Under the first 3 harvests ever (counted in `$.store`, once per turn) a dim second line: `1–3 keep one · 0 keep all · the rest wait in the pane under “proposed”`.
  - A turn's proposals are Claude's `proposed` notes in this project carrying the turn's id. Only the main loop's `turn.complete` counts (subagents complete too); a turn that proposed nothing leaves the last harvest up, and a late harvest of an earlier turn never replaces a later one's.
  - Each turn fact (a conversation's generation, then a count per decision) is decided in order when its hook starts, so a write that waited never undoes a newer one. The band is drawn from these facts rather than synchronized to them.
  - Kept notes become `open` (only if still `proposed`). The band returns to Pocket when the next prompt starts a turn.
  - In the pane, a `proposed` row's footer is `a keep  r dismiss  t to prompt  i keys`.
- **No `$.ui.status`.** Counts live in the chips.

---

## 11. Repo layout and status

```
ostrakon/
  plugin/                 ← the mod
    .claude-plugin/plugin.json
    hooks/hooks.json
    hooks/register.tsx    ← thin: wires events to modules
    src/                  ← store.ts, mirror.ts, merge.ts, ulid.ts, frontmatter.ts, sync/*.ts, ui/*.tsx
    types/index.d.ts
    tests/*.test.ts
  server/                 ← hub (Bun) + public/ (phone PWA)
  docs/                   ← this file, phone.md
  tools/                  ← check.sh, screenshot pipeline, harnesses (see §12)
```
- A plugin may import its own files, but `import()` is not allowed.
- A `.claude-plugin/marketplace.json` at the repo root would make it installable with `/plugin install ostrakon --marketplace gaius-codius/ostrakon`.

**Built:** the storage core, the launcher pane, the Pocket band and `sent` tracking, the hub with the phone form and hub adapter, harvest, and the folder adapter. **Not built:** the git adapter and Notion.

## 12. Verification
- **Static checks:** `tools/check.sh` runs `claude plugin validate plugin/`, the type-check, `claude plugin test plugin/` and the hub's `bun test`. Type-checking needs `plugin/.claude-plugin/types/`, which the engine writes when it loads the mod.
- **Live:** drive a real session in tmux (`tmux new-session -d -s t -x 160 -y 42 'claude …'`, `send-keys`, `capture-pane -p`), with `--debug-file` to read `ui.open`, `ui.focus` and refusal lines.
- **Screenshots:** `tools/screens/lib.sh` (`start <fixture> <cols> <rows>`, `keys …`, `lit "text"`, `shot <name> "<caption>"`) renders `tmux capture-pane -e -N` to HTML (`ansi2html.py`) and then to PNG with headless `chromium`. Fixtures are `empty`, `few`, `long` and `many` (`fixture.py`); point a session at one with `OSTRAKON_DIR`. Wait about 2 s after opening before a shot.
- **States worth a screenshot:** search (empty, typing, no match), list view (grouped, folded, history), picked plus bundle, capture, edit, Pocket (0, 3, 9+ notes), the harvest band, a narrow terminal (100 columns, inline), and the light theme.

## 13. Targets (keystrokes, from a closed pane)
| Flow | Target |
|---|---|
| Capture mid-turn | N+3 (`// text ⏎`), and no loss of an existing draft |
| Send a same-project note | **2** (Pocket digit, ⏎) |
| Find and send a note from another project | **Q+4** (`ctrl+x s`, type, ⏎, `s`) |
| Edit a note | **R+5** (`ctrl+x s`, ⏎, R moves, `e`, ⏎), with explicit save/cancel and a kept draft |
| Bundle 3 hand-picked notes | **10** (`ctrl+x s`, ⏎, `v`, `j`, `v`, `j`, `v`, `b`, ⏎) |

Counting `ctrl+x s` as two keystrokes.
