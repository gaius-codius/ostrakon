import { atom, read, update } from 'claude-code'
import type { Elements, Register } from 'claude-code'

// Design mockups (phase D, part 2): static renders of every pane state in three directions, from
// fixed sample data. Nothing here is interactive; the real pane is built in P2.
//   /mock <quiet|cards|ledger|mix> <view>     views: see VIEWS
//   /mockband <off|a|b> <pocket0|pocket3|pocket9|harvest>

type E = Elements['terminal']
type Direction = 'quiet' | 'cards' | 'ledger' | 'mix'

const direction = atom({ plugin: 'spmock', key: 'direction' } as const, 'quiet')
const view = atom({ plugin: 'spmock', key: 'view' } as const, 'search-empty')
const band = atom({ plugin: 'spmock', key: 'band' } as const, 'off')

const PANE = 'ostrakon'
const VIEWS = [
  'search-empty',
  'search-typing',
  'search-nomatch',
  'list-grouped',
  'list-folded',
  'list-history',
  'picked',
  'bundle',
  'capture',
  'edit',
  'empty',
]

// ---- sample data ----

type Note = {
  id: string
  text: string
  project: string
  age: string
  by?: 'claude' | 'phone'
  status?: 'sent' | 'archived'
  branch?: string
}

const CURRENT = 'cc'
const NOTES: Note[] = [
  { id: 'a', project: 'cc', age: '12m', branch: 'main', text: 'check why the cache test is flaky on CI. started after the redis bump, only on the arm runners' },
  { id: 'b', project: 'cc', age: '1h', branch: 'main', text: 'rename the store helpers to match the spec (createStore, change, scan)' },
  { id: 'c', project: 'cc', age: '3h', by: 'claude', branch: 'main', text: 'login returns 401 right after a token refresh; retry ignores Retry-After' },
  { id: 'd', project: 'cc', age: '1d', branch: 'p1', text: 'try bun:test for the merge property tests' },
  { id: 'e', project: 'cc', age: '2d', branch: 'main', text: 'add a /jot section to the README' },
  { id: 'f', project: 'infra', age: '1h', text: 'add a cache invalidation metric to the hub dashboard' },
  { id: 'g', project: 'infra', age: '2d', text: 'rotate the staging api keys before friday' },
  { id: 'h', project: 'infra', age: '5d', text: 'tailscale serve on the server for the ostrakon hub' },
  { id: 'i', project: 'api', age: '2d', text: 'document the cache-key format in the api readme' },
  { id: 'j', project: 'api', age: '1w', text: 'pagination cursor is off by one on the last page' },
  { id: 'k', project: 'unfiled', age: '4h', by: 'phone', text: 'book the dentist' },
  { id: 'l', project: 'unfiled', age: '3d', by: 'phone', text: 'idea: weekly digest of what got sent' },
]
const HISTORY: Note[] = [
  { id: 'x', project: 'cc', age: '2d', status: 'sent', text: 'bump redis to 7.2 in the test compose file' },
  { id: 'y', project: 'cc', age: '5d', status: 'archived', text: 'remove the old v1 notes file' },
]
const PATHS: Record<string, string> = { cc: '~/Work/cc', infra: '~/code/infra', api: '~/Work/api', unfiled: '' }

// Project colours: theme keys only (they follow light and dark); the current project gets the accent.
const PALETTE = ['suggestion', 'success', 'merged', 'planMode', 'warning', 'autoAccept']
const colourOf = (project: string) => {
  if (project === CURRENT) return 'claude'
  if (project === 'unfiled') return 'inactive'
  let hash = 0
  for (const char of project) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length] ?? 'suggestion'
}

const fit = (text: string, width: number) => {
  const flat = text.replaceAll('\n', ' ')
  return flat.length <= width ? flat.padEnd(width) : `${flat.slice(0, Math.max(0, width - 1))}…`
}

// Matched characters of a query: a contiguous hit if there is one, else a greedy subsequence.
const segments = (text: string, query: string): [string, boolean][] => {
  if (query === '') return [[text, false]]
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at >= 0) return [[text.slice(0, at), false], [text.slice(at, at + query.length), true], [text.slice(at + query.length), false]]
  return [[text, false]]
}

const matches = (query: string) => NOTES.filter(note => note.text.toLowerCase().includes(query.toLowerCase()))

// ---- shared pieces ----

type RowSpec = {
  note: Note
  width: number
  number?: number
  isSelected?: boolean
  isPicked?: boolean
  showPicks?: boolean
  query?: string
  isHistory?: boolean
  // Grouped list rows leave the project out: the group header names it.
  isGrouped?: boolean
}

const Highlighted = ({ el, text, query, width, isDim }: { el: E; text: string; query: string; width: number; isDim?: boolean }) => {
  const { Text } = el
  const cut = fit(text, width)
  return (
    <Text dimColor={isDim}>
      {segments(cut, query).map(([part, isHit]) =>
        isHit ? (
          <Text bold color="claude" underline>
            {part}
          </Text>
        ) : (
          part
        ),
      )}
    </Text>
  )
}

const marker = (spec: RowSpec) => {
  if (spec.isHistory) return spec.note.status === 'sent' ? '↗' : '·'
  if (spec.note.by === 'claude') return '◆'
  if (spec.note.by === 'phone') return '▪'
  return ' '
}

// ---- direction: quiet ----
// Almost no chrome. Selected row: a background band with an accent bar. Projects as coloured
// words at the right. One footer line of keys.

const QuietRow = ({ el, spec }: { el: E; spec: RowSpec }) => {
  const { Box, Text } = el
  const { note, width } = spec
  const pick = spec.showPicks ? (spec.isPicked ? '● ' : '○ ') : ''
  const right = spec.isGrouped ? ` ${note.age.padStart(4)}` : `${fit(note.project, 8).trimEnd().padStart(8)} ${note.age.padStart(4)}`
  const textWidth = width - 3 - pick.length - right.length - 1
  return (
    <Box width={width} backgroundColor={spec.isSelected ? 'subtle' : undefined}>
      <Text color="claude">{spec.isSelected ? '▌' : ' '}</Text>
      <Text color={marker(spec) === '◆' ? 'claude' : 'inactive'}>{marker(spec)} </Text>
      {pick !== '' && <Text color={spec.isPicked ? 'claude' : 'inactive'}>{pick}</Text>}
      <Highlighted el={el} text={note.text} query={spec.query ?? ''} width={textWidth} isDim={spec.isHistory} />
      <Text> </Text>
      {!spec.isGrouped && <Text color={spec.isHistory ? 'inactive' : colourOf(note.project)}>{fit(note.project, 8).trimEnd().padStart(8)}</Text>}
      <Text dimColor> {note.age.padStart(4)}</Text>
    </Box>
  )
}

// ---- direction: cards ----
// Framed search, project pills on the left, preview in a card, primary actions as buttons.

const Pill = ({ el, project, isDim }: { el: E; project: string; isDim?: boolean }) => {
  const { Text } = el
  return (
    <Text backgroundColor={isDim ? 'inactive' : colourOf(project)} color="inverseText">
      {` ${project.slice(0, 7).padEnd(7)} `}
    </Text>
  )
}

const CardsRow = ({ el, spec }: { el: E; spec: RowSpec }) => {
  const { Box, Text } = el
  const { note, width } = spec
  const pick = spec.showPicks ? (spec.isPicked ? '● ' : '○ ') : ''
  const textWidth = width - 2 - (spec.isGrouped ? 0 : 10) - 1 - pick.length - 2 - 5
  return (
    <Box width={width} backgroundColor={spec.isSelected ? 'subtle' : undefined}>
      <Text color="claude">{spec.isSelected ? '▌ ' : '  '}</Text>
      {!spec.isGrouped && <Pill el={el} project={note.project} isDim={spec.isHistory} />}
      <Text> </Text>
      {pick !== '' && <Text color={spec.isPicked ? 'claude' : 'inactive'}>{pick}</Text>}
      <Text color={marker(spec) === '◆' ? 'claude' : 'inactive'}>{marker(spec)} </Text>
      <Highlighted el={el} text={note.text} query={spec.query ?? ''} width={textWidth} isDim={spec.isHistory} />
      <Text dimColor>{note.age.padStart(5)}</Text>
    </Box>
  )
}

// ---- direction: ledger ----
// A table: numbered rows (1-9 jump), a column header, coloured dots for projects, selection
// drawn inverse like the native focus ring.

const LedgerRow = ({ el, spec }: { el: E; spec: RowSpec }) => {
  const { Box, Text } = el
  const { note, width } = spec
  const num = spec.number !== undefined && spec.number <= 9 ? String(spec.number) : ' '
  const pick = spec.showPicks ? (spec.isPicked ? '●' : '○') : marker(spec)
  const textWidth = width - 4 - (spec.isGrouped ? 0 : 12) - 5
  return (
    <Box width={width}>
      <Text color="claude" bold>
        {num}
      </Text>
      <Text color={spec.isPicked || pick === '◆' ? 'claude' : 'inactive'}> {pick} </Text>
      <Text inverse={spec.isSelected}>
        <Highlighted el={el} text={note.text} query={spec.query ?? ''} width={textWidth} isDim={spec.isHistory} />
      </Text>
      {!spec.isGrouped && <Text color={spec.isHistory ? 'inactive' : colourOf(note.project)}> ● </Text>}
      {!spec.isGrouped && <Text dimColor>{fit(note.project, 9)}</Text>}
      <Text dimColor>{note.age.padStart(5)}</Text>
    </Box>
  )
}

// ---- direction: mix (Quiet + Ledger, the picked one) ----
// Ledger's numbered rows and bold footer keys; Quiet's band-and-bar selection and coloured project
// word. No column header. Two rules only: heavy under the search, light above preview and footer.

const MixRow = ({ el, spec }: { el: E; spec: RowSpec }) => {
  const { Box, Text } = el
  const { note, width } = spec
  const num = spec.number !== undefined && spec.number <= 9 ? String(spec.number) : ' '
  const pick = spec.showPicks ? (spec.isPicked ? '●' : '○') : marker(spec)
  const right = spec.isGrouped ? ` ${note.age.padStart(4)}` : `${fit(note.project, 8).trimEnd().padStart(8)} ${note.age.padStart(4)}`
  const textWidth = width - 5 - right.length - 1
  return (
    <Box width={width} backgroundColor={spec.isSelected ? 'subtle' : undefined}>
      <Text color="claude">{spec.isSelected ? '▌' : ' '}</Text>
      <Text color={spec.isSelected ? undefined : 'claude'} bold>
        {num}
      </Text>
      <Text color={spec.isPicked || pick === '◆' ? 'claude' : 'inactive'}> {pick} </Text>
      <Highlighted el={el} text={note.text} query={spec.query ?? ''} width={textWidth} isDim={spec.isHistory} />
      <Text> </Text>
      {!spec.isGrouped && <Text color={spec.isHistory ? 'inactive' : colourOf(note.project)}>{fit(note.project, 8).trimEnd().padStart(8)}</Text>}
      <Text dimColor> {note.age.padStart(4)}</Text>
    </Box>
  )
}

const Row = ({ el, dir, spec }: { el: E; dir: Direction; spec: RowSpec }) =>
  dir === 'quiet' ? (
    <QuietRow el={el} spec={spec} />
  ) : dir === 'cards' ? (
    <CardsRow el={el} spec={spec} />
  ) : dir === 'mix' ? (
    <MixRow el={el} spec={spec} />
  ) : (
    <LedgerRow el={el} spec={spec} />
  )

// ---- header (search / capture) ----

type Header = { mode: 'search' | 'capture' | 'edit'; query: string; right: string; isFocused: boolean }

const HeaderLine = ({ el, dir, width, header }: { el: E; dir: Direction; width: number; header: Header }) => {
  const { Box, Text } = el
  const isCapture = header.mode === 'capture'
  const glyph = isCapture ? '✎' : '❯'
  const label = isCapture ? 'new note' : ''
  const caret = header.isFocused ? '▏' : ''
  const placeholder = isCapture ? 'write a note, ⏎ to save' : 'search notes'
  const content = (
    <Box width={dir === 'cards' ? width - 4 : width}>
      <Text color={isCapture ? 'claude' : header.isFocused ? 'claude' : 'inactive'} bold>
        {glyph}{' '}
      </Text>
      {label !== '' && (
        <Text color="claude" bold>
          {label}{' '}
        </Text>
      )}
      {header.query === '' ? (
        <Text dimColor>
          {caret}
          {placeholder}
        </Text>
      ) : (
        <Text bold={isCapture}>
          {header.query}
          {caret}
        </Text>
      )}
      {dir === 'mix' && header.mode === 'search' && header.isFocused && <Text dimColor> ⏎ to list</Text>}
      <Box flexGrow={1} />
      <Text dimColor>{header.right}</Text>
    </Box>
  )
  if (dir === 'cards') {
    return (
      <Box borderStyle="round" borderColor={isCapture ? 'claude' : header.isFocused ? 'promptBorder' : 'inactive'} paddingX={1} width={width}>
        {content}
      </Box>
    )
  }
  if (dir === 'ledger' || dir === 'mix') {
    return (
      <Box flexDirection="column" width={width}>
        {content}
        <Text dimColor>{'━'.repeat(width)}</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={width}>
      {content}
      <Text dimColor>{'─'.repeat(width)}</Text>
    </Box>
  )
}

const LedgerColumns = ({ el, width }: { el: E; width: number }) => {
  const { Text } = el
  return <Text dimColor>{`#   ${'note'.padEnd(width - 4 - 12 - 5)}  project     age`}</Text>
}

// ---- preview ----

const Preview = ({ el, dir, width, note }: { el: E; dir: Direction; width: number; note: Note }) => {
  const { Box, Text } = el
  const who = note.by === 'claude' ? '◆ claude' : note.by === 'phone' ? 'phone' : 'you'
  const meta = [who, PATHS[note.project] || 'unfiled', note.branch, `${note.age} ago`].filter(Boolean).join(' · ')
  const body = (
    <Box flexDirection="column">
      <Text wrap="wrap">{note.text}</Text>
      <Text dimColor>{meta}</Text>
    </Box>
  )
  if (dir === 'cards') {
    return (
      <Box borderStyle="round" borderColor="inactive" paddingX={1} width={width} flexDirection="column">
        {body}
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={width}>
      <Text dimColor>{(dir === 'ledger' ? '┄' : '─').repeat(width)}</Text>
      {body}
    </Box>
  )
}

// ---- footer ----

type Key = [string, string]
const SEARCH_KEYS: Key[] = [['ctrl+l', 'list view'], ['ctrl+s', 'scope'], ['ctrl+n', 'new'], ['ctrl+q', 'close']]
const ROW_KEYS: Key[] = [['v', 'pick'], ['t', 'to prompt'], ['s', 'send'], ['e', 'edit'], ['d', 'archive'], ['b', 'bundle'], ['l', 'list'], ['f', 'search'], ['i', 'keys']]

const Footer = ({ el, dir, width, keys, status, legend }: { el: E; dir: Direction; width: number; keys: Key[]; status?: string; legend?: string }) => {
  const { Box, Text } = el
  if (dir === 'cards') {
    const [first, second, ...rest] = keys
    return (
      <Box flexDirection="column" width={width}>
        <Box gap={1}>
          {[first, second].filter((key): key is Key => key !== undefined).map(([k, label]) => (
            <Text bold color="claude">
              [ {k} {label} ]
            </Text>
          ))}
          <Box flexGrow={1} />
          {status !== undefined && <Text color="claude">{status}</Text>}
        </Box>
        <Box flexWrap="wrap" columnGap={2}>
          {rest.map(([k, label]) => (
            <Text dimColor>
              {k} {label}
            </Text>
          ))}
          {legend !== undefined && <Text dimColor>{legend}</Text>}
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" width={width}>
      {dir === 'ledger' && <Text dimColor>{'━'.repeat(width)}</Text>}
      {dir === 'mix' && <Text dimColor>{'─'.repeat(width)}</Text>}
      <Box flexWrap="wrap" columnGap={2} width={width}>
        {status !== undefined && (
          <Text color="claude" bold>
            {status}
          </Text>
        )}
        {keys.map(([k, label]) => (
          <Text>
            <Text color={dir === 'quiet' ? 'claude' : undefined} bold={dir === 'ledger' || dir === 'mix'}>
              {k}
            </Text>
            <Text dimColor> {label}</Text>
          </Text>
        ))}
        {legend !== undefined && <Text dimColor>{legend}</Text>}
      </Box>
    </Box>
  )
}

// ---- group header (list view) ----

const GroupHeader = ({ el, dir, width, project, count, isFolded }: { el: E; dir: Direction; width: number; project: string; count: number; isFolded?: boolean }) => {
  const { Box, Text } = el
  const fold = isFolded ? '▸' : '▾'
  if (dir === 'cards') {
    return (
      <Box width={width}>
        <Text dimColor>{fold} </Text>
        <Pill el={el} project={project} />
        <Text dimColor> {count}</Text>
      </Box>
    )
  }
  if (dir === 'ledger') {
    const label = ` ${project} · ${count} `
    return (
      <Text>
        <Text dimColor>{fold}─</Text>
        <Text color={colourOf(project)}>{label}</Text>
        <Text dimColor>{'─'.repeat(Math.max(0, width - label.length - 2))}</Text>
      </Text>
    )
  }
  return (
    <Text>
      <Text dimColor>{fold} </Text>
      <Text color={colourOf(project)} bold>
        {project}
      </Text>
      {dir !== 'mix' && <Text dimColor> · {count}</Text>}
    </Text>
  )
}

// ---- views ----

type Ctx = { el: E; dir: Direction; width: number }

const rowsOf = (
  ctx: Ctx,
  notes: Note[],
  options: { selected?: string; picked?: string[]; query?: string; isHistory?: boolean; isGrouped?: boolean; firstNumber?: number } = {},
) =>
  notes.map((note, i) => (
    <Row
      el={ctx.el}
      dir={ctx.dir}
      spec={{
        note,
        width: ctx.width,
        number: (options.firstNumber ?? 1) + i,
        isSelected: note.id === options.selected,
        isPicked: options.picked?.includes(note.id),
        showPicks: (options.picked?.length ?? 0) > 0,
        query: options.query,
        isHistory: options.isHistory,
        isGrouped: options.isGrouped,
      }}
    />
  ))

const legendFor = (notes: Note[]) => (notes.some(note => note.by === 'claude') ? '◆ from Claude' : undefined)

const SearchView = (ctx: Ctx, query: string) => {
  const { Box, Text } = ctx.el
  const here = NOTES.filter(note => note.project === CURRENT)
  const found = query === '' ? here : matches(query)
  const scope = query === '' ? 'this project' : 'all'
  const total = query === '' ? here.length : NOTES.length
  const right = query === '' ? `${scope} · ${here.length} open` : `${scope} · ${found.length} of ${total}`
  return (
    <Box flexDirection="column" width={ctx.width}>
      <HeaderLine el={ctx.el} dir={ctx.dir} width={ctx.width} header={{ mode: 'search', query, right, isFocused: true }} />
      {ctx.dir === 'ledger' && <LedgerColumns el={ctx.el} width={ctx.width} />}
      {found.length === 0 ? (
        <Box flexDirection="column" paddingY={1}>
          <Text dimColor>No notes match. ⏎ saves it to cc.</Text>
        </Box>
      ) : (
        <Box flexDirection="column">{rowsOf(ctx, found, { query })}</Box>
      )}
      {found[0] !== undefined && <Preview el={ctx.el} dir={ctx.dir} width={ctx.width} note={found[0]} />}
      <Box height={1} />
      <Footer
        el={ctx.el}
        dir={ctx.dir}
        width={ctx.width}
        keys={found.length === 0 ? [['⏎', 'save as note'], ['ctrl+s', 'scope'], ['ctrl+q', 'close']] : SEARCH_KEYS}
        legend={legendFor(found)}
      />
    </Box>
  )
}

const GROUPS = ['cc', 'infra', 'api', 'unfiled']

const ListView = (ctx: Ctx, options: { folded?: string[]; history?: boolean; picked?: string[]; selected: string }) => {
  const { Box } = ctx.el
  let shown = 0
  const groups = GROUPS.map(project => {
    const notes = NOTES.filter(note => note.project === project)
    const history = options.history ? HISTORY.filter(note => note.project === project) : []
    const isFolded = options.folded?.includes(project)
    const firstNumber = shown + 1
    if (!isFolded) shown += notes.length + history.length
    return (
      <Box flexDirection="column">
        <GroupHeader el={ctx.el} dir={ctx.dir} width={ctx.width} project={project} count={notes.length} isFolded={isFolded} />
        {!isFolded && rowsOf(ctx, notes, { selected: options.selected, picked: options.picked, isGrouped: true, firstNumber })}
        {!isFolded && history.length > 0 && rowsOf(ctx, history, { selected: options.selected, isHistory: true, isGrouped: true, firstNumber: firstNumber + notes.length })}
      </Box>
    )
  })
  const selected = [...NOTES, ...HISTORY].find(note => note.id === options.selected)
  const picked = options.picked?.length ?? 0
  return (
    <Box flexDirection="column" width={ctx.width}>
      <HeaderLine
        el={ctx.el}
        dir={ctx.dir}
        width={ctx.width}
        header={{ mode: 'search', query: '', right: `list · all · ${NOTES.length} open${options.history ? ' + history' : ''}`, isFocused: false }}
      />
      <Box flexDirection="column" gap={ctx.dir === 'cards' ? 1 : 0}>
        {groups}
      </Box>
      {selected !== undefined && <Preview el={ctx.el} dir={ctx.dir} width={ctx.width} note={selected} />}
      <Box height={1} />
      <Footer
        el={ctx.el}
        dir={ctx.dir}
        width={ctx.width}
        keys={
          options.history
            ? [['u', 'restore'], ['h', 'hide history'], ['z', 'fold'], ['f', 'search']]
            : picked > 0
              ? [['b', 'bundle'], ['v', 'pick'], ['x', 'clear picks'], ['t', 'to prompt'], ['i', 'keys']]
              : [...ROW_KEYS.slice(0, 5), ['z', 'fold'], ['h', 'history'], ['i', 'keys']]
        }
        status={picked > 0 ? `${picked} picked` : undefined}
        legend={picked > 0 ? undefined : legendFor(NOTES)}
      />
    </Box>
  )
}

const BundleView = (ctx: Ctx) => {
  const { Box, Text } = ctx.el
  const picked = ['a', 'c', 'f'].map(id => NOTES.find(note => note.id === id)).filter((note): note is Note => note !== undefined)
  const prompt = [
    'Please look at these notes from my ostrakon:',
    '',
    ...picked.map(note => `- ${note.project === CURRENT ? '' : `[${note.project}] `}${note.text}`),
  ]
  return (
    <Box flexDirection="column" width={ctx.width}>
      <Box width={ctx.width}>
        <Text color="claude" bold>
          ⇢ bundle{' '}
        </Text>
        <Text>3 notes into one prompt</Text>
        <Box flexGrow={1} />
        <Text dimColor>1 from infra</Text>
      </Box>
      <Text dimColor>{'─'.repeat(ctx.width)}</Text>
      <Box borderStyle={ctx.dir === 'cards' ? 'round' : 'quote'} borderColor="inactive" paddingX={ctx.dir === 'cards' ? 1 : 0} flexDirection="column" width={ctx.width}>
        {prompt.map(line => (
          <Text wrap="wrap">{line === '' ? ' ' : line}</Text>
        ))}
      </Box>
      <Box height={1} />
      <Text dimColor>The picked notes are marked sent once the prompt goes in. Nothing is removed before.</Text>
      <Box height={1} />
      <Footer el={ctx.el} dir={ctx.dir} width={ctx.width} keys={[['⏎', 'send'], ['t', 'to prompt (edit first)'], ['x', 'back'], ['esc', 'close']]} />
    </Box>
  )
}

const CaptureView = (ctx: Ctx) => {
  const { Box, Text } = ctx.el
  const saved = ['check whether the hub needs a nightly backup cron', 'ask about arm runner minutes']
  return (
    <Box flexDirection="column" width={ctx.width}>
      <HeaderLine
        el={ctx.el}
        dir={ctx.dir}
        width={ctx.width}
        header={{ mode: 'capture', query: 'the inline pane only has 11 rows at 100 columns', right: 'cc', isFocused: true }}
      />
      <Box flexDirection="column" paddingY={1}>
        {saved.map(text => (
          <Text>
            <Text color="success">✓ </Text>
            <Text>{text}</Text>
            <Text dimColor> · just now</Text>
          </Text>
        ))}
      </Box>
      <Text dimColor>Notes save to cc. Keep typing for the next one.</Text>
      <Box height={1} />
      <Footer el={ctx.el} dir={ctx.dir} width={ctx.width} keys={[['⏎', 'save'], ['empty ⏎', 'back to search'], ['ctrl+s', 'project']]} />
    </Box>
  )
}

const EditView = (ctx: Ctx) => {
  const { Box, Text } = ctx.el
  const here = NOTES.filter(note => note.project === CURRENT)
  return (
    <Box flexDirection="column" width={ctx.width}>
      <HeaderLine el={ctx.el} dir={ctx.dir} width={ctx.width} header={{ mode: 'search', query: '', right: `this project · ${here.length} open`, isFocused: false }} />
      {rowsOf(ctx, here.slice(0, 1))}
      <Box width={ctx.width} borderStyle="round" borderColor="claude" flexDirection="column" paddingX={1}>
        <Text>
          <Text color="claude" bold>
            edit{' '}
          </Text>
          rename the store helpers to match the spec (createStore, change, scan) and the tests▏ ⏎ save
        </Text>
        <Box gap={2}>
          <Text>[ esc cancel ]</Text>
          <Text color="claude" bold>
            [ ⏎ save ]
          </Text>
          <Box flexGrow={1} />
          <Text dimColor>draft kept if the pane closes</Text>
        </Box>
      </Box>
      {rowsOf(ctx, here.slice(2), { firstNumber: 3 })}
      <Box height={1} />
      <Footer el={ctx.el} dir={ctx.dir} width={ctx.width} keys={[['⏎', 'save'], ['esc', 'close, draft kept']]} />
    </Box>
  )
}

const EmptyView = (ctx: Ctx) => {
  const { Box, Text } = ctx.el
  const ways: [string, string][] = [
    ['//', 'in the prompt, even mid-turn: // check the flaky test ⏎  (space first for a literal //)'],
    ['ctrl+x s', 'opens this pane, and keeps your prompt draft'],
    ['phone', 'my-server.ts.net: notes land here within seconds'],
    ['◆', 'Claude can leave notes for you'],
  ]
  return (
    <Box flexDirection="column" width={ctx.width}>
      <HeaderLine el={ctx.el} dir={ctx.dir} width={ctx.width} header={{ mode: 'search', query: '', right: 'this project · 0 open', isFocused: true }} />
      <Box flexDirection="column" paddingY={1} paddingX={2} borderStyle={ctx.dir === 'cards' ? 'round' : undefined} borderColor="inactive">
        <Text bold>Nothing pending in cc.</Text>
        <Box height={1} />
        {ways.map(([key, text]) => (
          <Text>
            <Text color="claude" bold>
              {key.padEnd(10)}
            </Text>
            <Text dimColor>{text}</Text>
          </Text>
        ))}
      </Box>
      <Footer el={ctx.el} dir={ctx.dir} width={ctx.width} keys={[['ctrl+n', 'new'], ['ctrl+s', 'scope'], ['ctrl+q', 'close']]} />
    </Box>
  )
}

const render = (ctx: Ctx, name: string) => {
  switch (name) {
    case 'search-empty':
      return SearchView(ctx, '')
    case 'search-typing':
      return SearchView(ctx, 'cache')
    case 'search-nomatch':
      return SearchView(ctx, 'kubernetes')
    case 'list-grouped':
      return ListView(ctx, { selected: 'b' })
    case 'list-folded':
      return ListView(ctx, { selected: 'b', folded: ['infra', 'api'] })
    case 'list-history':
      return ListView(ctx, { selected: 'x', history: true, folded: ['infra', 'api', 'unfiled'] })
    case 'picked':
      return ListView(ctx, { selected: 'f', picked: ['a', 'c', 'f'] })
    case 'bundle':
      return BundleView(ctx)
    case 'capture':
      return CaptureView(ctx)
    case 'edit':
      return EditView(ctx)
    default:
      return EmptyView(ctx)
  }
}

// ---- the band ----

const POCKET = NOTES.filter(note => note.project === CURRENT)
const POCKET_MANY: Note[] = [
  ...POCKET,
  ...['bump bun to 1.3 in the hub image', 'screenshot the inline pane at 100 cols', 'ask about arm runner minutes', 'tidy the fixture generator'].map(
    (text, i): Note => ({ id: `p${i}`, project: CURRENT, age: `${i + 3}d`, text }),
  ),
]
const chipLabel = (note: Note) => `${note.by === 'claude' ? '◆ ' : ''}${fit(note.text, 18).trimEnd()}`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'mock', description: 'mockups: /mock <quiet|cards|ledger|mix> <view>', immediate: true })
    await $.command.register({ name: 'mockband', description: 'mockups: /mockband <off|a|b> <pocket0|pocket3|pocket9|harvest>', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'mock' }, async ($, e) => {
    const [dir = 'quiet', name = 'search-empty'] = String(e.args).trim().split(/\s+/)
    await update($, direction, () => dir)
    await update($, view, () => (VIEWS.includes(name) ? name : 'search-empty'))
    const opened = await $.ui.open({ id: PANE, title: 'ostrakon', closeOnEscape: true })
    return { text: `mock ${dir} ${name} ${opened.isPlaced ? '' : opened.reason}` }
  })

  on('command.run', { command: 'mockband' }, async ($, e) => {
    const [style = 'off', which = 'pocket3'] = String(e.args).trim().split(/\s+/)
    await update($, band, () => (style === 'off' ? 'off' : `${style}:${which}`))
    return { text: `band ${style} ${which}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el = $.ui.resolve(e) as E
    const dir = (await read($, direction)) as Direction
    const name = await read($, view)
    return render({ el, dir, width: e.props.bodyColumns - 1 }, name)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const setting = await read($, band)
    if (setting === 'off' || e.surface !== 'terminal' || e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [style, which] = setting.split(':')
    const below = await next(e)
    if (which === 'harvest') {
      const proposals = [
        'retry ignores Retry-After on 429',
        'the arm runner image is 3 weeks old',
        'merge.ts has no test for tombstones',
      ]
      return (
        <Box flexDirection="column">
          {below}
          <Box gap={2}>
            <Text color="claude" bold>
              ◆ 3 notes from this turn
            </Text>
            {proposals.map((text, i) => (
              <Button key={`h${i}`} plain hotkey={String(i + 1)} label={fit(text, 22).trimEnd()} onPress={() => undefined} />
            ))}
            <Button key="h0" plain hotkey="0" label="keep all" onPress={() => undefined} />
            <Button key="hopen" plain label="✎" onPress={() => undefined} />
          </Box>
          <Text dimColor>1–3 keep one · 0 keep all · the rest wait in the pane under “proposed”</Text>
        </Box>
      )
    }
    const notes = which === 'pocket0' ? [] : which === 'pocket3' ? POCKET.slice(0, 3) : POCKET_MANY
    const shown = notes.slice(0, 5)
    const more = notes.length - shown.length
    if (style === 'b') {
      return (
        <Box flexDirection="column">
          {below}
          <Box gap={1}>
            <Text color={notes.length > 0 ? 'claude' : 'inactive'}>✎ {CURRENT}</Text>
            {notes.length > 0 && <Text dimColor>│</Text>}
            {shown.map((note, i) => (
              <Button key={`p${i}`} plain hotkey={String(i + 1)} label={chipLabel(note)} onPress={() => undefined} />
            ))}
            {more > 0 && <Text dimColor>+{more} more</Text>}
            <Box flexGrow={1} />
            <Text dimColor>{notes.length > 0 ? 'digit ⏎ to use' : 'ctrl+x s · // to jot'}</Text>
          </Box>
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {below}
        <Box gap={2}>
          {shown.map((note, i) => (
            <Button key={`p${i}`} plain hotkey={String(i + 1)} label={chipLabel(note)} onPress={() => undefined} />
          ))}
          {more > 0 && <Button key="more" plain dimColor label={`+${more}`} onPress={() => undefined} />}
          <Button key="open" plain label="✎" onPress={() => undefined} />
        </Box>
      </Box>
    )
  })
}
