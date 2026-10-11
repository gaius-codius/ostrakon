import type { Elements } from 'claude-code'

import type { Note } from '../../types'
import { cells, cut, oneLine } from '../model'
import { CHORD, COLOUR, GLYPH, TEXT, WIDTH } from './look'

// The band above the prompt (SPEC §10): Pocket at rest, the harvest row while a turn's proposals
// wait. Pure: it gets the elements, the computed rows and the handlers.

type E = Elements['terminal']

// Presses carry the note the chip showed, so a stale or fast press never acts on another one.
export type BandHandlers = {
  chip: (n: number, id: string) => void
  keep: (id: string) => void
  keepAll: (ids: string[]) => void
  // Returns the open: the press waits for it, so the engine counts the pane as the person's
  // (an open after the press settled is "unasked" and isn't placed under 144 columns).
  open: () => Promise<unknown>
}

export type Chip = { n: number; id: string; label: string }

// The chips that fit, and how many notes didn't get one.
export type Chips = { chips: Chip[]; more: number }

export const OPEN_KEY = 'band-open'
export const MORE_KEY = 'band-more'
export const KEEP_ALL_KEY = 'band-keep-all'
export const chipKey = (n: number) => `band-chip-${n}`

const GAP = 3
// A plain Button draws `n: label`.
const chipWidth = (label: string) => 3 + cells(label)

// The opener at the front of the row: ✎ and the project, plain and dim.
export const openerOf = (projectName: string) => `${GLYPH.capture} ${cut(projectName, WIDTH.project)}`

// Cuts at the last word that fits `width` cells, unless that leaves fewer than `least`; then mid-word.
export const wordCut = (text: string, width: number, least: number) => {
  const hard = cut(text, width)
  if (hard === text) return hard
  const kept = hard.slice(0, -GLYPH.more.length)
  // The hard cut already ends on a word.
  if (/^\s/.test(text.slice(kept.length))) return hard
  const space = kept.lastIndexOf(' ')
  if (space <= 0) return hard
  const soft = `${kept.slice(0, space).trimEnd()}${GLYPH.more}`
  return cells(soft) >= least ? soft : hard
}

// The label's budget includes the ◆ of Claude's notes, so every chip is at most `width` wide. The
// harvest row's title carries the ◆ for all of its chips.
const labelOf = (note: Note, width: number, isMarked: boolean) =>
  isMarked && note.by === 'claude'
    ? `${GLYPH.claude} ${wordCut(oneLine(note.text), width - 2, WIDTH.chipMin - 2)}`
    : wordCut(oneLine(note.text), width, WIDTH.chipMin)

// Each chip and `+N` take the gap before them; `fixed` (the opener, a title) is the rest of the row.
const chipsWidth = (labels: string[]) => labels.reduce((sum, label) => sum + GAP + chipWidth(label), 0)
const moreWidth = (more: number) => (more > 0 ? GAP + `+${more}`.length : 0)

// Fits `notes` (in order) into `room` columns: every label is shortened first, from `widest` down
// to WIDTH.chipMin, then chips drop from the right into `more`. `fixed` is what the rest of the row
// takes whatever the chips do.
const fit = (notes: Note[], max: number, room: number, widest: number, fixed: number, isMarked: boolean): Chips => {
  for (let count = Math.min(notes.length, max); count >= 1; count--) {
    const shown = notes.slice(0, count)
    const more = notes.length - count
    for (let width = widest; width >= WIDTH.chipMin; width--) {
      const labels = shown.map(note => labelOf(note, width, isMarked))
      if (fixed + chipsWidth(labels) + moreWidth(more) <= room) {
        return { chips: shown.map((note, i) => ({ n: i + 1, id: note.id, label: labels[i] ?? '' })), more }
      }
    }
  }
  return { chips: [], more: notes.length }
}

const newest = (a: Note, b: Note) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1)

// Pocket: the open notes of this project, newest first, that fit `columns` after the opener. The
// opener and `+N` always stay.
export const pocketOf = (notes: Note[], projectKey: string, max: number, columns: number, opener: string): Chips => {
  const open = notes.filter(note => !note.deleted && note.status === 'open' && note.project?.key === projectKey).sort(newest)
  const cap = Number.isFinite(max) ? Math.max(0, Math.min(9, Math.floor(max))) : 0
  return fit(open, cap, columns, WIDTH.chip, cells(opener), true)
}

export type Harvest = Chips & { title: string; opener: string; gap: number }

// The harvest row, one line: the opener, the title and `0: keep all` always stay; proposals that
// don't fit wait in the pane, counted in a `+N` that opens it. Too narrow for a chip beside the
// title, the title shortens to the ◆. Too narrow for any chip, the row closes up to fit: one
// column apart, then the opener without the project, then no title.
export const harvestOf = (proposals: Note[], columns: number, opener: string): Harvest => {
  const fixed = (title: string) => cells(opener) + GAP + cells(title) + GAP + chipWidth(TEXT.keepAll)
  const title = TEXT.harvestTitle
  const full = fit(proposals, 9, columns, WIDTH.harvestChip, fixed(title), false)
  if (full.chips.length > 0 || proposals.length === 0) return { ...full, title, opener, gap: GAP }
  const short = TEXT.harvestShort
  const narrow = fit(proposals, 9, columns, WIDTH.harvestChip, fixed(short), false)
  if (narrow.chips.length > 0) return { ...narrow, title: short, opener, gap: GAP }
  // Each part and the gap before it; `0: keep all` is a Button's `0: label`.
  const width = (row: { opener: string; title: string; gap: number }) =>
    [row.opener, row.title, narrow.more > 0 ? `+${narrow.more}` : '', `0: ${TEXT.keepAll}`]
      .filter(part => part !== '')
      .reduce((sum, part) => sum + row.gap + cells(part), -row.gap)
  const rows = [
    { opener, title: short, gap: GAP },
    { opener, title: short, gap: 1 },
    { opener: GLYPH.capture, title: short, gap: 1 },
  ]
  return { ...narrow, ...(rows.find(row => width(row) <= columns) ?? { opener: GLYPH.capture, title: '', gap: 1 }) }
}

// How a row is drawn now: all of it dim while a turn runs; a just-saved note's chip at full
// strength among dim ones (a Button label takes no bold or colour).
export type Look = { isWorking: boolean; fresh: string }

// Only a fresh note the row shows dims the others.
const isDim = (look: Look, chips: Chip[], id: string) => (chips.some(chip => chip.id === look.fresh) ? id !== look.fresh : look.isWorking)

const More = ({ el, more, handlers }: { el: E; more: number; handlers: BandHandlers }) => {
  const { Button } = el
  return more > 0 ? <Button key={MORE_KEY} plain dimColor label={`+${more}`} onPress={() => handlers.open()} /> : null
}

const Open = ({ el, opener, handlers }: { el: E; opener: string; handlers: BandHandlers }) => {
  const { Button } = el
  return <Button key={OPEN_KEY} plain dimColor action={CHORD.toggle.action} label={opener} onPress={() => handlers.open()} />
}

export const PocketRow = ({ el, pocket, opener, look, handlers }: { el: E; pocket: Chips; opener: string; look: Look; handlers: BandHandlers }) => {
  const { Box, Button } = el
  return (
    <Box gap={GAP}>
      <Open el={el} opener={opener} handlers={handlers} />
      {pocket.chips.map(chip => (
        <Button key={chipKey(chip.n)} plain dimColor={isDim(look, pocket.chips, chip.id)} hotkey={String(chip.n)} label={chip.label} onPress={() => handlers.chip(chip.n, chip.id)} />
      ))}
      <More el={el} more={pocket.more} handlers={handlers} />
    </Box>
  )
}

// The proposals Claude left in the last turn: a digit keeps that one, 0 keeps them all (those in
// `+N` too). The dim line under it says so for the first few harvests only.
export const HarvestRow = ({
  el,
  proposals,
  harvest,
  look,
  hasHint,
  columns,
  handlers,
}: {
  el: E
  proposals: Note[]
  harvest: Harvest
  look: Look
  hasHint: boolean
  columns: number
  handlers: BandHandlers
}) => {
  const { Box, Text, Button } = el
  const ids = proposals.map(note => note.id)
  return (
    <Box flexDirection="column">
      <Box gap={harvest.gap}>
        <Open el={el} opener={harvest.opener} handlers={handlers} />
        {harvest.title !== '' && (
          <Text color={COLOUR.accent} bold dimColor={look.isWorking}>
            {harvest.title}
          </Text>
        )}
        {harvest.chips.map(chip => (
          <Button key={chipKey(chip.n)} plain dimColor={look.isWorking} hotkey={String(chip.n)} label={chip.label} onPress={() => handlers.keep(chip.id)} />
        ))}
        <More el={el} more={harvest.more} handlers={handlers} />
        <Button key={KEEP_ALL_KEY} plain dimColor={look.isWorking} hotkey="0" label={TEXT.keepAll} onPress={() => handlers.keepAll(ids)} />
      </Box>
      {hasHint ? <Text dimColor>{cut(TEXT.harvestHint(harvest.chips.length), columns)}</Text> : null}
    </Box>
  )
}
