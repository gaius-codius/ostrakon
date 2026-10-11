// Holds docs/DESIGN.md and the code to each other. Run by tools/check.sh and CI.
//
// - Drift: the doc's checked tables (each after a `<!-- check: <name> -->` line) against the values
//   in plugin/src/ui/look.ts, server/public/app.js, style.css and index.html, and the pane's palette
//   against the phone's.
// - Changelog: the newest entry's Fingerprint is a hash of those values, so a change to any of them
//   fails until it is logged: a new version with Change: and Why: lines.
// - History (with --base <git ref>): a design that differs from the base's needs a higher version
//   than the base's, and no entry of the base's may go.
//
//   bun tools/check-design.ts [--base <ref>]   check
//   bun tools/check-design.ts --fingerprint    print the current fingerprint
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import * as LOOK from '../plugin/src/ui/look'

export type Look = {
  GLYPH: Record<string, string>
  COLOUR: { palette: readonly { name: string; dark: string; light: string }[]; ansiPalette: readonly string[] } & Record<string, unknown>
  [key: string]: unknown
}
// A repo file's text by its path from the repo root, or undefined when there's none.
export type Read = (path: string) => string | undefined

const ROOT = new URL('..', import.meta.url)
export const readRepo: Read = path => {
  try {
    return readFileSync(new URL(path, ROOT), 'utf8')
  } catch {
    return undefined
  }
}

export const FILES = {
  doc: 'docs/DESIGN.md',
  look: 'plugin/src/ui/look.ts',
  app: 'server/public/app.js',
  css: 'server/public/style.css',
  html: 'server/public/index.html',
  motion: 'server/public/vendor/motion.js',
} as const
// What the doc's tables call a file.
const SHORT: Record<string, string> = { 'look.ts': FILES.look, 'app.js': FILES.app, 'style.css': FILES.css, 'index.html': FILES.html, 'motion.js': FILES.motion }

// The engine draws a plain Button's hotkey digit in this theme key: never a project's colour.
const RESERVED = 'suggestion'
const MIN_CONTRAST = 4.5

// ---- reading the code ----

type Vars = Map<string, string>
const varsOf = (block: string): Vars => new Map([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map(match => [match[1], match[2].trim().replace(/\s+/g, ' ')]))
// The light tokens are the first :root's; the dark ones the :root under prefers-color-scheme: dark.
const cssTokens = (css: string) => {
  const at = css.indexOf('@media (prefers-color-scheme: dark)')
  const start = css.indexOf(':root {')
  if (at < 0 || start < 0 || start > at) return { light: new Map() as Vars, dark: new Map() as Vars }
  const end = css.indexOf('\n}', at)
  return { light: varsOf(css.slice(start, at)), dark: varsOf(css.slice(at, end < 0 ? undefined : end)) }
}
const strings = (source: string) => [...source.matchAll(/'([^']*)'/g)].map(match => match[1])
const appPalette = (app: string) => strings(/^const PALETTE = \[([^\]]*)\]/m.exec(app)?.[1] ?? '')
const appGlyph = (app: string): Record<string, string> =>
  Object.fromEntries([...(/^const GLYPH = \{([^}]*)\}/m.exec(app)?.[1] ?? '').matchAll(/(\w+): '([^']*)'/g)].map(match => [match[1], match[2]]))
const appConstant = (app: string, name: string) => {
  const value = new RegExp(`^const ${name} = (-?[0-9.]+|'[^']*')`, 'm').exec(app)?.[1]
  return value === undefined ? undefined : value.startsWith("'") ? value.slice(1, -1) : value
}
const motionVersion = (motion: string) => /^\/\*! Motion (\d+\.\d+\.\d+) /.exec(motion)?.[1]

// `look.ts MS.fresh`, `app.js ARCHIVE_PX`, `motion.js version`: the value in the code, as text.
const constantOf = (name: string, look: Look, read: Read): string | undefined => {
  const [file = '', path = ''] = name.split(' ')
  if (file === 'look.ts') {
    const value = path.split('.').reduce<unknown>((at, key) => (at !== null && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), look)
    return typeof value === 'number' || typeof value === 'string' ? String(value) : undefined
  }
  if (file === 'app.js') return appConstant(read(FILES.app) ?? '', path)
  if (file === 'motion.js' && path === 'version') return motionVersion(read(FILES.motion) ?? '')
  return undefined
}

// ---- reading the doc ----

type Cell = { text: string; raw: string }
const unwrap = (raw: string) => {
  const trimmed = raw.trim()
  return /^`[^`]*`$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed
}
// The rows (header and rule left out) of every table after a `<!-- check: name -->` line.
export const tableOf = (doc: string, name: string): Cell[][] => {
  const lines = doc.split('\n')
  const rows: Cell[][] = []
  lines.forEach((line, at) => {
    if (line.trim() !== `<!-- check: ${name} -->`) return
    let row = at + 1
    while (row < lines.length && lines[row].trim() === '') row++
    for (let index = 0; row < lines.length && lines[row].trimStart().startsWith('|'); row++, index++) {
      if (index < 2) continue
      const cells = lines[row].trim().slice(1, -1).split('|')
      rows.push(cells.map(raw => ({ raw: raw.trim(), text: unwrap(raw) })))
    }
  })
  return rows
}
// A cell that lists several things: `a`, `b`, index.html.
const listOf = (cell: Cell | undefined) =>
  (cell?.raw ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '' && part !== '—')
    .map(part => ({ isKey: /^`[^`]*`$/.test(part), text: unwrap(part) }))
const isNone = (cell: Cell | undefined) => cell === undefined || cell.text === '—' || cell.text === ''

// ---- contrast (WCAG 2) ----

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
const isHex = (value: string | undefined): value is string => value !== undefined && /^#[0-9a-f]{6}$/i.test(value)

// ---- the fingerprint ----

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonical((value as Record<string, unknown>)[key])]),
    )
  return value
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 12)

// ---- the changelog ----

export type Entry = { version: string; date: string; changes: string[]; whys: string[]; fingerprint?: string; line: number }
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const compareVersions = (a: string, b: string) => {
  const [x, y] = [a, b].map(version => version.split('.').map(Number))
  for (let at = 0; at < 3; at++) if (x[at] !== y[at]) return x[at] - y[at]
  return 0
}

export const parseChangelog = (doc: string) => {
  const problems: string[] = []
  const header = /^Version: (.*)$/m.exec(doc)?.[1]?.trim()
  if (header === undefined) problems.push('DESIGN.md has no `Version:` line under its title')
  const lines = doc.split('\n')
  const start = lines.findIndex(line => /^## (\d+\. )?Changelog\s*$/.test(line))
  const entries: Entry[] = []
  if (start < 0) {
    problems.push('DESIGN.md has no `## Changelog` section')
    return { header, entries, problems }
  }
  let entry: Entry | undefined
  let isFenced = false
  for (let at = start + 1; at < lines.length; at++) {
    const line = lines[at].trimEnd()
    if (/^## /.test(line)) break
    if (line.startsWith('```')) isFenced = !isFenced
    if (isFenced || line.startsWith('```')) continue
    const where = `DESIGN.md line ${at + 1}`
    if (line.startsWith('### ')) {
      const match = /^### (\S+) — (\S+)$/.exec(line)
      if (!match) {
        problems.push(`${where}: a changelog heading is \`### <version> — <YYYY-MM-DD>\`, not \`${line}\``)
        entry = undefined
        continue
      }
      entry = { version: match[1], date: match[2], changes: [], whys: [], line: at + 1 }
      entries.push(entry)
      if (!SEMVER.test(entry.version)) problems.push(`${where}: ${entry.version} isn't a version (major.minor.patch)`)
      const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(entry.date)
      const day = date ? new Date(Date.UTC(+date[1], +date[2] - 1, +date[3])) : undefined
      if (!date || !day || day.getUTCMonth() !== +date[2] - 1 || day.getUTCDate() !== +date[3]) problems.push(`${where}: ${entry.date} isn't a date (YYYY-MM-DD)`)
      continue
    }
    if (!entry || line.trim() === '') continue
    const item = /^- (Change|Why):(.*)$/.exec(line)
    const print = /^Fingerprint:(.*)$/.exec(line)
    if (item) (item[1] === 'Change' ? entry.changes : entry.whys).push(item[2].trim())
    else if (print) {
      if (entry.fingerprint !== undefined) problems.push(`${where}: ${entry.version} has a second Fingerprint`)
      entry.fingerprint = print[1].trim()
    } else problems.push(`${where}: a changelog entry holds only \`- Change:\`, \`- Why:\` and \`Fingerprint:\` lines, not \`${line}\``)
  }
  if (entries.length === 0) problems.push('the changelog has no entries')
  for (const [at, item] of entries.entries()) {
    const where = `changelog ${item.version} (line ${item.line})`
    if (!item.changes.some(text => text !== '')) problems.push(`${where}: no \`- Change:\` line saying what changed`)
    if (!item.whys.some(text => text !== '')) problems.push(`${where}: no \`- Why:\` line giving the reason`)
    if (item.changes.includes('') || item.whys.includes('')) problems.push(`${where}: an empty Change: or Why: line`)
    const older = entries[at + 1]
    if (older && SEMVER.test(item.version) && SEMVER.test(older.version) && compareVersions(item.version, older.version) <= 0)
      problems.push(`${where}: versions go newest first, each higher than the one below; ${item.version} isn't above ${older.version}`)
  }
  const newest = entries[0]
  if (newest && header !== undefined && header !== newest.version) problems.push(`Version: says ${header}, but the newest changelog entry is ${newest.version}`)
  if (newest && newest.fingerprint === undefined) problems.push(`changelog ${newest.version}: the newest entry needs a \`Fingerprint:\` line`)
  return { header, entries, problems }
}

// ---- the check ----

export type Result = { problems: string[]; fingerprint: string; version?: string }

export const checkDesign = ({ look = LOOK as unknown as Look, read = readRepo, baseDoc }: { look?: Look; read?: Read; baseDoc?: string } = {}): Result => {
  const problems: string[] = []
  const doc = read(FILES.doc)
  if (doc === undefined) return { problems: [`${FILES.doc} is missing`], fingerprint: '' }
  const app = read(FILES.app) ?? ''
  const css = read(FILES.css) ?? ''
  const tokens = cssTokens(css)
  const palette = look.COLOUR.palette
  const names = palette.map(colour => colour.name)
  const roles = Object.fromEntries(Object.entries(look.COLOUR).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  const phoneGlyph = appGlyph(app)
  const table = (name: string) => {
    const rows = tableOf(doc, name)
    if (rows.length === 0) problems.push(`DESIGN.md has no \`<!-- check: ${name} -->\` table`)
    return rows
  }

  // The pane's palette against the phone's: the names in order in app.js, each one's values in style.css.
  const phoneNames = appPalette(app)
  if (phoneNames.join(' ') !== names.join(' ')) problems.push(`app.js PALETTE is [${phoneNames.join(', ')}], look.ts has [${names.join(', ')}]`)
  for (const colour of palette)
    for (const tone of ['light', 'dark'] as const) {
      const value = tokens[tone].get(colour.name)?.toLowerCase()
      if (value !== colour[tone]) problems.push(`style.css --${colour.name} (${tone}) is ${value ?? 'missing'}, look.ts has ${colour[tone]}`)
    }

  // Palette: name, dark, light, contrast on the phone's dark and light backgrounds, in look.ts order.
  const paletteRows = table('palette')
  if (paletteRows.map(row => row[0]?.text).join(' ') !== names.join(' '))
    problems.push(`DESIGN.md palette is [${paletteRows.map(row => row[0]?.text).join(', ')}], look.ts has [${names.join(', ')}]`)
  for (const row of paletteRows) {
    const colour = palette.find(candidate => candidate.name === row[0]?.text)
    if (!colour) continue
    if (row[1]?.text !== colour.dark) problems.push(`DESIGN.md palette ${colour.name} dark is ${row[1]?.text}, look.ts has ${colour.dark}`)
    if (row[2]?.text !== colour.light) problems.push(`DESIGN.md palette ${colour.name} light is ${row[2]?.text}, look.ts has ${colour.light}`)
    for (const [cell, tone] of [
      [row[3], 'dark'],
      [row[4], 'light'],
    ] as const) {
      const bg = tokens[tone].get('bg')
      if (!isHex(bg)) continue
      const ratio = contrast(colour[tone], bg)
      if (ratio < MIN_CONTRAST) problems.push(`palette ${colour.name} (${tone}) is ${ratio.toFixed(2)}:1 on --bg ${bg}, under ${MIN_CONTRAST}:1`)
      if (cell?.text !== `${ratio.toFixed(1)}:1`) problems.push(`DESIGN.md palette ${colour.name} on ${tone} bg says ${cell?.text}, it is ${ratio.toFixed(1)}:1`)
    }
  }

  // Colour roles: every theme-key role in look.ts COLOUR, with the phone token that plays it.
  const roleRows = table('roles')
  const docRoles = roleRows.map(row => row[0]?.text ?? '')
  for (const role of Object.keys(roles)) if (!docRoles.includes(role)) problems.push(`DESIGN.md colour roles miss \`${role}\` (look.ts COLOUR.${role})`)
  for (const row of roleRows) {
    const role = row[0]?.text ?? ''
    if (!(role in roles)) problems.push(`DESIGN.md colour role \`${role}\` isn't in look.ts COLOUR`)
    else if (row[1]?.text !== roles[role]) problems.push(`DESIGN.md colour role ${role} is \`${row[1]?.text}\`, look.ts has \`${roles[role]}\``)
    for (const token of listOf(row[2])) if (!tokens.light.has(token.text.replace(/^--/, ''))) problems.push(`DESIGN.md colour role ${role}: style.css has no ${token.text}`)
  }
  const ansiRows = table('ansi')
  if (ansiRows.map(row => row[1]?.text).join(' ') !== look.COLOUR.ansiPalette.join(' '))
    problems.push(`DESIGN.md 16-colour palette is [${ansiRows.map(row => row[1]?.text).join(', ')}], look.ts has [${look.COLOUR.ansiPalette.join(', ')}]`)
  if (look.COLOUR.ansiPalette.includes(RESERVED) || Object.values(roles).includes(RESERVED))
    problems.push(`look.ts COLOUR uses \`${RESERVED}\`: the engine draws hotkey digits in it, so nothing of ours may`)

  // Phone tokens: every custom property in style.css but the palette's, light and dark (— when the
  // dark theme keeps the light value).
  const tokenRows = table('tokens')
  const isPalette = (name: string) => names.includes(name)
  const docTokens = new Map(tokenRows.map(row => [row[0]?.text.replace(/^--/, '') ?? '', row]))
  for (const name of new Set([...tokens.light.keys(), ...tokens.dark.keys()]))
    if (!isPalette(name) && !docTokens.has(name)) problems.push(`DESIGN.md tokens miss --${name} (style.css)`)
  for (const [name, row] of docTokens) {
    if (!tokens.light.has(name) && !tokens.dark.has(name)) {
      problems.push(`DESIGN.md token --${name} isn't in style.css`)
      continue
    }
    if (row[1]?.text !== tokens.light.get(name)) problems.push(`DESIGN.md token --${name} light is ${row[1]?.text}, style.css has ${tokens.light.get(name) ?? 'none'}`)
    const dark = tokens.dark.get(name)
    if (isNone(row[2]) ? dark !== undefined : row[2]?.text !== dark) problems.push(`DESIGN.md token --${name} dark is ${row[2]?.text}, style.css has ${dark ?? '— (the light value)'}`)
  }

  // Contrast: text on its background in both themes, from the tokens.
  for (const row of table('contrast')) {
    const [text, on] = [row[0]?.text ?? '', row[1]?.text ?? '']
    for (const [cell, tone] of [
      [row[2], 'light'],
      [row[3], 'dark'],
    ] as const) {
      const valueOf = (token: string) => tokens[tone].get(token.replace(/^--/, '')) ?? tokens.light.get(token.replace(/^--/, ''))
      const [fg, bg] = [valueOf(text), valueOf(on)]
      if (!isHex(fg) || !isHex(bg)) {
        problems.push(`DESIGN.md contrast ${text} on ${on} (${tone}): both need a hex value in style.css`)
        continue
      }
      const ratio = contrast(fg, bg)
      if (ratio < MIN_CONTRAST) problems.push(`${text} on ${on} (${tone}) is ${ratio.toFixed(2)}:1, under ${MIN_CONTRAST}:1`)
      if (cell?.text !== `${ratio.toFixed(1)}:1`) problems.push(`DESIGN.md contrast ${text} on ${on} (${tone}) says ${cell?.text}, it is ${ratio.toFixed(1)}:1`)
    }
  }

  // Symbols: each glyph with the look.ts GLYPH keys (terminal) and app.js GLYPH keys or files (phone)
  // that draw it. Every key of both appears.
  const seen = { terminal: new Set<string>(), phone: new Set<string>() }
  for (const row of table('symbols')) {
    const glyph = row[0]?.text ?? ''
    for (const part of listOf(row[2])) {
      seen.terminal.add(part.text)
      if (look.GLYPH[part.text] !== glyph) problems.push(`DESIGN.md symbol ${glyph}: look.ts GLYPH.${part.text} is ${look.GLYPH[part.text] ?? 'missing'}`)
    }
    for (const part of listOf(row[3])) {
      if (part.isKey) {
        seen.phone.add(part.text)
        if (phoneGlyph[part.text] !== glyph) problems.push(`DESIGN.md symbol ${glyph}: app.js GLYPH.${part.text} is ${phoneGlyph[part.text] ?? 'missing'}`)
      } else if (!(read(SHORT[part.text] ?? part.text) ?? '').includes(glyph)) problems.push(`DESIGN.md symbol ${glyph}: ${part.text} doesn't draw it`)
    }
  }
  for (const key of Object.keys(look.GLYPH)) if (!seen.terminal.has(key)) problems.push(`DESIGN.md symbols miss look.ts GLYPH.${key} (${look.GLYPH[key]})`)
  for (const key of Object.keys(phoneGlyph)) if (!seen.phone.has(key)) problems.push(`DESIGN.md symbols miss app.js GLYPH.${key} (${phoneGlyph[key]})`)

  // Fixed copy: each string, word for word, in every file named beside it.
  const copy: string[] = []
  for (const row of table('copy')) {
    const text = row[0]?.text ?? ''
    copy.push(text)
    for (const file of listOf(row[1])) {
      const source = read(file.text)
      if (source === undefined) problems.push(`DESIGN.md copy “${text}”: no file ${file.text}`)
      else if (!source.includes(text)) problems.push(`DESIGN.md copy “${text}” isn't in ${file.text}`)
    }
  }

  // Numbers: motion, timings and terminal sizes, against the constant each row names.
  const constants: Record<string, string | undefined> = {}
  for (const row of table('constants')) {
    const name = row[0]?.text ?? ''
    const value = constantOf(name, look, read)
    constants[name] = value
    if (value === undefined) problems.push(`DESIGN.md constant \`${name}\` names nothing in the code`)
    else if (row[1]?.text !== value) problems.push(`DESIGN.md constant ${name} is ${row[1]?.text}, the code has ${value}`)
  }

  const fingerprint = hash({
    colour: look.COLOUR,
    glyph: look.GLYPH,
    phone: { palette: phoneNames, glyph: phoneGlyph, light: Object.fromEntries(tokens.light), dark: Object.fromEntries(tokens.dark) },
    constants,
    copy: [...copy].sort(),
  })

  const log = parseChangelog(doc)
  problems.push(...log.problems)
  const newest = log.entries[0]
  if (newest?.fingerprint !== undefined && newest.fingerprint !== fingerprint)
    problems.push(
      `Design values changed: the fingerprint is ${fingerprint}, the newest changelog entry (${newest.version}) says ${newest.fingerprint}. ` +
        `Bump \`Version:\`, add a changelog entry with \`- Change:\` and \`- Why:\` lines, and set its \`Fingerprint:\` to ${fingerprint}.`,
    )

  if (baseDoc !== undefined) {
    const base = parseChangelog(baseDoc).entries
    const versions = new Set(log.entries.map(item => item.version))
    for (const item of base) if (!versions.has(item.version)) problems.push(`changelog ${item.version} is in the base but gone here: entries are never removed`)
    const last = base[0]
    if (last && newest && last.fingerprint !== fingerprint && SEMVER.test(last.version) && SEMVER.test(newest.version) && compareVersions(newest.version, last.version) <= 0)
      problems.push(`Design values differ from the base's (${last.version}), so they need a new version above ${last.version} with its own Change: and Why:, not ${newest.version}.`)
  }
  return { problems, fingerprint, version: newest?.version }
}

// The design doc at a git ref, or undefined when the ref or the file isn't there.
export const docAt = (ref: string) => {
  const result = Bun.spawnSync(['git', 'show', `${ref}:${FILES.doc}`], { cwd: new URL('.', ROOT).pathname, stderr: 'ignore' })
  return result.exitCode === 0 ? result.stdout.toString() : undefined
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--base')
  // An empty ref (no commit before a branch's first push) compares with nothing.
  const ref = at >= 0 ? args[at + 1] || undefined : undefined
  if (at >= 0 && args[at + 1] === undefined) {
    console.log('--base needs a git ref')
    process.exit(2)
  }
  const baseDoc = ref ? docAt(ref) : undefined
  const result = checkDesign({ baseDoc })
  if (args.includes('--fingerprint')) {
    console.log(result.fingerprint)
    process.exit(0)
  }
  for (const problem of result.problems) console.log(problem)
  if (result.problems.length > 0) process.exit(1)
  const history = ref === undefined ? '' : baseDoc === undefined ? `, no ${FILES.doc} at ${ref} to compare` : `, history kept against ${ref}`
  console.log(`design ok: ${result.version}, fingerprint ${result.fingerprint}${history}`)
}
