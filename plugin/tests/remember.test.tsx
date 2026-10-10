import { expect, test } from 'claude-code/testing'

import { MemDir } from './memdir'
import { CC, INFRA, mountPane, put, run, startSession, texts } from './world'

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'add a cache invalidation metric', INFRA, 90)
  return dir
}

type Ui = Awaited<ReturnType<typeof mountPane>>
const shows = async (ui: Ui, pattern: RegExp) => (await texts(ui)).some(text => pattern.test(text))

test('ctrl+s to all is remembered: the pane opens on all until ctrl+s goes back to this project', async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  let ui = await mountPane($)
  expect(await shows(ui, /invalidation metric/)).toBe(false)
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await shows(ui, /invalidation metric/)).toBe(true)
  await ui.press({ key: 'key-pane:previous' })
  await ui.unmount()

  await run($, 'jot', '')
  ui = await mountPane($)
  expect(await shows(ui, /invalidation metric/)).toBe(true)
  // Back to this project: the default again from the next open.
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.press({ key: 'key-pane:previous' })
  await ui.unmount()

  await run($, 'jot', '')
  ui = await mountPane($)
  expect(await shows(ui, /invalidation metric/)).toBe(false)
  await ui.unmount()
})

test('a long capture draft reads whole under the one-line field, and its end when longer than the room', async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  const draft = 'is there a way to save the scope so we can default to all instead of this project when that is what the person wants'
  await ui.input({ key: 'capture', text: draft, kind: 'change' })
  expect(await shows(ui, /what the person wants/)).toBe(true)
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
  await ui.input({ key: 'capture', text: long, kind: 'change' })
  expect(await shows(ui, /word119$/)).toBe(true)
  expect(await shows(ui, /^…/)).toBe(true)
  await ui.unmount()
})
