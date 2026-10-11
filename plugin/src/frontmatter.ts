// The note file format: YAML front matter (a strict, small subset) and the note text as the body.
// parseNote throws on anything it doesn't understand in the keys it owns; the caller skips that
// file and never writes over it. Keys it doesn't own (Obsidian properties, tags) are kept
// verbatim, in whatever YAML form they take. serializeNote writes exactly what parseNote reads.

import type { Note, NoteBy, NoteContext, NoteProject, NoteStatus } from '../types'

const STATUSES: readonly NoteStatus[] = ['open', 'proposed', 'sent', 'archived', 'dismissed']
const AUTHORS: readonly NoteBy[] = ['you', 'claude', 'phone']
const CONTEXT_KEYS = ['sessionId', 'branch', 'turnId', 'harvestOf', 'sentSessionId'] as const
const PROJECT_KEYS = ['key', 'name', 'path'] as const
// The project and context are written as flat keys, which Obsidian's Properties shows and edits as
// text (`project: cc`, `projectKey: …`, `branch: …`); the nested blocks written before P6 are still read.
const FLAT_PROJECT = { name: 'project', key: 'projectKey', path: 'projectPath' } as const
const OWN_KEYS = ['id', 'status', 'by', 'created', 'updated', 'origin', 'project', 'projectKey', 'projectPath', 'context', ...CONTEXT_KEYS, 'sentAt', 'deleted']

// ISO 8601 with an explicit zone, so every machine reads the same instant.
const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:?\d\d)$/

type Scalar = string | boolean | null

// What YAML 1.1 or 1.2 readers would type as a number or a date rather than a string.
const YAML_NUMBER =
  /^[-+]?(\d[\d_]*(\.[\d_]*)?([eE][-+]?\d+)?|\.\d[\d_]*([eE][-+]?\d+)?|0x[\da-f_]+|0o[0-7_]+|0b[01_]+|\.inf|\.nan|\d[\d_]*(:[0-5]?\d)+(\.[\d_]*)?)$/i
const YAML_DATE = /^\d{4}-\d\d?-\d\d?([Tt ]|$)/

// Plain values stay unquoted only when every YAML reader would read them back as this string.
const needsQuotes = (value: string) =>
  value === '' ||
  value !== value.trim() ||
  /^(null|true|false|~|yes|no|on|off|y|n)$/i.test(value) ||
  YAML_NUMBER.test(value) ||
  YAML_DATE.test(value) ||
  /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
  /: |:$|\s#|[\n\r\t\\"]/.test(value)

const formatScalar = (value: Scalar) =>
  value === null ? 'null' : typeof value === 'boolean' ? String(value) : needsQuotes(value) ? JSON.stringify(value) : value

const parseScalar = (raw: string, where: string): Scalar => {
  const text = raw.trim()
  if (text.startsWith('"')) {
    const quoted = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/.exec(text)
    if (!quoted) throw new Error(`${where}: bad quoted string`)
    try {
      return JSON.parse(quoted[1] ?? '') as string
    } catch {
      throw new Error(`${where}: bad quoted string`)
    }
  }
  if (text.startsWith("'")) {
    const quoted = /^'((?:[^']|'')*)'(?:\s+#.*)?$/.exec(text)
    if (!quoted) throw new Error(`${where}: bad quoted string`)
    return (quoted[1] ?? '').replaceAll("''", "'")
  }
  const plain = text.replace(/(^|\s+)#.*$/, '')
  if (plain === 'null' || plain === '~' || plain === '') return null
  if (plain === 'true') return true
  if (plain === 'false') return false
  // Flow collections, anchors, tags, block scalars and nested mappings aren't part of the owned
  // keys' format; a plain value can't hold ": " either.
  if (/^[[\]{}&*!|>%@`]/.test(plain) || /:(\s|$)/.test(plain)) throw new Error(`${where}: unsupported YAML value "${plain}"`)
  return plain
}

const asString = (value: Scalar | undefined, where: string) => {
  if (typeof value !== 'string' || value === '') throw new Error(`${where}: expected text`)
  return value
}

const asTime = (value: Scalar | undefined, where: string) => {
  const text = asString(value, where)
  if (!TIMESTAMP.test(text) || Number.isNaN(Date.parse(text))) throw new Error(`${where}: not an ISO timestamp with a zone`)
  return text
}

type Nested = { values: Map<string, Scalar>; extra: string[] }
type Block = { scalars: Map<string, Scalar>; maps: Map<string, Nested | null>; extra: string[] }

const isComment = (line: string) => line.trimStart().startsWith('#')
// Lines that belong to the key above them: indented, a block-sequence item, or blank.
const isContinuation = (line: string) => /^\s/.test(line) || line.startsWith('- ') || line === '-' || line.trim() === ''

const readBlock = (lines: string[]): Block => {
  const block: Block = { scalars: new Map(), maps: new Map(), extra: [] }
  let i = 0
  const takeContinuation = () => {
    const taken: string[] = []
    while (i < lines.length && isContinuation(lines[i] ?? '')) taken.push(lines[i++] ?? '')
    // Trailing blank lines separate keys; they don't belong to the value.
    while (taken.length > 0 && (taken[taken.length - 1] ?? '').trim() === '') taken.pop()
    return taken
  }
  while (i < lines.length) {
    const line = lines[i] ?? ''
    i += 1
    if (line.trim() === '' || isComment(line)) continue
    const top = /^([^\s#-][^:]*):(?:\s+(.*))?$/.exec(line) ?? /^(-[^\s:][^:]*):(?:\s+(.*))?$/.exec(line)
    if (!top) throw new Error(`front matter line ${i}: not "key: value"`)
    const key = top[1] ?? ''
    const rest = top[2] ?? ''
    // Keys this mod doesn't own are kept verbatim, with every line that belongs to them. So is a
    // context key that isn't plain text (a list, a block): a property of the person's own that
    // happens to share the name.
    const isTheirs = (CONTEXT_KEYS as readonly string[]).includes(key) && (rest.trim() === '' || /^[[{|>]/.test(rest.trim()))
    if (!OWN_KEYS.includes(key) || isTheirs) {
      block.extra.push([line, ...takeContinuation()].join('\n'))
      continue
    }
    if (block.scalars.has(key) || block.maps.has(key)) throw new Error(`front matter: "${key}" twice`)
    if (key === 'project' || key === 'context') {
      const nestedLines = takeContinuation()
      const hasNested = nestedLines.some(nested => nested.trim() !== '' && !isComment(nested))
      if (rest.trim() !== '') {
        const value = parseScalar(rest, key)
        // The flat form: `project: <name>` beside projectKey and projectPath.
        if (key === 'project' && typeof value === 'string' && !hasNested) {
          block.scalars.set(key, value)
          continue
        }
        if (value !== null || hasNested) throw new Error(`${key}: expected a nested block or null`)
        block.maps.set(key, null)
        continue
      }
      const nested: Nested = { values: new Map(), extra: [] }
      for (const nestedLine of nestedLines) {
        if (nestedLine.trim() === '' || isComment(nestedLine)) continue
        const pair = /^\s+([^\s#-][^:]*):(?:\s+(.*))?$/.exec(nestedLine)
        if (!pair) throw new Error(`${key}: "${nestedLine.trim()}" is not "key: value"`)
        const name = pair[1] ?? ''
        const owned: readonly string[] = key === 'project' ? PROJECT_KEYS : CONTEXT_KEYS
        if (owned.includes(name)) nested.values.set(name, parseScalar(pair[2] ?? '', `${key}.${name}`))
        else nested.extra.push(nestedLine)
      }
      // `project:` with nothing under it is YAML null.
      block.maps.set(key, nested.values.size === 0 && nested.extra.length === 0 ? null : nested)
      continue
    }
    block.scalars.set(key, parseScalar(rest, key))
  }
  return block
}

const readProject = (nested: Nested | null | undefined, flat: (key: string) => Scalar | undefined): NoteProject | null => {
  const named = flat(FLAT_PROJECT.name)
  if (typeof named === 'string') {
    if (nested) throw new Error('project: both a nested block and a name')
    const key = asString(flat(FLAT_PROJECT.key), FLAT_PROJECT.key)
    const path = flat(FLAT_PROJECT.path)
    return { key, name: named, path: typeof path === 'string' ? path : '' }
  }
  // The name cleared in Obsidian (`project:` with nothing after it): the key still says which.
  const keyed = flat(FLAT_PROJECT.key)
  if (typeof keyed === 'string' && keyed !== '' && !nested) {
    const path = flat(FLAT_PROJECT.path)
    return { key: keyed, name: keyed.split(/[/:]/).pop() ?? keyed, path: typeof path === 'string' ? path : '' }
  }
  if (keyed !== undefined || flat(FLAT_PROJECT.path) !== undefined) throw new Error('projectKey: no project name')
  if (!nested) return null
  const key = asString(nested.values.get('key'), 'project.key')
  const name = nested.values.get('name')
  const path = nested.values.get('path')
  return {
    key,
    name: typeof name === 'string' && name !== '' ? name : (key.split(/[/:]/).pop() ?? key),
    path: typeof path === 'string' ? path : '',
  }
}

const readContext = (nested: Nested | null | undefined, flat: (key: string) => Scalar | undefined): NoteContext => {
  const context: NoteContext = {}
  for (const key of CONTEXT_KEYS) {
    const top = flat(key)
    if (top !== undefined && nested?.values.has(key)) throw new Error(`${key}: both flat and under context`)
    const value = top ?? nested?.values.get(key)
    if (typeof value === 'string' && value !== '') context[key] = value
  }
  return context
}

export const parseNote = (source: string): Note => {
  const text = source.replace(/^\uFEFF/, '')
  const opening = /^---\r?\n/.exec(text)
  if (!opening) throw new Error('no front matter')
  const closing = /\r?\n---(\r?\n|$)/.exec(text.slice(opening[0].length - 1))
  if (!closing) throw new Error('front matter never closes')
  const start = opening[0].length
  const end = opening[0].length - 1 + closing.index
  const after = text.slice(end + closing[0].length)
  const block = readBlock(text.slice(start, end).replaceAll('\r\n', '\n').split('\n'))
  const scalar = (key: string) => block.scalars.get(key)

  const status = scalar('status')
  if (!STATUSES.includes(status as NoteStatus)) throw new Error(`status: "${String(status)}" is not a status`)
  const by = scalar('by')
  if (!AUTHORS.includes(by as NoteBy)) throw new Error(`by: "${String(by)}" is not an author`)
  const sentAt = scalar('sentAt')
  const deleted = scalar('deleted') ?? false
  if (typeof deleted !== 'boolean') throw new Error('deleted: expected true or false')
  const origin = scalar('origin')

  const project = block.maps.get('project')
  const context = block.maps.get('context')
  const nestedExtra = {
    ...(project?.extra.length ? { project: project.extra } : {}),
    ...(context?.extra.length ? { context: context.extra } : {}),
  }
  const id = asString(scalar('id'), 'id')
  // Ids name files and lock directories: letters, digits, _ and - only.
  if (!/^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/.test(id)) throw new Error(`id: "${id}" isn't a safe id`)
  return {
    id,
    status: status as NoteStatus,
    by: by as NoteBy,
    created: asTime(scalar('created'), 'created'),
    updated: asTime(scalar('updated'), 'updated'),
    origin: typeof origin === 'string' && origin !== '' ? origin : 'unknown',
    project: readProject(project, scalar),
    context: readContext(context, scalar),
    sentAt: sentAt === null || sentAt === undefined ? null : asTime(sentAt, 'sentAt'),
    deleted,
    // The line break after the closing fence belongs to the format; one at the end is the file's.
    text: after.replace(/\r?\n$/, ''),
    extra: block.extra,
    ...(Object.keys(nestedExtra).length > 0 ? { nestedExtra } : {}),
  }
}

export const serializeNote = (note: Note) => {
  const lines = [
    '---',
    `id: ${formatScalar(note.id)}`,
    `status: ${note.status}`,
    `by: ${note.by}`,
    // Timestamps are written plain: YAML tools and Obsidian read them as dates, and parseNote
    // accepts them only in this exact form.
    `created: ${note.created}`,
    `updated: ${note.updated}`,
    `origin: ${formatScalar(note.origin)}`,
  ]
  // A nested block with keys of someone else's under it keeps the nested form, so they're kept.
  if (note.project && note.nestedExtra?.project) {
    lines.push('project:')
    for (const key of PROJECT_KEYS) lines.push(`  ${key}: ${formatScalar(note.project[key])}`)
    lines.push(...note.nestedExtra.project)
  } else if (note.project) {
    lines.push(
      `${FLAT_PROJECT.name}: ${formatScalar(note.project.name)}`,
      `${FLAT_PROJECT.key}: ${formatScalar(note.project.key)}`,
      `${FLAT_PROJECT.path}: ${formatScalar(note.project.path)}`,
    )
  } else {
    lines.push('project: null')
  }
  const context = CONTEXT_KEYS.filter(key => note.context[key] !== undefined)
  const contextExtra = note.nestedExtra?.context ?? []
  if (contextExtra.length > 0) {
    lines.push('context:')
    for (const key of context) lines.push(`  ${key}: ${formatScalar(note.context[key] ?? null)}`)
    lines.push(...contextExtra)
  } else {
    for (const key of context) lines.push(`${key}: ${formatScalar(note.context[key] ?? null)}`)
  }
  lines.push(`sentAt: ${note.sentAt ?? 'null'}`, `deleted: ${note.deleted}`, ...note.extra, '---', note.text)
  return `${lines.join('\n')}\n`
}
