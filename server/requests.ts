// Requests to file a note as a GitHub issue (SPEC §9.2 Filing): the phone asks, the hub drafts,
// the person approves the exact draft, the hub files it. Each request is its own record, kept
// apart from the note: it holds a snapshot of the note as it was asked for, and stays when the
// note is archived, deleted or purged. Every move between states is checked and made in one
// transaction, so two callers can't both take the same step.

import type { Database } from 'bun:sqlite'

import type { Note, NoteProject } from '../plugin/types'

export const STATES = ['waiting', 'drafting', 'drafted', 'approved', 'filing', 'filed', 'failed', 'unsure', 'discarded'] as const
export type RequestState = (typeof STATES)[number]
// Open is every state but these two: a note has at most one open request.
const CLOSED: RequestState[] = ['filed', 'discarded']
export const isOpen = (state: RequestState) => !CLOSED.includes(state)

export type Draft = { title: string; body: string; labels: string[] }

export type FilingRequest = {
  id: string
  note: string
  // The note's text and project when it was asked for: drafting reads these, never the note.
  text: string
  project: NoteProject
  repo: string // owner/repo, from the project key
  public: boolean
  state: RequestState
  phase: 'draft' | 'file' | null // where a `failed` request failed
  revision: number // counts drafts; filing names the one the person read
  draft: Draft | null
  issue: string | null
  error: string | null
  created: string
  updated: string
  // Counts up with every change to the request (the hub's change counter): what a client compares
  // to know which of two copies is newer, and what a person's step names when it depends on what
  // they saw.
  seq: number
}

// What the hub needs from outside to draft and file (#110 runs `claude` and `gh`; tests stub it).
// Filing is on only when the hub was given one.
export type Filing = {
  // The repos the hub may file to, and whether each is public; `error` says which it left out
  // because it couldn't tell whether it may file there.
  repos: () => Promise<{ repos: { repo: string; public: boolean }[]; error?: string }>
  draft: (request: FilingRequest) => Promise<Draft>
  // Each call has its own deadline (#110): the hub runs one request at a time and waits for it.
  // Returns the new issue's URL. Throws NotCreated only when GitHub said it created nothing; any
  // other failure leaves it unknown whether the issue exists.
  file: (request: FilingRequest & { draft: Draft }) => Promise<string>
  // The URL of the issue carrying the request's `ostrakon: <id>` marker, or null.
  find: (request: FilingRequest) => Promise<string | null>
}

export class NotCreated extends Error {}

// A GitHub issue URL, trimmed, and the repo it names.
const ISSUE_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/[1-9]\d*$/
export const issueUrl = (url: string) => (ISSUE_URL.test(url.trim()) ? url.trim() : null)
// One the person pasted for a request to `repo`: in that repo, so a slip of the paste is caught.
export const issueUrlIn = (repo: string, url: string) => {
  const match = ISSUE_URL.exec(url.trim())
  return match?.[1] !== undefined && match[1].toLowerCase() === repo.toLowerCase() ? url.trim() : null
}

// Short, one line: what the phone shows as a request's error. Token-like strings are removed, so
// what gh or claude said never shows a credential: GitHub's (ghp_, github_pat_, gho_…),
// Anthropic's (sk-ant-…), and any other run of 32 or more letters, digits, _ and -.
const MAX_ERROR = 300
const TOKEN_LIKE = /\b(?:gh[a-z]_|github_pat_|sk-ant-)[A-Za-z0-9_-]+|[A-Za-z0-9_-]{32,}/g
export const shortError = (error: unknown) => {
  const text = (error instanceof Error ? error.message : String(error)).replace(TOKEN_LIKE, '[redacted]').replace(/\s+/g, ' ').trim() || 'unknown error'
  return text.length > MAX_ERROR ? `${text.slice(0, MAX_ERROR - 1)}…` : text
}

type Row = {
  id: string
  note: string
  text: string
  project: string
  repo: string
  public: number
  state: RequestState
  phase: 'draft' | 'file' | null
  revision: number
  draft: string | null
  issue: string | null
  error: string | null
  created: string
  updated: string
  seq: number
}

const fromRow = (row: Row): FilingRequest => ({
  id: row.id,
  note: row.note,
  text: row.text,
  project: JSON.parse(row.project) as NoteProject,
  repo: row.repo,
  public: row.public === 1,
  state: row.state,
  phase: row.phase,
  revision: row.revision,
  draft: row.draft === null ? null : (JSON.parse(row.draft) as Draft),
  issue: row.issue,
  error: row.error,
  created: row.created,
  updated: row.updated,
  seq: row.seq,
})

// A draft as the hub keeps it; anything else fails the draft (#110 holds it to the repo's rules).
export const isDraft = (value: unknown): value is Draft => {
  const draft = value as Draft
  return (
    typeof draft === 'object' &&
    draft !== null &&
    typeof draft.title === 'string' &&
    draft.title.trim() !== '' &&
    typeof draft.body === 'string' &&
    Array.isArray(draft.labels) &&
    draft.labels.every(label => typeof label === 'string')
  )
}

// What a step answers: the request after it, `refused` (the request is left as it was) or `missing`.
export type Outcome = { kind: 'ok'; request: FilingRequest } | { kind: 'refused'; request: FilingRequest; reason: string } | { kind: 'missing' }

// `nextSeq` hands out the hub's change counter, shared with the notes, so the long poll wakes for
// a request too; `newId` and `now` are the hub's.
export const openRequests = (db: Database, { nextSeq, newId, now }: { nextSeq: () => number; newId: () => string; now: () => number }) => {
  db.run(
    `CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, note TEXT NOT NULL, text TEXT NOT NULL, project TEXT NOT NULL, repo TEXT NOT NULL,
      public INTEGER NOT NULL, state TEXT NOT NULL, phase TEXT, revision INTEGER NOT NULL, draft TEXT,
      issue TEXT, error TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, seq INTEGER NOT NULL)`,
  )
  // The database itself holds a note to one open request.
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS requests_open ON requests (note) WHERE state NOT IN ('filed', 'discarded')`)
  db.run('CREATE INDEX IF NOT EXISTS requests_seq ON requests (seq)')

  const byId = db.query<Row, [string]>('SELECT * FROM requests WHERE id = ?')
  const openFor = db.query<Row, [string]>(`SELECT * FROM requests WHERE note = ? AND state NOT IN ('filed', 'discarded')`)
  const inState = db.query<Row, [string]>('SELECT * FROM requests WHERE state = ? ORDER BY created, id')
  const filedFor = db.query<Row, [string]>(`SELECT * FROM requests WHERE note = ? AND state = 'filed' ORDER BY seq DESC LIMIT 1`)
  const openAll = db.query<Row, []>(`SELECT * FROM requests WHERE state NOT IN ('filed', 'discarded') ORDER BY created, id`)
  const sinceSeq = db.query<Row, [number, number]>('SELECT * FROM requests WHERE seq > ? AND seq <= ? ORDER BY seq')
  const maxSeq = db.query<{ seq: number | null }, []>('SELECT max(seq) AS seq FROM requests')
  const insert = db.query(
    `INSERT INTO requests (id, note, text, project, repo, public, state, phase, revision, draft, issue, error, created, updated, seq)
     VALUES (?, ?, ?, ?, ?, ?, 'waiting', NULL, 0, NULL, NULL, NULL, ?, ?, ?)`,
  )
  const write = db.query('UPDATE requests SET state = ?, phase = ?, revision = ?, draft = ?, issue = ?, error = ?, updated = ?, seq = ? WHERE id = ?')

  const get = (id: string) => {
    const row = byId.get(id)
    return row ? fromRow(row) : undefined
  }

  // Moves request `id` from one of `from` to `to`, with `fields` changed; anything else is refused
  // and changes nothing.
  const move = db.transaction(
    (
      id: string,
      from: RequestState[],
      to: RequestState,
      fields: Partial<Pick<FilingRequest, 'phase' | 'revision' | 'draft' | 'issue' | 'error'>> = {},
    ): Outcome => {
      const request = get(id)
      if (!request) return { kind: 'missing' }
      if (!from.includes(request.state)) return { kind: 'refused', request, reason: `the request is ${request.state}` }
      const next: FilingRequest = { ...request, phase: null, error: null, ...fields, state: to, updated: new Date(now()).toISOString(), seq: nextSeq() }
      write.run(next.state, next.phase, next.revision, next.draft && JSON.stringify(next.draft), next.issue, next.error, next.updated, next.seq, id)
      return { kind: 'ok', request: next }
    },
  )

  // A new `waiting` request for `note` in `repo`, or the open one it already has.
  const create = db.transaction((note: Note, repo: string, isPublic: boolean): FilingRequest => {
    const open = openFor.get(note.id)
    if (open) return fromRow(open)
    const project = note.project as NoteProject
    const id = newId()
    const at = new Date(now()).toISOString()
    insert.run(id, note.id, note.text, JSON.stringify(project), repo, isPublic ? 1 : 0, at, at, nextSeq())
    return get(id) as FilingRequest
  })

  // A step the person repeats returns the request as it is: `done` names the states that mean the
  // step already happened.
  const repeatable = (outcome: Outcome, done: RequestState[]): Outcome =>
    outcome.kind === 'refused' && done.includes(outcome.request.state) ? { kind: 'ok', request: outcome.request } : outcome

  return {
    get,
    create,
    openFor: (note: string) => {
      const row = openFor.get(note)
      return row ? fromRow(row) : undefined
    },
    // The note's latest filed request, if it has one.
    filedFor: (note: string) => {
      const row = filedFor.get(note)
      return row ? fromRow(row) : undefined
    },
    open: () => openAll.all().map(fromRow),
    inState: (state: RequestState) => inState.all(state).map(fromRow),
    // Requests changed after seq `after`, up to `upTo`; from 0, the open ones only (a client
    // starting over needs nothing that's finished).
    since: (after: number, upTo: number) =>
      sinceSeq
        .all(after, upTo)
        .map(fromRow)
        .filter(request => after > 0 || isOpen(request.state)),
    maxSeq: () => maxSeq.get()?.seq ?? 0,

    // The hub's steps.
    startDraft: (id: string) => move(id, ['waiting'], 'drafting'),
    drafted: (id: string, draft: Draft) => {
      const request = get(id)
      return move(id, ['drafting'], 'drafted', { draft, revision: (request?.revision ?? 0) + 1 })
    },
    draftFailed: (id: string, error: string) => move(id, ['drafting'], 'failed', { phase: 'draft', error }),
    startFile: (id: string) => move(id, ['approved'], 'filing'),
    filed: (id: string, issue: string) => move(id, ['filing'], 'filed', { issue }),
    // Found by its marker after an unsure filing: also when the person said Not filed meanwhile,
    // so the runner doesn't file it a second time.
    found: (id: string, issue: string) => move(id, ['unsure', 'approved'], 'filed', { issue }),
    fileFailed: (id: string, error: string) => move(id, ['filing'], 'failed', { phase: 'file', error }),
    fileUnsure: (id: string, error: string) => move(id, ['filing'], 'unsure', { error }),
    // A restart: a draft that was running starts again; a filing that was running may have
    // created the issue, so it's never tried again on its own.
    recover: db.transaction(() => {
      for (const request of inState.all('drafting')) move(request.id, ['drafting'], 'waiting')
      for (const request of inState.all('filing')) move(request.id, ['filing'], 'unsure', { error: 'the hub restarted while filing' })
    }),

    // The person's steps.
    approve: (id: string, revision: number): Outcome => {
      const request = get(id)
      if (request?.state === 'drafted' && request.revision !== revision)
        return { kind: 'refused', request, reason: `draft ${revision} is not the current draft (${request.revision})` }
      // Filing the same revision again is a repeat; filing an older one after it is not.
      if (request && ['approved', 'filing', 'filed', 'unsure'].includes(request.state) && request.revision !== revision)
        return { kind: 'refused', request, reason: `draft ${revision} is not the draft being filed (${request.revision})` }
      return repeatable(move(id, ['drafted'], 'approved'), ['approved', 'filing', 'filed', 'unsure'])
    },
    // Names the draft it replaces, as filing does: a stale tap doesn't throw away a newer draft.
    redraft: (id: string, revision: number): Outcome => {
      const request = get(id)
      if (request && request.revision !== revision)
        return { kind: 'refused', request, reason: `draft ${revision} is not the current draft (${request.revision})` }
      return repeatable(move(id, ['drafted'], 'waiting'), ['waiting', 'drafting'])
    },
    // Any state the hub isn't working on. An approved one only before filing claims it; an unsure
    // one is the person's to handle from then on (the issue may exist), and the hub stops looking.
    discard: (id: string) => repeatable(move(id, ['waiting', 'drafted', 'failed', 'approved', 'unsure'], 'discarded'), ['discarded']),
    retry: (id: string): Outcome => {
      const request = get(id)
      if (request?.state === 'failed') return move(id, ['failed'], request.phase === 'file' ? 'approved' : 'waiting')
      return repeatable(move(id, ['failed'], 'waiting'), ['waiting', 'drafting', 'approved', 'filing'])
    },
    // The person checked GitHub after an unsure filing; `seq` names the unsure state they saw, so a
    // late repeat can't approve a later filing attempt that also went unanswered.
    notFiled: (id: string, seq: number): Outcome => {
      const request = get(id)
      if (request?.state === 'unsure' && request.seq !== seq) return { kind: 'refused', request, reason: 'the request changed since; check GitHub again' }
      return repeatable(move(id, ['unsure'], 'approved'), ['approved', 'filing'])
    },
    foundFiled: (id: string, issue: string) => {
      const request = get(id)
      if (request?.state === 'filed' && request.issue === issue) return { kind: 'ok', request } as Outcome
      return move(id, ['unsure'], 'filed', { issue })
    },
  }
}

export type Requests = ReturnType<typeof openRequests>
