# Ostrakon: design

Status: in development · Last revised 2026-10-11

How ostrakon works: what it does, how notes are stored and synced, and the facts about Claude Code it depends on. Code comments point to sections of this file as `SPEC §n`.

| Path | What it is |
|---|---|
| `plugin/` | The mod (Claude Code plugin): store, merge, sync adapters, pane and band UI |
| `server/` | The hub (Bun + SQLite) and the phone app (PWA); setup in `docs/phone.md` |
| `bin/ostrakon`, `install.sh`, `update.sh` | The command line (`jot`, `pair`, `hub`, `update`, `doctor`, `version`) and the install and update scripts |
| `tools/` | Development tooling: screenshot pipeline, mockups, QA and experiment harnesses (their output goes to the gitignored `working-docs/`) |

---

## 1. Product

A scratchpad inside Claude Code for the thoughts, follow-ups and ideas that come up while you work with Claude, so they get written down instead of derailing the current task or being forgotten.

Three jobs, in priority order:

1. **Capture**: get a thought down in under 2 s, even mid-turn, without losing your place or your prompt draft.
2. **Triage**: see what's pending in this project and across every project and machine; find, edit, tidy and decide.
3. **Dispatch**: turn one note, or a hand-picked set, into a prompt. Never lose a note if dispatch fails.

Throughout, it should be keyboard-first, quick, and calm when you aren't using it.

### Shape
- **Pane = Launcher**: search-first, fzf-style, with multi-pick and bundle.
- **One view** inside the pane: notes grouped by project, filtered by the search field. No tab bar.
- **Resting state = Pocket**: numbered note chips above the prompt. `;` and a chip's digit in an empty prompt pull that note in (§10).
- **Harvest** (opt-in): after a turn, side issues worth keeping are proposed above the prompt, with **no change to how Claude works** (§8).
- **Sync**: pluggable adapters. A hub (usually reached over Tailscale) that also serves a phone capture form, and a folder adapter for Dropbox, Syncthing and Obsidian (§7).

### Non-goals
Ostrakon is not a full task manager: no due dates, priorities or assignees. It also has no board view, no sharing notes with other people, and no drag-and-drop with the mouse.

---

## 2. Platform facts

Claude Code's mods interface has rules and limits that aren't obvious from its API, and many choices later in this document follow from them. This section collects the ones that mattered. Anything marked *unverified* hasn't been tested.

### 2.1 Loading, checks and tests
- A mod is a plugin folder: `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{"modules":["./register.tsx"]}`), the hooks module, and `types/index.d.ts` (required when using `$.state`; named by `"types"` in `plugin.json`).
- Load it with `claude --plugin-dir <dir>` or `CLAUDE_CODE_PLUGIN_DIRS` in `settings.json`. Interactive sessions watch the folder and hot-reload on save.
- The engine writes types to `<mod>/.claude-plugin/types/` on load. Type-check with `npx -y -p typescript@5.6.3 tsc -p <mod>`.
- `claude plugin validate <dir>` checks statically; `claude plugin test <dir>` runs `*.test.ts`. Validation requires:
  - helpers that take `$` are **top-level** functions or consts, not closures inside `register`;
  - `$.state` keys are literals declared in the contract;
  - `$.env.get` names are literals.
- Runtime errors show as dim transcript lines. `claude --debug-file <path>` logs every refusal (`ui.open … asked|unasked`, `ui.focus … moved|denied`).
- A rejected `$` promise that nothing catches fails tests, so add a `.catch` to every call you don't await (especially `$.ui.focus`).
- The test kit (`claude-code/testing`):
  - mock every noun you touch (`mock.clock`, `mock.env`, `mock.store`);
  - op events answer `{ value }`;
  - `session.start` needs a bottom (`on('session.start', ($, e) => ({ cwd: e.cwd }))`);
  - `$.fs` has no implementation, so tests use an in-memory one (`plugin/tests/memdir.ts`);
  - `$.clock.sleep` blocks until `clock.advance(ms)`.

### 2.2 Focus, keys and opening
- **When a pane appears:** one opened in direct response to the person's input (a command, a button press) is placed at any width. One the mod opens "on its own" (a timer, a delayed call) only appears from **144 columns** (110 once the person has opened it). So open inside the triggering handler and check `isPlaced`.
- **When focus is granted:** `focus: true` is honoured only while the prompt is empty and nothing else holds the keys. A band Button press holds the keys, so `onPress` must return the open's promise for the pane to count as asked.
- **Inputs swallow keys:** while an Input has focus every printable key goes to it, so letter hotkeys only work when a Button has focus. The UI therefore always shows which mode you're in and which keys work now.
- **Hotkeys:** a Button `hotkey` is a single lowercase letter or digit and only works while the pane or band holds focus. Tab/Shift+Tab and Up/Down move between controls natively.
- **Esc:** with `closeOnEscape: true`, Esc raises `ui.close` with origin `person`, the same as the close mark, `ctrl+x x` and the engine's `pane:close`. A `ui.close` hook may refuse it by answering without `next`. The keys still go to the prompt, though, so take them back with `$.ui.open({ id, focus: true })` a moment later. That is how Esc can mean "back" instead of "close".
- **Ctrl chords:** mods can't define global shortcuts. A Button's `action` prop names an *existing* keybinding action, and the person's chord for it presses the button while it's mounted. Ostrakon borrows actions with no default key (table in §4.5). Contexts: `Pane` (a pane control has focus), `PaneField` (a pane Input or Select has focus), `Chat` (the main prompt). An action the engine is handling at the time never reaches the Button: `app:toggleTerminal`, `app:toggleBrief` and `pane:top` don't, the diff view's actions (the view is closed), `pane:previous` and `pane:next` (with one pane open) and `app:openArtifact` do. A pane's Button gets the person's chord from the prompt too.
- **Giving the keys back:** a mod has no call that gives the prompt the keyboard. Esc does (with `closeOnEscape` it raises the close, which a hook may refuse), and so does closing the pane. So to hand the keys over and keep the pane, close it and open it again without `focus`, inside the press: the press must wait for the open (return its promise) or the reopen counts as unasked and isn't placed under 110 columns.
- A bare `ctrl+x` can't be bound (it prefixes every engine chord), and `ctrl+x x` only closes a pane that holds the keyboard.

### 2.3 Drawing
- **Elements** come from `$.ui.resolve(e)`: Box, Text, Button, Input, Select, Link, Code, Markdown and Client; Raster and Image are terminal-only; mobile has no Input or Select.
- **Button** `plain` draws `k: label` with the hotkey in `suggestion`; without `plain` the terminal shows `[ label ]` and no hotkey. A digit hotkey on a band Button also fires when the person types that digit alone into an empty prompt and pauses. Ostrakon's band takes no hotkeys for that reason: a lone digit is how the person answers Claude's numbered questions. It reads its own keys in `prompt.edit` instead (§10).
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
- **`$.state` resets** on `/clear`, `/resume` and `/branch`, and `session.start` doesn't fire again. So reload on `session.start` and after `session.end` with reasons `clear` and `resume`; a poll also restores lost state. Don't rely on `classic.SessionStart`: an organization's policy plugin can bypass user plugins' classic hooks.
- **`$.store`** is kept per config directory. That's fine for preferences, but not for notes.
- **`$.fs.write` is not atomic:** a reader can see a half-written file. Rule: **a file that fails to parse aborts the operation; never write a default over it.** For atomic replacement, write a temp file and `$.process.run(['mv', tmp, final])`.
- Writing inside the plugin folder triggers hot reloads, so keep data outside it.
- There are no file-change events, so poll `$.fs.stat` mtimes.
- `$.session.root()` is the project root; `$.session.repo()` returns `{ root, remote }`, and the remote is the project key that is the same on every machine.
- `$.env.get('NAME')` takes literal names; `OSTRAKON_DIR` points a session at fixture data, and `OSTRAKON_CACHE` moves its machine records (memos, sync caches, the doctor's report) out of `~/.cache/ostrakon`; locks stay there, so every session on the machine shares them.

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

`plugin/src/ui/look.ts` holds every visual constant (glyphs, theme keys, widths, footer and toast wording, the chord table), so a change of look is a one-file edit. What the pane and the phone share (colour roles, the project palette, symbols, motion, fixed copy) is set in [`DESIGN.md`](DESIGN.md), which `tools/check.sh` holds to the code. The mockup mod (`tools/mockups`, `/mock mix <view>`) draws every state. This text is the reference for keys, wording and behaviour; the renders are the reference for spacing and colour.

### 4.1 Visual language
- Colour comes from theme keys, so every theme works, except project colours: a fixed palette shared with the phone, picked by the person's theme. The roles, the palette, the hash and how a theme picks its values are in [DESIGN.md §2–3](DESIGN.md#2-colour-roles).
- The accent (`claude`) marks the current project, row numbers, picks, `◆` and search hits (bold, no underline). The selected row has a `subtle` background and a focus block in column 0. Metadata (age, preview meta, footer labels) is dim. Other projects get a deterministic colour from a hash of their key, drawn on a `●` before their dim name, never on the name; `unfiled` is a grey `○`. `warning` and `error` are kept for real problems.
- No rules: one blank row separates the search row, the rows, the preview and the footer. Docked, capture is the one framed element (a `round` accent box).
- Glyphs and what each means: [DESIGN.md §5](DESIGN.md#5-symbols).
- Draw to `bodyColumns - 1`: a tree exactly `bodyColumns` wide overflowed by a column.
- Project labels are the repo basename; two projects with one basename get parent segments until they differ.

### 4.2 Search and groups
Focus starts in the search field; no row is selected and the top result is previewed.
```
❯ cache▏ ⏎ to list                                  all · 3 of 12   ← search row
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
● cc                                                              1   ← group header
   1   check why the cache test is flaky on CI. started after…  12m   ← rows
● infra                                                           1
   2   add a cache invalidation metric to the hub dashboard      1h
● api                                                             1
   3   document the cache-key format in the api readme           2d
──────────────────────────────────────────────────────────────────────
       ▎ check why the cache test is flaky on CI. started after     ← preview
       ▎ the redis bump, only on the arm runners
       ▎ you · ~/Work/cc · main · 12m ago                          ← meta
──────────────────────────────────────────────────────────────────────
ctrl+s this project  ctrl+n new  ctrl+q close         ctrl+x i keys  ← footer
```
- **Rows** are one line under their group header, indented two columns: selection bar, the row's number in the window (1–9, then `·`), a marker (`◆`, `▪`, `●`/`○`, `↗`), the text with search hits highlighted, then the age (`now`, `12m`, `3h`, `2d`, `5w`, `1y`).
- **Preview** (docked only): the selected note's text, capped at 6 lines, then a meta line `who · path · branch · age ago`, all behind a dim `▎` bar. It's indented so the bar starts in the rows' text column; no blank row is added for it. A long path is cut, then dropped, before the age is.
- **Ordering:** groups as in §4.3, with or without a query. Within a group: by rank with a query, otherwise newest `updated` first, ties by id. Ranking is a fuzzy subsequence score with bonuses for word starts, the current project and recency. Query tokens: `@infra`, `is:sent`, `is:archived`, `by:claude`.
- **Scope** is explicit state, shown at the right of the search row. The pane opens on this project; the first typed character switches to all, and clearing the query switches back, unless the person chose a scope with `ctrl+s`. Choosing all is remembered across sessions (`$.store`).
- **No match:** dim, `No notes match. ⏎ saves it to cc.` Enter saves the query as a note. The field drops its `⏎ to list`, which would be wrong here. A query too long for the field shows above that line, wrapped, as capture's draft does: up to 6 lines docked, its last line inline or in a body too short for the preview; one that fits isn't repeated. A storage problem's row stays above it.

### 4.3 Groups, history and picks
- **Groups** have a header at the left edge: the project's dot and its label, dim, with the group's open count dim on the right (the current project's even at `0`) and `▸` when folded. `proposed` (with `◆`) and the current project are bold accent. The notes under a header are indented two columns, so note text is the brightest thing in the list. Order: `proposed` first when harvest has any, then the current project, then others by latest activity, then `unfiled`. Within a group: open notes first, then history when shown. A query filters the notes and leaves `proposed` out; a group with none left isn't drawn, and a folded group shows its matches while the query lasts.
- **Headers are focusable;** `z` folds or unfolds a group.
- **History:** `h` adds `sent` and `archived` notes (dimmed); `u` on one restores it. With nothing open in this project but history hidden, its header still shows, with a count of `0`, in place of the empty inbox, and the search field's footer leads with `↓ history`: `↓` (or ⏎) reaches the header and `h` (or ⏎ there) shows the history, unfolded. The bare header has nothing to fold, so it offers no `z`. A query hides it. A storage problem's row sits above it, and then the footer leaves `↓ history` out.
- **Picking:** `v` picks or unpicks an open or proposed note. Once one is picked every row shows `●`/`○` and the footer leads with `3 picked`. Picks live in `$.state` until sent, cleared (`x`) or the session ends; a picked note that stops being open drops out with a toast. Bundles keep pick order.

### 4.4 Capture, `//` and the draft stash
- **In the pane:** `n` on a row or `ctrl+n` turns the search row into the capture row (`✎ new note`, the text, the target project at the right). Enter saves and stays in capture; Enter on an empty line returns to search. The draft shows underneath, wrapped (its end, when it's longer than the room). A failed save keeps the text and shows `Couldn't save: <reason>`.
- **Target project:** `ctrl+s` in capture turns the capture row into a picker (`✎ save to`, a field), with the projects under it: this project, `unfiled`, then the others, the current target marked `· now`. Typing narrows them to the labels that hold the text; Enter picks the first, and the row goes back to capture with the draft as it was. With nothing typed, Enter picks this project. `ctrl+s` or Esc goes back unchanged; nothing matching, Enter does nothing. The target holds while the pane is open, so several notes in a row go to the same project, and goes back to this session's project when the pane closes (`ctrl+x tab` doesn't close it). The phone puts the last-used project first instead (§9.3): it has no session project to go back to.
- **From the prompt:** a prompt that becomes exactly `//` is rewritten to `/jot ` (cursor at the end). `/jot` runs at once even mid-turn. `/jot` is painted in the accent and bold, the note after it italic. `/jot text` saves to this project; `/jot` alone opens the pane on search, where Enter on a query that matches nothing saves it as a note and `ctrl+n` turns to capture. To send a literal `//` prompt, start with a space or paste it: only one typed `/` after a lone `/` triggers the rewrite.
- **Hint line:** the dim line under the prompt gets a tail after ` · `. While the draft leads with `/jot `: `✎ ⏎ saves to cc`. A `/jot` draws no output row, but Claude still reads the command in its transcript, so the mod adds one line for Claude only: the note is the person's, saved, and needs nothing from it. For a few seconds after a save from the prompt ([DESIGN.md §7](DESIGN.md#7-motion)) (or a search with no match, saved from the pane): `✓ saved to cc`, in place of a toast. A failed save still says `Couldn't save: <reason>`.
- **Draft stash.** Every open that asks for focus (`ctrl+x s`, `/jot`, `ctrl+x tab` on a closed pane) first reads the prompt. If it holds a draft, the draft is kept in `$.state` as the *stash*, the prompt is emptied, and the pane opens focused. Each time the pane gives up the keys, the exit decides what the prompt holds and clears the stash; `ctrl+x tab` back into the pane holds it again:

| Exit | Prompt afterwards |
|---|---|
| `t`, or `t` in the bundle | the non-empty parts of: stash, whatever was typed into the prompt meanwhile, the note text, joined by blank lines; the pane closes |
| `s`, or ⏎ in the bundle | the note is submitted; on close the stash goes back. A failed or dropped submit leaves the note `open`, toasts `Not sent: <reason>`, and keeps the pane and stash |
| close (`q`, `ctrl+q`, `ctrl+x s`) | the stash goes back |
| keys to the prompt (`ctrl+x tab`, Esc at the top): the pane stays open | the stash goes back; `ctrl+x tab` from the prompt holds what's there again, after anything still held, and takes the keys back (refused them, it gives it straight back) |
| open refused or not placed | the stash goes straight back |

  The `ui.close` hook puts the stash back as the whole prompt only if the prompt is still empty. Otherwise it adds the stash after a blank line, so nothing is overwritten.
  So the stash is held only while the pane has the keys: when they go to the prompt, the draft is there too. A click into the prompt is the exception (the mod isn't told), and leaves it held until the next exit. `t` closes the pane rather than leaving it open: the prompt is where the work goes next, and an inline pane would keep its rows above it.
- The capture draft and the edit draft live in `$.state` and are restored when the pane reopens. The pane reopens in the edit card only if it closed while the card (or the key sheet over it) was showing; an edit left before the close keeps its draft for the next `e` on that note.

### 4.5 Keys and actions
Letter and digit keys work only while a row, header or Button has focus (an Input takes every printable key). `ctrl+` chords work anywhere in the pane.

| Key | Action |
|---|---|
| ↑ ↓ / Tab / `j` `k` | move; selection follows focus |
| `1`–`9` | jump to that row in the window |
| `g` | the top row; on the top row, the bottom one (`G` can't be a hotkey, §2.2). In the key sheet, not the footer |
| ⏎ | in search: focus the first result. On a row: same as `t` |
| `v` | pick or unpick |
| `x` | clear the picks (in the bundle: back to the list) |
| `t` | **to prompt**: fill the prompt (stash rules above) and close the pane. A note from another project is prefixed `[label] `. It becomes `sent` only when a submit containing that text is seen (§5) |
| `s` | **send** as the person (`asUser: true`), with the same prefix. If the text contains `@` mentions it behaves as `t` instead and says so. It becomes `sent` only after the submit resolves without a drop |
| `b` | bundle preview of the picked notes (§4.7) |
| `e` | edit inline (§4.7) |
| `d` | archive (`u` undoes) |
| `u` | on a history row: restore to open. Otherwise undo this session's last mutation (archive, edit, restore, pick-clear, move). A send can't be undone |
| `m` | move to a project (or `unfiled`): a `move to` field under the rows, with the places listed under it (up to five), the note's own left out. Typing narrows them to the labels that hold the text; Enter moves the note to the first and selects it. With nothing typed, Enter takes the first listed; nothing matching, Enter does nothing. The picker is a field, as capture's target picker is (§4.4), because the engine's `Select` has no type-to-search |
| `y` | copy the full text |
| `h` | history on/off |
| `z` | fold or unfold the group |
| `f` / `ctrl+f` | focus search |
| `n` / `ctrl+n` | new note |
| `ctrl+s` | scope (search, list); the footer names where it goes: `all projects`, or `this project` while scope is all. In capture, the target project picker (§4.4) |
| `i` / `ctrl+x i` | key sheet on/off (`ctrl+x i` also from a text field, which takes `i`; the sheet then has the keys, and gives them back to that field when it closes): a framed list of every key (unframed when the body is too short for a line inside the frame) (storage problems first; opened on a row, that row's own keys next, in its footer's order) between the search row and the footer; while it is up the pane takes the whole body and the footer its last row. It is at most 46 columns and never wider than the pane. After the keys, under a bold `symbols`, what the row markers mean: `◆` from Claude, `▪` from the phone, `● ○` picked / not picked, `↗` sent, `·` archived (or a row past 9), `▸` folded group. When it's longer than the rows between, it pages: the footer shows `j more 2/3`, `j` turns to the next page and `k` back, both going round |
| Esc | **back** one step: edit → the row (draft kept), move / bundle → the list, key sheet → the text field it was opened from, else the list, target picker → capture, capture → search, a row → the search field, a query → empty; at the top the keys go to the prompt and the pane stays open (Esc again, at an idle empty prompt, closes it). The close mark and `ctrl+x x` do the same as Esc (the mod can't tell them apart); the close mark closes a pane that isn't holding the keys |
| `ctrl+x tab` | the keys go to the prompt and the pane stays open, keeping its search, selection and drafts (an open key sheet or move picker closes; the target picker goes back to capture); from the prompt, back to the pane where it was. On a closed pane it opens it. It replaces the engine's `ctrl+x tab` (focus the band); a click still focuses the band |
| `q` / `ctrl+q` / `ctrl+x s` | close the pane from anywhere; drafts are kept. `ctrl+x s` closes it from the prompt too |

**Borrowed chords** (the person binds them in their keybindings; the table lives in `look.ts`):
- `ctrl+x s` → `app:cycleDiffBase`
- `ctrl+x tab` → `app:openArtifact` (in `Chat`, `Pane` and `PaneField`; the band carries it too, so with the pane closed it never reaches the engine, which would open an artifact)
- `ctrl+f` → `app:toggleDiffNoiseFilter`
- `ctrl+s` → `app:toggleDiffPreSession`
- `ctrl+q` → `pane:previous` (not the engine's `pane:close`, which the mod reads as Esc)
- `ctrl+n` → `pane:next`
- `ctrl+x i` → `app:toggleReplTab`

### 4.6 Contextual footer
One blank row, then one line: as many key/label pairs for the focus as the width takes (key bold, label dim, two spaces between) and `i keys` on the right (`ctrl+x i keys` while a text field has focus); the last pairs drop until the line fits. On a row with nothing picked, the note's own actions lead (`t to prompt  s send  e edit  d archive`), then `m move` and `y copy`, then `v pick`, `z fold` and `h history`. A status leads in bold: `3 picked`, `2 unreadable files` (error), `hub offline · 3 queued` (warning); a status takes at most half the line (24 columns when half is less) and is cut with `…`, its `· 3 queued` kept, leaving room for `i keys`. The legend `◆ from Claude` trails while a `◆` row is drawn; it drops after any pairs past the first four, and before those four.

**The footer never advertises a key that doesn't work in the current focus**, so it changes with the focus (search field, row, picks held, history, proposed, group header, capture, edit, bundle, empty inbox). A pane that isn't holding the keyboard shows only `ctrl+x tab focus  ctrl+x s close`, both of which work from the prompt.

**Storage problems** also draw a focusable problem row above the first result, in `error` (`⚠ 2 unreadable files · ⏎ details`); ⏎ opens a card listing each file and reason.

### 4.7 Other states
- **Bundle:** `⇢ bundle  3 notes into one prompt`, then the exact prompt in a quote box: `Please look at these notes from my ostrakon:`, a blank line, one `- ` line per note in pick order (other projects prefixed `[label] `). Focus goes to a `[ send ]` button; ⏎ sends and `t` fills the prompt instead. Picked notes are marked sent only once the prompt goes in.
- **Edit:** the row becomes a `round` box with a one-line Input prefilled with the text. Newlines show as `↵` and turn back into newlines on save (a note that already contains `↵` can't round-trip, so `e` points you to the file). `[ esc back ]` and `[ ⏎ save ]` sit below, naming their keys where the eye is, then `draft kept if the pane closes` when it fits on the line; the draft is kept if the pane closes. `[ esc back ]` does what Esc does: back to the row, the draft kept for the next `e` on that note.
- **Empty inbox** (nothing open in scope, and no history in this project; with history, §4.3's bare header instead): `Nothing pending in cc.` (scope all: `Nothing pending in any project.`) and the ways in (`//`, `ctrl+n` new note, and the phone and harvest lines when those are configured) in a fixed key column. Docked, a small dim shard sits beside them; when the descriptions would be cut beside it, the shard is left out.
- **Toasts** are short and calm (`Archived · u undo`, `Copied`, `note 2 in your prompt · ⏎ to send`). Never `$.ui.status`.

### 4.8 Paging and the inline pane
**The mod pages the rows, never the engine.** It draws only the rows that fit in `scroll.bodyRows` minus the chrome, so the content always fits. This matters because the arrow keys only move between controls while the content fits; it's what lets the selection follow the focus.
- Numbers 1–9 count from the top of the window.
- **Edge sentinels:** when rows exist below the window a dim `↓ 4 more` button sits under the last row; above, `↑ 2 more`. Focus arriving on one shifts the window by a row and moves focus to the new edge row; `j`/`k` page directly.
- **Zero results:** no rows and no sentinels; focus stays in the search field.
- **When the selected row disappears** (filtered, archived, synced away), selection moves to the row now at the same index, or the last row.

**Inline layout.** Switch on `e.props.placement === 'inline'`, not on a column count. The inline body is about 11 rows and keeps the search row, the rows and a one-line footer; it drops the preview. The scope and counts stay at the right of the search row in every focus; with a row selected, its meta leads them (`◆ claude` or `phone` when not yours, then path, branch, age), dropping the path, then the age, then the branch when the room runs short. Footer pairs drop from the right until the line fits.

### 4.9 Construction
- The search field is an `Input` with no `label` (the terminal would draw `label: `); the glyph is a `Text` before it.
- A row is a keyed `Box` whose focus target is a one-space `plain` Button in column 0; focus inverts it into the selection bar. Rows are keyed by *slot in the window*, not by note, so paging doesn't move the ring.
- While the move picker or the edit card is open, the rows and the `↑ n more` and `↓ n more` lines draw a plain space instead of their Button. Across a redraw the terminal keeps the ring at the same place among the controls, not on the same key, so a row added or dropped above the picker or the card would otherwise take the ring: the picker closes and loses what was typed in it. Leaving either one by Shift+Tab goes to the search field.
- Keys with no visible control (letter actions, digits, borrowed chords) are Buttons in an **action layer**, a `display: 'none'` Box drawn last. A `ui.focus` hook redirects any move onto it.
- While a row, the bundle or the key sheet holds the ring, the layer also answers every other letter and digit by doing nothing, because an unanswered printable key would go to the prompt and take the keyboard with it.
- Docked, the preview and footer have fixed heights, so the window never changes size as the selection moves. The pane fills the body and the footer keeps its last row, whether the list is full, short, has no match or is empty. In a body too short for the preview and three rows besides, the preview goes, as inline, so the footer stays on screen. What sits between the search row and the footer is cut at the rows left there, so in a short body it is the empty block, a long query or capture's saves that are cut, never the footer. Capture keeps its hint (or its error) first, then the newest save, then the draft's lines, then the earlier saves. Editing, the preview gives up text lines (the draft keeps its end) before the rows or the footer give way. The bundle's note list gives up lines first, down to one `… and N more`, then its blank lines, so its `[ send ]` button stays on screen down to a body of 6 rows.
- Each open draws exactly one `autoFocus` element. Every in-pane view change calls `$.ui.focus` on its target (search → first result, list toggle → selected row, capture, edit, bundle → `[ send ]`, back out → the row it came from, fold → the header).

---

## 5. Dispatch semantics
- **Detecting a sent note:** in `prompt.submit` (origin `composer`), if the text contains the exact text the mod filled for a note or bundle since the last submit, those notes are marked `sent` (each fill on its own: two notes filled one after the other are both marked, and one whose text was deleted from the prompt is not), with `sentAt` and `context.sentSessionId`. A prompt submitted while idle is marked at once; one submitted mid-turn only waits in the queue (the person can take it back) and is marked when it is delivered.
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
origin: laptop                       # hostname that made the last change, or the source /api/jot was given (§9.2)
project: cc                          # the project's name, or null for none
projectKey: github.com/example/cc    # normalized git remote; falls back to "path:/home/user/work/cc"
projectPath: /home/user/work/cc      # display only; differs per machine
sessionId: 0463fee3-…                # context, all optional
branch: main                         # read and shown if present; not written (the engine gives no branch)
turnId: …
harvestOf: "fix auth tests"          # read if present; not written
sentSessionId: 32896f8f-…            # where a sent note went (§5)
sentAt: null
deleted: false                       # tombstone, only set by purge
---
check why the cache test is flaky on CI. started after the redis bump, only on the arm runners
```
- **Project key:** the `origin` remote, normalized, so a project is the same on every machine. A worktree is its main checkout's project (the engine's repo root is the main working tree's). A folder with no remote falls back to `path:<its root>`; once it has a remote, a session there moves the notes kept under that path to the remote's project, so the folder isn't two projects. The move is an ordinary change that syncs like any other, made by the poll only after every sync (hub, mirror) has pulled in that session, so a change made elsewhere meanwhile isn't undone by this machine's older copy.
  - **Known issue, kept by choice:** a `path:` key is only a path, so the same path on two machines is one project, and when it gains a remote on one machine, notes made under that path on the other move too. Telling them apart would need a record of which machine made each note. Revisit if folder paths are shared across machines.
- **Flat keys:** the project and context are written as flat keys because Obsidian's Properties shows nested blocks as raw JSON. Older nested `project:`/`context:` blocks are still read.
- **Parsing:** a strict, small YAML subset with its own parser and serializer (no dependency). An unparseable file is **skipped and reported**, never overwritten. Keys this mod doesn't own are kept verbatim.
- **Writes** go to a temp file of their own, then `mv` puts it in place in one step. The file is read back after the rename; if another writer replaced it meanwhile, it's re-read on the next poll.
- **Changing a note** takes a per-note lock, reads every copy of that id fresh, merges them, applies the change and writes `<id>.md`.
- **Locks** coordinate the sessions on one machine only; machines reconcile through copies and the merge, never through locks on a synced folder. They live in `~/.cache/ostrakon/locks/<id>/` (`mkdir` plus an `owner` file with a random token, the owning process id and its start time).
  - A lock is taken over **only when that exact process is confirmed gone**; a failed lookup never counts as gone. A live owner keeps its lock however long it stalls, and waiters give up after about 3 s.
  - Recovery runs under a guard so one session recovers each abandoned lock. An ownerless lock (a crash between `mkdir` and the owner write) is cleared after 60 s.
  - Note ids are restricted to `[0-9A-Za-z_-]` because they name files and locks.

### 6.3 Merge rules (local, and every sync adapter)
- Notes are matched by `id`.
- **Winner** (`plugin/src/merge.ts`, shared by the mod, the hub and every adapter): the later `updated` wins. On a tie, the more final status wins: `deleted` > `archived` > `sent` > `dismissed` > `open` > `proposed`. Then the higher `origin`, then the whole serialized file, so the order is total and every machine picks the same winner.
- **Clock:** every local change sets `updated = max(now, previous.updated + 1ms)`. So a change always moves the note's clock forward, even when this machine's clock is behind the one that made the last change (the idea behind a hybrid logical clock).
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
- **Hub adapter:** HTTP to the hub (§9).
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
Not built. It would be the only adapter that needs real upkeep, because Notion has its own data model and API. There are two routes: the Notion API through `$.http.fetch` with a token in a `sensitive` option, or the claude.ai Notion connector through `$.mcp.call` (declared in the API but *unverified* at runtime). The last writer would win, with Notion's `last_edited_time` mapped into `updated`. A one-way export is the cheap first step.

---

## 8. Harvest (opt-in)

**Rule:** harvest must not change how Claude works. If Claude would have pursued or fixed something, it still does. The ostrakon is a *place to put* ideas, follow-ups and observations that would otherwise be mentioned in passing or never said.

- **Options:** `harvest` (boolean, default `false`), `harvestMaxPerTurn` (default 3, 1 to 9) and `harvestMode`, `fork` (default) or `light`.
- **Claude's tools** are registered always and are the same with harvest on or off:
  - **`jot`** (`mcp__ostrakon__jot`) is what "jot that down" calls. A jot is an `open` note of Claude's (`by: claude`) in this project, with a toast `◆ Claude jotted: …`, and the reply gives its id. An optional `project` names another project the notes already know (by its label, key or name, case aside); an unknown name is refused with the known ones. A jot whose text matches an `open` or `proposed` note in the same project (case and spacing aside) saves nothing and replies with that note's id. Claude's saves in a session (jots and harvest) run one at a time, each checked against what is waiting just before it, so two at once can't both save the same text; two sessions saving the same text at the same moment still can. A project name that fits two projects at the first way it matches is refused, with those projects by key.
  - **`notes`** (`mcp__ostrakon__notes`) lists the `open` and `proposed` notes in this project, another (`project`) or all (`project: "all"`), newest first or by match for a `query` (the pane's search, `@project` and `by:claude` included; `is:sent` and `is:archived` find nothing, since only waiting notes are listed): one line each with its id, age, author, `proposed` when it is, and `[project]` for other projects in an all-projects list. At most 50, then how many more.
  - **`archive`** (`mcp__ostrakon__archive`) archives an `open` or `proposed` note by id, with a toast `◆ Claude archived: …`. It goes on the pane's undo list, so `u` restores it. The status is checked again on the note as read under its lock, so a note another session sent or archived meanwhile is refused and nothing changes; so is an unknown id.
- **Mechanism:** when a main turn ends (`turn.complete`, an answer, not interrupted, at least 5 s), the mod asks one question with no tools over the session's own transcript (`$.model.fork`, served from the prompt cache). The question carries the turn's final reply and the notes Claude already jotted in it, and asks for up to `harvestMaxPerTurn` side issues worth keeping, as a JSON array of strings in a fenced block (`[]` for none). The array becomes `proposed` notes (`by: claude`) in this project, less any that repeat a note already waiting there (`open` or `proposed`, case and spacing aside) or each other. Claude's own requests are identical with harvest on and off.
  - **Why a review rather than prompt text:** the engine's security default skips a user-tier plugin's `prompt.compose` and `prompt.context` hooks (only a tool's description reaches the model). Claude does call `jot` on its own; the review catches what it leaves in passing.
  - **Cost:** one fork per reviewed turn, mostly cache reads (about 45k cached, 0.5k new input, 0.1k output tokens, 2 s, after the turn).
  - **`light` mode** replaces the fork with one `$.model.complete` on a small model, shown only the turn's prompt, its final reply (cut in the middle beyond a limit) and the notes already jotted, and told it can't see files or tool output. It costs about a sixtieth as much but finds fewer proposals and none that depend on files or tool results.
- **End of turn:** once the proposals land the band shows them as numbered chips (§10). Unhandled proposals stay `proposed` and show in the pane under a "proposed" group; they never clutter Pocket. A review's proposals are kept with their turn, and the band shows them only while that turn is still the latest and none is running, so a review landing after the next prompt or `/clear` leaves its proposals in the pane only.

---

## 9. The hub: sync service plus the phone app

### 9.1 Requirements
A machine that stays on, with Bun installed, systemd (for the unit in `server/`), a free port, and a way for your devices to reach it over HTTPS. `tailscale serve` is the easy way (the tailnet's policy has to allow it); any HTTPS reverse proxy, tunnel or VPN works too (`docs/phone.md`).

### 9.2 Service (`server/`)
- **Runtime:** Bun, a single file (`server/hub.ts`), and `bun:sqlite` (table `notes(id PRIMARY KEY, doc TEXT, updated TEXT, origin TEXT, seq INTEGER)`; `seq` is a server-assigned, monotonic change counter used as the pull cursor).
- **API:**
  - `GET /api/changes?since=<seq>&wait=25`: long poll. Returns `{ notes, cursor }`.
  - `POST /api/notes`: a batch upsert. The server applies §6.3 per note and returns the winners.
  - `GET /api/projects`: known projects, for the phone's picker.
  - `POST /api/jot`: `{ text, project?, source? }` makes one note; what an iOS Shortcut, `curl` or another sender (a Slack bot) sends. Without `source` it's the phone's (`by: phone`, `origin: iphone`); with one it's yours (`by: you`) and `origin` is the source, a short name (letters, digits, `.`, `_`, `-`; at most 64). A project is matched by key or name; an unknown one leaves the note unfiled.
  - `GET /` and the files in `server/public/` (one folder down at most: `fonts/`, `vendor/`): the phone app (§9.3).
  - Notes travel as JSON; the hub holds each to the file format and refuses the rest per note.
- **Network:** the hub binds only to `127.0.0.1`. With Tailscale it's exposed by `tailscale serve --bg --https=8443 http://127.0.0.1:8790`: HTTPS, because a PWA needs it, on its own port so anything on 443 is left alone.
- **Auth:** every `/api` call carries a bearer token (`HUB_TOKEN`). `HUB_LOGIN` can also let a Tailscale login in without the token, but tagged devices carry no `Tailscale-User-Login` header, so the token is the real auth.
- **Pairing:** `POST /api/pair` (authorized) mints a one-time code, kept in memory for 5 minutes. `POST /api/pair/claim` trades it for the token; it's the one call without auth, and a browser may make it only from the hub's own origin. `ostrakon pair` puts the code, not the token, in its QR.
- **Ops:** a systemd user unit, a daily SQLite backup (7 kept), and `GET /healthz` (answers `ok <version>`). No framework.

### 9.3 Phone form (PWA)
- **Header:** `✎ ostrakon` (the one `h1`), a search button, and while the hub can't be reached `hub offline · N queued` in the warning colour. While sync works it says nothing.
- **Capture first:** a card with the note field and a pill naming where the note goes (default `unfiled`). Focusing the field opens capture: the card takes an accent border, the header shows **Close** (the draft is kept, here and in `localStorage`), the list beneath dims and is out of reach (a tap on it, Escape, or Tab past the last control closes the form), and project chips wrap under the field: the last-used project first, then the hub's most recently active, three in all, and `N more` for the rest. A tap on a chip files the note there, a second tap goes back to unfiled; the hint under the chips says which (`unfiled · tap a project to file`). Save is off until there's text.
- **Project picker (`File under`):** a drawer with a search field, every project with its dot and open count (matches in bold), and `unfiled` under `always`, ticked and marked `the default` when it's the choice. Picking closes it and puts focus back in the note field; **Done** or the scrim closes it unchanged.
- **Saved:** the form closes, says `✓ saved · waiting to sync` (then `· synced` once the hub has it), the placeholder becomes `Another…`, and the pill shows where the note went; the next note starts unfiled again. The new row is tinted for a few seconds and says `now`.
- **Inbox below:** open notes grouped as the pane groups them: a heading per project (a dot in the colour `colourOf` gives it, the name, the count), projects by latest note, unfiled last (a ring for a dot), newest first within each. Each heading is an `h2` with a fold button (`aria-expanded`); it sticks while its group scrolls, and folds are kept on the phone (`▸` after a folded name).
- **Proposals:** Claude's `proposed` notes (harvest, §8) come first under `◆ Proposed by Claude`, each with `for ● <project> · <age>` and **Keep** (makes it open) and **Dismiss** (status `dismissed`), each with Undo.
- **Rows:** the pane's markers (`◆` from Claude, read as "From Claude"; `▪` from the phone), the text, the age (or `↑ queued`), and a `⋯` **Note actions** button. A tap on the text, or `⋯`, opens the action sheet; holding still about half a second marks the row, and the lift edits it (iOS brings the keyboard up only for a field focused in a touch's own event) in a panel over the list, as tall as the screen above the keyboard, with Cancel and Save at the top; a swipe left archives.
- **Action sheet:** the note quoted whole (a long one scrolls in its own space, so the actions stay in view) with its project, origin and age, then **Edit**, **Copy text**, **Move to project** (current project on the right; it turns to the sheet's second page, `Move to`, with the picker's search and list, and **Back**, Escape or a swipe right goes back), **Mark sent** (`used elsewhere; leaves open notes`) and **Archive**, then **Cancel**. A modal dialog: focus stays inside, Escape or a swipe down closes it (Escape on `Move to` goes back first), and focus goes back to the row's `⋯` (or the next row's when the note left the list). Move, Mark sent and Archive come with Undo in a toast (`Archived · <note>`).
- **Swipe:** the row follows the finger by transform, once a frame, over an `Archive` strip that turns solid while letting go would archive. Letting go archives only while the finger is still heading left past the threshold, or on a quick flick left (the numbers are in [DESIGN.md §7](DESIGN.md#7-motion)); a finger that turned back right, or a short slow drag, springs the row home. An archived row slides out, then its height closes up.
- **Search:** the header's search button swaps the header for a filter field (with a clear button) and **Cancel**. Open notes only, matching text or project name, marked in the text; `3 notes in 2 projects` in a live region; a folded group shows its matches and says `folded · showing matches`. With none: `No open notes match “…”` and `Archived and sent notes aren't searched.`
- **Empty:** a shard, `Nothing open`, `Your notes land here, sorted by project.`, the ways notes arrive (share, Siri, `//`, `◆`) and a link to the Shortcut setup.
- **Offline:** captures and changes queue in `localStorage` and flush when the hub is reachable; the field's placeholder says `A note… will sync when back online`. A note the hub refuses stays on the phone under `The hub wouldn't take N notes` with the hub's reason, `Only this phone has it.`, and **Edit**, **Retry** and **Discard local copy** (with Undo).
- **First run:** `Connect this phone` with the three pairing steps (`ostrakon pair`, scan, Add to Home Screen), a pairing error in a box when the code was refused, and `Paste a hub token instead` folded below. UI copy never names the transport.
- **Look:** tokens for dark and light (`prefers-color-scheme`), IBM Plex served from `public/fonts/`, sizes in `rem`, and the accessibility bar: [DESIGN.md §4 and §8](DESIGN.md#4-phone-tokens). Vanilla JS, no framework, no build.
- **Motion:** Motion (`public/vendor/motion.js`, MIT, pinned) moves the sheets, the editor and the picker, and springs the toast and the swipe; changing between list, capture and search is a View Transition where the browser has them (entering search fades in instead, so the field can take focus for the keyboard). With `prefers-reduced-motion` nothing moves: things appear at once or fade. What moves and how: [DESIGN.md §7](DESIGN.md#7-motion).
- **Add to Home Screen:** a manifest and an icon. iOS gives a Home Screen app storage apart from Safari's, so the token travels in the app's start URL (`docs/phone.md`). The service worker caches the shell, fonts and Motion, so the app opens offline.
- **Shortcut:** an iOS Shortcut can POST to `/api/jot` from the share sheet or Siri (`docs/phone.md`).
- Notes from the phone have `by: phone`.

### 9.4 Mod side
- Options `hubUrl` and `hubToken`; the folder adapter's is `mirrorDir` (§7.2).
- The hub adapter uses `$.http.fetch` with a long-poll `pull`. When the hub is unreachable the mod keeps working locally and the footer shows `hub offline · N queued` (or `hub refused the token · N queued`). While sync works the footer says nothing.
- **Hub runs:** every response names the hub's run (a random id per start). A client that sees it change drops its cursor and what it knew the hub held and does a full pull, so a restored or wiped hub gets every note back from the machines that have them.
- **Several sessions on one machine** each run the loop. Pushes and absorbs are idempotent (merge, per-note locks); the cost is N long polls and repeated identical pushes.

### 9.5 Outside Claude Code: `ostrakon jot`
- `ostrakon jot [--project <name>] <text>` (`server/jot.ts`, Bun) saves an `open` note of yours (`by: you`, `origin` this machine's hostname) into the notes folder the mod uses, found as the mod finds it: `OSTRAKON_DIR` from Claude Code's settings, else from the shell, else the `notesDir` option, else the default. It writes a temp file and renames it into place (§6.2); sessions here read it on their next poll.
- `--project` (`-p`) takes a project the notes in that folder already know, matched as Claude's `jot` matches (§8); an unknown or ambiguous name is refused with the known ones, and nothing is saved.
- When a hub is set (the mod's `hubUrl` and `hubToken`, or `OSTRAKON_HUB_URL` and `OSTRAKON_HUB_TOKEN`, read as a pair: if either is set, neither comes from the settings), it also posts the note to `POST /api/notes`, waiting at most 3 s. The sessions' own push of the same note later changes nothing (§6.3). A hub that can't be reached, refuses it or answers as something other than a hub is reported on stderr, with whether a session here will send it later (only when the mod has that hub); the note is still saved and the exit code is 0.
- `ostrakon jot --ask` (`bin/jot-ask`) asks for one line in the first prompt tool it finds (Omarchy's `omarchy-menu-input`, walker, fuzzel, rofi, wofi, zenity, or a macOS dialog, untested: #78), takes a leading `@name` as `--project name` (a lone `@name` is refused), and shows the answer as a notification; a refused note's text is in it, so it isn't lost.

---

## 10. Resting state: Pocket (band above the prompt)

```
✎ cc   ;1 check why the cache…   ;2 rename the store helpers   ;3 ◆ login returns…   +2
```
- **Opener:** `✎ <project>` leads the row, dim; it carries the borrowed `ctrl+x s` action and opens the launcher.
- **Chips:** up to `pocketMax` (default 5, max 9) open notes of the current project, newest `updated` first. Each chip is its key, `;` and its digit, in the accent, then a `plain` Button with no hotkey. The label is the note's text on one line, cut to 24 terminal cells with `…`, with `◆ ` in front for Claude's notes. The cut falls at the last word that fits, unless that leaves under 10 cells; then mid-word. Chips sit 3 columns apart.
- **`+N`** (dim) shows when more open notes exist than chips; it and the opener open the launcher. Opened by their chord the pane gets focus; opened by a click the band holds the keys, so the pane opens unfocused (`ctrl+x tab` then gives it them).
- **Width:** fit to `e.props.bodyColumns`, the opener included. First shorten every label, down to 10 columns, then drop chips from the right into `+N`. The opener and `+N` always stay.
- **While a turn runs** (`e.props.isWorking`) the whole row draws dim; the keys still work.
- **Fresh chip:** a note the person just saved (`/jot text`, the pane) stands out for a moment ([DESIGN.md §7](DESIGN.md#7-motion)): its chip at full strength, the other chips dim. A Button label takes no bold or colour.
- **Keys from an empty prompt:** type `;2`. Note 2 is filled into the prompt at once (prefixed per §4.5, after the stash if one is held, §4.4) and a toast says `note 2 in your prompt · ⏎ to send`. Submitting marks it `sent` (§5). A chip never opens the pane, and never closes one: the key is typed in the prompt and a chip press takes the keys (§2.2), so an open pane is beside the prompt (as after `ctrl+x tab` or Esc at the top, §4.4), kept there to write with the notes in view. The held draft is still spent. `t` from the pane still closes it. Only a typed digit right after a lone `;` counts: a lone digit, a pasted `;2` (or both keys arriving in one write, which the engine can't tell from a paste), `;` inside a draft, or a digit with no chip goes in as typed, so to send a prompt that starts with `;2`, paste it. The keys press the chips the terminal's band showed when the key was typed, even if it redraws before the key's turn comes.
- **Zero notes:** the opener alone, with the project's name whole up to 24 columns. `pocket: false` keeps only the opener.
- **Composition:** draw `await next(e)` first, inside a column Box, then the chip row.
- **Harvest** takes the chip row's place while the last turn has proposals:
  - One line: the opener, `◆ from this turn` in bold, the proposals as numbered chips, `+N`, then `;0 keep all`. `;n` keeps that proposal, `;0` keeps them all (those in `+N` too), and either empties the prompt. Too narrow for a chip beside the title, the title shortens to `◆`; too narrow for any chip, the row closes up to fit: one column apart, then `✎` without the project, then no `◆`. Under the first 3 harvests ever (counted in `$.store`, once per turn) a dim second line: `;1–;3 keep one · ;0 keep all · the rest wait in the pane under “proposed”`.
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
  server/                 ← hub (Bun), jot.ts (`ostrakon jot`) + public/ (phone PWA)
  docs/                   ← this file, DESIGN.md, phone.md
  tools/                  ← check.sh, screenshot pipeline, harnesses (see §12)
```
- A plugin may import its own files, but `import()` is not allowed.
- A `.claude-plugin/marketplace.json` at the repo root would make it installable with `/plugin install ostrakon --marketplace gaius-codius/ostrakon`.

**Built:** the storage core, the launcher pane, the Pocket band and `sent` tracking, the hub with the phone app and hub adapter, harvest, and the folder adapter. **Not built:** the git adapter and Notion.

## 12. Verification
- **Static checks:** `tools/check.sh` runs `claude plugin validate plugin/`, the type-check, `claude plugin test plugin/`, the hub's `bun test` and `tools/check-design.ts` (DESIGN.md against the code, §11 of it for the changelog rules). Type-checking needs `plugin/.claude-plugin/types/`, which the engine writes when it loads the mod.
- **Live:** drive a real session in tmux (`tmux new-session -d -s t -x 160 -y 42 'claude …'`, `send-keys`, `capture-pane -p`), with `--debug-file` to read `ui.open`, `ui.focus` and refusal lines.
- **Screenshots:** `tools/screens/lib.sh` (`start <fixture> <cols> <rows>`, `keys …`, `lit "text"`, `shot <name> "<caption>"`) renders `tmux capture-pane -e -N` to HTML (`ansi2html.py`) and then to PNG with headless `chromium`. Fixtures are `empty`, `few`, `long` and `many` (`fixture.py`); point a session at one with `OSTRAKON_DIR`. Wait about 2 s after opening before a shot.
- **States worth a screenshot:** search (empty, typing, no match), groups (folded, history), picked plus bundle, capture, edit, Pocket (0, 3, 9+ notes), the harvest band, a narrow terminal (100 columns, inline), and the light theme.
- **The load report** (`plugin/src/report.ts`): each session start writes `~/.cache/ostrakon/report.json` with the Claude Code version that loaded the mod (`$.session.version()`), and the problems its sessions hit afterwards (storage, sync, the jot tool, harvest reviews; a hub or mirror that refuses, such as a wrong token, but not one that is only out of reach, which stays in the footer): the 10 latest distinct ones, each counted, saved on the next poll after it happens. Concurrent sessions share the file, so it is the latest writer's view. `ostrakon doctor` (`bin/doctor`) reads it, since validation and the tests can't show that the mod actually runs in someone's Claude Code version.

## 13. Targets (keystrokes, from a closed pane)
How many keystrokes common flows should take, starting with the pane closed. N is the length of the note, Q of the search query, and R the moves to reach the row.

| Flow | Target |
|---|---|
| Capture mid-turn | N+3 (`// text ⏎`), and no loss of an existing draft |
| Send a same-project note | **3** (`;`, Pocket digit, ⏎) |
| Find and send a note from another project | **Q+4** (`ctrl+x s`, type, ⏎, `s`) |
| Edit a note | **R+5** (`ctrl+x s`, ⏎, R moves, `e`, ⏎), with explicit save/cancel and a kept draft |
| Capture to another project | **N+Q+6** (`ctrl+x s`, `ctrl+n`, `ctrl+s`, type, ⏎, the note, ⏎) |
| Bundle 3 hand-picked notes | **10** (`ctrl+x s`, ⏎, `v`, `j`, `v`, `j`, `v`, `b`, ⏎) |

Counting `ctrl+x s` as two keystrokes.
