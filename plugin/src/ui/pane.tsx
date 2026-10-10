import type { Elements } from 'claude-code'

import type { Note, NoteProblem, NoteProject, PaneState } from '../../types'
import type { Action, Ctx, Focus, Key, Line, Page } from '../model'
import { ageOf, cells, cut, fitOneLine, fitStatuses, footerPairs, fromField, groupLabel, labelOf, oneLine, toField, uniqueKeys, wrap } from '../model'
import { CHORD, COLOUR, GLYPH, SHARD, TEXT, WIDTH, colourOf } from './look'

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
  counts: { shown: number; total: number }
  picksHidden: number
  bundle: Note[]
  projects: NoteProject[]
  captureLabel: string
  showLegend: boolean
  // The rows the engine gives the pane's body.
  bodyRows: number
  // `hub offline · 3 queued` while a configured hub can't be reached (SPEC §9.4); empty otherwise.
  syncStatus: string
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

// A note's project on the right of a row: the colour goes on the dot, the name stays dim, and only
// the current project's name takes the accent.
const ProjectCell = ({ el, view, note, isHistory }: { el: E; view: PaneView; note: Note; isHistory: boolean }) => {
  const { Text } = el
  const key = note.project?.key ?? null
  const isCurrent = key === view.ctx.current.key && !isHistory
  const name = cut(labelOf(view.ctx, note.project), WIDTH.project)
  return (
    <Text>
      {' '.repeat(Math.max(0, WIDTH.project - cells(name)))}
      <Text color={isHistory ? COLOUR.history : colourOf(key, view.ctx.current.key)}>{key === null ? GLYPH.unfiledDot : GLYPH.dot} </Text>
      <Text color={isCurrent ? COLOUR.accent : undefined} dimColor={!isCurrent}>
        {name}
      </Text>
    </Text>
  )
}

const NoteRow = ({ el, view, line, slot, handlers }: { el: E; view: PaneView; line: Extract<Line, { kind: 'note' }>; slot: number; handlers: Handlers }) => {
  const { Box, Text, Button } = el
  const { note } = line
  const { pane, ctx } = view
  const isSelected = (view.focus.kind === 'line' || view.focus.kind === 'move') && pane.cursor === note.id
  const number = view.page.numbers.get(note.id)
  const isHistory = note.status === 'sent' || note.status === 'archived'
  const [marker, markerColour] = markerOf(note, pane)
  const isGrouped = line.group !== undefined
  // Grouped, a note sits indented under its heading; ungrouped, its project shows on the right.
  const indent = isGrouped ? 2 : 0
  const right = isGrouped ? 1 + WIDTH.age : 1 + 2 + WIDTH.project + 1 + WIDTH.age
  const textWidth = view.width - WIDTH.lead - indent - right
  const text = cut(oneLine(note.text), textWidth)
  return (
    <Box key={`row-${slot}`} width={view.width} backgroundColor={isSelected ? COLOUR.band : undefined}>
      <Button key={slotKey(slot)} plain label=" " onPress={() => handlers.pressSlot(slot)} />
      {isGrouped && <Text>{' '.repeat(indent)}</Text>}
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
      {!isGrouped && <ProjectCell el={el} view={view} note={note} isHistory={isHistory} />}
      {!isGrouped && <Text> </Text>}
      <Text dimColor>{ageOf(note.updated, ctx.now).padStart(WIDTH.age)}</Text>
    </Box>
  )
}

const GroupRow = ({ el, view, line, slot, handlers }: { el: E; view: PaneView; line: Extract<Line, { kind: 'group' }>; slot: number; handlers: Handlers }) => {
  const { Box, Text, Button } = el
  const isSelected = view.focus.kind === 'line' && view.pane.cursor === line.key
  // A heading reads apart from its notes: dot and dim name at the left edge, the notes indented
  // below. Only proposed and the current project are bold accent.
  const isProposed = line.group === 'proposed'
  const isAccent = isProposed || (line.project !== null && line.project.key === view.ctx.current.key)
  const mark = isProposed ? GLYPH.claude : line.project === null ? GLYPH.unfiledDot : GLYPH.dot
  return (
    <Box key={`row-${slot}`} width={view.width} backgroundColor={isSelected ? COLOUR.band : undefined}>
      <Button key={slotKey(slot)} plain label=" " onPress={() => handlers.pressSlot(slot)} />
      <Text color={isProposed ? COLOUR.accent : colourOf(line.project?.key ?? null, view.ctx.current.key)}>{mark} </Text>
      <Text color={isAccent ? COLOUR.accent : undefined} bold={isAccent} dimColor={!isAccent}>
        {cut(groupLabel(view.ctx, line), WIDTH.label)}
      </Text>
      {line.isFolded && <Text dimColor> {GLYPH.folded}</Text>}
      <Box flexGrow={1} />
      {line.count > 0 && <Text dimColor>{String(line.count)}</Text>}
    </Box>
  )
}

const ProblemRow = ({ el, view, line, slot, handlers }: { el: E; view: PaneView; line: Extract<Line, { kind: 'problem' }>; slot: number; handlers: Handlers }) => {
  const { Box, Text, Button } = el
  const isSelected = view.focus.kind === 'line' && view.pane.cursor === line.key
  return (
    <Box key={`row-${slot}`} width={view.width} backgroundColor={isSelected ? COLOUR.band : undefined}>
      <Button key={slotKey(slot)} plain label=" " onPress={() => handlers.pressSlot(slot)} />
      <Text color={COLOUR.problem} bold>
        {GLYPH.problem} {line.count} unreadable file{line.count === 1 ? '' : 's'}
      </Text>
      <Text dimColor> · ⏎ details</Text>
    </Box>
  )
}

const Sentinel = ({ el, id, glyph, count, handlers }: { el: E; id: string; glyph: string; count: number; handlers: Handlers }) => {
  const { Box, Text, Button } = el
  return (
    <Box>
      <Button key={id} plain dimColor label=" " onPress={() => handlers.action(id === UP_KEY ? 'up' : 'down')} />
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
    pane.view === 'list'
      ? `list · ${scope} · ${counts.total} open${pane.history ? ' + history' : ''}`
      : pane.query.trim() === ''
        ? `${scope} · ${counts.total} open`
        : `${scope} · ${counts.shown} of ${counts.total}`
  if (!(view.isInline && view.focus.kind === 'line' && view.preview)) return cut(counted, room)
  const { who, path, branch, age } = metaParts(view, view.preview)
  const mark = who === 'you' ? undefined : who
  const tries = [
    [mark, path, branch, age],
    [mark, branch, age],
    [mark, branch],
    [mark],
  ]
  for (const parts of tries) {
    const text = [...parts, counted].filter(Boolean).join(' · ')
    if (cells(text) <= room) return text
  }
  return cut(counted, room)
}

const SearchRow = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Text, Input } = el
  const isFocused = view.focus.kind === 'search' || view.focus.kind === 'empty'
  const right = rightText(view, Math.max(10, Math.floor(view.width / 2)))
  return (
    <Box width={view.width}>
      <Text color={isFocused ? COLOUR.accent : COLOUR.history} bold>
        {GLYPH.search}{' '}
      </Text>
      <Box flexGrow={1}>
        <Input
          key={SEARCH_KEY}
          placeholder={TEXT.placeholder}
          value={view.pane.query}
          submitLabel={TEXT.toList}
          autoFocus={view.pane.mode === 'browse' ? true : undefined}
          onInput={value => handlers.searchInput(value)}
          onSubmit={value => handlers.searchSubmit(value)}
        />
      </Box>
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
          placeholder="write a note"
          value={view.pane.capture.draft}
          submitLabel=""
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

const metaOf = (view: PaneView, note: Note) => {
  const { who, path, branch, age } = metaParts(view, note)
  return [who, path, branch, age].filter(Boolean).join(' · ')
}

// Docked, the preview and the footer keep fixed heights, so the rows' window never changes size
// as the selection moves (and the footer doesn't jump).
export const PREVIEW_ROWS = 1 + WIDTH.previewLines + 1
export const FOOTER_ROWS = 1

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
  // Quoted: a dim bar down the left, the way the bundle shows what it will send.
  const width = view.width - 2
  const lines = wrap(isEditing ? fromField(edit.draft) : note.text, width)
  let shown = lines.slice(0, WIDTH.previewLines)
  if (isEditing) shown = draftLines(fromField(edit.draft), width, WIDTH.previewLines)
  else if (lines.length > WIDTH.previewLines) shown[shown.length - 1] = cut(`${shown[shown.length - 1] ?? ''} `, width).replace(/ ?$/, GLYPH.more)
  return (
    <Box flexDirection="column" width={view.width} height={PREVIEW_ROWS}>
      <Box height={1} />
      {shown.map(line => (
        <Text>
          <Text dimColor>{GLYPH.quote} </Text>
          {line === '' ? ' ' : line}
        </Text>
      ))}
      <Text dimColor>
        {GLYPH.quote} {cut(metaOf(view, note), width)}
      </Text>
    </Box>
  )
}

const Footer = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const { pane, focus } = view
  const statuses: [string, string][] = []
  if (pane.picks.length > 0 && focus.kind === 'line') statuses.push([`${pane.picks.length} picked${view.picksHidden > 0 ? ` (${view.picksHidden} hidden)` : ''}`, COLOUR.accent])
  if (view.problems.length > 0 && focus.kind !== 'line') statuses.push([`${view.problems.length} unreadable file${view.problems.length === 1 ? '' : 's'}`, COLOUR.problem])
  if (view.syncStatus !== '') statuses.push([view.syncStatus, COLOUR.offline])
  // One line: at most WIDTH.footerPairs actions, the legend if there's room, `i keys` on the right.
  const all: [string, string][] = focus.kind === 'unfocused' ? TEXT.unfocused : footerPairs(view.keys)
  const keySheet = all.find(([key]) => key === 'i')
  // Statuses are cut, never wrapped, and leave room for `i keys` (two gaps: the spacer's and its own).
  const shown = fitStatuses(statuses, view.width - 2 - (keySheet ? 2 + cells(keySheet.join(' ')) : 0))
  const lead = shown.map(([text]) => text).join('  ')
  const actions = all.filter(([key]) => key !== 'i').slice(0, WIDTH.footerPairs)
  if (view.showLegend && !view.isInline) actions.push([TEXT.legend, ''])
  // The spacer before `i keys` takes one more gap than fitOneLine counts.
  const fitted = fitOneLine(keySheet ? [...actions, keySheet] : actions, lead, view.width - 2)
  const pairs = fitted.filter(([key]) => key !== 'i')
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
    <Box flexDirection="column" width={view.width}>
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
    <Box display="none">
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
      <Button key={`${LAYER_PREFIX}toggle`} plain action={CHORD.toggle.action} label="toggle" onPress={() => handlers.action('toggle')} />
      {idle.map(char => (
        <Button key={`${LAYER_PREFIX}idle-${char}`} plain hotkey={char} label="" onPress={() => undefined} />
      ))}
    </Box>
  )
}

const Rows = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Text, Input, Button } = el
  const { page } = view
  return (
    <Box flexDirection="column" width={view.width}>
      {page.above > 0 && <Sentinel el={el} id={UP_KEY} glyph={GLYPH.up} count={page.above} handlers={handlers} />}
      {page.lines.map((line, slot) => {
        if (view.pane.mode === 'edit' && view.pane.edit && line.key === view.pane.edit.id) {
          return (
            <Box key={`row-${slot}`} width={view.width} borderStyle="round" borderColor={COLOUR.accent} flexDirection="column" paddingX={1}>
              <Box>
                <Box flexShrink={0}>
                  <Text color={COLOUR.accent} bold>
                    edit{' '}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Input key={EDIT_KEY} value={view.pane.edit.draft} submitLabel="" onInput={value => handlers.editInput(value)} onSubmit={value => handlers.editSubmit(value)} />
                </Box>
              </Box>
              <Box gap={2}>
                <Button key="edit-cancel" label="cancel" onPress={() => handlers.editCancel()} />
                <Button key="edit-save" variant="primary" label="save" onPress={() => handlers.editSubmit(view.pane.edit?.draft ?? '')} />
                <Box flexGrow={1} />
                <Text dimColor>{TEXT.editHint}</Text>
              </Box>
            </Box>
          )
        }
        if (line.kind === 'note') return <NoteRow el={el} view={view} line={line} slot={slot} handlers={handlers} />
        if (line.kind === 'group') return <GroupRow el={el} view={view} line={line} slot={slot} handlers={handlers} />
        return <ProblemRow el={el} view={view} line={line} slot={slot} handlers={handlers} />
      })}
      {page.below > 0 && <Sentinel el={el} id={DOWN_KEY} glyph={GLYPH.down} count={page.below} handlers={handlers} />}
    </Box>
  )
}

const NoMatch = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const where = view.pane.scope === 'project' ? view.ctx.current.name : 'any project'
  const [line, hint] = TEXT.noMatch(view.pane.query.trim(), where)
  return (
    <Box flexDirection="column" paddingY={view.isInline ? 0 : 1}>
      <Text>{line}</Text>
      <Text dimColor>
        <Text color={COLOUR.accent}>{GLYPH.enter}</Text> {hint} {view.ctx.current.name} · <Text color={COLOUR.accent}>ctrl+s</Text> scope
      </Text>
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
    <Box flexDirection="column" paddingY={view.isInline ? 0 : 1} paddingX={1}>
      <Box>
        <Box width={indent} />
        <Text bold>{TEXT.emptyTitle(view.pane.scope === 'project' ? view.ctx.current.name : 'any project')}</Text>
      </Box>
      {!view.isInline && <Box height={1} />}
      <Box>
        {hasShard && (
          <Box flexDirection="column" width={indent} flexShrink={0}>
            {SHARD.map(line => (
              <Text color={COLOUR.accent} dimColor>
                {line}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column">
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
  const keep = view.isInline ? WIDTH.savedInline : WIDTH.savedDocked
  const draft = capture.draft.trim() === '' ? [] : draftLines(capture.draft, view.width, view.isInline ? 1 : WIDTH.previewLines)
  return (
    <Box flexDirection="column" paddingY={view.isInline ? 0 : 1}>
      {draft.map(line => (
        <Text>{line === '' ? ' ' : line}</Text>
      ))}
      {draft.length > 0 && !view.isInline && <Box height={1} />}
      {/* The newest save is bright; earlier ones step back. */}
      {capture.saved.slice(-keep).map((text, i, saved) => (
        <Text>
          <Text color={i === saved.length - 1 ? COLOUR.saved : COLOUR.history}>{GLYPH.saved} </Text>
          <Text dimColor={i !== saved.length - 1}>{cut(oneLine(text), view.width - 14)}</Text>
          <Text dimColor> · just now</Text>
        </Text>
      ))}
      {capture.error !== null ? <Text color={COLOUR.problem}>{cut(capture.error, view.width)}</Text> : <Text dimColor>{TEXT.captureHint(view.captureLabel)}</Text>}
    </Box>
  )
}

const Bundle = ({ el, view, handlers, rows }: { el: E; view: PaneView; handlers: Handlers; rows: number }) => {
  const { Box, Text, Button } = el
  const others = view.bundle.filter(note => note.project !== null && note.project.key !== view.ctx.current.key)
  const fromOthers = [...new Set(others.map(note => labelOf(view.ctx, note.project)))]
  const room = Math.max(1, rows)
  const lines = view.bundle.map(note => `- ${note.project !== null && note.project.key !== view.ctx.current.key ? `[${labelOf(view.ctx, note.project)}] ` : ''}${oneLine(note.text)}`)
  const shown = lines.length > room ? [...lines.slice(0, room - 1), `${GLYPH.more} and ${lines.length - room + 1} more`] : lines
  return (
    <Box flexDirection="column" width={view.width}>
      <Box width={view.width}>
        <Text color={COLOUR.accent} bold>
          {GLYPH.bundle} bundle{' '}
        </Text>
        <Text>
          {view.bundle.length} note{view.bundle.length === 1 ? '' : 's'} into one prompt
        </Text>
        <Box flexGrow={1} />
        {fromOthers.length > 0 && <Text dimColor>{others.length} from {fromOthers.join(', ')}</Text>}
      </Box>
      <Box height={1} />
      <Box borderStyle="quote" borderColor={COLOUR.history} flexDirection="column" width={view.width}>
        <Text>{TEXT.bundleIntro}</Text>
        <Text> </Text>
        {shown.map(line => (
          <Text>{cut(line, view.width - 2)}</Text>
        ))}
      </Box>
      {!view.isInline && <Box height={1} />}
      {!view.isInline && <Text dimColor>{TEXT.bundleNote}</Text>}
      <Box gap={2}>
        <Button key={SEND_KEY} variant="primary" label="send" onPress={() => handlers.action('send')} />
      </Box>
    </Box>
  )
}

const Move = ({ el, view, handlers }: { el: E; view: PaneView; handlers: Handlers }) => {
  const { Box, Select } = el
  const options = [...view.projects.map(project => ({ value: project.key, label: labelOf(view.ctx, project) })), { value: 'unfiled', label: 'unfiled' }]
  return (
    <Box width={view.width}>
      <Select key={MOVE_KEY} label="move to" options={options} onSelect={value => handlers.moveTo(value)} />
    </Box>
  )
}

// The key sheet sits under the search row and above the footer, framed. It pages to fit the rows
// between (SPEC §4.5): the problems first, then the keys.
const sheetTop = (isInline: boolean) => (isInline ? 1 : 2)
export const sheetRoom = (bodyRows: number, isInline: boolean) => Math.max(1, bodyRows - sheetTop(isInline) - FOOTER_ROWS - 2)
export const sheetPages = (bodyRows: number, isInline: boolean, problems: number) =>
  Math.max(1, Math.ceil((problems + TEXT.keySheet.length) / sheetRoom(bodyRows, isInline)))

const padCells = (text: string, width: number) => `${text}${' '.repeat(Math.max(0, width - cells(text)))}`

const KeySheet = ({ el, view }: { el: E; view: PaneView }) => {
  const { Box, Text } = el
  const width = Math.min(WIDTH.keySheet, view.width - 1)
  const inner = width - 4
  const keyWidth = Math.min(WIDTH.sheetKey, Math.floor(inner / 2))
  const room = sheetRoom(view.bodyRows, view.isInline)
  const page = view.focus.kind === 'sheet' ? view.focus.page : 0
  const entries = [...view.problems.map(problem => ({ problem: `${problem.file}: ${problem.reason}`, key: '', label: '' })), ...TEXT.keySheet.map(([key, label]) => ({ problem: '', key, label }))]
  return (
    <Box position="absolute" top={sheetTop(view.isInline)} left={Math.max(0, view.width - width)} width={width} borderStyle="round" borderColor={COLOUR.accent} flexDirection="column" paddingX={1} backgroundColor={COLOUR.band}>
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
  const preview = view.isInline ? 0 : PREVIEW_ROWS
  const footer = view.isInline ? FOOTER_ROWS : 1 + FOOTER_ROWS
  const edit = view.pane.mode === 'edit' ? 3 : 0
  const move = view.pane.mode === 'move' ? 1 : 0
  return header + preview + footer + edit + move
}

export const Pane = ({ el, view, handlers, hasHub, hasHarvest, bundleRows }: { el: E; view: PaneView; handlers: Handlers; hasHub: boolean; hasHarvest: boolean; bundleRows: number }) => {
  const { Box } = el
  const { pane, focus } = view
  const hasNotes = view.lines.some(line => line.kind !== 'group')
  const body = () => {
    if (pane.mode === 'capture') return <Capture el={el} view={view} />
    if (pane.mode === 'bundle') return <Bundle el={el} view={view} handlers={handlers} rows={bundleRows} />
    if (view.lines.length === 0 && pane.query.trim() !== '') return <NoMatch el={el} view={view} />
    if (view.lines.length === 0 && pane.query.trim() === '') return <Empty el={el} view={view} hasHub={hasHub} hasHarvest={hasHarvest} />
    return <Rows el={el} view={view} handlers={handlers} />
  }
  const showPreview = !view.isInline && (pane.mode === 'browse' || pane.mode === 'sheet' || pane.mode === 'move' || pane.mode === 'edit') && hasNotes
  // With the key sheet up the pane takes the whole body and the footer its last row, so the sheet,
  // paged to the rows between, never covers the footer or runs past a short inline pane.
  const isSheet = pane.mode === 'sheet'
  return (
    <Box flexDirection="column" width={view.width} height={isSheet ? view.bodyRows : undefined}>
      {pane.mode === 'bundle' ? null : pane.mode === 'capture' ? <CaptureRow el={el} view={view} handlers={handlers} /> : <SearchRow el={el} view={view} handlers={handlers} />}
      {pane.mode !== 'bundle' && !view.isInline && <Box height={1} />}
      {body()}
      {pane.mode === 'move' && <Move el={el} view={view} handlers={handlers} />}
      {showPreview && (view.preview ? <Preview el={el} view={view} note={view.preview} /> : <Box height={PREVIEW_ROWS} />)}
      {isSheet && <Box flexGrow={1} />}
      <Footer el={el} view={view} />
      {isSheet && <KeySheet el={el} view={view} />}
      <ActionLayer el={el} view={view} handlers={handlers} />
    </Box>
  )
}
