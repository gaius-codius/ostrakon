import { describe, expect, test } from 'claude-code/testing'

import type { PaneState } from '../types'
import type { FocusEvent, FocusView } from '../src/focus'
import { focusMove, leaveMode, needsView, pagedSlot, routeFocus } from '../src/focus'
import { freshPane } from '../src/model'
import { DOWN_KEY, EDIT_KEY, MOVE_KEY, SEARCH_KEY, SHEET_KEY, UP_KEY } from '../src/ui/pane'

// Ten lines, a window of four from `offset`.
const viewAt = (offset: number, rows = 4, total = 10): FocusView => {
  const lines = Array.from({ length: total }, (_, i) => ({ key: `n${i}` }))
  return { lines, page: { offset, lines: lines.slice(offset, offset + rows) } }
}
const EMPTY: FocusView = { lines: [], page: { offset: 0, lines: [] } }

const person = (element: string | undefined): FocusEvent => ({ element, isPerson: true })
const engine = (element: string | undefined): FocusEvent => ({ element, isPerson: false })

// The landing of a move, as the hook decides it: the view only when the move needs one.
const land = (e: FocusEvent, previous: string | undefined, view: FocusView = viewAt(0)) => {
  const move = focusMove(e)
  return routeFocus(move, e, previous, needsView(move) ? view : undefined)
}
const after = (landing: { pane?: (state: PaneState) => PaneState }, state: PaneState = freshPane()) => (landing.pane ? landing.pane(state) : state)
const editing = (): PaneState => ({ ...freshPane(), mode: 'edit', edit: { id: 'n1', draft: 'half typed' }, focus: 'control' })

describe('focus', () => {
  test("the engine's own move is passed on and remembered at once; onto the action layer it is routed like the person's", () => {
    expect(focusMove(engine('slot-2'))).toEqual({ kind: 'pass' })
    expect(needsView(focusMove(engine('slot-2')))).toBe(false)
    expect(land(engine('slot-2'), SEARCH_KEY)).toEqual({ to: 'slot-2' })
    expect(focusMove(engine('key-e'))).toEqual({ kind: 'layer' })
    // Except the key sheet's own key, where the sheet opened from a text field takes the keys.
    const sheet: PaneState = { ...freshPane(), mode: 'sheet', sheetFrom: 'search' }
    expect(land(engine(SHEET_KEY), SEARCH_KEY)).toEqual({ to: SHEET_KEY })
    expect(after(land(engine(SHEET_KEY), SEARCH_KEY), sheet)).toBe(sheet)
    expect(focusMove(person(SHEET_KEY))).toEqual({ kind: 'layer' })
    // Nowhere, even from the engine, is a landing: the pane's focus becomes none.
    expect(focusMove(engine(undefined))).toEqual({ kind: 'land', slot: undefined })
    expect(after(land(engine(undefined), 'slot-1')).focus).toBe('none')
  })

  test('the action layer is never a stop: past the last row stays there, Shift+Tab off search goes to the last row, else search', () => {
    const fromRow = land(person('key-e'), 'slot-1')
    expect([fromRow.to, fromRow.last]).toEqual(['slot-1', 'slot-1'])
    expect(after(fromRow)).toMatchObject({ cursor: 'n1', focus: 'line' })

    const fromSearch = land(person('key-pane:previous'), SEARCH_KEY, viewAt(3))
    expect([fromSearch.to, fromSearch.last]).toEqual(['slot-3', 'slot-3'])
    expect(after(fromSearch)).toMatchObject({ cursor: 'n6', focus: 'line' })

    const fromFooter = land(person('key-e'), 'capture-save')
    expect([fromFooter.to, fromFooter.last]).toEqual([SEARCH_KEY, SEARCH_KEY])
    expect(after(fromFooter, { ...freshPane(), focus: 'control', cursor: 'n2' })).toMatchObject({ cursor: 'n2', focus: 'search' })
  })

  test("off search with no rows the layer sends the ring to search; from a row that left the window the pane's focus goes to search", () => {
    const empty = land(person('key-e'), SEARCH_KEY, EMPTY)
    expect(empty.to).toBe(SEARCH_KEY)
    expect(after(empty).focus).toBe('search')
    // The row it was on is gone: the ring stays on that slot, and the pane's cursor is left as it was.
    const gone = land(person('key-e'), 'slot-7')
    expect(gone.to).toBe('slot-7')
    expect(after(gone, { ...freshPane(), cursor: 'n2', focus: 'line' })).toMatchObject({ cursor: 'n2', focus: 'search' })
  })

  test('an edge sentinel reached from elsewhere lands on the nearest row without paging', () => {
    const down = land(person(DOWN_KEY), SEARCH_KEY, viewAt(2))
    expect(down).toMatchObject({ to: 'slot-3', last: 'slot-3' })
    expect(down.paged).toBeUndefined()
    expect(after(down)).toMatchObject({ cursor: 'n5', focus: 'line', offset: 0 })
    const up = land(person(UP_KEY), 'capture-save', viewAt(2))
    expect(up).toMatchObject({ to: 'slot-0', last: 'slot-0' })
    expect(after(up)).toMatchObject({ cursor: 'n2', focus: 'line' })
  })

  test('from the row beside it, an edge sentinel pages by one line onto the next line', () => {
    const down = land(person(DOWN_KEY), 'slot-3', viewAt(2))
    expect(down).toMatchObject({ to: DOWN_KEY, paged: 'n6' })
    expect(down.last).toBeUndefined()
    expect(after(down)).toMatchObject({ cursor: 'n6', focus: 'line', offset: 3 })
    const up = land(person(UP_KEY), 'slot-0', viewAt(2))
    expect(up).toMatchObject({ paged: 'n1' })
    expect(after(up)).toMatchObject({ cursor: 'n1', offset: 1 })
    // The ring lands on the paged line's slot in the window drawn after.
    expect(pagedSlot(viewAt(3), 'n6')).toBe('slot-3')
    expect(pagedSlot(viewAt(3), 'n9')).toBe('slot-0')
  })

  test('at either end of the list an edge sentinel changes nothing', () => {
    expect(land(person(DOWN_KEY), 'slot-3', viewAt(6))).toEqual({ to: DOWN_KEY })
    expect(land(person(UP_KEY), 'slot-0', viewAt(0))).toEqual({ to: UP_KEY })
    // An empty window: nothing beside it and nothing to page to.
    expect(land(person(DOWN_KEY), SEARCH_KEY, EMPTY)).toEqual({ to: DOWN_KEY })
  })

  test('a row, the search field, a control or nowhere: the ring stays there, remembered before the view is read', () => {
    expect(focusMove(person('slot-2'))).toEqual({ kind: 'land', slot: 2 })
    expect(needsView(focusMove(person('slot-2')))).toBe(true)
    expect(needsView(focusMove(person(SEARCH_KEY)))).toBe(false)
    expect(needsView(focusMove(person('capture-save')))).toBe(false)
    const row = land(person('slot-2'), SEARCH_KEY, viewAt(4))
    expect(row.to).toBe('slot-2')
    expect(row.last).toBeUndefined()
    expect(after(row)).toMatchObject({ cursor: 'n6', focus: 'line' })
    // A slot past the window's rows changes nothing.
    expect(land(person('slot-9'), SEARCH_KEY)).toEqual({ to: 'slot-9' })
    expect(after(land(person(SEARCH_KEY), 'slot-1'), { ...freshPane(), focus: 'line' }).focus).toBe('search')
    expect(after(land(person('capture-save'), SEARCH_KEY)).focus).toBe('control')
    expect(after(land(person(undefined), SEARCH_KEY)).focus).toBe('none')
  })

  test('leaving the edit card or the move Select ends that mode, keeping the draft; other modes stay', () => {
    for (const to of [EDIT_KEY, 'edit-cancel', 'edit-save']) expect(leaveMode(editing(), to).mode).toBe('edit')
    const left = leaveMode(editing(), SEARCH_KEY)
    expect(left).toMatchObject({ mode: 'browse', moving: null, edit: { id: 'n1', draft: 'half typed' } })
    const moving: PaneState = { ...freshPane(), mode: 'move', moving: 'n1' }
    expect(leaveMode(moving, MOVE_KEY)).toBe(moving)
    expect(leaveMode(moving, 'slot-0')).toMatchObject({ mode: 'browse', moving: null })
    expect(leaveMode({ ...freshPane(), mode: 'sheet', sheetFrom: 'capture' }, 'slot-0')).toMatchObject({ mode: 'browse', sheetFrom: null })
    for (const mode of ['capture', 'bundle', 'browse'] as const) expect(leaveMode({ ...freshPane(), mode }, 'slot-0').mode).toBe(mode)
    // Through every route: the layer, an edge, a row.
    expect(after(land(person('key-e'), 'slot-1'), editing()).mode).toBe('browse')
    expect(after(land(person(DOWN_KEY), 'slot-3', viewAt(2)), editing()).mode).toBe('browse')
    expect(after(land(person('slot-1'), EDIT_KEY), editing()).mode).toBe('browse')
    expect(after(land(person('edit-save'), EDIT_KEY), editing())).toMatchObject({ mode: 'edit', focus: 'control' })
  })
})
