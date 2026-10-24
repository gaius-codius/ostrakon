// Every visual constant of the pane and band (SPEC §4.1). The owner may still change the look;
// a change of look is meant to be an edit to this file alone.

export const GLYPH = {
  search: '❯',
  capture: '✎',
  bundle: '⇢',
  bar: '▌',
  claude: '◆',
  phone: '▪',
  picked: '●',
  unpicked: '○',
  sent: '↗',
  archived: '·',
  pastNine: '·',
  folded: '▸',
  saved: '✓',
  more: '…',
  enter: '⏎',
  newline: '↵',
  up: '↑',
  down: '↓',
  problem: '⚠',
  // The project dot before a name: another project's in its colour, unfiled hollow.
  dot: '●',
  unfiledDot: '○',
  // The bar down the left of quoted text: the preview and the bundle.
  quote: '▎',
} as const

// The empty pane's ostrakon, drawn dim beside the ways in.
export const SHARD = ['   ▁▁▁▁▁', '  ╱ ≡ ≈ ╲▁', ' ╱ ≈≡ ≈≡  ╲', ' ╲▁▁▁▁▁▁▁▁╱'] as const

// Theme keys follow light and dark. Projects take the palette instead, raw colours so the phone
// draws the same ones: server/public/app.js names them in this order and style.css holds the values
// (tools/check.sh fails when the three differ). Each reads at 4.5:1 on its theme's background. A
// 16-colour theme can't draw hex: projects take theme keys there, never `suggestion`, which a
// Button's hotkey digit is drawn in.
export const COLOUR = {
  accent: 'claude',
  band: 'subtle',
  unfiled: 'inactive',
  history: 'inactive',
  saved: 'success',
  problem: 'error',
  offline: 'warning',
  palette: [
    { name: 'teal', dark: '#4cc2b4', light: '#00756d' },
    { name: 'sky', dark: '#5aaeeb', light: '#1565a8' },
    { name: 'violet', dark: '#b08cf5', light: '#6f3fd1' },
    { name: 'magenta', dark: '#de7fe0', light: '#9b2ea6' },
    { name: 'pink', dark: '#f283ac', light: '#b52f68' },
    { name: 'gold', dark: '#e0bf4c', light: '#7f6400' },
    { name: 'lime', dark: '#a9cc55', light: '#4f7410' },
    { name: 'sand', dark: '#cfae86', light: '#7e5e38' },
  ],
  ansiPalette: ['success', 'merged', 'planMode', 'warning'],
} as const

export const WIDTH = {
  // Row columns: bar, number, space, marker, space.
  lead: 5,
  project: 8,
  age: 4,
  // Labels outside rows (group headers, the capture row, bundle lines).
  label: 24,
  previewLines: 6,
  // The key sheet at most, and its key column; narrower panes get a narrower sheet.
  keySheet: 46,
  sheetKey: 12,
  // The empty pane's shard column, and the key column beside it.
  shard: 13,
  wayKey: 10,
  // Footer pairs kept ahead of the legend; more show when the width allows (SPEC §4.6).
  footerPairs: 4,
  savedDocked: 3,
  savedInline: 1,
  // Band chips (SPEC §10): Pocket labels shorten from `chip` to `chipMin` before chips drop; a
  // label cuts at a word unless that leaves it under `chipMin`.
  chip: 24,
  chipMin: 10,
  harvestChip: 22,
} as const

// The band's keys (SPEC §10): `;` then a chip's digit, typed into an empty prompt. Never a lone
// digit, which answers Claude's numbered questions.
export const BAND_KEY = ';'
export const bandKey = (n: number) => `${BAND_KEY}${n}`

export const TEXT = {
  placeholder: 'search notes',
  toList: 'to list',
  captureLabel: 'new note',
  captureHint: (project: string) => `${GLYPH.enter} saves to ${project}`,
  targetLabel: 'save to',
  targetPlaceholder: 'type a project',
  noTarget: 'No project matches.',
  noMatch: (project: string) => `No notes match. ${GLYPH.enter} saves it to ${project}.`,
  bundleIntro: 'Please look at these notes from my ostrakon:',
  editHint: 'draft kept if the pane closes',
  // The edit box's buttons carry their keys, since that's where the eye is while editing.
  editBack: 'esc back',
  editSave: `${GLYPH.enter} save`,
  emptyTitle: (where: string) => `Nothing pending in ${where}.`,
  unfocused: [
    ['ctrl+x tab', 'focus'],
    ['ctrl+x s', 'close'],
  ] as [string, string][],
  legend: '◆ from Claude',
  keySheet: [
    ['↑ ↓ j k', 'move'],
    ['1–9', 'jump to a row'],
    ['⏎ / t', 'to prompt'],
    ['a / r', 'keep / dismiss'],
    ['s', 'send'],
    ['v / x', 'pick / clear picks'],
    ['b', 'bundle the picks'],
    ['e', 'edit'],
    ['d / u', 'archive / undo, restore'],
    ['m', 'move to a project'],
    ['y', 'copy'],
    ['h / z', 'history / fold'],
    ['f / ctrl+f', 'search'],
    ['n / ctrl+n', 'new note'],
    ['ctrl+s', 'scope, or pick a project'],
    ['esc', 'back, then to the prompt'],
    ['q / ctrl+q', 'close'],
    ['ctrl+x s', 'open / close'],
    ['ctrl+x i', 'keys, from a text field too'],
    ['ctrl+x tab', 'to the prompt and back'],
    ['//', 'jot from the prompt'],
  ] as [string, string][],
  // After the keys in the sheet, under `symbolsTitle`: what a row's marker means (DESIGN.md §5).
  symbolsTitle: 'symbols',
  symbolSheet: [
    [GLYPH.claude, 'from Claude'],
    [GLYPH.phone, 'from the phone'],
    [`${GLYPH.picked} ${GLYPH.unpicked}`, 'picked / not picked'],
    [GLYPH.sent, 'sent'],
    [GLYPH.archived, 'archived, or a row past 9'],
    [GLYPH.folded, 'folded group'],
  ] as [string, string][],
  keepAll: 'keep all',
  harvestTitle: `${GLYPH.claude} from this turn`,
  harvestShort: GLYPH.claude,
  harvestHint: (n: number) =>
    `${n === 0 ? '' : `${n === 1 ? bandKey(1) : `${bandKey(1)}–${bandKey(n)}`} keep one · `}${bandKey(0)} keep all · the rest wait in the pane under “proposed”`,
  // The hint shows under the first few harvests ever, then the row speaks for itself.
  harvestHintTimes: 3,
} as const

// The tail on the hint line under the prompt (SPEC §4.4): what a /jot draft will do, then that
// it did. The engine parts its line from the tail; `gap` parts ours from another mod's tail.
export const HINT = {
  gap: ' · ',
  capture: (project: string) => `${GLYPH.capture} ${GLYPH.enter} saves to ${project}`,
  saved: (project: string) => `${GLYPH.saved} saved to ${project}`,
} as const

// What Claude reads after a `/jot`: the command is in its transcript, so it learns the note is the
// person's own and needs nothing from it.
export const JOT_CONTEXT = 'The person saved that /jot as a note for themselves, and it is saved. It needs no reply or action.'

// How long a just-saved note stays drawn as new, and the saved tail stays up.
export const MS = { fresh: 2000, saved: 3000 } as const

export const TOAST = {
  archived: 'Archived · u undo',
  restored: 'Restored',
  copied: 'Copied',
  undone: 'Undone',
  nothingToUndo: 'Nothing to undo',
  pickFirst: 'Pick notes with v first',
  onlyOpen: 'Only open notes can be picked',
  pickDropped: (n: number) => `${n} pick${n === 1 ? '' : 's'} dropped: no longer open`,
  mentions: '@ mentions need the prompt: filled instead',
  notSent: (why: string) => `Not sent: ${why}`,
  inPrompt: (n: number) => `note ${n} in your prompt · ⏎ to send`,
  hasNewline: 'Contains ↵: edit the file instead (path copied)',
  moved: (project: string) => `Moved to ${project}`,
  failed: (why: string) => `Couldn't save: ${why}`,
  notFilled: "Couldn't put it in the prompt: the prompt is busy",
  kept: (n: number) => (n === 1 ? 'Kept' : `Kept ${n} notes`),
  // Claude's jot, harvest on or off (as v1).
  jotted: (text: string) => `${GLYPH.claude} Claude jotted: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`,
  claudeArchived: (text: string) => `${GLYPH.claude} Claude archived: ${text.length > 60 ? `${text.slice(0, 59)}…` : text}`,
} as const

// Borrowed engine actions (SPEC §2.2); the person binds the chords in their keybindings.
export const CHORD = {
  toggle: { action: 'app:cycleDiffBase', keys: 'ctrl+x s' },
  // Moves the keyboard between the pane and the prompt; it takes ctrl+x tab from the band. Not
  // app:toggleTerminal or app:toggleBrief: the engine's own handlers take those before a Button.
  switch: { action: 'app:openArtifact', keys: 'ctrl+x tab' },
  search: { action: 'app:toggleDiffNoiseFilter', keys: 'ctrl+f' },
  scope: { action: 'app:toggleDiffPreSession', keys: 'ctrl+s' },
  // Not the engine's pane:close: that close looks like Esc's to the mod, which makes Esc "back".
  close: { action: 'pane:previous', keys: 'ctrl+q' },
  new: { action: 'pane:next', keys: 'ctrl+n' },
  // `i` is typed into a text field, so the key sheet has a chord too. Not app:redraw: the engine's
  // own handler for it is always on and takes the key before the pane's Button.
  keys: { action: 'app:toggleReplTab', keys: 'ctrl+x i' },
} as const

// How the person's theme draws: `dark` and `light` take the palette's hex, `ansi` its theme keys.
export type Tone = 'dark' | 'light' | 'ansi'

// A theme's base as the engine names it; anything it doesn't know draws as dark, as there.
export const toneOf = (base: string): Tone => {
  if (base === 'dark-ansi' || base === 'light-ansi') return 'ansi'
  return base === 'light' || base === 'light-daltonized' ? 'light' : 'dark'
}

// Deterministic colour for a project: the current one is the accent, unfiled is grey. The phone
// hashes the same way.
export const colourOf = (key: string | null, current: string, tone: Tone) => {
  if (key === null) return COLOUR.unfiled
  if (key === current) return COLOUR.accent
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  if (tone === 'ansi') return COLOUR.ansiPalette[hash % COLOUR.ansiPalette.length] ?? COLOUR.ansiPalette[0]
  return (COLOUR.palette[hash % COLOUR.palette.length] ?? COLOUR.palette[0])[tone]
}
