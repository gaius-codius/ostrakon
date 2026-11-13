import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MemDir } from './memdir'
import { CC, INFRA, mountPane, put, run, startSession } from './world'

// Fast typing (voice-to-text, a quick typist) sends changes faster than the pane's state saves and
// redraws. A field drawn from that state would take an older text and drop the keys typed since,
// so a field in view is never drawn again while it's typed in.

type Mounted = Awaited<ReturnType<typeof mountPane>>

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rename the store helpers', CC, 60)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'add a cache invalidation metric', INFRA, 90)
  return dir
}

const SPOKEN = 'the quick brown fox jumps over the lazy dog'

const drawnIn = async (ui: Mounted, key: string) => (await ui.find({ type: 'Input', key }))?.props?.value

// Every prefix of the text as its own change, sent at once, then backspaced away and typed again,
// with the field's drawn value read between them while they run.
const burst = async (ui: Mounted, key: string) => {
  const seen: unknown[] = []
  const prefixes = Array.from({ length: SPOKEN.length }, (_, i) => SPOKEN.slice(0, i + 1))
  const typing = [...prefixes, ...[...prefixes].reverse().slice(1), '', ...prefixes].map(text => ui.input({ key, text, kind: 'change' }))
  for (let i = 0; i < 20; i += 1) seen.push(await drawnIn(ui, key))
  await Promise.all(typing)
  seen.push(await drawnIn(ui, key))
  return seen
}

const opened = async ($: Engine, on: Parameters<typeof startSession>[1], open: (ui: Mounted) => Promise<unknown>) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await open(ui)
  return ui
}

const FIELDS: [string, (ui: Mounted) => Promise<unknown>][] = [
  ['q', async () => undefined],
  ['capture', ui => ui.press({ key: 'key-pane:next' })],
  [
    'target',
    async ui => {
      await ui.press({ key: 'key-pane:next' })
      await ui.press({ key: 'key-app:toggleDiffPreSession' })
    },
  ],
  [
    'edit',
    async ui => {
      await ui.input({ key: 'q', text: '', kind: 'submit' })
      await ui.press({ key: 'key-e' })
    },
  ],
  [
    'move',
    async ui => {
      await ui.input({ key: 'q', text: '', kind: 'submit' })
      await ui.press({ key: 'key-m' })
    },
  ],
]

for (const [key, open] of FIELDS) {
  test(`typing fast in the ${key} field never draws it again with older text`, async ($, on) => {
    const ui = await opened($, on, open)
    const first = await drawnIn(ui, key)
    expect(first).toBeDefined()
    for (const value of await burst(ui, key)) expect(value).toBe(first)
    await ui.unmount()
  })
}

test('typed fast, the search still filters by the whole text', async ($, on) => {
  const ui = await opened($, on, async () => undefined)
  await Promise.all(['r', 're', 'ren', 'rena', 'renam', 'rename'].map(text => ui.input({ key: 'q', text, kind: 'change' })))
  expect(await ui.find({ type: 'Text', text: /store helpers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /flaky/ })).toBeUndefined()
  await ui.unmount()
})

test('Enter on a search that lists draws the query back each time: the field emptied itself', async ($, on) => {
  const ui = await opened($, on, async () => undefined)
  await ui.input({ key: 'q', text: 'rename', kind: 'change' })
  expect(await drawnIn(ui, 'q')).toBe('')
  await ui.input({ key: 'q', text: 'rename', kind: 'submit' })
  expect(await drawnIn(ui, 'q')).toBe('rename')
  await ui.press({ key: 'key-app:toggleDiffNoiseFilter' })
  await ui.input({ key: 'q', text: 'rename', kind: 'submit' })
  expect(await drawnIn(ui, 'q')).toBe('rename ')
  await ui.unmount()
})

test('capture saves retried after a failure keep the text each time, and a saved one never comes back', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'keep me', kind: 'change' })
  // To the picker and back: the field comes into view drawn with the draft.
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await drawnIn(ui, 'capture')).toBe('keep me')
  dir.failWrites = true
  await ui.input({ key: 'capture', text: 'keep me', kind: 'submit' })
  const once = await drawnIn(ui, 'capture')
  expect(String(once).trimEnd()).toBe('keep me')
  await ui.input({ key: 'capture', text: String(once), kind: 'submit' })
  const twice = await drawnIn(ui, 'capture')
  expect(String(twice).trimEnd()).toBe('keep me')
  expect(twice).not.toBe(once)
  dir.failWrites = false
  await ui.input({ key: 'capture', text: String(twice), kind: 'submit' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await drawnIn(ui, 'capture')).toBe('')
  await ui.unmount()
})

test('a search saved as a note after failed saves leaves the list unfiltered', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: 'unique missing note', kind: 'change' })
  dir.failWrites = true
  await ui.input({ key: 'q', text: 'unique missing note', kind: 'submit' })
  await ui.input({ key: 'q', text: String(await drawnIn(ui, 'q')), kind: 'submit' })
  dir.failWrites = false
  await ui.input({ key: 'q', text: String(await drawnIn(ui, 'q')), kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /store helpers/ })).toBeDefined()
  await ui.unmount()
})
