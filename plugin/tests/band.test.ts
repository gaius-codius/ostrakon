import { describe, expect, test } from 'claude-code/testing'

import type { Note, NoteProject } from '../types'
import { cells, cut } from '../src/model'
import { harvestOf, openerOf, pocketOf, wordCut } from '../src/ui/band'
import { TEXT, WIDTH } from '../src/ui/look'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const CC: NoteProject = { key: 'github.com/me/cc', name: 'cc', path: '/home/me/Work/cc' }
const INFRA: NoteProject = { key: 'github.com/me/infra', name: 'infra', path: '/home/me/code/infra' }

let serial = 0
const note = (text: string, minutes: number, extra: Partial<Note> = {}): Note => {
  const stamp = new Date(NOW - minutes * 60_000).toISOString()
  return {
    id: `n${String(++serial).padStart(3, '0')}`,
    status: 'open',
    by: 'you',
    created: stamp,
    updated: stamp,
    origin: 'office',
    project: CC,
    context: {},
    sentAt: null,
    deleted: false,
    text,
    extra: [],
    ...extra,
  }
}

const LONG = 'a very long note text that goes on and on'
const WIDE = 200
const OPENER = openerOf('cc')
const GAP = 3

// Terminal cells counted here on purpose, apart from the code under test: wide characters are 2.
const cellsIn = (text: string) =>
  [...text].reduce((sum, char) => sum + (/[\u1100-\u115f\u3000-\u9fff\uff00-\uff60]/.test(char) || (char.codePointAt(0) ?? 0) >= 0x1f300 ? 2 : 1), 0)

describe('pocketOf', () => {
  test('only open notes of the project, newest updated first, deleted and other states left out', () => {
    const old = note('old', 50)
    const fresh = note('fresh', 1)
    const mid = note('mid', 10)
    const notes = [
      old,
      fresh,
      mid,
      note('elsewhere', 2, { project: INFRA }),
      note('unfiled', 2, { project: null }),
      note('sent already', 3, { status: 'sent' }),
      note('archived', 3, { status: 'archived' }),
      note('proposed', 3, { status: 'proposed' }),
      note('gone', 3, { deleted: true }),
    ]
    const pocket = pocketOf(notes, CC.key, 5, WIDE, OPENER)
    expect(pocket.chips.map(chip => chip.id)).toEqual([fresh.id, mid.id, old.id])
    expect(pocket.chips.map(chip => chip.n)).toEqual([1, 2, 3])
    expect(pocket.more).toBe(0)
  })

  test('the max caps the chips and the rest count in more, never above nine chips', () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`n${i}`, i))
    expect(pocketOf(notes, CC.key, 3, WIDE, OPENER)).toMatchObject({ more: 9 })
    expect(pocketOf(notes, CC.key, 3, WIDE, OPENER).chips).toHaveLength(3)
    const capped = pocketOf(notes, CC.key, 20, WIDE, OPENER)
    expect(capped.chips).toHaveLength(9)
    expect(capped.more).toBe(3)
  })

  test("labels are cut to 24 columns at a word, with an ellipsis; Claude's notes spend two of them on the diamond", () => {
    const pocket = pocketOf([note(LONG, 1), note(LONG, 2, { by: 'claude' }), note('short', 3)], CC.key, 5, WIDE, OPENER)
    expect(pocket.chips.map(chip => chip.label)).toEqual(['a very long note text…', '◆ a very long note text…', 'short'])
    for (const chip of pocket.chips) expect(cellsIn(chip.label)).toBeLessThanOrEqual(WIDTH.chip)
  })

  test('a word cut keeps at least chipMin cells, else cuts mid-word', () => {
    expect(wordCut('check why the cache test is flaky', 24, 10)).toBe('check why the cache…')
    // The hard cut already ends on a word: kept as it is.
    expect(wordCut('a very long note text that goes', 22, 10)).toBe('a very long note text…')
    // The last space would leave `a…`: too short, so mid-word.
    expect(wordCut('a supercalifragilisticexpialidocious', 24, 10)).toBe('a supercalifragilistice…')
    expect(wordCut('nospacesatallinthislongword', 12, 10)).toBe('nospacesata…')
    expect(wordCut('fits as it is', 24, 10)).toBe('fits as it is')
  })

  test('wide characters count two cells and are never cut in half', () => {
    const cjk = '日本語のメモをここに書いておきます'
    const emoji = '😀'.repeat(13)
    const labels = pocketOf([note(cjk, 1), note(emoji, 2)], CC.key, 5, WIDE, OPENER).chips.map(chip => chip.label)
    // Eleven wide characters and the ellipsis are 23 cells; a twelfth would make 25.
    expect(labels).toEqual(['日本語のメモをここに書…', `${'😀'.repeat(11)}…`])
    for (const label of labels) expect(cellsIn(label)).toBeLessThanOrEqual(WIDTH.chip)
  })

  test("a note's lines run together in its label", () => {
    expect(pocketOf([note('first\n  second', 1)], CC.key, 5, WIDE, OPENER).chips[0]?.label).toBe('first second')
  })

  test('at narrow widths labels shorten down to 10 before any chip drops into more', () => {
    const notes = [note(LONG, 1), note(LONG, 2), note(LONG, 3)]
    // The opener (4) and three chips of `a very long note…` (17, cut at a word) fit 75; at 22 they would need 88.
    const shortened = pocketOf(notes, CC.key, 5, 75, OPENER)
    expect(shortened.chips).toHaveLength(3)
    expect(shortened.more).toBe(0)
    expect(shortened.chips.map(chip => chip.label)).toEqual(Array(3).fill('a very long note…'))
    // At 10 columns three chips need 52, so one drops and the other two grow back to fill.
    const dropped = pocketOf(notes, CC.key, 5, 50, OPENER)
    expect(dropped.chips).toHaveLength(2)
    expect(dropped.more).toBe(1)
    expect(dropped.chips.map(chip => chip.label)).toEqual(['a very long…', 'a very long…'])
  })

  test('the opener and +N are budgeted: the drawn row never exceeds the columns', () => {
    const notes = [
      note(LONG, 1),
      note('日本語のメモをここに書いておきます', 2),
      note(LONG, 3, { by: 'claude' }),
      ...Array.from({ length: 6 }, (_, i) => note(`${LONG} ${i}`, 4 + i, { by: i % 2 === 0 ? 'claude' : 'you' })),
    ]
    const opener = openerOf('a-long-project-name')
    for (const columns of [20, 30, 45, 60, 80, 100, 120, 160]) {
      const { chips, more } = pocketOf(notes, CC.key, 9, columns, opener)
      // The opener, then each Button's `n: label` (3 cells and the label's) and `+N`, 3 apart.
      const drawn = [opener, ...chips.map(chip => `;${chip.n} ${chip.label}`), ...(more > 0 ? [`+${more}`] : [])]
      const width = drawn.reduce((sum, text) => sum + cellsIn(text), 0) + GAP * (drawn.length - 1)
      expect(chips.length + more).toBe(9)
      if (chips.length > 0) expect(width).toBeLessThanOrEqual(columns)
    }
  })

  test('the harvest row stays one line within the columns, with chips or without', () => {
    const proposals = Array.from({ length: 12 }, (_, i) => note(`${LONG} ${i}`, i, { by: 'claude', status: 'proposed' }))
    for (const columns of [60, 100, 160]) expect(harvestOf(proposals.slice(0, 5), columns, OPENER).chips.length).toBeGreaterThan(0)
    // Down to `✎ +12 ;0 keep all`, the narrowest the row gets.
    const opener = openerOf('ostrakon')
    for (const count of [1, 5, 12]) {
      for (let columns = 17; columns <= 160; columns++) {
        const { chips, more, title, gap, opener: shown } = harvestOf(proposals.slice(0, count), columns, opener)
        const drawn = [shown, title, ...chips.map(chip => `;${chip.n} ${chip.label}`), ...(more > 0 ? [`+${more}`] : []), `;0 ${TEXT.keepAll}`].filter(
          text => text !== '',
        )
        const width = drawn.reduce((sum, text) => sum + cellsIn(text), 0) + gap * (drawn.length - 1)
        expect(width).toBeLessThanOrEqual(columns)
      }
    }
  })

  test("a pocketMax that isn't a number shows no chips rather than throwing", () => {
    expect(pocketOf([note('x', 1)], CC.key, Number.NaN, WIDE, OPENER)).toEqual({ chips: [], more: 1 })
  })
  test('a row too narrow for even one chip shows none and counts them all in more', () => {
    expect(pocketOf([note('x', 1), note('y', 2)], CC.key, 5, 8, OPENER)).toEqual({ chips: [], more: 2 })
  })

  test('no notes, no chips', () => {
    expect(pocketOf([], CC.key, 5, WIDE, OPENER)).toEqual({ chips: [], more: 0 })
    expect(pocketOf([note('elsewhere', 1, { project: INFRA })], CC.key, 5, WIDE, OPENER)).toEqual({ chips: [], more: 0 })
  })

  test('harvest chips carry no diamond and shrink to 10 before proposals drop into +N', () => {
    const proposals = [1, 2, 3, 4].map(i => note(`${LONG} ${i}`, i, { by: 'claude', status: 'proposed' }))
    const roomy = harvestOf(proposals, WIDE, OPENER)
    expect(roomy.more).toBe(0)
    expect(roomy.chips.map(chip => chip.label)).toEqual(proposals.map(proposal => `${proposal.text.slice(0, 21)}…`))
    // The opener, the title and `;0 keep all` take 37 of the 76 columns; two chips and `+2` fit the rest.
    const narrow = harvestOf(proposals, 76, OPENER)
    expect(narrow.chips).toHaveLength(2)
    expect(narrow.more).toBe(2)
    expect(narrow.chips.every(chip => !chip.label.includes('◆') && chip.label.length >= 10)).toBe(true)
  })

  test('a harvest without room for a chip beside the title falls back to the short title', () => {
    const harvest = harvestOf([note('x', 1, { status: 'proposed' }), note('y', 2, { status: 'proposed' })], 36, OPENER)
    expect(harvest.title).toBe('◆')
    expect(harvest.chips.map(chip => chip.label)).toEqual(['x', 'y'])
    expect(harvestOf([note('x', 1, { status: 'proposed' })], 80, OPENER).title).toBe('◆ from this turn')
  })

  test('a harvest too narrow for any chip counts them all in more and closes up to fit: one apart, then no project, then no ◆', () => {
    const one = [note('x', 1, { status: 'proposed' })]
    const opener = openerOf('ostrakon')
    // `✎ ostrakon   ◆   +1   ;0 keep all` takes 33.
    expect(harvestOf(one, 33, opener)).toMatchObject({ chips: [], more: 1, title: '◆', opener: '✎ ostrakon', gap: 3 })
    expect(harvestOf(one, 30, opener)).toMatchObject({ chips: [], more: 1, title: '◆', opener: '✎ ostrakon', gap: 1 })
    expect(harvestOf(one, 26, opener)).toMatchObject({ chips: [], more: 1, title: '◆', opener: '✎', gap: 1 })
    expect(harvestOf(one, 17, opener)).toMatchObject({ chips: [], more: 1, title: '', opener: '✎', gap: 1 })
    expect(harvestOf(one, 21, OPENER)).toMatchObject({ chips: [], more: 1, title: '◆', opener: '✎ cc', gap: 1 })
  })

  test('cells count grapheme clusters: ZWJ sequences and flags are 2, combining marks 0, wide brackets 2', () => {
    expect(cells('👩‍💻')).toBe(2)
    expect(cells('🇦🇺')).toBe(2)
    expect(cells('e\u1ab0')).toBe(1)
    expect(cells('\u2329')).toBe(2)
    expect(cells('ab')).toBe(2)
  })

  test('a narrow character drawn as emoji, by VS16 or a keycap, is 2; with VS15 or alone it stays 1', () => {
    expect(cells('❤️')).toBe(2)
    expect(cells('☀️')).toBe(2)
    expect(cells('1️⃣')).toBe(2)
    expect(cells('#️⃣')).toBe(2)
    expect(cells('❤')).toBe(1)
    expect(cells('❤︎')).toBe(1)
    expect(cells('a❤️b')).toBe(4)
  })

  test('a cut never splits a ZWJ sequence, a flag or a character and its marks', () => {
    expect(cut('👩‍💻👩‍💻👩‍💻', 5)).toBe('👩‍💻👩‍💻…')
    expect(cut('🇦🇺🇦🇺🇦🇺', 5)).toBe('🇦🇺🇦🇺…')
    expect(cut('e\u1ab0e\u1ab0e\u1ab0e\u1ab0', 3)).toBe('e\u1ab0e\u1ab0…')
  })
})
