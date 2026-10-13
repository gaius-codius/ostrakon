// The phone app's sheets in WebKit at iPhone size: the note menu (⋯ or a long press) and the
// project picker rise from below and stop where they settle, never above it, and their dialog never
// scrolls. Run through tools/phone/run.sh, which starts a test hub and hands its address over.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'

import { devices, webkit } from 'playwright-core'

const HUB = process.env.PHONE_HUB
const TOKEN = process.env.PHONE_TOKEN
if (!HUB || !TOKEN) throw new Error('run this through tools/phone/run.sh')

const note = (id, text, name) => ({
  id,
  status: 'open',
  by: 'you',
  created: '2026-10-10T01:00:00.000Z',
  updated: '2026-10-10T01:00:00.000Z',
  origin: 'office',
  project: { key: `github.com/me/${name}`, name, path: `/home/me/${name}` },
  context: {},
  sentAt: null,
  deleted: false,
  text,
  extra: [],
})

let browser
let page

before(async () => {
  const notes = [
    note('01JA7K2M3Q9X4ZB6C8D0EFGH0A', 'Check the retry on a refused push', 'ostrakon'),
    note('01JA7K2M3Q9X4ZB6C8D0EFGH0B', 'Ask about the release date', 'ostrakon'),
    note('01JA7K2M3Q9X4ZB6C8D0EFGH0C', 'Rename the band setting', 'pane'),
    // A long one, older than the rest so its group comes last.
    {
      ...note('01JA7K2M3Q9X4ZB6C8D0EFGH0D', Array.from({ length: 40 }, (_, at) => `Line ${at + 1} of a long note.`).join('\n'), 'long'),
      updated: '2026-10-09T01:00:00.000Z',
    },
    // Enough more for the page to scroll behind a sheet.
    ...Array.from({ length: 30 }, (_, at) => note(`01JA7K2M3Q9X4ZB6C8D0EFGH${String(10 + at)}`, `Older note ${at + 1}`, 'later')),
  ]
  const pushed = await fetch(`${HUB}/api/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ notes }),
  })
  assert.equal(pushed.status, 200, await pushed.text())
  browser = await webkit.launch()
  page = await pageWith(devices['iPhone 15'])
})

// A page signed in to the test hub, in a browser context made with `options`.
const pageWith = async options => {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' })
  await context.addInitScript(token => localStorage.setItem('sp.token', JSON.stringify(token)), TOKEN)
  return context.newPage()
}

// A fresh page for each test: one that fails with a sheet still up leaves nothing behind.
beforeEach(async () => {
  await page.goto(HUB)
  await page.locator('li.note').first().waitFor()
})

after(() => browser?.close())

// Leeway for rounding and an ease that lands a pixel or so off before it ends.
const SLACK_PX = 2
// Frames watched from the one the dialog opens on: a second at 60 frames a second, which the rise
// (RISE_S in app.js) is well inside.
const FRAMES = 60

// Watches `dialog` every frame from when it opens: its scroll offset and its panel's top. The
// panel rises from below and comes to rest: it never shows in place first and then drops, never
// goes past its rest, and the dialog itself never scrolls.
const watchRise = async (dialog, open) => {
  await page.evaluate(
    ([selector, count]) => {
      const box = document.querySelector(selector)
      const panel = box.querySelector('.panel')
      window.frames_ = []
      const sample = () => {
        if (box.open)
          window.frames_.push({
            scroll: box.scrollTop,
            top: Math.round(panel.getBoundingClientRect().top),
            opacity: Number(getComputedStyle(panel).opacity) * Number(getComputedStyle(box).opacity),
          })
        if (window.frames_.length < count) requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    },
    [dialog, FRAMES],
  )
  await open()
  await page.waitForFunction(count => window.frames_.length >= count, FRAMES)
  const frames = await page.evaluate(() => window.frames_)
  const tops = frames.map(frame => frame.top).join(' ')
  if (process.env.PHONE_DEBUG) console.log(dialog, tops)
  const rest = frames.at(-1).top
  assert.ok(rest > 0 && rest < page.viewportSize().height, `${dialog}'s panel came to rest off screen, at ${rest}px`)
  assert.equal(frames.at(-1).opacity, 1, `${dialog}'s panel came to rest see-through`)
  assert.deepEqual(
    frames.filter(frame => frame.scroll !== 0),
    [],
    `${dialog} scrolled while opening`,
  )
  const drops = frames.slice(1).filter((frame, at) => frame.top > frames[at].top + SLACK_PX)
  assert.deepEqual(drops, [], `${dialog}'s panel moved down while rising; its top each frame: ${tops}`)
  const past = frames.filter(frame => frame.top < rest - SLACK_PX)
  assert.deepEqual(past, [], `${dialog}'s panel went above where it came to rest (${rest}px); its top each frame: ${tops}`)
}

test('the menu rises into place from ⋯', async () => {
  await watchRise('#sheet', () => page.locator('li.note .more').first().tap())
})

test('the menu rises into place from a tap on a note', async () => {
  await watchRise('#sheet', () => page.locator('li.note .text').nth(1).tap())
})

const editorOpen = (on = page) => on.waitForFunction(() => document.getElementById('editor').open)
const editorShut = (on = page) => on.waitForFunction(() => !document.getElementById('editor').open)

// Holds a finger on `target` past HOLD_MS (app.js), then lifts it.
const hold = async (on, target) => {
  const box = await target.boundingBox()
  await on.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
  await on.mouse.down()
  await on.locator('li.note.held').waitFor()
  await on.waitForTimeout(100)
  await on.mouse.up()
}

test('holding a note edits it, once lifted', async () => {
  const row = page.locator('li.note').nth(1)
  const box = await row.locator('.text').boundingBox()
  await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
  await page.mouse.down()
  await page.locator('li.note.held').waitFor()
  assert.equal(await page.evaluate(() => document.getElementById('sheet').open), false, 'holding opened the menu')
  await page.mouse.up()
  await editorOpen()
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'editor-text', "the field doesn't have focus")
  assert.equal(await page.evaluate(() => document.getElementById('sheet').open), false, 'the lift opened the menu')
})

test('the menu shows a long note whole, scrolling, with every action in view', async () => {
  const row = page.locator('li.note[data-id="01JA7K2M3Q9X4ZB6C8D0EFGH0D"]')
  await row.scrollIntoViewIfNeeded()
  await row.locator('.more').tap()
  await sheetOpen()
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => document.querySelector('#sheet .quote').classList.contains('scrolls')), true, "the long note doesn't scroll")
  // Scrolled to its end, the last line shows: nothing is cut off.
  const shown = await page.evaluate(() => {
    const quote = document.querySelector('#sheet .quote')
    quote.scrollTop = quote.scrollHeight
    const text = document.getElementById('sheet-text').getBoundingClientRect()
    return text.bottom <= quote.getBoundingClientRect().bottom + 1
  })
  assert.equal(shown, true, "the long note's last line can't be scrolled into view")
  const { height } = page.viewportSize()
  for (const name of ['Edit', 'Archive']) {
    const box = await page.locator('#sheet-actions .action', { hasText: name }).boundingBox()
    assert.ok(box.y >= 0 && box.y + box.height <= height, `${name} is out of view, at ${Math.round(box.y)}px`)
  }
})

test('the File under drawer rises into place', async () => {
  // It opens from the capture form's "more" chip, shown only with more projects than fit as chips;
  // opened straight here instead.
  await watchRise('#picker', () => page.evaluate(() => openPicker({})))
})

const sheetOpen = () => page.waitForFunction(() => document.getElementById('sheet').open)
const sheetShut = () => page.waitForFunction(() => !document.getElementById('sheet').open)
// Which page of the sheet shows, once a turn has finished.
const pageShown = async () => {
  // Motion starts an animation a frame after it's asked for: give it that, then wait for none.
  await page.waitForTimeout(100)
  return page.waitForFunction(() => {
    const [actions, move] = ['sheet-actions', 'sheet-move'].map(id => document.getElementById(id))
    return actions.hidden !== move.hidden && document.getAnimations().length === 0 && (move.hidden ? 'actions' : 'move')
  })
}

// Watches the Move to page every frame while `turn` runs and for a moment after: its left edge,
// and the sheet's scroll offsets. It slides one way only (`way`: -1 left, coming in; 1 right,
// going back), and nothing in the sheet scrolls.
const watchTurn = async (turn, way) => {
  await page.evaluate(count => {
    const move = document.getElementById('sheet-move')
    const boxes = ['#sheet', '#sheet .panel', '#sheet .group', '#sheet .pages'].map(selector => document.querySelector(selector))
    window.frames_ = []
    const sample = () => {
      window.frames_.push({
        left: move.hidden ? null : Math.round(move.getBoundingClientRect().left),
        scroll: boxes.reduce((sum, box) => sum + box.scrollTop + box.scrollLeft, 0),
      })
      if (window.frames_.length < count) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }, FRAMES)
  await turn()
  await page.waitForFunction(count => window.frames_.length >= count, FRAMES)
  const frames = await page.evaluate(() => window.frames_)
  const lefts = frames.map(frame => frame.left)
  if (process.env.PHONE_DEBUG) console.log('turn', lefts.join(' '))
  assert.deepEqual(
    frames.filter(frame => frame.scroll !== 0),
    [],
    'the sheet scrolled while turning a page',
  )
  const shown = lefts.filter(left => left !== null)
  const backwards = shown.slice(1).filter((left, at) => (left - shown[at]) * way < -SLACK_PX)
  assert.deepEqual(backwards, [], `the Move to page slid the wrong way; its left edge each frame: ${lefts.join(' ')}`)
}

const openMovePage = async (note = page.locator('li.note').first()) => {
  await note.locator('.more').tap()
  await sheetOpen()
  await watchTurn(() => page.locator('#sheet-actions .action', { hasText: 'Move to project' }).tap(), -1)
  assert.equal(await pageShown().then(handle => handle.jsonValue()), 'move')
}

test('Move to project turns to a page of the menu, and Back turns back', async () => {
  await openMovePage()
  assert.equal(await page.evaluate(() => document.getElementById('picker').open), false, 'the picker opened as a second dialog')
  assert.ok((await page.locator('#sheet-move .pick').count()) >= 3, 'the Move to page has no projects')
  const { width } = page.viewportSize()
  const left = (await page.locator('#sheet-move').boundingBox()).x
  assert.ok(left >= 0 && left < width / 4, `the Move to page came to rest at ${left}px`)
  await watchTurn(() => page.locator('#sheet-back').tap(), 1)
  assert.equal(await pageShown().then(handle => handle.jsonValue()), 'actions')
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.key), 'Move to project')
})

test('Escape on Move to goes back a page, then closes', async () => {
  await openMovePage()
  await page.keyboard.press('Escape')
  assert.equal(await pageShown().then(handle => handle.jsonValue()), 'actions')
  assert.equal(await page.evaluate(() => document.getElementById('sheet').open), true, 'Escape closed the sheet from Move to')
  await page.keyboard.press('Escape')
  await sheetShut()
})

// A finger's drag across the Move to page, from a third of the way in: `dx` to the right over `ms`.
const dragRight = async (dx, ms) => {
  const box = await page.locator('#sheet-move').boundingBox()
  const [x, y] = [box.x + box.width / 3, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  const steps = Math.max(1, Math.round(ms / 16))
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(x + (dx * step) / steps, y)
    await page.waitForTimeout(ms / steps)
  }
  await page.mouse.up()
}

test('a swipe right on Move to goes back; a short one stays', async () => {
  await openMovePage()
  await dragRight(40, 600)
  assert.equal(await pageShown().then(handle => handle.jsonValue()), 'move', 'a short slow swipe went back')
  await watchTurn(() => dragRight(160, 200), 1)
  assert.equal(await pageShown().then(handle => handle.jsonValue()), 'actions', "a long swipe didn't go back")
  assert.equal(await page.evaluate(() => document.getElementById('sheet').open), true)
})

test('the menu shows again after Move to', async () => {
  await openMovePage()
  await page.locator('#sheet-cancel').tap()
  await sheetShut()
  await watchRise('#sheet', () => page.locator('li.note .more').first().tap())
  assert.equal(await pageShown().then(handle => handle.jsonValue()), 'actions')
})

// The page under a sheet or drawer stays where it is when you scroll on the scrim. Mobile WebKit
// can't be scrolled from a test, so this one is desktop WebKit at the same size, with a wheel.
test('the page stays put behind the menu', async t => {
  const { viewport } = devices['iPhone 15']
  const wheeled = await pageWith({ viewport })
  t.after(() => wheeled.context().close())
  await wheeled.goto(HUB)
  await wheeled.locator('li.note').first().waitFor()
  const scrollOnScrim = async () => {
    await wheeled.mouse.move(viewport.width / 2, 20)
    await wheeled.mouse.wheel(0, 600)
    await wheeled.waitForTimeout(300)
    return wheeled.evaluate(() => window.scrollY)
  }
  await wheeled.locator('li.note .more').first().click()
  await wheeled.waitForFunction(() => document.getElementById('sheet').open)
  assert.equal(await scrollOnScrim(), 0, 'the page scrolled behind the menu')
  await wheeled.locator('#sheet-actions .action', { hasText: 'Move to project' }).click()
  await wheeled.waitForFunction(() => !document.getElementById('sheet-move').hidden)
  assert.equal(await scrollOnScrim(), 0, 'the page scrolled behind Move to')
  await wheeled.keyboard.press('Escape')
  await wheeled.keyboard.press('Escape')
  await wheeled.waitForFunction(() => !document.getElementById('sheet').open)
  // With nothing up it does scroll: the checks above could pass on a page too short to.
  assert.ok((await scrollOnScrim()) > 0, "the page didn't scroll with nothing up")
})

// A finger's drag down from `point` ({x, y}): `dy` over `ms`.
const dragDown = async (point, dy, ms) => {
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  const steps = Math.max(1, Math.round(ms / 16))
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(point.x, point.y + (dy * step) / steps)
    await page.waitForTimeout(ms / steps)
  }
  await page.mouse.up()
}
const middleOf = async selector => {
  const box = await page.locator(selector).boundingBox()
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
const panelTop = () => page.evaluate(() => Math.round(document.querySelector('#sheet .panel').getBoundingClientRect().top))

test('a swipe down closes the menu; a short one settles back', async () => {
  await page.locator('li.note .more').first().tap()
  await sheetOpen()
  await page.waitForTimeout(400)
  const rest = await panelTop()
  await dragDown(await middleOf('#sheet .head'), 40, 600)
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => document.getElementById('sheet').open), true, 'a short slow swipe closed the menu')
  assert.ok(Math.abs((await panelTop()) - rest) <= SLACK_PX, `the menu didn't settle back to ${rest}px`)
  // A short pull that starts on Cancel isn't a tap on it.
  await dragDown(await middleOf('#sheet-cancel'), 40, 600)
  await page.waitForTimeout(400)
  assert.equal(await page.evaluate(() => document.getElementById('sheet').open), true, 'a pull that began on Cancel closed the menu')
  await dragDown(await middleOf('#sheet .head'), 200, 200)
  await sheetShut()
})

test('a swipe down on Move to closes the menu', async () => {
  await openMovePage()
  await dragDown(await middleOf('#sheet-move .bar h2'), 200, 200)
  await sheetShut()
  assert.equal(await page.evaluate(() => document.getElementById('picker-body').closest('dialog').id), 'picker')
})

test('the editor rises into place from a hold', async () => {
  await watchRise('#editor', () => hold(page, page.locator('li.note .text').nth(2)))
})

// iOS brings the keyboard up only for a focus in the tap itself: Edit focuses the field at once,
// not once the menu has gone.
test('Edit in the menu opens the editor with the field focused in the same tap', async () => {
  await page.locator('li.note .more').first().tap()
  await sheetOpen()
  await pageShown()
  const focused = await page.evaluate(() => {
    document.querySelector('#sheet-actions [data-key="Edit"]').click()
    return document.activeElement?.id
  })
  assert.equal(focused, 'editor-text', "Edit didn't focus the field in its own click")
  await sheetShut()
  assert.equal(await page.evaluate(() => document.getElementById('editor').open), true, 'the editor closed with the menu')
})

test('Cancel and Escape close the editor and keep the note', async () => {
  const row = page.locator('li.note').first()
  const text = await row.locator('.text').textContent()
  for (const close of [() => page.locator('#editor-cancel').tap(), () => page.keyboard.press('Escape')]) {
    await hold(page, row.locator('.text'))
    await editorOpen()
    await page.locator('#editor-text').fill('Something else')
    await close()
    await editorShut()
    assert.equal(await row.locator('.text').textContent(), text, 'closing without Save changed the note')
  }
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('more')), true, "focus isn't back on the note's ⋯")
})

// Editing a note with the keyboard up: the editor fills the screen above it, and the page under it
// never scrolls. Playwright's WebKit has no keyboard, so the page gets a stand-in visualViewport,
// shrunk by a keyboard's height on cue.
const KEYBOARD_PX = 320
test('the editor fills the screen above the keyboard, and nothing scrolls', async t => {
  const edited = await pageWith(devices['iPhone 15'])
  t.after(() => edited.context().close())
  await edited.context().addInitScript(() => {
    const view = new EventTarget()
    Object.assign(view, { offsetTop: 0, offsetLeft: 0, scale: 1, width: innerWidth, height: innerHeight })
    Object.defineProperty(window, 'visualViewport', { value: view, configurable: true })
    // The keyboard slides up as iOS's does, with a resize a frame for about a quarter second.
    window.showKeyboard_ = height =>
      new Promise(done => {
        const from = innerHeight - view.height
        let step = 0
        const next = () => {
          step += 1
          view.height = innerHeight - (from + ((height - from) * step) / 16)
          view.dispatchEvent(new Event('resize'))
          if (step < 16) requestAnimationFrame(next)
          else done()
        }
        requestAnimationFrame(next)
      })
  })
  await edited.goto(HUB)
  await edited.locator('li.note').first().waitFor()
  // The last row (the long note's group comes last), with the list scrolled to its end.
  await edited.evaluate(() => scrollTo(0, document.documentElement.scrollHeight))
  const before = await edited.evaluate(() => scrollY)
  await hold(edited, edited.locator('li.note').last().locator('.text'))
  await editorOpen(edited)
  await edited.evaluate(height => window.showKeyboard_(height), KEYBOARD_PX)
  await edited.waitForTimeout(400)
  const { bottom, top, field, focused, scroll, height } = await edited.evaluate(() => {
    const panel = document.querySelector('#editor .panel').getBoundingClientRect()
    const text = document.getElementById('editor-text').getBoundingClientRect()
    return {
      bottom: panel.bottom,
      top: panel.top,
      field: text.bottom,
      focused: document.activeElement?.id,
      scroll: scrollY,
      height: innerHeight,
    }
  })
  assert.equal(focused, 'editor-text', "the field doesn't have focus")
  assert.equal(scroll, before, 'the page scrolled under the editor')
  const want = height - KEYBOARD_PX - 8
  assert.ok(Math.abs(bottom - want) <= SLACK_PX, `the editor's bottom is at ${Math.round(bottom)}px, not just above the keyboard (${want}px)`)
  assert.ok(top >= 0 && field <= bottom, 'the field runs past the editor')
  await edited.evaluate(() => window.showKeyboard_(0))
  await edited.waitForTimeout(100)
  const rest = await edited.evaluate(() => document.querySelector('#editor .panel').getBoundingClientRect().bottom)
  assert.ok(rest > bottom + KEYBOARD_PX - 50, `the editor didn't grow back when the keyboard went (its bottom at ${Math.round(rest)}px)`)
})

test('Save changes the note', async () => {
  const id = '01JA7K2M3Q9X4ZB6C8D0EFGH0C'
  const text = page.locator(`li.note[data-id="${id}"] .text`)
  await text.scrollIntoViewIfNeeded()
  await hold(page, text)
  await editorOpen()
  await page.locator('#editor-text').fill('Rename the band setting to width')
  await page.locator('#editor-save').tap()
  await editorShut()
  await page.waitForFunction(id => document.querySelector(`li.note[data-id="${id}"] .text`)?.textContent.includes('to width'), id)
})

// Last: it moves a note, which the other tests' rows would notice.
test('picking a project on Move to moves the note and closes the menu', async () => {
  const id = '01JA7K2M3Q9X4ZB6C8D0EFGH0B'
  await openMovePage(page.locator(`li.note[data-id="${id}"]`))
  await page.locator('#sheet-move .pick', { hasText: 'pane' }).tap()
  await sheetShut()
  await page.locator(`.group[data-key="github.com/me/pane"] li.note[data-id="${id}"]`).waitFor()
  assert.equal(await page.evaluate(() => document.activeElement?.closest('li.note')?.dataset.id), id, "focus isn't on the moved note's ⋯")
  // And the picker's list is back in its drawer, for File under.
  assert.equal(await page.evaluate(() => document.getElementById('picker-body').closest('dialog').id), 'picker')
})
