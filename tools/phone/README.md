# Phone tests

The phone app (`server/public/`) in WebKit, the engine under iOS Safari, at iPhone 15 size with
touch. `run.sh` starts a test hub (`hub.ts`: the real hub with filing stubbed) with its own data and
token, adds a few notes, and runs `sheet.test.mjs` against it:

- the note menu, opened from ⋯ and from a tap on the note, and the File under drawer each rise from below
  and stop where they rest: the panel never shows in place first and then drops, never goes past
  its rest by more than a few pixels, and the dialog holding it never scrolls
  ([DESIGN.md §7](../../docs/DESIGN.md#7-motion)).
- Move to project turns to the menu's second page (no second dialog), sliding one way only with
  nothing in the sheet scrolling; Back, Escape and a swipe right go back, a short slow swipe
  doesn't; picking a project moves the note and closes the menu.
- holding a note edits it on the lift, without opening the menu; the menu shows a long note whole,
  scrolling, with every action in view.
- the menu shows again, fully, after Move to has been up.
- a swipe down closes the menu, from the actions or Move to, and a short slow one settles back.
- the editor rises from a hold or Edit (its field focused in that same tap), fills the screen
  above the keyboard with the page under it still, and Cancel, Escape and Save do what they say (a stand-in
  visualViewport plays the keyboard, since Playwright's WebKit has none).
- the page behind the menu doesn't scroll (desktop WebKit at iPhone size, since mobile
  WebKit can't be scrolled from a test).
- File as issue shows only on a note under a repo the hub files to; it puts a request under
  Drafts, whose draft shows the repo, `public` or `private`, title, labels and body, and File files
  it (it leaves Drafts and the note leaves the inbox).
- New draft drafts again; Discard drops the request and keeps the note.
- a filing with no clear answer shows `Couldn't tell if it was filed. Check GitHub.` and a link to
  the repo's issues; Not filed files it again, and It's there refuses a URL in another repo under
  the field, then files it with the right one. Discard there, below `Discard stops the hub
  checking. The issue may still exist.`, drops the request and keeps the note.
- a request waiting to file behind a slow filing can be discarded, and the hub never files it.
- a draft that fails shows the reason, with Retry and Discard.
- under a repo the hub couldn't check (an `error` from `/api/filing`), File as issue is off with
  `hub couldn't check this repo`, and is on once the hub lists the repo; after an unanswered ask,
  the next menu asks again.
- while the hub can't be reached, File as issue and every Drafts button are off, and nothing is
  queued.
- screenshots of Drafts and of the menu with File as issue, light and dark, go to `$SCREENS_DIR`
  (default `/tmp/ostrakon-phone-screens`).

```sh
tools/phone/run.sh                           # all of them
tools/phone/run.sh --test-name-pattern=picker
PHONE_DEBUG=1 tools/phone/run.sh             # print each panel's top, frame by frame
SCREENS_DIR=~/screens tools/phone/run.sh     # where the screenshots go
```

WebKit's Linux build wants Ubuntu's libraries, so where `docker` is, the tests run in Playwright's
image (`mcr.microsoft.com/playwright:v1.64.0-noble`, pulled on first use). On Ubuntu you can run
WebKit directly instead:

```sh
(cd tools/phone && bun install && bunx playwright-core install --with-deps webkit)
PHONE_IN=host tools/phone/run.sh
```

`playwright-core` in `package.json` and the image's tag are the same version; bump them together.
Desktop WebKit isn't iOS: it catches layout, focus and scrolling bugs like these, but try anything
that moves on a real iPhone too.
