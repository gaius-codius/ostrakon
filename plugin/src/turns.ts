import type { Note } from '../types'
import { REVIEW_MIN_MS } from './harvest'

// What the hooks decide about turns and harvest (SPEC §8, §10): which prompt a turn belongs to,
// whether a write to the band's facts or the harvest applies, whether a turn is reviewed, and what
// the band shows. Pure: each hook hands its event and the module's state to a reducer at entry,
// before any wait, keeps the state it returns, and makes the writes it returns
// (tests/turns.test.ts).

// The order of the decisions: a conversation's generation, bumped when a session starts or ends,
// and a sequence number per decision. A write to the turns or harvest atom applies only if what it
// was decided under isn't older than what the atom holds, so a write that waited never undoes a
// newer one. A reload starts its generations above every earlier one.
export type Order = { generation: number; seq: number }
export const isOlder = (a: Order, b: Order) => a.generation < b.generation || (a.generation === b.generation && a.seq < b.seq)

// A prompt's turn: its id, order and the user's text ('' after a reload, which keeps none). Its
// continuations (turns with no text) share its harvest, and its text.
export type PromptTurn = Order & { turnId: string; text: string }
// The main loop's running turn: its id and its prompt's turn (its own, or for a continuation the
// turn it continues).
export type RunningTurn = { turnId: string; prompt: PromptTurn }

// The module's facts: the conversation's generation, the last sequence number, the latest prompt's
// turn in this conversation (null after /clear or /resume, or a reload) and the running turn (null
// between turns).
export type TurnState = { conversation: number; seq: number; latestPrompt: PromptTurn | null; running: RunningTurn | null }

// The band's facts ($.state, so they outlive a reload): the latest prompt's turn and its order, the
// turn running ('' between turns), and the order of the decision that wrote them.
export type TurnFacts = Order & { latest: string; latestOrder: Order; running: string }
// The latest prompt's proposals, in the order they were made, and that prompt's order.
export type Harvest = (Order & { turnId: string; ids: string[] }) | null

// A write to the band's facts, made with update.
export type FactsWrite = (now: TurnFacts) => TurnFacts

export const freshTurns = (conversation: number): TurnState => ({ conversation, seq: 0, latestPrompt: null, running: null })

const ordered = (state: TurnState): [TurnState, Order] => {
  const seq = state.seq + 1
  return [{ ...state, seq }, { generation: state.conversation, seq }]
}

// A session starting (or the module reloading) begins a newer generation. With no running turn
// known (a reload mid-turn loses it), the band's facts keep none.
export const sessionStarted = (state: TurnState): { state: TurnState; facts: FactsWrite | null } => {
  const [next, order] = ordered({ ...state, conversation: state.conversation + 1 })
  const facts: FactsWrite | null = state.running === null ? now => (now.running === '' || isOlder(order, now) ? now : { ...now, running: '', ...order }) : null
  return { state: next, facts }
}

// A reload keeps the atoms but not the module: once session start has read them, later decisions
// order above what they hold, and the latest prompt comes back, so a continuation after the reload
// still joins its harvest.
export const sessionRestored = (state: TurnState, stored: TurnFacts, shown: Harvest): TurnState => ({
  ...state,
  conversation: Math.max(state.conversation, stored.generation + 1, (shown?.generation ?? 0) + 1),
  latestPrompt: state.latestPrompt === null && stored.latest !== '' ? { turnId: stored.latest, text: '', ...stored.latestOrder } : state.latestPrompt,
})

// /clear or /resume: the next conversation is a newer generation with no latest prompt, so a review
// still running for this one is never drawn there.
export const sessionEnded = (state: TurnState): { state: TurnState; facts: FactsWrite } => {
  const [next, order] = ordered({ ...state, conversation: state.conversation + 1, latestPrompt: null })
  return { state: next, facts: now => (isOlder(order, now) ? now : { ...now, latest: '', ...order }) }
}

// A turn with text is a new prompt's: the band goes back to Pocket, whoever sent it. A
// continuation with no text keeps its prompt's harvest (with no prompt known, it's its own).
export const turnStarted = (state: TurnState, e: { turnId: string; text: string }): { state: TurnState; facts: FactsWrite } => {
  const [next, order] = ordered(state)
  const prompt = e.text.trim() !== '' || state.latestPrompt === null ? { turnId: e.turnId, text: e.text, ...order } : state.latestPrompt
  return {
    state: { ...next, latestPrompt: prompt, running: { turnId: e.turnId, prompt } },
    facts: now => (isOlder(order, now) ? now : { latest: prompt.turnId, latestOrder: { generation: prompt.generation, seq: prompt.seq }, running: e.turnId, ...order }),
  }
}

export type TurnEnd = { turnId: string; agentId?: string; isAborted: boolean; reason: string; durationMs: number }

// A turn completing comes off the module if it's the one running (a turn starting meanwhile is left
// alone), and ends in the band's facts unless something newer was written since. Only that turn
// collects its harvest; it's reviewed when harvest is on and it was a full answer, not a quick one.
// A subagent's runs complete too, with no turn.start of their own: they change nothing.
export const turnCompleted = (
  state: TurnState,
  e: TurnEnd,
  isHarvestOn: boolean,
): { state: TurnState; facts: FactsWrite | null; turn: RunningTurn | null; review: boolean } => {
  if (e.agentId !== undefined) return { state, facts: null, turn: null, review: false }
  const turn = state.running?.turnId === e.turnId ? state.running : null
  const [next, order] = ordered(turn === null ? state : { ...state, running: null })
  return {
    state: next,
    facts: now => (now.running !== e.turnId || isOlder(order, now) ? now : { ...now, running: '', ...order }),
    turn,
    review: turn !== null && isHarvestOn && !e.isAborted && e.reason === 'answer' && e.durationMs >= REVIEW_MIN_MS,
  }
}

// The fork reads the main thread's last request: once a newer prompt started, or the conversation
// ended (/clear, /resume leave no latest prompt), that's no longer this turn's, so it goes unreviewed.
export const canReview = (state: TurnState, turn: RunningTurn) => state.latestPrompt?.turnId === turn.prompt.turnId

const byCreated = (a: Note, b: Note) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1)

// A turn's proposals: Claude's, in this project, carrying the turn's id (a note without one, a
// subagent's jot, belongs to no turn), oldest first.
export const turnProposals = (all: Note[], projectKey: string, turnId: string) =>
  all.filter(note => note.status === 'proposed' && !note.deleted && note.by === 'claude' && note.project?.key === projectKey && note.context.turnId === turnId).sort(byCreated)

// A turn's proposals as its prompt's harvest. The same prompt's (its turn and its continuations,
// in any order) go together, oldest first; a harvest never replaces one of a prompt that started
// later.
export const mergeHarvest = (current: Harvest, prompt: PromptTurn, made: string[], createdOf: (id: string) => string): Harvest => {
  if (current !== null && current.turnId === prompt.turnId) {
    const ids = [...new Set([...current.ids, ...made])]
    ids.sort((a, b) => (createdOf(a) < createdOf(b) ? -1 : createdOf(a) > createdOf(b) ? 1 : a < b ? -1 : 1))
    return { ...current, ids }
  }
  if (current !== null && isOlder(prompt, current)) return current
  return { turnId: prompt.turnId, generation: prompt.generation, seq: prompt.seq, ids: made }
}

// Whether the band offers the harvest: only the latest prompt's, and not while a turn runs, so none
// once another prompt started a turn or after /clear. Decided at draw time, so a review that lands
// late needs no check of its own.
export const isHarvestShown = (shown: Harvest, facts: TurnFacts): shown is NonNullable<Harvest> =>
  shown !== null && shown.turnId === facts.latest && facts.running === ''

// The harvest's proposals still waiting, in the order they were made.
export const waitingProposals = (shown: NonNullable<Harvest>, all: Record<string, Note>): Note[] =>
  shown.ids.map(id => all[id]).filter((note): note is Note => note?.status === 'proposed' && !note.deleted)
