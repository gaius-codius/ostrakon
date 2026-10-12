import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { parseNote } from '../src/frontmatter'
import {
  ARCHIVE_DESCRIPTION,
  ARCHIVE_REPLY,
  DEFAULT_HARVEST_MODE,
  JOT_DESCRIPTION,
  JOT_REPLY,
  NOTES_DESCRIPTION,
  NOTES_MAX,
  LIGHT_ANSWER_MAX,
  LIGHT_PROMPT_MAX,
  harvestModeOf,
  lightRequest,
  parseReview,
  reviewPrompt,
} from '../src/harvest'
import { MemDir } from './memdir'
import { CC, INFRA, mountPane, noteIn, put, run, startSession } from './world'
import type { World } from './world'

type On = Parameters<typeof startSession>[1]

const ON = { harvest: true }
const USAGE = { input_tokens: 400, output_tokens: 100, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0 }
const BAND = {
  plugin: 'ostrakon',
  surface: 'terminal',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const fixture = () => {
  const dir = new MemDir()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH01', 'check why the cache test is flaky', CC, 12)
  return dir
}

const claudes = (dir: MemDir) =>
  dir
    .names('/data/notes')
    .filter(name => name.endsWith('.md'))
    .map(name => parseNote(dir.get(`/data/notes/${name}`) ?? ''))
    .filter(note => note.by === 'claude')
    .sort((a, b) => (a.id < b.id ? -1 : 1))

// The jot tool under the name the engine gave it at registration, so the mod's tool.call pattern
// must match what the engine really registers.
const jotName = (world: World) => {
  const name = world.tools.find(tool => tool.name === 'jot')?.registeredAs
  if (name === undefined) throw new Error('the jot tool was not registered')
  return name
}
const jot = ($: Engine, world: World, note: unknown) => $.tool.call({ tool: jotName(world), note } as never)
const toolName = (world: World, name: string) => {
  const found = world.tools.find(tool => tool.name === name)?.registeredAs
  if (found === undefined) throw new Error(`the ${name} tool was not registered`)
  return found
}
const call = ($: Engine, world: World, name: string, input: Record<string, unknown>) => $.tool.call({ tool: toolName(world, name), ...input } as never)
const TOOLS = [
  expect.objectContaining({ name: 'jot', isDeferred: false, description: JOT_DESCRIPTION }),
  expect.objectContaining({ name: 'notes', isDeferred: false, description: NOTES_DESCRIPTION }),
  expect.objectContaining({ name: 'archive', isDeferred: false, description: ARCHIVE_DESCRIPTION }),
]

// The model's answer to the review, beneath the mod (registered before the session starts); the
// questions it was asked are kept. `gate`, when given, holds the answer until it resolves.
const reviewer = (on: On, text: string, gate?: Promise<void>) => {
  const asked: string[] = []
  on('model.fork', async (_, e) => {
    asked.push(e.prompt)
    if (gate) await gate
    return {
      value: text === '' ? { isAnswered: false as const, reason: 'empty-reply' as const, usage: USAGE } : { isAnswered: true as const, text, usage: USAGE },
    }
  })
  return asked
}

// The same, for light mode: the model.complete requests it was sent (fork asks are kept apart, so a
// test can say which call a mode made).
const lightReviewer = (on: On, text: string, gate?: Promise<void>) => {
  const sent: { model: string; effort?: string; system?: string; prompt: string }[] = []
  const forked: string[] = []
  on('model.complete', async (_, e) => {
    sent.push({ model: e.model, effort: e.effort, system: e.system, prompt: e.prompt })
    if (gate) await gate
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  on('model.fork', async (_, e) => {
    forked.push(e.prompt)
    return { value: { isAnswered: true as const, text: '["from the fork"]', usage: USAGE } }
  })
  return { sent, forked }
}

const opened = () => {
  let open = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  return { gate, open }
}

const turn = async ($: Engine, durationMs = 12000, isAborted = false, turnId = 'turn-1') => {
  await $.turn.start({ text: 'fix the count', turnId })
  return async () => {
    await $.turn.complete({
      answer: 'Fixed count(). test_discount still fails: codes are case-sensitive.',
      durationMs,
      isAborted,
      turnId,
      reason: isAborted ? 'aborted' : 'answer',
    })
  }
}

// The review runs in the background on mocks that answer at once. `until` waits for what a test
// expects (and fails when it never comes); `settle` gives a review that should do nothing the same
// room to do something wrong.
const until = async (isDone: () => boolean, what: string) => {
  for (let i = 0; i < 5000; i++) {
    if (isDone()) return
    await Promise.resolve()
  }
  throw new Error(`never happened: ${what}`)
}
const settle = async () => {
  for (let i = 0; i < 2000; i++) await Promise.resolve()
}
const proposed = (dir: MemDir) => claudes(dir).filter(note => note.status === 'proposed')

test('the tools are registered at session start, in the prompt, the same with harvest off and on', async ($, on) => {
  const { world } = await startSession($, on, fixture())
  expect(world.tools).toEqual(TOOLS)
  // The owner's rule: the tool never offers ostrakon as a place to defer work to.
  expect(JOT_DESCRIPTION).toContain("doesn't replace doing or saying what you normally would")
})

test('harvest on: the tools are registered exactly as with harvest off', { options: ON }, async ($, on) => {
  const { world } = await startSession($, on, fixture())
  expect(world.tools).toEqual(TOOLS)
})

test("a jot is an open note of Claude's in this project, with a toast, harvest on or off", { options: ON }, async ($, on) => {
  const dir = fixture()
  reviewer(on, '```json\n[]\n```')
  const { world } = await startSession($, on, dir)
  const done = await turn($)
  const reply = await jot($, world, '  retry ignores Retry-After  ')
  await done()
  await settle()
  const [note] = claudes(dir)
  expect(reply).toEqual({ result: JOT_REPLY.saved(note?.id ?? '') })
  expect(note).toMatchObject({
    text: 'retry ignores Retry-After',
    status: 'open',
    by: 'claude',
    project: { key: CC.key },
    context: { sessionId: 'sess-1', turnId: 'turn-1' },
  })
  expect(world.toasts).toContain('◆ Claude jotted: retry ignores Retry-After')
})

test('an empty jot is refused and saves nothing', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  expect(await jot($, world, '   ')).toEqual({ deny: JOT_REPLY.empty })
  expect(await jot($, world, undefined)).toEqual({ deny: JOT_REPLY.empty })
  expect(claudes(dir)).toEqual([])
})

test('harvest on: a finished turn is reviewed once, and what the review finds is proposed and offered by the band', { options: ON }, async ($, on) => {
  const dir = fixture()
  const asked = reviewer(
    on,
    'Here are two.\n```json\n["test_discount fails: codes are case-sensitive (shop/pricing.py)", "cli.py \\"N items\\" now counts units"]\n```',
  )
  await startSession($, on, dir)
  const done = await turn($)
  await done()
  await until(() => proposed(dir).length === 2, 'two proposals')
  expect(asked).toHaveLength(1)
  expect(asked[0]).toContain('take no action')
  expect(asked[0]).toContain('Fixed count()')
  expect(claudes(dir).map(note => [note.status, note.text, note.context.turnId])).toEqual([
    ['proposed', 'test_discount fails: codes are case-sensitive (shop/pricing.py)', 'turn-1'],
    ['proposed', 'cli.py "N items" now counts units', 'turn-1'],
  ])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test(
  'harvest on: the review leaves out what Claude jotted this turn and proposes at most harvestMaxPerTurn',
  { options: { harvest: true, harvestMaxPerTurn: 2 } },
  async ($, on) => {
    const dir = fixture()
    const asked = reviewer(on, '```json\n["one", "two", "three"]\n```')
    const { world } = await startSession($, on, dir)
    const done = await turn($)
    await jot($, world, 'retry ignores Retry-After')
    await done()
    await until(() => proposed(dir).length === 2, 'two proposals')
    expect(asked[0]).toContain('Already saved, so leave these out:\n- retry ignores Retry-After')
    expect(asked[0]).toContain('List up to 2 side issues')
    expect(
      claudes(dir)
        .filter(note => note.status === 'proposed')
        .map(note => note.text),
    ).toEqual(['one', 'two'])
  },
)

test('harvest on: an empty array, a quick turn or an interrupted one propose nothing', { options: ON }, async ($, on) => {
  const dir = fixture()
  const asked = reviewer(on, '[]')
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the review')
  await settle()
  await (await turn($, 2000))()
  await (await turn($, 12000, true))()
  await settle()
  // The quick turn and the interrupted one weren't reviewed.
  expect(asked).toHaveLength(1)
  expect(claudes(dir)).toEqual([])
})

test('harvest off: no turn is reviewed', async ($, on) => {
  const dir = fixture()
  const asked = reviewer(on, '```json\n["something"]\n```')
  await startSession($, on, dir)
  await (await turn($))()
  await settle()
  expect(asked).toEqual([])
  expect(claudes(dir)).toEqual([])
})

test("a review reply's notes are the strings of the JSON array in its last fenced block, else of the first [ … ] in it", () => {
  expect(parseReview('Here are the side issues.\n```json\n["a", "b"]\n```')).toEqual(['a', 'b'])
  // The last fenced block is the answer; a fence without a language counts too.
  expect(parseReview('```json\n["draft"]\n```\nOn reflection:\n```\n["final"]\n```')).toEqual(['final'])
  // No fence: the first array in the reply, whatever is around it; a ] inside a note doesn't end it.
  expect(parseReview('Notes: ["check a[0] bounds", "b"] and that is all.')).toEqual(['check a[0] bounds', 'b'])
  // A last fence that holds no array falls back to the first array in the reply.
  expect(parseReview('["x"]\n```\nnone\n```')).toEqual(['x'])
  // A fence mark inside a note is text: fences open and close only on lines of their own, a closer
  // at least as long as its opener.
  expect(parseReview('```json\n["use ``` fences in the README", "b"]\n```')).toEqual(['use ``` fences in the README', 'b'])
  expect(parseReview('````json\n["a"]\n```\n["b"]\n````')).toEqual(['a'])
  expect(parseReview('```json\n["old"]\n```\nRevised:\n```json\n["use ``` here", "new"]\n```')).toEqual(['use ``` here', 'new'])
  // A tilde fence's info string may hold backticks.
  expect(parseReview('```json\n["old"]\n```\n~~~json `notes`\n["new"]\n~~~')).toEqual(['new'])
  // The last fenced block that holds an array of notes, not simply the last block.
  expect(parseReview('```json\n["a"]\n```\nFor example:\n```ts\nconst first = arr[0]\n```')).toEqual(['a'])
  // Without a fence, the first array that is empty or holds a string: a bracket in a lead-in isn't it.
  expect(parseReview('Side issues [2 found]:\n["a","b"]')).toEqual(['a', 'b'])
  expect(parseReview('See note [1].\n["a"]')).toEqual(['a'])
  // Entries that aren't strings, or are blank, are no note; each is one line, at most 300 characters.
  expect(parseReview('```json\n["a", 2, null, {"text": "b"}, ["c"], "  ", "d\\n  e"]\n```')).toEqual(['a', 'd e'])
  expect(parseReview(`["${'x'.repeat(400)}"]`)[0]).toHaveLength(300)
  // A real note may start with "None"; markdown inside a note is kept as written.
  expect(parseReview('["None of the API handlers validate tenant ids", "**Audit** calls to __init__"]')).toEqual([
    'None of the API handlers validate tenant ids',
    '**Audit** calls to __init__',
  ])
  // Nothing worth keeping, in any form, or no array at all.
  for (const none of ['[]', '```json\n[]\n```', 'NONE', 'Nothing worth keeping this turn.', '["unclosed", ', '']) expect(parseReview(none)).toEqual([])
  // An echo of the question proposes none of it.
  expect(parseReview(reviewPrompt('Fixed it.', ['an old jot'], 3))).toEqual([])
})

test("a subagent's jot is tied to the session, not to the main turn running", async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await $.turn.start({ text: 'go', turnId: 'turn-2' })
  await $.tool.call({ tool: jotName(world), note: 'from a background agent', agentId: 'agent-1' } as never)
  expect(claudes(dir)[0]?.context).toEqual({ sessionId: 'sess-1' })
})

test('harvest on: a review with no answer proposes nothing', { options: ON }, async ($, on) => {
  const dir = fixture()
  const asked = reviewer(on, '')
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the review')
  await settle()
  expect(claudes(dir)).toEqual([])
})

test("harvest on: a reply that repeats this turn's jot doesn't propose it again", { options: ON }, async ($, on) => {
  const dir = fixture()
  reviewer(on, '```json\n["Retry ignores  retry-after", "the cache key misses the locale"]\n```')
  const { world } = await startSession($, on, dir)
  const done = await turn($)
  await jot($, world, 'retry ignores Retry-After')
  await done()
  await until(() => proposed(dir).length === 1, 'one proposal')
  await settle()
  expect(proposed(dir).map(note => note.text)).toEqual(['the cache key misses the locale'])
})

test('harvest on: a review that lands after a later turn started (and ended) stays in the pane, out of the band', { options: ON }, async ($, on) => {
  const dir = fixture()
  const { gate, open } = opened()
  const asked = reviewer(on, '```json\n["from the first turn"]\n```', gate)
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the first review')
  // The next turn starts and ends (too quick for a review of its own) before the first lands.
  await (await turn($, 1000, false, 'turn-2'))()
  open()
  await until(() => proposed(dir).length === 1, 'the late proposal')
  await settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await ui.unmount()
})

test("harvest on: a late review of an earlier turn doesn't take the band from a later turn's proposals", { options: ON }, async ($, on) => {
  const dir = fixture()
  const { gate, open } = opened()
  // The first question waits; later ones are answered at once. Each answer is picked by its
  // question's place, taken before any wait.
  const asked: string[] = []
  on('model.fork', async (_, e) => {
    const n = asked.push(e.prompt)
    if (n === 1) await gate
    const text = n === 1 ? '["from the first turn"]' : '["from the second turn"]'
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  const { clock } = await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the first review')
  await clock.advance(1000)
  await (await turn($, 12000, false, 'turn-2'))()
  await until(() => proposed(dir).length === 1, "the second turn's proposal")
  await settle()
  open()
  await until(() => proposed(dir).length === 2, 'the late proposal')
  await settle()
  expect(proposed(dir).map(note => [note.text, note.context.turnId])).toEqual([
    ['from the second turn', 'turn-2'],
    ['from the first turn', 'turn-1'],
  ])
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  const labels = (await ui.findAll({ type: 'Button' })).map(found => (found.props as { label?: string }).label)
  expect(labels).toContain('from the second turn')
  expect(labels).not.toContain('from the first turn')
  await ui.unmount()
})

test(
  "harvest on: a completion held by the engine until the next prompt started isn't reviewed: the fork would read the newer turn",
  { options: ON },
  async ($, on) => {
    const dir = fixture()
    const asked = reviewer(on, '```json\n["from the first turn"]\n```')
    const { gate, open } = opened()
    const { world } = await startSession($, on, dir)
    const held: NonNullable<World['heldCompletion']> = { turnId: 'turn-1', gate }
    world.heldCompletion = held
    const done = await turn($)
    const completing = done()
    await until(() => held.isHeld === true, 'the held completion')
    await $.turn.start({ text: 'and again', turnId: 'turn-2' })
    open()
    await completing
    await settle()
    expect(asked).toEqual([])
    expect(proposed(dir)).toEqual([])
  },
)

test(
  "harvest on: of two turns started at the same moment, a late review of the first doesn't take the band from the second",
  { options: ON },
  async ($, on) => {
    const dir = fixture()
    const { gate, open } = opened()
    const asked: string[] = []
    on('model.fork', async (_, e) => {
      const n = asked.push(e.prompt)
      if (n === 1) await gate
      const text = n === 1 ? '["from the first turn"]' : '["from the second turn"]'
      return { value: { isAnswered: true as const, text, usage: USAGE } }
    })
    await startSession($, on, dir)
    await (await turn($))()
    await until(() => asked.length === 1, 'the first review')
    // No time passes: both turns start at the same millisecond.
    await (await turn($, 12000, false, 'turn-2'))()
    await until(() => proposed(dir).length === 1, "the second turn's proposal")
    await settle()
    open()
    await until(() => proposed(dir).length === 2, 'the late proposal')
    await settle()
    const ui = await $.ui.mount(BAND)
    const labels = (await ui.findAll({ type: 'Button' })).map(found => (found.props as { label?: string }).label)
    expect(labels).toContain('from the second turn')
    expect(labels).not.toContain('from the first turn')
    await ui.unmount()
  },
)

test("harvest on: a continuation's proposals join its prompt's, whichever review lands first", { options: ON }, async ($, on) => {
  const dir = fixture()
  const { gate, open } = opened()
  const asked: string[] = []
  on('model.fork', async (_, e) => {
    const n = asked.push(e.prompt)
    if (n === 1) await gate
    const text = n === 1 ? '["from the prompt\'s turn"]' : '["from the continuation"]'
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  const { clock } = await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the first review')
  // A continuation (no text) of the same prompt runs and is reviewed while the first review waits.
  await clock.advance(1000)
  await $.turn.start({ text: '', turnId: 'turn-2' })
  open()
  await until(() => proposed(dir).length === 1, "the prompt's proposal")
  await $.turn.complete({ answer: 'Also checked the tax rate.', durationMs: 12000, isAborted: false, turnId: 'turn-2', reason: 'answer' })
  await until(() => proposed(dir).length === 2, "the continuation's proposal")
  await settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  const labels = (await ui.findAll({ type: 'Button' })).map(found => (found.props as { label?: string }).label)
  expect(labels).toContain("from the prompt's turn")
  expect(labels).toContain('from the continuation')
  await ui.unmount()
})

test("harvest on: a continuation reviewed before its prompt's late review keeps its proposals in the band too", { options: ON }, async ($, on) => {
  const dir = fixture()
  const { gate, open } = opened()
  const asked: string[] = []
  on('model.fork', async (_, e) => {
    const n = asked.push(e.prompt)
    if (n === 1) await gate
    const text = n === 1 ? '["from the prompt\'s turn"]' : '["from the continuation"]'
    return { value: { isAnswered: true as const, text, usage: USAGE } }
  })
  const { clock } = await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the first review')
  await clock.advance(1000)
  await $.turn.start({ text: '', turnId: 'turn-2' })
  await $.turn.complete({ answer: 'Also checked the tax rate.', durationMs: 12000, isAborted: false, turnId: 'turn-2', reason: 'answer' })
  await until(() => proposed(dir).length === 1, "the continuation's proposal")
  await settle()
  open()
  await until(() => proposed(dir).length === 2, 'the late proposal')
  await settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
  await ui.unmount()
})

test("harvest on: a review that lands after /clear stays in the pane, out of the new conversation's band", { options: ON }, async ($, on) => {
  const dir = fixture()
  const { gate, open } = opened()
  const asked = reviewer(on, '```json\n["from before the clear"]\n```', gate)
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked.length === 1, 'the review')
  await $.session.end({ reason: 'clear', sessionId: 'sess-1' } as never)
  open()
  await until(() => proposed(dir).length === 1, 'the late proposal')
  await settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await ui.unmount()
})

test('a jot is kept as one line, at most 300 characters', async ($, on) => {
  const dir = fixture()
  const { world } = await startSession($, on, dir)
  await jot($, world, '  first line\n  second line  ')
  await jot($, world, 'x'.repeat(500))
  expect(claudes(dir).map(note => (note.text.length > 300 ? 'too long' : note.text.slice(0, 20)))).toEqual(['first line second li', 'xxxxxxxxxxxxxxxxxxxx'])
  expect(claudes(dir)[1]?.text).toHaveLength(300)
})

test("harvest on: a repeated jot doesn't use up the limit", { options: { harvest: true, harvestMaxPerTurn: 1 } }, async ($, on) => {
  const dir = fixture()
  reviewer(on, '```json\n["retry ignores Retry-After", "the cache key misses the locale"]\n```')
  const { world } = await startSession($, on, dir)
  const done = await turn($)
  await jot($, world, 'retry ignores Retry-After')
  await done()
  await until(() => proposed(dir).length === 1, 'one proposal')
  expect(proposed(dir).map(note => note.text)).toEqual(['the cache key misses the locale'])
})

const LIGHT = { harvest: true, harvestMode: 'light' }

test('harvestMode: light and fork are the two modes; anything else is the default', () => {
  expect(harvestModeOf('light')).toBe('light')
  expect(harvestModeOf('fork')).toBe('fork')
  for (const other of [undefined, '', 'Light', 'both', true, 1, null]) expect(harvestModeOf(other)).toBe(DEFAULT_HARVEST_MODE)
})

test("light mode's request holds the turn's prompt, final answer and saved notes, and nothing else", () => {
  const request = lightRequest('fix the count', 'Fixed count().', ['retry ignores Retry-After'], 2)
  expect(request).toMatchObject({ model: 'haiku', effort: 'low' })
  expect(request.system).toContain("can't see files or tool output")
  expect(request.prompt).toContain('<prompt>\nfix the count\n</prompt>')
  expect(request.prompt).toContain('<reply>\nFixed count().\n</reply>')
  expect(request.prompt).toContain('List up to 2 side issues')
  expect(request.prompt).toContain('Already saved, so leave these out:\n- retry ignores Retry-After')
  expect(request.prompt).toContain('JSON array of strings')
  // The fork's question is the same words: only what precedes it differs.
  const question = (text: string) => text.slice(text.indexOf('List up to'))
  expect(question(request.prompt)).toBe(question(reviewPrompt('Fixed count().', ['retry ignores Retry-After'], 2)))
  // No saved notes, no prompt known (a reload lost it): no list, and a plain marker.
  const bare = lightRequest('  ', 'Done.', [], 3)
  expect(bare.prompt).not.toContain('Already saved')
  expect(bare.prompt).toContain('<prompt>\n(not available)\n</prompt>')
})

test('light mode leaves the middle out of a long prompt or answer', () => {
  const long = (mark: string, n: number) => `${mark}${'x'.repeat(n)}${mark}`
  const request = lightRequest(long('P', 20000), long('A', 50000), [], 3)
  const between = (tag: string) => request.prompt.slice(request.prompt.indexOf(`<${tag}>`), request.prompt.indexOf(`</${tag}>`))
  expect(between('prompt').length).toBeLessThan(LIGHT_PROMPT_MAX + 100)
  expect(between('reply').length).toBeLessThan(LIGHT_ANSWER_MAX + 100)
  expect(between('prompt')).toMatch(/^<prompt>\nP.*characters left out.*P\n$/s)
  expect(between('reply')).toMatch(/^<reply>\nA.*characters left out.*A\n$/s)
})

test('light mode cuts a long text on whole clusters, rounding inward, at both cuts', () => {
  const half = LIGHT_PROMPT_MAX / 2
  const LONE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
  const kept = (text: string) => {
    const prompt = lightRequest(text, 'ok', [], 3).prompt
    const found = /<prompt>\n(.*)\n\[… (\d+) characters left out …\]\n(.*)\n<\/prompt>/s.exec(prompt)
    if (found === null) throw new Error('no cut in the prompt')
    return { head: found[1] ?? '', left: Number(found[2]), tail: found[3] ?? '' }
  }
  // A cluster across the cut, by where in it the cut falls: a surrogate pair (cut between its
  // halves), a letter and its combining mark, a joined emoji sequence (cut among its parts), a flag.
  const across: [string, string, number][] = [
    ['a surrogate pair', '\u{1F600}', 1],
    ['a combining mark', 'e\u0301', 1],
    ['a ZWJ emoji', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 4],
    ['a ZWJ emoji, cut at its joiner', '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}', 3],
    ['a flag', '\u{1F1F8}\u{1F1EA}', 2],
  ]
  for (const [what, cluster, k] of across) {
    // At the head's cut the cluster starts k units before it; at the tail's it ends k units after it.
    const atHead = kept(`${'a'.repeat(half - k)}${cluster}${'z'.repeat(20000)}`)
    expect(atHead.head, `${what} at the head's cut`).toBe('a'.repeat(half - k))
    expect(atHead.head + atHead.tail).not.toMatch(LONE)
    expect(atHead.tail).toBe('z'.repeat(half))
    const atTail = kept(`${'z'.repeat(20000)}${cluster}${'a'.repeat(half - k)}`)
    expect(atTail.tail, `${what} at the tail's cut`).toBe('a'.repeat(half - k))
    expect(atTail.head + atTail.tail).not.toMatch(LONE)
    expect(atTail.head).toBe('z'.repeat(half))
    // What was left out counts exactly the units not kept.
    expect(atHead.left).toBe(20000 + k + cluster.length - k - half)
    expect(atTail.left).toBe(20000 + cluster.length + (half - k) - (half - k) - half)
  }
  // A cluster that fits before the cut is kept whole.
  const fits = kept(`${'a'.repeat(half - 2)}\u{1F600}${'z'.repeat(20000)}`)
  expect(fits.head).toBe(`${'a'.repeat(half - 2)}\u{1F600}`)
})

test(
  'harvest light: a finished turn is reviewed by one small-model completion, not a fork, and its proposals are offered by the band',
  { options: LIGHT },
  async ($, on) => {
    const dir = fixture()
    const { sent, forked } = lightReviewer(on, '```json\n["test_discount fails: codes are case-sensitive (shop/pricing.py)", "the tax rate is global"]\n```')
    await startSession($, on, dir)
    await (await turn($))()
    await until(() => proposed(dir).length === 2, 'two proposals')
    expect(forked).toEqual([])
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ model: 'haiku', effort: 'low' })
    // The turn's own prompt (turn.start's text) and answer.
    expect(sent[0]?.prompt).toContain('<prompt>\nfix the count\n</prompt>')
    expect(sent[0]?.prompt).toContain('Fixed count(). test_discount still fails')
    expect(claudes(dir).map(note => [note.status, note.text, note.context.turnId])).toEqual([
      ['proposed', 'test_discount fails: codes are case-sensitive (shop/pricing.py)', 'turn-1'],
      ['proposed', 'the tax rate is global', 'turn-1'],
    ])
    const ui = await $.ui.mount(BAND)
    expect(await ui.find({ type: 'Text', text: '◆ from this turn' })).toBeDefined()
    await ui.unmount()
  },
)

test(
  'harvest light: the same limits as the fork: jotted notes left out and told, at most harvestMaxPerTurn, quick and interrupted turns skipped',
  { options: { ...LIGHT, harvestMaxPerTurn: 2 } },
  async ($, on) => {
    const dir = fixture()
    const { sent, forked } = lightReviewer(on, '```json\n["Retry ignores  retry-after", "one", "two", "three"]\n```')
    const { world } = await startSession($, on, dir)
    const done = await turn($)
    await jot($, world, 'retry ignores Retry-After')
    await done()
    await until(() => proposed(dir).length === 2, 'two proposals')
    await settle()
    expect(proposed(dir).map(note => note.text)).toEqual(['one', 'two'])
    expect(sent[0]?.prompt).toContain('Already saved, so leave these out:\n- retry ignores Retry-After')
    await (await turn($, 2000, false, 'turn-2'))()
    await (await turn($, 12000, true, 'turn-3'))()
    await settle()
    expect(sent).toHaveLength(1)
    expect(forked).toEqual([])
  },
)

test("harvest light: a continuation is reviewed with its prompt's text", { options: LIGHT }, async ($, on) => {
  const dir = fixture()
  const { sent } = lightReviewer(on, '[]')
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => sent.length === 1, 'the first review')
  await $.turn.start({ text: '', turnId: 'turn-2' })
  await $.turn.complete({ answer: 'Also checked the tax rate.', durationMs: 12000, isAborted: false, turnId: 'turn-2', reason: 'answer' })
  await until(() => sent.length === 2, "the continuation's review")
  expect(sent[1]?.prompt).toContain('<prompt>\nfix the count\n</prompt>')
  expect(sent[1]?.prompt).toContain('Also checked the tax rate.')
})

test("harvest light: a completion held until the next prompt started isn't reviewed, as in fork mode", { options: LIGHT }, async ($, on) => {
  const dir = fixture()
  const { sent } = lightReviewer(on, '["from the first turn"]')
  const { gate, open } = opened()
  const { world } = await startSession($, on, dir)
  const held: NonNullable<World['heldCompletion']> = { turnId: 'turn-1', gate }
  world.heldCompletion = held
  const done = await turn($)
  const completing = done()
  await until(() => held.isHeld === true, 'the held completion')
  await $.turn.start({ text: 'and again', turnId: 'turn-2' })
  open()
  await completing
  await settle()
  expect(sent).toEqual([])
  expect(proposed(dir)).toEqual([])
})

test('harvest light: a review that lands after a later turn started stays in the pane, out of the band', { options: LIGHT }, async ($, on) => {
  const dir = fixture()
  const { gate, open } = opened()
  const { sent } = lightReviewer(on, '["from the first turn"]', gate)
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => sent.length === 1, 'the first review')
  await (await turn($, 1000, false, 'turn-2'))()
  open()
  await until(() => proposed(dir).length === 1, 'the late proposal')
  await settle()
  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /from this turn/ })).toBeUndefined()
  await ui.unmount()
})

test('harvest light: a completion that fails proposes nothing', { options: LIGHT }, async ($, on) => {
  const dir = fixture()
  let asked = 0
  on('model.complete', async () => {
    asked += 1
    return { value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage: USAGE } }
  })
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => asked === 1, 'the review')
  await settle()
  expect(claudes(dir)).toEqual([])
})

test('harvestMode fork (and no setting) reviews by fork, never by completion', { options: { harvest: true, harvestMode: 'fork' } }, async ($, on) => {
  const dir = fixture()
  const asked = reviewer(on, '["from the fork"]')
  let completed = 0
  on('model.complete', async () => {
    completed += 1
    return { value: { isAnswered: true as const, text: '["from light"]', usage: USAGE } }
  })
  await startSession($, on, dir)
  await (await turn($))()
  await until(() => proposed(dir).length === 1, 'the proposal')
  expect(asked).toHaveLength(1)
  expect(completed).toBe(0)
})

// Holds the first read of the clock a review makes (the review's first call is its session id; the
// world answers both, so a catch-all hook sees them). `arm` starts the watch once the session is up.
const clockHold = (on: On) => {
  const { gate, open } = opened()
  const hold = { isArmed: false, isReviewing: false, isHeld: false, open }
  on('*', async (_, e, next) => {
    if (hold.isArmed && next.is('session.id', e)) hold.isReviewing = true
    if (hold.isReviewing && !hold.isHeld && next.is('clock.now', e)) {
      hold.isHeld = true
      await gate
    }
    return next(e)
  })
  return hold
}

// The review's check that its prompt is still the latest, and its model call, have no wait between
// them: a newer prompt starting while the review waits for anything before the check unreviews the
// turn, and the clock read for the log's latency is taken before the check, not after it.
test(
  'harvest light: a newer turn starting while the review waits for the clock leaves this turn unreviewed, so no model call reads the wrong transcript',
  { options: LIGHT },
  async ($, on) => {
    const dir = fixture()
    const { sent, forked } = lightReviewer(on, '["from the first turn"]')
    const hold = clockHold(on)
    await startSession($, on, dir)
    hold.isArmed = true
    await (await turn($))()
    await until(() => hold.isHeld, 'the held clock read')
    await $.turn.start({ text: 'and again', turnId: 'turn-2' })
    hold.open()
    await settle()
    expect(sent).toEqual([])
    expect(forked).toEqual([])
    expect(proposed(dir)).toEqual([])
  },
)

test('harvest fork: a newer turn starting while the review waits for the clock leaves this turn unreviewed', { options: ON }, async ($, on) => {
  const dir = fixture()
  const asked = reviewer(on, '["from the first turn"]')
  const hold = clockHold(on)
  await startSession($, on, dir)
  hold.isArmed = true
  await (await turn($))()
  await until(() => hold.isHeld, 'the held clock read')
  await $.turn.start({ text: 'and again', turnId: 'turn-2' })
  hold.open()
  await settle()
  expect(asked).toEqual([])
  expect(proposed(dir)).toEqual([])
})

// Claude's notes, archive, a repeated jot and a jot to another project.

const projects = () => {
  const dir = fixture()
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH02', 'rotate the staging certs', INFRA, 30)
  put(dir, '01JA7K2M3Q9X4ZB6C8D0EFGH03', 'Pin the bun version in CI', CC, 5)
  return dir
}
const textOf = (reply: unknown) => String((reply as { result?: unknown }).result)

test("notes lists this project's waiting notes, newest first, each with its id", async ($, on) => {
  const { world } = await startSession($, on, projects())
  expect(textOf(await call($, world, 'notes', {}))).toBe(
    [
      '2 waiting in cc:',
      '- 01JA7K2M3Q9X4ZB6C8D0EFGH03 (5m, by you): Pin the bun version in CI',
      '- 01JA7K2M3Q9X4ZB6C8D0EFGH01 (12m, by you): check why the cache test is flaky',
    ].join('\n'),
  )
})

test('notes takes a query, another project or all, and refuses a project it does not know', async ($, on) => {
  const { world } = await startSession($, on, projects())
  expect(textOf(await call($, world, 'notes', { query: 'cache' }))).toContain('check why the cache test is flaky')
  expect(textOf(await call($, world, 'notes', { query: 'cache' }))).not.toContain('Pin the bun')
  expect(textOf(await call($, world, 'notes', { query: 'nothing like it' }))).toBe('No waiting notes in cc match "nothing like it".')
  expect(textOf(await call($, world, 'notes', { project: 'INFRA' }))).toBe(
    '1 waiting in infra:\n- 01JA7K2M3Q9X4ZB6C8D0EFGH02 (30m, by you): rotate the staging certs',
  )
  const all = textOf(await call($, world, 'notes', { project: 'all' }))
  expect(all).toStartWith('3 waiting in any project:')
  expect(all).toContain('): [infra] rotate the staging certs')
  expect(all).toContain('): Pin the bun version in CI')
  expect(await call($, world, 'notes', { project: 'nope' })).toEqual({ deny: 'No project named "nope". Known: cc, infra.' })
})

test('notes marks a proposal', { options: ON }, async ($, on) => {
  const dir = fixture()
  reviewer(on, '```json\n["the cache key misses the locale"]\n```')
  const { world } = await startSession($, on, dir)
  const done = await turn($)
  await done()
  await until(() => proposed(dir).length === 1, 'one proposal')
  await settle()
  expect(textOf(await call($, world, 'notes', {}))).toContain('(now, by claude, proposed): the cache key misses the locale')
})

test('notes says who wrote each note and caps a long list', async ($, on) => {
  const dir = fixture()
  for (let i = 0; i < NOTES_MAX + 2; i++) put(dir, `01JA7K2M3Q9X4ZB6C8D0EF${String(i).padStart(4, '0')}`, `note ${i}`, CC, 20 + i)
  const { world } = await startSession($, on, dir)
  await jot($, world, 'one of mine')
  const listed = textOf(await call($, world, 'notes', {})).split('\n')
  expect(listed[0]).toBe(`${NOTES_MAX + 4} waiting in cc:`)
  expect(listed[1]).toEndWith('(now, by claude): one of mine')
  expect(listed).toHaveLength(NOTES_MAX + 2)
  expect(listed.at(-1)).toBe('… and 4 more; narrow with query.')
})

test("archive archives a waiting note by id, with a toast, and the pane's u undoes it", async ($, on) => {
  const dir = projects()
  const { world } = await startSession($, on, dir)
  const id = '01JA7K2M3Q9X4ZB6C8D0EFGH03'
  expect(await call($, world, 'archive', { id })).toEqual({ result: ARCHIVE_REPLY.archived(id) })
  expect(noteIn(dir, id).status).toBe('archived')
  expect(world.toasts).toContain('◆ Claude archived: Pin the bun version in CI')
  expect(textOf(await call($, world, 'notes', {}))).not.toContain(id)
  expect(await call($, world, 'archive', { id })).toEqual({ deny: ARCHIVE_REPLY.notOpen(id, 'archived') })
  expect(await call($, world, 'archive', { id: 'nope' })).toEqual({ deny: ARCHIVE_REPLY.missing('nope') })
  await run($, 'jot', '')
  const ui = await mountPane($)
  await ui.input({ key: 'q', text: '', kind: 'submit' })
  await ui.press({ key: 'key-digit-1' })
  await ui.press({ key: 'key-u' })
  expect(noteIn(dir, id).status).toBe('open')
  await ui.unmount()
})

test('a jot that repeats a waiting note in its project saves nothing and gives its id', async ($, on) => {
  const dir = projects()
  const { world } = await startSession($, on, dir)
  expect(await jot($, world, '  pin the BUN version   in ci ')).toEqual({ result: JOT_REPLY.already('01JA7K2M3Q9X4ZB6C8D0EFGH03') })
  expect(claudes(dir)).toEqual([])
  expect(world.toasts.filter(text => text.includes('jotted'))).toEqual([])
  // The same text in another project is a new note.
  expect(textOf(await call($, world, 'jot', { note: 'Pin the bun version in CI', project: 'infra' }))).toStartWith('Saved to ostrakon as ')
})

test('a jot can go to another project by name, and a name it does not know is refused', async ($, on) => {
  const dir = projects()
  const { world } = await startSession($, on, dir)
  await call($, world, 'jot', { note: 'the staging cert expires Friday', project: 'Infra' })
  expect(claudes(dir)[0]).toMatchObject({ text: 'the staging cert expires Friday', project: { key: INFRA.key } })
  expect(await call($, world, 'jot', { note: 'x', project: 'nope' })).toEqual({ deny: 'No project named "nope". Known: cc, infra.' })
  expect(claudes(dir)).toHaveLength(1)
})

test("harvest on: a review doesn't propose a note already waiting in this project, or the same one twice", { options: ON }, async ($, on) => {
  const dir = fixture()
  reviewer(on, '```json\n["Check why the cache test is FLAKY", "the cache key misses the locale", "the cache key misses the locale"]\n```')
  await startSession($, on, dir)
  const done = await turn($)
  await done()
  await until(() => proposed(dir).length === 1, 'one proposal')
  await settle()
  expect(proposed(dir).map(note => note.text)).toEqual(['the cache key misses the locale'])
})
