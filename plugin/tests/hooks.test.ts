import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { serializeNote } from '../src/frontmatter'
import { MemDir } from './memdir'
import { CC, INFRA, NOTE, PANE, mountPane, noteIn, put, run, startSession, texts } from './world'

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rename the store helpers', CC, 60)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'add a cache invalidation metric', INFRA, 90)
  return dir
}

test('the pane opens on this project, searches everywhere once typing, and Enter saves a failed search', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await run($, 'jot', '')
  expect(world.opened).toBe(1)
  const ui = await mountPane($)
  expect(await ui.find({ type: 'Text', text: /this project · 2 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /rename the store helpers/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add a cache invalidation metric/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ctrl\+l$/ })).toBeDefined()

  await ui.input({ key: 'q', text: 'cache', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /all · 2 of 3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /add a cache invalidation metric/ })).toBeDefined()

  await ui.input({ key: 'q', text: 'kubernetes', kind: 'change' })
  expect(await ui.find({ type: 'Text', text: /No notes match “kubernetes” in any project/ })).toBeDefined()
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

test('d archives with an undo, and the list view groups by project with history on h', async ($, on) => {
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

  await ui.press({ key: 'key-l' })
  expect(await ui.find({ type: 'Text', text: /list · all · 3 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeDefined()
  await ui.press({ key: 'key-app:toggleDiffPreSession' })
  expect(await ui.find({ type: 'Text', text: /list · this project · 2 open/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^infra$/ })).toBeUndefined()
  await ui.unmount()
})

test('/jot saves at once; alone it opens the pane, where ctrl+n captures, saving and staying until an empty Enter', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await run($, 'jot', 'buy milk')
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

const composer = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('the person\'s next submit carrying a filled note marks it sent; after that the fill is spent', async ($, on) => {
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
test('a focus move waiting on the view is already the ring\'s last: the action layer meanwhile sends the ring back to it', async ($, on) => {
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
  // 11 rows less the search row, the footer and the frame: 7 a page, so 19 keys take 3.
  expect(await ui.find({ type: 'Text', text: /^jump to a row$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ close keys$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ more 1\/3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^copy$/ })).toBeUndefined()
  await ui.press({ key: 'key-j' })
  expect(await ui.find({ type: 'Text', text: /^copy$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^jump to a row$/ })).toBeUndefined()
  await ui.press({ key: 'key-k' })
  await ui.press({ key: 'key-k' })
  expect(await ui.find({ type: 'Text', text: /^ more 3\/3$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^jot from the prompt/ })).toBeDefined()
  // At 40 columns the sheet is narrower than its 46, and no label line is wider than the pane.
  for (const text of await texts(ui)) expect(text.length).toBeLessThanOrEqual(39)
  await ui.press({ key: 'key-i' })
  expect(await ui.find({ type: 'Text', text: /^ close keys$/ })).toBeUndefined()
  await ui.press({ key: 'key-i' })
  expect(await ui.find({ type: 'Text', text: /^ more 1\/3$/ })).toBeDefined()
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
