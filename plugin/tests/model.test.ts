import { describe, expect, test } from 'claude-code/testing'

import type { Note, NoteProject } from '../types'
import type { Ctx, Focus, Line } from '../src/model'
import { CHORD, COLOUR, TEXT, WIDTH, colourOf, toneOf } from '../src/ui/look'
import {
  ageOf,
  bundleText,
  canEditInline,
  carriedIn,
  cells,
  dispatchText,
  fitFooter,
  fitOneLine,
  fitStatuses,
  footerPairs,
  footerRows,
  freshPane,
  fromField,
  keysFor,
  labelsOf,
  linesOf,
  matchOf,
  ownKeys,
  pageOf,
  parseQuery,
  sheetLines,
  toField,
  uniqueKeys,
  wrap,
} from '../src/model'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const CC: NoteProject = { key: 'github.com/me/cc', name: 'cc', path: '/home/me/Work/cc' }
const INFRA: NoteProject = { key: 'github.com/me/infra', name: 'infra', path: '/home/me/code/infra' }
const API_A: NoteProject = { key: 'github.com/me/api', name: 'api', path: '/home/me/Work/api' }
const API_B: NoteProject = { key: 'github.com/work/api', name: 'api', path: '/home/me/work/api' }

const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

let serial = 0
const note = (text: string, project: NoteProject | null, minutes: number, extra: Partial<Note> = {}): Note => ({
  id: `n${String(++serial).padStart(3, '0')}`,
  status: 'open',
  by: 'you',
  created: ago(minutes),
  updated: ago(minutes),
  origin: 'office',
  project,
  context: {},
  sentAt: null,
  deleted: false,
  text,
  extra: [],
  ...extra,
})

const ctxOf = (projects: NoteProject[] = [CC, INFRA]): Ctx => ({ now: NOW, current: CC, labels: labelsOf(projects) })

describe('model', () => {
  test('a prompt carries each fill it holds; one held only inside a longer fill is not carried', () => {
    const texts = ['fix typo', 'fix typo in README', 'rename the store']
    expect(carriedIn('fix typo in README', texts)).toEqual(['fix typo in README'])
    expect(carriedIn('fix typo\n\nfix typo in README', texts)).toEqual(['fix typo', 'fix typo in README'])
    expect(carriedIn('rename the store\n\nfix typo', texts)).toEqual(['fix typo', 'rename the store'])
    expect(carriedIn('nothing here', texts)).toEqual([])
  })

  test('ages read now, minutes, hours, days, weeks, years', () => {
    expect([0, 12, 180, 60 * 48, 60 * 24 * 20, 60 * 24 * 400].map(minutes => ageOf(ago(minutes), NOW))).toEqual(['now', '12m', '3h', '2d', '2w', '1y'])
  })

  test('project labels are basenames, with parents only where two share one', () => {
    const labels = labelsOf([CC, INFRA, API_A, API_B])
    expect(labels.get(CC.key)).toBe('cc')
    expect(labels.get(API_A.key)).toBe('me/api')
    expect(labels.get(API_B.key)).toBe('work/api')
  })

  test('query tokens and matching', () => {
    expect(parseQuery('cache @infra is:sent by:claude')).toEqual({ words: 'cache', project: 'infra', status: 'sent', by: 'claude' })
    expect(matchOf('check the cache test', 'cache')).toEqual([10, 11, 12, 13, 14])
    expect(matchOf('check the cache test', 'zz')).toBeUndefined()
    expect(matchOf('dark/light contrast check on the pane', 'cache')).toBeUndefined()
    expect(matchOf('the cachetest', 'cht')).toBeDefined()
  })

  test('the pane shows this project when empty, and typing keeps the groups, hiding those with no match', () => {
    const notes = [note('flaky cache test', CC, 10), note('cache metric', INFRA, 20), note('rename helpers', CC, 5), note('api docs', API_A, 1)]
    const keys = (lines: Line[]) => lines.map(line => (line.kind === 'note' ? line.note.text : line.key))
    const ctx = ctxOf([CC, INFRA, API_A])
    expect(keys(linesOf(ctx, freshPane(), notes, []))).toEqual([`group:${CC.key}`, 'rename helpers', 'flaky cache test'])
    const typing = linesOf(ctx, { ...freshPane(), query: 'cache', scope: 'all' }, notes, [])
    expect(keys(typing)).toEqual([`group:${CC.key}`, 'flaky cache test', `group:${INFRA.key}`, 'cache metric'])
  })

  test('the list groups proposed, this project, others by activity, then unfiled; empty and folded groups', () => {
    const notes = [
      note('old infra', INFRA, 600),
      note('api thing', API_A, 30),
      note('phone note', null, 1, { by: 'phone' }),
      note('mine', CC, 100),
      note('from claude', CC, 2, { status: 'proposed', by: 'claude' }),
      note('sent one', CC, 3, { status: 'sent' }),
    ]
    const ctx = ctxOf([CC, INFRA, API_A])
    const pane = { ...freshPane(), scope: 'all' as const }
    const keys = (lines: Line[]) => lines.map(line => (line.kind === 'note' ? line.note.text : line.key))
    expect(keys(linesOf(ctx, pane, notes, []))).toEqual([
      'group:proposed',
      'from claude',
      `group:${CC.key}`,
      'mine',
      `group:${API_A.key}`,
      'api thing',
      `group:${INFRA.key}`,
      'old infra',
      'group:unfiled',
      'phone note',
    ])
    const folded = linesOf(ctx, { ...pane, folded: [INFRA.key], history: true }, notes, [])
    expect(keys(folded)).toContain('sent one')
    expect(keys(folded).indexOf('sent one')).toBe(keys(folded).indexOf('mine') + 1)
    expect(keys(folded)).not.toContain('old infra')
    expect(keys(folded)).toContain(`group:${INFRA.key}`)
    const filtered = linesOf(ctx, { ...pane, query: 'api' }, notes, [])
    expect(keys(filtered)).toEqual([`group:${API_A.key}`, 'api thing'])
    // A search shows the matches of a folded group.
    expect(keys(linesOf(ctx, { ...pane, query: 'old', folded: [INFRA.key] }, notes, []))).toEqual([`group:${INFRA.key}`, 'old infra'])
    // A search leaves proposed notes out, even ones that match.
    expect(keys(linesOf(ctx, { ...pane, query: 'claude' }, notes, []))).toEqual([])
  })

  test('paging keeps the cursor in the window and numbers at most nine rows', () => {
    const lines = Array.from({ length: 30 }, (_, i): Line => ({ kind: 'note', key: `k${i}`, note: note(`n${i}`, CC, i), group: CC.key, hits: [] }))
    const top = pageOf(lines, 0, null, 12)
    expect(top.lines.length).toBe(11)
    expect(top.below).toBe(19)
    expect([...top.numbers.values()]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const down = pageOf(lines, 0, 'k20', 12)
    expect(down.lines.map(line => line.key)).toContain('k20')
    expect(down.above).toBeGreaterThan(0)
    expect(down.lines.length).toBe(10)
    const fits = pageOf(lines.slice(0, 5), 3, null, 12)
    expect(fits.offset).toBe(0)
    expect(fits.lines.length).toBe(5)
  })

  test('the footer only advertises keys that are mounted, and never letters with the search field focused', () => {
    const open = note('n', CC, 1)
    const focuses: Focus[] = [
      { kind: 'search', hasResults: true, hasQuery: false },
      { kind: 'search', hasResults: false, hasQuery: true },
      { kind: 'line', line: { kind: 'note', key: open.id, note: open, group: CC.key, hits: [] }, picks: 0 },
      { kind: 'line', line: { kind: 'note', key: open.id, note: open, group: CC.key, hits: [] }, picks: 2 },
      { kind: 'line', line: { kind: 'note', key: 'h', note: { ...open, status: 'archived' }, group: CC.key, hits: [] }, picks: 0 },
      { kind: 'line', line: { kind: 'group', key: 'group:x', group: 'x', project: CC, isFolded: false, count: 0 }, picks: 0 },
      { kind: 'capture' },
      { kind: 'edit' },
      { kind: 'bundle' },
      { kind: 'empty' },
    ]
    for (const focus of focuses) {
      const keys = uniqueKeys(keysFor(focus))
      for (const key of keys) {
        if (key.shown && /^[a-z0-9]$/.test(key.shown[0])) expect(key.hotkey).toBe(key.shown[0])
        if (key.shown?.[0].startsWith('ctrl+')) expect(key.chord).toBeDefined()
      }
      if (focus.kind === 'search') expect(keys.some(key => key.hotkey !== undefined)).toBe(false)
    }
    const history = footerPairs(keysFor(focuses[4] as Focus)).map(([key]) => key)
    expect(history).toEqual(['u', 'h', 'z', 'f', 'i'])
    const picked = footerPairs(keysFor(focuses[3] as Focus)).map(([key]) => key)
    expect(picked.slice(0, 3)).toEqual(['b', 'v', 'x'])
    // Nothing picked, the note's own actions take the four footer places, archive among them, and
    // move and copy come next.
    const row = footerPairs(keysFor(focuses[2] as Focus)).map(([key]) => key)
    expect(row.slice(0, 6)).toEqual(['t', 's', 'e', 'd', 'm', 'y'])
    expect(footerPairs(keysFor({ kind: 'sheet', page: 0, pages: 1, lead: [] })).map(([key]) => key)).toEqual(['i'])
    expect(footerPairs(keysFor({ kind: 'sheet', page: 1, pages: 3, lead: [] }))).toEqual([
      ['i', 'close keys'],
      ['j', 'more 2/3'],
    ])
  })

  test('a text field, which takes i, shows the key sheet as its chord; everywhere else the chord is answered unshown', () => {
    const open = note('n', CC, 1)
    const fields: Focus[] = [
      { kind: 'search', hasResults: true, hasQuery: false },
      { kind: 'search', hasResults: false, hasQuery: true },
      { kind: 'empty' },
      { kind: 'capture' },
      { kind: 'edit' },
    ]
    for (const focus of fields) {
      const pairs = footerPairs(keysFor(focus))
      expect(pairs.at(-1)).toEqual([CHORD.keys.keys, 'keys'])
      expect(pairs.some(([key]) => key === 'i')).toBe(false)
    }
    const rows: Focus[] = [
      { kind: 'line', line: { kind: 'note', key: open.id, note: open, group: CC.key, hits: [] }, picks: 0 },
      { kind: 'line', line: { kind: 'group', key: 'group:x', group: 'x', project: CC, isFolded: false, count: 0 }, picks: 0 },
      { kind: 'line', line: { kind: 'problem', key: 'problem', count: 1 }, picks: 0 },
      { kind: 'sheet', page: 0, pages: 1, lead: [] },
      { kind: 'bundle' },
      { kind: 'move' },
    ]
    for (const focus of rows) {
      const chorded = uniqueKeys(keysFor(focus)).find(key => key.chord === CHORD.keys.action)
      expect(chorded?.action).toBe('keys')
      expect(chorded?.shown).toBeUndefined()
    }
    expect(TEXT.keySheet.map(([key]) => key)).toEqual(expect.arrayContaining([CHORD.keys.keys, 'ctrl+x tab']))
  })

  test("the key sheet leads with a row's own keys, in its footer's order", () => {
    const open = note('n', CC, 1)
    const row: Focus = { kind: 'line', line: { kind: 'note', key: open.id, note: open, group: CC.key, hits: [] }, picks: 0 }
    const picked: Focus = { kind: 'line', line: { kind: 'note', key: open.id, note: open, group: CC.key, hits: [] }, picks: 2 }
    const group: Focus = { kind: 'line', line: { kind: 'group', key: 'group:x', group: 'x', project: CC, isFolded: false, count: 0 }, picks: 0 }
    expect(ownKeys(keysFor(row))).toEqual(['t', 's', 'e', 'd', 'm', 'y', 'v'])
    expect(ownKeys(keysFor(picked))).toEqual(['b', 'v', 'x', 't'])
    expect(ownKeys(keysFor(group))).toEqual([])
    const sheet = sheetLines(TEXT.keySheet, ownKeys(keysFor(row)))
    expect(sheet.slice(0, 8).map(([key]) => key)).toEqual(['⏎ / t', 's', 'e', 'd / u', 'm', 'y', 'v / x', '↑ ↓ j k'])
    expect(sheet).toHaveLength(TEXT.keySheet.length)
    expect(new Set(sheet).size).toBe(TEXT.keySheet.length)
    expect(sheetLines(TEXT.keySheet, [])).toEqual(TEXT.keySheet)
    const proposal = note('p', CC, 1, { status: 'proposed', by: 'claude' })
    const proposed: Focus = { kind: 'line', line: { kind: 'note', key: proposal.id, note: proposal, group: 'proposed', hits: [] }, picks: 0 }
    expect(ownKeys(keysFor(proposed))).toEqual(['a', 'r', 't'])
    expect(
      sheetLines(TEXT.keySheet, ownKeys(keysFor(proposed)))
        .slice(0, 2)
        .map(([key]) => key),
    ).toEqual(['a / r', '⏎ / t'])
    for (const [key, label] of TEXT.keySheet) expect(cells(key) <= WIDTH.sheetKey && cells(label) <= WIDTH.keySheet - 4 - WIDTH.sheetKey).toBe(true)
  })

  test("a folded group's footer offers to unfold it", () => {
    const group = (isFolded: boolean): Focus => ({
      kind: 'line',
      line: { kind: 'group', key: 'group:x', group: 'x', project: CC, isFolded, count: 0 },
      picks: 0,
    })
    expect(footerPairs(keysFor(group(false)))[0]).toEqual(['z', 'fold'])
    expect(footerPairs(keysFor(group(true)))[0]).toEqual(['z', 'unfold'])
  })

  test('wrapping counts terminal cells: wide characters take two and are never split', () => {
    expect(wrap('one two three', 7)).toEqual(['one two', 'three'])
    const wide = wrap('日本語のテキスト', 6)
    expect(wide).toEqual(['日本語', 'のテキ', 'スト'])
    for (const line of wrap('🎉🎉🎉 party time 日本語', 5)) expect(cells(line)).toBeLessThanOrEqual(5)
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b'])
    // ❤️ is a narrow heart and VS16: two cells, so nine to a line of 18.
    expect(wrap('❤️'.repeat(18), 18)).toEqual(['❤️'.repeat(9), '❤️'.repeat(9)])
  })

  test("a long status keeps its queued count: the problem's text is cut instead", () => {
    const missing = 'mirror folder missing: /home/me/Documents/a very long vault path/ostrakon/notes · 3 queued'
    const [fitted] = fitStatuses([[missing, 'w']], 30)
    expect(fitted?.[0].startsWith('mirror folder')).toBe(true)
    expect(fitted?.[0].endsWith('… · 3 queued')).toBe(true)
    expect(cells(fitted?.[0] ?? '')).toBeLessThanOrEqual(30)
    // Too narrow for the count and some of the problem, it's a plain cut.
    expect(fitStatuses([[missing, 'w']], 14)[0]?.[0].endsWith('queued')).toBe(false)
  })

  test('footer statuses are cut to their room, the last ones first', () => {
    const offline = 'hub offline · 12 queued · mirror unavailable'
    expect(
      fitStatuses(
        [
          ['2 picked', 'a'],
          [offline, 'w'],
        ],
        60,
      ),
    ).toEqual([
      ['2 picked', 'a'],
      [offline, 'w'],
    ])
    const cut = fitStatuses(
      [
        ['2 picked', 'a'],
        [offline, 'w'],
      ],
      30,
    )
    expect(cut.map(([text]) => cells(text)).reduce((sum, size) => sum + size + 2, -2)).toBeLessThanOrEqual(30)
    expect(cut[0]?.[0]).toBe('2 picked')
    expect(cut[1]?.[0].endsWith('…')).toBe(true)
    expect(
      fitStatuses(
        [
          ['2 picked', 'a'],
          [offline, 'w'],
        ],
        9,
      ),
    ).toEqual([['2 picked', 'a']])
  })

  test('inline footers drop pairs from the right and keep i keys', () => {
    const pairs: [string, string][] = [
      ['v', 'pick'],
      ['t', 'to prompt'],
      ['s', 'send'],
      ['e', 'edit'],
      ['d', 'archive'],
      ['i', 'keys'],
    ]
    expect(fitOneLine(pairs, '', 30).map(([key]) => key)).toEqual(['v', 't', 'i'])
    // In a text field the pair is the chord's, kept the same way.
    const field: [string, string][] = [
      ['ctrl+s', 'scope'],
      ['ctrl+n', 'new'],
      ['ctrl+q', 'close'],
      ['ctrl+x i', 'keys'],
    ]
    expect(fitOneLine(field, '', 40).map(([key]) => key)).toEqual(['ctrl+s', 'ctrl+n', 'ctrl+x i'])
  })

  test('the footer fits as many pairs as the width allows, the legend before all but the first four', () => {
    const open = note('n', CC, 1)
    const row: Focus = { kind: 'line', line: { kind: 'note', key: open.id, note: open, group: CC.key, hits: [] }, picks: 0 }
    const pairs = footerPairs(keysFor(row))
    const legend: [string, string] = [TEXT.legend, '']
    const shown = (width: number, withLegend?: [string, string]) => fitFooter(pairs, withLegend, '', width, WIDTH.footerPairs).map(([key]) => key)
    // `t to prompt  s send  e edit  d archive  i keys` is 46 cells, and each pair after it 8 more.
    expect(shown(46)).toEqual(['t', 's', 'e', 'd', 'i'])
    expect(shown(45)).toEqual(['t', 's', 'e', 'i'])
    expect(shown(62)).toEqual(['t', 's', 'e', 'd', 'm', 'y', 'i'])
    expect(shown(100)).toEqual(['t', 's', 'e', 'd', 'm', 'y', 'v', 'z', 'h', 'i'])
    // Wider never shows fewer, and every width keeps the line whole.
    for (let width = 10; width <= 120; width += 1) {
      const fitted = fitFooter(pairs, legend, '2 picked', width, WIDTH.footerPairs)
      expect(footerRows(fitted, '2 picked', width) === 1 || fitted.length === 1).toBe(true)
      expect(fitted.length).toBeGreaterThanOrEqual(fitFooter(pairs, legend, '2 picked', width - 1, WIDTH.footerPairs).length)
    }
    // The legend goes after the first four, before the rest, and is drawn last but for `i keys`.
    expect(shown(61, legend)).toEqual(['t', 's', 'e', 'd', TEXT.legend, 'i'])
    expect(shown(77, legend)).toEqual(['t', 's', 'e', 'd', 'm', 'y', TEXT.legend, 'i'])
    expect(shown(60, legend)).toEqual(['t', 's', 'e', 'd', 'i'])
  })

  test('dispatch names other projects, and edit fields round-trip newlines', () => {
    const ctx = ctxOf()
    const here = note('fix it', CC, 1)
    const there = note('rotate keys', INFRA, 1)
    expect(dispatchText(ctx, here)).toBe('fix it')
    expect(dispatchText(ctx, there)).toBe('[infra] rotate keys')
    expect(bundleText(ctx, [here, there])).toBe('Please look at these notes from my ostrakon:\n\n- fix it\n- [infra] rotate keys')
    expect(fromField(toField('one\ntwo'))).toBe('one\ntwo')
    expect(canEditInline('has ↵ already')).toBe(false)
  })
})

describe('project colours', () => {
  test('a project keeps its colour, the current one takes the accent and unfiled is grey', () => {
    for (const tone of ['dark', 'light', 'ansi'] as const) {
      expect(colourOf(INFRA.key, CC.key, tone)).toBe(colourOf(INFRA.key, CC.key, tone))
      expect(colourOf(CC.key, CC.key, tone)).toBe(COLOUR.accent)
      expect(colourOf(null, CC.key, tone)).toBe(COLOUR.unfiled)
    }
  })

  test('the theme picks the palette: hex for dark and light, theme keys for 16 colours', () => {
    // The phone hashes the same way, so these hold there too.
    expect(colourOf('github.com/me/infra', CC.key, 'dark')).toBe('#b08cf5')
    expect(colourOf('github.com/me/infra', CC.key, 'light')).toBe('#6f3fd1')
    expect(colourOf('github.com/me/infra', CC.key, 'ansi')).toBe('planMode')
    const keys = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(name => `github.com/me/${name}`)
    expect(new Set(keys.map(key => colourOf(key, CC.key, 'dark'))).size).toBeGreaterThan(4)
    for (const key of keys) expect(colourOf(key, CC.key, 'ansi')).not.toBe('suggestion')
    expect(['dark', 'dark-daltonized', 'light', 'light-daltonized', 'dark-ansi', 'light-ansi', 'nonsense'].map(toneOf)).toEqual([
      'dark',
      'dark',
      'light',
      'light',
      'ansi',
      'ansi',
      'dark',
    ])
  })
})
