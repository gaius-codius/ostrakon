import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { MemDir } from './memdir'
import { cells } from '../src/model'
import { FOOTER_KEY, PREVIEW_ROWS, TEXT_COLUMN } from '../src/ui/pane'
import { COLOUR, GLYPH, JOT_CONTEXT } from '../src/ui/look'
import { CC, INFRA, NOTE, PANE, mountPane, noteIn, put, run, startSession, texts } from './world'
import { serializeNote } from '../src/frontmatter'

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rename the store helpers', CC, 60)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'add a cache invalidation metric', INFRA, 90)
  return dir
}

// The file a note was saved to, by its text.
const savedFile = (dir: MemDir, text: string) => [...dir.files.values()].find(file => file.text.includes(text))?.text ?? ''

test('the pane opens on this project, searches everywhere once typing, and Enter saves a failed search', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  expect(world.opened).toBe(1)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /this project · 2 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rename the store helpers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add a cache invalidation metric/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ctrl\+s$/ })).toBeDefined()

  await ui.input({ key: 'q', text: 'cache', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /all · 2 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add a cache invalidation metric/ })).toBeDefined()

  await ui.input({ key: 'q', text: 'kubernetes', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^No notes match\. ⏎ saves it to / })).toBeDefined()
  // A query the field holds isn't repeated, and the footer, not the body, has the scope key.
  expect(await ui.find({ type: 'Text', text: /kubernetes/ })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /^ctrl\+s$/ })).length).toBe(1)
  // One the field cuts off reads whole under it.
  const long = `kubernetes ${'node pool '.repeat(20)}upgrade`
  await ui.input({ key: 'q', text: long, kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /upgrade$/ })).toBeDefined()
  await ui.input({ key: 'q', text: 'kubernetes', kind: 'change' })
  await ui.input({ key: 'q', text: 'kubernetes', kind: 'submit' })
  expect(world.toasts.some(toast => toast.includes('saved to'))).toBe(false)
  expect([...dir.files.values()].some(file => file.text.includes('kubernetes'))).toBe(true)
  await ui.unmount()
})

test('a draft in the prompt is held while the pane is open and comes back after it', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir, 'my half-written prompt')
  await run($, 'jot', '')
  expect(world.box.text).toBe('')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:previous' })
  expect(world.closed).toBe(1)
  await ui.unmount()
  expect(world.box.text).toBe('my half-written prompt')
})

test('t puts the note after the held draft, and the submit carrying it marks it sent', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir, 'my draft')
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /^d$/ })).toBeDefined()
  await ui.press({ key: 'key-t' })
  expect(world.box.text).toBe('my draft\n\ncheck why the cache test is flaky')
  expect(world.closed).toBe(1)
  await $.prompt.submit({ text: world.box.text, wait: false, origin: { kind: 'plugin', name: 'test' } })
  // A plugin's own submit isn't the person's: nothing is marked.
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('open')
  await ui.unmount()
})

test('digits jump, v picks across projects, b previews and send submits the bundle with project names', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: 'cache', kind: 'change' })
  await ui.input({ key: 'q', text: 'cache', kind: 'submit' })
  await ui.press({ key: 'key-v' })
  await ui.press({ key: 'key-digit-2' })
  await ui.press({ key: 'key-v' })
  expect(await ui.find({ type: 'Text', text: /^2 picked$/ })).toBeDefined()
  await ui.press({ key: 'key-b' })
  expect(await ui.find({ type: 'Text', text: /2 notes into one prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[infra\] add a cache invalidation metric/ })).toBeDefined()
  await ui.press({ key: 'bundle-send' })
  await clock.advance(10)
  expect(world.submitted[0]).toBe(
    'Please look at these notes from my ostrakon:\n\n- check why the cache test is flaky\n- [infra] add a cache invalidation metric',
  )
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03').status).toBe('sent')
  await ui.unmount()
})

test('d archives with an undo, and the pane groups by project with history on h', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-d' })
  expect(world.toasts).toContain('Archived · u undo')
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('archived')
  await ui.press({ key: 'key-digit-1' })
  await ui.press({ key: 'key-u' })
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('open')

  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeUndefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await ui.find({ type: 'Text', text: /all · 3 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await ui.find({ type: 'Text', text: /this project · 2 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeUndefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: /this project · 2 open \+ history/ })).toBeDefined()
  // With history on, a search counts from open and history notes alike.
  await ui.press({ key: 'key-d' })
  await ui.input({ key: 'q', text: 'e', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /this project · 2 of 2/ })).toBeDefined()
  await ui.unmount()
})

test('/jot saves at once; alone it opens the pane, where ctrl+n captures, saving and staying until an empty Enter', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  // No output row (the hint line says it saved); Claude, who reads the command, is told it needs nothing.
  expect(await run($, 'jot', 'buy milk')).toEqual({ context: [JOT_CONTEXT] })
  expect(world.toasts.some(toast => toast.includes('saved to'))).toBe(false)
  expect([...dir.files.values()].some(file => file.text.includes('buy milk'))).toBe(true)

  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  expect(await ui.find({ type: 'Text', text: /new note/ })).toBeDefined()
  await ui.input({ key: 'capture', text: 'first idea', kind: 'submit' })
  await ui.input({ key: 'capture', text: 'second idea', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /^second idea$/ })).toBeDefined()
  await ui.input({ key: 'capture', text: '', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /new note/ })).toBeUndefined()
  expect([...dir.files.values()].filter(file => file.text.includes('idea')).length).toBe(2)
  await ui.unmount()
})

test('notes load at session start, and unreadable files show as a problem row', async ($, on) => {
  const dir = fixture()
  dir.put('/data/notes/broken.md', 'not a note')
  const { clock } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /1 unreadable file$/ })).toBeDefined()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH04', 'a new one from the phone', CC, 1)
  await clock.advance(2100)
  expect(await ui.find({ type: 'Text', text: /a new one from the phone/ })).toBeDefined()
  expect(dir.get('/data/notes/broken.md')).toBe('not a note')
  expect((await texts(ui)).length).toBeGreaterThan(5)
  await ui.unmount()
})

test('a search with no match beside an unreadable file still says Enter saves it, and a short pane takes one line of it', async ($, on) => {
  const dir = fixture()
  dir.put('/data/notes/broken.md', 'not a note')
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: 'kubernetes', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /1 unreadable file/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^No notes match\. / })).toBeDefined()
  const field = await ui.find({ type: 'Input' })
  expect((field?.props as { submitLabel?: string } | undefined)?.submitLabel).toBe('')
  const long = `kubernetes ${'node pool '.repeat(40)}upgrade`
  await ui.input({ key: 'q', text: long, kind: 'change' })
  const wrapped = async () => (await texts(ui)).filter(text => /node pool/.test(text) && !text.startsWith('No notes')).length
  expect(await wrapped()).toBeGreaterThan(1)
  await ui.redraw({ ...PANE.props, scroll: { offset: 0, bodyRows: 14 } })
  expect(await wrapped()).toBe(1)
  await ui.unmount()
})

const composer = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test("the person's next submit carrying a filled note marks it sent; after that the fill is spent", async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-t' })
  await composer($, `${world.box.text} please`)
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('sent')

  // A second fill, then an unrelated prompt: the fill is spent and a later match marks nothing.
  await run($, 'jot', '')
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-t' })
  await composer($, 'something else entirely')
  await composer($, 'rename the store helpers')
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02').status).toBe('open')
  await ui.unmount()
})

test('opening again while open keeps the held draft', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir, 'draft A')
  await run($, 'jot', '')
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:previous' })
  expect(world.box.text).toBe('draft A')
  await ui.unmount()
})

test('a dropped send leaves the pane open and the note open', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  world.drop = 'blocked by a hook'
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-s' })
  await clock.advance(10)
  expect(world.closed).toBe(0)
  expect(world.toasts).toContain('Not sent: blocked by a hook')
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('open')
  await ui.unmount()
})

test('a capture save that fails keeps the text and says why', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  dir.failWrites = true
  await ui.input({ key: 'capture', text: 'keep me', kind: 'change' })
  await ui.input({ key: 'capture', text: 'keep me', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /^Couldn't save/ })).toBeDefined()
  const field = await ui.find({ type: 'Input' })
  expect(String((field?.props as { value?: string } | undefined)?.value ?? '').trim()).toBe('keep me')
  await ui.unmount()
})

test('an edit draft survives closing the pane and comes back on open', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'half-edited text', kind: 'change' })
  await ui.press({ key: 'key-pane:previous' })
  await run($, 'jot', '')
  expect(await ui.find({ type: 'Text', text: /^edit $/ })).toBeDefined()
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half-edited text')
  await ui.unmount()
})

test('an edit closed on a note sent meanwhile opens on the list, its draft kept for the next e', async ($, on) => {
  const dir = fixture()
  const { clock } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'half-edited text', kind: 'change' })
  await ui.press({ key: 'key-pane:previous' })
  const file = '/data/notes/01JA7K2M3Q9X4ZB6C8D0EFGH01.md'
  dir.put(file, dir.get(file)?.replace('status: open', 'status: sent') ?? '')
  await clock.advance(2000)
  await run($, 'jot', '')
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  expect((await texts(ui)).some(text => /draft kept/.test(text))).toBe(false)
  expect(await ui.find({ type: 'Text', text: /rename the store helpers/ })).toBeDefined()
  // The browse footer, not the edit card's.
  expect(await ui.find({ type: 'Text', text: /^ctrl\+s all projects$/ })).toBeDefined()
  // Back on the list, the note picks the draft up again.
  dir.put(file, dir.get(file)?.replace('status: sent', 'status: open') ?? '')
  await clock.advance(2000)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half-edited text')
  await ui.unmount()
})

// Another project's note, reached by a search (scope all), edited, the pane closed. The query
// clears with the close, so the scope is back on this project when the pane opens again.
const closedOnInfraEdit = async ($: Engine, on: Parameters<typeof startSession>[1]) => {
  const dir = fixture()
  const { clock } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: 'metric', kind: 'change' })
  await ui.input({ key: 'q', text: 'metric', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'half-edited metric', kind: 'change' })
  await ui.press({ key: 'key-pane:previous' })
  return { dir, clock, ui }
}

test("an edit of another project's note closed and reopened comes back on the card, scope all", async ($, on) => {
  const { ui } = await closedOnInfraEdit($, on)
  await run($, 'jot', '')
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half-edited metric')
  expect(await ui.find({ type: 'Text', text: /^ all · 3 open$/ })).toBeDefined()
  await ui.unmount()
})

test("an edit of another project's note closed on a note sent meanwhile opens on this project's list", async ($, on) => {
  const { dir, clock, ui } = await closedOnInfraEdit($, on)
  const file = '/data/notes/01JA7K2M3Q9X4ZB6C8D0EFGH03.md'
  dir.put(file, dir.get(file)?.replace('status: open', 'status: sent') ?? '')
  await clock.advance(2000)
  await run($, 'jot', '')
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ this project · 2 open$/ })).toBeDefined()
  await ui.unmount()
})

// The kit can't raise Esc; Tab off the card leaves the same state (the list, the draft kept).
type Leave = ($: Engine, ui: Awaited<ReturnType<typeof mountPane>>) => Promise<unknown>
const leftEdit = async ($: Engine, on: Parameters<typeof startSession>[1], leave: Leave) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'half-edited text', kind: 'change' })
  await leave($, ui)
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  await ui.press({ key: 'key-pane:previous' })
  await run($, 'jot', '')
  expect(await ui.find({ type: 'Input', key: 'edit' })).toBeUndefined()
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half-edited text')
  await ui.unmount()
}

test('an edit left by its cancel button before the pane closes stays shut on open, its draft kept for the next e', ($, on) =>
  leftEdit($, on, (_, ui) => ui.press({ key: 'edit-cancel' })))

test('an edit left by moving the ring off it before the pane closes stays shut on open, its draft kept for the next e', ($, on) =>
  leftEdit($, on, $ => $.ui.focus({ component: 'Pane', requestId: PANE.requestId, element: 'q', origin: { kind: 'person' } })))

test('an unfocused pane draws no selection and says how to get the keyboard', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.redraw({ ...PANE.props, isFocused: false })
  expect(await ui.find({ type: 'Text', text: /^ctrl\+x tab$/ })).toBeDefined()
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(box => (box.props as { backgroundColor?: string }).backgroundColor === 'subtle')).toBe(false)
  await ui.unmount()
})

test('a dropped submit of a filled note keeps it tracked, so the retry marks it sent', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-t' })
  const filled = world.box.text
  world.drop = 'not now'
  await composer($, filled)
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('open')
  world.drop = undefined
  await composer($, filled)
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01').status).toBe('sent')
  await ui.unmount()
})

// The ui.focus hook's boundary: a landing is the ring's last element at once, before the view is
// read, so a move onto the action layer while that read waits goes back to it.
test("a focus move waiting on the view is already the ring's last: the action layer meanwhile sends the ring back to it", async ($, on) => {
  const dir = fixture()
  // Holds the next read of the pane's state once armed (the view's), until open.
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  let isArmed = false
  let held = 0
  on('state.get', async (_, e, next) => {
    if (isArmed && (e as { key?: string }).key === 'pane') {
      isArmed = false
      held += 1
      await gate
    }
    return next(e)
  })
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  const focus = (element: string) => $.ui.focus({ component: 'Pane', requestId: PANE.requestId, element, origin: { kind: 'person' } })
  await focus('q')
  isArmed = true
  const landing = focus('slot-0')
  for (let i = 0; i < 1000 && held < 1; i++) await Promise.resolve()
  expect(held).toBe(1)
  // Off the search field the layer would go to the last row (slot-1); off slot-0 it stays there.
  await focus('key-e')
  expect(world.focused.at(-1)).toBe('slot-0')
  open()
  await landing
  expect(world.focused.slice(-2)).toEqual(['slot-0', 'slot-0'])
})

test('inline, a selected row puts its meta before the scope, and drops it before the scope when short', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const inline = (bodyColumns: number) => ({ ...PANE.props, placement: 'inline' as const, bodyColumns, scroll: { offset: 0, bodyRows: 11 } })
  const ui = await $.ui.mount({ plugin: 'ostrakon', surface: 'terminal', ...PANE, props: inline(100) })
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /^ ~\/Work\/cc · 12m ago · this project · 2 open$/ })).toBeDefined()
  await ui.redraw(inline(60))
  expect(await ui.find({ type: 'Text', text: /^ this project · 2 open$/ })).toBeDefined()
  await ui.unmount()
})

test('the key sheet pages to fit the inline body, j and k turning the pages round, i closing it', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const props = { ...PANE.props, placement: 'inline' as const, bodyColumns: 40, scroll: { offset: 0, bodyRows: 11 } }
  const ui = await $.ui.mount({ plugin: 'ostrakon', surface: 'terminal', ...PANE, props })
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-i' })
  // 11 rows less the search row, the footer and the frame: 7 a page, so 22 keys and the symbols
  // (a title and 6 lines) take 5. Opened on a row, its own seven keys (copy the last but
  // one) are the first page.
  expect(await ui.find({ type: 'Text', text: /^copy$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ close keys$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ more 1\/5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^jump to a row$/ })).toBeUndefined()
  await ui.press({ key: 'key-j' })
  expect(await ui.find({ type: 'Text', text: /^jump to a row$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^copy$/ })).toBeUndefined()
  await ui.press({ key: 'key-k' })
  await ui.press({ key: 'key-k' })
  expect(await ui.find({ type: 'Text', text: /^ more 5\/5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^folded group$/ })).toBeDefined()
  await ui.press({ key: 'key-k' })
  expect(await ui.find({ type: 'Text', text: /^jot from the prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^symbols$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^from the phone$/ })).toBeDefined()
  // At 40 columns the sheet is narrower than its 46, and no label line is wider than the pane.
  for (const text of await texts(ui)) expect(text.length).toBeLessThanOrEqual(39)
  await ui.press({ key: 'key-i' })
  expect(await ui.find({ type: 'Text', text: /^ close keys$/ })).toBeUndefined()
  await ui.press({ key: 'key-i' })
  expect(await ui.find({ type: 'Text', text: /^ more 1\/5$/ })).toBeDefined()
  await ui.unmount()
})

// An element as the tests read the drawn tree.
type Drawn = { type: string; props?: Record<string, unknown>; children?: unknown[] }
// A drawn element's text, nested Texts and all; a Button draws its label.
const textOf = (node: unknown): string => {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object' || node === null) return ''
  const { type, props = {}, children = [] } = node as Drawn
  if (type === 'Button') return String(props.label ?? '')
  return children.map(textOf).join('')
}

// Rows a drawn element takes, for the column layouts the pane's states draw: a Text is a row, a
// Box its fixed height, or its rows (summed down a column, the tallest across a row), padding and
// border (a quote border is only a bar down the left).
const rowsOf = (node: unknown): number => {
  if (typeof node !== 'object' || node === null) return 0
  const { type, props = {}, children = [] } = node as Drawn
  if (type === 'Text' || type === 'Button' || type === 'Input') return 1
  if (props.display === 'none' || props.position === 'absolute') return 0
  if (typeof props.height === 'number') return props.height
  const inner = children.map(rowsOf)
  const content = props.flexDirection === 'column' ? inner.reduce((sum, rows) => sum + rows, 0) : Math.max(0, ...inner)
  const pad = 2 * Number(props.paddingY ?? 0) + (props.borderStyle !== undefined && props.borderStyle !== 'quote' ? 2 : 0)
  return Math.max(content + pad, Number(props.minHeight ?? 0))
}
// The footer's row in the pane: the rows of what's above it.
const footerRow = async (ui: Awaited<ReturnType<typeof mountPane>>) => {
  const [root] = await ui.findAll({ type: 'Box' })
  const children = (root?.children ?? []) as Drawn[]
  // A child's key is in its props; only what find returns carries it as `key`.
  const at = children.findIndex(child => child.props?.key === FOOTER_KEY)
  expect(at).toBeGreaterThan(-1)
  const above = children
    .slice(0, at)
    .map(rowsOf)
    .reduce((sum, rows) => sum + rows, 0)
  return above + rowsOf(children[at]) - 1
}

test("docked, the footer keeps the body's last row with notes and with no match", async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  const last = PANE.props.scroll.bodyRows - 1
  expect(await footerRow(ui)).toBe(last)
  await ui.input({ key: 'q', text: 'kubernetes', kind: 'change' })
  expect(await footerRow(ui)).toBe(last)
  // The no-match line is indented one, as the note rows are.
  const boxes = await ui.findAll({ type: 'Box' })
  const noMatch = boxes.find(box =>
    (box.children as Drawn[]).some(child => child.type === 'Text' && /^No notes match/.test(String((child.children ?? []).join('')))),
  )
  expect(noMatch?.props.paddingLeft).toBe(1)
  await ui.unmount()
})

test("docked, the empty pane's footer keeps the body's last row too", async ($, on) => {
  await startSession($, on, new MemDir())
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^Nothing pending in cc\.$/ })).toBeDefined()
  expect(await footerRow(ui)).toBe(PANE.props.scroll.bodyRows - 1)
  await ui.unmount()
})

// Redraws the pane docked at `bodyRows` by `bodyColumns`.
const dockAt = async (ui: Awaited<ReturnType<typeof mountPane>>, bodyRows: number, bodyColumns: number = PANE.props.bodyColumns) => {
  const props = { ...PANE.props, bodyColumns, scroll: { offset: 0, bodyRows } }
  await ui.redraw(props)
  await ui.redraw(props)
}
// Rows what sits between the search row and the footer would take past the room it's cut to.
const spill = async (ui: Awaited<ReturnType<typeof mountPane>>) => {
  const [root] = await ui.findAll({ type: 'Box' })
  const middle = ((root?.children ?? []) as Drawn[]).find(child => child.props?.overflow === 'hidden')
  return rowsOf(middle?.children?.[0]) - Number(middle?.props?.height ?? 0)
}

test('docked, the footer fits as many key pairs as the width allows, none cut', async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  const shown = async (bodyColumns: number) => {
    await dockAt(ui, 37, bodyColumns)
    const labels = [' to prompt', ' send', ' edit', ' archive', ' move', ' copy', ' pick', ' fold', ' history']
    const found = await Promise.all(labels.map(async label => (await ui.find({ type: 'Text', text: label })) !== undefined))
    return labels.filter((_, i) => found[i]).map(label => label.trim())
  }
  // The pane is a column narrower than the body, the line two narrower than the pane.
  expect(await shown(101)).toEqual(['to prompt', 'send', 'edit', 'archive', 'move', 'copy', 'pick', 'fold', 'history'])
  expect(await shown(65)).toEqual(['to prompt', 'send', 'edit', 'archive', 'move', 'copy'])
  expect(await shown(57)).toEqual(['to prompt', 'send', 'edit', 'archive', 'move'])
  expect(await shown(41)).toEqual(['to prompt', 'send', 'edit'])
  expect(await ui.find({ type: 'Text', text: ' keys' })).toBeDefined()
  await ui.unmount()
})

test("docked at short heights, the footer keeps the body's last row with notes, no match or capture", async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  const everyHeight = async (check?: (bodyRows: number) => Promise<void>) => {
    for (let bodyRows = 8; bodyRows <= 17; bodyRows += 1) {
      await dockAt(ui, bodyRows)
      expect(await footerRow(ui)).toBe(bodyRows - 1)
      await check?.(bodyRows)
    }
  }
  // The rows and the no-match block fit the room, so nothing is cut. At 8 rows the no-match block's
  // bottom padding is.
  const fits = async (bodyRows: number) => expect(await spill(ui)).toBeLessThanOrEqual(bodyRows > 8 ? 0 : 1)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await everyHeight(fits)
  await ui.input({ key: 'q', text: Array.from({ length: 40 }, (_, i) => `nomatch${i}`).join(' '), kind: 'change' })
  await everyHeight(fits)
  await dockAt(ui, 37)
  await ui.press({ key: 'key-pane:next' })
  for (const text of ['first idea', 'second idea', 'third idea']) await ui.input({ key: 'capture', text, kind: 'submit' })
  await ui.input({ key: 'capture', text: Array.from({ length: 120 }, (_, i) => `word${i}`).join(' '), kind: 'change' })
  // From 14 rows capture keeps its hint, the newest save and the draft's end, nothing cut.
  await everyHeight(async bodyRows => {
    if (bodyRows < 14) return
    expect(await spill(ui)).toBeLessThanOrEqual(0)
    expect((await texts(ui)).some(text => /saves to/.test(text))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /third idea/ })).toBeDefined()
    expect((await texts(ui)).some(text => /word119$/.test(text))).toBe(true)
  })
  await ui.unmount()
})

test("docked at short heights, editing a note in a long list keeps the draft's end and the footer", async ($, on) => {
  const dir = new MemDir()
  for (let i = 10; i < 40; i += 1) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFGH${i}`, `note number ${i}`, CC, i)
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  for (let i = 0; i < 12; i += 1) await ui.press({ key: 'key-j' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: `${Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ')} TAIL`, kind: 'change' })
  for (let bodyRows = 15; bodyRows <= 20; bodyRows += 1) {
    await dockAt(ui, bodyRows)
    expect(await footerRow(ui)).toBe(bodyRows - 1)
    expect(await spill(ui)).toBeLessThanOrEqual(0)
    expect((await texts(ui)).some(text => /TAIL$/.test(text))).toBe(true)
    // Each of the draft's lines is one row: wrapped to the indented preview's width, none runs past it.
    const boxes = (await ui.findAll({ type: 'Box' })) as Drawn[]
    const preview = boxes.find(box => box.props?.paddingLeft === TEXT_COLUMN)
    const lines = (preview?.children ?? []).map(textOf).filter(text => text.startsWith(GLYPH.quote))
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(Number(preview?.props?.width) - TEXT_COLUMN)
  }
  await ui.unmount()
})

test('docked from 9 rows, the move picker keeps a place on screen, and its height while typing', async ($, on) => {
  const dir = new MemDir()
  for (let i = 10; i < 40; i += 1) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFGH${i}`, `note number ${i}`, CC, i)
  for (const [i, name] of ['infra', 'api', 'web', 'docs', 'ops', 'data'].entries()) {
    put(dir, `01JA7K2M3Q9X4ZB6C8D0EFGP${i}`, `a note for ${name}`, { key: `github.com/me/${name}`, name, path: `/home/me/code/${name}` }, 50 + i)
  }
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  for (let i = 0; i < 12; i += 1) await ui.press({ key: 'key-j' })
  await ui.press({ key: 'key-m' })
  const middleRows = async () => {
    const [root] = await ui.findAll({ type: 'Box' })
    const middle = ((root?.children ?? []) as Drawn[]).find(child => child.props?.overflow === 'hidden')
    return rowsOf(middle?.children?.[0])
  }
  for (let bodyRows = 8; bodyRows <= 22; bodyRows += 1) {
    await ui.input({ key: 'move', text: '', kind: 'change' })
    await dockAt(ui, bodyRows)
    expect(await footerRow(ui)).toBe(bodyRows - 1)
    // At 8 rows a row and its two counts leave the field no room for a place under it.
    expect(await spill(ui)).toBeLessThanOrEqual(bodyRows > 8 ? 0 : 1)
    expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
    const before = await middleRows()
    await ui.input({ key: 'move', text: 'zzz', kind: 'change' })
    expect(await middleRows()).toBe(before)
  }
  await ui.unmount()
})

test('docked in a very short body, a failed capture save still says why', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'first idea', kind: 'submit' })
  dir.failWrites = true
  await ui.input({ key: 'capture', text: 'second idea', kind: 'submit' })
  for (let bodyRows = 9; bodyRows <= 14; bodyRows += 1) {
    await dockAt(ui, bodyRows)
    expect(await spill(ui)).toBeLessThanOrEqual(0)
    expect((await texts(ui)).some(text => /EROFS/.test(text))).toBe(true)
  }
  await ui.unmount()
})

test('docked at short heights, the bundle keeps its send button and the note list gives up lines', async ($, on) => {
  const dir = new MemDir()
  for (let i = 10; i < 15; i += 1) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFGH${i}`, `note number ${i}`, CC, i)
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  for (let i = 0; i < 5; i += 1) {
    await ui.press({ key: 'key-v' })
    await ui.press({ key: 'key-j' })
  }
  await ui.press({ key: 'key-b' })
  expect(await ui.find({ type: 'Text', text: /5 notes into one prompt/ })).toBeDefined()
  // The header, the intro, the button and the footer take 4 rows, the blanks under the header and the
  // intro and above the button and the footer 4, and the notes the rest. At 8 the blank above the
  // button goes, so one `… and N more` line still fits.
  const notes: [bodyRows: number, shown: number][] = [
    [8, 1],
    [9, 1],
    [10, 2],
    [11, 3],
    [12, 4],
    [13, 5],
  ]
  for (const [bodyRows, shown] of notes) {
    await dockAt(ui, bodyRows)
    expect(await footerRow(ui)).toBe(bodyRows - 1)
    expect(await spill(ui)).toBeLessThanOrEqual(0)
    const labels = (await ui.findAll({ type: 'Button' })).map(found => (found.props as { label?: string }).label)
    expect(labels).toContain('send')
    const lines = (await texts(ui)).filter(text => /^- note number|^… and \d+ more$/.test(text))
    expect(lines.length).toBe(shown)
    if (shown < 5) expect(lines.at(-1)).toBe(`… and ${5 - shown + 1} more`)
  }
  await ui.unmount()
})

test("docked at short heights, the empty pane's footer keeps the body's last row", async ($, on) => {
  await startSession($, on, new MemDir())
  await run($, 'jot', '')
  const ui = await mountPane($)
  for (let bodyRows = 8; bodyRows <= 17; bodyRows += 1) {
    await dockAt(ui, bodyRows, 72)
    expect(await footerRow(ui)).toBe(bodyRows - 1)
  }
  await ui.unmount()
})

test('docked in a body too short for the preview and three rows besides, the preview goes', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  const at = async (bodyRows: number) => {
    const props = { ...PANE.props, scroll: { offset: 0, bodyRows } }
    await ui.redraw(props)
    await ui.redraw(props)
    return (await ui.find({ type: 'Text', text: /you · ~\/Work\/cc/ })) !== undefined
  }
  // The search row and a blank, the preview's 8, a row between ↑ and ↓ counts, the blank and the footer.
  expect(await at(15)).toBe(true)
  expect(await at(14)).toBe(false)
  expect(await ui.find({ type: 'Text', text: /rename the store helpers/ })).toBeDefined()
  await ui.unmount()
})

test("docked, the preview's bar starts in the note text's column, with no blank row added", async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  const boxes = (await ui.findAll({ type: 'Box' })) as Drawn[]
  // The selected row: the cells drawn before the box that holds its text.
  const row = boxes.find(box => box.props?.backgroundColor !== undefined && /check why the cache test is flaky/.test(textOf(box)))
  const kids = row?.children ?? []
  const at = kids.findIndex(child => /check why the cache test is flaky/.test(textOf(child)))
  expect(at).toBeGreaterThan(0)
  const column = cells(kids.slice(0, at).map(textOf).join(''))
  expect(column).toBe(TEXT_COLUMN)
  // The preview: its padding puts the bar there, and its height is what it was.
  const preview = boxes.find(box => box.props?.height === PREVIEW_ROWS && (box.children ?? []).some(child => textOf(child).startsWith(GLYPH.quote)))
  expect(preview?.props?.paddingLeft).toBe(column)
  const lines = (preview?.children ?? []).filter(child => textOf(child).startsWith(GLYPH.quote))
  expect(lines.map(textOf)).toEqual([`${GLYPH.quote} check why the cache test is flaky`, expect.stringMatching(new RegExp(`^${GLYPH.quote} you · ~/Work/cc`))])
  expect(preview?.children?.length).toBe(1 + lines.length)
  await ui.unmount()
})

test('docked and narrow, a preview cut at its sixth line still fits its row', async ($, on) => {
  const dir = new MemDir()
  // Seven lines that each fill the preview's 30 cells at 40 columns.
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', Array.from({ length: 7 }, (_, i) => `line${i} abcdefghij abcdefghijklm`).join('\n'), CC, 1)
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  const props = { ...PANE.props, bodyColumns: 40 }
  await ui.redraw(props)
  await ui.redraw(props)
  const boxes = (await ui.findAll({ type: 'Box' })) as Drawn[]
  const preview = boxes.find(box => box.props?.height === PREVIEW_ROWS && (box.children ?? []).some(child => textOf(child).startsWith(GLYPH.quote)))
  const room = Number(preview?.props?.width) - TEXT_COLUMN
  const lines = (preview?.children ?? []).map(textOf).filter(text => text.startsWith(GLYPH.quote))
  expect(room).toBe(32)
  expect(lines[0]).toBe(`${GLYPH.quote} line0 abcdefghij abcdefghijklm`)
  for (const line of lines) expect(cells(line)).toBeLessThanOrEqual(room)
  expect(lines[5]).toBe(`${GLYPH.quote} line5 abcdefghij abcdefghijkl${GLYPH.more}`)
  await ui.unmount()
})

test('at the shortest heights the key sheet drops its frame and stays off the footer', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-i' })
  // The sheet's last row, frame and all, is above the footer's, the body's last.
  const sheetAt = async (placement: 'dock' | 'inline', bodyRows: number) => {
    const props = { ...PANE.props, placement, scroll: { offset: 0, bodyRows } }
    await ui.redraw(props)
    await ui.redraw(props)
    const sheet = (await ui.findAll({ type: 'Box' })).find(box => box.props.position === 'absolute')
    const isFramed = sheet?.props.borderStyle !== undefined
    const lines = (sheet?.children ?? []).length
    expect(Number(sheet?.props.top) + lines + (isFramed ? 2 : 0)).toBeLessThanOrEqual(bodyRows - 1)
    return { isFramed, lines }
  }
  expect(await sheetAt('dock', 6)).toEqual({ isFramed: true, lines: 1 })
  expect(await sheetAt('dock', 5)).toEqual({ isFramed: false, lines: 2 })
  expect(await sheetAt('inline', 5)).toEqual({ isFramed: true, lines: 1 })
  expect(await sheetAt('inline', 4)).toEqual({ isFramed: false, lines: 2 })
  expect(await ui.find({ type: 'Text', text: /^ close keys$/ })).toBeDefined()
  await ui.unmount()
})

test("opened on a row, the key sheet leads with the row's own keys and the row stays put", async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-i' })
  const lead = ['⏎ / t', 's', 'e', 'd / u', 'm', 'y', 'v / x', '↑ ↓ j k']
  const keys = (await texts(ui)).map(text => text.trim()).filter(text => lead.includes(text))
  expect(keys).toEqual(lead)
  expect(await ui.find({ type: 'Text', text: /check why the cache test is flaky/ })).toBeDefined()
  await ui.unmount()
})

const THEME_ROW = { key: 'theme', label: 'Theme', kind: 'choice', provider: { plugin: 'engine', tier: 'core' }, isLocked: false } as const

test('project colours follow the theme: light, a 16-colour one, a custom theme by its base, and a change in /config', async ($, on) => {
  const theme = { value: 'light' }
  on('config.list', () => ({ value: [{ ...THEME_ROW, value: theme.value }] }))
  on('config.set', (_, e) => ({ value: e.value }))
  const dir = fixture()
  dir.put('/home/me/.claude/themes/paper.json', JSON.stringify({ name: 'Paper', base: 'light-daltonized' }))
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  // infra's dot on its heading, scope all; cc is this project, in the accent.
  const infraDot = async () => {
    await ui.redraw(PANE.props)
    return (await ui.findAll({ type: 'Text', text: GLYPH.dot })).map(dot => dot.props.color).find(colour => colour !== COLOUR.accent)
  }
  expect(await infraDot()).toBe('#6f3fd1')
  const set = async (value: string) => {
    await $.config.set({ key: 'theme', value, previous: '', provider: THEME_ROW.provider, origin: { kind: 'composer' } })
  }
  await set('dark-ansi')
  expect(await infraDot()).toBe('planMode')
  await set('custom:paper')
  expect(await infraDot()).toBe('#6f3fd1')
  // A custom theme whose file is gone draws as dark.
  await set('custom:gone')
  expect(await infraDot()).toBe('#b08cf5')
  await ui.unmount()
})

test('the empty pane names its scope and offers ctrl+n for a new note', async ($, on) => {
  await startSession($, on, new MemDir())
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^Nothing pending in cc\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^new note$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /open this pane/ })).toBeUndefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await ui.find({ type: 'Text', text: /^Nothing pending in any project\.$/ })).toBeDefined()
  await ui.unmount()
})

test('with nothing open here but history, the heading shows: ↓ reaches it and h shows the history', async ($, on) => {
  const dir = new MemDir()
  const stamp = '2026-10-09T11:00:00.000Z'
  const id = '01JA7K2M3Q9X4ZB6C8D0EFGH09'
  dir.put(`/data/notes/${id}.md`, serializeNote({ ...NOTE, status: 'archived', id, text: 'an old cc note', project: CC, created: stamp, updated: stamp }))
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^Nothing pending in cc\.$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^cc$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^0$/ })).toBeDefined()
  // The footer says how: ↓ to the heading, where `h` is history; ctrl+s names where it goes.
  expect(await ui.find({ type: 'Text', text: /^↓$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ history$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ all projects$/ })).toBeDefined()
  // Enter, as `⏎ to list` says, goes to the heading; there, `h` leads and nothing is to fold.
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /^ fold$/ })).toBeUndefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: /an old cc note/ })).toBeDefined()
  await ui.unmount()
})

test('with no history here, the empty pane stays, and ctrl+s names where it goes', async ($, on) => {
  await startSession($, on, new MemDir())
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^Nothing pending in cc\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ all projects$/ })).toBeDefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await ui.find({ type: 'Text', text: /^ this project$/ })).toBeDefined()
  await ui.unmount()
})

test('g goes to the top row, and pressed there to the bottom', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-j' })
  expect(await ui.find({ type: 'Text', text: /^ to prompt$/ })).toBeDefined()
  // The top row is cc's heading, whose footer leads with fold, not a note's actions.
  await ui.press({ key: 'key-g' })
  expect(await ui.find({ type: 'Text', text: /^ to prompt$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ fold$/ })).toBeDefined()
  // The bottom row is infra's one note: d archives that one.
  await ui.press({ key: 'key-g' })
  await ui.press({ key: 'key-d' })
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03').status).toBe('archived')
  await ui.unmount()
})

test('with harvest on, the empty pane says Claude can leave notes', { options: { harvest: true } }, async ($, on) => {
  await startSession($, on, new MemDir())
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /^Claude can leave notes for you$/ })).toBeDefined()
  await ui.unmount()
})

// A third project, so typing has something to narrow.
const API = { key: 'github.com/me/api', name: 'api', path: '/home/me/code/api' }

// The move picker on the flaky note (this project's), with the list searched everywhere so the
// note stays listed once it moves.
const movingFlaky = async ($: Engine, on: Parameters<typeof startSession>[1]) => {
  const dir = fixture()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH05', 'pin the api client', API, 30)
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: 'flaky', kind: 'change' })
  await ui.input({ key: 'q', text: 'flaky', kind: 'submit' })
  await ui.press({ key: 'key-m' })
  return { dir, world, ui }
}

test("m offers every place but the note's own, and Enter with nothing typed moves to the first", async ($, on) => {
  const { dir, ui } = await movingFlaky($, on)
  expect(await ui.find({ type: 'Input', key: 'move' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^api$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^unfiled$/ })).toBeDefined()
  // cc, where the note is, isn't offered: infra is first (the row's header names cc, so it can't
  // be looked for).
  await ui.input({ key: 'move', text: '', kind: 'submit' })
  expect(savedFile(dir, 'flaky')).toContain(INFRA.key)
  await ui.unmount()
})

test('in the move picker, typing narrows the places and Enter moves the note to the first, selected', async ($, on) => {
  const { dir, world, ui } = await movingFlaky($, on)
  await ui.input({ key: 'move', text: 'INF', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^api$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^unfiled$/ })).toBeUndefined()
  await ui.input({ key: 'move', text: 'INF', kind: 'submit' })
  expect(savedFile(dir, 'flaky')).toContain(INFRA.key)
  expect(world.toasts.some(toast => toast.includes('infra'))).toBe(true)
  expect(await ui.find({ type: 'Input', key: 'move' })).toBeUndefined()
  // The moved note is the selected row: e edits it.
  await ui.press({ key: 'key-e' })
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('check why the cache test is flaky')
  await ui.unmount()
})

test("a note moved out of this project's list leaves the line that took its place selected", async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-m' })
  await ui.input({ key: 'move', text: 'infra', kind: 'submit' })
  expect(savedFile(dir, 'flaky')).toContain(INFRA.key)
  expect(await ui.find({ type: 'Text', text: /check why the cache test is flaky/ })).toBeUndefined()
  await ui.press({ key: 'key-e' })
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('rename the store helpers')
  await ui.unmount()
})

test('in the move picker, nothing matching, Enter keeps the picker and the typed text', async ($, on) => {
  const { dir, ui } = await movingFlaky($, on)
  await ui.input({ key: 'move', text: 'zzz', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /No project matches/ })).toBeDefined()
  await ui.input({ key: 'move', text: 'zzz', kind: 'submit' })
  const picker = await ui.find({ type: 'Input', key: 'move' })
  expect(((picker?.props as { value?: string } | undefined)?.value ?? '').trim()).toBe('zzz')
  expect(savedFile(dir, 'flaky')).toContain(CC.key)
  await ui.unmount()
})

// The keys of the controls the ring stops on, in the order it visits them: the action layer, a
// `display: 'none'` Box, isn't one.
const ringOf = (node: unknown): string[] => {
  if (typeof node !== 'object' || node === null) return []
  const { type, props, children } = node as Drawn
  if (type === 'Box' && props?.display === 'none') return []
  if (type === 'Button' || type === 'Input' || type === 'Select') return [String(props?.key)]
  return (children ?? []).flatMap(ringOf)
}

// The terminal keeps the ring at its place in this order across a redraw: a row added above the
// move picker or the edit card would leave the ring on that row, the picker closed and what was
// typed in it gone, or the card's typing going to the list.
for (const [press, control] of [
  ['key-m', 'move'],
  ['key-e', 'edit'],
] as const) {
  test(`a note arriving above the ${control} control leaves it at its place in the ring`, async ($, on) => {
    const dir = fixture()
    const { clock } = await startSession($, on, dir)
    await run($, 'jot', '')
    const ui = await mountPane($)
    await ui.input({ key: 'q', text: '', kind: 'submit' })
    await ui.press({ key: press })
    const before = ringOf(await ui.drawn())
    expect(before).toContain(control)
    put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH04', 'a newer one from the phone', CC, 1)
    await clock.advance(2100)
    expect(await ui.find({ type: 'Text', text: /a newer one from the phone/ })).toBeDefined()
    const after = ringOf(await ui.drawn())
    expect(after.indexOf(control)).toBe(before.indexOf(control))
    await ui.unmount()
  })
}

test('a narrow docked empty pane drops the shard before cutting the ways in', async ($, on) => {
  await startSession($, on, new MemDir())
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /╲▁▁▁/ })).toBeDefined()
  await ui.redraw({ ...PANE.props, bodyColumns: 56 })
  expect(await ui.find({ type: 'Text', text: /╲▁▁▁/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^jot a note from the prompt, even mid-turn$/ })).toBeDefined()
  await ui.unmount()
})

test('in capture, ctrl+s opens a picker: typing narrows the projects and Enter picks the first, the draft kept', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'bump the base image', kind: 'change' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await ui.find({ type: 'Text', text: /save to/ })).toBeDefined()
  // This project, unfiled, then the others; capture saves to this project until one is picked.
  expect(await ui.find({ type: 'Text', text: /^cc$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^unfiled$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
  await ui.input({ key: 'target', text: 'inf', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^unfiled$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^cc$/ })).toBeUndefined()
  await ui.input({ key: 'target', text: 'inf', kind: 'submit' })
  const field = await ui.find({ type: 'Input', key: 'capture' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('bump the base image')
  expect(await ui.find({ type: 'Text', text: /saves to infra/ })).toBeDefined()
  await ui.input({ key: 'capture', text: 'bump the base image', kind: 'submit' })
  expect(savedFile(dir, 'bump the base image')).toContain(INFRA.key)
  await ui.unmount()
})

test("the picker's ctrl+s goes back to capture with the target as it was; nothing matching, Enter stays", async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'half a thought', kind: 'change' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'target', text: 'zzz', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /No project matches/ })).toBeDefined()
  await ui.input({ key: 'target', text: 'zzz', kind: 'submit' })
  const picker = await ui.find({ type: 'Input', key: 'target' })
  expect(((picker?.props as { value?: string } | undefined)?.value ?? '').trim()).toBe('zzz')
  // The key sheet isn't offered over the picker, as over the move picker.
  expect(await ui.find({ type: 'Text', text: /^ctrl\+x i$/ })).toBeUndefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  const field = await ui.find({ type: 'Input', key: 'capture' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half a thought')
  expect(await ui.find({ type: 'Text', text: /saves to cc/ })).toBeDefined()
  await ui.unmount()
})

test('the picked target holds for the rest of the open, and a note started after a close goes to this project', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'target', text: 'infra', kind: 'submit' })
  await ui.input({ key: 'capture', text: 'first for infra', kind: 'submit' })
  // Back to search and into capture again: still infra.
  await ui.input({ key: 'capture', text: '', kind: 'submit' })
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'second for infra', kind: 'submit' })
  expect(savedFile(dir, 'second for infra')).toContain(INFRA.key)
  await ui.press({ key: 'key-pane:previous' })
  await run($, 'jot', '')
  await ui.press({ key: 'key-pane:next' })
  expect(await ui.find({ type: 'Text', text: /saves to cc/ })).toBeDefined()
  await ui.input({ key: 'capture', text: 'after the close', kind: 'submit' })
  expect(savedFile(dir, 'after the close')).toContain(CC.key)
  expect(savedFile(dir, 'after the close')).not.toContain(INFRA.key)
  await ui.unmount()
})

// One archived note of this project's: the list is its bare heading.
const historyOnly = () => {
  const dir = new MemDir()
  const stamp = '2026-10-09T11:00:00.000Z'
  const id = '01JA7K2M3Q9X4ZB6C8D0EFGH09'
  dir.put(`/data/notes/${id}.md`, serializeNote({ ...NOTE, status: 'archived', id, text: 'an old cc note', project: CC, created: stamp, updated: stamp }))
  return dir
}

test("the bare heading has no number, and pressing its row shows this project's history", async ($, on) => {
  await startSession($, on, historyOnly())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  // Row numbers go on notes only (1-9), so it's the row's own press that reaches the history.
  expect(await ui.find({ type: 'Text', text: /^1$/ })).toBeUndefined()
  await ui.press({ key: 'slot-0' })
  expect(await ui.find({ type: 'Text', text: /an old cc note/ })).toBeDefined()
  await ui.unmount()
})

test('a project folded before its last open note went shows its history on h', async ($, on) => {
  const dir = historyOnly()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  const { clock } = await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-j' })
  await ui.press({ key: 'key-g' })
  await ui.press({ key: 'key-z' })
  expect(await ui.find({ type: 'Text', text: /check why the cache test is flaky/ })).toBeUndefined()
  // Archived elsewhere: cc is left with only its history, under a bare heading.
  const flaky = noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01')
  dir.put('/data/notes/01JA7K2M3Q9X4ZB6C8D0EFGH01.md', serializeNote({ ...flaky, status: 'archived', updated: '2026-10-09T11:59:00.000Z' }))
  await clock.advance(2100)
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: /an old cc note/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /check why the cache test is flaky/ })).toBeDefined()
  await ui.unmount()
})

test('under a storage problem, the footer drops ↓ history: the problem row is first, not the heading', async ($, on) => {
  const dir = historyOnly()
  dir.put('/data/notes/broken.md', 'not a note')
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /1 unreadable file$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^cc$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^↓$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ history$/ })).toBeUndefined()
  await ui.unmount()
})

test('g on a list longer than the window scrolls to the bottom row and back to the top', async ($, on) => {
  const dir = new MemDir()
  for (let i = 0; i < 30; i += 1) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFG${String(i).padStart(3, '0')}`, `long list item ${i} end`, CC, i)
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await dockAt(ui, 14)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-j' })
  expect(await ui.find({ type: 'Text', text: /long list item 0 end/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /long list item 29 end/ })).toBeUndefined()
  await ui.press({ key: 'key-g' })
  await ui.press({ key: 'key-g' })
  expect(await ui.find({ type: 'Text', text: /long list item 29 end/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /long list item 0 end/ })).toBeUndefined()
  await ui.press({ key: 'key-d' })
  expect(noteIn(dir, '01JA7K2M3Q9X4ZB6C8D0EFG029').status).toBe('archived')
  await ui.press({ key: 'key-g' })
  expect(await ui.find({ type: 'Text', text: /long list item 0 end/ })).toBeDefined()
  await ui.unmount()
})

test('ctrl+x tab from the target picker gives the prompt the keys, and capture comes back with its draft', async ($, on) => {
  const { world } = await startSession($, on, fixture(), 'my draft')
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.input({ key: 'capture', text: 'half a thought', kind: 'change' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'target', text: 'inf', kind: 'change' })
  await ui.press({ key: 'key-switch' })
  expect(world.box.text).toBe('my draft')
  expect(world.openFocus).toEqual([true, false])
  await ui.redraw({ ...PANE.props, isFocused: false })
  expect(await ui.find({ type: 'Input', key: 'target' })).toBeUndefined()
  await ui.press({ key: 'key-switch' })
  await ui.redraw({ ...PANE.props, isFocused: true })
  const field = await ui.find({ type: 'Input', key: 'capture' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half a thought')
  // Nothing was picked: capture still saves to this project.
  expect(await ui.find({ type: 'Text', text: /saves to cc/ })).toBeDefined()
  await ui.unmount()
})

test('closed from the target picker, the pane opens on the list, and capture saves to this project again', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir, 'my draft')
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'target', text: 'infra', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /saves to infra/ })).toBeDefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.press({ key: 'key-pane:previous' })
  expect(world.closed).toBe(1)
  expect(world.box.text).toBe('my draft')
  await run($, 'jot', '')
  expect(await ui.find({ type: 'Input', key: 'target' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /rename the store helpers/ })).toBeDefined()
  await ui.press({ key: 'key-pane:next' })
  expect(await ui.find({ type: 'Text', text: /saves to cc/ })).toBeDefined()
  await ui.input({ key: 'capture', text: 'after the picker closed', kind: 'submit' })
  expect(savedFile(dir, 'after the picker closed')).toContain(CC.key)
  await ui.unmount()
})

test('picking unfiled in the target picker saves the note with no project', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'target', text: 'unf', kind: 'submit' })
  expect(await ui.find({ type: 'Text', text: /saves to unfiled/ })).toBeDefined()
  await ui.input({ key: 'capture', text: 'a loose thought', kind: 'submit' })
  const saved = [...dir.files.values()].find(file => file.text.includes('a loose thought'))?.text ?? ''
  expect(saved).not.toBe('')
  expect(saved).not.toContain(CC.key)
  expect(saved).not.toContain(INFRA.key)
  await ui.unmount()
})

test('u after a move puts the note back in its project', async ($, on) => {
  const { dir, world, ui } = await movingFlaky($, on)
  await ui.input({ key: 'move', text: 'infra', kind: 'submit' })
  expect(savedFile(dir, 'flaky')).toContain(INFRA.key)
  await ui.press({ key: 'key-u' })
  expect(savedFile(dir, 'flaky')).toContain(CC.key)
  expect(savedFile(dir, 'flaky')).not.toContain(INFRA.key)
  expect(world.toasts.at(-1)).toMatch(/undone/i)
  await ui.unmount()
})

test("moving this project's last note away leaves the empty pane", async ($, on) => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'add a cache invalidation metric', INFRA, 90)
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-m' })
  await ui.input({ key: 'move', text: 'infra', kind: 'submit' })
  expect(savedFile(dir, 'flaky')).toContain(INFRA.key)
  expect(await ui.find({ type: 'Text', text: /^Nothing pending in cc\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /check why the cache test is flaky/ })).toBeUndefined()
  await ui.unmount()
})

test('the edit card draws its [ esc back ] button', async ($, on) => {
  await startSession($, on, fixture())
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  const back = await ui.find({ type: 'Button', key: 'edit-cancel' })
  expect((back?.props as { label?: string } | undefined)?.label).toBe('esc back')
  await ui.unmount()
})

test('with a capture target picked, an edit closed and reopened comes back, and a new note goes to this project', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.press({ key: 'key-pane:next' })
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  await ui.input({ key: 'target', text: 'infra', kind: 'submit' })
  await ui.input({ key: 'capture', text: '', kind: 'submit' })
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-e' })
  await ui.input({ key: 'edit', text: 'half-edited text', kind: 'change' })
  await ui.press({ key: 'key-pane:previous' })
  await run($, 'jot', '')
  const field = await ui.find({ type: 'Input', key: 'edit' })
  expect((field?.props as { value?: string } | undefined)?.value).toBe('half-edited text')
  await ui.press({ key: 'edit-cancel' })
  await ui.press({ key: 'key-pane:next' })
  expect(await ui.find({ type: 'Text', text: /saves to cc/ })).toBeDefined()
  await ui.input({ key: 'capture', text: 'after the reopen', kind: 'submit' })
  expect(savedFile(dir, 'after the reopen')).toContain(CC.key)
  await ui.unmount()
})
