import { describe, expect, test } from 'claude-code/testing'

import type { Note, NoteProject } from '../types'
import { REVIEW_MIN_MS } from '../src/harvest'
import type { FactsWrite, Harvest, TurnEnd, TurnFacts, TurnState } from '../src/turns'
import {
  canReview,
  freshTurns,
  isHarvestShown,
  isOlder,
  mergeHarvest,
  sessionEnded,
  sessionRestored,
  sessionStarted,
  turnCompleted,
  turnProposals,
  turnStarted,
  waitingProposals,
} from '../src/turns'

// The hooks' interleavings as plain transitions: each decision is taken on the module's state at
// a hook's entry, and its write to the band's facts is applied whenever the test says (a write the
// engine holds is applied after later ones).

const CC: NoteProject = { key: 'github.com/me/cc', name: 'cc', path: '/home/me/Work/cc' }
const INFRA: NoteProject = { key: 'github.com/me/infra', name: 'infra', path: '/home/me/code/infra' }
const T0 = Date.parse('2026-10-10T12:00:00.000Z')

// The atoms' defaults in hooks/register.tsx.
const FRESH: TurnFacts = { latest: '', latestOrder: { generation: 0, seq: 0 }, running: '', generation: 0, seq: 0 }

const proposal = (id: string, turnId: string | undefined, seconds: number, extra: Partial<Note> = {}): Note => ({
  id,
  status: 'proposed',
  by: 'claude',
  created: new Date(T0 + seconds * 1000).toISOString(),
  updated: new Date(T0 + seconds * 1000).toISOString(),
  origin: 'office',
  project: CC,
  context: turnId === undefined ? {} : { turnId },
  sentAt: null,
  deleted: false,
  text: id,
  extra: [],
  ...extra,
})

const END: Omit<TurnEnd, 'turnId'> = { isAborted: false, reason: 'answer', durationMs: 12000 }

// A session: the module's state and the two atoms, with the hooks' steps on them.
const session = (conversation = 1000) => {
  const s = { state: freshTurns(conversation), facts: FRESH, harvest: null as Harvest, notes: {} as Record<string, Note> }
  const write = (facts: FactsWrite | null) => {
    if (facts) s.facts = facts(s.facts)
  }
  // Decided now; the returned write is applied when the caller says.
  const start = () => {
    const started = sessionStarted(s.state)
    s.state = started.state
    return () => {
      write(started.facts)
      s.state = sessionRestored(s.state, s.facts, s.harvest)
    }
  }
  const end = () => {
    const ending = sessionEnded(s.state)
    s.state = ending.state
    return () => write(ending.facts)
  }
  const begin = (turnId: string, text = 'go') => {
    const started = turnStarted(s.state, { turnId, text })
    s.state = started.state
    return () => write(started.facts)
  }
  const complete = (turnId: string, extra: Partial<TurnEnd> = {}, isHarvestOn = true) => {
    const completed = turnCompleted(s.state, { turnId, ...END, ...extra }, isHarvestOn)
    s.state = completed.state
    return { ...completed, apply: () => write(completed.facts) }
  }
  // The turn's proposals as its prompt's harvest (collectHarvest).
  const collect = (turn: ReturnType<typeof complete>['turn'], ...made: Note[]) => {
    for (const note of made) s.notes[note.id] = note
    if (turn === null) return
    const ids = turnProposals(Object.values(s.notes), CC.key, turn.turnId).map(note => note.id)
    if (ids.length === 0) return
    s.harvest = mergeHarvest(s.harvest, turn.prompt, ids, id => s.notes[id]?.created ?? '')
  }
  const shown = () => (isHarvestShown(s.harvest, s.facts) ? waitingProposals(s.harvest, s.notes).map(note => note.id) : [])
  return { s, start, end, begin, complete, collect, shown }
}

describe('turns', () => {
  test("a turn with text is its own prompt; a continuation with no text is its prompt's, or its own when none is known", () => {
    const { s, begin, complete } = session()
    begin('t0', '')()
    expect(s.state.latestPrompt?.turnId).toBe('t0')
    complete('t0').apply()
    begin('t1', 'fix the count')()
    expect(s.state.running).toMatchObject({ turnId: 't1', prompt: { turnId: 't1' } })
    complete('t1').apply()
    begin('t2', '  ')()
    expect(s.state.running).toMatchObject({ turnId: 't2', prompt: { turnId: 't1' } })
    expect(s.facts).toMatchObject({ latest: 't1', running: 't2' })
    // The prompt keeps its own order: the band's facts carry it.
    expect(s.facts.latestOrder).toEqual({ generation: s.state.latestPrompt?.generation, seq: s.state.latestPrompt?.seq })
  })

  test("a prompt keeps the user's text, and its continuations reuse it; a turn with no prompt known has none", () => {
    const { s, begin, complete } = session()
    begin('t0', '')()
    expect(s.state.running?.prompt).toMatchObject({ turnId: 't0', text: '' })
    complete('t0').apply()
    begin('t1', 'fix the count')()
    expect(s.state.running?.prompt).toMatchObject({ turnId: 't1', text: 'fix the count' })
    complete('t1').apply()
    // A continuation: its own turn, its prompt's text, and again after another.
    begin('t2', '')()
    expect(s.state.running).toMatchObject({ turnId: 't2', prompt: { turnId: 't1', text: 'fix the count' } })
    complete('t2').apply()
    begin('t3', '  ')()
    expect(s.state.running?.prompt).toMatchObject({ turnId: 't1', text: 'fix the count' })
    complete('t3').apply()
    // The next prompt has its own.
    begin('t4', 'and the docs')()
    expect(s.state.running?.prompt).toMatchObject({ turnId: 't4', text: 'and the docs' })
  })

  test("the band shows a prompt's harvest once its turn ends, hides it while a continuation runs, and drops it at the next prompt", () => {
    const { begin, complete, collect, shown } = session()
    begin('t1')()
    const first = complete('t1')
    first.apply()
    collect(first.turn, proposal('p1', 't1', 1))
    expect(shown()).toEqual(['p1'])
    begin('t2', '')()
    expect(shown()).toEqual([])
    const second = complete('t2')
    second.apply()
    collect(second.turn)
    expect(shown()).toEqual(['p1'])
    // A prompt that proposes nothing leaves the harvest as it was, out of the band.
    begin('t3', 'and again')()
    const third = complete('t3')
    third.apply()
    collect(third.turn)
    expect(shown()).toEqual([])
  })

  test("a completion whose write waits doesn't end the turn that starts meanwhile, which still collects its harvest", () => {
    const { s, begin, complete, collect, shown } = session()
    begin('t1')()
    const first = complete('t1')
    begin('t2', 'and again')()
    first.apply()
    expect(s.facts.running).toBe('t2')
    const second = complete('t2')
    expect(second.turn?.turnId).toBe('t2')
    second.apply()
    collect(second.turn, proposal('p2', 't2', 2))
    expect(shown()).toEqual(['p2'])
  })

  test("a completion for a turn the module never knew collects nothing, and its waiting write doesn't end a continuation", () => {
    const { s, begin, complete, collect, shown } = session()
    begin('t1')()
    const first = complete('t1')
    first.apply()
    collect(first.turn, proposal('p1', 't1', 1))
    const orphan = complete('t0')
    expect([orphan.turn, orphan.review]).toEqual([null, false])
    begin('t2', '')()
    orphan.apply()
    expect(s.facts.running).toBe('t2')
    expect(shown()).toEqual([])
    complete('t2').apply()
    expect(shown()).toEqual(['p1'])
  })

  test("a session start whose write waits doesn't end a turn that starts meanwhile: the harvest stays hidden while it runs", () => {
    const { s, start, begin, complete, collect, shown } = session()
    begin('t1')()
    const first = complete('t1')
    first.apply()
    collect(first.turn, proposal('p1', 't1', 1))
    begin('t2', '')()
    // The continuation's end and a reload's session start wait together.
    const ending = complete('t2')
    const starting = start()
    begin('t3', '')()
    ending.apply()
    starting()
    expect(s.facts.running).toBe('t3')
    expect(shown()).toEqual([])
    complete('t3').apply()
    expect(shown()).toEqual(['p1'])
  })

  test("a session start with a turn running leaves the band's facts alone; idle, it ends a turn the facts still hold", () => {
    const { s, start, begin } = session()
    begin('t1')()
    expect(sessionStarted(s.state).facts).toBeNull()
    // A reload mid-turn loses the running turn: the facts' running turn ends.
    s.state = freshTurns(5000)
    start()()
    expect(s.facts.running).toBe('')
  })

  test("a /clear whose write waits doesn't hide the harvest of the new conversation's first turn", () => {
    const { s, end, begin, complete, collect, shown } = session()
    const clearing = end()
    begin('t1')()
    const first = complete('t1')
    first.apply()
    collect(first.turn, proposal('p1', 't1', 1))
    clearing()
    expect(s.facts.latest).toBe('t1')
    expect(shown()).toEqual(['p1'])
  })

  test('/clear hides the harvest; a review landing after it is never drawn, and the next turn is a prompt of its own', () => {
    const { s, end, begin, complete, collect, shown } = session()
    begin('t1')()
    const first = complete('t1')
    first.apply()
    end()()
    expect(s.state.latestPrompt).toBeNull()
    // The late review's proposals reach the harvest, but the band's facts have no latest prompt.
    collect(first.turn, proposal('p1', 't1', 1))
    expect(shown()).toEqual([])
    expect(canReview(s.state, first.turn!)).toBe(false)
    begin('t2', '')()
    expect(s.state.running?.prompt.turnId).toBe('t2')
  })

  test("a subagent's completion changes nothing: no order, no write, no turn", () => {
    const { s, begin, complete } = session()
    begin('t1')()
    const before = s.state
    const sub = complete('t1', { agentId: 'agent-1' })
    expect(sub).toMatchObject({ facts: null, turn: null, review: false })
    expect(s.state).toBe(before)
    expect(complete('t1').turn?.turnId).toBe('t1')
  })

  test('a turn is reviewed when harvest is on and it answered in full, not quick, aborted or otherwise ended', () => {
    const { begin, complete } = session()
    const review = (extra: Partial<TurnEnd>, isHarvestOn = true) => {
      begin('t1')()
      return complete('t1', extra, isHarvestOn).review
    }
    expect(review({})).toBe(true)
    expect(review({ durationMs: REVIEW_MIN_MS })).toBe(true)
    expect(review({ durationMs: REVIEW_MIN_MS - 1 })).toBe(false)
    expect(review({ isAborted: true, reason: 'aborted' })).toBe(false)
    expect(review({ reason: 'error' })).toBe(false)
    expect(review({}, false)).toBe(false)
  })

  test("a review runs only while its prompt is the latest: a completion held until the next prompt started goes unreviewed; a continuation's doesn't", () => {
    const { s, begin, complete } = session()
    begin('t1')()
    const held = complete('t1')
    expect(canReview(s.state, held.turn!)).toBe(true)
    begin('t2', '')()
    expect(canReview(s.state, held.turn!)).toBe(true)
    begin('t3', 'and again')()
    expect(canReview(s.state, held.turn!)).toBe(false)
  })

  test("a late harvest of an earlier prompt never replaces a later one's, even started in the same millisecond", () => {
    const { s, begin, complete, collect, shown } = session()
    begin('t1')()
    const first = complete('t1')
    first.apply()
    begin('t2', 'and again')()
    const second = complete('t2')
    second.apply()
    collect(second.turn, proposal('p2', 't2', 2))
    collect(first.turn, proposal('p1', 't1', 1))
    expect(s.harvest).toMatchObject({ turnId: 't2', ids: ['p2'] })
    expect(shown()).toEqual(['p2'])
    // The orders tell them apart by sequence alone: no clock is read.
    expect(isOlder(first.turn!.prompt, second.turn!.prompt)).toBe(true)
  })

  test("a continuation's proposals join its prompt's, oldest first, whichever lands first", () => {
    for (const isPromptFirst of [true, false]) {
      const { s, begin, complete, collect, shown } = session()
      begin('t1')()
      const first = complete('t1')
      first.apply()
      begin('t2', '')()
      const second = complete('t2')
      second.apply()
      const fromPrompt = proposal('p1', 't1', 1)
      const fromContinuation = proposal('p2', 't2', isPromptFirst ? 2 : 0)
      if (isPromptFirst) {
        collect(first.turn, fromPrompt)
        collect(second.turn, fromContinuation)
      } else {
        collect(second.turn, fromContinuation)
        collect(first.turn, fromPrompt)
      }
      expect(s.harvest?.turnId).toBe('t1')
      expect(shown()).toEqual(isPromptFirst ? ['p1', 'p2'] : ['p2', 'p1'])
      // Collecting the same turn again adds nothing twice.
      collect(first.turn)
      expect(shown()).toHaveLength(2)
    }
  })

  test('a reload orders later decisions above what the atoms hold and brings the latest prompt back', () => {
    const before = session(1000)
    before.begin('t1')()
    const first = before.complete('t1')
    first.apply()
    before.collect(first.turn, proposal('p1', 't1', 1))
    // The new module's clock is behind the old one's generations.
    const after = session(10)
    Object.assign(after.s, { facts: before.s.facts, harvest: before.s.harvest, notes: before.s.notes })
    after.start()()
    expect(after.s.state.conversation).toBeGreaterThan(before.s.facts.generation)
    // The user's text isn't in the band's facts: a restored prompt has none.
    expect(after.s.state.latestPrompt).toEqual({ ...first.turn!.prompt, text: '' })
    expect(after.shown()).toEqual(['p1'])
    // A continuation after the reload still joins the prompt's harvest.
    after.begin('t2', '')()
    const second = after.complete('t2')
    second.apply()
    after.collect(second.turn, proposal('p2', 't2', 2))
    expect(after.shown()).toEqual(['p1', 'p2'])
    // A harvest newer than the facts lifts the generation too; a prompt the module knows stays.
    const known: TurnState = { ...freshTurns(10), latestPrompt: { turnId: 't9', text: 'nine', generation: 3, seq: 1 } }
    const restored = sessionRestored(known, FRESH, { turnId: 't1', generation: 40, seq: 2, ids: [] })
    expect(restored.conversation).toBe(41)
    expect(restored.latestPrompt?.turnId).toBe('t9')
    expect(sessionRestored(freshTurns(10), FRESH, null).latestPrompt).toBeNull()
  })

  test("an older decision's write never undoes a newer one's", () => {
    const { s, begin } = session()
    const first = begin('t1')
    const second = begin('t2', 'and again')
    second()
    first()
    expect(s.facts).toMatchObject({ latest: 't2', running: 't2' })
  })

  test("a turn's proposals: Claude's, still proposed, in this project, carrying the turn's id, oldest first", () => {
    const all = [
      proposal('b', 't1', 2),
      proposal('a', 't1', 2),
      proposal('c', 't1', 1),
      proposal('mine', 't1', 0, { by: 'you' }),
      proposal('elsewhere', 't1', 0, { project: INFRA }),
      proposal('unfiled', 't1', 0, { project: null }),
      proposal('earlier', 't0', 0),
      proposal('no-turn', undefined, 0),
      proposal('kept', 't1', 0, { status: 'open' }),
      proposal('gone', 't1', 0, { deleted: true }),
    ]
    expect(turnProposals(all, CC.key, 't1').map(note => note.id)).toEqual(['c', 'a', 'b'])
  })

  test("the band offers only proposals still waiting, in the harvest's order", () => {
    const notes = {
      p1: proposal('p1', 't1', 1),
      p2: proposal('p2', 't1', 2, { status: 'open' }),
      p3: proposal('p3', 't1', 3, { deleted: true }),
      p4: proposal('p4', 't1', 4),
    }
    const facts: TurnFacts = { ...FRESH, latest: 't1' }
    const harvest: Harvest = { turnId: 't1', generation: 1, seq: 1, ids: ['p4', 'p2', 'p3', 'missing', 'p1'] }
    expect(isHarvestShown(harvest, facts)).toBe(true)
    expect(waitingProposals(harvest, notes).map(note => note.id)).toEqual(['p4', 'p1'])
    expect(isHarvestShown(null, facts)).toBe(false)
    expect(isHarvestShown(harvest, { ...facts, running: 't2' })).toBe(false)
    expect(isHarvestShown(harvest, { ...facts, latest: 't2' })).toBe(false)
  })
})
