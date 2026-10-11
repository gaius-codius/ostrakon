import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MemDir } from './memdir'
import { CC, INFRA, mountPane, put, run, startSession } from './world'

// The kit can't raise a person's close (Esc): `$.ui.close` isn't on its engine and a mounted Pane
// has no close mark, so the back steps of the `ui.close` hook can't be driven from here. What can
// be: a plugin-origin close (ctrl+q's layer key, q) always closes, and the footers say what Esc does.

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rename the store helpers', CC, 60)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'add a cache invalidation metric', INFRA, 90)
  return dir
}

type Ui = Awaited<ReturnType<typeof mountPane>>

const hasText = async (ui: Ui, pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern })) !== undefined

// /jot opens the pane on search; `isCapture` goes on to a new note (ctrl+n).
const opened = async ($: Engine, on: Parameters<typeof startSession>[1], isCapture = false) => {
  const started = await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  if (isCapture) await ui.press({ key: 'key-pane:next' })
  return { ...started, ui }
}

test("ctrl+q's layer key closes the pane from capture, and nothing re-opens it afterwards", async ($, on) => {
  const { world, clock, ui } = await opened($, on, true)
  expect(await hasText(ui, /new note/)).toBe(true)
  await ui.press({ key: 'key-pane:previous' })
  expect(world.closed).toBe(1)
  await clock.advance(500)
  expect(world.opened).toBe(1)
  await ui.unmount()
})

test('ctrl+q closes at once from a focused row and from the edit card', async ($, on) => {
  const { world, clock, ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeDefined()
  await ui.press({ key: 'key-pane:previous' })
  expect(world.closed).toBe(1)
  await clock.advance(500)
  expect(world.opened).toBe(1)
  await ui.unmount()
})

test('the footers of capture, edit, bundle and move say what esc does', async ($, on) => {
  const { ui } = await opened($, on, true)
  expect(await hasText(ui, /^esc$/)).toBe(true)
  await ui.input({ key: 'capture', text: '', kind: 'submit' })

  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  expect(await hasText(ui, /^esc$/)).toBe(true)
  await ui.press({ key: 'edit-cancel' })

  await ui.press({ key: 'key-v' })
  await ui.press({ key: 'key-b' })
  expect(await hasText(ui, /^esc$/)).toBe(true)
  await ui.unmount()
})
