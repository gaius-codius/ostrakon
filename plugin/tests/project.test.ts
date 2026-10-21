import { describe, expect, test } from 'claude-code/testing'

import { serializeNote } from '../src/frontmatter'
import { folderNotes } from '../src/project'
import type { Note } from '../types'
import { MemDir } from './memdir'
import { CC, INFRA, NOTE, noteIn, put, run, startSession } from './world'

// Which project a session is (SPEC §6): a worktree is its main checkout's, and a folder that gained
// a remote doesn't stay two projects.

const FOLDER = { key: 'path:/home/me/Work/cc', name: 'cc', path: '/home/me/Work/cc' }
const ELSEWHERE = { key: 'path:/home/me/scratch', name: 'scratch', path: '/home/me/scratch' }

const POLL_MS = 2000
const HUB = { hubUrl: 'https://hub.test/', hubToken: 'secret' }

const ONE = '01JA7K2M3Q9X4ZB6C8D0EFGH01'
const TWO = '01JA7K2M3Q9X4ZB6C8D0EFGH02'
const THREE = '01JA7K2M3Q9X4ZB6C8D0EFGH03'
const FOUR = '01JA7K2M3Q9X4ZB6C8D0EFGH04'
const FIVE = '01JA7K2M3Q9X4ZB6C8D0EFGH05'

const note = (id: string, project: typeof CC | null, own: Partial<Note> = {}): Note => ({
  ...NOTE,
  extra: [],
  id,
  text: id,
  project,
  created: '2026-10-09T11:00:00.000Z',
  updated: '2026-10-09T11:00:00.000Z',
  ...own,
})

// The note saved with `text`, read back from its file.
const savedNote = (dir: MemDir, text: string) =>
  dir
    .names('/data/notes')
    .filter(name => /^[0-9A-Z]{26}\.md$/.test(name))
    .map(name => noteIn(dir, name.slice(0, -3)))
    .find(found => found.text === text)

describe('folderNotes', () => {
  test("a remote's project takes the notes kept under its folder's path, in any status, but not deleted ones", () => {
    const all = [note(ONE, FOLDER), note(TWO, FOLDER, { status: 'archived' }), note(THREE, FOLDER, { deleted: true }), note(FOUR, ELSEWHERE), note(FIVE, null)]
    expect(folderNotes(all, CC).map(found => found.id)).toEqual([ONE, TWO])
  })

  test('a folder with no remote is its path: nothing to join', () => {
    expect(folderNotes([note(ONE, FOLDER)], FOLDER)).toEqual([])
  })
})

test("a folder's notes from before it had a remote join the remote's project on the first poll", async ($, on) => {
  const dir = new MemDir()
  put(dir, ONE, 'saved before the remote', FOLDER, 90)
  dir.put(`/data/notes/${TWO}.md`, serializeNote(note(TWO, FOLDER, { status: 'archived' })))
  dir.put(`/data/notes/${THREE}.md`, serializeNote(note(THREE, FOLDER, { deleted: true })))
  put(dir, FOUR, 'another folder', ELSEWHERE, 60)
  put(dir, FIVE, 'already the remote', CC, 30)
  const { clock } = await startSession($, on, dir)
  await clock.advance(10)
  expect(noteIn(dir, ONE).project).toEqual(FOLDER)
  // With no sync configured there's nothing to wait for: the first poll moves them.
  await clock.advance(POLL_MS)
  expect(noteIn(dir, ONE).project).toEqual(CC)
  expect(noteIn(dir, ONE).text).toBe('saved before the remote')
  expect(noteIn(dir, ONE).updated > '2026-10-09T11:00:00.000Z').toBe(true)
  expect(noteIn(dir, TWO).project).toEqual(CC)
  expect(noteIn(dir, TWO).status).toBe('archived')
  expect(noteIn(dir, THREE).project).toEqual(FOLDER)
  expect(noteIn(dir, FOUR).project).toEqual(ELSEWHERE)
  expect(noteIn(dir, FIVE).project).toEqual(CC)
})

test("a session in a worktree is its main checkout's project, remote or not", async ($, on) => {
  const dir = new MemDir()
  put(dir, ONE, 'from the main checkout', FOLDER, 90)
  // The engine answers the main working tree's root for a worktree; the session's root is the worktree.
  const { clock } = await startSession($, on, dir, '', { repo: { root: '/home/me/Work/cc', remote: null }, root: '/home/me/Work/cc-wt/feature-x' })
  await run($, 'jot', 'from the worktree')
  await clock.advance(10)
  const saved = savedNote(dir, 'from the worktree')
  expect(saved?.project).toEqual(FOLDER)
  // A folder with no remote is its own path: nothing joins anything.
  expect(noteIn(dir, ONE).project).toEqual(FOLDER)
})

test('a folder that is no repo is its own project, named for the folder', async ($, on) => {
  const dir = new MemDir()
  put(dir, ONE, 'an infra note', INFRA, 90)
  const { clock } = await startSession($, on, dir, '', { repo: null, root: '/home/me/scratch' })
  await run($, 'jot', 'in a plain folder')
  await clock.advance(10)
  const saved = savedNote(dir, 'in a plain folder')
  expect(saved?.project).toEqual(ELSEWHERE)
})

// A hub that answers the first pull with `held` and keeps later long polls open until `release`.
const hubWith = (on: Parameters<typeof startSession>[1], held: Note[]) => {
  const waiting: (() => void)[] = []
  on('http.fetch', async ($, e) => {
    if (e.url.includes('/api/notes')) {
      const pushed = (JSON.parse(e.init?.body ?? '{}') as { notes: Note[] }).notes
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ notes: pushed, cursor: 2 }) } }
    }
    if (e.url.includes('wait=25')) await new Promise<void>(resolve => waiting.push(resolve))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ notes: held, cursor: 1 }) } }
  })
  return () => {
    for (const release of waiting) release()
  }
}

test('a folder note archived on another device before this session synced stays archived when it joins', { options: HUB }, async ($, on) => {
  const dir = new MemDir()
  dir.put(`/data/notes/${ONE}.md`, serializeNote(note(ONE, FOLDER)))
  // The phone archived it later than this machine's copy; the hub has that, this machine doesn't yet.
  const release = hubWith(on, [note(ONE, FOLDER, { status: 'archived', updated: '2026-10-09T11:30:00.000Z', origin: 'iphone' })])
  const { clock } = await startSession($, on, dir)
  await clock.advance(10)
  await clock.advance(POLL_MS)
  const joined = noteIn(dir, ONE)
  expect(joined.project).toEqual(CC)
  expect(joined.status).toBe('archived')
  release()
})

test('while the hub is out of reach, folder notes wait rather than join', { options: HUB }, async ($, on) => {
  const dir = new MemDir()
  dir.put(`/data/notes/${ONE}.md`, serializeNote(note(ONE, FOLDER)))
  on('http.fetch', () => ({ deny: 'connect ECONNREFUSED' }))
  const { clock } = await startSession($, on, dir)
  await clock.advance(10)
  await clock.advance(POLL_MS * 3)
  expect(noteIn(dir, ONE).project).toEqual(FOLDER)
})
