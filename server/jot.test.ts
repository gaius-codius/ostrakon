import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Note } from '../plugin/types'
import { parseNote, serializeNote } from '../plugin/src/frontmatter'
import { handler, openHub } from './hub'
import { type JotDeps, jot, parseArgs } from './jot'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jot-test-'))
  dirs.push(dir)
  return dir
}

const NOW = Date.parse('2026-10-24T10:00:00Z')
const offline: JotDeps['fetch'] = () => Promise.reject(new Error('no network'))

const setup = (settings?: unknown, env: JotDeps['env'] = {}, fetch: JotDeps['fetch'] = offline) => {
  const home = temp()
  if (settings !== undefined) {
    mkdirSync(join(home, '.claude'))
    writeFileSync(join(home, '.claude', 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings))
  }
  const deps: JotDeps = { home, env, host: 'desk', now: NOW, fetch }
  const notes = (dir = join(home, '.local/share/ostrakon/notes')) =>
    readdirSync(dir).map(name => ({ name, note: parseNote(readFileSync(join(dir, name), 'utf8')) }))
  return { home, deps, notes }
}

const cc = { key: 'github.com/me/cc', name: 'cc', path: '/w/cc' }
const existing = (id: string, project: Note['project'], fields: Partial<Note> = {}): Note => ({
  id,
  status: 'open',
  by: 'you',
  created: '2026-10-10T01:00:00.000Z',
  updated: '2026-10-10T01:00:00.000Z',
  origin: 'laptop',
  project,
  context: {},
  sentAt: null,
  deleted: false,
  text: 'older',
  extra: [],
  ...fields,
})
const seed = (dir: string, notes: Note[]) => {
  mkdirSync(dir, { recursive: true })
  for (const note of notes) writeFileSync(join(dir, `${note.id}.md`), serializeNote(note))
}

describe('ostrakon jot', () => {
  test('saves an open note of yours, with this machine as its origin, in the default folder', async () => {
    const { deps, notes } = setup()
    const result = await jot(['call', 'the', 'plumber'], deps)
    expect(result).toEqual({ out: ['Saved.'], err: [], code: 0 })
    const [saved] = notes()
    expect(saved?.name).toBe(`${saved?.note.id}.md`)
    expect(saved?.note).toMatchObject({
      text: 'call the plumber',
      by: 'you',
      origin: 'desk',
      status: 'open',
      project: null,
      created: '2026-10-24T10:00:00.000Z',
    })
  })

  test('files it under a project the notes already know, by name or key, and refuses one they do not', async () => {
    const { home, deps, notes } = setup()
    const dir = join(home, '.local/share/ostrakon/notes')
    seed(dir, [existing('01JA7K2M3Q9X4ZB6C8D0EFGHJK', cc)])
    expect((await jot(['--project', 'cc', 'fix the flaky test'], deps)).out).toEqual(['Saved to cc.'])
    expect((await jot(['--project=github.com/me/cc', 'second'], deps)).code).toBe(0)
    expect(notes().filter(({ note }) => note.project?.key === cc.key)).toHaveLength(3)
    const refused = await jot(['-p', 'nope', 'third'], deps)
    expect(refused.code).toBe(1)
    expect(refused.err[0]).toContain('Known: cc')
    expect(notes()).toHaveLength(3)
  })

  test('refuses a project when no note has one yet', async () => {
    const { deps } = setup()
    expect((await jot(['-p', 'cc', 'x'], deps)).err).toEqual(['ostrakon jot: No project named "cc": no note here has a project yet.'])
  })

  test('uses the folder the mod uses: the settings env, the shell env, then the notesDir option', async () => {
    const custom = temp()
    const fromOption = setup({ pluginConfigs: { ostrakon: { options: { notesDir: custom } } } })
    await jot(['a'], fromOption.deps)
    expect(fromOption.notes(join(custom, 'notes'))).toHaveLength(1)

    const shell = temp()
    const fromShell = setup({ pluginConfigs: { ostrakon: { options: { notesDir: custom } } } }, { OSTRAKON_DIR: shell })
    await jot(['b'], fromShell.deps)
    expect(fromShell.notes(join(shell, 'notes'))).toHaveLength(1)

    const settingsEnv = temp()
    const fromSettings = setup({ env: { OSTRAKON_DIR: settingsEnv } }, { OSTRAKON_DIR: shell })
    await jot(['c'], fromSettings.deps)
    expect(fromSettings.notes(join(settingsEnv, 'notes'))).toHaveLength(1)
  })

  test('sends the note to the hub at once when one is set up', async () => {
    const hub = openHub(temp())
    const serve = handler(hub, { token: 'secret' })
    const fetch: JotDeps['fetch'] = (url, init) => serve(new Request(url, init))
    const { deps, notes } = setup({ pluginConfigs: { 'ostrakon@ostrakon': { options: { hubUrl: 'https://hub/', hubToken: 'secret' } } } }, {}, fetch)
    const result = await jot(['from the desk'], deps)
    expect(result).toEqual({ out: ['Saved.'], err: [], code: 0 })
    const [local] = notes()
    expect(hub.changes(0).notes).toEqual(local ? [local.note] : [])
    expect(local).toBeDefined()
  })

  test('keeps the note here and says so when the hub is down or refuses it', async () => {
    const { deps, notes } = setup({}, { OSTRAKON_HUB_URL: 'https://hub', OSTRAKON_HUB_TOKEN: 'secret' })
    const down = await jot(['one'], deps)
    expect(down.code).toBe(0)
    expect(down.err[0]).toContain('the hub is unreachable')

    const refusing = setup(
      {},
      { OSTRAKON_HUB_URL: 'https://hub', OSTRAKON_HUB_TOKEN: 'wrong' },
      async () => new Response('{"error":"unauthorized"}', { status: 401 }),
    )
    expect((await jot(['two'], refusing.deps)).err[0]).toContain('refused the token')
    expect(notes()).toHaveLength(1)
    expect(refusing.notes()).toHaveLength(1)
  })

  test('refuses an empty note and unknown options without saving', async () => {
    const { deps, home } = setup()
    expect((await jot([], deps)).code).toBe(2)
    expect((await jot(['--project', 'cc'], deps)).code).toBe(2)
    expect((await jot(['--force', 'x'], deps)).code).toBe(2)
    expect(() => readdirSync(join(home, '.local/share/ostrakon/notes'))).toThrow()
  })

  test('reads text after -- as it is', () => {
    expect(parseArgs(['--', '--project', 'is', 'text'])).toEqual({ text: '--project is text' })
  })
})
