import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Note } from '../plugin/types'
import { PAIR_TTL_MS, VERSION, handler, openHub, pairLink, toNote } from './hub'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const fresh = (auth: { token?: string; login?: string } = { token: 'secret', login: 'owner@example.com' }) => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-test-'))
  dirs.push(dir)
  const hub = openHub(dir)
  let clock = Date.parse('2026-10-10T00:00:00Z')
  const fetch = handler(hub, auth, { now: () => clock })
  const call = (path: string, init: RequestInit & { auth?: string | null } = {}) =>
    fetch(
      new Request(`http://hub${path}`, {
        ...init,
        headers: { ...(init.auth === null ? {} : { authorization: `Bearer ${init.auth ?? 'secret'}` }), ...(init.headers as Record<string, string> | undefined) },
      }),
    )
  return { dir, hub, call, advance: (ms: number) => (clock += ms) }
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
    const health = await call('/healthz', { auth: null })
    expect(health.status).toBe(200)
    expect(await health.text()).toBe(`ok ${VERSION}\n`)
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
    const broken = await call('/api/jot', { method: 'POST', body: '{not json' })
    expect(broken.status).toBe(400)
    expect(await broken.json()).toEqual({ error: 'invalid JSON body' })
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

describe('pairing codes', () => {
  const mint = async (call: ReturnType<typeof fresh>['call']) => ((await (await call('/api/pair', { method: 'POST' })).json()) as { code: string; expiresIn: number })
  const claim = (call: ReturnType<typeof fresh>['call'], code: string, headers: Record<string, string> = {}) =>
    call('/api/pair/claim', { method: 'POST', auth: null, headers, body: JSON.stringify({ code }) })

  test('minting needs the token or the owner login, and a hub with no token has none to hand out', async () => {
    const { call } = fresh()
    expect((await call('/api/pair', { method: 'POST', auth: null })).status).toBe(401)
    expect((await call('/api/pair', { method: 'POST', auth: 'wrong' })).status).toBe(401)
    const minted = await mint(call)
    expect(minted.code).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(minted.expiresIn).toBe(PAIR_TTL_MS / 1000)
    const login = fresh({ login: 'owner@example.com' })
    const response = await login.call('/api/pair', { method: 'POST', auth: null, headers: { 'tailscale-user-login': 'owner@example.com' } })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'the hub has no HUB_TOKEN to hand out' })
  })

  test('a code gives the token once, with no Authorization header', async () => {
    const { call } = fresh()
    const { code } = await mint(call)
    const first = await claim(call, code)
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ token: 'secret' })
    expect((await claim(call, code)).status).toBe(401)
  })

  test('an unknown code, an expired one and a missing one are all refused alike', async () => {
    const { call, advance } = fresh()
    const unknown = await claim(call, 'nope')
    expect(unknown.status).toBe(401)
    const { code } = await mint(call)
    advance(PAIR_TTL_MS + 1)
    const expired = await claim(call, code)
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual(await unknown.json())
    expect((await call('/api/pair/claim', { method: 'POST', auth: null, body: 'not json' })).status).toBe(401)
  })

  test('a code still works just inside its time, and only the newest few are kept', async () => {
    const { call, advance } = fresh()
    const { code } = await mint(call)
    advance(PAIR_TTL_MS - 1)
    expect((await claim(call, code)).status).toBe(200)
    const first = await mint(call)
    for (let i = 0; i < 10; i++) await mint(call)
    expect((await claim(call, first.code)).status).toBe(401)
  })

  test("a claim from another site's page is refused, and the code survives it", async () => {
    const { call } = fresh()
    const { code } = await mint(call)
    expect((await claim(call, code, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await claim(call, code, { origin: 'http://hub' })).status).toBe(200)
  })
})

describe('pairLink', () => {
  test('adds the trailing slash and the token', () => {
    expect(pairLink('https://hub.example.ts.net:8443', { token: 'abc' })).toBe('https://hub.example.ts.net:8443/?token=abc')
    expect(pairLink('https://hub.example.ts.net:8443/', { token: 'abc' })).toBe('https://hub.example.ts.net:8443/?token=abc')
  })

  test('builds a pairing link', () => {
    expect(pairLink('https://hub.example.ts.net:8443', { pair: 'abc' })).toBe('https://hub.example.ts.net:8443/?pair=abc')
  })

  test('keeps a path and drops any query or fragment', () => {
    expect(pairLink('https://example.ts.net/hub', { token: 't' })).toBe('https://example.ts.net/hub/?token=t')
    expect(pairLink('https://example.ts.net/hub/?x=1#y', { pair: 't' })).toBe('https://example.ts.net/hub/?pair=t')
  })

  test('encodes the token', () => {
    expect(pairLink('https://example.ts.net', { token: 'a b&c=d/+' })).toBe('https://example.ts.net/?token=a%20b%26c%3Dd%2F%2B')
  })

  test('throws on http and on a bad URL', () => {
    expect(() => pairLink('http://example.ts.net:8443', { token: 't' })).toThrow('https')
    expect(() => pairLink('example.ts.net', { pair: 't' })).toThrow('not a valid URL')
  })
})
