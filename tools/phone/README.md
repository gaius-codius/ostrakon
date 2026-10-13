# Phone tests

The phone app (`server/public/`) in WebKit, the engine under iOS Safari, at iPhone 15 size with
touch. `run.sh` starts a test hub with its own data and token, adds a few notes, and runs
`sheet.test.mjs` against it:

- the note menu, opened from ⋯ and from a long press, and the File under drawer each rise from below
  and stop where they rest: the panel never shows in place first and then drops, never goes past
  its rest by more than a few pixels, and the dialog holding it never scrolls
  ([DESIGN.md §7](../../docs/DESIGN.md#7-motion)).
- Move to project turns to the menu's second page (no second dialog), sliding one way only with
  nothing in the sheet scrolling; Back, Escape and a swipe right go back, a short slow swipe
  doesn't; picking a project moves the note and closes the menu.
- the menu shows again, fully, after Move to has been up.
- the page behind the menu doesn't scroll (desktop WebKit at iPhone size, since mobile
  WebKit can't be scrolled from a test).

```sh
tools/phone/run.sh                           # all of them
tools/phone/run.sh --test-name-pattern=picker
PHONE_DEBUG=1 tools/phone/run.sh             # print each panel's top, frame by frame
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
