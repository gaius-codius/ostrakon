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

  test('a conflict copy that lost the merge brings no project of its own', async () => {
    const { deps, home } = setup()
    const other = { key: 'github.com/old/cc', name: 'cc', path: '/old/cc' }
    const dir = join(home, '.local/share/ostrakon/notes')
    seed(dir, [existing('01JA7K2M3Q9X4ZB6C8D0EFGHJK', cc, { updated: '2026-10-11T00:00:00.000Z' })])
    writeFileSync(join(dir, '01JA7K2M3Q9X4ZB6C8D0EFGHJK (conflict).md'), serializeNote(existing('01JA7K2M3Q9X4ZB6C8D0EFGHJK', other)))
    expect((await jot(['-p', 'cc', 'x'], deps)).out).toEqual(['Saved to cc.'])
  })

  test('trims the hub settings, as the mod does', async () => {
    const seen: string[] = []
    const spy: JotDeps['fetch'] = async url => {
      seen.push(url)
      return new Response('{}', { status: 500 })
    }
    const { deps } = setup({ pluginConfigs: { ostrakon: { options: { hubUrl: ' https://hub/ ', hubToken: ' t ' } } } }, {}, spy)
    await jot(['x'], deps)
    expect(seen).toEqual(['https://hub/api/notes'])
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

  test('takes the hub URL and token as a pair: the settings token never goes to an env URL', async () => {
    const seen: string[] = []
    const spy: JotDeps['fetch'] = async (url, init) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`)
      return new Response('{}', { status: 500 })
    }
    const settings = { pluginConfigs: { ostrakon: { options: { hubUrl: 'https://real', hubToken: 'real-token' } } } }
    const halfEnv = setup(settings, { OSTRAKON_HUB_URL: 'https://test' }, spy)
    expect((await jot(['x'], halfEnv.deps)).err[0]).toContain('go together')
    expect(seen).toEqual([])
    const fromSettings = setup(settings, {}, spy)
    const down = await jot(['y'], fromSettings.deps)
    expect(seen).toEqual(['https://real/api/notes Bearer real-token'])
    expect(down.err[0]).toContain('Claude Code sends it')
  })

  test("reads the hub from one plugin entry: a leftover entry's URL never gets another's token", async () => {
    const seen: string[] = []
    const spy: JotDeps['fetch'] = async (url, init) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`)
      return new Response('{}', { status: 500 })
    }
    const settings = {
      pluginConfigs: {
        ostrakon: { options: { hubUrl: 'https://old' } },
        'ostrakon@ostrakon': { options: { hubUrl: 'https://current', hubToken: 'live-token' } },
      },
    }
    const { deps } = setup(settings, {}, spy)
    await jot(['x'], deps)
    expect(seen).toEqual(['https://current/api/notes Bearer live-token'])
  })

  test("a leftover entry with only a folder doesn't hide another entry's hub", async () => {
    const seen: string[] = []
    const spy: JotDeps['fetch'] = async url => {
      seen.push(url)
      return new Response('{}', { status: 500 })
    }
    const old = temp()
    const settings = { pluginConfigs: { ostrakon: { options: { notesDir: old } }, 'ostrakon@ostrakon': { options: { hubUrl: 'https://hub', hubToken: 't' } } } }
    const { deps, notes } = setup(settings, {}, spy)
    await jot(['x'], deps)
    expect(seen).toEqual(['https://hub/api/notes'])
    expect(readdirSync(join(old, 'notes'))).toHaveLength(1)
    expect(() => notes()).toThrow()
  })

  test("with an env hub other than the mod's, says a session sends it to the mod's hub", async () => {
    const down: JotDeps['fetch'] = async () => new Response('{}', { status: 500 })
    const settings = { pluginConfigs: { ostrakon: { options: { hubUrl: 'https://mods', hubToken: 't' } } } }
    const other = setup(settings, { OSTRAKON_HUB_URL: 'https://other', OSTRAKON_HUB_TOKEN: 'u' }, down)
    expect((await jot(['x'], other.deps)).err[0]).toContain("send it to the mod's hub")
    const same = setup(settings, { OSTRAKON_HUB_URL: 'https://mods/', OSTRAKON_HUB_TOKEN: 'u' }, down)
    expect((await jot(['x'], same.deps)).err[0]).toContain('Claude Code sends it')
  })

  test('reads the settings from CLAUDE_CONFIG_DIR when it is set, as the sessions do', async () => {
    const seen: string[] = []
    const spy: JotDeps['fetch'] = async url => {
      seen.push(url)
      return new Response('{}', { status: 500 })
    }
    const moved = temp()
    const folder = temp()
    writeFileSync(
      join(moved, 'settings.json'),
      JSON.stringify({ pluginConfigs: { ostrakon: { options: { notesDir: folder, hubUrl: 'https://moved', hubToken: 't' } } } }),
    )
    const { deps, notes } = setup({ pluginConfigs: { ostrakon: { options: { hubUrl: 'https://home', hubToken: 't' } } } }, { CLAUDE_CONFIG_DIR: moved }, spy)
    expect((await jot(['x'], deps)).out).toEqual(['Saved.'])
    expect(readdirSync(join(folder, 'notes'))).toHaveLength(1)
    expect(seen).toEqual(['https://moved/api/notes'])
    expect(() => notes()).toThrow()

    writeFileSync(join(moved, 'settings.json'), '{')
    expect((await jot(['y'], deps)).err).toEqual([`ostrakon jot: ${join(moved, 'settings.json')} isn't valid JSON`])
  })

  test("doesn't say a session sends it later when the hub refused the token the sessions use", async () => {
    const refusing: JotDeps['fetch'] = async () => new Response('{"error":"unauthorized"}', { status: 401 })
    const settings = { pluginConfigs: { ostrakon: { options: { hubUrl: 'https://hub', hubToken: 'stale' } } } }
    const fromSettings = setup(settings, {}, refusing)
    const refused = await jot(['x'], fromSettings.deps)
    expect(refused.code).toBe(0)
    expect(refused.err[0]).toContain('refused the token')
    expect(refused.err[0]).not.toContain('Claude Code sends it')
    expect(refused.err[0]).toContain('copy HUB_TOKEN')

    const otherToken = setup(settings, { OSTRAKON_HUB_URL: 'https://hub', OSTRAKON_HUB_TOKEN: 'typo' }, refusing)
    const envRefused = (await jot(['y'], otherToken.deps)).err[0]
    expect(envRefused).not.toContain('Claude Code sends it')
    expect(envRefused).toContain('hubToken in the settings')
  })

  test('keeps the notesDir option as given, as the mod does', async () => {
    const custom = `${temp()} `
    const { deps } = setup({ pluginConfigs: { ostrakon: { options: { notesDir: custom } } } })
    await jot(['x'], deps)
    expect(readdirSync(join(custom, 'notes'))).toHaveLength(1)
  })

  test('says something else answered when the reply is not the hub', async () => {
    const html: JotDeps['fetch'] = async () => new Response('<html>tailscale</html>', { status: 200 })
    const { deps } = setup({}, { OSTRAKON_HUB_URL: 'https://wrong', OSTRAKON_HUB_TOKEN: 't' }, html)
    const result = await jot(['x'], deps)
    expect(result.err[0]).toContain("https://wrong didn't answer as a hub (200)")
    expect(result.err[0]).toContain('No session here uses that hub')
  })

  test('refuses an empty project name and "all"', async () => {
    const { deps, home } = setup()
    seed(join(home, '.local/share/ostrakon/notes'), [existing('01JA7K2M3Q9X4ZB6C8D0EFGHJK', cc)])
    expect((await jot(['--project=', 'x'], deps)).code).toBe(2)
    expect((await jot(['--project', 'all', 'x'], deps)).err).toEqual(['ostrakon jot: a note goes in one project, not "all".'])
  })

  test('the command keeps text that starts with a dash after --', async () => {
    const home = temp()
    const run = Bun.spawnSync(['bash', join(import.meta.dir, '../bin/ostrakon'), 'jot', '--', '-5 degrees outside'], {
      env: { HOME: home, PATH: process.env.PATH ?? '' },
    })
    expect(run.stdout.toString()).toBe('Saved.\n')
    const dir = join(home, '.local/share/ostrakon/notes')
    const [name] = readdirSync(dir)
    expect(parseNote(readFileSync(join(dir, name ?? ''), 'utf8')).text).toBe('-5 degrees outside')
  })

  test('reads text after -- as it is', () => {
    expect(parseArgs(['--', '--project', 'is', 'text'])).toEqual({ text: '--project is text' })
  })
})
