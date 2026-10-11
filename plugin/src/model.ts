import type { Note, NoteProblem, NoteProject, PaneState } from '../types'
import { CHORD, GLYPH } from './ui/look'

// The pane's pure model: what to show for a state and a set of notes. No engine calls here, so
// all of it is unit-tested (tests/model.test.ts).

export const freshPane = (): PaneState => ({
  view: 'search',
  mode: 'browse',
  query: '',
  scope: 'project',
  scopeChosen: false,
  history: false,
  folded: [],
  picks: [],
  cursor: null,
  focus: 'search',
  offset: 0,
  sheetPage: 0,
  edit: null,
  moving: null,
  capture: { draft: '', target: null, saved: [], error: null },
  stash: '',
  lastFill: null,
  undo: [],
})

// ---- text ----

export const oneLine = (text: string) => text.replaceAll(/\s*\n\s*/g, ' ').trim()

// Terminal cells a character takes: two for wide East Asian characters, emoji and flags, none for
// combining marks and joiners.
const WIDE =
  /[\u1100-\u115F\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u200B-\u200F\u20D0-\u20FF\uFE00-\uFE0F]/u
const cellsOf = (char: string) => (ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1)

// What the terminal draws as one character (an emoji sequence, a flag, a letter and its marks).
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined
export const clustersOf = (text: string) => (segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text))
// A cluster is as wide as its widest character: a joined emoji sequence is two cells, not six.
const clusterCells = (cluster: string) => {
  let widest = 0
  for (const char of cluster) widest = Math.max(widest, cellsOf(char))
  return widest
}

export const cells = (text: string) => {
  let sum = 0
  for (const cluster of clustersOf(text)) sum += clusterCells(cluster)
  return sum
}

// Cuts to `width` terminal cells, by whole clusters.
export const cut = (text: string, width: number) => {
  if (width <= 0) return ''
  if (cells(text) <= width) return text
  let kept = ''
  let used = 0
  for (const cluster of clustersOf(text)) {
    const size = clusterCells(cluster)
    if (used + size > width - 1) break
    kept += cluster
    used += size
  }
  // A cut word ends at the …; a cut space doesn't sit in front of it.
  return `${kept.trimEnd()}${GLYPH.more}`
}

// Wraps at spaces to `width` cells; a word wider than a line breaks between clusters.
export const wrap = (text: string, width: number) => {
  const room = Math.max(1, width)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (cells(line + word) > room && line.trim() !== '') {
        out.push(line.trimEnd())
        line = word.trimStart()
      } else line += word
      while (cells(line) > room) {
        let head = ''
        let used = 0
        for (const cluster of clustersOf(line)) {
          const size = clusterCells(cluster)
          if (used + size > room && head !== '') break
          head += cluster
          used += size
        }
        out.push(head)
        line = line.slice(head.length)
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

export const ageOf = (stamp: string, now: number) => {
  const minutes = Math.max(0, Math.floor((now - Date.parse(stamp)) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`
  if (days < 365) return `${Math.floor(days / 7)}w`
  return `${Math.floor(days / 365)}y`
}

// Edit fields are one line: newlines show as ↵ and come back on save. A note that already holds a
// literal ↵ can't round-trip and isn't edited inline.
export const canEditInline = (text: string) => !text.includes(GLYPH.newline)
export const toField = (text: string) => text.replaceAll('\n', GLYPH.newline)
export const fromField = (text: string) => text.replaceAll(GLYPH.newline, '\n')

// ---- projects ----

const segmentsOf = (key: string) => key.replace(/^path:/, '').split('/').filter(Boolean)

// Display labels: the basename, with parent segments prepended only where two projects share one.
export const labelsOf = (projects: NoteProject[]) => {
  const byKey = new Map<string, NoteProject>()
  for (const project of projects) byKey.set(project.key, project)
  const labels = new Map<string, string>()
  const byName = new Map<string, string[]>()
  for (const [key, project] of byKey) byName.set(project.name, [...(byName.get(project.name) ?? []), key])
  for (const [name, keys] of byName) {
    if (keys.length === 1) {
      labels.set(keys[0] ?? '', name)
      continue
    }
    const longest = Math.max(...keys.map(key => segmentsOf(key).length))
    for (let depth = 2; depth <= longest + 1; depth++) {
      const tried = keys.map(key => (depth > segmentsOf(key).length ? key : segmentsOf(key).slice(-depth).join('/')))
      if (new Set(tried).size === keys.length || depth > longest) {
        keys.forEach((key, i) => labels.set(key, tried[i] ?? key))
        break
      }
    }
  }
  return labels
}

export const UNFILED = 'unfiled'
export const PROPOSED = 'proposed'

export type Ctx = {
  now: number
  current: NoteProject
  labels: Map<string, string>
}

export const labelOf = (ctx: Ctx, project: NoteProject | null) =>
  project === null ? UNFILED : ctx.labels.get(project.key) ?? project.name

export const isOther = (ctx: Ctx, note: Note) => note.project !== null && note.project.key !== ctx.current.key

// What a note becomes in a prompt: its text, prefixed with its project when that isn't this one.
export const dispatchText = (ctx: Ctx, note: Note) => (isOther(ctx, note) ? `[${labelOf(ctx, note.project)}] ${note.text}` : note.text)

export const bundleText = (ctx: Ctx, notes: Note[]) =>
  ['Please look at these notes from my ostrakon:', '', ...notes.map(note => `- ${dispatchText(ctx, note)}`)].join('\n')

// ---- search ----

export type Query = { words: string; project?: string; status?: 'sent' | 'archived'; by?: 'claude' }

export const parseQuery = (raw: string): Query => {
  const words: string[] = []
  const query: Query = { words: '' }
  for (const token of raw.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith('@') && token.length > 1) query.project = token.slice(1).toLowerCase()
    else if (token === 'is:sent' || token === 'is:archived') query.status = token.slice(3) as 'sent' | 'archived'
    else if (token === 'by:claude') query.by = 'claude'
    else words.push(token)
  }
  query.words = words.join(' ')
  return query
}

// Where the query's characters fall in the text: a contiguous hit when there is one, else a
// greedy subsequence. Undefined when the text doesn't match at all.
export const matchOf = (text: string, query: string): number[] | undefined => {
  if (query === '') return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  const at = haystack.indexOf(needle)
  if (at >= 0) return Array.from({ length: needle.length }, (_, i) => at + i)
  const positions: number[] = []
  let from = 0
  for (const char of needle) {
    if (char === ' ') continue
    const found = haystack.indexOf(char, from)
    if (found < 0) return undefined
    positions.push(found)
    from = found + 1
  }
  // A subsequence scattered across the whole line isn't a match: "cache" in "contrast check".
  const spread = (positions[positions.length - 1] ?? 0) - (positions[0] ?? 0) + 1
  return spread <= needle.replaceAll(' ', '').length * 2 ? positions : undefined
}

const isWordStart = (text: string, at: number) => at === 0 || /[\s\-_/.([{'"]/.test(text[at - 1] ?? ' ')

export const scoreOf = (ctx: Ctx, note: Note, query: string) => {
  const text = oneLine(note.text)
  const positions = matchOf(text, query)
  if (positions === undefined) return undefined
  let score = 0
  if (query !== '') {
    const first = positions[0] ?? 0
    const contiguous = positions.every((at, i) => i === 0 || at === (positions[i - 1] ?? 0) + 1)
    const spread = (positions[positions.length - 1] ?? 0) - first
    score += contiguous ? 100 : 50 - Math.min(40, spread)
    if (isWordStart(text, first)) score += 20
    score -= Math.min(10, first / 10)
  }
  if (note.project?.key === ctx.current.key) score += 10
  const days = (ctx.now - Date.parse(note.updated)) / 86_400_000
  score += Math.max(0, 10 - days / 3)
  return score
}

// ---- lines ----

export type Line =
  | { kind: 'problem'; key: 'problem'; count: number }
  | { kind: 'group'; key: string; group: string; project: NoteProject | null; isFolded: boolean; count: number }
  | { kind: 'note'; key: string; note: Note; group?: string; hits: number[] }

export const groupKeyOf = (note: Note) => (note.status === 'proposed' ? PROPOSED : note.project?.key ?? UNFILED)

const newest = (a: Note, b: Note) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1)

const isHistory = (note: Note) => note.status === 'sent' || note.status === 'archived'

// The notes a state shows, before grouping: scope, query tokens, status.
export const visibleNotes = (ctx: Ctx, pane: PaneState, notes: Note[]) => {
  const query = parseQuery(pane.query)
  const shown: { note: Note; score: number; hits: number[] }[] = []
  for (const note of notes) {
    if (note.deleted) continue
    if (pane.scope === 'project' && note.project?.key !== ctx.current.key) continue
    if (query.project !== undefined && !labelOf(ctx, note.project).toLowerCase().includes(query.project)) continue
    if (query.by !== undefined && note.by !== query.by) continue
    if (query.status !== undefined) {
      if (note.status !== query.status) continue
    } else if (pane.view === 'list') {
      if (!(note.status === 'open' || note.status === 'proposed' || (pane.history && isHistory(note)))) continue
    } else if (note.status !== 'open') continue
    const score = scoreOf(ctx, note, query.words)
    if (score === undefined) continue
    shown.push({ note, score, hits: matchOf(oneLine(note.text), query.words) ?? [] })
  }
  if (query.words === '') shown.sort((a, b) => newest(a.note, b.note))
  else shown.sort((a, b) => b.score - a.score || newest(a.note, b.note))
  return shown
}

export const linesOf = (ctx: Ctx, pane: PaneState, notes: Note[], problems: NoteProblem[]): Line[] => {
  const lines: Line[] = problems.length > 0 ? [{ kind: 'problem', key: 'problem', count: problems.length }] : []
  const shown = visibleNotes(ctx, pane, notes)
  if (pane.view === 'search') {
    for (const { note, hits } of shown) lines.push({ kind: 'note', key: note.id, note, hits })
    return lines
  }
  const groups = new Map<string, typeof shown>()
  for (const item of shown) {
    const key = groupKeyOf(item.note)
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const activity = (key: string) => (groups.get(key) ?? []).reduce((latest, item) => (item.note.updated > latest ? item.note.updated : latest), '')
  const order = [...groups.keys()].sort((a, b) => {
    const rank = (key: string) => (key === PROPOSED ? 0 : key === ctx.current.key ? 1 : key === UNFILED ? 3 : 2)
    return rank(a) - rank(b) || (activity(a) < activity(b) ? 1 : activity(a) > activity(b) ? -1 : a < b ? -1 : 1)
  })
  for (const group of order) {
    const items = groups.get(group) ?? []
    const isFolded = pane.folded.includes(group)
    const project = group === PROPOSED || group === UNFILED ? null : items[0]?.note.project ?? null
    // Open (and proposed) first, then history; each newest first. With a query, by rank.
    const live = items.filter(item => !isHistory(item.note))
    const past = items.filter(item => isHistory(item.note))
    lines.push({ kind: 'group', key: `group:${group}`, group, project, isFolded, count: live.length })
    if (isFolded) continue
    for (const { note, hits } of [...live, ...past]) lines.push({ kind: 'note', key: note.id, note, group, hits })
  }
  return lines
}

export const groupLabel = (ctx: Ctx, line: Extract<Line, { kind: 'group' }>) =>
  line.group === PROPOSED ? PROPOSED : line.group === UNFILED ? UNFILED : labelOf(ctx, line.project)

// ---- paging (SPEC §4.8) ----

export type Page = {
  offset: number
  lines: Line[]
  above: number
  below: number
  // Line index → its 1-9 number, for note lines within the window.
  numbers: Map<string, number>
}

// The window of lines that fits `capacity` rows, keeping the cursor inside it. Each edge sentinel
// takes one row from the window when there is something past that edge.
export const pageOf = (lines: Line[], desired: number, cursor: string | null, capacity: number): Page => {
  const total = lines.length
  const at = cursor === null ? -1 : lines.findIndex(line => line.key === cursor)
  const fits = (offset: number) => {
    let rows = capacity
    if (offset > 0) rows -= 1
    if (offset + rows < total) rows -= 1
    return Math.max(1, rows)
  }
  let offset = Math.max(0, Math.min(desired, Math.max(0, total - 1)))
  if (at >= 0) {
    if (at < offset) offset = at
    while (at >= offset + fits(offset)) offset += 1
  }
  // Don't leave empty room at the bottom when scrolled.
  while (offset > 0 && offset - 1 + fits(offset - 1) >= total && (at < 0 || at < offset - 1 + fits(offset - 1))) offset -= 1
  const rows = total <= capacity && offset === 0 ? total : fits(offset)
  const window = lines.slice(offset, offset + rows)
  const numbers = new Map<string, number>()
  let n = 0
  for (const line of window) if (line.kind === 'note' && n < 9) numbers.set(line.key, ++n)
  return { offset, lines: window, above: offset, below: Math.max(0, total - offset - window.length), numbers }
}

// Rows a wrapped text takes at a width.
export const wrappedRows = (text: string, width: number) =>
  text.split('\n').reduce((rows, line) => rows + Math.max(1, Math.ceil(cells(line) / Math.max(1, width))), 0)

// ---- keys and footers (SPEC §4.5, §4.6) ----

export type Action =
  | 'pick'
  | 'clearPicks'
  | 'toPrompt'
  | 'send'
  | 'bundle'
  | 'edit'
  | 'archive'
  | 'undo'
  | 'restore'
  | 'move'
  | 'copy'
  | 'list'
  | 'history'
  | 'fold'
  | 'search'
  | 'new'
  | 'scope'
  | 'keys'
  | 'close'
  | 'keep'
  | 'dismiss'
  | 'details'
  | 'back'
  | 'down'
  | 'up'
  | 'toggle'

// A key the pane answers: `hotkey` is a letter for the hidden action layer, `chord` a borrowed
// engine action. `shown` is what the footer prints (absent: answered but not advertised).
export type Key = { action: Action; hotkey?: string; chord?: string; shown?: [string, string] }

const k = (action: Action, hotkey: string, label: string, isShown = true): Key => ({ action, hotkey, shown: isShown ? [hotkey, label] : undefined })
const chord = (action: Action, which: keyof typeof CHORD, label: string, isShown = true): Key => ({
  action,
  chord: CHORD[which].action,
  shown: isShown ? [CHORD[which].keys, label] : undefined,
})

// Answered everywhere in the pane (chords work with an Input focused too).
const CHORDS = (isShown: boolean): Key[] => [
  chord('list', 'list', 'list view', isShown),
  chord('scope', 'scope', 'scope', isShown),
  chord('new', 'new', 'new', isShown),
  chord('search', 'search', 'search', false),
  chord('close', 'close', 'close', isShown),
]

export type Focus =
  | { kind: 'unfocused' }
  | { kind: 'search'; hasResults: boolean; hasQuery: boolean }
  | { kind: 'line'; line: Line; view: 'search' | 'list'; picks: number }
  | { kind: 'capture' }
  | { kind: 'edit' }
  | { kind: 'bundle' }
  | { kind: 'move' }
  // `lead`: the hotkeys of the row the sheet was opened on, its own actions; none off a row.
  | { kind: 'sheet'; page: number; pages: number; lead: string[] }
  | { kind: 'empty' }

// The keys answered in a focus, footer order. The hidden action layer mounts exactly these, so a
// key the footer shows always works and nothing else is advertised.
export const keysFor = (focus: Focus): Key[] => {
  const nav = [k('down', 'j', 'down', false), k('up', 'k', 'up', false)]
  switch (focus.kind) {
    case 'unfocused':
      return []
    case 'search':
      if (focus.hasQuery && !focus.hasResults) {
        return [{ action: 'new', shown: ['⏎', 'save as note'] }, chord('scope', 'scope', 'scope'), chord('close', 'close', 'close'), chord('list', 'list', '', false), chord('new', 'new', '', false)]
      }
      return [chord('list', 'list', 'list view'), chord('scope', 'scope', 'scope'), chord('new', 'new', 'new'), chord('close', 'close', 'close')]
    case 'empty':
      return [chord('new', 'new', 'new'), chord('scope', 'scope', 'scope'), chord('close', 'close', 'close'), chord('list', 'list', '', false)]
    case 'capture':
      return [{ action: 'new', shown: ['⏎', 'save'] }, { action: 'back', shown: ['esc', 'back to search'] }, chord('scope', 'scope', 'project'), ...CHORDS(false)]
    case 'edit':
      return [{ action: 'new', shown: ['⏎', 'save'] }, { action: 'back', shown: ['esc', 'back, draft kept'] }, { action: 'back', shown: ['tab then ⏎', 'cancel'] }, ...CHORDS(false)]
    case 'bundle':
      return [{ action: 'send', shown: ['⏎', 'send'] }, k('toPrompt', 't', 'to prompt (edit first)'), { action: 'back', shown: ['esc', 'back'] }, k('back', 'x', '', false), ...CHORDS(false)]
    case 'move':
      return [{ action: 'move', shown: ['⏎', 'move'] }, { action: 'back', shown: ['esc', 'back'] }, ...CHORDS(false)]
    case 'sheet':
      return [
        k('keys', 'i', 'close keys'),
        ...(focus.pages > 1 ? [k('down', 'j', `more ${focus.page + 1}/${focus.pages}`), k('up', 'k', 'back', false)] : []),
        ...CHORDS(false),
      ]
    case 'line': {
      const { line } = focus
      const always = [...nav, k('copy', 'y', 'copy', false), k('close', 'q', 'close', false), k('search', 'f', 'search', false), k('new', 'n', 'new', false), ...CHORDS(false)]
      if (line.kind === 'problem') return [{ action: 'details', shown: ['⏎', 'details'] }, k('search', 'f', 'search'), ...always]
      if (line.kind === 'group') {
        return [k('fold', 'z', 'fold'), k('history', 'h', 'history'), k('search', 'f', 'search'), k('keys', 'i', 'keys'), k('list', 'l', 'list', false), ...nav, ...CHORDS(false)]
      }
      const { note } = line
      const inList = focus.view === 'list'
      const listKeys = inList ? [k('fold', 'z', 'fold', false), k('history', 'h', 'history', false)] : []
      if (note.status === 'sent' || note.status === 'archived') {
        return inList
          ? [k('restore', 'u', 'restore'), k('history', 'h', 'hide history'), k('fold', 'z', 'fold'), k('search', 'f', 'search'), k('keys', 'i', 'keys', false), k('list', 'l', 'list', false), ...always]
          : [k('restore', 'u', 'restore'), k('search', 'f', 'search'), k('keys', 'i', 'keys'), k('list', 'l', 'list', false), ...always]
      }
      if (note.status === 'proposed') {
        return [k('keep', 'a', 'keep'), k('dismiss', 'r', 'dismiss'), k('toPrompt', 't', 'to prompt'), k('keys', 'i', 'keys'), k('list', 'l', 'list', false), ...listKeys, ...always]
      }
      const rest = [
        k('send', 's', 'send', false),
        k('edit', 'e', 'edit', false),
        k('archive', 'd', 'archive', false),
        k('undo', 'u', 'undo', false),
        k('move', 'm', 'move', false),
        k('list', 'l', 'list', false),
        ...listKeys,
        ...always,
      ]
      if (focus.picks > 0) {
        return [k('bundle', 'b', 'bundle'), k('pick', 'v', 'pick'), k('clearPicks', 'x', 'clear picks'), k('toPrompt', 't', 'to prompt'), k('keys', 'i', 'keys'), ...rest]
      }
      // Nothing picked: the note's own actions lead, so they are the four the footer has room for.
      const shown = inList
        ? [k('toPrompt', 't', 'to prompt'), k('send', 's', 'send'), k('edit', 'e', 'edit'), k('archive', 'd', 'archive'), k('pick', 'v', 'pick'), k('fold', 'z', 'fold'), k('history', 'h', 'history'), k('keys', 'i', 'keys')]
        : [k('toPrompt', 't', 'to prompt'), k('send', 's', 'send'), k('edit', 'e', 'edit'), k('archive', 'd', 'archive'), k('pick', 'v', 'pick'), k('list', 'l', 'list'), k('search', 'f', 'search'), k('keys', 'i', 'keys')]
      return [...shown, k('bundle', 'b', 'bundle', false), ...rest]
    }
  }
}

// One key per hotkey and chord (the first wins), so the action layer never mounts two Buttons for
// one key.
export const uniqueKeys = (keys: Key[]) => {
  const seen = new Set<string>()
  return keys.filter(key => {
    const id = key.hotkey ?? key.chord ?? `shown:${key.shown?.[0]}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

export const footerPairs = (keys: Key[]) => uniqueKeys(keys).flatMap(key => (key.shown ? [key.shown] : []))

// The keys a row's footer leads with, its own actions, up to the first of the pane's own.
const PANE_ACTIONS: Action[] = ['list', 'search', 'fold', 'history', 'keys']
export const ownKeys = (keys: Key[]) => {
  const own: string[] = []
  for (const key of uniqueKeys(keys)) {
    if (key.shown === undefined || key.hotkey === undefined) continue
    if (PANE_ACTIONS.includes(key.action)) break
    own.push(key.hotkey)
  }
  return own
}

// The key sheet's lines with the row's own keys first, in its footer's order, then the rest as
// they are. A line is a row's when one of its keys (`d / u`) is.
export const sheetLines = (lines: [string, string][], lead: string[]) => {
  const own = [...new Set(lead.flatMap(hotkey => lines.filter(([keys]) => keys.split(' / ').includes(hotkey))))]
  return [...own, ...lines.filter(line => !own.includes(line))]
}

// Footer statuses ([text, colour]) within `room` cells, two between them: cut, never wrapped, and
// the last ones go first.
export const fitStatuses = (statuses: [string, string][], room: number) => {
  let left = room
  return statuses.flatMap(([text, colour]): [string, string][] => {
    const fitted = cut(text, left)
    left -= cells(fitted) + 2
    return fitted === '' ? [] : [[fitted, colour]]
  })
}

// Footer rows at a width: pairs wrap with two spaces between them.
export const footerRows = (pairs: [string, string][], lead: string, width: number) => {
  let rows = 1
  let used = cells(lead)
  for (const [key, label] of pairs) {
    const size = cells(key) + (label === '' ? 0 : 1 + cells(label))
    const gap = used === 0 ? 0 : 2
    if (used + gap + size > width && used > 0) {
      rows += 1
      used = size
    } else used += gap + size
  }
  return rows
}

// Inline: drop pairs from the right until one line fits, keeping `i keys` when it was there.
export const fitOneLine = (pairs: [string, string][], lead: string, width: number) => {
  const keys = pairs.find(([key]) => key === 'i')
  let kept = pairs.filter(([key]) => key !== 'i')
  const withKeys = () => (keys ? [...kept, keys] : kept)
  while (kept.length > 0 && footerRows(withKeys(), lead, width) > 1) kept = kept.slice(0, -1)
  return withKeys()
}

