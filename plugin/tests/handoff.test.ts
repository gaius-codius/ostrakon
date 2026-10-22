import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MemDir } from './memdir'
import { CHORD } from '../src/ui/look'
import { CC, PANE, mountPane, put, run, startSession, texts } from './world'

// ctrl+x tab moves the keyboard between the pane and the prompt (SPEC §4.4, §4.5). The kit can't
// raise a person's close, so Esc at the top (which ends in the same giveBack) isn't driven here.

const BAND = {
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rename the store helpers', CC, 60)
  return dir
}

type Ui = Awaited<ReturnType<typeof mountPane>>

const hasText = async (ui: Ui, pattern: RegExp) => (await ui.find({ type: 'Text', text: pattern })) !== undefined

// The draft is held by the open; the pane is drawn with the keys.
const opened = async ($: Engine, on: Parameters<typeof startSession>[1], draft: string) => {
  const started = await startSession($, on, fixture(), draft)
  await run($, 'jot', '')
  const ui = await mountPane($)
  return { ...started, ui }
}

test('ctrl+x tab in the pane gives the prompt the keys and the held draft, and leaves the pane as it was', async ($, on) => {
  const { world, ui } = await opened($, on, 'my draft')
  expect(world.box.text).toBe('')
  await ui.input({ key: 'q', text: 'store', kind: 'change' })
  await ui.press({ key: 'key-switch' })
  expect(world.box.text).toBe('my draft')
  // Closed and opened again without the keys; the close keeps the query (no cleanup ran).
  expect(world.closed).toBe(1)
  expect(world.openFocus).toEqual([true, false])
  await ui.redraw({ ...PANE.props, isFocused: false })
  expect(await hasText(ui, /^ctrl\+x tab$/)).toBe(true)
  await ui.redraw({ ...PANE.props, isFocused: true })
  const field = await ui.find({ type: 'Input', key: 'q' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('store')
  await ui.unmount()
})

test('ctrl+x tab from the prompt holds what was typed there and takes the keys back; closing returns it', async ($, on) => {
  const { world, ui } = await opened($, on, 'my draft')
  await ui.press({ key: 'key-switch' })
  await ui.redraw({ ...PANE.props, isFocused: false })
  world.box.text = 'my draft, and more'
  await ui.press({ key: 'key-switch' })
  expect(world.box.text).toBe('')
  expect(world.openFocus).toEqual([true, false, true])
  await ui.redraw({ ...PANE.props, isFocused: true })
  await ui.press({ key: 'key-pane:previous' })
  expect(world.box.text).toBe('my draft, and more')
  await ui.unmount()
})

test('ctrl+x tab from an empty prompt takes the keys without holding anything', async ($, on) => {
  const { world, ui } = await opened($, on, '')
  await ui.press({ key: 'key-switch' })
  await ui.redraw({ ...PANE.props, isFocused: false })
  await ui.press({ key: 'key-switch' })
  expect(world.openFocus).toEqual([true, false, true])
  await ui.redraw({ ...PANE.props, isFocused: true })
  await ui.press({ key: 'key-pane:previous' })
  expect(world.box.text).toBe('')
  await ui.unmount()
})

test("ctrl+x s on a pane that isn't holding the keys closes it, and the prompt keeps what's in it", async ($, on) => {
  const { world, ui } = await opened($, on, 'my draft')
  await ui.press({ key: 'key-switch' })
  await ui.redraw({ ...PANE.props, isFocused: false })
  world.box.text = 'my draft, edited'
  await ui.press({ key: 'key-toggle' })
  expect(world.closed).toBe(2)
  expect(world.box.text).toBe('my draft, edited')
  await ui.unmount()
})

test("the band carries ctrl+x tab: with the pane closed it opens it with the keys, holding the prompt's draft", async ($, on) => {
  const { world } = await startSession($, on, fixture(), 'half a thought')
  const band = await $.ui.mount({ plugin: 'ostrakon', surface: 'terminal', ...BAND })
  await band.press({ key: 'band-switch' })
  expect(world.openFocus).toEqual([true])
  expect(world.box.text).toBe('')
  await band.unmount()
})

test('the key sheet goes when the keys go: back, the pane shows the field it was opened from', async ($, on) => {
  const { ui } = await opened($, on, '')
  const sheetUp = async () => (await texts(ui)).some(text => /^jump to a row$/.test(text))
  await ui.press({ key: `key-${CHORD.keys.action}` })
  expect(await sheetUp()).toBe(true)
  await ui.press({ key: 'key-switch' })
  await ui.redraw({ ...PANE.props, isFocused: false })
  await ui.press({ key: 'key-switch' })
  await ui.redraw({ ...PANE.props, isFocused: true })
  expect(await sheetUp()).toBe(false)
  expect(await ui.find({ type: 'Input', key: 'q' })).toBeDefined()
  await ui.unmount()
})
