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

const GAP = 2
// A plain Button draws `n: label`.
const chipWidth = (label: string) => 3 + cells(label)

// The label's budget includes the ◆ of Claude's notes, so every chip is at most `width` wide. The
// harvest row's title carries the ◆ for all of its chips.
const labelOf = (note: Note, width: number, isMarked: boolean) =>
  isMarked && note.by === 'claude' ? `${GLYPH.claude} ${cut(oneLine(note.text), width - 2)}` : cut(oneLine(note.text), width)

const chipsWidth = (labels: string[]) => labels.reduce((sum, label) => sum + chipWidth(label) + GAP, 0)
const moreWidth = (more: number) => (more > 0 ? `+${more}`.length + GAP : 0)

// Fits `notes` (in order) into `room` columns: every label is shortened first, from `widest` down
// to WIDTH.chipMin, then chips drop from the right into `more`. `fixed` is what the rest of the row
// takes whatever the chips do.
const fit = (notes: Note[], max: number, room: number, widest: number, fixed: number, isMarked: boolean): Chips => {
  for (let count = Math.min(notes.length, max); count >= 1; count--) {
    const shown = notes.slice(0, count)
    const more = notes.length - count
    for (let width = widest; width >= WIDTH.chipMin; width--) {
      const labels = shown.map(note => labelOf(note, width, isMarked))
      if (chipsWidth(labels) + moreWidth(more) + fixed <= room) {
        return { chips: shown.map((note, i) => ({ n: i + 1, id: note.id, label: labels[i] ?? '' })), more }
      }
    }
  }
  return { chips: [], more: notes.length }
}

const newest = (a: Note, b: Note) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : a.id < b.id ? -1 : 1)

// Pocket: the open notes of this project, newest first, that fit `columns`. `+N` and ✎ always stay.
export const pocketOf = (notes: Note[], projectKey: string, max: number, columns: number): Chips => {
  const open = notes.filter(note => !note.deleted && note.status === 'open' && note.project?.key === projectKey).sort(newest)
  const cap = Number.isFinite(max) ? Math.max(0, Math.min(9, Math.floor(max))) : 0
  return fit(open, cap, columns, WIDTH.chip, cells(GLYPH.capture), true)
}

// The harvest row: the title, `0: keep all` and ✎ always stay; proposals that don't fit wait in the
// pane, counted in a `+N` that opens it. Too narrow for a chip beside the title, the title shortens.
export const harvestOf = (proposals: Note[], columns: number): Chips & { title: string } => {
  const fixed = (title: string) => cells(title) + GAP + chipWidth(TEXT.keepAll) + GAP + cells(GLYPH.capture)
  const title = TEXT.harvestTitle(proposals.length)
  const full = fit(proposals, 9, columns, WIDTH.harvestChip, fixed(title), false)
  if (full.chips.length > 0 || proposals.length === 0) return { ...full, title }
  const short = TEXT.harvestShort(proposals.length)
  return { ...fit(proposals, 9, columns, WIDTH.harvestChip, fixed(short), false), title: short }
}

const More = ({ el, more, handlers }: { el: E; more: number; handlers: BandHandlers }) => {
  const { Button } = el
  return more > 0 ? <Button key={MORE_KEY} plain dimColor label={`+${more}`} onPress={() => handlers.open()} /> : null
}

const Open = ({ el, handlers }: { el: E; handlers: BandHandlers }) => {
  const { Button } = el
  return <Button key={OPEN_KEY} plain action={CHORD.toggle.action} label={GLYPH.capture} onPress={() => handlers.open()} />
}

export const PocketRow = ({ el, pocket, handlers }: { el: E; pocket: Chips; handlers: BandHandlers }) => {
  const { Box, Button } = el
  return (
    <Box gap={GAP}>
      {pocket.chips.map(chip => (
        <Button key={chipKey(chip.n)} plain hotkey={String(chip.n)} label={chip.label} onPress={() => handlers.chip(chip.n, chip.id)} />
      ))}
      <More el={el} more={pocket.more} handlers={handlers} />
      <Open el={el} handlers={handlers} />
    </Box>
  )
}

// The proposals Claude left in the last turn: a digit keeps that one, 0 keeps them all (those in
// `+N` too).
export const HarvestRow = ({ el, proposals, harvest, columns, handlers }: { el: E; proposals: Note[]; harvest: Chips & { title: string }; columns: number; handlers: BandHandlers }) => {
  const { Box, Text, Button } = el
  const ids = proposals.map(note => note.id)
  return (
    <Box flexDirection="column">
      <Box gap={GAP}>
        <Text color={COLOUR.accent} bold>
          {harvest.title}
        </Text>
        {harvest.chips.map(chip => (
          <Button key={chipKey(chip.n)} plain hotkey={String(chip.n)} label={chip.label} onPress={() => handlers.keep(chip.id)} />
        ))}
        <More el={el} more={harvest.more} handlers={handlers} />
        <Button key={KEEP_ALL_KEY} plain hotkey="0" label={TEXT.keepAll} onPress={() => handlers.keepAll(ids)} />
        <Open el={el} handlers={handlers} />
      </Box>
      <Text dimColor>{cut(TEXT.harvestHint(harvest.chips.length), columns)}</Text>
    </Box>
  )
}
