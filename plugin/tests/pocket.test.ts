import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { PromptEditInput, PromptEditResult } from 'claude-code'

import { serializeNote } from '../src/frontmatter'
import { MemDir } from './memdir'
import { MS } from '../src/ui/look'
import { SWITCH_KEY } from '../src/ui/band'
import { CC, INFRA, NOTE, PANE, mountPane, noteIn, put, run, startSession } from './world'

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

// The band's drawn Buttons: not the hidden one that carries ctrl+x tab (tests/handoff.test.ts).
const drawn = async (ui: Band) => (await ui.findAll({ type: 'Button' })).filter(found => found.key !== SWITCH_KEY)

const buttons = async (ui: Band) =>
  (await drawn(ui)).map(found => {
    const props = found.props as { label?: string; hotkey?: string }
    return { key: found.key, label: props.label, hotkey: props.hotkey }
  })

// Which of the band's Buttons draw dim, by key.
const dims = async (ui: Band) => Object.fromEntries((await drawn(ui)).map(found => [found.key, (found.props as { dimColor?: boolean }).dimColor === true]))

const composer = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

// The band's keys as drawn, in order: `;1`, `;2`, … and `;0` for keep all.
const keys = async (ui: Band) =>
  (await ui.findAll({ type: 'Text' })).map(found => String((found as { text?: unknown }).text ?? '')).filter(text => /^;\d$/.test(text))

// The editor beneath the mod splices the edit in, as core does.
const editor = (on: Parameters<typeof startSession>[1]) => {
  on('prompt.edit', ($, e) => ({ text: `${e.text.slice(0, e.start)}${e.inputText}${e.text.slice(e.end)}`, cursor: e.start + e.inputText.length }))
}
// A key typed at the end of the draft (a paste carries no key). The kit's $ raises prompt.edit,
// though its type leaves it out.
type Edit = (e: PromptEditInput) => Promise<PromptEditResult>
const type = ($: Engine, text: string, inputText: string, isPasted = false) =>
  ($.prompt as unknown as { edit: Edit }).edit({
    origin: { kind: 'composer' },
    ...(isPasted ? {} : { key: { key: inputText } }),
    text,
    cursor: text.length,
    start: text.length,
    end: text.length,
    inputText,
  })

test("the band draws the opener, then this project's open notes as numbered chips, newest first", async ($, on) => {
  await startSession($, on, fixture())
  const ui = await mountBand($)
  expect(await buttons(ui)).toEqual([
    { key: 'band-open', label: '✎ cc', hotkey: undefined },
    { key: 'band-chip-1', label: 'check why the cache…', hotkey: undefined },
    { key: 'band-chip-2', label: 'rename the store helpers', hotkey: undefined },
  ])
  await ui.unmount()
})

test('each chip draws its key, a ; then its digit, and takes no hotkey: a lone digit in the prompt answers Claude', async ($, on) => {
  await startSession($, on, fixture())
  const ui = await mountBand($)
  expect(await keys(ui)).toEqual([';1', ';2'])
  expect((await buttons(ui)).every(button => button.hotkey === undefined)).toBe(true)
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

test('chip 2 pressed with an empty prompt puts exactly the note there, and the submit marks it sent', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
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

test(';2 typed into an empty prompt puts exactly note 2 there, and the submit marks it sent', async ($, on) => {
  editor(on)
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  const ui = await mountBand($)
  expect((await type($, '', ';')).text).toBe(';')
  const typed = await type($, ';', '2')
  expect(typed).toEqual({ text: 'rename the store helpers', cursor: 24 })
  expect(world.toasts).toContain('note 2 in your prompt · ⏎ to send')
  expect(noteIn(dir, TWO).status).toBe('open')

  await composer($, typed.text)
  expect(noteIn(dir, TWO).status).toBe('sent')
  expect(noteIn(dir, ONE).status).toBe('open')
  await ui.unmount()
})

// The pane opened, then ctrl+x tab: it stays open beside the prompt, which holds the keys.
const besidePrompt = async ($: Engine) => {
  await run($, 'jot', '')
  const pane = await mountPane($)
  await pane.press({ key: 'key-switch' })
  await pane.redraw({ ...PANE.props, isFocused: false })
  return pane
}

test(';2 with the pane open beside the prompt fills the prompt and leaves the pane open', async ($, on) => {
  editor(on)
  const { world } = await startSession($, on, fixture())
  const pane = await besidePrompt($)
  const band = await mountBand($)
  expect(world.closed).toBe(1)
  await type($, '', ';')
  expect(await type($, ';', '2')).toEqual({ text: 'rename the store helpers', cursor: 24 })
  expect(world.closed).toBe(1)
  expect(world.pane).toEqual({ isOpen: true, isFocused: false })
  await band.unmount()
  await pane.unmount()
})

test('a chip pressed with the pane open beside the prompt leaves it open', async ($, on) => {
  const { world, clock } = await startSession($, on, fixture())
  const pane = await besidePrompt($)
  const band = await mountBand($)
  await band.press({ key: 'band-chip-2' })
  await clock.advance(10)
  expect(world.box.text).toBe('rename the store helpers')
  expect(world.closed).toBe(1)
  expect(world.pane).toEqual({ isOpen: true, isFocused: false })
  await band.unmount()
  await pane.unmount()
})

test('a chip pressed while the pane held the keys and a draft leaves the pane open and spends the draft', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir, 'my draft')
  await run($, 'jot', '')
  const pane = await mountPane($)
  const band = await mountBand($)
  await band.press({ key: 'band-chip-2' })
  await clock.advance(10)
  const filled = 'my draft\n\nrename the store helpers'
  expect(world.box.text).toBe(filled)
  expect(world.closed).toBe(0)
  expect(world.pane.isOpen).toBe(true)
  // Spent: the keys going to the prompt give nothing back.
  await pane.press({ key: 'key-switch' })
  expect(world.box.text).toBe(filled)
  await composer($, filled)
  expect(noteIn(dir, TWO).status).toBe('sent')
  await band.unmount()
  await pane.unmount()
})

test('a lone digit, a ; inside a draft, a pasted ;2 or a digit with no chip goes into the prompt as typed', async ($, on) => {
  editor(on)
  const { world } = await startSession($, on, fixture())
  const ui = await mountBand($)
  expect((await type($, '', '2')).text).toBe('2')
  expect((await type($, 'pick;', '2')).text).toBe('pick;2')
  expect((await type($, '', ';2', true)).text).toBe(';2')
  expect((await type($, ';', '7')).text).toBe(';7')
  expect((await type($, ';', 'a')).text).toBe(';a')
  expect(world.toasts).toEqual([])
  await ui.unmount()
})

test('with Pocket off, ;1 goes into the prompt as typed', { options: { pocket: false } }, async ($, on) => {
  editor(on)
  await startSession($, on, fixture())
  const ui = await mountBand($)
  expect((await type($, ';', '1')).text).toBe(';1')
  await ui.unmount()
})

test('the keys follow the band: a note archived elsewhere leaves it, and its key no longer fills the prompt', async ($, on) => {
  editor(on)
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  // Another session archives chip 2's note; the next poll reads it and the band redraws.
  dir.put(`/data/notes/${TWO}.md`, dir.get(`/data/notes/${TWO}.md`)?.replace('status: open', 'status: archived') ?? '')
  await clock.advance(2000)
  expect(await keys(ui)).toEqual([';1'])
  expect((await type($, ';', '2')).text).toBe(';2')
  expect((await type($, ';', '1')).text).toBe('check why the cache test is flaky')
  expect(world.toasts).toEqual(['note 1 in your prompt · ⏎ to send'])
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
  const { world, clock } = await startSession($, on, dir)
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
    { key: 'band-chip-1', label: 'follow up on the…', hotkey: undefined },
    { key: 'band-chip-2', label: 'document the store…', hotkey: undefined },
    { key: 'band-keep-all', label: 'keep all', hotkey: undefined },
  ])
  await ui.unmount()
})

test('a harvest row too narrow for a chip closes up to fit: one column apart, the opener without the project', async ($, on) => {
  const { ui } = await harvested($, on)
  // `✎ ◆ +2 ;0 keep all` is 18 cells.
  await ui.redraw({ ...BAND.props, bodyColumns: 18 })
  expect(await buttons(ui)).toEqual([
    { key: 'band-open', label: '✎', hotkey: undefined },
    { key: 'band-more', label: '+2', hotkey: undefined },
    { key: 'band-keep-all', label: 'keep all', hotkey: undefined },
  ])
  expect(await ui.find({ type: 'Text', text: '◆' })).toBeDefined()
  expect((await ui.findAll({ type: 'Box' })).map(box => (box.props as { gap?: number }).gap)).toContain(1)
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

test('pressing a harvest chip keeps that note, the other stays proposed', async ($, on) => {
  const { dir, ui, world, clock } = await harvested($, on)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  expect(noteIn(dir, PROPOSED).status).toBe('open')
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('proposed')
  expect(world.toasts).toContain('Kept')
  await ui.unmount()
})

test(';1 typed into an empty prompt keeps that proposal and empties the prompt; ;0 keeps the rest', async ($, on) => {
  editor(on)
  const { dir, ui, world } = await harvested($, on)
  expect(await keys(ui)).toEqual([';1', ';2', ';0'])
  expect(await type($, ';', '1')).toEqual({ text: '', cursor: 0 })
  expect(noteIn(dir, PROPOSED).status).toBe('open')
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('proposed')
  expect(world.toasts).toContain('Kept')
  await ui.redraw(BAND.props)
  expect(await type($, ';', '0')).toEqual({ text: '', cursor: 0 })
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('open')
  // With the harvest kept, Pocket is back: its keys fill the prompt.
  await ui.redraw(BAND.props)
  expect((await type($, ';', '9')).text).toBe(';9')
  await ui.unmount()
})

test(';0 keeps every proposal, those counted in +N too', async ($, on) => {
  editor(on)
  const { dir, ui } = await harvested($, on)
  // `✎ ◆ +2 ;0 keep all`: no chip fits, both proposals wait in +N.
  await ui.redraw({ ...BAND.props, bodyColumns: 18 })
  expect(await keys(ui)).toEqual([';0'])
  expect((await type($, ';', '1')).text).toBe(';1')
  expect(await type($, ';', '0')).toEqual({ text: '', cursor: 0 })
  expect(noteIn(dir, PROPOSED).status).toBe('open')
  expect(noteIn(dir, PROPOSED_TOO).status).toBe('open')
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

test("the harvest is this turn's: Claude's, this project's, by turn id (a note without one is no turn's)", async ($, on) => {
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
  expect((await buttons(ui)).filter(button => button.key?.startsWith('band-chip-')).map(button => button.label)).toEqual(['in this turn'])
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

test("a completion whose write waits doesn't lose the turn that starts meanwhile: that turn still collects its harvest", async ($, on) => {
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

test("a completion for a turn the module never knew, whose write waits, doesn't end a turn that starts meanwhile", async ($, on) => {
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

test("a session start whose write waits doesn't end a turn that starts meanwhile: the harvest stays hidden while it runs", async ($, on) => {
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

test("a /clear whose write waits doesn't hide the harvest of the new conversation's first turn", async ($, on) => {
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

test("a subagent's turn.complete, or one for a turn that isn't running, collects nothing and ends nothing", async ($, on) => {
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
test("a completion the engine holds keeps its turn: a continuation starting meanwhile doesn't take it, and its harvest is still collected", async ($, on) => {
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
  row: {
    door: 'prompt' | 'delivery' | 'attachment' | 'tool-result'
    role?: 'user' | 'assistant'
    agentId?: string
    name?: string
    origin?: { kind: 'composer' } | { kind: 'engine' } | { kind: 'plugin'; name: string; asUser?: true }
  } = { door: 'prompt' },
) =>
  $.session.append({
    message: { type: 'user', role: row.role ?? 'user', ...(row.name ? { name: row.name } : {}), content: [{ type: 'text', text }] },
    door: row.door,
    origin: row.origin ?? { kind: 'composer' },
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

test("a subagent's row, a tool result or an assistant row carrying the text never marks the note", async ($, on) => {
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

// A short note and a longer one that contains its text.
const SHORT = '01JA7K2M3Q9X4ZB6C8D0EFGH31'
const LONG = '01JA7K2M3Q9X4ZB6C8D0EFGH32'
const nested = () => {
  const dir = new MemDir()
  put(dir, LONG, 'fix typo in README', CC, 5)
  put(dir, SHORT, 'fix typo', CC, 30)
  return dir
}

test('a note left in the prompt is not marked sent by the row of a longer note sent with s', async ($, on) => {
  const dir = nested()
  const { world, clock } = await startSession($, on, dir)
  const band = await mountBand($)
  await band.press({ key: 'band-chip-2' })
  await clock.advance(10)
  await band.unmount()
  expect(world.box.text).toBe('fix typo')
  await run($, 'jot', '')
  const pane = await mountPane($)
  await pane.input({ key: 'q', text: '', kind: 'submit' })
  await pane.press({ key: 'key-s' })
  await clock.advance(10)
  expect(world.submitted).toEqual(['fix typo in README'])
  // The engine appends the plugin's prompt as a row of its own.
  await append($, 'fix typo in README', { door: 'prompt', origin: { kind: 'plugin', name: 'ostrakon', asUser: true } })
  await clock.advance(10)
  expect(noteIn(dir, LONG).status).toBe('sent')
  expect(noteIn(dir, SHORT).status).toBe('open')
  // Still in the prompt: the person's own submit carrying it marks it.
  expect(world.box.text).toBe('fix typo')
  await composer($, world.box.text)
  expect(noteIn(dir, SHORT).status).toBe('sent')
  await pane.unmount()
})

test("a note held in the prompt is not marked sent by a person's row that carries its text", async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  const text = world.box.text
  await append($, `see ${text}`, { door: 'attachment', name: 'nested_memory', origin: { kind: 'engine' } })
  await append($, text, { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('open')
  await composer($, text)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

test("a plugin's row carrying a queued note's text marks nothing; the queued prompt's own row still does", async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  await append($, text, { door: 'prompt', origin: { kind: 'plugin', name: 'other', asUser: true } })
  await append($, text, { door: 'attachment', origin: { kind: 'plugin', name: 'other' } })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('open')
  await append($, text, { door: 'delivery', name: 'queued_command', origin: { kind: 'engine' } })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

// The engine puts a queued prompt taken back into the box, and says only that it wrote the box.
type Change = (e: { text: string; cursor: number; origin: { kind: string; name?: string } }) => Promise<unknown>
const change = ($: Engine, text: string, origin: { kind: string; name?: string }) =>
  ($.prompt as unknown as { change: Change }).change({ text, cursor: text.length, origin })

test('a queued prompt taken back and deleted leaves its note open, whatever row carries the text later', async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  await change($, text, { kind: 'engine' })
  await change($, '', { kind: 'engine' })
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-3' })
  await append($, `the memory file says: ${text}`, { door: 'attachment', name: 'nested_memory', origin: { kind: 'engine' } })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('open')
  await ui.unmount()
})

test('a queued note taken back inside a longer note held in the prompt is no longer queued', async ($, on) => {
  const dir = nested()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  await $.turn.start({ text: 'working on something', turnId: 'turn-3' })
  await ui.press({ key: 'band-chip-2' })
  await clock.advance(10)
  // The person types the rest, so the queued prompt reads like the longer note.
  await $.prompt.submit({ text: 'fix typo in README', wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  world.box.text = ''
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  expect(world.box.text).toBe('fix typo in README')
  await change($, 'fix typo in README\n\nfix typo in README', { kind: 'engine' })
  await change($, '', { kind: 'engine' })
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-3' })
  await append($, 'fix typo', { door: 'attachment', name: 'nested_memory', origin: { kind: 'engine' } })
  await clock.advance(10)
  expect(noteIn(dir, SHORT).status).toBe('open')
  await ui.unmount()
})

test('a queued prompt taken back and submitted again marks its note once its row enters', async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  await change($, text, { kind: 'engine' })
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  expect(noteIn(dir, ONE).status).toBe('open')
  await append($, text, { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

test('a queued prompt taken back and submitted once idle marks its note at once', async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  await change($, text, { kind: 'engine' })
  await $.turn.complete({ ...TURN_DONE, turnId: 'turn-3' })
  await composer($, text)
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

test('a recalled history entry or a plugin fill holding a queued note leaves it queued', async ($, on) => {
  const { dir, ui, clock, text } = await queued($, on)
  await change($, text, { kind: 'history' })
  await change($, text, { kind: 'plugin', name: 'ostrakon' })
  await append($, text, { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
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

// Two notes put into one prompt, three ways; answers what the prompt holds then. The person's
// prompt is empty and nothing runs when each starts.
const TWO_FILLS = {
  'two chip presses': async ($: Engine, world: World, clock: Clock) => {
    const ui = await mountBand($)
    await ui.press({ key: 'band-chip-1' })
    await clock.advance(10)
    await ui.press({ key: 'band-chip-2' })
    await clock.advance(10)
    await ui.unmount()
    return world.box.text
  },
  // A key fills only an empty prompt: the person cuts note 1, types ;2, then pastes note 1 back.
  'two ;n keys': async ($: Engine) => {
    const ui = await mountBand($)
    await type($, '', ';')
    const first = (await type($, ';', '1')).text
    await type($, '', ';')
    const second = (await type($, ';', '2')).text
    await ui.unmount()
    return (await type($, second, `\n\n${first}`, true)).text
  },
  'a chip, then t from the pane': async ($: Engine, world: World, clock: Clock) => {
    await run($, 'jot', '')
    const pane = await mountPane($)
    const band = await mountBand($)
    await band.press({ key: 'band-chip-2' })
    await clock.advance(10)
    await pane.input({ key: 'q', text: '', kind: 'submit' })
    await pane.press({ key: 'key-t' })
    await band.unmount()
    await pane.unmount()
    return world.box.text
  },
}

type World = Awaited<ReturnType<typeof startSession>>['world']
type Clock = Awaited<ReturnType<typeof startSession>>['clock']

for (const [how, fill] of Object.entries(TWO_FILLS)) {
  test(`${how}, then a submit carrying both: both notes are marked sent`, async ($, on) => {
    editor(on)
    const dir = fixture()
    const { world, clock } = await startSession($, on, dir)
    const text = await fill($, world, clock)
    expect(text).toContain('check why the cache test is flaky')
    expect(text).toContain('rename the store helpers')
    await composer($, text)
    expect(noteIn(dir, ONE).status).toBe('sent')
    expect(noteIn(dir, TWO).status).toBe('sent')
  })

  test(`${how}, then a submit queued mid-turn: both notes are marked sent once it enters`, async ($, on) => {
    editor(on)
    const dir = fixture()
    const { world, clock } = await startSession($, on, dir)
    const text = await fill($, world, clock)
    await $.turn.start({ text: 'working on something', turnId: 'turn-3' })
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
    expect(noteIn(dir, ONE).status).toBe('open')
    expect(noteIn(dir, TWO).status).toBe('open')
    await append($, text, { door: 'delivery', name: 'queued_command' })
    await clock.advance(10)
    expect(noteIn(dir, ONE).status).toBe('sent')
    expect(noteIn(dir, TWO).status).toBe('sent')
  })
}

test('of two fills, one deleted from the prompt before the submit stays open, and the submit spends it', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  await TWO_FILLS['two chip presses']($, world, clock)
  await composer($, 'rename the store helpers')
  expect(noteIn(dir, TWO).status).toBe('sent')
  expect(noteIn(dir, ONE).status).toBe('open')
  // Spent: a later prompt that carries the deleted note's text doesn't mark it.
  await composer($, 'check why the cache test is flaky')
  expect(noteIn(dir, ONE).status).toBe('open')
})

test('of two fills queued mid-turn, one deleted from the prompt stays open, and the entry of its text later marks nothing', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  await TWO_FILLS['two chip presses']($, world, clock)
  await $.turn.start({ text: 'working on something', turnId: 'turn-3' })
  await $.prompt.submit({ text: 'rename the store helpers', wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  await append($, 'rename the store helpers', { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  expect(noteIn(dir, TWO).status).toBe('sent')
  await append($, 'check why the cache test is flaky', { door: 'prompt' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('open')
})

test('two prompts queued in one turn, each carrying its own fill, mark both notes once their rows enter', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  await $.turn.start({ text: 'working on something', turnId: 'turn-3' })
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  const first = world.box.text
  await $.prompt.submit({ text: first, wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  world.box.text = ''
  await ui.press({ key: 'band-chip-2' })
  await clock.advance(10)
  const second = world.box.text
  expect(second).toBe('rename the store helpers')
  await $.prompt.submit({ text: second, wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  await append($, first, { door: 'delivery', name: 'queued_command' })
  await append($, second, { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  expect(noteIn(dir, TWO).status).toBe('sent')
  await ui.unmount()
})

test('a fill waiting in the queue, filled again, is still marked sent when its queued prompt enters', async ($, on) => {
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  await $.turn.start({ text: 'working on something', turnId: 'turn-3' })
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  const text = world.box.text
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  world.box.text = ''
  // Still open, so the band offers it again.
  await ui.redraw(BAND.props)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  world.box.text = ''
  await $.prompt.submit({ text: 'something else', wait: false, origin: { kind: 'composer' }, turnId: 'turn-3' })
  await append($, text, { door: 'delivery', name: 'queued_command' })
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

// What the pane atom held before v0.8 (one lastFill, no fills), as a reload keeps it.
const OLD_PANE = {
  mode: 'browse',
  query: '',
  scope: 'project',
  scopeChosen: false,
  history: false,
  folded: [],
  picks: [],
  cursor: null,
  focus: 'search',
  offset: 0,
  sheetPage: 0,
  sheetFrom: null,
  edit: null,
  moving: null,
  capture: { draft: '', target: null, saved: [], error: null },
  stash: '',
  lastFill: null,
  undo: [],
}

test('a pane value older code left across a reload is set aside: a fill and its submit still mark the note sent', async ($, on) => {
  on('state.get', async (_, e, next) => {
    const got = (await next(e)) as { value: { value: unknown; version: number } }
    if ((e as { key?: string }).key === 'pane' && got.value.version === 0) return { value: { value: OLD_PANE, version: 0 } }
    return got
  })
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-1' })
  await clock.advance(10)
  await composer($, world.box.text)
  await clock.advance(10)
  expect(noteIn(dir, ONE).status).toBe('sent')
  await ui.unmount()
})

test('two notes with the same text, each put into the prompt, are both marked sent', async ($, on) => {
  const dir = fixture()
  put(dir, OTHER, 'rename the store helpers', CC, 90)
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  await ui.press({ key: 'band-chip-2' })
  await clock.advance(10)
  world.box.text = ''
  await ui.press({ key: 'band-chip-3' })
  await clock.advance(10)
  expect(world.box.text).toBe('rename the store helpers')
  await composer($, world.box.text)
  expect(noteIn(dir, TWO).status).toBe('sent')
  expect(noteIn(dir, OTHER).status).toBe('sent')
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

test('while a turn runs every chip, +N and the opener draw dim, and the chips still press', async ($, on) => {
  const dir = fixture()
  for (const i of [5, 6, 7, 8, 9, 10]) put(dir, `01JA7K2M3Q9X4ZB6C8D0EFG${String(i).padStart(3, '0')}`, `another note ${i}`, CC, 100 + i)
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($, { isWorking: true }, 80)
  const dim = await dims(ui)
  expect(Object.keys(dim)).toContain('band-more')
  expect(Object.values(dim).every(Boolean)).toBe(true)
  await ui.press({ key: 'band-chip-2' })
  await clock.advance(10)
  expect(world.box.text).toBe('rename the store helpers')
  // At rest only the opener and +N are dim.
  await ui.redraw({ ...BAND.props, bodyColumns: 80 })
  expect(
    Object.entries(await dims(ui))
      .filter(([, isDim]) => isDim)
      .map(([key]) => key),
  ).toEqual(['band-open', 'band-more'])
  await ui.unmount()
})

test('a note just saved stands out in the pocket for MS.fresh: its chip at full strength, the rest dim', async ($, on) => {
  const { clock } = await startSession($, on, fixture())
  const ui = await mountBand($)
  await run($, 'jot', 'buy milk')
  await ui.redraw(BAND.props)
  expect(await buttons(ui)).toContainEqual({ key: 'band-chip-1', label: 'buy milk', hotkey: undefined })
  expect(await dims(ui)).toEqual({ 'band-open': true, 'band-chip-1': false, 'band-chip-2': true, 'band-chip-3': true })
  await clock.advance(MS.fresh)
  await ui.redraw(BAND.props)
  expect(await dims(ui)).toEqual({ 'band-open': true, 'band-chip-1': false, 'band-chip-2': false, 'band-chip-3': false })
  await ui.unmount()
})

test('a reload within MS.fresh, which stops the timer, ends the fresh chip at once', async ($, on) => {
  const { clock } = await startSession($, on, fixture())
  const ui = await mountBand($)
  await run($, 'jot', 'buy milk')
  await ui.redraw(BAND.props)
  expect(await dims(ui)).toEqual({ 'band-open': true, 'band-chip-1': false, 'band-chip-2': true, 'band-chip-3': true })
  // A reload keeps the atoms and runs session.start again.
  const reloaded = $.session.start({ cwd: '/home/me/Work/cc', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  await reloaded
  await ui.redraw(BAND.props)
  expect(await dims(ui)).toEqual({ 'band-open': true, 'band-chip-1': false, 'band-chip-2': false, 'band-chip-3': false })
  await ui.unmount()
})

test('the harvest row is one line, with the hint under it for the first three harvests only, each counted once', async ($, on) => {
  const dir = fixture()
  await startSession($, on, dir)
  const ui = await mountBand($)
  const hasHint = async () => (await ui.find({ type: 'Text', text: /keep one · ;0 keep all/ })) !== undefined
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

test('a key waiting behind another acts on the chip shown when it was typed, though the band redrew meanwhile', async ($, on) => {
  editor(on)
  const dir = fixture()
  const { world, clock } = await startSession($, on, dir)
  const ui = await mountBand($)
  // Holds a chip press inside the lock (at its read of the prompt), so a key typed meanwhile waits.
  let open = () => {}
  const held: NonNullable<typeof world.heldRead> = { gate: new Promise<void>(resolve => (open = resolve)) }
  world.heldRead = held
  const press = ui.press({ key: 'band-chip-2' })
  for (let i = 0; i < 1000 && !held.isHeld; i++) await Promise.resolve()
  expect(held.isHeld).toBe(true)
  // Typed while chip 1 is the cache note; it waits behind the press.
  const typed = type($, ';', '1')
  // Another session archives the cache note: the band redraws, and chip 1 is now another note.
  dir.put(`/data/notes/${ONE}.md`, dir.get(`/data/notes/${ONE}.md`)?.replace('status: open', 'status: archived') ?? '')
  await clock.advance(2000)
  expect(await keys(ui)).toEqual([';1'])
  open()
  await press
  // The key meant the cache note, which is gone: nothing goes in, rather than the note now at 1.
  expect(await typed).toEqual({ text: '', cursor: 0 })
  await ui.unmount()
})

test("the desktop's band, at its own width or under a survey, doesn't change what the terminal's keys press", async ($, on) => {
  editor(on)
  await startSession($, on, fixture())
  const ui = await mountBand($)
  for (const props of [{ bodyColumns: 20 }, { hasSurvey: true }]) {
    const desktop = await $.ui.mount({ plugin: 'ostrakon', surface: 'desktop', ...BAND, props: { ...BAND.props, ...props } })
    await desktop.unmount()
  }
  expect((await type($, ';', '2')).text).toBe('rename the store helpers')
  await ui.unmount()
})
