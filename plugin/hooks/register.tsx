import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register } from 'claude-code'

import type { Note, NoteProblem, NoteProject, NoteStatus, PaneState, SyncState } from '../types'
import { focusMove, needsView, pagedSlot, routeFocus } from '../src/focus'
import { createMirrorStore } from '../src/mirror'
import type { Action, Ctx, Focus, Line } from '../src/model'
import {
  bundleText,
  canEditInline,
  dispatchText,
  freshPane,
  fromField,
  keysFor,
  labelOf,
  labelsOf,
  linesOf,
  ownKeys,
  pageOf,
  parseQuery,
  toField,
  visibleNotes,
} from '../src/model'
import {
  ARCHIVE_DESCRIPTION,
  ARCHIVE_REPLY,
  ARCHIVE_SCHEMA,
  ARCHIVE_TOOL,
  DEFAULT_HARVEST_MODE,
  JOT_DESCRIPTION,
  JOT_REPLY,
  JOT_SCHEMA,
  JOT_TOOL,
  NOTES_DESCRIPTION,
  NOTES_SCHEMA,
  NOTES_TOOL,
  duplicateOf,
  harvestModeOf,
  jotText,
  lightRequest,
  notesReply,
  parseReview,
  projectNamed,
  reviewPrompt,
  unknownProject,
} from '../src/harvest'
import type { HarvestMode } from '../src/harvest'
import { basename, normalizeRemote } from '../src/project'
import { freshReport, withProblem } from '../src/report'
import { StorageError, createStore } from '../src/store'
import type { StoreIO } from '../src/store'
import { createSync } from '../src/sync/core'
import type { Sync, SyncIO } from '../src/sync/core'
import { ARCHIVE_FOLDER, folderAdapter } from '../src/sync/folder'
import type { MirrorIO } from '../src/sync/folder'
import { hubAdapter } from '../src/sync/hub'
import {
  canReview,
  freshTurns,
  isHarvestShown,
  mergeHarvest,
  sessionEnded,
  sessionRestored,
  sessionStarted,
  turnCompleted,
  turnProposals,
  turnStarted,
  waitingProposals,
} from '../src/turns'
import type { RunningTurn } from '../src/turns'
import { HarvestRow, PocketRow, harvestOf, openerOf, pocketOf } from '../src/ui/band'
import type { BandHandlers } from '../src/ui/band'
import { HINT, MS, TEXT, TOAST, toneOf } from '../src/ui/look'
import type { Tone } from '../src/ui/look'
import { CAPTURE_KEY, EDIT_KEY, MOVE_KEY, Pane, SEARCH_KEY, SEND_KEY, chromeRows, sheetPages, slotKey } from '../src/ui/pane'
import type { Handlers, PaneView } from '../src/ui/pane'

const PANE = 'ostrakon'
// $.store key: the scope the pane opens on, when the person chose all (SPEC §4.2).
const SCOPE_KEY = 'scope'
// $.store key: how many harvests have shown the hint line (SPEC §10).
const HARVEST_HINTS_KEY = 'harvestHints'
const POLL_MS = 2000
// After a refused close (Esc as back), when the keys have gone back to the prompt.
const REFOCUS_MS = 60

// The session's state values. $.state resets on /clear, /resume and /branch; the store reloads
// notes from disk then, so nothing here is the only copy of a note.
const isOpen = atom({ plugin: 'ostrakon', key: 'isOpen' } as const, false)
const notes = atom({ plugin: 'ostrakon', key: 'notes' } as const, {})
const problems = atom({ plugin: 'ostrakon', key: 'problems' } as const, [])
const pane = atom({ plugin: 'ostrakon', key: 'pane' } as const, freshPane())
// Shaped: the value was a list of ids before the band was drawn against the latest turn.
const harvest = atom({ plugin: 'ostrakon', key: 'harvest' } as const, null, { shape: 'order' })
const turns = atom(
  { plugin: 'ostrakon', key: 'turns' } as const,
  { latest: '', latestOrder: { generation: 0, seq: 0 }, running: '', generation: 0, seq: 0 },
  { shape: 'order' },
)
const syncState = atom({ plugin: 'ostrakon', key: 'sync' } as const, { isOn: false, isOnline: false, queued: 0, problem: '' })
const mirrorState = atom({ plugin: 'ostrakon', key: 'mirror' } as const, { isOn: false, isOnline: false, queued: 0, problem: '' })
// The hint line's tail (SPEC §4.4): a /jot draft says what Enter will do, then that it did.
const isJotDraft = atom({ plugin: 'ostrakon', key: 'isJotDraft' } as const, false)
const savedAt = atom({ plugin: 'ostrakon', key: 'savedAt' } as const, 0)
// The band (SPEC §10): the note just saved, whose chip stands out for MS.fresh, and the turn whose
// harvest still carries the dim hint line.
const fresh = atom({ plugin: 'ostrakon', key: 'fresh' } as const, '')
const harvestHint = atom({ plugin: 'ostrakon', key: 'harvestHint' } as const, '')

// The pane's last drawn geometry: actions page and focus against what the person sees.
const geometry = { bodyRows: 30, width: 70, isInline: false, isFocused: true }
// This session's project, found once at session start.
let project: NoteProject = { key: 'path:/', name: '/', path: '/' }
// False until session start finds the project: harvest proposes nothing under the placeholder.
let isProjectKnown = false
// How the person's theme draws project colours: read at session start and when /config changes it.
let tone: Tone = 'dark'
// The element the ring was last on: Shift+Tab off the search field lands on the action layer,
// and is sent to the last row instead of back.
let lastElement: string | undefined
// Bumped on every close: a send that completes after the pane was closed and opened again
// doesn't close the new opening.
let generation = 0
// Notes being sent right now (a submit can wait for the turn): pressing s again doesn't resend.
const pending = new Set<string>()
// A held draft the prompt refused to take back just before $.state reset (/clear, /resume).
let heldOverReset = ''
// Where the selected line last was: when it leaves the list (archived, filtered, synced away) the
// line now at that index is selected instead (SPEC §4.8).
let lastCursorIndex = 0
const pocketOptions = { isOn: true, max: 5 }
// Harvest (SPEC §8): off by default; on, each finished turn is reviewed for at most `max` proposals.
const harvestOptions: { isOn: boolean; max: number; mode: HarvestMode } = { isOn: false, max: 3, mode: DEFAULT_HARVEST_MODE }
// The turn facts (SPEC §10): the conversation's generation and sequence, the latest prompt's turn
// and the running one. Decided by src/turns.ts at a hook's entry, before any wait, and kept here.
let turnState = freshTurns(Date.now())
// The hub (SPEC §9.4) and the mirror folder (SPEC §7.2), when the person configured them: set in
// register, started at session start. Each has a sync of its own (src/sync/core.ts).
const hubOptions = { url: '', token: '' }
const mirrorOptions = { dir: '' }
type Syncing = { name: 'hub' | 'mirror'; target: string; sync: Sync }
let syncs: Syncing[] = []
let isSyncRunning = false
let isPushScheduled = false
// How soon after a local change it goes out (SPEC §7.1).
const PUSH_DEBOUNCE_MS = 1000

// The load report for `ostrakon doctor` (src/report.ts): replaced at session start, and saved
// then and, after a problem, on the next poll.
let report = freshReport('', '')
let isReportDirty = false
let isReportSaving = false

const reportPath = async ($: EngineInterface) => `${((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')}/.cache/ostrakon/report.json`

// Never in the way: a report that can't be written is only a debug line, and tried again on the
// next poll. One save at a time, so an older one never lands over a newer; a call while one runs,
// or a problem noted after its snapshot, is saved on the next poll.
const saveReport = async ($: EngineInterface) => {
  if (isReportSaving) {
    isReportDirty = true
    return
  }
  isReportSaving = true
  isReportDirty = false
  let tmp = ''
  try {
    const path = await reportPath($)
    report = { ...report, writtenAt: new Date(await $.clock.now()).toISOString() }
    await $.process.run(['mkdir', '-p', path.replace(/\/[^/]+$/, '')])
    tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`
    await $.fs.write(tmp, `${JSON.stringify(report, null, 2)}\n`)
    const moved = await $.process.run(['mv', '-f', tmp, path])
    if (moved.exitCode !== 0) throw new Error(moved.stderr.trim() || `mv exited ${moved.exitCode}`)
  } catch (error) {
    isReportDirty = true
    if (tmp !== '') await $.process.run(['rm', '-f', tmp]).catch(() => undefined)
    $.ui.log(`ostrakon: report not saved: ${messageOf(error)}`, { to: 'debug' })
  } finally {
    isReportSaving = false
  }
}

// A problem worth knowing about: a debug line, as before, and a line in the load report.
const noteProblem = ($: EngineInterface, where: string, error: unknown) => {
  $.ui.log(`ostrakon: ${where}: ${messageOf(error)}`, { to: 'debug' })
  recordProblem($, where, messageOf(error))
}

// Only the report's line: for what the footer already shows, each poll.
const recordProblem = ($: EngineInterface, where: string, message: string) => {
  // The clock can refuse once the module is gone (a reload, the session's end); the line is lost then.
  void $.clock.now().then(
    now => {
      report = withProblem(report, where, message, new Date(now).toISOString())
      isReportDirty = true
    },
    () => undefined,
  )
}

// The store's view of the engine. Built per call from $ ($ may only be passed within this file).
const storeIO = async ($: EngineInterface): Promise<StoreIO> => ({
  env: { dir: await $.env.get('OSTRAKON_DIR'), home: await $.env.get('HOME') },
  read: async path => String(await $.fs.read(path)),
  write: (path, text) => $.fs.write(path, text),
  list: dir => $.fs.list(dir),
  exists: path => $.fs.exists(path),
  stat: path => $.fs.stat(path),
  move: (from, to) => $.process.run(['mv', '-f', from, to]),
  // A hard link can't replace a file. Where the file system has none (FAT, exFAT, some network
  // mounts), a move that won't replace one (mv -n), checked by the source being gone.
  place: async (from, to) => {
    if ((await $.process.run(['ln', '-T', '--', from, to])).exitCode === 0) {
      await $.process.run(['rm', '-f', '--', from])
      return true
    }
    if (await $.fs.exists(to)) return false
    await $.process.run(['mv', '-n', '-T', '--', from, to])
    return !(await $.fs.exists(from)) && (await $.fs.exists(to))
  },
  mkdir: async path => (await $.process.run(['mkdir', path])).exitCode === 0,
  rmdir: async path => (await $.process.run(['rmdir', path])).exitCode === 0,
  remove: async path => (await $.process.run(['rm', '-f', path])).exitCode === 0,
  mkdirs: async path => (await $.process.run(['mkdir', '-p', path])).exitCode === 0,
  hostname: async () => (await $.fs.read('/etc/hostname').then(String, () => '')).trim() || (await $.process.run(['uname', '-n'])).stdout,
  // process.run's parent is this Claude Code process (checked: its PPID is the claude binary).
  processId: async () => Number((await $.process.run(['sh', '-c', 'echo $PPID'])).stdout.trim()) || undefined,
  processState: async pid => {
    const listed = await $.process.run(['ps', '-o', 'lstart=', '-p', String(pid)])
    const started = listed.stdout.trim().replaceAll(/\s+/g, '-')
    if (listed.exitCode === 0 && started !== '') return { isRunning: true, started }
    // procps ps exits 1 with no output for a pid that doesn't exist; anything else is unknown.
    if (listed.exitCode === 1 && started === '' && listed.stderr.trim() === '') return { isRunning: false }
    return undefined
  },
  warn: text => noteProblem($, 'storage', text),
  now: () => $.clock.now(),
  sleep: ms => $.clock.sleep(ms),
  shown: async () => ({ notes: await read($, notes), problems: await read($, problems) }),
  publish: async (merged, broken) => {
    await update($, notes, () => merged)
    await update($, problems, () => broken)
    schedulePush($)
  },
})

// ---- sync ----

// A local change goes out a second after it lands; changes within that second go together.
const schedulePush = ($: EngineInterface) => {
  if (syncs.length === 0 || isPushScheduled) return
  isPushScheduled = true
  $.clock.after(PUSH_DEBOUNCE_MS, () => {
    isPushScheduled = false
    for (const syncing of syncs) {
      syncing.sync.push(syncIO($, syncing)).catch(error => noteProblem($, 'sync', error))
    }
  })
}

// A short name for a hub or mirror (kept as it was in P4, so the hub's cache file keeps its name).
const tagOf = (text: string) => {
  let tag = 0
  for (const char of text) tag = (Math.imul(tag, 31) + char.charCodeAt(0)) >>> 0
  return tag.toString(36)
}

// Machine-local, per hub or mirror folder: which revisions it holds (src/sync/core.ts).
const syncCachePath = async ($: EngineInterface, syncing: Syncing) =>
  `${((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')}/.cache/ostrakon/sync-${syncing.name}-${tagOf(syncing.target)}.json`

// Each sync's status for the footer (named outright: the engine lists what a module reads and writes).
const setSyncState = ($: EngineInterface, syncing: Syncing, fn: (state: SyncState) => SyncState) =>
  syncing.name === 'hub' ? update($, syncState, fn) : update($, mirrorState, fn)

const syncIO = ($: EngineInterface, syncing: Syncing): SyncIO => ({
  local: () => read($, notes),
  absorb: async incoming => store.absorb(await storeIO($), incoming),
  load: async () => {
    const path = await syncCachePath($, syncing)
    return (await $.fs.exists(path)) ? String(await $.fs.read(path)) : undefined
  },
  save: async text => {
    const path = await syncCachePath($, syncing)
    await $.process.run(['mkdir', '-p', path.replace(/\/[^/]+$/, '')])
    const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`
    await $.fs.write(tmp, text)
    await $.process.run(['mv', '-f', tmp, path])
  },
  status: async status => {
    // A refusal (a wrong token, a note the hub won't take) goes in the load report too; being
    // offline is ordinary (a laptop away from home), so it stays in the footer only.
    if (status.problem !== '' && status.problem !== 'offline') recordProblem($, syncing.name, status.problem)
    await setSyncState($, syncing, () => ({ isOn: true, ...status }))
  },
  warn: text => noteProblem($, 'sync', text),
})

// The footer's status while the hub or the mirror can't be reached; nothing while they can, or
// before first contact.
const syncStatusOf = (state: { isOn: boolean; isOnline: boolean; queued: number; problem: string }, offline: string) => {
  if (!state.isOn || state.isOnline || state.problem === '') return ''
  const what = state.problem === 'offline' ? offline : state.problem
  return state.queued > 0 ? `${what} · ${state.queued} queued` : what
}

// The mirror's stores: its folder's live notes and its Archive folder's archived ones (files in
// the folders themselves, locks apart from the notes folder's), and what each last published.
type MirrorView = { notes: Record<string, Note>; problems: NoteProblem[] }
const mirror = { live: createMirrorStore(), archive: createMirrorStore() }
const mirrorViews: { live: MirrorView; archive: MirrorView } = { live: { notes: {}, problems: [] }, archive: { notes: {}, problems: [] } }

const mirrorIO = async ($: EngineInterface, which: 'live' | 'archive'): Promise<MirrorIO> => ({
  ...(await storeIO($)),
  // OSTRAKON_DIR names the notes folder, never the mirror.
  env: { home: await $.env.get('HOME') },
  warn: text => noteProblem($, 'sync', text),
  shown: async () => mirrorViews[which],
  publish: async (merged, broken) => {
    mirrorViews[which] = { notes: merged, problems: broken }
  },
  view: () => mirrorViews[which].notes,
  problems: () => mirrorViews[which].problems,
})

// This session's project: the normalized git remote when there is one, else the root's path.
const currentProject = async ($: EngineInterface): Promise<NoteProject> => {
  const repo = await $.session.repo().catch(() => null)
  if (repo?.remote) {
    const key = normalizeRemote(repo.remote)
    return { key, name: basename(key), path: repo.root }
  }
  const root = repo?.root ?? (await $.session.root())
  return { key: `path:${root}`, name: basename(root), path: root }
}

// The theme's base as the engine resolves it. A custom theme's file names one; one that can't be
// read draws as dark. `auto` follows the terminal's background, which the engine asks the terminal
// for and a mod can't: COLORFGBG, the engine's own fallback, decides it when set, else dark.
const toneOfTheme = async ($: EngineInterface, theme: string): Promise<Tone> => {
  if (theme === 'auto') {
    // As the engine reads it: the background's colour index, dark for 0–6 and 8.
    const index = Number((await $.env.get('COLORFGBG'))?.split(';').at(-1) ?? '')
    return Number.isInteger(index) && index > 6 && index !== 8 && index <= 15 ? 'light' : 'dark'
  }
  if (!theme.startsWith('custom:')) return toneOf(theme)
  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  const file = await $.fs.read(`${dir}/themes/${theme.slice('custom:'.length)}.json`).then(String, () => '')
  try {
    const { base } = JSON.parse(file) as { base?: unknown }
    return toneOf(typeof base === 'string' ? base : 'dark')
  } catch {
    return 'dark'
  }
}

const themeTone = async ($: EngineInterface) => {
  const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
  return toneOfTheme($, typeof theme === 'string' ? theme : 'dark')
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const reportStorage = ($: EngineInterface, error: unknown) => noteProblem($, 'storage', error)

const toast = ($: EngineInterface, text: string) => {
  $.ui.toast(text)
}

const setPane = ($: EngineInterface, edit: (state: PaneState) => PaneState) => update($, pane, edit)

// The pane's handlers run one at a time: each reads the view the previous one left (fast j j j, or
// v j v, would otherwise act twice on one row).
let tail: Promise<unknown> = Promise.resolve()
const serially = <T,>(work: () => Promise<T>): Promise<T> => {
  const run = tail.then(work, work)
  tail = run.catch(() => undefined)
  return run
}

// An Input empties itself on Enter and only redraws a value that differs from the last one drawn:
// toggling a trailing space (trimmed everywhere it's read) draws the same text back.
const redrawn = (text: string) => (text === text.trimEnd() ? `${text} ` : text.trimEnd())

const joined = (...parts: string[]) => parts.filter(part => part.trim() !== '').join('\n\n')

const focusKey = ($: EngineInterface, key: string) => {
  $.ui.focus({ requestId: PANE, key }).catch(() => undefined)
}

// ---- the view ----

const projectsOf = (all: Note[]) => {
  const byKey = new Map<string, NoteProject>([[project.key, project]])
  for (const note of all) if (note.project !== null && !byKey.has(note.project.key)) byKey.set(note.project.key, note.project)
  return [...byKey.values()]
}

// What Claude's tools read: every note and the projects they name, labelled as the pane labels them.
const toolView = async ($: EngineInterface) => {
  const all = Object.values(await read($, notes))
  const projects = projectsOf(all)
  const ctx: Ctx = { now: await $.clock.now(), current: project, labels: labelsOf(projects) }
  return { ctx, all, projects }
}

const focusOf = (state: PaneState, lines: Line[], problemCount: number): Focus => {
  if (!geometry.isFocused) return { kind: 'unfocused' }
  if (state.mode === 'sheet') {
    const pages = sheetPages(geometry.bodyRows, geometry.isInline, problemCount)
    // Opened on a row, the sheet leads with that row's own keys, as its footer does.
    const row = state.focus === 'line' ? lines.find(candidate => candidate.key === state.cursor) : undefined
    const lead = row ? ownKeys(keysFor({ kind: 'line', line: row, view: state.view, picks: state.picks.length })) : []
    return { kind: 'sheet', page: Math.min(Math.max(0, state.sheetPage ?? 0), pages - 1), pages, lead }
  }
  if (state.mode === 'capture' || state.mode === 'edit' || state.mode === 'bundle' || state.mode === 'move') return { kind: state.mode }
  const line = state.focus === 'line' ? lines.find(candidate => candidate.key === state.cursor) : undefined
  if (line) return { kind: 'line', line, view: state.view, picks: state.picks.length }
  if (lines.length === 0 && state.query.trim() === '') return { kind: 'empty' }
  return { kind: 'search', hasResults: lines.some(candidate => candidate.kind === 'note'), hasQuery: state.query.trim() !== '' }
}

const viewOf = async ($: EngineInterface): Promise<PaneView & { bundleRows: number }> => {
  let state = await read($, pane)
  const all = Object.values(await read($, notes))
  const broken = await read($, problems)
  const projects = projectsOf(all)
  const ctx: Ctx = { now: await $.clock.now(), current: project, labels: labelsOf(projects) }
  const lines = linesOf(ctx, state, all, broken)
  if (state.focus === 'line' && state.cursor !== null) {
    const at = lines.findIndex(line => line.key === state.cursor)
    if (at >= 0) lastCursorIndex = at
    else if (lines.length > 0) state = { ...state, cursor: lines[Math.min(lastCursorIndex, lines.length - 1)]?.key ?? null }
  }
  const focus = focusOf(state, lines, broken.length)
  const keys = keysFor(focus)
  const noteLines = lines.filter((line): line is Extract<Line, { kind: 'note' }> => line.kind === 'note')
  const cursorNote = noteLines.find(line => line.key === state.cursor)?.note
  const preview = focus.kind === 'line' || state.mode !== 'browse' ? cursorNote : noteLines[0]?.note
  const total = visibleNotes(ctx, { ...state, query: '' }, all).filter(({ note }) => note.status === 'open').length
  const byId = new Map(all.map(note => [note.id, note]))
  const shownIds = new Set(noteLines.map(line => line.key))
  const target = state.capture.target
  const captureProject = target === 'unfiled' ? null : (projects.find(candidate => candidate.key === target) ?? project)
  const partial = {
    ctx,
    pane: state,
    focus,
    isInline: geometry.isInline,
    width: geometry.width,
    bodyRows: geometry.bodyRows,
    lines,
    preview,
    keys,
    problems: broken,
    counts: { shown: noteLines.length, total },
    picksHidden: state.picks.filter(id => !shownIds.has(id)).length,
    bundle: state.picks.map(id => byId.get(id)).filter((note): note is Note => note !== undefined),
    projects,
    captureLabel: labelOf(ctx, captureProject),
    showLegend: state.picks.length === 0 && noteLines.some(line => line.note.by === 'claude'),
    syncStatus: [syncStatusOf(await read($, syncState), 'hub offline'), syncStatusOf(await read($, mirrorState), 'mirror unavailable')]
      .filter(text => text !== '')
      .join(' · '),
    tone,
  }
  const capacity = Math.max(1, geometry.bodyRows - chromeRows(partial))
  // The window follows the focused row (under the key sheet too), or the note being edited or moved.
  const isOnLine = focus.kind === 'line' || (focus.kind === 'sheet' && state.focus === 'line')
  const anchor = state.mode === 'edit' ? (state.edit?.id ?? null) : state.mode === 'move' ? state.moving : isOnLine ? state.cursor : null
  const page = pageOf(lines, state.offset, anchor, capacity)
  return { ...partial, page, bundleRows: Math.max(1, geometry.bodyRows - 11) }
}

// ---- actions ----

// The scope when the person hasn't chosen one: the list shows every project; search shows this
// project until something is typed (SPEC §4.2).
const autoScope = (state: PaneState, view: PaneState['view']): PaneState['scope'] =>
  state.scopeChosen ? state.scope : view === 'list' || state.query.trim() !== '' ? 'all' : 'project'

const changeNote = async ($: EngineInterface, id: string, edit: (note: Note) => Note | undefined) => {
  try {
    return await store.change(await storeIO($), id, edit)
  } catch (error) {
    noteProblem($, 'storage', error)
    toast($, TOAST.failed(error instanceof StorageError ? error.message : messageOf(error)))
    return undefined
  }
}

const setStatus = async ($: EngineInterface, id: string, status: NoteStatus, isUndoable = true) => {
  let before: NoteStatus | undefined
  const stamp = new Date(await $.clock.now()).toISOString()
  const changed = await changeNote($, id, note => {
    before = note.status
    return { ...note, status, sentAt: status === 'sent' ? stamp : note.sentAt }
  })
  if (changed && isUndoable && before !== undefined && before !== status) {
    const was = before
    await setPane($, state => ({ ...state, undo: [...state.undo, { kind: 'status' as const, id, before: was }].slice(-50) }))
  }
  return changed
}

// Marks notes sent once the prompt carrying them went in (SPEC §5), with this session's id.
const markSent = async ($: EngineInterface, ids: string[]) => {
  // Out of the picks first, so the poll doesn't report them dropped.
  await setPane($, state => ({ ...state, picks: state.picks.filter(id => !ids.includes(id)) }))
  const stamp = new Date(await $.clock.now()).toISOString()
  const sessionId = await $.session.id().catch(() => undefined)
  for (const id of ids) {
    await changeNote($, id, note => ({ ...note, status: 'sent', sentAt: stamp, context: { ...note.context, sentSessionId: sessionId } }))
  }
}

// One step back, for Esc: a mode to the list, a row to the search field, a query to empty, the
// list view to search. False at the top: the pane closes.
const goBack = async ($: EngineInterface) => {
  const state = await read($, pane)
  if (state.mode === 'edit') {
    // The draft is kept: editing the note again picks it back up.
    await setPane($, current => ({ ...current, mode: 'browse' }))
    if (state.edit) await focusLine($, state.edit.id)
    return true
  }
  if (state.mode === 'move' || state.mode === 'sheet' || state.mode === 'bundle') {
    await setPane($, current => ({ ...current, mode: 'browse', moving: null }))
    if (state.cursor !== null && state.focus === 'line') await focusLine($, state.cursor)
    else if (state.mode === 'bundle' && state.cursor !== null) await focusLine($, state.cursor)
    else focusKey($, SEARCH_KEY)
    return true
  }
  if (state.mode === 'capture') {
    await setPane($, current => ({ ...current, mode: 'browse', focus: 'search', capture: { ...current.capture, error: null } }))
    focusKey($, SEARCH_KEY)
    return true
  }
  if (state.focus === 'line' || state.focus === 'control') {
    await setPane($, current => ({ ...current, focus: 'search' }))
    focusKey($, SEARCH_KEY)
    return true
  }
  if (state.query.trim() !== '') {
    await setPane($, current => ({ ...current, query: redrawn(''), offset: 0, cursor: null, scope: current.scopeChosen ? current.scope : 'project' }))
    focusKey($, SEARCH_KEY)
    return true
  }
  if (state.view === 'list') {
    await setPane($, current => ({ ...current, view: 'search', offset: 0, scope: autoScope(current, 'search') }))
    focusKey($, SEARCH_KEY)
    return true
  }
  return false
}

// Puts the pane's keyboard back where its state says: the selected row, or the search field.
const refocus = async ($: EngineInterface) => {
  if (!(await read($, isOpen))) return
  // Focusing an element only moves the pane's ring; opening it again with focus takes the keys.
  await $.ui.open({ id: PANE, title: 'ostrakon', focus: true, closeOnEscape: true }).catch(() => undefined)
  const state = await read($, pane)
  if (state.focus === 'line' && state.cursor !== null) return focusLine($, state.cursor)
  focusKey($, SEARCH_KEY)
}

// Spends the pane's last fill if it's still `text`: one submit or entry marks it, never two.
const spendFill = async ($: EngineInterface, text: string) => {
  let isSpent = false
  await setPane($, current => {
    if (current.lastFill?.text !== text) return current
    isSpent = true
    return { ...current, lastFill: null }
  })
  return isSpent
}

// Focus a line by key once the next drawing has it: its slot in the window.
const focusLine = async ($: EngineInterface, key: string | null) => {
  if (key === null) {
    await setPane($, state => ({ ...state, focus: 'search' }))
    return focusKey($, SEARCH_KEY)
  }
  await setPane($, state => ({ ...state, cursor: key, focus: 'line', mode: state.mode === 'sheet' ? 'browse' : state.mode }))
  const view = await viewOf($)
  await setPane($, state => ({ ...state, offset: view.page.offset }))
  const slot = view.page.lines.findIndex(line => line.key === key)
  if (slot < 0) {
    await setPane($, state => ({ ...state, focus: 'search' }))
    return focusKey($, SEARCH_KEY)
  }
  lastElement = slotKey(slot)
  focusKey($, lastElement)
}

// After the lines shift under a focused row (a poll, an undo), puts the ring back on the selected
// line's slot so Enter and the letter keys act on the same row.
const realign = async ($: EngineInterface) => {
  if (!(await read($, isOpen))) return
  const view = await viewOf($)
  if (view.focus.kind !== 'line' || view.pane.cursor === null) return
  // The selected note left the list: keep the line that took its place (viewOf picked it).
  const stored = (await read($, pane)).cursor
  if (stored !== view.pane.cursor) {
    const cursor = view.pane.cursor
    await setPane($, state => ({ ...state, cursor }))
  }
  const slot = view.page.lines.findIndex(line => line.key === view.pane.cursor)
  if (slot >= 0 && slotKey(slot) !== lastElement && lastElement?.startsWith('slot-')) {
    lastElement = slotKey(slot)
    focusKey($, lastElement)
  }
}

// Puts the held draft back and resets what lasts only while the pane is open. Runs from the mod's
// own close and from the ui.close hook (Esc, the close mark); the second run finds nothing held.
let closing: Promise<void> | undefined
const afterClose = ($: EngineInterface) => {
  // One cleanup at a time: the mod's own close and the ui.close hook can both run it.
  closing ??= cleanUp($).finally(() => {
    closing = undefined
  })
  return closing
}

const cleanUp = async ($: EngineInterface) => {
  generation += 1
  const held = (await read($, pane)).stash
  // The draft stays held if the prompt won't take it back; the next open merges it.
  let restored = false
  if (held !== '') {
    const box = await $.prompt.read().catch(() => ({ text: '' }))
    const filled = await $.prompt.fill({ text: joined(box.text, held), mode: 'replace' }).catch(() => ({ isFilled: false }))
    restored = filled.isFilled
  }
  await setPane($, current => ({
    ...current,
    // Only what was put back leaves the stash; anything held since stays.
    stash: restored && current.stash === held ? '' : current.stash,
    moving: null,
    mode: 'browse',
    query: '',
    scope: 'project',
    scopeChosen: false,
    focus: 'search',
    offset: 0,
  }))
  await update($, isOpen, () => false)
}

const closePane = async ($: EngineInterface) => {
  await afterClose($)
  await $.ui.close({ id: PANE }).catch(() => undefined)
}

// Opens the pane with the keyboard, holding the prompt's draft until it closes (SPEC §4.4).
const openPane = async ($: EngineInterface, mode: 'browse' | 'capture') => {
  const before = await read($, pane)
  const wasOpen = await read($, isOpen)
  // Already open (the person clicked into the prompt and ran /jot): the held draft stays held;
  // only a closed pane takes what's in the prompt now.
  let taken = ''
  if (!wasOpen) {
    const box = await $.prompt.read().catch(() => ({ text: '' }))
    if (box.text !== '') {
      const emptied = await $.prompt.fill({ text: '', mode: 'replace' }).catch(() => ({ isFilled: false }))
      if (emptied.isFilled) taken = box.text
    }
  }
  const all = await read($, notes)
  const resumesEdit = mode === 'browse' && before.edit !== null && all[before.edit.id] !== undefined
  // A note of another project needs scope all to be on the list again.
  const editsOther = resumesEdit && before.edit !== null && all[before.edit.id]?.project?.key !== project.key
  const orphan = heldOverReset
  heldOverReset = ''
  // The person's saved preference (ctrl+s to all): a closed pane opens on it.
  const isAllSaved = !wasOpen && (await $.store.get(SCOPE_KEY).catch(() => undefined)) === 'all'
  await setPane($, state => ({
    ...state,
    scope: editsOther || isAllSaved ? 'all' : state.scope,
    scopeChosen: state.scopeChosen || isAllSaved,
    mode: resumesEdit ? 'edit' : mode,
    view: resumesEdit ? state.view : 'search',
    focus: mode === 'capture' || resumesEdit ? 'control' : 'search',
    cursor: resumesEdit ? (state.edit?.id ?? state.cursor) : state.cursor,
    stash: joined(orphan, state.stash, taken),
    capture: { ...state.capture, target: state.capture.target ?? project.key, error: null, saved: mode === 'capture' ? [] : state.capture.saved },
  }))
  let why: string | undefined
  try {
    const opened = await $.ui.open({ id: PANE, title: 'ostrakon', focus: true, closeOnEscape: true })
    if (!opened.isPlaced) why = opened.reason ?? 'not placed'
  } catch (error) {
    why = messageOf(error)
  }
  // The pane not opening is the kind of break a new Claude Code brings (SPEC §12, the load report).
  if (why !== undefined) noteProblem($, 'pane not opened', why)
  await update($, isOpen, () => why === undefined)
  if (why !== undefined) {
    await afterClose($)
    return why
  }
  if (resumesEdit) focusKey($, EDIT_KEY)
  return undefined
}

// The person's note; its chip draws fresh for MS.fresh, until a later save takes over.
const createNote = async ($: EngineInterface, text: string, target: NoteProject | null) => {
  const created = await store.create(await storeIO($), { text, by: 'you', project: target, context: {} })
  await update($, fresh, () => created.id)
  $.clock.after(MS.fresh, () => {
    update($, fresh, current => (current === created.id ? '' : current)).catch(error => reportStorage($, error))
  })
  return created
}

// Written only when it changes: prompt.edit runs on every key.
const markJotDraft = async ($: EngineInterface, isJot: boolean) => {
  if ((await read($, isJotDraft)) !== isJot) await update($, isJotDraft, () => isJot)
}

// A save from the prompt says so on the hint line for MS.saved, in place of a toast. A later save
// keeps its own time: the earlier one's timer leaves it up.
const showSaved = async ($: EngineInterface) => {
  const at = await $.clock.now()
  await update($, savedAt, () => at)
  $.clock.after(MS.saved, () => {
    update($, savedAt, current => (current === at ? 0 : current)).catch(error => reportStorage($, error))
  })
}

// Fills the prompt with the held draft, anything typed there since, and the note; closes the pane
// if it's open. `typed` is what the prompt held that isn't the person's draft (the band's digit).
const fillPrompt = async ($: EngineInterface, text: string, ids: string[], typed?: string) => {
  const state = await read($, pane)
  const box = await $.prompt.read().catch(() => ({ text: '' }))
  const draft = typed !== undefined && box.text.trim() === typed ? '' : box.text
  const filled = await $.prompt.fill({ text: joined(state.stash, draft, text), mode: 'replace' }).catch(() => ({ isFilled: false }))
  if (!filled.isFilled) {
    toast($, TOAST.notFilled)
    return false
  }
  await setPane($, current => ({ ...current, stash: '', lastFill: { text, ids } }))
  if (await read($, isOpen)) await closePane($)
  return true
}

const act = async ($: EngineInterface, action: Action) => {
  const view = await viewOf($)
  const state = view.pane
  const line = view.lines.find(candidate => candidate.key === state.cursor)
  const note = line?.kind === 'note' ? line.note : undefined
  const at = line ? view.lines.indexOf(line) : -1
  switch (action) {
    case 'down':
    case 'up': {
      const step = action === 'down' ? 1 : -1
      // The key sheet pages round instead.
      if (view.focus.kind === 'sheet') {
        const { page, pages } = view.focus
        await setPane($, current => ({ ...current, sheetPage: (page + step + pages) % pages }))
        return
      }
      const next = view.lines[Math.max(0, Math.min(view.lines.length - 1, (at < 0 ? -1 : at) + step))]
      if (next) await focusLine($, next.key)
      return
    }
    case 'pick': {
      if (!note) return
      if (note.status !== 'open' && note.status !== 'proposed') return toast($, TOAST.onlyOpen)
      await setPane($, current => ({
        ...current,
        picks: current.picks.includes(note.id) ? current.picks.filter(id => id !== note.id) : [...current.picks, note.id],
      }))
      return
    }
    case 'clearPicks':
      await setPane($, current => ({ ...current, picks: [], undo: [...current.undo, { kind: 'picks', before: current.picks }] }))
      return
    case 'toPrompt': {
      if (state.mode === 'bundle')
        return fillPrompt(
          $,
          bundleText(view.ctx, view.bundle),
          view.bundle.map(item => item.id),
        )
      if (note) return fillPrompt($, dispatchText(view.ctx, note), [note.id])
      return
    }
    case 'send': {
      const sending = state.mode === 'bundle' ? view.bundle : note ? [note] : []
      if (sending.length === 0) return
      const text = state.mode === 'bundle' ? bundleText(view.ctx, sending) : dispatchText(view.ctx, sending[0] as Note)
      const ids = sending.map(item => item.id)
      // @file mentions aren't expanded for a plugin's prompt: those go through the person's Enter.
      if (/(^|\s)@\S/.test(text)) {
        toast($, TOAST.mentions)
        return fillPrompt($, text, ids)
      }
      // Not awaited: mid-turn the submit waits for the turn. The pane closes only once the prompt is
      // in, and only if it's still the same opening; a drop or failure leaves the pane, the picks
      // and the held draft as they were. A note already on its way isn't sent twice.
      if (ids.some(id => pending.has(id))) return
      for (const id of ids) pending.add(id)
      const opening = generation
      $.prompt
        .submit({ text, asUser: true })
        .then(
          async result => {
            if ('drop' in result && result.drop) return toast($, TOAST.notSent(result.drop))
            if ((result.text ?? text).includes(text)) await markSent($, ids)
            if (generation === opening) await closePane($)
          },
          error => toast($, TOAST.notSent(messageOf(error))),
        )
        .catch(error => reportStorage($, error))
        .finally(() => {
          for (const id of ids) pending.delete(id)
        })
      return
    }
    case 'bundle':
      if (state.picks.length === 0) return toast($, TOAST.pickFirst)
      await setPane($, current => ({ ...current, mode: 'bundle' }))
      focusKey($, SEND_KEY)
      return
    case 'edit': {
      if (!note) return
      if (!canEditInline(note.text)) {
        await $.ui.copy({ text: `${store.root(await storeIO($))}/notes/${note.id}.md` }).catch(() => undefined)
        return toast($, TOAST.hasNewline)
      }
      // Editing the same note again picks its kept draft back up.
      await setPane($, current => ({
        ...current,
        mode: 'edit',
        edit: current.edit?.id === note.id ? current.edit : { id: note.id, draft: toField(note.text) },
      }))
      focusKey($, EDIT_KEY)
      return
    }
    case 'archive':
      if (!note) return
      if (await setStatus($, note.id, 'archived')) toast($, TOAST.archived)
      return
    case 'restore':
      if (note && (note.status === 'sent' || note.status === 'archived')) {
        if (await setStatus($, note.id, 'open')) toast($, TOAST.restored)
      }
      return
    case 'undo': {
      if (note && (note.status === 'sent' || note.status === 'archived')) return act($, 'restore')
      const last = state.undo[state.undo.length - 1]
      if (!last) return toast($, TOAST.nothingToUndo)
      // The entry goes only once its reversal is written; a failed one stays for another try.
      let isDone = true
      if (last.kind === 'picks') await setPane($, current => ({ ...current, picks: last.before }))
      else if (last.kind === 'status') isDone = (await changeNote($, last.id, item => ({ ...item, status: last.before }))) !== undefined
      else if (last.kind === 'text') isDone = (await changeNote($, last.id, item => ({ ...item, text: last.before }))) !== undefined
      else isDone = (await changeNote($, last.id, item => ({ ...item, project: last.before }))) !== undefined
      if (!isDone) return
      await setPane($, current => ({ ...current, undo: current.undo.slice(0, -1) }))
      toast($, TOAST.undone)
      await realign($)
      return
    }
    case 'move':
      if (!note) return
      await setPane($, current => ({ ...current, mode: 'move', moving: note.id }))
      focusKey($, MOVE_KEY)
      return
    case 'copy':
      if (!note) return
      await $.ui.copy({ text: note.text }).catch(() => undefined)
      toast($, TOAST.copied)
      return
    case 'list':
      await setPane($, current => {
        const view = current.view === 'list' ? 'search' : 'list'
        return { ...current, view, mode: 'browse', offset: 0, scope: autoScope(current, view) }
      })
      {
        // Into the list (or back), focus goes to the selected row, or the first one.
        const after = await viewOf($)
        const keep = state.focus === 'line' && after.lines.some(item => item.key === state.cursor) ? state.cursor : null
        const first = after.lines.find(item => item.kind === 'note')?.key ?? after.lines[0]?.key ?? null
        await focusLine($, keep ?? first)
      }
      return
    case 'history':
      await setPane($, current => ({ ...current, history: !current.history, view: 'list', scope: autoScope(current, 'list') }))
      return
    case 'fold': {
      const group = line?.kind === 'group' ? line.group : line?.kind === 'note' ? line.group : undefined
      if (group === undefined) return
      await setPane($, current => ({
        ...current,
        folded: current.folded.includes(group) ? current.folded.filter(key => key !== group) : [...current.folded, group],
      }))
      await focusLine($, `group:${group}`)
      return
    }
    case 'search':
      await setPane($, current => ({ ...current, mode: 'browse', focus: 'search' }))
      focusKey($, SEARCH_KEY)
      return
    case 'new':
      await setPane($, current => ({
        ...current,
        mode: 'capture',
        focus: 'control',
        capture: { ...current.capture, target: current.capture.target ?? project.key, error: null },
      }))
      focusKey($, CAPTURE_KEY)
      return
    case 'scope':
      if (state.mode === 'capture') {
        // This project, then unfiled, then the others by recent activity.
        const order = [project.key, 'unfiled', ...view.projects.filter(item => item.key !== project.key).map(item => item.key)]
        const nextTarget = order[(order.indexOf(state.capture.target ?? project.key) + 1) % order.length] ?? project.key
        await setPane($, current => ({ ...current, capture: { ...current.capture, target: nextTarget } }))
        return
      }
      await setPane($, current => ({ ...current, scope: current.scope === 'project' ? 'all' : 'project', scopeChosen: true, offset: 0 }))
      // Remembered across opens and sessions: all sticks; back to this project restores the
      // defaults (search starts here, the list and typing look everywhere).
      if ((await read($, pane)).scope === 'all') await $.store.set(SCOPE_KEY, 'all').catch(error => reportStorage($, error))
      else await $.store.delete(SCOPE_KEY).catch(error => reportStorage($, error))
      return
    case 'keys':
    case 'details':
      await setPane($, current => ({ ...current, mode: current.mode === 'sheet' ? 'browse' : 'sheet', sheetPage: 0 }))
      return
    case 'close':
    case 'toggle':
      await closePane($)
      return
    case 'keep':
      if (note) await setStatus($, note.id, 'open')
      return
    case 'dismiss':
      if (note) await setStatus($, note.id, 'dismissed')
      return
    case 'back':
      await setPane($, current => ({ ...current, mode: 'browse', edit: null }))
      if (state.cursor !== null) await focusLine($, state.cursor)
      else focusKey($, SEARCH_KEY)
      return
  }
}

// ---- input handlers ----

const searchInput = async ($: EngineInterface, value: string) => {
  await setPane($, state => ({
    ...state,
    query: value,
    scope: autoScope({ ...state, query: value }, state.view),
    offset: 0,
    cursor: null,
    focus: 'search',
  }))
}

const searchSubmit = async ($: EngineInterface, value: string) => {
  const view = await viewOf($)
  const first = view.lines.find(line => line.kind === 'note')
  if (first) {
    // The field empties itself on Enter and only takes a value that differs from the last one
    // drawn; a trailing space (search trims it) draws the query back.
    await setPane($, state => ({ ...state, query: state.query === state.query.trimEnd() ? `${state.query} ` : state.query.trimEnd() }))
    return focusLine($, first.key)
  }
  // A search that found nothing becomes a note: its words, not its tokens (@infra, is:sent).
  const text = parseQuery(value).words.trim()
  if (text === '') {
    await setPane($, state => ({ ...state, query: redrawn(value) }))
    return
  }
  try {
    await createNote($, text, project)
    await showSaved($)
    // Something typed while it saved is a new search: leave it.
    await setPane($, state => (state.query === value ? { ...state, query: '', scope: state.scopeChosen ? state.scope : 'project' } : state))
  } catch (error) {
    noteProblem($, 'storage', error)
    toast($, TOAST.failed(messageOf(error)))
    await setPane($, state => ({ ...state, query: redrawn(value) }))
  }
}

const captureSubmit = async ($: EngineInterface, value: string) => {
  const text = value.trim()
  if (text === '') {
    await setPane($, state => ({ ...state, mode: 'browse', focus: 'search', capture: { ...state.capture, draft: '', error: null } }))
    return focusKey($, SEARCH_KEY)
  }
  const view = await viewOf($)
  const target = view.pane.capture.target
  const into = target === 'unfiled' ? null : (view.projects.find(item => item.key === target) ?? project)
  try {
    await createNote($, text, into)
    // Text typed while the save ran is the next note: leave it.
    await setPane($, state => ({
      ...state,
      capture: {
        ...state.capture,
        draft: state.capture.draft === value ? '' : state.capture.draft,
        error: null,
        saved: [...state.capture.saved, text].slice(-10),
      },
    }))
  } catch (error) {
    noteProblem($, 'storage', error)
    await setPane($, state => ({
      ...state,
      capture: { ...state.capture, draft: state.capture.draft === value ? redrawn(value) : state.capture.draft, error: TOAST.failed(messageOf(error)) },
    }))
  }
}

const editSubmit = async ($: EngineInterface, value: string) => {
  const state = await read($, pane)
  if (!state.edit) return
  const id = state.edit.id
  const text = fromField(value).trim()
  let before: string | undefined
  if (text !== '') {
    const changed = await changeNote($, id, note => {
      before = note.text
      return note.text === text ? undefined : { ...note, text }
    })
    if (!changed) {
      // Kept in the field (the Input emptied itself on Enter) for another try.
      await setPane($, current => ({ ...current, edit: current.edit ? { ...current.edit, draft: redrawn(value) } : null }))
      return
    }
    const was = before
    if (was !== undefined && was !== text)
      await setPane($, current => ({ ...current, undo: [...current.undo, { kind: 'text' as const, id, before: was }].slice(-50) }))
  }
  await setPane($, current => ({ ...current, mode: 'browse', edit: null }))
  await focusLine($, id)
}

const moveTo = async ($: EngineInterface, value: string) => {
  const view = await viewOf($)
  // The note fixed when the Select opened: if it left the list meanwhile, nothing moves.
  const note = view.lines.find(line => line.key === view.pane.moving)
  if (note?.kind !== 'note') {
    await setPane($, state => ({ ...state, mode: 'browse', moving: null }))
    return
  }
  const into = value === 'unfiled' ? null : (view.projects.find(item => item.key === value) ?? null)
  const before = note.note.project
  const changed = await changeNote($, note.note.id, item => ({ ...item, project: into }))
  await setPane($, state => ({
    ...state,
    mode: 'browse',
    moving: null,
    undo: changed ? [...state.undo, { kind: 'project' as const, id: note.note.id, before }].slice(-50) : state.undo,
  }))
  if (changed) toast($, TOAST.moved(labelOf(view.ctx, into)))
  await focusLine($, note.note.id)
}

const pressSlot = async ($: EngineInterface, slot: number) => {
  const view = await viewOf($)
  const line = view.page.lines[slot]
  if (!line) return
  await setPane($, state => ({ ...state, cursor: line.key, focus: 'line' }))
  await act($, line.kind === 'note' ? 'toPrompt' : line.kind === 'group' ? 'fold' : 'details')
}

const digit = async ($: EngineInterface, n: number) => {
  const view = await viewOf($)
  for (const [key, number] of view.page.numbers) if (number === n) return focusLine($, key)
}

// ---- the band ----

// A Pocket chip: the note goes into the prompt (SPEC §10); a chip never opens the pane.
const pocketChip = async ($: EngineInterface, n: number, id: string) => {
  const note = (await read($, notes))[id]
  if (note?.status !== 'open') return
  const ctx: Ctx = { now: await $.clock.now(), current: project, labels: labelsOf(projectsOf(Object.values(await read($, notes)))) }
  if (await fillPrompt($, dispatchText(ctx, note), [note.id], String(n))) toast($, TOAST.inPrompt(n))
}

// The proposals of the last turn still waiting, in the order they were made: none once another
// prompt started a turn, while a turn runs, or after /clear (SPEC §10). Decided here, at draw time,
// so a review that lands late needs no check of its own.
const proposalsOf = async ($: EngineInterface) => {
  const shown = await read($, harvest)
  if (!isHarvestShown(shown, await read($, turns))) return []
  return waitingProposals(shown, await read($, notes))
}

// Keeps proposals: only one still proposed under the lock becomes open (another session may have
// dismissed it since the last poll).
const keep = async ($: EngineInterface, ids: string[]) => {
  let kept = 0
  for (const id of ids) {
    // A change that applies nothing resolves to the note as it was: count only real keeps.
    let isKept = false
    const changed = await changeNote($, id, note => {
      isKept = note.status === 'proposed'
      return isKept ? { ...note, status: 'open' } : undefined
    })
    if (changed && isKept) kept += 1
  }
  if (kept > 0) toast($, TOAST.kept(kept))
}

// This turn's proposals: Claude's, in this project, carrying the turn's id (a note without one, a
// subagent's jot, belongs to no turn). Kept as its prompt's harvest; the band decides when drawn
// whether that's still the latest turn. A turn that proposed nothing leaves the last harvest as
// it was; a continuation's proposals join its prompt's; and a harvest never replaces one of a
// prompt that started later.
const collectHarvest = async ($: EngineInterface, turn: RunningTurn) => {
  await storeIO($)
    .then(store.scan)
    .catch(error => reportStorage($, error))
  const made = turnProposals(Object.values(await read($, notes)), project.key, turn.turnId).map(note => note.id)
  if (made.length === 0) return
  const all = await read($, notes)
  const created = (id: string) => all[id]?.created ?? ''
  let started = ''
  await update($, harvest, current => {
    const merged = mergeHarvest(current, turn.prompt, made, created)
    started = merged !== null && merged.turnId !== current?.turnId ? merged.turnId : ''
    return merged
  })
  if (started !== '') await countHarvest($, started)
}

// A new turn's harvest, counted once: the first few carry the hint line (SPEC §10).
const countHarvest = async ($: EngineInterface, turnId: string) => {
  const stored = await $.store.get(HARVEST_HINTS_KEY).catch(() => undefined)
  const shown = typeof stored === 'number' && Number.isFinite(stored) ? stored : 0
  if (shown >= TEXT.harvestHintTimes) return
  await update($, harvestHint, () => turnId)
  await $.store.set(HARVEST_HINTS_KEY, shown + 1).catch(error => reportStorage($, error))
}

// Harvest's review of a finished turn (SPEC §8): one fork over the session's transcript (or, in
// light mode, one small-model completion over the turn's prompt, answer and notes) for side
// issues worth keeping, proposed as this turn's. Runs after the turn; the band picks them up.
const reviewTurn = async ($: EngineInterface, turn: RunningTurn, answer: string) => {
  if (!isProjectKnown) return
  // Read before the question: a /clear while it's out moves the session on.
  const sessionId = await $.session.id().catch(() => undefined)
  const all = Object.values(await read($, notes))
  // What Claude jotted this turn is saved already: the review leaves it out.
  const jotted = all.filter(note => note.by === 'claude' && note.context.turnId === turn.turnId).map(note => note.text)
  const room = harvestOptions.max
  // The mode is read once: a review runs in the one it started in. The start time is taken here,
  // before the check, so no wait sits between the check and the model call.
  const { mode } = harvestOptions
  const started = await $.clock.now()
  // The fork reads the main thread's last request: once a newer prompt started, or the
  // conversation ended (/clear, /resume leave no latest prompt), that's no longer this turn's, so
  // this turn goes unreviewed.
  if (!canReview(turnState, turn)) {
    $.ui.log(`ostrakon: harvest review skipped: a newer turn or conversation started`, { to: 'debug' })
    return
  }
  const reply =
    mode === 'light'
      ? await $.model.complete(lightRequest(turn.prompt.text, answer, jotted, room))
      : await $.model.fork({ prompt: reviewPrompt(answer, jotted, room) })
  const usage = 'usage' in reply ? reply.usage : { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  $.ui.log(
    `ostrakon: harvest review (${mode}) ${reply.isAnswered ? 'answered' : reply.reason} in ${(await $.clock.now()) - started} ms: input=${usage.input_tokens} output=${usage.output_tokens} cacheRead=${usage.cache_read_input_tokens} cacheCreate=${usage.cache_creation_input_tokens}`,
    { to: 'debug' },
  )
  if (!reply.isAnswered) {
    $.ui.log(`ostrakon: harvest review skipped: ${reply.reason}`, { to: 'debug' })
    return
  }
  // A reply that repeats a jot it was told about, a note already waiting in this project or itself
  // doesn't propose it again.
  const same = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
  const saved = new Set(jotted.map(same))
  const waiting = Object.values(await read($, notes))
  const found = parseReview(reply.text)
    .filter(text => !saved.has(same(text)) && duplicateOf(waiting, text, project) === undefined)
    .filter((text, at, all) => all.findIndex(other => same(other) === same(text)) === at)
    .slice(0, room)
  if (found.length === 0) return
  const io = await storeIO($)
  for (const text of found) {
    await store.create(io, {
      text,
      by: 'claude',
      status: 'proposed',
      project,
      context: { ...(sessionId !== undefined ? { sessionId } : {}), turnId: turn.turnId },
    })
  }
  // Shown only while this turn is still the latest; otherwise they wait in the pane.
  await collectHarvest($, turn)
}

// Drops picks that stopped being open (archived, sent or changed in another session).
const prunePicks = async ($: EngineInterface) => {
  if ((await read($, pane)).picks.length === 0) return
  const all = await read($, notes)
  const isLive = (id: string) => all[id]?.status === 'open' || all[id]?.status === 'proposed'
  let dropped = 0
  await setPane($, current => {
    const kept = current.picks.filter(isLive)
    dropped = current.picks.length - kept.length
    return dropped === 0 ? current : { ...current, picks: kept }
  })
  if (dropped > 0) toast($, TOAST.pickDropped(dropped))
}

// A path with ~ expanded, symlinks and `.`/`..` resolved (realpath -m: parts that don't exist yet
// are fine); as written, less a trailing slash, where realpath can't say.
const resolved = async ($: EngineInterface, path: string) => {
  const home = ((await $.env.get('HOME')) ?? '').replace(/\/+$/, '')
  const expanded = path.replace(/^~(?=\/|$)/, home).replace(/(?<=.)\/+$/, '')
  const real = await $.process.run(['realpath', '-m', '--', expanded]).catch(() => undefined)
  return real?.exitCode === 0 && real.stdout.trim().startsWith('/') ? real.stdout.trim() : expanded
}

// Starts the hub's and the mirror's pull loops once per loaded module (a reload starts fresh ones;
// the old loops' timers stop with the old module).
const startSync = async ($: EngineInterface) => {
  if (isSyncRunning) return
  isSyncRunning = true
  syncs = []
  if (hubOptions.url !== '') {
    const adapter = hubAdapter((url, init) => $.http.fetch(url, init), hubOptions.url, hubOptions.token)
    syncs.push({ name: 'hub', target: hubOptions.url, sync: createSync(adapter) })
  }
  if (mirrorOptions.dir !== '') {
    // One name per folder however it's spelled (symlinks, `..`): its locks and memory go by it.
    const dir = await resolved($, mirrorOptions.dir)
    mirror.live = createMirrorStore(dir)
    mirror.archive = createMirrorStore(`${dir}/${ARCHIVE_FOLDER}`)
    const adapter = folderAdapter(
      mirror.live,
      mirror.archive,
      () => mirrorIO($, 'live'),
      () => mirrorIO($, 'archive'),
      async () => resolved($, `${store.root(await storeIO($))}/notes`),
      async id => (await read($, notes))[id],
    )
    syncs.push({ name: 'mirror', target: mirrorOptions.dir, sync: createSync(adapter) })
  }
  for (const syncing of syncs) {
    void setSyncState($, syncing, state => ({ ...state, isOn: true }))
    syncing.sync.run(
      syncIO($, syncing),
      (ms, fn) => void $.clock.after(ms, fn),
      () => true,
    )
  }
}

// Replaced in register once the person's notesDir option is known.
let store = createStore()

export const register: Register = (on, options) => {
  const notesDir = typeof options.notesDir === 'string' && options.notesDir !== '' ? options.notesDir : undefined
  store = createStore(notesDir)
  pocketOptions.isOn = options.pocket !== false
  hubOptions.url = typeof options.hubUrl === 'string' ? options.hubUrl.trim() : ''
  hubOptions.token = typeof options.hubToken === 'string' ? options.hubToken.trim() : ''
  mirrorOptions.dir = typeof options.mirrorDir === 'string' ? options.mirrorDir.trim() : ''
  harvestOptions.isOn = options.harvest === true
  harvestOptions.mode = harvestModeOf(options.harvestMode)
  harvestOptions.max =
    typeof options.harvestMaxPerTurn === 'number' && Number.isFinite(options.harvestMaxPerTurn)
      ? Math.max(1, Math.min(9, Math.floor(options.harvestMaxPerTurn)))
      : 3
  pocketOptions.max = typeof options.pocketMax === 'number' && Number.isFinite(options.pocketMax) ? Math.max(1, Math.min(9, Math.floor(options.pocketMax))) : 5

  on('session.start', async ($, e, next) => {
    // Decided now, before any wait: a session starting (or the module reloading) begins a newer
    // generation; with no running turn known (a reload mid-turn loses it), the band's facts keep none.
    const started = sessionStarted(turnState)
    turnState = started.state
    // A new report per load: which Claude Code this is, and (from here on) what goes wrong.
    const claude = await $.session.version().then(
      v => v.version,
      () => 'unknown',
    )
    report = freshReport(new Date(await $.clock.now()).toISOString(), claude)
    await $.command.register({ name: 'jot', description: 'Save a note to ostrakon (alone: open the pane)', immediate: true, argumentHint: '<note>' })
    // The same whether harvest is on or off: the person can always ask Claude to jot something.
    for (const [name, description, inputSchema] of [
      [JOT_TOOL, JOT_DESCRIPTION, JOT_SCHEMA],
      [NOTES_TOOL, NOTES_DESCRIPTION, NOTES_SCHEMA],
      [ARCHIVE_TOOL, ARCHIVE_DESCRIPTION, ARCHIVE_SCHEMA],
    ] as const) {
      await $.tool.register({ name, description, inputSchema, isDeferred: false }).catch(error => noteProblem($, `${name} tool not registered`, error))
    }
    if (started.facts) await update($, turns, started.facts)
    // A reload keeps the atoms but not the module: later decisions order above what they hold, and
    // the latest prompt comes back, so a continuation after the reload still joins its harvest.
    const stored = await read($, turns)
    const shown = await read($, harvest)
    turnState = sessionRestored(turnState, stored, shown)
    // The fresh chip and the saved hint end on timers, which stopped with the old module: they end now.
    await update($, fresh, () => '')
    await update($, savedAt, () => 0)
    project = await currentProject($)
      .then(found => {
        isProjectKnown = true
        return found
      })
      .catch(() => project)
    tone = await themeTone($).catch(() => 'dark')
    await store.loadAll(await storeIO($)).catch(error => reportStorage($, error))
    // Timers stop when the module reloads; a reload runs session.start again and re-arms this.
    $.clock.every(POLL_MS, () => {
      if (isReportDirty) void saveReport($)
      storeIO($)
        .then(store.scan)
        .then(() => prunePicks($))
        .then(() => realign($))
        .catch(error => reportStorage($, error))
    })
    void startSync($).catch(error => noteProblem($, 'sync', error))
    // Not awaited: a slow disk never holds the session up for a diagnostic (saveReport catches).
    void saveReport($)
    return next(e)
  })

  // $.state resets on /clear, /resume and /branch, and session.start doesn't fire again. The
  // classic SessionStart hook can't be relied on (an organization's policy plugin may bypass user
  // plugins' classic hooks), so reload once the old session has ended. The poll's own check for a
  // lost view covers /branch and anything else within one period.
  on('session.end', { reason: ['clear', 'resume'] }, async ($, e, next) => {
    // Decided now, before any wait: the next conversation is a newer generation with no latest
    // prompt, so a review still running for this one is never drawn there.
    const ending = sessionEnded(turnState)
    turnState = ending.state
    // $.state is about to reset: a draft the open pane holds goes back into the prompt first.
    const held = (await read($, pane)).stash
    if (held !== '') {
      const box = await $.prompt.read().catch(() => ({ text: '' }))
      const filled = await $.prompt.fill({ text: joined(box.text, held), mode: 'replace' }).catch(() => ({ isFilled: false }))
      // Not taken back: kept outside $.state, and merged into the stash at the next open.
      if (!filled.isFilled) heldOverReset = joined(heldOverReset, held)
    }
    const ended = await next(e)
    await update($, turns, ending.facts)
    $.clock.after(100, () => {
      storeIO($)
        .then(store.loadAll)
        .catch(error => reportStorage($, error))
    })
    return ended
  })

  // The theme changed: project colours follow it.
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    if (set.deny !== undefined) return set
    tone = await toneOfTheme($, String(set.value)).catch(() => 'dark')
    $.ui.invalidate('ui.render')
    return set
  })

  // Claude's jot (SPEC §8): an open note in this project and a toast, as v1; harvest on or off.
  // Matched by pattern: the engine's tool-name type lists only the tools it knew when the types
  // were written.
  on('tool.call', { tool: /^mcp__ostrakon__jot$/ }, async ($, e) => {
    const input = e as { note?: unknown; project?: unknown }
    const text = jotText(input.note)
    if (text === '') return { deny: JOT_REPLY.empty }
    const { ctx, all, projects } = await toolView($)
    let into: NoteProject | null = project
    if (typeof input.project === 'string' && input.project.trim() !== '') {
      const named = projectNamed(ctx, projects, input.project)
      if (!named) return { deny: unknownProject(ctx, projects, input.project) }
      into = named
    }
    const same = duplicateOf(all, text, into)
    if (same) return { result: JOT_REPLY.already(same.id) }
    // A subagent's jot may come while a later main turn runs: it's tied to the session only.
    const turnId = e.agentId === undefined ? turnState.running?.turnId : undefined
    const sessionId = await $.session.id().catch(() => undefined)
    let saved: Note
    try {
      saved = await store.create(await storeIO($), {
        text,
        by: 'claude',
        project: into,
        context: { ...(sessionId !== undefined ? { sessionId } : {}), ...(turnId !== undefined ? { turnId } : {}) },
      })
    } catch (error) {
      noteProblem($, 'storage', error)
      return { deny: TOAST.failed(messageOf(error)) }
    }
    toast($, TOAST.jotted(text))
    return { result: JOT_REPLY.saved(saved.id) }
  })

  // Claude's look at the notes waiting (SPEC §8): this project's, another's or all of them.
  on('tool.call', { tool: /^mcp__ostrakon__notes$/ }, async ($, e) => {
    const input = e as { query?: unknown; project?: unknown }
    const { ctx, all, projects } = await toolView($)
    let scope: NoteProject | null = project
    if (typeof input.project === 'string' && input.project.trim() !== '') {
      const named = projectNamed(ctx, projects, input.project)
      if (named === undefined) return { deny: unknownProject(ctx, projects, input.project) }
      scope = named
    }
    return { result: notesReply(ctx, all, scope, typeof input.query === 'string' ? input.query : '') }
  })

  // Claude archives a note whose work is done (SPEC §8); the pane's u undoes it, as the person's own.
  on('tool.call', { tool: /^mcp__ostrakon__archive$/ }, async ($, e) => {
    const id = String((e as { id?: unknown }).id ?? '').trim()
    const note = (await read($, notes))[id]
    if (!note || note.deleted) return { deny: ARCHIVE_REPLY.missing(id) }
    if (note.status !== 'open' && note.status !== 'proposed') return { deny: ARCHIVE_REPLY.notOpen(id, note.status) }
    if (!(await setStatus($, id, 'archived'))) return { deny: ARCHIVE_REPLY.failed }
    toast($, TOAST.claudeArchived(note.text))
    return { result: ARCHIVE_REPLY.archived(id) }
  })

  // `/jot text` saves at once, even mid-turn; `/jot` alone opens the pane (on search, where typing
  // and Enter saves a new note too).
  on('command.run', { command: 'jot' }, async ($, e) => {
    const text = String(e.args ?? '').trim()
    // The draft went in with the command: the hint line no longer reads it as one.
    await update($, isJotDraft, () => false)
    if (text === '') {
      const why = await openPane($, 'browse')
      return { text: why === undefined ? '' : `ostrakon: ${why}` }
    }
    try {
      await createNote($, text, project)
      await showSaved($)
      return { text: '' }
    } catch (error) {
      noteProblem($, 'storage', error)
      return { text: `ostrakon: ${TOAST.failed(messageOf(error))}` }
    }
  })

  // `//` typed into an empty prompt becomes `/jot ` (SPEC §4.4). Only a typed `/` after a lone `/`:
  // a paste, or `//` inside a draft, is left alone.
  on('prompt.edit', async ($, e, next) => {
    const mark = { start: 0, end: 4, color: 'claude', bold: true } as const
    if (e.key !== undefined && e.text === '/' && e.inputText === '/' && e.start === 1 && e.end === 1) {
      await markJotDraft($, true)
      return { text: '/jot ', cursor: 5, decorations: [mark] }
    }
    const edited = await next(e)
    const isJot = edited.text.startsWith('/jot ')
    await markJotDraft($, isJot)
    if (!isJot) return edited
    // Every answer replaces the decorations, so /jot stays marked while it leads the prompt, and
    // the note after it reads as one.
    const note = { start: 5, end: edited.text.length, italic: true } as const
    return { ...edited, decorations: [...(edited.decorations ?? []), mark, ...(edited.text.length > 5 ? [note] : [])] }
  })

  // The hint line under the prompt (SPEC §4.4): a /jot draft says where it saves, then that it did.
  // Added to the engine's line as its tail, after any other mod's.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const said = e.props.isDraft && (await read($, isJotDraft)) ? HINT.capture(project.name) : (await read($, savedAt)) !== 0 ? HINT.saved(project.name) : ''
    if (said === '') return next(e)
    const before = e.props.tail ?? ''
    // The engine parts its own line from the tail; only another mod's tail needs one here.
    const gap = before !== '' ? HINT.gap : ''
    return next({ ...e, props: { ...e.props, tail: `${before}${gap}${said}` } })
  })

  // A note the pane or band put into the prompt is sent once a submit carrying that text goes in.
  on('prompt.submit', async ($, e, next) => {
    const fill = e.origin.kind === 'composer' ? (await read($, pane)).lastFill : null
    // Only the person's next submit after a fill counts: once one goes in, the fill is spent, so a
    // later prompt that happens to contain a short note's text never marks it. A dropped submit
    // spends nothing: the retry still counts.
    const result = await next(e)
    if ('drop' in result && result.drop) return result
    if (fill === null) return result
    const carries = e.text.includes(fill.text) && (result.text ?? e.text).includes(fill.text)
    // Submitted mid-turn, the prompt only waits in the queue: the person can still take it back.
    // It's sent once it enters the conversation (session.append below).
    if (carries && e.turnId !== undefined) return result
    if ((await spendFill($, fill.text)) && carries) await markSent($, fill.ids)
    return result
  })

  // A queued prompt that carries the fill enters the conversation as a row of the main loop's: the
  // note is sent now.
  on('session.append', async ($, e, next) => {
    const appended = await next(e)
    if (e.agentId !== undefined || e.message.role !== 'user' || !(e.door === 'prompt' || e.door === 'attachment' || e.door === 'delivery')) return appended
    const fill = (await read($, pane)).lastFill
    if (fill === null) return appended
    const text = e.message.content.map(block => (typeof block.text === 'string' ? block.text : '')).join('\n')
    if (!text.includes(fill.text)) return appended
    $.ui.log(`ostrakon: sent on entry (${e.door}${e.message.name ? ` ${e.message.name}` : ''})`, { to: 'debug' })
    spendFill($, fill.text)
      .then(isSpent => (isSpent ? markSent($, fill.ids) : undefined))
      .catch(error => reportStorage($, error))
    return appended
  })

  on('turn.start', async ($, e, next) => {
    // The band goes back to Pocket once the next prompt goes in, whoever sent it (a command like
    // /jot starts no turn); a continuation with no text keeps its prompt's harvest. Unkept
    // proposals stay proposed. Decided now, before any wait.
    const started = turnStarted(turnState, e)
    turnState = started.state
    await update($, turns, started.facts)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // Decided now, before any wait: this turn comes off the module (a turn starting meanwhile is
    // left alone), and the band's facts end it unless something newer was written since. A
    // subagent's runs complete too, with no turn.start of their own: only the main turn counts.
    // Whether harvest is on is read here too, at entry (it's set once, in register).
    const completed = turnCompleted(turnState, e, harvestOptions.isOn)
    turnState = completed.state
    const done = await next(e)
    if (completed.facts) await update($, turns, completed.facts)
    if (completed.turn === null) return done
    await collectHarvest($, completed.turn)
    if (completed.review) {
      void reviewTurn($, completed.turn, e.answer).catch(error => noteProblem($, 'harvest review failed', error))
    }
    return done
  })

  // The band (SPEC §10): Pocket, or the last turn's proposals. Drawn under other mods' bands.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const el = $.ui.resolve(e) as Elements['terminal']
    const { Box } = el
    const columns = e.props.bodyColumns
    const run = (work: Promise<unknown>) => {
      work.catch(error => reportStorage($, error))
    }
    const proposals = await proposalsOf($)
    const opener = openerOf(project.name)
    const look = { isWorking: e.props.isWorking, fresh: await read($, fresh) }
    const handlers: BandHandlers = {
      chip: (n, id) => run(serially(() => pocketChip($, n, id))),
      keep: id => run(serially(() => keep($, [id]))),
      keepAll: ids => run(serially(() => keep($, ids))),
      open: () => serially(() => openPane($, 'browse')).catch(error => reportStorage($, error)),
    }
    let row: JSX.Element
    if (proposals.length > 0) {
      const hasHint = (await read($, harvest))?.turnId === (await read($, harvestHint))
      row = (
        <HarvestRow
          el={el}
          proposals={proposals}
          harvest={harvestOf(proposals, columns, opener)}
          look={look}
          hasHint={hasHint}
          columns={columns}
          handlers={handlers}
        />
      )
    } else {
      const all = pocketOptions.isOn ? Object.values(await read($, notes)) : []
      row = <PocketRow el={el} pocket={pocketOf(all, project.key, pocketOptions.max, columns, opener)} opener={opener} look={look} handlers={handlers} />
    }
    return (
      <Box flexDirection='column'>
        {below}
        {row}
      </Box>
    )
  })

  // Esc is "back" (SPEC §4.5): the mod can't see Esc, only the close it asks for, so a person's
  // close of the focused pane goes back one step and closes only from the top. ctrl+q and
  // ctrl+x s are the mod's own closes (origin plugin) and always close.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person' && geometry.isFocused && (await serially(() => goBack($)))) {
      // Esc hands the keys back to the prompt once this settles: take them back after.
      $.clock.after(REFOCUS_MS, () => {
        serially(() => refocus($)).catch(error => reportStorage($, error))
      })
      return { value: undefined }
    }
    const closed = await next(e)
    if (e.id === PANE) await afterClose($)
    return closed
  })

  // The ring's routing is decided in src/focus.ts; this applies it.
  on('ui.focus', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const event = { element: e.element, isPerson: e.origin.kind === 'person' }
    const previous = lastElement
    const move = focusMove(event)
    // Where the ring stays where it went, that's its last element now, before any wait.
    if (move.kind === 'pass' || move.kind === 'land') lastElement = e.element
    const landing = routeFocus(move, event, previous, needsView(move) ? await viewOf($) : undefined)
    if (landing.last !== undefined) lastElement = landing.last
    if (landing.pane) await setPane($, landing.pane)
    if (landing.paged !== undefined) {
      lastElement = pagedSlot(await viewOf($), landing.paged)
      return next({ ...e, element: lastElement })
    }
    return next(landing.to === e.element ? e : { ...e, element: landing.to })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    geometry.bodyRows = e.props.scroll.bodyRows
    geometry.width = Math.max(20, e.props.bodyColumns - 1)
    geometry.isInline = e.props.placement === 'inline'
    geometry.isFocused = e.props.isFocused
    const el = $.ui.resolve(e) as Elements['terminal']
    const view = await viewOf($)
    const run = (work: Promise<unknown>) => {
      work.catch(error => reportStorage($, error))
    }
    // Typing goes straight to state; everything else waits its turn (serially).
    const handlers: Handlers = {
      action: action => run(serially(() => act($, action))),
      digit: n => run(serially(() => digit($, n))),
      pressSlot: slot => run(serially(() => pressSlot($, slot))),
      searchInput: value => run(searchInput($, value)),
      searchSubmit: value => run(serially(() => searchSubmit($, value))),
      captureInput: value => run(setPane($, state => ({ ...state, capture: { ...state.capture, draft: value } }))),
      captureSubmit: value => run(serially(() => captureSubmit($, value))),
      editInput: value => run(setPane($, state => ({ ...state, edit: state.edit ? { ...state.edit, draft: value } : null }))),
      editSubmit: value => run(serially(() => editSubmit($, value))),
      editCancel: () => run(serially(() => act($, 'back'))),
      moveTo: value => run(serially(() => moveTo($, value))),
    }
    return <Pane el={el} view={view} handlers={handlers} hasHub={hubOptions.url !== ''} hasHarvest={false} bundleRows={view.bundleRows} />
  })
}
