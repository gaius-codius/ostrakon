// The sync core (SPEC §7.1): the local folder is always the truth for the UI; an adapter only
// reconciles it with somewhere else. The core owns what every adapter shares: which notes the
// other side already has, the change queue, backoff, and the status the pane shows.

import type { Note } from '../../types'
import { parseNote, serializeNote } from '../frontmatter'
import { winner } from '../merge'

export type SyncAdapter = {
  name: string
  // Changes after `cursor` (null: everything), waiting up to `waitS` seconds for one to arrive.
  // `hub` names the other side's current run: when it changes, the cursor means nothing any more.
  pull: (cursor: string | null, waitS: number) => Promise<{ notes: Note[]; cursor: string; hub?: string }>
  // Sends changed notes; resolves the other side's copy of each after its merge, and its run.
  push: (notes: Note[]) => Promise<{ notes: Note[]; hub?: string }>
}

// The other side answered, and said no (a refused token, a refused batch): not a network problem.
export class SyncRefused extends Error {}

export type SyncStatus = { isOnline: boolean; queued: number; problem: string }

export type SyncIO = {
  // The session's merged view of the local folder.
  local: () => Promise<Record<string, Note>>
  // Writes the notes that win against the local copies; resolves the ids it couldn't write.
  absorb: (notes: Note[]) => Promise<{ failed: string[] }>
  // Which revisions the other side holds, kept between sessions (machine-local), so the queue
  // count is right before the first pull. Several sessions share it.
  load: () => Promise<string | undefined>
  save: (text: string) => Promise<void>
  status: (status: SyncStatus) => Promise<void>
  warn: (text: string) => void
}

const WAIT_S = 25
const BACKOFF_MS = [1000, 2000, 5000, 10_000, 15_000]
const backoff = (failures: number) => BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 15_000
// Notes per push: well under what the hub takes in one request (500).
export const PUSH_BATCH = 200

// A short fingerprint of a note's file (cyrb53): enough to tell "the other side has this exact
// revision" without keeping every note twice.
export const fingerprint = (note: Note) => hashOf(serializeNote(note))

// cyrb53: 53 bits, so names made from it (a folder's memory, its locks) don't collide in practice.
export const hashOf = (text: string) => {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// A note from the other side, held to the file format like any file; undefined when it isn't one.
export const checked = (value: unknown): Note | undefined => {
  try {
    const note = parseNote(serializeNote(value as Note))
    return serializeNote(note) === serializeNote(value as Note) ? note : undefined
  } catch {
    return undefined
  }
}

type Saved = { hub?: string; known?: Record<string, string> }

export const createSync = (adapter: SyncAdapter) => {
  // id → fingerprint of a revision the other side has held in its current run. Within a run the
  // other side only ever moves a note to a merge winner, so a local copy with this fingerprint
  // never needs sending. Rebuilt from scratch by every full pull.
  let known = new Map<string, string>()
  let hub: string | undefined
  let cursor: string | null = null
  // Bumped when the other side's run changes: an answer to a request made before then is about
  // another run and is dropped.
  let epoch = 0
  let isLoaded = false
  let isSeeded = false
  // Pull and push fail separately: pulls can work while one batch keeps being refused.
  let isReachable = false
  let pullProblem = ''
  let pushProblem = ''
  let pushFailures = 0
  let isRetryScheduled = false
  let retryGeneration = 0
  let isPushing = false
  let isPushAgain = false
  // Pulled notes that won but couldn't be written here (a lock held too long, a full disk): tried
  // again with every pull, so the cursor moving past them doesn't lose them.
  const unwritten = new Map<string, Note>()
  let after: ((ms: number, fn: () => void) => void) | undefined
  let status: SyncStatus = { isOnline: false, queued: 0, problem: '' }

  const parse = (text: string | undefined): Saved => {
    try {
      return JSON.parse(text ?? '{}') as Saved
    } catch {
      return {}
    }
  }

  const load = async (io: SyncIO) => {
    if (isLoaded) return
    isLoaded = true
    const saved = parse(await io.load().catch(() => undefined))
    known = new Map(Object.entries(saved.known ?? {}))
    hub = saved.hub
  }

  // Other sessions save the same file: what they learned about this run of the hub is kept too,
  // except right after a full pull, whose snapshot replaces it.
  const save = async (io: SyncIO, isSnapshot = false) => {
    try {
      const disk = isSnapshot ? {} : parse(await io.load())
      const merged = disk.hub !== undefined && disk.hub === hub ? { ...disk.known, ...Object.fromEntries(known) } : Object.fromEntries(known)
      await io.save(JSON.stringify({ hub, known: merged }))
    } catch (error) {
      io.warn(`sync cache: ${String(error)}`)
    }
  }

  const dirtyOf = (local: Record<string, Note>) => Object.values(local).filter(note => known.get(note.id) !== fingerprint(note))

  const problemOf = (error: unknown) => (error instanceof SyncRefused ? error.message : 'offline')

  const report = async (io: SyncIO) => {
    const queued = dirtyOf(await io.local().catch(() => ({}))).length
    // Nothing left to send (a pull brought the same revisions): an old push error is moot.
    if (queued === 0) {
      pushProblem = ''
      pushFailures = 0
      isRetryScheduled = false
      retryGeneration += 1
    }
    const next = { isOnline: isReachable && pushProblem === '', queued, problem: !isReachable ? pullProblem : pushProblem }
    if (next.isOnline === status.isOnline && next.queued === status.queued && next.problem === status.problem) return
    status = next
    await io.status(next)
  }

  // Takes the other side's notes in: remembered as held there, and written locally where they win.
  // Resolves whether any lost to the local copy: then the other side holds an older revision (a
  // folder can move backwards: a restored file, a winning conflict copy removed) and needs ours.
  const take = async (io: SyncIO, notes: Note[]) => {
    for (const note of notes) known.set(note.id, fingerprint(note))
    // A revision still waiting to be written is replaced only by one that beats it.
    const incoming = new Map(unwritten)
    for (const note of notes) {
      const waiting = incoming.get(note.id)
      incoming.set(note.id, waiting ? winner(waiting, note) : note)
    }
    const local = await io.local()
    const isBehind = notes.some(note => {
      const mine = local[note.id]
      return mine !== undefined && fingerprint(mine) !== fingerprint(note) && winner(mine, note) === mine
    })
    const differ = [...incoming.values()].filter(note => {
      const mine = local[note.id]
      return mine === undefined || fingerprint(mine) !== fingerprint(note)
    })
    const failed = new Set(differ.length > 0 ? (await io.absorb(differ)).failed : [])
    // A pull and a push can take notes in at once: settle each note against the waiting list as it
    // is now, never against the copy taken above, so neither drops what the other just queued.
    for (const note of incoming.values()) {
      const waiting = unwritten.get(note.id)
      if (failed.has(note.id)) unwritten.set(note.id, waiting ? winner(waiting, note) : note)
      else if (waiting && winner(waiting, note) === note) unwritten.delete(note.id)
    }
    return isBehind
  }

  const retryPush = (io: SyncIO) => {
    if (!after || isRetryScheduled) return
    isRetryScheduled = true
    const mine = ++retryGeneration
    after(backoff(pushFailures++), () => {
      // Called off when the queue emptied meanwhile; a later failure arms its own.
      if (mine !== retryGeneration) return
      isRetryScheduled = false
      void push(io)
    })
  }

  // Sends every local note the other side doesn't have, a batch at a time. One push at a time; a
  // call while one runs makes it go round again. A failure retries on its own backoff.
  const push = async (io: SyncIO): Promise<void> => {
    await load(io)
    if (isPushing) {
      isPushAgain = true
      return
    }
    isPushing = true
    try {
      do {
        isPushAgain = false
        const dirty = dirtyOf(await io.local())
        if (isSeeded && dirty.length > 0) {
          try {
            for (let i = 0; i < dirty.length; i += PUSH_BATCH) {
              const asked = epoch
              const answer = await adapter.push(dirty.slice(i, i + PUSH_BATCH))
              // Answered by another run than the one pulled from: what it holds says nothing about
              // the current run. Start over with a full pull, which pushes again after.
              if (asked !== epoch || (answer.hub !== undefined && answer.hub !== hub)) {
                restart()
                break
              }
              await take(io, answer.notes)
            }
            pushProblem = ''
            pushFailures = 0
          } catch (error) {
            pushProblem = problemOf(error)
            retryPush(io)
          }
          await save(io)
        } else if (dirty.length === 0) {
          // Nothing left to send (a pull brought the same revisions): an old push error is moot.
          pushProblem = ''
          pushFailures = 0
        }
        await report(io)
      } while (isPushAgain)
    } finally {
      isPushing = false
    }
  }

  // The other side's run changed: the next pull is a full one, and any answer in flight is dropped.
  const restart = () => {
    cursor = null
    epoch += 1
  }

  // One pull. A full one (each session's first, and after the other side restarted) takes
  // everything there is and rebuilds what's known about it, so a note missing on either side comes
  // back; the rest wait for changes, except while unreachable: then a quick look, so what's queued
  // goes out the moment the other side is back. Rejects when the other side can't be reached.
  const pull = async (io: SyncIO): Promise<void> => {
    await load(io)
    const isFull = cursor === null
    const asked = epoch
    let result: Awaited<ReturnType<SyncAdapter['pull']>>
    try {
      result = await adapter.pull(cursor, isFull || !isReachable ? 0 : WAIT_S)
    } catch (error) {
      isReachable = false
      pullProblem = problemOf(error)
      await report(io).catch(() => undefined)
      throw error
    }
    if (asked !== epoch) return pull(io)
    if (!isFull && result.hub !== undefined && result.hub !== hub) {
      // A restart, a restore, a wiped database: this cursor belongs to another run.
      restart()
      return pull(io)
    }
    if (isFull) known = new Map()
    hub = result.hub ?? hub
    const isBehind = await take(io, result.notes)
    // A push saw the run change while this was being taken in: start over.
    if (asked !== epoch) return pull(io)
    cursor = result.cursor
    const isFirst = !isSeeded
    const wasReachable = isReachable
    isSeeded = true
    isReachable = true
    pullProblem = ''
    await save(io, isFull)
    await report(io)
    if (isFirst || isFull || !wasReachable || isBehind) await push(io)
  }

  // Pulls until `isAlive` says stop, backing off while the other side is unreachable. Each round is
  // scheduled through `schedule`, so a timer that stops (the module reloaded) ends the loop.
  const run = (io: SyncIO, schedule: (ms: number, fn: () => void) => void, isAlive: () => boolean) => {
    after = schedule
    let failures = 0
    const round = () => {
      if (!isAlive()) return
      pull(io).then(
        () => {
          failures = 0
          schedule(0, round)
        },
        () => schedule(backoff(failures++), round),
      )
    }
    round()
  }

  return { push, pull, run, status: () => status }
}

export type Sync = ReturnType<typeof createSync>
