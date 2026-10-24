export type NoteStatus = 'open' | 'proposed' | 'sent' | 'archived' | 'dismissed'

export type NoteBy = 'you' | 'claude' | 'phone'

// key is the normalized git remote (the same on every machine), or "path:<root>" without one.
export type NoteProject = { key: string; name: string; path: string }

export type NoteContext = {
  sessionId?: string
  branch?: string
  turnId?: string
  harvestOf?: string
  // The session a sent note went into (SPEC §5).
  sentSessionId?: string
}

export type Note = {
  id: string
  status: NoteStatus
  by: NoteBy
  created: string
  updated: string
  origin: string
  project: NoteProject | null
  context: NoteContext
  sentAt: string | null
  deleted: boolean
  text: string
  // Top-level front-matter lines this mod doesn't own (Obsidian's tags, aliases...), kept verbatim.
  extra: string[]
  // Lines under project: or context: that this mod doesn't own, kept verbatim.
  nestedExtra?: { project?: string[]; context?: string[] }
}

// A file under notes/ that couldn't be read as a note; it's skipped and never written over.
export type NoteProblem = { file: string; reason: string }

// The launcher pane's state (SPEC §4). Note ids, project keys and line keys only; the notes
// themselves live in `notes`.
export type PaneMode = 'browse' | 'capture' | 'edit' | 'bundle' | 'move' | 'sheet'

export type Undo =
  | { kind: 'status'; id: string; before: NoteStatus }
  | { kind: 'text'; id: string; before: string }
  | { kind: 'project'; id: string; before: NoteProject | null }
  | { kind: 'picks'; before: string[] }

export type PaneState = {
  mode: PaneMode
  query: string
  // 'project' or 'all'; `scopeChosen` once ctrl+s picked one, until the pane closes.
  scope: 'project' | 'all'
  scopeChosen: boolean
  history: boolean
  // Folded groups by group key (a project key, 'unfiled' or 'proposed').
  folded: string[]
  picks: string[]
  // The selected line: a note id, 'group:<key>' or 'problem'; null while nothing is selected.
  cursor: string | null
  // Where the pane's focus ring is: the search field, a line, another control, or nowhere.
  focus: 'search' | 'line' | 'control' | 'none'
  // The first line drawn (rows are paged by the mod, SPEC §4.8).
  offset: number
  // The key sheet's page, from 0, while it's paged to fit the body.
  sheetPage: number
  // The text field the key sheet was opened from, which it hands the keys back to; null off a row.
  sheetFrom: 'search' | 'capture' | 'edit' | null
  edit: { id: string; draft: string } | null
  // The note a move (m) applies to, fixed when the Select opens.
  moving: string | null
  capture: { draft: string; target: string | null; saved: string[]; error: string | null }
  // The person's prompt draft, held while the pane has the keyboard (SPEC §4.4).
  stash: string
  // What the pane put into the prompt since the last submit, so a submit containing a fill's text
  // marks its notes sent.
  fills: Fill[]
  undo: Undo[]
}

export type Fill = { text: string; ids: string[] }

export type SyncState = { isOn: boolean; isOnline: boolean; queued: number; problem: string }

declare module 'claude-code' {
  interface PluginState {
    ostrakon: {
      isOpen: boolean
      notes: Record<string, Note>
      problems: NoteProblem[]
      pane: PaneState
      // The proposals of the last turn that left some, and the turn they belong to (its prompt's
      // turn) with that turn's order (SPEC §10). The band shows them only while that turn is the latest.
      harvest: Shaped<{ turnId: string; generation: number; seq: number; ids: string[] } | null>
      // The latest prompt's turn in this conversation ('' after /clear or /resume), and the main
      // turn running ('' between turns): what the band's harvest is drawn against.
      turns: Shaped<{ latest: string; latestOrder: { generation: number; seq: number }; running: string; generation: number; seq: number }>
      // The hub's sync status (SPEC §9.4); isOn false when no hub is configured.
      sync: SyncState
      // The mirror folder's sync status (SPEC §7.2); isOn false when no mirror is configured.
      mirror: SyncState
      // Whether the prompt's draft leads with `/jot `, as prompt.edit last saw it (SPEC §4.4).
      isJotDraft: boolean
      // When the last /jot save landed, while the hint line still says so; 0 otherwise.
      savedAt: number
      // The note just saved, whose band chip draws fresh for a moment; '' when none (SPEC §10).
      fresh: string
      // The turn whose harvest carries the dim hint line: one of the first few harvests ever.
      harvestHint: string
    }
  }
}
