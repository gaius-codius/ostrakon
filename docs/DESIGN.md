# Ostrakon design system

Version: 5.0.0

What the terminal mod (the pane, the band and the prompt hint, in `plugin/`) and the phone (`server/public/`) must agree on: colour roles, the project palette, the phone's tokens, symbols, fixed copy, motion and the accessibility bar. [`SPEC.md`](SPEC.md) describes behaviour and points here for these values instead of repeating them. The code holds the values: `plugin/src/ui/look.ts` for the terminal, `style.css`, `app.js` and `index.html` for the phone.

To change the design, change the code and this file in the same commit, bump `Version:`, and add a changelog entry (§11) that says what changed and why. `tools/check.sh` and CI run `tools/check-design.ts`, which fails when a table marked `<!-- check: … -->` disagrees with the code, when the design values change without a new entry, or when an entry has no reason.

## 1. Principles

| Rule | Why |
|---|---|
| Quiet by default: no rules, no boxes but the one you're typing in, metadata dim. | Note text should be the brightest thing on screen. |
| Accent means act, now or yours: the current project, picks, `◆`, the primary button. | One colour that always means the same thing is easy to read. |
| Colour is never the only signal: a dot sits beside a name, a status has words. | Some people can't tell the colours apart, and 16-colour terminals have few. |
| Copy is plain, short and literal. | Short literal words are quick to read and promise nothing the app doesn't do. |
| A mark or word means the same on every surface. | People move between the terminal and the phone. |

## 2. Colour roles

Terminal colours are theme keys (they follow the person's theme), except project colours (§3). The phone has its own tokens (§4).

<!-- check: roles -->
| Role | Terminal key | Phone token | Use | Why |
|---|---|---|---|---|
| `accent` | `claude` | `--accent`, `--accent-text` | current project, row numbers, the band's keys, picks, `◆`, search hits, the capture frame, Save | the one colour for act, now or yours |
| `band` | `subtle` | `--raised` | the selected row's background | marks the row without a rule |
| `unfiled` | `inactive` | `--dim` | the unfiled ring | grey: no project, nothing to say |
| `history` | `inactive` | — | sent and archived rows, unpicked marks | done, so out of the way |
| `saved` | `success` | `--success-text`, `--fresh` | `✓ saved`, the just-saved row | the one positive state |
| `problem` | `error` | `--error`, `--error-text`, `--error-wash` | unreadable files, refused notes | kept for real problems |
| `offline` | `warning` | `--warn` | `hub offline · N queued` | needs attention, nothing lost |

**Reserved:** the engine draws a plain Button's hotkey digit in the theme's `suggestion` key. Nothing of ours uses `suggestion`, so a project never looks like a hotkey. The checker fails if `look.ts` uses it.

## 3. Project palette

Each project other than the current one gets a colour from a hash of its key, drawn on a dot before its name, never on the name (the name is dim in the pane; on the phone it's a heading, in the text colour). The current project is the accent, in the pane only (the phone has no current project). Unfiled is a grey ring (`○`).

**Hash:** `hash = (hash * 31 + charCode) >>> 0` over the project key's characters, from 0; the colour is `palette[hash % 8]`. `colourOf` in `look.ts` and in `app.js` must stay the same function.

<!-- check: palette -->
| Name | Dark | Light | On dark bg | On light bg |
|---|---|---|---|---|
| teal | `#4cc2b4` | `#00756d` | 8.5:1 | 5.1:1 |
| sky | `#5aaeeb` | `#1565a8` | 7.6:1 | 5.6:1 |
| violet | `#b08cf5` | `#6f3fd1` | 6.9:1 | 5.8:1 |
| magenta | `#de7fe0` | `#9b2ea6` | 7.2:1 | 5.8:1 |
| pink | `#f283ac` | `#b52f68` | 7.6:1 | 5.4:1 |
| gold | `#e0bf4c` | `#7f6400` | 10.3:1 | 5.2:1 |
| lime | `#a9cc55` | `#4f7410` | 10.0:1 | 5.0:1 |
| sand | `#cfae86` | `#7e5e38` | 8.8:1 | 5.4:1 |

Contrast is against the phone's `--bg` (`#141416`, `#f6f5f2`); the checker recomputes it and fails under 4.5:1. Order matters: it is the hash's.

**Why fixed hex:** theme keys gave four distinct colours at most (`merged` and `autoAccept` are the same colour in every built-in theme), `suggestion` is the hotkey digit's colour, `warning` reads as an alarm, and the phone could only copy one theme's values. Fixed values look the same on both surfaces.

**Which value the terminal draws:**

| Theme (`/config` `theme`) | Draws |
|---|---|
| `dark`, `dark-daltonized` | the dark values |
| `light`, `light-daltonized` | the light values |
| `custom:<name>` | by the `base` in `~/.claude/themes/<name>.json` (`$CLAUDE_CONFIG_DIR` if set); dark if unreadable |
| `auto` | `COLORFGBG`'s background index: 7 or 9–15 light, anything else (or unset) dark |
| `dark-ansi`, `light-ansi` | theme keys instead, below |
| anything else | the dark values |

A 16-colour theme can't draw hex, so projects take these theme keys, by the same hash modulo 4:

<!-- check: ansi -->
| # | Theme key |
|---|---|
| 1 | `success` |
| 2 | `merged` |
| 3 | `planMode` |
| 4 | `warning` |

## 4. Phone tokens

Light is `:root`, dark is `@media (prefers-color-scheme: dark)`. `—` means dark keeps the light value. The project colours (§3) are tokens too, named after the palette.

<!-- check: tokens -->
| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f6f5f2` | `#141416` | page, rows |
| `--surface` | `#ffffff` | `#1d1d21` | the form, sheets, drawers, fields |
| `--raised` | `#efede8` | `#2a2a30` | pill, picked chip, pressed rows, code |
| `--line` | `#e2e0da` | `#2c2c33` | hairlines, chip borders |
| `--line-strong` | `#cfccc4` | `#3a3a42` | field borders, the grabber |
| `--text` | `#1d1d1f` | `#ececf0` | text; the toast's background |
| `--text-soft` | `#3c3c40` | `#c4c4cc` | secondary text |
| `--dim` | `#64646a` | `#9a9aa4` | ages, hints, headings, icons |
| `--faint` | `#6f6d68` | `#86868f` | counts, `⋯`, the pane's quote bars |
| `--deco` | `#b8b6b0` | `#5a5a62` | the `▪` marker (decoration, not text) |
| `--accent` | `#b5532f` | `#d97757` | Save, focus rings, Keep, the capture border |
| `--accent-text` | `#a84a28` | `#e8957a` | accent words on a surface (Archive in the sheet) |
| `--on-accent` | `#ffffff` | `#141416` | text on the accent |
| `--success-text` | `#276e33` | `#4eba65` | `✓ saved`, search marks |
| `--warn` | `#a15c00` | `#e0a243` | hub offline, queued |
| `--error` | `#c0362c` | `#ef6b5f` | refused notes, storage problems |
| `--error-text` | `#a32a20` | `#f3a097` | error words |
| `--accent-inverse` | `#e8957a` | `#a84a28` | Undo on the toast |
| `--dim-inverse` | `#b0b0b8` | `#55555c` | the toast's detail |
| `--fresh` | `rgba(44, 122, 57, 0.1)` | `rgba(78, 186, 101, 0.1)` | the just-saved row, search marks |
| `--error-wash` | `rgba(192, 54, 44, 0.08)` | `rgba(239, 107, 95, 0.12)` | the pairing error box |
| `--scrim` | `rgba(6, 6, 8, 0.45)` | `rgba(6, 6, 8, 0.62)` | behind sheets and drawers |
| `--inactive` | `rgb(102, 102, 102)` | `rgb(153, 153, 153)` | a dot with no project colour |

**Type.** IBM Plex Sans and Mono, served from `server/public/fonts/` (latin subsets, OFL) and cached by the service worker, so the app looks the same offline. Sizes are in `rem` from a 100% root (`-apple-system-body` on iOS for Dynamic Type), so text settings scale the page. Body is 1rem at line-height 1.45; metadata, counts and hints are Mono at 0.75rem. A project heading on the phone is 0.9375rem semibold in the text colour, its dot 0.625rem, with more space above it than between notes: it stands out by weight and contrast, so the notes stay the largest text.

<!-- check: tokens -->
| Token | Light | Dark | Use |
|---|---|---|---|
| `--sans` | `"IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif` | — | everything but metadata |
| `--mono` | `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace` | — | ages, counts, hints, status, code |

**Spacing and shape** (as used; `style.css` is the reference): page gutter 1.25rem (or the safe area), content at most 40rem wide; rows pad 0.5rem by 1.25rem and bleed to the edges; gaps step through 0.375, 0.5, 0.625, 0.75, 0.875 and 1.125rem, and 1.5rem between projects. Radii: 0.375rem focus rings and code, 0.75rem buttons and fields, 1rem the toast, 1.125rem the form and sheet groups, 1.375rem pills, chips and the drawer's top. **Targets are 44px** (2.75rem) at the least, in both directions.

**Contrast.** Text on its background, recomputed by the checker from the tokens; anything under 4.5:1 fails.

<!-- check: contrast -->
| Text | On | Light | Dark | Where |
|---|---|---|---|---|
| `--text` | `--bg` | 15.4:1 | 15.6:1 | note text |
| `--text` | `--surface` | 16.8:1 | 14.3:1 | the form, sheets, drawers |
| `--text-soft` | `--bg` | 10.1:1 | 10.6:1 | the empty page's ways in |
| `--dim` | `--bg` | 5.4:1 | 6.6:1 | ages, headings, hints |
| `--dim` | `--surface` | 5.9:1 | 6.0:1 | sheet subtitles and meta |
| `--dim` | `--raised` | 5.0:1 | 5.1:1 | the pill, the picker's search |
| `--faint` | `--bg` | 4.7:1 | 5.1:1 | counts, `folded` |
| `--faint` | `--surface` | 5.2:1 | 4.7:1 | counts in the picker |
| `--accent` | `--bg` | 4.5:1 | 5.9:1 | the mark, Keep, the empty page's keys |
| `--accent-text` | `--surface` | 5.7:1 | 7.2:1 | Archive in the sheet |
| `--on-accent` | `--accent` | 4.9:1 | 5.9:1 | Save |
| `--success-text` | `--bg` | 5.7:1 | 7.5:1 | `✓ saved` |
| `--warn` | `--bg` | 4.8:1 | 8.3:1 | hub offline, queued |
| `--error` | `--bg` | 5.1:1 | 6.1:1 | a refused note's reason |
| `--error-text` | `--bg` | 6.6:1 | 9.0:1 | the hub wouldn't take it |
| `--bg` | `--text` | 15.4:1 | 15.6:1 | toast text |
| `--accent-inverse` | `--text` | 7.2:1 | 4.8:1 | toast Undo |
| `--dim-inverse` | `--text` | 7.8:1 | 6.3:1 | toast detail |

## 5. Symbols

The terminal column names `look.ts` `GLYPH` keys; the phone column names `app.js` `GLYPH` keys, or a file that draws the mark itself. Every key of both is listed.

<!-- check: symbols -->
| Glyph | Meaning | Terminal | Phone |
|---|---|---|---|
| `❯` | search field | `search` | — |
| `✎` | capture: the capture row, the band's opener | `capture` | — |
| `⇢` | bundle | `bundle` | — |
| `▌` | the selected row's bar | `bar` | — |
| `◆` | from Claude; Claude's proposals | `claude` | `claude`, index.html |
| `▪` | from the phone | `phone` | `phone` |
| `●` | picked | `picked` | — |
| `○` | not picked (once something is) | `unpicked` | — |
| `●` | a project's dot, in its colour | `dot` | — |
| `○` | unfiled | `unfiledDot` | — |
| `↗` | sent | `sent` | — |
| `·` | archived | `archived` | — |
| `·` | a row past 9, with no digit | `pastNine` | — |
| `▸` | group folded | `folded` | `folded` |
| `✓` | saved | `saved` | `saved` |
| `…` | text cut short | `more` | — |
| `⏎` | Enter | `enter` | — |
| `↵` | a newline in a one-line field | `newline` | — |
| `↑` | more rows above | `up` | — |
| `↑` | waiting to sync (`↑ queued`) | — | `queued` |
| `↓` | more rows below | `down` | — |
| `⚠` | storage problem | `problem` | — |
| `▎` | quoted text | `quote` | — |
| `›` | opens more (Move to project, the Shortcut link, a fold) | — | `next`, index.html, style.css |

The phone draws its dots and rings in CSS (`.dot`, `.dot.ring`), and `⋯` (Note actions), the sheet's action icons and the mark beside its name (from `brand/mark-small.svg`, in `--accent`) as SVG. `↑` is the one mark with two meanings; a word always stands beside it.

## 6. Copy

- Plain, short, literal. One plain sentence over two clever ones.
- Never name the transport (no "Tailscale"): people reach the hub in different ways.
- No reassurance and no lines about what the product remembers or does for you.
- Status fragments are lowercase and joined with ` · ` (`hub offline · 3 queued`, `✓ saved · waiting to sync`).
- Buttons say the action (Save, Keep, Archive, Mark sent); toasts say what happened (`Archived`, `Copied`).

Strings the surfaces or the docs depend on, each checked word for word in every file listed:

<!-- check: copy -->
| Text | Files | Use |
|---|---|---|
| `hub offline` | plugin/hooks/register.tsx, server/public/app.js, docs/SPEC.md | the status while the hub can't be reached |
| `queued` | plugin/hooks/register.tsx, server/public/app.js | changes not yet at the hub |
| `unfiled` | plugin/src/ui/pane.tsx, server/public/app.js, server/public/index.html | a note with no project |
| `◆ from Claude` | plugin/src/ui/look.ts, docs/SPEC.md | the pane's legend while a `◆` row shows |
| `From Claude` | server/public/app.js | what the phone's `◆` reads as |
| `Proposed by Claude` | server/public/app.js, docs/SPEC.md | the phone's heading for proposals |
| `keep all` | plugin/src/ui/look.ts | the harvest band's `;0 keep all` |
| `saves to` | plugin/src/ui/look.ts, docs/SPEC.md | the hint tail while a `/jot` draft is typed, and capture's line: `⏎ saves to <project>` |
| `saved to` | plugin/src/ui/look.ts, docs/SPEC.md | the hint tail after a save: `✓ saved to <project>` |
| `esc back` | plugin/src/ui/look.ts, docs/SPEC.md | the edit card's back button: `[ esc back ]`, the draft kept |
| `all projects` | plugin/src/model.ts, docs/SPEC.md | the footer's `ctrl+s` in this project's scope |
| `this project` | plugin/src/model.ts, plugin/src/ui/pane.tsx, docs/SPEC.md | the footer's `ctrl+s` in scope all, and the search row's scope |
| `symbols` | plugin/src/ui/look.ts, docs/SPEC.md | the key sheet's heading over the row markers |
| `Archived · u undo` | plugin/src/ui/look.ts, docs/SPEC.md | the pane's archive toast |
| `Please look at these notes from my ostrakon:` | plugin/src/ui/look.ts, docs/SPEC.md | the bundle's first line |
| `· waiting to sync` | server/public/app.js | after Save, until the hub has the note |
| `· synced` | server/public/app.js | once it has |
| `· the hub wouldn't take it` | server/public/app.js | the hub refused the note just saved |
| `A note… will sync when back online` | server/public/app.js, docs/SPEC.md | the field's placeholder offline |
| `Another…` | server/public/app.js, docs/SPEC.md | the field's placeholder after a save |
| `unfiled · tap a project to file` | server/public/app.js, docs/SPEC.md | the hint under the chips |
| `Mark sent` | server/public/app.js, docs/SPEC.md | the sheet action |
| `used elsewhere; leaves open notes` | server/public/app.js, docs/SPEC.md | its subtitle |
| `folded · showing matches` | server/public/app.js, docs/SPEC.md | a folded group during a search |
| `Only this phone has it.` | server/public/app.js, docs/SPEC.md | under a refused note |
| `Nothing open` | server/public/index.html, docs/SPEC.md | the empty inbox |
| `Your notes land here, sorted by project.` | server/public/index.html, docs/SPEC.md | under it |
| `Connect this phone` | server/public/index.html, docs/SPEC.md | first run |
| `Notes sync through your ostrakon hub.` | server/public/index.html | under it |
| `Paste a hub token instead` | server/public/index.html, docs/SPEC.md | the folded token form |
| `Archived and sent notes aren't searched.` | server/public/index.html, docs/SPEC.md | a search with no match |
| `File under` | server/public/index.html, docs/SPEC.md | the project picker's title |

## 7. Motion

Things that move: the phone's swipe, sheets, drawers and the editor (rise over a fading scrim), the toast, and the change between list, capture and search (a View Transition where the browser has `document.startViewTransition`; entering search fades instead, so the field can take focus for the keyboard). Nothing else moves; the terminal never animates.

- **Swipe to archive:** the row follows the finger by `transform` only, once a frame. Letting go archives only while the finger is still heading left past the threshold, or on a quick flick left; a finger that turned back right, or a short slow drag, springs the row home. An archived row slides out, then its height closes up, then Undo shows. Why: under the first rule, a row dragged past the threshold archived even after the finger turned back, so changing your mind still archived.
- **Sheets and drawers rise from below and stop:** the panel starts below the screen before the first frame (set in the page, since Motion applies its first keyframe a frame late) and never goes above where it rests. The dialog that holds it is `overflow: clip`, never `hidden`: a hidden overflow can still be scrolled, and iOS scrolls it to show the focused action while the panel is still below the screen, so the panel rode up the screen and then snapped back. Since a clipped dialog isn't a scroll container, a scroll on the scrim would reach the page, so the page doesn't scroll while one is open (`html:has(dialog[open])`). `tools/phone/run.sh` checks both in WebKit.
- **Pages of a sheet:** Move to project is the action sheet's second page, not a second dialog: it slides in from the right over the actions (which slide a little left and fade), and the sheet's height follows, in `RISE_S`. **Back**, Escape or a swipe right goes back; the page follows the finger, and letting go past `BACK_PX`, or on a flick right, goes back, otherwise it slides home. Positions are in px throughout, each move starting from where the page is, so a turn picks up from a finger without a jump.
- **Swipe down to close:** a sheet follows the finger down as its scrim fades, and letting go past `DISMISS_PX`, or on a flick down, closes it; otherwise it settles back. It starts anywhere on the sheet but a list that scrolls (Move to's projects, the actions when they don't fit), where up and down are the list's. A swipe's lift is never a tap on what's under it.
- **The editor:** a note is edited in a panel over the list, rising and sinking as a sheet does, its height what the keyboard leaves of the screen (the visualViewport), with Cancel and Save at the top and a long note scrolling inside the field. iOS slides the view over the page for the keyboard rather than shrinking it, so a field in the list landed wherever iOS scrolled it, and scrolling it into place fought iOS: the screen jerked, or left a blank past the list. Sizing a panel to the view needs no scrolling.
- **Reduced motion** (`prefers-reduced-motion: reduce`): nothing moves; things appear and go at once, or fade. A swipe still archives, without the slide.
- Springs come from Motion, vendored unchanged in `server/public/vendor/motion.js` (MIT) and cached for offline use.

<!-- check: constants -->
| Constant | Value | Rule |
|---|---|---|
| `app.js ARCHIVE_PX` | 80 | heading left past this many px, letting go archives |
| `app.js FLICK_PX_PER_MS` | 0.5 | a flick left this fast (500 px/s) archives… |
| `app.js FLICK_MIN_PX` | 24 | …once it has moved this far |
| `app.js TURN_PX` | 4 | a move this far sets which way the finger is heading |
| `app.js VELOCITY_MS` | 100 | speed is measured over this many ms |
| `app.js HOLD_MS` | 550 | holding still this long marks the row, and the lift edits it |
| `app.js RISE_S` | 0.28 | a sheet or drawer rises in this long, on a steep ease-out |
| `app.js SINK_S` | 0.16 | and sinks in this long |
| `app.js BACK_PX` | 80 | swiping right this far on a sheet's second page goes back |
| `app.js DISMISS_PX` | 96 | swiping a sheet down this far closes it |
| `app.js FRESH_MS` | 3000 | the phone's just-saved row stays tinted |
| `look.ts MS.fresh` | 2000 | the band's just-saved chip stays at full strength, the rest dim |
| `look.ts MS.saved` | 3000 | the hint tail `✓ saved to <project>` stays up |
| `motion.js version` | 13.1.1 | the vendored Motion |

## 8. Accessibility

| Rule | Why |
|---|---|
| Text at 4.5:1 or better in both themes (§3, §4, checked) | readable in sunlight and with low vision |
| Targets 44×44px at the least | thumbs |
| Every gesture has a button and a keyboard path: swipe = Archive in the sheet, hold = Edit in the sheet, tap = `⋯` | not everyone can swipe or hold |
| Sheets and drawers are modal: focus stays inside, Escape closes, focus goes back to where it came from | keyboard and screen reader users don't get lost |
| Save, sync and search results are announced (`role="status"`, live regions) | the screen changes without focus moving |
| At 200% text, nothing scrolls sideways at 390px wide | large text is a setting people use |
| axe finds nothing on each screen | catches what review misses |
| Terminal: colour is never the only signal; names stand beside dots, statuses are words | 16-colour themes and colour blindness |

## 9. Terminal constraints

| Constraint | Rule |
|---|---|
| Theme keys or hex | Roles are theme keys, so every theme works. Only project colours are hex (§3), with theme keys on `*-ansi` themes. |
| What the engine draws | A plain Button's chrome and its hotkey digit (in `suggestion`), the band separator, the hint line's own text. A Button label takes no bold or colour, so the fresh chip stands out by dimming the others. The band's Buttons take no hotkey (the engine would press one on a lone digit typed into the prompt); each chip's `;n` key is our own Text before it. |
| Width | Draw to `bodyColumns - 1`. Band chips shorten (to `WIDTH.chipMin`) before they drop into `+N`; the opener and `+N` stay. |
| Narrow empty pane | The shard goes first when the descriptions would be cut beside it. |
| Narrow harvest row | Title shortens to `◆`; then, with no room for a chip: one column apart, then `✎` without the project, then no `◆`. |
| Short pane | The docked preview drops when the body can't hold it and three rows besides (under 15 rows); the key sheet drops its frame when no line fits inside it. Docked, what sits between the search row and the footer is cut at the rows left there, so the footer keeps the last row. |

<!-- check: constants -->
| Constant | Value | Rule |
|---|---|---|
| `look.ts WIDTH.chip` | 24 | a Pocket chip's label, at most, in cells |
| `look.ts WIDTH.chipMin` | 10 | labels shorten to this before chips drop |
| `look.ts WIDTH.keySheet` | 46 | the key sheet's width, at most |
| `look.ts WIDTH.previewLines` | 6 | preview text lines |
| `look.ts WIDTH.footerPairs` | 4 | key pairs in the footer kept ahead of the legend; more show when the width allows |
| `look.ts TEXT.harvestHintTimes` | 3 | harvests that show the hint line |

## 10. Not covered

Keys, layout and behaviour are in [`SPEC.md`](SPEC.md). The terminal's spacing is in `look.ts` `WIDTH` and the renders (`tools/screens`); the phone's in `style.css`.

## 11. Changelog

Newest first. Each entry is a heading `### <version> — <YYYY-MM-DD>`, then one or more `- Change:` lines and one or more `- Why:` lines. The newest entry ends with `Fingerprint: <hash>` of the design values in the code (`bun tools/check-design.ts --fingerprint` prints it). Versions: major when a meaning changes or something goes (a glyph means something else, a colour role moves); minor when something is added; patch for a value tweak or a doc fix. Entries are never removed.

### 5.0.0 — 2026-10-24
- Change: The edit card's back button reads `[ esc back ]` (was `[ esc cancel ]`).
- Change: The footer's `ctrl+s` names where it goes, `all projects` or `this project`, in place of `scope`.
- Change: With nothing open in this project but some history, the list shows the project's header with `0` in place of the empty inbox, and the footer leads with `↓ history`.
- Change: The key sheet ends with the row markers under `symbols`, and lists `g` (top, again bottom).
- Why: The button keeps the draft, which "cancel" didn't say. `scope` didn't say that it's the way to every project's notes. History was out of reach from the empty inbox, and the footer's `◆ from Claude` was the only legend for the row markers.
Fingerprint: 58295af87f4e

### 4.0.0 — 2026-10-22
- Change: The footer shows as many key pairs as the width takes, not four at most: on a row, `m move` and `y copy` follow the note's own four, then `v pick`, `z fold` and `h history`. The legend stays ahead of the pairs past the first four.
- Change: Docked, what sits between the search row and the footer is cut at the rows left there, so a short body keeps the footer on its last row in every state.
- Why: A wide pane left most of the footer empty while the keys it could show were only in the key sheet. In a short body the empty block, a long query or capture's saves pushed the footer off the body.
Fingerprint: da3fa407fa5f

### 3.0.0 — 2026-10-22
- Change: The `/jot` hint tail reads `✎ ⏎ saves to cc`; `Claude won't see it` is gone. Capture's line reads `⏎ saves to cc` (was `Notes save to cc. Keep typing for the next one.`), and the bundle view drops `The picked notes are marked sent once the prompt goes in. Nothing is removed before.`
- Why: Claude does see a `/jot`: the engine keeps the command in the transcript, and QA had Claude quote one back. The other two lines explained what the product does, which §6 rules out; the footer already has the keys.
Fingerprint: da3fa407fa5f

### 2.0.0 — 2026-10-21
- Change: The band's chips read `;1 label` instead of `1: label`, and keep all reads `;0 keep all`: the key is a `;` and the digit, drawn by us in the accent (as the pane's row numbers), and the chip's Button takes no hotkey. The harvest hint reads `;1–;3 keep one · ;0 keep all · …`.
- Why: A lone digit typed into an empty prompt pressed the band's chip of that number, so answering one of Claude's numbered questions with `2` pulled a note into the prompt or kept a proposal instead.
Fingerprint: ad50d4f26e1b

### 1.0.1 — 2026-10-13
- Change: Sheets and drawers start below the screen before their first frame, and their dialog clips its overflow instead of hiding it (§7).
- Why: Opening the note menu showed it in place for a frame, then it dropped and rose; and on iOS the dialog scrolled to show the focused action, so the menu rode up the screen and snapped back.
- Change: Sheets and drawers rise in 0.28s on a steep ease-out that ends on time (was a 0.32s spring with a small bounce, which took about 0.35s to settle) and sink in 0.16s; Move to project became the sheet's second page, with Back, Escape and a swipe right to go back, instead of the project picker as a second dialog; a swipe down closes a sheet; a note is edited in a panel sized to the screen above the keyboard, not in the list; a tap on a note opens its sheet, which shows the note whole, and holding a note edits it; the phone quotes a note without the pane's `▎` bar; a project heading on the phone is 0.9375rem semibold in the text colour (was 0.8125rem, dim), with a larger dot, more space above it, and a hairline under it while it's stuck to the top.
- Why: Opening the menu felt slow, and going from the menu to the picker sank one dialog and raised another for what is one step, with no way back to the actions. Sheets had no swipe down to close, which iOS sheets have, and a note edited in the list landed wherever iOS scrolled it, often half under the keyboard; scrolling it into place fought iOS's own scroll. A tap edited, so a note longer than the row's four lines (or the sheet's three) could only be read whole by editing it, with the keyboard over half of it. The `▎` bar sets quoted text apart in a terminal, which can't draw boxes; on the phone the quote already has its own section. Project headings were the faintest text on the screen, so they read as labels rather than as the sections the notes sit in.
Fingerprint: ad50d4f26e1b

### 1.0.0 — 2026-10-11
- Change: First version of this file, recording the look after the quiet terminal redesign and the phone redesign, with `tools/check-design.ts` holding it to the code in `tools/check.sh` and CI.
- Why: The pane, the band and the phone are written in separate files and languages, and they had already drifted: the pane hashed projects over five theme keys and the phone over six, so a project could take a different colour on each.
- Change: Quiet terminal: no rules (a blank row instead), project dots before dim names, groups indented under their header, a one-line footer of at most four key pairs, one framed element (capture), the band's opener chip, chips cut at a word, a one-line harvest row.
- Why: Note text should be the brightest thing on screen; rules, coloured names and a two-line footer competed with it.
- Change: Project colours became a fixed palette of eight, each a dark and a light value at 4.5:1 or better, chosen by the person's theme and shared with the phone; `*-ansi` themes take four theme keys instead.
- Why: Theme keys gave four distinct colours at most, since `merged` and `autoAccept` are one colour in every built-in theme; `suggestion` is the colour the engine draws hotkey digits in; `warning` read as an alarm; and the phone could only copy one theme's values.
- Change: Plain copy rules (§6).
- Why: Early phone copy such as "Pair once; the phone remembers" and "Notes from anywhere land here" read as written by an AI, and "over Tailscale" named one way to reach the hub when people use several.
- Change: The phone takes its own light and dark tokens, and IBM Plex Sans and Mono served from the hub, sized in rem.
- Why: Fonts from the hub, cached with the app, look the same offline; rem lets text settings and Dynamic Type scale the page.
- Change: Swipe archives only while still heading left past 80px, or on a flick; otherwise the row springs home.
- Why: Under the old rule, letting go anywhere past 80px archived, even after the finger turned back, so changing your mind still archived.
- Change: The accessibility bar (§8): 44px targets, a button for every gesture, modal sheets, live regions, 200% text at 390px, axe clean.
- Why: The phone is used one-handed and with large text, and a gesture-only action shuts out anyone who can't make it.

### 0.1.0 — 2026-10-11
- Change: The look as first released (ostrakon v0.1.0): theme keys only, project colours from six theme keys hashed from the project key, heavy and light rules between parts, and the phone on system fonts with its own small token set.
- Why: Theme keys follow every theme with no hex to keep in step, which was enough until the pane and the phone had to agree.
