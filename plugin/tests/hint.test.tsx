import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptEditInput, PromptEditResult } from 'claude-code'

import { HINT, MS } from '../src/ui/look'
import { MemDir } from './memdir'
import { CC, put, run, startSession } from './world'

// The hint line under the prompt (SPEC §4.4) and the prompt's /jot paint.

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  return dir
}

// The engine's hint line beneath the mod: it draws the tail it was handed, so a test reads it.
// The editor beneath it splices the edit in, as core does.
const hintLine = (on: Parameters<typeof startSession>[1]) => {
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail ?? ''}</Text>
  })
  on('prompt.edit', ($, e) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
}
const HINT_PROPS = { isDraft: true, isWorking: false, hint: '? for shortcuts' }
const mountHint = ($: Engine) => $.ui.mount({ plugin: 'ostrakon', surface: 'terminal', component: 'PromptHint', props: HINT_PROPS })
const tailOf = async (ui: Awaited<ReturnType<typeof mountHint>>) => String((await ui.find({ type: 'Text' }))?.text ?? '')
// A key typed at the end of the draft. The kit's $ raises prompt.edit, though its type leaves it out.
type Edit = (e: PromptEditInput) => Promise<PromptEditResult>
const edit = ($: Engine, text: string, inputText: string) =>
  ($.prompt as unknown as { edit: Edit }).edit({ origin: { kind: 'composer' }, text, cursor: text.length, start: text.length, end: text.length, inputText })

test('a /jot draft marks the command and italicises the note, and the hint line says where it saves', async ($, on) => {
  hintLine(on)
  await startSession($, on, fixture())
  const ui = await mountHint($)
  expect(await tailOf(ui)).toBe('')
  const started = await edit($, '/jot', ' ')
  expect(started.decorations).toEqual([{ start: 0, end: 4, color: 'claude', bold: true }])
  const typed = await edit($, '/jot buy mil', 'k')
  expect(typed.decorations).toEqual([
    { start: 0, end: 4, color: 'claude', bold: true },
    { start: 5, end: 13, italic: true },
  ])
  await ui.redraw(HINT_PROPS)
  expect(await tailOf(ui)).toBe(`${HINT.gap}${HINT.capture('cc')}`)
  // A draft that stops leading with /jot is an ordinary prompt again.
  const plain = await edit($, '', 'buy milk')
  expect(plain.decorations).toBeUndefined()
  await ui.redraw(HINT_PROPS)
  expect(await tailOf(ui)).toBe('')
  await ui.unmount()
})

test('a /jot save says saved on the hint line instead of a toast, until MS.saved has passed', async ($, on) => {
  hintLine(on)
  const { world, clock } = await startSession($, on, fixture())
  const ui = await mountHint($)
  await edit($, '/jot buy mil', 'k')
  await run($, 'jot', 'buy milk')
  await ui.redraw({ ...HINT_PROPS, isDraft: false })
  expect(await tailOf(ui)).toBe(`${HINT.gap}${HINT.saved('cc')}`)
  expect(world.toasts).toEqual([])
  // Typing /jot again within the window: the draft's cue wins.
  await edit($, '/jot', ' ')
  await ui.redraw(HINT_PROPS)
  expect(await tailOf(ui)).toBe(`${HINT.gap}${HINT.capture('cc')}`)
  await edit($, '', 'x')
  await clock.advance(MS.saved)
  await ui.redraw({ ...HINT_PROPS, isDraft: false })
  expect(await tailOf(ui)).toBe('')
  await ui.unmount()
})

test('a failed /jot save still says why, and the hint line claims nothing', async ($, on) => {
  hintLine(on)
  const dir = fixture()
  await startSession($, on, dir)
  const ui = await mountHint($)
  dir.failWrites = true
  const result = await run($, 'jot', 'buy milk')
  expect(String((result as { text?: string }).text)).toMatch(/^ostrakon: Couldn't save/)
  await ui.redraw({ ...HINT_PROPS, isDraft: false })
  expect(await tailOf(ui)).toBe('')
  await ui.unmount()
})
