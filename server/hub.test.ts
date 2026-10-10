import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Note } from '../plugin/types'
import { handler, openHub, toNote } from './hub'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-test-'))
  dirs.push(dir)
  const hub = openHub(dir)
  const fetch = handler(hub, { token: 'secret', login: 'owner@example.com' })
  const call = (path: string, init: RequestInit & { auth?: string | null } = {}) =>
    fetch(
      new Request(`http://hub${path}`, {
        ...init,
        headers: { ...(init.auth === null ? {} : { authorization: `Bearer ${init.auth ?? 'secret'}` }), ...(init.headers as Record<string, string> | undefined) },
      }),
    )
  return { dir, hub, call }
}

const note = (id: string, fields: Partial<Note> = {}): Note => ({
  id,
  status: 'open',
  by: 'you',
  created: '2026-10-10T01:00:00.000Z',
  updated: '2026-10-10T01:00:00.000Z',
  origin: 'office',
  project: { key: 'github.com/me/cc', name: 'cc', path: '/home/me/cc' },
  context: {},
  sentAt: null,
  deleted: false,
  text: 'a note',
  extra: [],
  ...fields,
})

const A = '01JA7K2M3Q9X4ZB6C8D0EFGH0A'
const B = '01JA7K2M3Q9X4ZB6C8D0EFGH0B'

describe('hub', () => {
  test('a push stores the merge winner and moves the cursor only when the stored copy changes', async () => {
    const { call } = fresh()
    const push = async (...notes: Note[]) => (await (await call('/api/notes', { method: 'POST', body: JSON.stringify({ notes }) })).json()) as { notes: Note[]; cursor: number }
    expect((await push(note(A))).cursor).toBe(1)
    expect((await push(note(A))).cursor).toBe(1)
    const older = await push(note(A, { updated: '2026-10-09T00:00:00.000Z', text: 'stale' }))
    expect(older.cursor).toBe(1)
    expect(older.notes[0]?.text).toBe('a note')
    const newer = await push(note(A, { updated: '2026-10-10T02:00:00.000Z', text: 'newer' }))
    expect(newer.cursor).toBe(2)
    const changes = (await (await call('/api/changes?since=1')).json()) as { notes: Note[]; cursor: number }
    expect(changes.notes.map(n => n.text)).toEqual(['newer'])
  })

  test('a long poll returns as soon as something changes', async () => {
    const { call } = fresh()
    const started = Date.now()
    const waiting = call('/api/changes?since=0&wait=5')
    setTimeout(() => void call('/api/notes', { method: 'POST', body: JSON.stringify({ notes: [note(B)] }) }), 100)
    const body = (await (await waiting).json()) as { notes: Note[]; cursor: number }
    expect(body.notes.map(n => n.id)).toEqual([B])
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('a cursor from a hub that was reset starts over', async () => {
    const { call } = fresh()
    await call('/api/notes', { method: 'POST', body: JSON.stringify({ notes: [note(A)] }) })
    const body = (await (await call('/api/changes?since=99')).json()) as { notes: Note[] }
    expect(body.notes.map(n => n.id)).toEqual([A])
  })

  test('every /api call needs the token or the owner login; the page itself does not', async () => {
    const { call } = fresh()
    expect((await call('/api/changes', { auth: null })).status).toBe(401)
    expect((await call('/api/changes', { auth: 'wrong' })).status).toBe(401)
    expect((await call('/api/changes', { auth: null, headers: { 'tailscale-user-login': 'someone@else.com' } })).status).toBe(401)
    expect((await call('/api/changes', { auth: null, headers: { 'tailscale-user-login': 'owner@example.com' } })).status).toBe(200)
    expect((await call('/healthz', { auth: null })).status).toBe(200)
    expect((await call('/../hub.ts', { auth: null })).status).toBe(404)
  })

  test('a note that is not one is refused, and the rest of the batch still lands', async () => {
    const { call } = fresh()
    const response = await call('/api/notes', {
      method: 'POST',
      body: JSON.stringify({ notes: [note(A), { ...note(B), status: 'pending' }, { ...note('../etc') }, { text: 'no id' }] }),
    })
    const body = (await response.json()) as { notes: Note[]; rejected: { reason: string }[] }
    expect(body.notes.map(n => n.id)).toEqual([A])
    expect(body.rejected).toHaveLength(3)
  })

  test('toNote keeps unknown front-matter lines and refuses what would not round-trip', () => {
    expect(toNote(note(A, { extra: ['tags: [ostrakon]'] })).extra).toEqual(['tags: [ostrakon]'])
    expect(() => toNote(note(A, { updated: 'yesterday' }))).toThrow()
    expect(() => toNote(note(A, { extra: ['not yaml at all'] }))).toThrow()
  })

  test('jot makes a phone note from one line, filed under a known project by key or name', async () => {
    const { call } = fresh()
    await call('/api/notes', { method: 'POST', body: JSON.stringify({ notes: [note(A)] }) })
    const body = (await (await call('/api/jot', { method: 'POST', body: JSON.stringify({ text: ' call the plumber ', project: 'cc' }) })).json()) as { note: Note }
    expect(body.note).toMatchObject({ text: 'call the plumber', by: 'phone', origin: 'iphone', status: 'open', project: { key: 'github.com/me/cc' } })
    const plain = (await (await call('/api/jot', { method: 'POST', body: JSON.stringify({ text: 'x', project: 'nope' }) })).json()) as { note: Note }
    expect(plain.note.project).toBeNull()
    expect((await call('/api/jot', { method: 'POST', body: '{}' })).status).toBe(400)
  })

  test('projects come from live notes, most recent first', async () => {
    const { call } = fresh()
    const infra = { key: 'github.com/me/infra', name: 'infra', path: '/x' }
    await call('/api/notes', {
      method: 'POST',
      body: JSON.stringify({
        notes: [note(A), note(B, { project: infra, updated: '2026-10-10T05:00:00.000Z' }), note('01JA7K2M3Q9X4ZB6C8D0EFGH0C', { project: { key: 'gone', name: 'gone', path: '' }, deleted: true })],
      }),
    })
    const body = (await (await call('/api/projects')).json()) as { projects: { key: string }[] }
    expect(body.projects.map(p => p.key)).toEqual(['github.com/me/infra', 'github.com/me/cc'])
  })

  test('a backup is a readable copy, and only the last week is kept', () => {
    const { dir, hub } = fresh()
    hub.push([note(A)])
    for (let day = 1; day <= 9; day++) hub.backup(new Date(`2026-10-0${day}T03:00:00Z`))
    const file = hub.backup(new Date('2026-10-10T03:00:00Z'))
    expect(existsSync(file)).toBe(true)
    const copy = new Database(file, { readonly: true })
    expect(copy.query<{ id: string }, []>('SELECT id FROM notes').all().map(row => row.id)).toEqual([A])
    copy.close()
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(7)
  })

  test('each run of the hub has its own id, so clients notice a restart or a restore', async () => {
    const { dir, hub, call } = fresh()
    const first = (await (await call('/api/changes')).json()) as { hub: string }
    expect(first.hub).toBe(hub.id)
    hub.close()
    const again = openHub(dir)
    expect(again.id).not.toBe(hub.id)
    again.close()
  })

  test('tombstones older than the keep time are purged; live notes and the cursor stay', () => {
    const { hub } = fresh()
    const old = '2026-01-01T00:00:00.000Z'
    hub.push([note(A, { deleted: true, updated: old }), note(B, { updated: old })])
    expect(hub.purge(Date.parse('2026-10-10T00:00:00Z'))).toBe(1)
    expect(hub.changes(0).notes.map(n => n.id)).toEqual([B])
    expect(hub.cursor()).toBe(2)
    hub.close()
  })

  test('the cursor never moves back, even when a purge removed the row that held the last seq', () => {
    const { dir, hub } = fresh()
    const old = '2026-01-01T00:00:00.000Z'
    hub.push([note(A, { updated: old }), note(B, { deleted: true, updated: old })])
    hub.purge(Date.parse('2026-10-10T00:00:00Z'))
    hub.close()
    const again = openHub(dir)
    expect(again.cursor()).toBe(2)
    again.close()
  })

  test("the owner login alone can't write from another site's page", async () => {
    const { call } = fresh()
    const owner = { 'tailscale-user-login': 'owner@example.com' }
    const jot = (headers: Record<string, string>) => call('/api/jot', { method: 'POST', auth: null, headers, body: JSON.stringify({ text: 'x' }) })
    expect((await jot({ ...owner, origin: 'https://evil.example' })).status).toBe(401)
    expect((await jot({ ...owner, origin: 'http://hub' })).status).toBe(200)
    expect((await jot(owner)).status).toBe(200)
    // The token works from anywhere: it's never sent by a browser on its own.
    expect((await call('/api/jot', { method: 'POST', headers: { origin: 'https://evil.example' }, body: JSON.stringify({ text: 'y' }) })).status).toBe(200)
  })

  test('a database from before the meta table keeps its cursor through a purge', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-test-'))
    dirs.push(dir)
    const old = new Database(join(dir, 'hub.sqlite'), { create: true })
    old.run('CREATE TABLE notes (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated TEXT NOT NULL, origin TEXT NOT NULL, seq INTEGER NOT NULL)')
    const tomb = note(B, { deleted: true, updated: '2026-01-01T00:00:00.000Z' })
    old.query('INSERT INTO notes VALUES (?, ?, ?, ?, ?)').run(B, JSON.stringify(tomb), tomb.updated, tomb.origin, 2)
    old.close()
    const hub = openHub(dir)
    hub.purge(Date.parse('2026-10-10T00:00:00Z'))
    hub.close()
    const again = openHub(dir)
    expect(again.cursor()).toBe(2)
    again.close()
  })

  test('the manifest carries the token in its start URL only when asked with the right one', async () => {
    const { call } = fresh()
    const right = (await (await call('/manifest.json?token=secret', { auth: null })).json()) as { start_url: string }
    expect(right.start_url).toBe('./?token=secret')
    const wrong = (await (await call('/manifest.json?token=nope', { auth: null })).json()) as { start_url: string }
    expect(wrong.start_url).toBe('./')
  })

  test('the page opened with the right token links the manifest with it from the start', async () => {
    const { call } = fresh()
    expect(await (await call('/?token=secret', { auth: null })).text()).toContain('<link rel="manifest" href="manifest.json?token=secret">')
    expect(await (await call('/?token=nope', { auth: null })).text()).toContain('<link rel="manifest" href="manifest.json">')
    expect(await (await call('/', { auth: null })).text()).toContain('<link rel="manifest" href="manifest.json">')
  })
})
