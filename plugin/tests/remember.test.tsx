import { expect, test } from 'claude-code/testing'

import { MemDir } from './memdir'
import { WIDTH } from '../src/ui/look'
import { CC, INFRA, PANE, mountPane, noteIn, put, run, startSession, texts } from './world'

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

test("a long capture draft grows the field, to a few rows (fewer inline), and isn't repeated under it", async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  const rows = async () => (await ui.find({ type: 'Input', key: 'capture' }))?.props?.rows
  // Two rows from the start: a field of one holds one line.
  expect(await rows()).toBe(2)
  await ui.input({ key: 'capture', text: 'is there a way to save the scope so we can default to all instead of this project', kind: 'change' })
  expect(await rows()).toBe(2)
  await ui.input({ key: 'capture', text: 'one\ntwo\nthree', kind: 'change' })
  expect(await rows()).toBe(3)
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ')
  await ui.input({ key: 'capture', text: long, kind: 'change' })
  expect(await rows()).toBe(WIDTH.fieldRows)
  expect(await shows(ui, /word119/)).toBe(false)
  await ui.redraw({ ...PANE.props, placement: 'inline', scroll: { offset: 0, bodyRows: 11 } })
  expect(await rows()).toBe(WIDTH.fieldRowsInline)
  await ui.unmount()
})

test('a capture with several lines saves them', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'first line\nsecond line', kind: 'submit' })
  const saved = dir
    .names('/data/notes')
    .map(name => noteIn(dir, name.replace(/\.md$/, '')))
    .find(note => note.text.startsWith('first line'))
  expect(saved?.text).toBe('first line\nsecond line')
  await ui.unmount()
})

test('the edit card edits a note with several lines as it is, ↵ and all', async ($, on) => {
  const other = new MemDir()
  put(other, '01JA7K2M3Q9X4ZB6C8D0EFGH05', 'line one\nline two ↵ kept', CC, 5)
  await startSession($, on, other)
  await run($, 'jot', '')
  const pane = await mountPane($)
  await pane.input({ key: 'q', text: '', kind: 'submit' })
  await pane.press({ key: 'key-e' })
  expect((await pane.find({ type: 'Input', key: 'edit' }))?.props?.value).toBe('line one\nline two ↵ kept')
  await pane.input({ key: 'edit', text: 'line one\nline three', kind: 'submit' })
  expect(noteIn(other, '01JA7K2M3Q9X4ZB6C8D0EFGH05').text).toBe('line one\nline three')
  await pane.unmount()
})
