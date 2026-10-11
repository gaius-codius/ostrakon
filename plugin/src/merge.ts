// Merge rules (SPEC §6.3), shared by local reads and every sync adapter. Two copies of a note
// (same id) are reconciled by picking a winner; the order is total, so every machine agrees.

import type { Note } from '../types'
import { serializeNote } from './frontmatter'

// Higher is more final. A tombstone (deleted) outranks every status; tombstones rank by status too.
const FINALITY: Record<Note['status'], number> = { proposed: 0, open: 1, dismissed: 2, sent: 3, archived: 4 }
const finality = (note: Note) => (note.deleted ? 10 : 0) + FINALITY[note.status]

const time = (iso: string) => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Positive when a wins. Later `updated` wins; on a tie the more final status, then the origin,
// then the whole file as written, so copies that differ in anything at all still have one winner
// and the result never depends on argument order or on which machine merges. The hub and every
// adapter use this function rather than their own reading of the rules.
export const compareNotes = (a: Note, b: Note) =>
  time(a.updated) - time(b.updated) || finality(a) - finality(b) || compareText(a.origin, b.origin) || compareText(serializeNote(a), serializeNote(b))

export const winner = (a: Note, b: Note) => (compareNotes(a, b) >= 0 ? a : b)

export const mergeAll = (notes: Iterable<Note>) => {
  const byId = new Map<string, Note>()
  for (const note of notes) {
    const seen = byId.get(note.id)
    byId.set(note.id, seen ? winner(seen, note) : note)
  }
  return byId
}

// A hybrid-logical-clock step: never earlier than the previous stamp, so a local change always
// beats the copy it changed even when this machine's clock is behind the one that wrote it.
export const nextStamp = (now: number, previous?: string) => new Date(Math.max(now, previous === undefined ? 0 : time(previous) + 1)).toISOString()

// Tombstones are kept this long after their last change, then dropped from storage.
export const PURGE_AFTER_MS = 60 * 24 * 60 * 60 * 1000

export const isPurgeable = (note: Note, now: number) => note.deleted && now - time(note.updated) > PURGE_AFTER_MS
