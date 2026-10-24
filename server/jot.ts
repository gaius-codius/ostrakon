// `ostrakon jot [--project <name>] <text>` (bin/ostrakon): saves a note of yours from outside Claude
// Code, a launcher or a script. It goes into this machine's notes folder the way the pane writes one,
// so sessions here pick it up, and straight to the hub when one is set up, so the phone and other
// machines have it at once. A hub that can't be reached is no failure: a session sends it later, when
// the mod has that hub.
//
// The folder and the hub come from Claude Code's settings, as the mod sees them (bin/doctor reads
// them the same way): settings.json in CLAUDE_CONFIG_DIR, else ~/.claude. OSTRAKON_HUB_URL and
// OSTRAKON_HUB_TOKEN go over the settings' hub.

import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import type { Note, NoteProject } from '../plugin/types'
import { parseNote, serializeNote } from '../plugin/src/frontmatter'
import { projectNamed, unknownProject } from '../plugin/src/harvest'
import { mergeAll } from '../plugin/src/merge'
import { labelOf, labelsOf } from '../plugin/src/model'
import { randomTag } from '../plugin/src/store'
import { ulid } from '../plugin/src/ulid'

const HUB_TIMEOUT_MS = 3000
const REFUSED = 'the hub refused the token'
const USAGE = 'usage: ostrakon jot [--project|-p <name>] <text>'

export type JotDeps = {
  home: string
  env: Record<string, string | undefined>
  host: string
  now: number
  fetch: (url: string, init: RequestInit) => Promise<Response>
}

type Settings = { envDir?: string; notesDir?: string; hubUrl?: string; hubToken?: string }

// Trimmed, as the mod reads its hub options (register.tsx).
const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
// A folder as given: the mod doesn't trim notesDir or OSTRAKON_DIR.
const path = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined)

// The plugin's options, under whichever name it was installed as (the same names bin/doctor tries).
// The hub's URL and token as a pair, from the first entry that has both, so a leftover entry's URL
// never meets another's token.
export const settingsOf = (file: string): Settings => {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  const parsed = JSON.parse(raw) as unknown
  if (typeof parsed !== 'object' || parsed === null) return {}
  const s = parsed as { env?: Record<string, unknown>; pluginConfigs?: Record<string, { options?: Record<string, unknown> }> }
  const entries = ['ostrakon', 'ostrakon@inline', 'ostrakon@ostrakon'].map(name => s.pluginConfigs?.[name]?.options)
  const hub = entries.find(options => text(options?.hubUrl) !== undefined && text(options?.hubToken) !== undefined)
  const notesDir = entries.map(options => path(options?.notesDir)).find(value => value !== undefined)
  return { envDir: path(s.env?.OSTRAKON_DIR), notesDir, hubUrl: text(hub?.hubUrl), hubToken: text(hub?.hubToken) }
}

// Where Claude Code keeps its settings: CLAUDE_CONFIG_DIR when set, as the sessions here see it.
// Appended as given, not join()ed: join would fold a `..` the filesystem resolves after a symlink.
export const settingsFileOf = (home: string, env: JotDeps['env']) => `${path(env.CLAUDE_CONFIG_DIR) ?? `${home}/.claude`}/settings.json`

// As the mod picks it (store.ts): OSTRAKON_DIR as a session sees it (the settings' env over the
// shell's), else the notesDir option, else the default; the notes are in its notes/.
export const notesDirOf = (home: string, env: JotDeps['env'], settings: Settings) => {
  const chosen = settings.envDir || env.OSTRAKON_DIR || settings.notesDir || `${home}/.local/share/ostrakon`
  return `${chosen.replace(/^~(?=\/)/, home).replace(/\/+$/, '')}/notes`
}

// The projects the notes here know, each as its newest live note has it. Copies of one note (a
// sync's conflict copy) are merged first, as the store does, so a losing copy's project doesn't count.
export const knownProjects = (dir: string): NoteProject[] => {
  const newest = new Map<string, { project: NoteProject; updated: string }>()
  const read: Note[] = []
  let names: string[] = []
  try {
    names = readdirSync(dir).filter(name => name.endsWith('.md') && !name.startsWith('.'))
  } catch {
    return []
  }
  for (const name of names) {
    try {
      read.push(parseNote(readFileSync(join(dir, name), 'utf8')))
    } catch {}
  }
  for (const note of mergeAll(read).values()) {
    if (note.deleted || note.project === null) continue
    const seen = newest.get(note.project.key)
    if (seen === undefined || seen.updated < note.updated) newest.set(note.project.key, { project: note.project, updated: note.updated })
  }
  return [...newest.values()].map(entry => entry.project)
}

type Parsed = { text: string; project?: string } | { error: string }

export const parseArgs = (args: string[]): Parsed => {
  const words: string[] = []
  let project: string | undefined
  for (let at = 0; at < args.length; at++) {
    const arg = args[at] ?? ''
    if (arg === '--') {
      words.push(...args.slice(at + 1))
      break
    }
    if (arg === '--project' || arg === '-p' || arg.startsWith('--project=')) {
      project = arg.startsWith('--project=') ? arg.slice('--project='.length) : args[++at]
      if (project === undefined || project.trim() === '') return { error: '--project needs a project name' }
    } else if (arg.startsWith('-') && arg !== '-') return { error: `unknown option: ${arg}` }
    else words.push(arg)
  }
  const joined = words.join(' ').trim()
  if (joined === '') return { error: 'nothing to save' }
  return project === undefined ? { text: joined } : { text: joined, project }
}

// What the hub said, or why it said nothing; undefined when it took the note.
const sendToHub = async (deps: JotDeps, url: string, token: string, note: Note) => {
  try {
    const response = await deps.fetch(`${url.replace(/\/+$/, '')}/api/notes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ notes: [note] }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    })
    if (response.status === 401) return REFUSED
    // A body that isn't the hub's JSON is something else answering at that address (a wrong URL).
    const body = (await response.json().catch(() => undefined)) as
      | { notes?: { id?: unknown }[]; rejected?: { reason?: unknown }[]; error?: unknown }
      | undefined
    if (typeof body !== 'object' || body === null) return `${url} didn't answer as a hub (${response.status})`
    if (!response.ok) return `the hub answered ${typeof body.error === 'string' ? body.error : response.status}`
    if (Array.isArray(body.notes) && body.notes.some(sent => sent?.id === note.id)) return undefined
    return `the hub refused it: ${String(body.rejected?.[0]?.reason ?? 'no reason given')}`
  } catch {
    return 'the hub is unreachable'
  }
}

// Saves one note; resolves what to print and the exit code.
export const jot = async (args: string[], deps: JotDeps): Promise<{ out: string[]; err: string[]; code: number }> => {
  const parsed = parseArgs(args)
  if ('error' in parsed) return { out: [], err: [`ostrakon jot: ${parsed.error}`, USAGE], code: 2 }
  const file = settingsFileOf(deps.home, deps.env)
  let settings: Settings
  try {
    settings = settingsOf(file)
  } catch {
    return { out: [], err: [`ostrakon jot: ${file} isn't valid JSON`], code: 1 }
  }
  const dir = notesDirOf(deps.home, deps.env, settings)

  let project: NoteProject | null = null
  let label = ''
  if (parsed.project !== undefined) {
    const projects = knownProjects(dir)
    const ctx = { now: deps.now, current: { key: '', name: '', path: '' }, labels: labelsOf(projects) }
    const named = projectNamed(ctx, projects, parsed.project)
    if (named === null) return { out: [], err: ['ostrakon jot: a note goes in one project, not "all".'], code: 1 }
    if (named === undefined)
      return {
        out: [],
        err: [
          `ostrakon jot: ${projects.length > 0 ? unknownProject(ctx, projects, parsed.project) : `No project named "${parsed.project.trim()}": no note here has a project yet.`}`,
        ],
        code: 1,
      }
    project = named
    label = labelOf(ctx, named)
  }

  const stamp = new Date(deps.now).toISOString()
  const note: Note = {
    id: ulid(deps.now),
    status: 'open',
    by: 'you',
    created: stamp,
    updated: stamp,
    origin: deps.host.trim() || 'unknown',
    project,
    context: {},
    sentAt: null,
    deleted: false,
    text: parsed.text,
    extra: [],
  }
  // A temp file of its own, then one rename, as the store writes (SPEC §6.2); dot files aren't read as notes.
  const tmp = join(dir, `.${note.id}.${randomTag()}.tmp`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, serializeNote(note))
    renameSync(tmp, join(dir, `${note.id}.md`))
  } catch (error) {
    rmSync(tmp, { force: true })
    return { out: [], err: [`ostrakon jot: couldn't save to ${dir}: ${error instanceof Error ? error.message : String(error)}`], code: 1 }
  }

  const saved = project === null ? 'Saved.' : `Saved to ${label}.`
  // The URL and token as a pair, from one place: the settings' token never goes to the env's URL.
  const fromEnv = Boolean(deps.env.OSTRAKON_HUB_URL || deps.env.OSTRAKON_HUB_TOKEN)
  const url = fromEnv ? text(deps.env.OSTRAKON_HUB_URL) : settings.hubUrl
  const token = fromEnv ? text(deps.env.OSTRAKON_HUB_TOKEN) : settings.hubToken
  if (!url || !token)
    return { out: [saved], err: fromEnv ? ['OSTRAKON_HUB_URL and OSTRAKON_HUB_TOKEN go together; the note is only in this folder.'] : [], code: 0 }
  const problem = await sendToHub(deps, url, token, note)
  if (problem === undefined) return { out: [saved], err: [], code: 0 }
  // Sessions here push it later only when the mod itself has that hub, and a token it takes.
  const same = (a: string | undefined) => a?.replace(/\/+$/, '')
  const sessionsHub = !fromEnv || same(url) === same(settings.hubUrl)
  const later =
    sessionsHub && problem === REFUSED
      ? token === settings.hubToken
        ? "Sessions here use that token too: copy HUB_TOKEN from the hub's env file into hubToken."
        : 'Sessions here use the hubToken in the settings.'
      : sessionsHub
        ? 'Claude Code sends it once a session runs here.'
        : settings.hubUrl
          ? `Sessions here send it to the mod's hub, not that one.`
          : `No session here uses that hub, so it stays only in ${dir}.`
  return { out: [saved], err: [`Only on this machine for now: ${problem}. ${later}`], code: 0 }
}

if (import.meta.main) {
  // bin/ostrakon passes `jot` first, so Bun never takes a `--` the person typed as its own.
  const [first, ...rest] = Bun.argv.slice(2)
  const result = await jot(first === 'jot' ? rest : Bun.argv.slice(2), {
    home: process.env.HOME ?? '',
    env: process.env,
    host: hostname(),
    now: Date.now(),
    fetch,
  })
  for (const line of result.out) console.log(line)
  for (const line of result.err) console.error(line)
  process.exit(result.code)
}
