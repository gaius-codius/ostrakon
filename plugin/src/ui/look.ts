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
export const SHARD = ['  ▁▁▁▁▁', ' ╱  ✎  ╲▁', ' ╲▁▁▁▁▁▁╱'] as const

// Theme keys only: they follow light and dark. `permission` is left out because it matches
// `suggestion` in the light theme; `warning` because a project shouldn't read as an alarm.
export const COLOUR = {
  accent: 'claude',
  band: 'subtle',
  unfiled: 'inactive',
  history: 'inactive',
  saved: 'success',
  problem: 'error',
  offline: 'warning',
  palette: ['suggestion', 'success', 'merged', 'planMode', 'autoAccept'],
} as const

export const WIDTH = {
  // Row columns: bar, number, space, marker, space.
  lead: 5,
  project: 8,
  age: 4,
  // Labels outside rows (group headers, the capture row, bundle lines).
  label: 24,
  previewLines: 6,
  keySheet: 46,
  // The empty pane's shard column, and the key column beside it.
  shard: 13,
  wayKey: 10,
  // Footer pairs beside `i keys` (SPEC §4.6).
  footerPairs: 4,
  savedDocked: 3,
  savedInline: 1,
  // Band chips (SPEC §10): Pocket labels shorten from `chip` to `chipMin` before chips drop; a
  // label cuts at a word unless that leaves it under `chipMin`.
  chip: 24,
  chipMin: 10,
  harvestChip: 22,
} as const

export const TEXT = {
  placeholder: 'search notes',
  toList: 'to list',
  captureLabel: 'new note',
  captureHint: (project: string) => `Notes save to ${project}. Keep typing for the next one.`,
  noMatch: (query: string, where: string) => [`No notes match “${query}” in ${where}.`, `saves “${query}” as a new note in`] as const,
  bundleIntro: 'Please look at these notes from my ostrakon:',
  bundleNote: 'The picked notes are marked sent once the prompt goes in. Nothing is removed before.',
  editHint: 'draft kept if the pane closes',
  emptyTitle: (project: string) => `Nothing pending in ${project}.`,
  unfocused: [
    ['ctrl+x tab', 'focus'],
    ['ctrl+x s', 'close'],
  ] as [string, string][],
  legend: '◆ from Claude',
  keepAll: 'keep all',
  harvestTitle: `${GLYPH.claude} from this turn`,
  harvestShort: GLYPH.claude,
  harvestHint: (n: number) => `${n === 0 ? '' : `${n === 1 ? '1' : `1–${n}`} keep one · `}0 keep all · the rest wait in the pane under “proposed”`,
  // The hint shows under the first few harvests ever, then the row speaks for itself.
  harvestHintTimes: 3,
} as const

// The tail on the hint line under the prompt (SPEC §4.4): what a /jot draft will do, then that
// it did. `gap` parts it from the engine's line (the engine draws the tail dim, right after it).
export const HINT = {
  gap: ' · ',
  capture: (project: string) => `${GLYPH.capture} ${GLYPH.enter} saves to ${project}, Claude won't see it`,
  saved: (project: string) => `${GLYPH.saved} saved to ${project}`,
} as const

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
} as const

// Borrowed engine actions (SPEC §2.2); the person binds the chords in their keybindings.
export const CHORD = {
  toggle: { action: 'app:cycleDiffBase', keys: 'ctrl+x s' },
  search: { action: 'app:toggleDiffNoiseFilter', keys: 'ctrl+f' },
  scope: { action: 'app:toggleDiffPreSession', keys: 'ctrl+s' },
  // Not the engine's pane:close: that close looks like Esc's to the mod, which makes Esc "back".
  close: { action: 'pane:previous', keys: 'ctrl+q' },
  list: { action: 'app:toggleReplTab', keys: 'ctrl+l' },
  new: { action: 'pane:next', keys: 'ctrl+n' },
} as const

// Deterministic colour for a project: the current one is the accent, unfiled is grey.
export const colourOf = (key: string | null, current: string) => {
  if (key === null) return COLOUR.unfiled
  if (key === current) return COLOUR.accent
  let hash = 0
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLOUR.palette[hash % COLOUR.palette.length] ?? COLOUR.palette[0]
}
