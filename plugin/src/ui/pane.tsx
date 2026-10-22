import type { Elements } from 'claude-code'

import type { Note, NoteProblem, NoteProject, PaneState } from '../../types'
import type { Action, Ctx, Focus, Key, Line, Page } from '../model'
import {
  ageOf,
  cells,
  cut,
  fitFooter,
  fitStatuses,
  footerPairs,
  fromField,
  groupLabel,
  isSheetPair,
  labelOf,
  oneLine,
  sheetLines,
  uniqueKeys,
  wrap,
} from '../model'
import { CHORD, COLOUR, GLYPH, SHARD, TEXT, WIDTH, colourOf } from './look'
import type { Tone } from './look'

// The launcher pane's drawing (SPEC §4). Pure: it gets the elements, a computed view and the
// handlers, and returns the tree. Everything that touches the engine lives in hooks/register.tsx.

type E = Elements['terminal']

export type Handlers = {
  action: (action: Action) => void
  digit: (n: number) => void
  pressSlot: (slot: number) => void
  searchInput: (value: string) => void
  searchSubmit: (value: string) => void
  captureInput: (value: string) => void
  captureSubmit: (value: string) => void
  editInput: (value: string) => void
  editSubmit: (value: string) => void
  editCancel: () => void
  moveTo: (value: string) => void
}

export type PaneView = {
  ctx: Ctx
  pane: PaneState
  focus: Focus
  isInline: boolean
  width: number
  lines: Line[]
  page: Page
  // The note the preview shows: the selected one, or the top result while typing.
  preview: Note | undefined
  keys: Key[]
  problems: NoteProblem[]
  // Notes counted for the header: open in scope, and the total the query looked through.
  counts: { shown: number; total: number; searched: number }
  picksHidden: number
  bundle: Note[]
  projects: NoteProject[]
  captureLabel: string
  showLegend: boolean
  // The rows the engine gives the pane's body.
  bodyRows: number
  // `hub offline · 3 queued` while a configured hub can't be reached (SPEC §9.4); empty otherwise.
  syncStatus: string
  // How the person's theme draws project colours.
  tone: Tone
}

export const SEARCH_KEY = 'q'
export const CAPTURE_KEY = 'capture'
export const EDIT_KEY = 'edit'
export const SEND_KEY = 'bundle-send'
export const MOVE_KEY = 'move'
export const slotKey = (slot: number) => `slot-${slot}`
export const UP_KEY = 'more-up'
export const DOWN_KEY = 'more-down'
export const LAYER_PREFIX = 'key-'
// The key sheet's `i` in the action layer: opened from a text field, the sheet takes the keys here.
export const SHEET_KEY = `${LAYER_PREFIX}i`
export const FOOTER_KEY = 'footer'

const markerOf = (note: Note, pane: PaneState): [string, string | undefined] => {
  if (pane.picks.length > 0) return pane.picks.includes(note.id) ? [GLYPH.picked, COLOUR.accent] : [GLYPH.unpicked, COLOUR.history]
  if (note.status === 'sent') return [GLYPH.sent, COLOUR.history]
  if (note.status === 'archived') return [GLYPH.archived, COLOUR.history]
  if (note.by === 'claude') return [GLYPH.claude, COLOUR.accent]
  if (note.by === 'phone') return [GLYPH.phone, undefined]
  return [' ', undefined]
}

const Hits = ({ el, text, hits, isDim }: { el: E; text: string; hits: number[]; isDim: boolean }) => {
  const { Text } = el
  if (hits.length === 0) return <Text dimColor={isDim}>{text}</Text>
  const marks = new Set(hits)
  const runs: [string, boolean][] = []
  for (let i = 0; i < text.length; i++) {
    const isHit = marks.has(i)
    const last = runs[runs.length - 1]
    if (last && last[1] === isHit) last[0] += text[i]
    else runs.push([text[i] ?? '', isHit])
  }
  return (
    <Text dimColor={isDim}>
      {runs.map(([part, isHit]) =>
        isHit ? (
          <Text bold color={COLOUR.accent}>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  )
}

// A row's focus target: a one-space Button in column 0 that the ring inverts. While the move
// picker or the edit card has the ring, the rows draw a plain space instead. The terminal keeps
// the ring at its place among the controls across a redraw, so a row added or dropped above them
// (a poll, a sync) would otherwise leave the ring on a row: the picker closed and its arrow-key
// choice gone, or the card's typing going to the list.
const Target = ({ el, view, id, isDim, onPress }: { el: E; view: PaneView; id: string; isDim?: boolean; onPress: () => void }) => {
  const { Button, Text } = el
  const isHeld = view.pane.mode === 'move' || view.pane.mode === 'edit'
  return isHeld ? <Text> </Text> : <Button key={id} plain dimColor={isDim} label=' ' onPress={onPress} />
}

// A note sits indented under its heading, which names its project.
const NOTE_INDENT = 2
// The column a note row's text starts in: the focus target, the indent, the number and the marker.
export const TEXT_COLUMN = WIDTH.lead + NOTE_INDENT

const NoteRow = ({ el, view, line, slot, handlers }: { el: E; view: PaneView; line: Extract<Line, { kind: 'note' }>; slot: number; handlers: Handlers }) => {
  const { Box, Text } = el
  const { note } = line
  const { pane, ctx } = view
  const isSelected = (view.focus.kind === 'line' || view.focus.kind === 'move') && pane.cursor === note.id
  const number = view.page.numbers.get(note.id)
  const isHistory = note.status === 'sent' || note.status === 'archived'
  const [marker, markerColour] = markerOf(note, pane)
  const right = 1 + WIDTH.age
  const textWidth = view.width - TEXT_COLUMN - right
  const text = cut(oneLine(note.text), textWidth)
  return (
    <Box key={`row-${slot}`} width={view.width} backgroundColor={isSelected ? COLOUR.band : undefined}>
      <Target el={el} view={view} id={slotKey(slot)} onPress={() => handlers.pressSlot(slot)} />
      <Text>{' '.repeat(NOTE_INDENT)}</Text>
      {number !== undefined ? (
        <Text color={isSelected ? undefined : COLOUR.accent} bold>
          {String(number)}
        </Text>
      ) : (
        <Text dimColor>{GLYPH.pastNine}</Text>
      )}
      <Text color={markerColour}> {marker} </Text>
      <Box width={textWidth}>
        <Hits el={el} text={text} hits={line.hits.filter(at => at < text.length)} isDim={isHistory} />
      </Box>
      <Text> </Text>
      <Text dimColor>{ageOf(note.updated, ctx.now).padStart(WIDTH.age)}</Text>
    </Box>
  )
}

const GroupRow = ({ el, view, line, slot, handlers }: { el: E; view: PaneView; line: Extract<Line, { kind: 'group' }>; slot: number; handlers: Handlers }) => {
  const { Box, Text } = el
  const isSelected = view.focus.kind === 'line' && view.pane.cursor === line.key
  // A heading reads apart from its notes: dot and dim name at the left edge, the notes indented
  // below. Only proposed and the current project are bold accent.
  const isProposed = line.group === 'proposed'
  const isAccent = isProposed || (line.project !== null && line.project.key === view.ctx.current.key)
  const mark = isProposed ? GLYPH.claude : line.project === null ? GLYPH.unfiledDot : GLYPH.dot
  return (
    <Box key={`row-${slot}`} width={view.width} backgroundColor={isSelected ? COLOUR.band : undefined}>
      <Target el={el} view={view} id={slotKey(slot)} onPress={() => handlers.pressSlot(slot)} />
      <Text color={isProposed ? COLOUR.accent : colourOf(line.project?.key ?? null, view.ctx.current.key, view.tone)}>{mark} </Text>
      <Text color={isAccent ? COLOUR.accent : undefined} bold={isAccent} dimColor={!isAccent}>
        {cut(groupLabel(view.ctx, line), WIDTH.label)}
      </Text>
      {line.isFolded && <Text dimColor> {GLYPH.folded}</Text>}
      <Box flexGrow={1} />
      {line.count > 0 && <Text dimColor>{String(line.count)}</Text>}
    </Box>
  )
}

const ProblemRow = ({
  el,
  view,
  line,
  slot,
  handlers,
}: {
  el: E
  view: PaneView
  line: Extract<Line, { kind: 'problem' }>
  slot: number
  handlers: Handlers
}) => {
  const { Box, Text } = el
  const isSelected = view.focus.kind === 'line' && view.pane.cursor === line.key
  return (
    <Box key={`row-${slot}`} width={view.width} backgroundColor={isSelected ? COLOUR.band : undefined}>
      <Target el={el} view={view} id={slotKey(slot)} onPress={() => handlers.pressSlot(slot)} />
      <Text color={COLOUR.problem} bold>
        {GLYPH.problem} {line.count} unreadable file{line.count === 1 ? '' : 's'}
      </Text>
      <Text dimColor> · ⏎ details</Text>
    </Box>
  )
}

const Sentinel = ({ el, view, id, glyph, count, handlers }: { el: E; view: PaneView; id: string; glyph: string; count: number; handlers: Handlers }) => {
  const { Box, Text } = el
  return (
    <Box>
      <Target el={el} view={view} id={id} isDim onPress={() => handlers.action(id === UP_KEY ? 'up' : 'down')} />
      <Text dimColor>
        {glyph} {count} more
      </Text>
    </Box>
  )
}

// The search row's right side, within `room` cells. The scope always shows; inline, a selected
// row's meta leads it, dropping the path, then the age, then the branch to fit.
const rightText = (view: PaneView, room: number) => {
  const { pane, counts } = view
  const scope = pane.scope === 'project' ? 'this project' : 'all'
  const counted =
    pane.query.trim() === '' ? `${scope} · ${counts.total} open${pane.history ? ' + history' : ''}` : `${scope} · ${counts.shown} of ${counts.searched}`
  if (!(view.isInline && view.focus.kind === 'line' && view.preview)) return cut(counted, room)
  const { who, path, branch, age } = metaParts(view, view.preview)
  const mark = who === 'you' ? undefined : who
  const tries = [[mark, path, branch, age], [mark, branch, age], [mark, branch], [mark]]
  for (const parts of tries) {
    const text = [...parts, counted].filter(Boolean).join(' · ')
    if (cells(text) <= room) return text
  }
  return cut(counted, room)
}

// A query that matches nothing: Enter saves it as a note, so the field's "to list" would be wrong.
// Note rows only: a storage problem's row doesn't count as a match (searchSubmit saves past it).
const isNoMatch = (view: PaneView) => !view.lines.some(line => line.kind === 'note') && view.pane.query.trim() !== ''

// The search field's width: what the glyph and the right side leave, so the row never runs past
// the pane. Then the room its text has beside the cursor and the field's hint, which keeps its ⏎
// with no label.
const searchWidth = (view: PaneView) => Math.max(1, view.width - 2 - 1 - cells(rightText(view, Math.max(10, Math.floor(view.width / 2)))))
const searchRoom = (view: PaneView) => searchWidth(view) - 1 - cells(isNoMatch(view) ? ` ${GLYPH.enter}` : ` ${GLYPH.enter} ${TEXT.toList}`)

const SearchRow = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Text, Input } = el
  const isFocused = view.focus.kind === 'search' || view.focus.kind === 'empty'
  const right = rightText(view, Math.max(10, Math.floor(view.width / 2)))
  return (
    <Box width={view.width}>
      <Text color={isFocused ? COLOUR.accent : COLOUR.history} bold>
        {GLYPH.search}{' '}
      </Text>
      {/* An explicit width, as capture's: left to flex, the field's "⏎ to list" wraps onto a second row. */}
      <Box width={searchWidth(view)}>
        <Input
          key={SEARCH_KEY}
          placeholder={TEXT.placeholder}
          value={view.pane.query}
          submitLabel={isNoMatch(view) ? '' : TEXT.toList}
          autoFocus={view.pane.mode === 'browse' ? true : undefined}
          onInput={value => handlers.searchInput(value)}
          onSubmit={value => handlers.searchSubmit(value)}
        />
      </Box>
      <Box flexGrow={1} />
      <Text dimColor> {right}</Text>
    </Box>
  )
}

// Docked, the capture row is the pane's one card: a round accent frame, because it's the one
// moment the pane is a text field rather than a list.
const CaptureRow = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Text, Input } = el
  const isFramed = !view.isInline
  const inner = view.width - (isFramed ? 4 : 0)
  const lead = `${GLYPH.capture} ${TEXT.captureLabel} `
  return (
    <Box width={view.width} borderStyle={isFramed ? 'round' : undefined} borderColor={isFramed ? COLOUR.accent : undefined} paddingX={isFramed ? 1 : 0}>
      <Box flexShrink={0}>
        <Text color={COLOUR.accent} bold>
          {lead}
        </Text>
      </Box>
      {/* An explicit width: left to flex, the field's own "⏎ save" hint wraps onto a second row. */}
      <Box width={Math.max(10, inner - cells(lead) - 1 - cells(cut(view.captureLabel, WIDTH.label)))}>
        <Input
          key={CAPTURE_KEY}
          placeholder='write a note'
          value={view.pane.capture.draft}
          submitLabel=''
          autoFocus
          onInput={value => handlers.captureInput(value)}
          onSubmit={value => handlers.captureSubmit(value)}
        />
      </Box>
      <Box flexShrink={0}>
        <Text color={isFramed ? COLOUR.accent : undefined} dimColor={!isFramed}>
          {' '}
          {cut(view.captureLabel, WIDTH.label)}
        </Text>
      </Box>
    </Box>
  )
}

const metaParts = (view: PaneView, note: Note) => {
  const age = ageOf(note.updated, view.ctx.now)
  return {
    who: note.by === 'claude' ? `${GLYPH.claude} claude` : note.by === 'phone' ? 'phone' : 'you',
    path: note.project?.path ? note.project.path.replace(/^\/home\/[^/]+/, '~') : 'unfiled',
    branch: note.context.branch,
    age: age === 'now' ? 'just now' : `${age} ago`,
  }
}

// Within `width` cells: a long path is cut, then dropped, before the age is.
const metaOf = (view: PaneView, note: Note, width: number) => {
  const { who, path, branch, age } = metaParts(view, note)
  const rest = [who, branch, age].filter(Boolean).join(' · ')
  const room = width - cells(rest) - cells(' · ')
  if (room < 8) return cut(rest, width)
  return [who, cut(path, room), branch, age].filter(Boolean).join(' · ')
}

// Docked, the preview and the footer keep fixed heights, so the rows' window never changes size
// as the selection moves (and the footer doesn't jump).
export const PREVIEW_ROWS = 1 + WIDTH.previewLines + 1
export const FOOTER_ROWS = 1
// Docked in a body too short for the preview and three rows (one between the ↑ and ↓ counts)
// besides, the preview goes, as inline, so the footer stays on screen.
const hasPreview = (view: { isInline: boolean; bodyRows: number }) => !view.isInline && view.bodyRows >= 2 + PREVIEW_ROWS + 3 + 1 + FOOTER_ROWS
// The edit card is three rows taller than its row, so editing in a body too short for both, the
// preview gives up text lines (the draft keeps its end) rather than be cut at the footer.
const EDIT_ROWS = 3
const previewLinesOf = (view: { pane: PaneState; bodyRows: number }) =>
  view.pane.mode === 'edit' ? Math.max(1, Math.min(WIDTH.previewLines, view.bodyRows - (2 + 2 + 3 + EDIT_ROWS + 1 + FOOTER_ROWS))) : WIDTH.previewLines
const previewRows = (view: { pane: PaneState; bodyRows: number }) => 1 + previewLinesOf(view) + 1

// A draft being typed, wrapped: the one-line field cuts it off, so this is where it reads whole.
// Too long for `rows`, it shows its end (where the typing is), led by …
const draftLines = (text: string, width: number, rows: number) => {
  const lines = wrap(text, width)
  if (lines.length <= rows) return lines
  const tail = lines.slice(-rows)
  tail[0] = `${GLYPH.more}${cut(tail[0] ?? '', width - 1)}`
  return tail
}

const Preview = ({ el, view, note }: { el: E; view: PaneView; note: Note }) => {
  const { Box, Text } = el
  const { edit } = view.pane
  // While the note is being edited, the preview is the draft, whole.
  const isEditing = view.pane.mode === 'edit' && edit !== null && edit.id === note.id
  // Quoted: a dim bar down the left, the way the bundle shows what it will send. The bar sits
  // under the rows' text, so the preview reads as the selected row's.
  const width = Math.max(1, view.width - TEXT_COLUMN - 2)
  const lines = wrap(isEditing ? fromField(edit.draft) : note.text, width)
  const rows = previewLinesOf(view)
  let shown = lines.slice(0, rows)
  if (isEditing) shown = draftLines(fromField(edit.draft), width, rows)
  // A last line that fills the width gives up its end to the … rather than run past it.
  else if (lines.length > rows) shown[shown.length - 1] = cut(`${shown[shown.length - 1] ?? ''}${GLYPH.more}`, width)
  return (
    <Box flexDirection='column' width={view.width} height={previewRows(view)} paddingLeft={TEXT_COLUMN}>
      <Box height={1} />
      {shown.map(line => (
        <Text>
          <Text dimColor>{GLYPH.quote} </Text>
          {line === '' ? ' ' : line}
        </Text>
      ))}
      <Text dimColor>
        {GLYPH.quote} {metaOf(view, note, width)}
      </Text>
    </Box>
  )
}

const Footer = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const { pane, focus } = view
  const statuses: [string, string][] = []
  if (pane.picks.length > 0 && focus.kind === 'line')
    statuses.push([`${pane.picks.length} picked${view.picksHidden > 0 ? ` (${view.picksHidden} hidden)` : ''}`, COLOUR.accent])
  if (view.problems.length > 0 && focus.kind !== 'line')
    statuses.push([`${view.problems.length} unreadable file${view.problems.length === 1 ? '' : 's'}`, COLOUR.problem])
  if (view.syncStatus !== '') statuses.push([view.syncStatus, COLOUR.offline])
  // One line: as many actions as fit, the legend before any past the first WIDTH.footerPairs, and
  // `i keys` on the right.
  const all: [string, string][] = focus.kind === 'unfocused' ? TEXT.unfocused : footerPairs(view.keys)
  const keySheet = all.find(isSheetPair)
  // Statuses are cut, never wrapped, and leave room for `i keys` (two gaps: the spacer's and its own).
  // They take at most half the line, so a long one (a mirror's path) leaves the keys a place.
  const shown = fitStatuses(
    statuses,
    Math.min(Math.max(WIDTH.label, Math.floor(view.width / 2)), view.width - 2 - (keySheet ? 2 + cells(keySheet.join(' ')) : 0)),
  )
  const lead = shown.map(([text]) => text).join('  ')
  const legend: [string, string] | undefined = view.showLegend && !view.isInline ? [TEXT.legend, ''] : undefined
  // The spacer before `i keys` takes one more gap than fitFooter counts.
  const fitted = fitFooter(all, legend, lead, view.width - 2, WIDTH.footerPairs)
  const pairs = fitted.filter(pair => !isSheetPair(pair))
  const Pair = ({ pair: [key, label] }: { pair: [string, string] }) =>
    key === TEXT.legend ? (
      <Text dimColor>{key}</Text>
    ) : (
      <Text>
        <Text bold>{key}</Text>
        {label !== '' && <Text dimColor> {label}</Text>}
      </Text>
    )
  return (
    <Box key={FOOTER_KEY} flexDirection='column' width={view.width} flexShrink={0}>
      {!view.isInline && <Box height={1} />}
      <Box columnGap={2} width={view.width} height={FOOTER_ROWS}>
        {shown.map(([text, colour]) => (
          <Text color={colour} bold>
            {text}
          </Text>
        ))}
        {pairs.map(pair => (
          <Pair pair={pair} />
        ))}
        <Box flexGrow={1} />
        {keySheet && fitted.includes(keySheet) && <Pair pair={keySheet} />}
      </Box>
    </Box>
  )
}

// The keys no control shows: hidden Buttons whose hotkeys and chords the pane answers.
const ActionLayer = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Button } = el
  const keys = uniqueKeys(view.keys).filter(key => key.hotkey !== undefined || key.chord !== undefined)
  const digits = view.focus.kind === 'line' ? [...view.page.numbers.values()] : []
  // With a row or Button focused, a letter no Button answers would go to the prompt and take the
  // keyboard with it. Every other letter and digit is answered here and does nothing.
  const holdsKeys =
    view.focus.kind === 'line' || view.focus.kind === 'bundle' || view.focus.kind === 'sheet' || (view.focus.kind === 'edit' && view.pane.focus === 'control')
  const taken = new Set([...keys.map(key => key.hotkey), ...digits.map(String)])
  const idle = holdsKeys ? [...'abcdefghijklmnopqrstuvwxyz0123456789'].filter(char => !taken.has(char)) : []
  return (
    <Box display='none'>
      {keys.map(key => (
        <Button
          key={`${LAYER_PREFIX}${key.hotkey ?? key.chord}`}
          plain
          hotkey={key.hotkey}
          action={key.chord}
          label={key.action}
          onPress={() => handlers.action(key.action)}
        />
      ))}
      {digits.map(n => (
        <Button key={`${LAYER_PREFIX}digit-${n}`} plain hotkey={String(n)} label={`row ${n}`} onPress={() => handlers.digit(n)} />
      ))}
      {/* ctrl+x s closes the pane from anywhere while it's mounted; the band (P3) opens it. */}
      <Button key={`${LAYER_PREFIX}toggle`} plain action={CHORD.toggle.action} label='toggle' onPress={() => handlers.action('toggle')} />
      {idle.map(char => (
        <Button key={`${LAYER_PREFIX}idle-${char}`} plain hotkey={char} label='' onPress={() => undefined} />
      ))}
    </Box>
  )
}

const Rows = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Text, Input, Button } = el
  const { page } = view
  return (
    <Box flexDirection='column' width={view.width}>
      {page.above > 0 && <Sentinel el={el} view={view} id={UP_KEY} glyph={GLYPH.up} count={page.above} handlers={handlers} />}
      {page.lines.map((line, slot) => {
        if (view.pane.mode === 'edit' && view.pane.edit && line.key === view.pane.edit.id) {
          return (
            <Box key={`row-${slot}`} width={view.width} borderStyle='round' borderColor={COLOUR.accent} flexDirection='column' paddingX={1}>
              <Box>
                <Box flexShrink={0}>
                  <Text color={COLOUR.accent} bold>
                    edit{' '}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Input
                    key={EDIT_KEY}
                    value={view.pane.edit.draft}
                    submitLabel=''
                    onInput={value => handlers.editInput(value)}
                    onSubmit={value => handlers.editSubmit(value)}
                  />
                </Box>
              </Box>
              <Box gap={2}>
                <Button key='edit-cancel' label={TEXT.editCancel} onPress={() => handlers.editCancel()} />
                <Button key='edit-save' variant='primary' label={TEXT.editSave} onPress={() => handlers.editSubmit(view.pane.edit?.draft ?? '')} />
                <Box flexGrow={1} />
                {/* Only when it fits: wrapped, it adds a row the paging doesn't budget for. */}
                {editHintFits(view.width) && <Text dimColor>{TEXT.editHint}</Text>}
              </Box>
            </Box>
          )
        }
        if (line.kind === 'note') return <NoteRow el={el} view={view} line={line} slot={slot} handlers={handlers} />
        if (line.kind === 'group') return <GroupRow el={el} view={view} line={line} slot={slot} handlers={handlers} />
        return <ProblemRow el={el} view={view} line={line} slot={slot} handlers={handlers} />
      })}
      {page.below > 0 && <Sentinel el={el} view={view} id={DOWN_KEY} glyph={GLYPH.down} count={page.below} handlers={handlers} />}
    </Box>
  )
}

// The edit card's button row: its frame and padding, both buttons, three gaps of 2, the hint.
const editHintFits = (width: number) => width - 4 >= cells(`[ ${TEXT.editCancel} ]`) + cells(`[ ${TEXT.editSave} ]`) + 3 * 2 + cells(TEXT.editHint)

// Enter saves the query as a note, so this is capture's start: a query the field cuts off reads
// whole here, as capture's draft does, and one that fits isn't repeated. The footer has the keys.
const NoMatch = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const query = view.pane.query.trim()
  // The field shows the query untrimmed, so its spaces count toward the cut. A body too short for
  // the preview takes one line, as inline, so the footer stays on screen.
  const rows = !view.isInline && hasPreview(view) ? WIDTH.previewLines : 1
  // Indented one, past the rows' focus column, as the note rows are.
  const width = view.width - 1
  const draft = cells(view.pane.query) > searchRoom(view) ? draftLines(query, width, rows) : []
  return (
    <Box flexDirection='column' paddingY={view.isInline ? 0 : 1} paddingLeft={1}>
      {draft.map(line => (
        <Text>{line === '' ? ' ' : line}</Text>
      ))}
      {draft.length > 0 && !view.isInline && <Box height={1} />}
      <Text dimColor>{cut(TEXT.noMatch(view.ctx.current.name), width)}</Text>
    </Box>
  )
}

const Empty = ({ el, view, hasHub, hasHarvest }: { el: E; view: PaneView; hasHub: boolean; hasHarvest: boolean }) => {
  const { Box, Text } = el
  const ways: [string, string][] = [
    ['//', 'jot a note from the prompt, even mid-turn'],
    [CHORD.new.keys, 'new note'],
    ...(hasHub ? ([[`${GLYPH.phone} phone`, 'notes from your phone land here']] as [string, string][]) : []),
    ...(hasHarvest ? ([[GLYPH.claude, 'Claude can leave notes for you']] as [string, string][]) : []),
  ]
  // Docked, a small shard sits beside the ways in; the title and the keys share its right edge,
  // and the descriptions share one column after the keys. Too narrow for that, the shard goes first.
  const longest = Math.max(...ways.map(([, text]) => cells(text)))
  const hasShard = !view.isInline && view.width - 2 - WIDTH.shard - WIDTH.wayKey >= longest
  const indent = hasShard ? WIDTH.shard : 0
  return (
    <Box flexDirection='column' paddingY={view.isInline ? 0 : 1} paddingX={1}>
      <Box>
        <Box width={indent} />
        <Text bold>{TEXT.emptyTitle(view.pane.scope === 'project' ? view.ctx.current.name : 'any project')}</Text>
      </Box>
      {!view.isInline && <Box height={1} />}
      <Box>
        {hasShard && (
          <Box flexDirection='column' width={indent} flexShrink={0}>
            {SHARD.map(line => (
              <Text color={COLOUR.accent} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection='column'>
          {ways.map(([key, text]) => (
            <Box>
              <Box width={WIDTH.wayKey} flexShrink={0}>
                <Text color={COLOUR.accent} bold>
                  {key}
                </Text>
              </Box>
              <Text dimColor>{cut(text, view.width - 2 - indent - WIDTH.wayKey)}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

const Capture = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const { capture } = view.pane
  // Docked, the rows between capture's and the footer's, inside the padding. A short body keeps the
  // hint (or the error) first, then the newest save, then the draft's lines, then the earlier saves.
  const room = view.bodyRows - topRows('capture', false) - (1 + FOOTER_ROWS) - 2
  const newest = Math.min(1, capture.saved.length, room - 1)
  const draftRows = view.isInline ? 1 : Math.min(WIDTH.previewLines, room - 1 - newest - 1)
  const draft = capture.draft.trim() === '' || draftRows < 1 ? [] : draftLines(capture.draft, view.width, draftRows)
  const keep = view.isInline ? WIDTH.savedInline : Math.max(0, newest, Math.min(WIDTH.savedDocked, room - 1 - (draft.length > 0 ? draft.length + 1 : 0)))
  return (
    <Box flexDirection='column' paddingY={view.isInline ? 0 : 1}>
      {draft.map(line => (
        <Text>{line === '' ? ' ' : line}</Text>
      ))}
      {draft.length > 0 && !view.isInline && <Box height={1} />}
      {/* The newest save is bright; earlier ones step back. */}
      {capture.saved.slice(capture.saved.length - Math.min(keep, capture.saved.length)).map((text, i, saved) => (
        <Text>
          <Text color={i === saved.length - 1 ? COLOUR.saved : COLOUR.history}>{GLYPH.saved} </Text>
          <Text dimColor={i !== saved.length - 1}>{cut(oneLine(text), view.width - 14)}</Text>
          <Text dimColor> · just now</Text>
        </Text>
      ))}
      {capture.error !== null ? (
        <Text color={COLOUR.problem}>{cut(capture.error, view.width)}</Text>
      ) : (
        <Text dimColor>{TEXT.captureHint(view.captureLabel)}</Text>
      )}
    </Box>
  )
}

const Bundle = ({ el, view, handlers, rows }: { el: E; view: PaneView; handlers: Handlers; rows: number }) => {
  const { Box, Text, Button } = el
  const others = view.bundle.filter(note => note.project !== null && note.project.key !== view.ctx.current.key)
  const fromOthers = [...new Set(others.map(note => labelOf(view.ctx, note.project)))]
  const room = Math.max(1, rows)
  const lines = view.bundle.map(
    note => `- ${note.project !== null && note.project.key !== view.ctx.current.key ? `[${labelOf(view.ctx, note.project)}] ` : ''}${oneLine(note.text)}`,
  )
  const shown = lines.length > room ? [...lines.slice(0, room - 1), `${GLYPH.more} and ${lines.length - room + 1} more`] : lines
  return (
    <Box flexDirection='column' width={view.width}>
      <Box width={view.width}>
        <Text color={COLOUR.accent} bold>
          {GLYPH.bundle} bundle{' '}
        </Text>
        <Text>
          {view.bundle.length} note{view.bundle.length === 1 ? '' : 's'} into one prompt
        </Text>
        <Box flexGrow={1} />
        {fromOthers.length > 0 && (
          <Text dimColor>
            {others.length} from {fromOthers.join(', ')}
          </Text>
        )}
      </Box>
      <Box height={1} />
      <Box borderStyle='quote' borderColor={COLOUR.history} flexDirection='column' width={view.width}>
        <Text>{TEXT.bundleIntro}</Text>
        <Text> </Text>
        {shown.map(line => (
          <Text>{cut(line, view.width - 2)}</Text>
        ))}
      </Box>
      {!view.isInline && <Box height={1} />}
      <Box gap={2}>
        <Button key={SEND_KEY} variant='primary' label='send' onPress={() => handlers.action('send')} />
      </Box>
    </Box>
  )
}

const Move = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Select } = el
  const all = [...view.projects.map(project => ({ value: project.key, label: labelOf(view.ctx, project) })), { value: 'unfiled', label: 'unfiled' }]
  // Where the note is now isn't offered, and the picker starts on the first place it can go.
  const moving = view.lines.find(line => line.key === view.pane.moving)
  const now = moving?.kind === 'note' ? (moving.note.project?.key ?? 'unfiled') : undefined
  const elsewhere = all.filter(option => option.value !== now)
  const options = elsewhere.length > 0 ? elsewhere : all
  return (
    <Box width={view.width}>
      <Select key={MOVE_KEY} label='move to' options={options} value={options[0]?.value} onSelect={value => handlers.moveTo(value)} />
    </Box>
  )
}

// The key sheet sits under the search row and above the footer, framed. It pages to fit the rows
// between (SPEC §4.5): the problems first, then the keys. Too short for a line inside the frame
// (5 rows docked, 4 inline), it drops the frame rather than cover the footer.
const sheetTop = (isInline: boolean) => (isInline ? 1 : 2)
// The rows above what the mode shows: the search row, or capture's (framed docked), and a blank
// docked. The bundle has neither.
const topRows = (mode: PaneState['mode'], isInline: boolean) => {
  if (mode === 'bundle') return 0
  if (mode === 'capture') return isInline ? 1 : 3 + 1
  return sheetTop(isInline)
}
const isSheetFramed = (bodyRows: number, isInline: boolean) => bodyRows - sheetTop(isInline) - FOOTER_ROWS - 2 >= 1
export const sheetRoom = (bodyRows: number, isInline: boolean) =>
  Math.max(1, bodyRows - sheetTop(isInline) - FOOTER_ROWS - (isSheetFramed(bodyRows, isInline) ? 2 : 0))
export const sheetPages = (bodyRows: number, isInline: boolean, problems: number) =>
  Math.max(1, Math.ceil((problems + TEXT.keySheet.length) / sheetRoom(bodyRows, isInline)))

const padCells = (text: string, width: number) => `${text}${' '.repeat(Math.max(0, width - cells(text)))}`

const KeySheet = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const width = Math.min(WIDTH.keySheet, view.width - 1)
  const inner = width - 4
  const keyWidth = Math.min(WIDTH.sheetKey, Math.floor(inner / 2))
  const room = sheetRoom(view.bodyRows, view.isInline)
  const isFramed = isSheetFramed(view.bodyRows, view.isInline)
  const page = view.focus.kind === 'sheet' ? view.focus.page : 0
  const lines = sheetLines(TEXT.keySheet, view.focus.kind === 'sheet' ? view.focus.lead : [])
  const entries = [
    ...view.problems.map(problem => ({ problem: `${problem.file}: ${problem.reason}`, key: '', label: '' })),
    ...lines.map(([key, label]) => ({ problem: '', key, label })),
  ]
  return (
    <Box
      position='absolute'
      top={sheetTop(view.isInline)}
      left={Math.max(0, view.width - width)}
      width={width}
      borderStyle={isFramed ? 'round' : undefined}
      borderColor={COLOUR.accent}
      flexDirection='column'
      paddingX={1}
      backgroundColor={COLOUR.band}
    >
      {entries.slice(page * room, (page + 1) * room).map(({ problem, key, label }) =>
        problem !== '' ? (
          <Text color={COLOUR.problem}>{cut(problem, inner)}</Text>
        ) : (
          <Text>
            <Text bold>{padCells(cut(key, keyWidth - 1), keyWidth)}</Text>
            <Text dimColor>{cut(label, inner - keyWidth)}</Text>
          </Text>
        ),
      )}
    </Box>
  )
}

// Rows the chrome around the lines takes, so the mod can page the lines to fit (SPEC §4.8).
export const chromeRows = (view: Omit<PaneView, 'page'>) => {
  const header = view.isInline ? 1 : 2
  const preview = hasPreview(view) ? previewRows(view) : 0
  const footer = view.isInline ? FOOTER_ROWS : 1 + FOOTER_ROWS
  const edit = view.pane.mode === 'edit' ? EDIT_ROWS : 0
  const move = view.pane.mode === 'move' ? 1 : 0
  return header + preview + footer + edit + move
}

export const Pane = ({
  el,
  view,
  handlers,
  hasHub,
  hasHarvest,
  bundleRows,
}: {
  el: E
  view: PaneView
  handlers: Handlers
  hasHub: boolean
  hasHarvest: boolean
  bundleRows: number
}) => {
  const { Box } = el
  const { pane } = view
  const hasNotes = view.lines.some(line => line.kind !== 'group')
  const body = () => {
    if (pane.mode === 'capture') return <Capture el={el} view={view} />
    if (pane.mode === 'bundle') return <Bundle el={el} view={view} handlers={handlers} rows={bundleRows} />
    // A storage problem's row stays above the no-match line.
    if (isNoMatch(view)) return [view.lines.length > 0 && <Rows el={el} view={view} handlers={handlers} />, <NoMatch el={el} view={view} />]
    if (view.lines.length === 0 && pane.query.trim() === '') return <Empty el={el} view={view} hasHub={hasHub} hasHarvest={hasHarvest} />
    return <Rows el={el} view={view} handlers={handlers} />
  }
  const showPreview = hasPreview(view) && (pane.mode === 'browse' || pane.mode === 'sheet' || pane.mode === 'move' || pane.mode === 'edit') && hasNotes
  const middle = [
    body(),
    pane.mode === 'move' && <Move el={el} view={view} handlers={handlers} />,
    showPreview && (view.preview ? <Preview el={el} view={view} note={view.preview} /> : <Box height={previewRows(view)} />),
  ]
  // Docked, and inline with the key sheet up, the pane takes the whole body and the footer its last
  // row, whether the list is full, short, has no match or is empty. What sits between is cut at the
  // rows left there: in a short body the empty block, a long query, capture's saves or the rows
  // under the sheet run taller than the room, and pushed the footer off the body. Inline otherwise,
  // the pane is only as tall as what it shows.
  const isSheet = pane.mode === 'sheet'
  const isFilled = isSheet || !view.isInline
  const middleRows = Math.max(0, view.bodyRows - topRows(pane.mode, view.isInline) - (view.isInline ? FOOTER_ROWS : 1 + FOOTER_ROWS))
  return (
    <Box flexDirection='column' width={view.width} height={isFilled ? view.bodyRows : undefined}>
      {pane.mode === 'bundle' ? null : pane.mode === 'capture' ? (
        <CaptureRow el={el} view={view} handlers={handlers} />
      ) : (
        <SearchRow el={el} view={view} handlers={handlers} />
      )}
      {pane.mode !== 'bundle' && !view.isInline && <Box height={1} />}
      {isFilled ? (
        <Box flexDirection='column' flexShrink={0} height={middleRows} overflow='hidden'>
          <Box flexDirection='column' flexShrink={0}>
            {middle}
          </Box>
        </Box>
      ) : (
        middle
      )}
      <Footer el={el} view={view} />
      {isSheet && <KeySheet el={el} view={view} />}
      <ActionLayer el={el} view={view} handlers={handlers} />
    </Box>
  )
}
