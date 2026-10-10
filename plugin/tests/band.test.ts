import { describe, expect, test } from 'claude-code/testing'

import type { Note, NoteProject } from '../types'
import { cells, cut } from '../src/model'
import { harvestOf, pocketOf } from '../src/ui/band'

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
    const pocket = pocketOf(notes, CC.key, 5, WIDE)
    expect(pocket.chips.map(chip => chip.id)).toEqual([fresh.id, mid.id, old.id])
    expect(pocket.chips.map(chip => chip.n)).toEqual([1, 2, 3])
    expect(pocket.more).toBe(0)
  })

  test('the max caps the chips and the rest count in more, never above nine chips', () => {
    const notes = Array.from({ length: 12 }, (_, i) => note(`n${i}`, i))
    expect(pocketOf(notes, CC.key, 3, WIDE)).toMatchObject({ more: 9 })
    expect(pocketOf(notes, CC.key, 3, WIDE).chips).toHaveLength(3)
    const capped = pocketOf(notes, CC.key, 20, WIDE)
    expect(capped.chips).toHaveLength(9)
    expect(capped.more).toBe(3)
  })

  test('labels are cut to 18 columns with an ellipsis; Claude\'s notes spend two of them on the diamond', () => {
    const pocket = pocketOf([note(LONG, 1), note(LONG, 2, { by: 'claude' }), note('short', 3)], CC.key, 5, WIDE)
    expect(pocket.chips.map(chip => chip.label)).toEqual(['a very long note…', '◆ a very long not…', 'short'])
  })

  test('wide characters count two cells and are never cut in half', () => {
    const cjk = '日本語のメモをここに書いておきます'
    const emoji = '😀'.repeat(12)
    const labels = pocketOf([note(cjk, 1), note(emoji, 2)], CC.key, 5, WIDE).chips.map(chip => chip.label)
    // Eight wide characters and the ellipsis are 17 cells; a ninth would make 19.
    expect(labels).toEqual(['日本語のメモをこ…', `${'😀'.repeat(8)}…`])
    for (const label of labels) expect(cellsIn(label)).toBeLessThanOrEqual(18)
  })

  test('a note\'s lines run together in its label', () => {
    expect(pocketOf([note('first\n  second', 1)], CC.key, 5, WIDE).chips[0]?.label).toBe('first second')
  })

  test('at narrow widths labels shorten down to 10 before any chip drops into more', () => {
    const notes = [note(LONG, 1), note(LONG, 2), note(LONG, 3)]
    // Three chips of 14 columns fit 60; at 18 they would need 70.
    const shortened = pocketOf(notes, CC.key, 5, 60)
    expect(shortened.chips).toHaveLength(3)
    expect(shortened.more).toBe(0)
    expect(shortened.chips.every(chip => chip.label.length === 14)).toBe(true)
    // At 10 columns three chips need 46, so one drops and the other two grow back to fill.
    const dropped = pocketOf(notes, CC.key, 5, 40)
    expect(dropped.chips).toHaveLength(2)
    expect(dropped.more).toBe(1)
    expect(dropped.chips.every(chip => chip.label.length >= 10)).toBe(true)
  })

  test('+N and the pencil are budgeted: the drawn row never exceeds the columns', () => {
    const notes = [
      note(LONG, 1),
      note('日本語のメモをここに書いておきます', 2),
      note(LONG, 3, { by: 'claude' }),
      ...Array.from({ length: 6 }, (_, i) => note(`${LONG} ${i}`, 4 + i, { by: i % 2 === 0 ? 'claude' : 'you' })),
    ]
    for (const columns of [20, 30, 45, 60, 80, 120]) {
      const { chips, more } = pocketOf(notes, CC.key, 9, columns)
      // Each Button draws `n: label` (3 cells and the label's), a gap of 2 follows each, then `+N` and ✎.
      const drawn = [...chips.map(chip => `${chip.n}: ${chip.label}`), ...(more > 0 ? [`+${more}`] : []), '✎']
      const width = drawn.reduce((sum, text) => sum + cellsIn(text), 0) + 2 * (drawn.length - 1)
      expect(chips.length + more).toBe(9)
      if (chips.length > 0) expect(width).toBeLessThanOrEqual(columns)
    }
  })

  test('a pocketMax that isn\'t a number shows no chips rather than throwing', () => {
    expect(pocketOf([note('x', 1)], CC.key, Number.NaN, WIDE)).toEqual({ chips: [], more: 1 })
  })
  test('a row too narrow for even one chip shows none and counts them all in more', () => {
    expect(pocketOf([note('x', 1), note('y', 2)], CC.key, 5, 8)).toEqual({ chips: [], more: 2 })
  })

  test('no notes, no chips', () => {
    expect(pocketOf([], CC.key, 5, WIDE)).toEqual({ chips: [], more: 0 })
    expect(pocketOf([note('elsewhere', 1, { project: INFRA })], CC.key, 5, WIDE)).toEqual({ chips: [], more: 0 })
  })

  test('harvest chips carry no diamond and shrink to 10 before proposals drop into +N', () => {
    const proposals = [1, 2, 3, 4].map(i => note(`${LONG} ${i}`, i, { by: 'claude', status: 'proposed' }))
    const roomy = harvestOf(proposals, WIDE)
    expect(roomy.more).toBe(0)
    expect(roomy.chips.map(chip => chip.label)).toEqual(proposals.map(proposal => `${proposal.text.slice(0, 21)}…`))
    // The title, `0: keep all` and the pencil take 40 of the 76 columns; two 10-cell chips fit the rest.
    const narrow = harvestOf(proposals, 76)
    expect(narrow.chips).toHaveLength(2)
    expect(narrow.more).toBe(2)
    expect(narrow.chips.every(chip => !chip.label.includes('◆') && chip.label.length >= 10)).toBe(true)
  })

  test('a harvest without room for a chip beside the title falls back to the short title', () => {
    const harvest = harvestOf([note('x', 1, { status: 'proposed' }), note('y', 2, { status: 'proposed' })], 32)
    expect(harvest.title).toBe('◆ 2')
    expect(harvest.chips.map(chip => chip.label)).toEqual(['x', 'y'])
    expect(harvestOf([note('x', 1, { status: 'proposed' })], 80).title).toBe('◆ 1 note from this turn')
  })

  test('a harvest too narrow for any chip even with the short title counts them all in more', () => {
    expect(harvestOf([note('x', 1, { status: 'proposed' })], 20)).toMatchObject({ chips: [], more: 1, title: '◆ 1' })
  })

  test('cells count grapheme clusters: ZWJ sequences and flags are 2, combining marks 0, wide brackets 2', () => {
    expect(cells('👩‍💻')).toBe(2)
    expect(cells('🇦🇺')).toBe(2)
    expect(cells('e\u1ab0')).toBe(1)
    expect(cells('\u2329')).toBe(2)
    expect(cells('ab')).toBe(2)
  })

  test('a cut never splits a ZWJ sequence, a flag or a character and its marks', () => {
    expect(cut('👩‍💻👩‍💻👩‍💻', 5)).toBe('👩‍💻👩‍💻…')
    expect(cut('🇦🇺🇦🇺🇦🇺', 5)).toBe('🇦🇺🇦🇺…')
    expect(cut('e\u1ab0e\u1ab0e\u1ab0e\u1ab0', 3)).toBe('e\u1ab0e\u1ab0…')
  })
})
