import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { CHORD } from '../src/ui/look'
import { MemDir } from './memdir'
import { CC, mountPane, put, run, startSession, texts } from './world'

// A text field takes `i`, so the key sheet opens from one with its chord (SPEC §4.5): the sheet
// takes the keys, and hands them back to the field it was opened from. The kit raises no
// `ui.focus` for the mod's own focus moves, so where the ring goes is checked live (QA), and these
// check what's drawn.

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rename the store helpers', CC, 60)
  return dir
}

type Ui = Awaited<ReturnType<typeof mountPane>>
const CHORD_KEY = `key-${CHORD.keys.action}`
const sheetUp = async (ui: Ui) => (await texts(ui)).some(text => /^jump to a row$/.test(text))
const shows = async (ui: Ui, pattern: RegExp) => (await texts(ui)).some(text => pattern.test(text))

const opened = async ($: Engine, on: Parameters<typeof startSession>[1]) => {
  const started = await startSession($, on, fixture())
  await run($, 'jot', '')
  return { ...started, ui: await mountPane($) }
}

test('from the search field the chord opens the key sheet, which takes the keys and gives them back', async ($, on) => {
  const { ui } = await opened($, on)
  expect(await shows(ui, /^ctrl\+x i$/)).toBe(true)
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(true)
  // With the keys, `i` closes it as it does from a row; the search field has them again.
  await ui.press({ key: 'key-i' })
  expect(await sheetUp(ui)).toBe(false)
  expect(await shows(ui, /^ctrl\+x i$/)).toBe(true)
  await ui.press({ key: CHORD_KEY })
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(false)
  await ui.unmount()
})

test('from capture the sheet closes back to capture, the draft as it was', async ($, on) => {
  const { ui } = await opened($, on)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'half a thought', kind: 'change' })
  expect(await shows(ui, /^ctrl\+x i$/)).toBe(true)
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(true)
  expect(await ui.find({ type: 'Input', key: 'capture' })).toBeUndefined()
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(false)
  const field = await ui.find({ type: 'Input', key: 'capture' })
  expect(field?.props.value).toBe('half a thought')
  await ui.unmount()
})

test('from the edit card the sheet closes back to the card, the draft as it was', async ($, on) => {
  const { ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'check why the cache test is flaky on CI', kind: 'change' })
  expect(await shows(ui, /^ctrl\+x i$/)).toBe(true)
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(true)
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  await ui.press({ key: 'key-i' })
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect(field?.props.value).toBe('check why the cache test is flaky on CI')
  await ui.unmount()
})

test('closed with the sheet over the edit card, the pane opens on the card again, the draft as it was', async ($, on) => {
  const { ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'check why the cache test is flaky on CI', kind: 'change' })
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(true)
  await ui.press({ key: 'key-pane:previous' })
  await run($, 'jot', '')
  expect(await sheetUp(ui)).toBe(false)
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect(field?.props.value).toBe('check why the cache test is flaky on CI')
  await ui.unmount()
})

test('opened on a row with `i`, the chord closes the sheet too', async ($, on) => {
  const { ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-i' })
  expect(await sheetUp(ui)).toBe(true)
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(false)
  await ui.unmount()
})

test('a note archived while its edit card waits under the sheet: the sheet closes to the list', async ($, on) => {
  const { world, ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.press({ key: CHORD_KEY })
  const archive = world.tools.find(tool => tool.name === 'archive')?.registeredAs ?? 'archive'
  await $.tool.call({ tool: archive, id: '01JA7K2M3Q9X4ZB6C8D0EFGH01' } as never)
  await ui.press({ key: 'key-i' })
  expect(await sheetUp(ui)).toBe(false)
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  expect(await shows(ui, /draft kept/)).toBe(false)
  expect(await shows(ui, /^ctrl\+x i$/)).toBe(true)
  await ui.unmount()
})

test('a note archived while its edit card waits under the sheet: ctrl+x tab hands the keys over with the list behind, not the card', async ($, on) => {
  const { world, ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(true)
  const archive = world.tools.find(tool => tool.name === 'archive')?.registeredAs ?? 'archive'
  await $.tool.call({ tool: archive, id: '01JA7K2M3Q9X4ZB6C8D0EFGH01' } as never)
  await ui.press({ key: 'key-switch' })
  expect(await sheetUp(ui)).toBe(false)
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  expect(await shows(ui, /draft kept/)).toBe(false)
  expect(await shows(ui, /^ctrl\+x i$/)).toBe(true)
  await ui.unmount()
})

test('the bundle answers the chord and stays as it is', async ($, on) => {
  const { ui } = await opened($, on)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-v' })
  await ui.press({ key: 'key-b' })
  const before = await texts(ui)
  await ui.press({ key: CHORD_KEY })
  expect(await sheetUp(ui)).toBe(false)
  expect(await texts(ui)).toEqual(before)
  await ui.unmount()
})
