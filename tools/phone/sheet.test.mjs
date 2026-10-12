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
  ]
  const pushed = await fetch(`${HUB}/api/notes`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ notes }),
  })
  assert.equal(pushed.status, 200, await pushed.text())
  browser = await webkit.launch()
  const context = await browser.newContext({ ...devices['iPhone 15'], serviceWorkers: 'block' })
  await context.addInitScript(token => localStorage.setItem('sp.token', JSON.stringify(token)), TOKEN)
  page = await context.newPage()
})

// A fresh page for each test: one that fails with a sheet still up leaves nothing behind.
beforeEach(async () => {
  await page.goto(HUB)
  await page.locator('li.note').first().waitFor()
})

after(() => browser?.close())

// The spring's bounce takes the panel a few pixels past where it rests, and back.
const BOUNCE_PX = 8
// Frames watched from the one the dialog opens on: a second at 60 frames a second, which the rise
// (a 0.32s spring) is well inside.
const FRAMES = 60

// Watches `dialog` every frame from when it opens: its scroll offset and its panel's top. The
// panel rises from below and comes to rest: it never shows in place first and then drops, never
// goes past its rest by more than the bounce, and the dialog itself never scrolls.
const watchRise = async (dialog, open) => {
  await page.evaluate(
    ([selector, count]) => {
      const box = document.querySelector(selector)
      const panel = box.querySelector('.panel')
      window.frames_ = []
      const sample = () => {
        if (box.open) window.frames_.push({ scroll: box.scrollTop, top: Math.round(panel.getBoundingClientRect().top) })
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
  assert.deepEqual(
    frames.filter(frame => frame.scroll !== 0),
    [],
    `${dialog} scrolled while opening`,
  )
  const drops = frames.slice(1).filter((frame, at) => frame.top > frames[at].top + BOUNCE_PX)
  assert.deepEqual(drops, [], `${dialog}'s panel moved down while rising; its top each frame: ${tops}`)
  const past = frames.filter(frame => frame.top < rest - BOUNCE_PX)
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

test('the project picker rises into place from Move to project', async () => {
  await page.locator('li.note .more').first().tap()
  await page.waitForFunction(() => document.getElementById('sheet').open)
  await watchRise('#picker', () => page.locator('#sheet-actions .action', { hasText: 'Move to project' }).tap())
})
