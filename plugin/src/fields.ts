import type { FieldKey, PaneState } from '../types'

// What the pane's text fields draw (tests/fields.test.ts). An Input holds what the person types and
// takes a value only when it differs from the last one drawn; a render built on an older save
// would draw older text and drop the keys typed since. So the typed state (the query, the drafts,
// the pickers' text) is never drawn: `drawn` is, and it changes only when the mod sets a field on
// purpose, or the field comes into view.

const FIELDS: FieldKey[] = ['q', 'capture', 'target', 'edit', 'move']

export const typedIn = (state: PaneState, field: FieldKey) =>
  field === 'q'
    ? state.query
    : field === 'capture'
      ? state.capture.draft
      : field === 'target'
        ? state.capture.find
        : field === 'edit'
          ? (state.edit?.draft ?? '')
          : state.moveFind

// Which field instance a state draws for a key, or null where it draws none: the search row sits
// above the list, the move picker and the edit card, and capture and its picker replace it.
export const shownAs = (state: PaneState, field: FieldKey) => {
  const { mode } = state
  if (field === 'q') return mode === 'browse' || mode === 'sheet' || mode === 'move' || mode === 'edit' ? 'q' : null
  if (field === 'capture') return mode === 'capture' ? 'capture' : null
  if (field === 'target') return mode === 'target' ? 'target' : null
  if (field === 'edit') return mode === 'edit' && state.edit ? `edit:${state.edit.id}` : null
  return mode === 'move' ? `move:${state.moving}` : null
}

// A field draws the typed text only as it comes into view or leaves it, when no keys can be on
// their way to it; while it's in view, only drawField changes what it draws.
export const settleDrawn = (before: PaneState, after: PaneState): PaneState => {
  let drawn = after.drawn
  for (const field of FIELDS) {
    if (shownAs(before, field) === shownAs(after, field) || drawn[field] !== before.drawn[field]) continue
    drawn = { ...drawn, [field]: typedIn(after, field) }
  }
  return drawn === after.drawn ? after : { ...after, drawn }
}

// Sets what a field in view draws. An Input only takes a value that differs from the last one drawn
// (and empties itself on Enter): the same text comes back with a trailing space toggled (trimmed
// everywhere it's read), and an empty field drawn empty last is drawn with no value.
export const redrawn = (text: string) => (text === text.trimEnd() ? `${text} ` : text.trimEnd())
// The typed state becomes what's drawn too, space and all: the field holds exactly that now, and
// its next Enter is compared with it.
export const drawField = (state: PaneState, field: FieldKey, text: string): PaneState => {
  const last = state.drawn[field]
  const next = text === '' ? (last === '' ? null : '') : text === last ? redrawn(text) : text
  return { ...typedAs(state, field, next ?? ''), drawn: { ...state.drawn, [field]: next } }
}

const typedAs = (state: PaneState, field: FieldKey, text: string): PaneState =>
  field === 'q'
    ? { ...state, query: text }
    : field === 'capture'
      ? { ...state, capture: { ...state.capture, draft: text } }
      : field === 'target'
        ? { ...state, capture: { ...state.capture, find: text } }
        : field === 'edit'
          ? { ...state, edit: state.edit ? { ...state.edit, draft: text } : null }
          : { ...state, moveFind: text }

// A pane opened again draws its fields afresh, each with the text typed in it.
export const drawnTyped = (state: PaneState): PaneState => ({
  ...state,
  drawn: Object.fromEntries(FIELDS.map(field => [field, typedIn(state, field)])) as PaneState['drawn'],
})

// After $.state resets with the pane open, every field is empty again but the engine holds what it
// last drew, and the fresh state's '' may be just that: each field is drawn empty with a value
// other than the one it had before the reset.
export const emptiedAfter = (before: PaneState['drawn']): PaneState['drawn'] =>
  Object.fromEntries(FIELDS.map(field => [field, before[field] === '' ? null : ''])) as PaneState['drawn']
