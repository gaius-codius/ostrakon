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

test('the menu rises into place from a long press', async () => {
  const box = await page.locator('li.note').nth(1).boundingBox()
  await watchRise('#sheet', async () => {
    await page.mouse.move(box.x + box.width / 3, box.y + box.height / 2)
    await page.mouse.down()
    await page.waitForFunction(() => document.getElementById('sheet').open)
    await page.mouse.up()
  })
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
