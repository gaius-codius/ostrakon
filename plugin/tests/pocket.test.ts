import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { serializeNote } from '../src/frontmatter'
import { MemDir } from './memdir'
import { MS } from '../src/ui/look'
import { CC, INFRA, NOTE, noteIn, put, run, startSession } from './world'

const ONE = '01JA7K2M3Q9X4ZB6C8D0EFGH01'
const TWO = '01JA7K2M3Q9X4ZB6C8D0EFGH02'
const OTHER = '01JA7K2M3Q9X4ZB6C8D0EFGH03'
const PROPOSED = '01JA7K2M3Q9X4ZB6C8D0EFGH04'
const PROPOSED_TOO = '01JA7K2M3Q9X4ZB6C8D0EFGH05'

const BAND = {
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const fixture = () => {
  const dir = new MemDir()
  put(dir, ONE, 'check why the cache test is flaky', CC, 12)
  put(dir, TWO, 'rename the store helpers', CC, 60)
  put(dir, OTHER, 'add a cache invalidation metric', INFRA, 90)
  return dir
}

// What Claude left in a turn: `turnId` ties it to that turn; without one it counts for the
// session and time it was made in. Overrides turn it into someone else's or another project's.
const propose = (
  dir: MemDir,
  id: string,
  text: string,
  own: { turnId?: string; sessionId?: string; created?: string; by?: 'claude' | 'you'; project?: typeof CC | typeof INFRA } = {},
) => {
  const created = own.created ?? '2099-01-01T00:00:00.000Z'
  dir.put(
    `/data/notes/${id}.md`,
    serializeNote({
      ...NOTE,
      id,
      text,
      project: own.project ?? CC,
      by: own.by ?? 'claude',
      status: 'proposed',
      context: { turnId: own.turnId, sessionId: own.turnId === undefined ? (own.sessionId ?? 'sess-1') : undefined },
      created,
      updated: created,
    }),
  )
}

const TURN_DONE = { answer: 'done', durationMs: 5, isAborted: false, turnId: 'turn-1', reason: 'answer' } as const

const mountBand = ($: Engine, props: Partial<{ hasSurvey: boolean; isWorking: boolean }> = {}, bodyColumns = 120) =>
  $.ui.mount({ plugin: 'ostrakon', surface: 'terminal', ...BAND, props: { ...BAND.props, bodyColumns, ...props } })

type Band = Awaited<ReturnType<typeof mountBand>>

const buttons = async (ui: Band) =>
  (await ui.findAll({ type: 'Button' })).map(found => {
    const props = found.props as { label?: string; hotkey?: string }
    return { key: found.key, label: props.label, hotkey: props.hotkey }
  })

// Which of the band's Buttons draw dim, by key.
const dims = async (ui: Band) =>
  Object.fromEntries((await ui.findAll({ type: 'Button' })).map(found => [found.key, (found.props as { dimColor?: boolean }).dimColor === true]))

const composer = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

test('the band draws the opener, then this project\'s open notes as numbered chips, newest first', async ($, on) => {
  await startSession($, on, fixture())
  const ui = await mountBand($)
  expect(await buttons(ui)).toEqual([
    { key: 'band-open', label: '✎ cc', hotkey: undefined },
    { key: 'band-chip-1', label: 'check why the cache…', hotkey: '1' },
    { key: 'band-chip-2', label: 'rename the store helpers', hotkey: '2' },
  ])
  await ui.unmount()
})

test('a note from another project is not in the pocket', async ($, on) => {
  await startSession($, on, fixture())
  const ui = await mountBand($)
  expect((await buttons(ui)).some(button => button.label?.includes('invalidation'))).toBe(false)
  await ui.unmount()
})

test('with a survey up the band draws only what the hook below gave', async ($, on) => {
  await startSession($, on, fixture())
  const ui = await mountBand($, { hasSurvey: true })
  expect(await buttons(ui)).toEqual([])
  await ui.unmount()
})

test('chip 2 with a lone 2 in the prompt puts exactly the note there, and the submit marks it sent', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir, '2')
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-2' })
  await clock.advance(10)
  expect(world.box.text).toBe('rename the store helpers')
  expect(world.toasts).toContain('note 2 in your prompt · ⏎ to send')
  expect(noteIn(dir, TWO).status).toBe('open')

  await composer($, world.box.text)
  const sent = noteIn(dir, TWO)
  expect(sent.status).toBe('sent')
  expect(sent.sentAt).not.toBeNull()
  expect(sent.context.sentSessionId).toBe('sess-1')
  expect(noteIn(dir, ONE).status).toBe('open')
  await ui.unmount()
})

test('a draft other than the digit stays, with the note after a blank line', async ($, on) => {
  const { world, clock } = await startSession($, on, fixture(), 'my draft')
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  expect(world.box.text).toBe('my draft\n\ncheck why the cache test is flaky')
  await ui.unmount()
})

test('a turn that starts inside the submit, before the note is marked sent, still ends with the note sent', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir, '1')
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  world.turnOnSubmit = 'turn-5'
  await composer($, world.box.text)
  const sent = noteIn(dir, ONE)
  expect(sent.status).toBe('sent')
  expect(sent.sentAt).not.toBeNull()
  await ui.unmount()
})

// A turn that leaves two proposals, both tied to the turn by its id.
const harvested = async ($: Engine, on: Parameters<typeof startSession>[1]) => {
  const dir = fixture()
  const started = await startSession($, on, dir)
  await $.turn.start({ text: 'do the thing', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'follow up on the flaky cache test', { turnId: 'turn-1', created: '2020-01-01T00:00:00.000Z' })
  propose(dir, PROPOSED_TOO, 'document the store helpers', { turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  const ui = await mountBand($)
  return { dir, ui, ...started }
}

test('after a turn that proposed notes the band shows the harvest row instead of the pocket', async ($, on) => {
  const { ui } = await harvested($, on)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  expect(await buttons(ui)).toEqual([
    { key: 'band-open', label: '✎ cc', hotkey: undefined },
    { key: 'band-chip-1', label: 'follow up on the…', hotkey: '1' },
    { key: 'band-chip-2', label: 'document the store…', hotkey: '2' },
    { key: 'band-keep-all', label: 'keep all', hotkey: '0' },
  ])
  await ui.unmount()
})

test('proposals made before the turn started are not its harvest', async ($, on) => {
  const dir = fixture()
  propose(dir, PROPOSED, 'an old proposal', { turnId: 'turn-0', created: '2020-01-01T00:00:00.000Z' })
  await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await ui.unmount()
})

test('pressing a harvest digit keeps that note, the other stays proposed', async ($, on) => {
  const { dir, ui, world, clock } = await harvested($, on)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  expect(noteIn(dir, PROPOSED).status).toBe('open')
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('proposed')
  expect(world.toasts).toContain('Kept')
  await ui.unmount()
})

test('keep all keeps every proposal of the turn', async ($, on) => {
  const { dir, ui, world, clock } = await harvested($, on)
  await ui.press({ key: 'band-keep-all' })
  await clock.advance(10)
  expect(noteIn(dir, PROPOSED).status).toBe('open')
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('open')
  expect(world.toasts).toContain('Kept 2 notes')
  await ui.unmount()
})

test('the next turn with text clears the harvest and leaves unkept proposals proposed; a command that starts no turn does not', async ($, on) => {
  const { dir, ui, clock } = await harvested($, on)
  await composer($, '/jot')
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeDefined()

  await $.turn.start({ text: 'carry on', turnId: 'turn-2' })
  await clock.advance(10)
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  expect((await buttons(ui)).map(button => button.key)).toEqual(['band-open', 'band-chip-1', 'band-chip-2'])
  expect(noteIn(dir, PROPOSED).status).toBe('proposed')
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('proposed')
  await ui.unmount()
})

test('the harvest is this turn\'s: Claude\'s, this project\'s, by turn id (a note without one is no turn\'s)', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'in this turn', { turnId: 'turn-1' })
  propose(dir, PROPOSED_TOO, 'no turn id, this session', {})
  propose(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH06', 'by the person', { turnId: 'turn-1', by: 'you' })
  propose(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH07', 'in another project', { turnId: 'turn-1', project: INFRA })
  propose(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH08', 'an earlier turn', { turnId: 'turn-0' })
  propose(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH09', 'another session', { sessionId: 'sess-2' })
  propose(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH0A', 'before the turn began', { created: '2020-01-01T00:00:00.000Z' })
  await $.turn.complete(TURN_DONE)
  const ui = await mountBand($)
  expect((await buttons(ui)).filter(button => button.hotkey !== undefined && button.hotkey !== '0').map(button => button.label)).toEqual(['in this turn'])
  await ui.unmount()
})

test('a turn with text that proposes nothing ends with Pocket; a continuation with no text leaves the harvest up', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the first turn', { turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  await $.turn.start({ text: '', turnId: 'turn-2' })
  // Hidden while the continuation runs, back once it's over.
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-2' })
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()

  await $.turn.start({ text: 'and again', turnId: 'turn-3' })
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-3' })
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await ui.unmount()
})

// Holds writes to the band's turn facts that `match` picks, while armed, until `open` (the kit
// answers $.state beneath this hook), so other turns can start while they wait.
type TurnsWrite = { latest?: string; running?: string }
const heldWrites = (on: Parameters<typeof startSession>[1], match: (value: TurnsWrite) => boolean) => {
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  let held = 0
  let isArmed = false
  on('state.set', async (_, e, next) => {
    // The turns atom is shaped: its value is kept under a tag.
    const write = e as { key?: string; value?: { value?: TurnsWrite } }
    const value = write.value?.value
    if (isArmed && write.key === 'turns' && value !== undefined && match(value)) {
      held += 1
      await gate
    }
    return next(e)
  })
  const until = async (count: number) => {
    for (let i = 0; i < 1000 && held < count; i++) await Promise.resolve()
    expect(held).toBeGreaterThanOrEqual(count)
  }
  return {
    arm: () => (isArmed = true),
    until,
    open: () => {
      isArmed = false
      open()
    },
  }
}
const heldTurnEnd = (on: Parameters<typeof startSession>[1]) => {
  const held = heldWrites(on, value => value.running === '')
  return { ...held, arm: () => held.arm() }
}

test('a completion whose write waits doesn\'t lose the turn that starts meanwhile: that turn still collects its harvest', async ($, on) => {
  const dir = fixture()
  const held = heldTurnEnd(on)
  const { clock } = await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  held.arm()
  const first = $.turn.complete(TURN_DONE)
  await held.until(1)
  await clock.advance(1000)
  await $.turn.start({ text: 'and again', turnId: 'turn-2' })
  held.open()
  await first
  propose(dir, PROPOSED, 'from the second turn', { turnId: 'turn-2' })
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-2' })
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test('a completion for a turn the module never knew, whose write waits, doesn\'t end a turn that starts meanwhile', async ($, on) => {
  const dir = fixture()
  const held = heldTurnEnd(on)
  const { clock } = await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the turn', { turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  held.arm()
  const orphan = $.turn.complete({ ...TURN_DONE, turnId: 'turn-0' })
  await held.until(1)
  await clock.advance(1000)
  // A continuation starts: the harvest hides while it runs.
  await $.turn.start({ text: '', turnId: 'turn-2' })
  held.open()
  await orphan
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-2' })
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test('a session start whose write waits doesn\'t end a turn that starts meanwhile: the harvest stays hidden while it runs', async ($, on) => {
  const dir = fixture()
  const held = heldWrites(on, value => value.running === '')
  const { clock } = await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the turn', { turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  // A continuation ends; its write and a session start's (as a reload runs) wait together.
  await $.turn.start({ text: '', turnId: 'turn-2' })
  held.arm()
  const ending = $.turn.complete({ ...TURN_DONE, turnId: 'turn-2' })
  const starting = $.session.start({ cwd: '/home/me/Work/cc', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  await held.until(2)
  await $.turn.start({ text: '', turnId: 'turn-3' })
  held.open()
  await ending
  await starting
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-3' })
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test('a /clear whose write waits doesn\'t hide the harvest of the new conversation\'s first turn', async ($, on) => {
  const dir = fixture()
  const held = heldWrites(on, value => value.latest === '')
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await startSession($, on, dir)
  held.arm()
  const clearing = $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  await held.until(1)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the new conversation', { turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  held.open()
  await clearing
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test('a subagent\'s turn.complete, or one for a turn that isn\'t running, collects nothing and ends nothing', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the turn', { turnId: 'turn-1' })
  await $.turn.complete({ ...TURN_DONE, agentId: 'agent-1' })
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-0' })
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await $.turn.complete(TURN_DONE)
  await ui.redraw(BAND.props)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

// The hook's boundary: the completion is decided at entry, before the engine's next(e), so a turn
// that starts while the engine holds it doesn't take its place.
test('a completion the engine holds keeps its turn: a continuation starting meanwhile doesn\'t take it, and its harvest is still collected', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the first turn', { turnId: 'turn-1' })
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  const held: NonNullable<typeof world.heldCompletion> = { turnId: 'turn-1', gate }
  world.heldCompletion = held
  const completing = $.turn.complete(TURN_DONE)
  for (let i = 0; i < 1000 && held.isHeld !== true; i++) await Promise.resolve()
  expect(held.isHeld).toBe(true)
  await $.turn.start({ text: '', turnId: 'turn-2' })
  open()
  await completing
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-2' })
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test('keeping a proposal that was archived or kept elsewhere meanwhile changes nothing', async ($, on) => {
  const dir = fixture()
  const { clock, world } = await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-1' })
  propose(dir, PROPOSED, 'from the turn', { turnId: 'turn-1' })
  await $.turn.complete(TURN_DONE)
  const ui = await mountBand($)
  // Another session archives it after the band was drawn.
  dir.put(`/data/notes/${PROPOSED}.md`, dir.get(`/data/notes/${PROPOSED}.md`)?.replace('status: proposed', 'status: archived') ?? '')
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  expect(noteIn(dir, PROPOSED).status).toBe('archived')
  expect(world.toasts.filter(text => text.startsWith('Kept'))).toEqual([])
  await ui.unmount()
})

// A row entering the conversation, as the engine appends it.
const append = (
  $: Engine,
  text: string,
  row: { door: 'prompt' | 'delivery' | 'attachment' | 'tool-result'; role?: 'user' | 'assistant'; agentId?: string; name?: string } = { door: 'prompt' },
) =>
  $.session.append({
    message: { type: 'user', role: row.role ?? 'user', ...(row.name ? { name: row.name } : {}), content: [{ type: 'text', text }] },
    door: row.door,
    origin: { kind: 'composer' },
    uuid: `row-${text.length}-${row.door}`,
    ...(row.agentId ? { agentId: row.agentId } : {}),
  })

// A note in the prompt, sent from the band while turn-3 is running (so the submit is queued).
const queued = async ($: Engine, on: Parameters<typeof startSession>[1]) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir, '1')
  const ui = await mountBand($)
  await $.turn.start({ text: 'working on something', turnId: 'turn-3' })
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  const text = world.box.text
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  return { dir, ui, clock, text }
}

test('a prompt queued mid-turn leaves the note open until its delivery row enters, then marks it sent', async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  expect(noteIn(dir, ONE).status).toBe('open')
  await append($, text, { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  const sent = noteIn(dir, ONE)
  expect(sent.status).toBe('sent')
  expect(sent.context.sentSessionId).toBe('sess-1')
  await ui.unmount()
})

test('a queued prompt that is taken back (no row ever enters) leaves the note open', async ($, on) => {
  const { dir, ui, clock } = await queued($, on)
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-3' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('open')
  await ui.unmount()
})

test('a subagent\'s row, a tool result or an assistant row carrying the text never marks the note', async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  await append($, text, { door: 'delivery', agentId: 'agent-1' })
  await append($, text, { door: 'tool-result' })
  await append($, text, { door: 'prompt', role: 'assistant' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('open')
  // The person's own row still does.
  await append($, text, { door: 'delivery' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

test('an idle submit and the prompt row for the same text mark the note once', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir, '1')
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  const text = world.box.text
  await composer($, text)
  const first = noteIn(dir, ONE)
  expect(first.status).toBe('sent')
  await clock.advance(1000)
  await append($, text, { door: 'prompt' })
  await clock.advance(10)
  const after = noteIn(dir, ONE)
  expect(after.sentAt).toBe(first.sentAt)
  expect(after.updated).toBe(first.updated)
  await ui.unmount()
})

test('pocketMax sets how many chips the band offers', { options: { pocketMax: 2 } }, async ($, on) => {
  const dir = new MemDir()
  for (let i = 1; i <= 7; i++) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFGH2${i}`, `note ${i}`, CC, i)
  await startSession($, on, dir)
  const ui = await mountBand($)
  expect((await buttons(ui)).filter(button => button.key?.startsWith('band-chip-'))).toHaveLength(2)
  expect(await ui.find({ type: 'Button', key: 'band-more' })).toBeDefined()
  await ui.unmount()
})

test('a slow sent write that turns start during still ends with the note sent', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir, '1')
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  const text = world.box.text
  let release = () => {}
  dir.writeGate = new Promise<void>(resolve => (release = resolve))
  const submitted = composer($, text)
  await clock.advance(10)
  await $.turn.start({ text: 'something unrelated', turnId: 'turn-2' })
  await $.turn.start({ text, turnId: 'turn-3' })
  release()
  await submitted
  await clock.advance(10)
  const sent = noteIn(dir, ONE)
  expect(sent.status).toBe('sent')
  expect(sent.sentAt).not.toBeNull()
  await ui.unmount()
})

test('while a turn runs every chip, +N and the opener draw dim, and the digits still press', async ($, on) => {
  const dir = fixture()
  for (const i of [5, 6, 7, 8, 9, 10]) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFG${String(i).padStart(3, '0')}`, `another note ${i}`, CC, 100 + i)
  const { world, clock } = await startSession($, on, dir, '2')
  const ui = await mountBand($, { isWorking: true }, 80)
  const dim = await dims(ui)
  expect(Object.keys(dim)).toContain('band-more')
  expect(Object.values(dim).every(Boolean)).toBe(true)
  await ui.press({ key: 'band-chip-2' })
  await clock.advance(10)
  expect(world.box.text).toBe('rename the store helpers')
  // At rest only the opener and +N are dim.
  await ui.redraw({ ...BAND.props, bodyColumns: 80 })
  expect(Object.entries(await dims(ui)).filter(([, isDim]) => isDim).map(([key]) => key)).toEqual(['band-open', 'band-more'])
  await ui.unmount()
})

test('a note just saved stands out in the pocket for MS.fresh: its chip at full strength, the rest dim', async ($, on) => {
  const { clock } = await startSession($, on, fixture())
  const ui = await mountBand($)
  await run($, 'jot', 'buy milk')
  await ui.redraw(BAND.props)
  expect(await buttons(ui)).toContainEqual({ key: 'band-chip-1', label: 'buy milk', hotkey: '1' })
  expect(await dims(ui)).toEqual({ 'band-open': true, 'band-chip-1': false, 'band-chip-2': true, 'band-chip-3': true })
  await clock.advance(MS.fresh)
  await ui.redraw(BAND.props)
  expect(await dims(ui)).toEqual({ 'band-open': true, 'band-chip-1': false, 'band-chip-2': false, 'band-chip-3': false })
  await ui.unmount()
})

test('the harvest row is one line, with the hint under it for the first three harvests only, each counted once', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  const ui = await mountBand($)
  const hasHint = async () => (await ui.find({ type: 'Text', text: /keep one · 0 keep all/ })) !== undefined
  for (const i of [1, 2, 3, 4]) {
    await $.turn.start({ text: `go ${i}`, turnId: `turn-${i}` })
    propose(dir, `01JA7K2M3Q9X4ZB6C8D0EFGH1${i}`, `proposal ${i}`, { turnId: `turn-${i}` })
    await $.turn.complete({ ...TURN_DONE, turnId: `turn-${i}` })
    await ui.redraw(BAND.props)
    expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
    expect(await hasHint()).toBe(i <= 3)
    // Drawn again, or joined by a continuation, it's the same harvest: not counted again.
    await $.turn.start({ text: '', turnId: `turn-${i}b` })
    await $.turn.complete({ ...TURN_DONE, turnId: `turn-${i}b` })
    await ui.redraw(BAND.props)
    expect(await hasHint()).toBe(i <= 3)
  }
  await ui.unmount()
})
