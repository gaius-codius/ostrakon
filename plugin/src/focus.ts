import type { PaneState } from '../types'
import { DOWN_KEY, EDIT_KEY, LAYER_PREFIX, MOVE_KEY, SEARCH_KEY, SHEET_KEY, UP_KEY, slotKey } from './ui/pane'

// The pane's focus ring: where a move of the ring lands, and what the pane's state becomes. Pure;
// the ui.focus hook in hooks/register.tsx reads the view, applies the decision and moves the ring
// (tests/focus.test.ts).

// A move of the ring: the element it went to, and whether the person moved it (Tab, a click) or
// the engine did (the mod's own focus).
export type FocusEvent = { element: string | undefined; isPerson: boolean }

// What routing reads of the pane's view: every line, and the window drawn.
export type FocusView = { lines: { key: string }[]; page: { offset: number; lines: { key: string }[] } }

// What a move is, known without the view. `pass`: the engine's own move to anything but the action
// layer, only remembered. `layer`: onto the action layer, drawn last, which is never a stop.
// `edge`: onto an edge sentinel, which pages. `land`: anywhere else (a row, the search field, a
// control, nowhere), where the ring stays. A pass or a landing is the ring's last element at once,
// before any wait.
export type FocusMove = { kind: 'pass' } | { kind: 'layer' } | { kind: 'edge'; isDown: boolean } | { kind: 'land'; slot: number | undefined }

export const focusMove = (e: FocusEvent): FocusMove => {
  const element = e.element
  if (!e.isPerson && element !== undefined && !element.startsWith(LAYER_PREFIX)) return { kind: 'pass' }
  // The one layer stop: the key sheet, opened from a text field, takes the keys there (the mod's
  // own move; the person's Tab onto it is still routed off the layer).
  if (!e.isPerson && element === SHEET_KEY) return { kind: 'pass' }
  if (element?.startsWith(LAYER_PREFIX)) return { kind: 'layer' }
  if (element === DOWN_KEY || element === UP_KEY) return { kind: 'edge', isDown: element === DOWN_KEY }
  return { kind: 'land', slot: element?.startsWith('slot-') ? Number(element.slice(5)) : undefined }
}

// Only a redirect, a page or a row needs the view.
export const needsView = (move: FocusMove) => move.kind === 'layer' || move.kind === 'edge' || (move.kind === 'land' && move.slot !== undefined)

// Leaving the edit card or the move picker ends that mode (the edit draft is kept), whichever route
// the ring takes.
export const leaveMode = (state: PaneState, to: string | undefined): PaneState => {
  const stays =
    (state.mode === 'edit' && (to === EDIT_KEY || to === 'edit-cancel' || to === 'edit-save')) ||
    (state.mode === 'move' && to === MOVE_KEY) ||
    state.mode === 'capture' ||
    state.mode === 'target' ||
    state.mode === 'bundle' ||
    state.mode === 'browse'
  return stays ? state : { ...state, mode: 'browse', moving: null, sheetFrom: null }
}

export type FocusLanding = {
  // Where the engine puts the ring.
  to: string | undefined
  // The ring's last element from now on; as it was when not given.
  last?: string
  // The pane's state after the move; unchanged when not given.
  pane?: (state: PaneState) => PaneState
  // Paged by one line: the ring goes instead to this line's slot in the window drawn after `pane`
  // (pagedSlot), which becomes the last element.
  paged?: string
}

// Where a move lands, from the ring's last element before it and the view (when needsView).
export const routeFocus = (move: FocusMove, e: FocusEvent, previous: string | undefined, view: FocusView | undefined): FocusLanding => {
  const element = e.element
  const page = view?.page ?? { offset: 0, lines: [] }
  switch (move.kind) {
    case 'pass':
      return { to: element }
    case 'layer': {
      // Moving on past the last row stays there; Shift+Tab off the search field goes to the last
      // row; anything else to the search field.
      const last = page.lines.length - 1
      const to = previous?.startsWith('slot-') ? previous : previous === SEARCH_KEY && last >= 0 ? slotKey(last) : SEARCH_KEY
      const line = to.startsWith('slot-') ? page.lines[Number(to.slice(5))] : undefined
      return {
        to,
        last: to,
        pane: state => (line ? { ...leaveMode(state, to), cursor: line.key, focus: 'line' } : { ...leaveMode(state, to), focus: 'search' }),
      }
    }
    case 'edge': {
      // Edge sentinels page by one line and keep the ring on the edge slot (SPEC §4.8). Arriving
      // from anywhere but the row beside it (the search field, the footer) lands on the nearest row
      // without paging.
      const nearest = move.isDown ? page.lines.length - 1 : 0
      const beside = slotKey(nearest)
      const near = page.lines[nearest]
      if (previous !== beside && near) return { to: beside, last: beside, pane: state => ({ ...leaveMode(state, beside), cursor: near.key, focus: 'line' }) }
      const line = view?.lines[move.isDown ? page.offset + page.lines.length : page.offset - 1]
      if (!line) return { to: element }
      const offset = page.offset + (move.isDown ? 1 : -1)
      return { to: element, pane: state => ({ ...leaveMode(state, 'slot'), cursor: line.key, focus: 'line', offset }), paged: line.key }
    }
    case 'land': {
      const after = (state: PaneState) => leaveMode(state, element)
      if (move.slot !== undefined) {
        const line = page.lines[move.slot]
        return line ? { to: element, pane: state => ({ ...after(state), cursor: line.key, focus: 'line' }) } : { to: element }
      }
      if (element === SEARCH_KEY) return { to: element, pane: state => ({ ...after(state), focus: 'search' }) }
      return { to: element, pane: state => ({ ...after(state), focus: element === undefined ? 'none' : 'control' }) }
    }
  }
}

// A paged line's slot in the window drawn after paging (the first, if it isn't there).
export const pagedSlot = (view: FocusView, key: string) =>
  slotKey(
    Math.max(
      0,
      view.page.lines.findIndex(line => line.key === key),
    ),
  )
