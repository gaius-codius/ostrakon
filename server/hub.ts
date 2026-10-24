// The ostrakon hub (SPEC §9): one SQLite table of notes, merged with the mod's own rules, a
// long-poll change feed, and the phone form. Bound to 127.0.0.1; `tailscale serve` is the way in.
//
//   HUB_PORT   port on 127.0.0.1 (default 8790)
//   HUB_DATA   folder for hub.sqlite and its backups (default ~/.local/share/ostrakon-hub)
//   HUB_TOKEN  bearer token every /api call carries
//   HUB_LOGIN  a Tailscale login allowed without the token (the Tailscale-User-Login header
//              `serve` adds; absent for requests from tagged devices). Any process on this host
//              can send that header to 127.0.0.1 itself, so set it only where every local user
//              is trusted; writes it authorizes must come from the hub's own page (no foreign
//              Origin).
//
// `bun server/hub.ts pair [--token] [url]` (or `ostrakon pair`, bin/ostrakon) asks the hub running on this host for a one-time
// pairing code and prints a QR code of the phone's `?pair=` link (needs HUB_TOKEN and `qrencode`), then exits; the url is the hub's
// public https address (default: this Tailscale node). `--token` prints the old `?token=` link instead, which carries the token itself.

import { Database } from 'bun:sqlite'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Note } from '../plugin/types'
import { parseNote, serializeNote } from '../plugin/src/frontmatter'
import { PURGE_AFTER_MS, isPurgeable, nextStamp, winner } from '../plugin/src/merge'
import { ulid } from '../plugin/src/ulid'
import manifest from '../plugin/.claude-plugin/plugin.json'

// The release this hub is, from the mod's manifest (one version for the repo); shown on /healthz.
export const VERSION: string = manifest.version

const MAX_WAIT_S = 25
// What /api/jot takes as a note's source, kept to what reads as a host name in `origin`.
const SOURCE = /^[A-Za-z0-9._-]{1,64}$/
const MAX_BATCH = 500
const KEEP_BACKUPS = 7
export const PAIR_TTL_MS = 5 * 60 * 1000
const MAX_PAIR_CODES = 10
const PUBLIC = join(import.meta.dir, 'public')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

// A note as it arrives (JSON from the mod, the phone or a Shortcut), held to the file format:
// whatever doesn't survive a write and a read back as the same note is refused.
export const toNote = (value: unknown): Note => {
  if (typeof value !== 'object' || value === null) throw new Error('not an object')
  const v = value as Record<string, unknown>
  const note = {
    id: v.id,
    status: v.status,
    by: v.by,
    created: v.created,
    updated: v.updated,
    origin: v.origin,
    project: v.project ?? null,
    context: v.context ?? {},
    sentAt: v.sentAt ?? null,
    deleted: v.deleted ?? false,
    text: v.text,
    extra: v.extra ?? [],
    ...(v.nestedExtra === undefined ? {} : { nestedExtra: v.nestedExtra }),
  } as Note
  if (typeof note.text !== 'string') throw new Error('text: expected a string')
  if (!Array.isArray(note.extra) || !note.extra.every(line => typeof line === 'string')) throw new Error('extra: expected lines')
  const read = parseNote(serializeNote(note))
  if (serializeNote(read) !== serializeNote(note)) throw new Error('note does not round-trip through the file format')
  return read
}

export const openHub = (dataDir: string) => {
  mkdirSync(dataDir, { recursive: true })
  const db = new Database(join(dataDir, 'hub.sqlite'), { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run('CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, doc TEXT NOT NULL, updated TEXT NOT NULL, origin TEXT NOT NULL, seq INTEGER NOT NULL)')
  db.run('CREATE INDEX IF NOT EXISTS notes_seq ON notes (seq)')
  // The highest seq ever handed out, kept apart from the notes: a purge can remove the row that
  // held it, and the cursor must still never move back.
  db.run('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL)')
  const getOne = db.query<{ doc: string }, [string]>('SELECT doc FROM notes WHERE id = ?')
  const since = db.query<{ doc: string; seq: number }, [number, number]>('SELECT doc, seq FROM notes WHERE seq > ? ORDER BY seq LIMIT ?')
  const maxSeq = db.query<{ seq: number | null }, []>('SELECT max(seq) AS seq FROM notes')
  const put = db.query('INSERT OR REPLACE INTO notes (id, doc, updated, origin, seq) VALUES (?, ?, ?, ?, ?)')
  const all = db.query<{ doc: string }, []>('SELECT doc FROM notes')
  const drop = db.query('DELETE FROM notes WHERE id = ?')
  // Names this run of the hub: a client that sees it change (a restart, a restore from backup, a
  // wiped database) can no longer trust its cursor or what it thinks the hub holds, and starts over.
  const hubId = crypto.randomUUID()

  const getSeq = db.query<{ value: number }, []>("SELECT value FROM meta WHERE key = 'seq'")
  const putSeq = db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('seq', ?)")
  let cursor = Math.max(maxSeq.get()?.seq ?? 0, getSeq.get()?.value ?? 0)
  // Recorded at once: a database from before the meta table has its high-water mark only in a row
  // that a purge may remove.
  putSeq.run(cursor)
  const waiters = new Set<() => void>()
  const wake = () => {
    for (const resolve of waiters) resolve()
    waiters.clear()
  }

  // Each note merged with the stored copy (SPEC §6.3); the winner is stored, and gets a new seq
  // only when it differs from what was there. Resolves the winners in the order given.
  const upsert = db.transaction((incoming: Note[]) => {
    const winners: Note[] = []
    for (const note of incoming) {
      const row = getOne.get(note.id)
      const stored = row ? (JSON.parse(row.doc) as Note) : undefined
      const best = stored ? winner(stored, note) : note
      if (!stored || serializeNote(best) !== serializeNote(stored)) {
        cursor += 1
        putSeq.run(cursor)
        put.run(best.id, JSON.stringify(best), best.updated, best.origin, cursor)
      }
      winners.push(best)
    }
    return winners
  })

  const push = (incoming: Note[]) => {
    const before = cursor
    const winners = upsert(incoming)
    if (cursor !== before) wake()
    return winners
  }

  const changes = (after: number, limit = MAX_BATCH) => {
    const rows = since.all(after, limit)
    return { hub: hubId, notes: rows.map(row => JSON.parse(row.doc) as Note), cursor: rows.length === limit ? (rows.at(-1)?.seq ?? cursor) : cursor }
  }

  // Resolves once something past `after` exists, or after `ms`.
  const waitFor = (after: number, ms: number) =>
    new Promise<void>(resolve => {
      if (cursor > after || ms <= 0) return resolve()
      const done = () => {
        clearTimeout(timer)
        waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      waiters.add(done)
    })

  // Projects the notes name, most recently active first.
  const projects = () => {
    const latest = new Map<string, { key: string; name: string; path: string; updated: string }>()
    for (const row of all.all()) {
      const note = JSON.parse(row.doc) as Note
      if (note.deleted || !note.project) continue
      const seen = latest.get(note.project.key)
      if (!seen || seen.updated < note.updated) latest.set(note.project.key, { ...note.project, updated: note.updated })
    }
    return [...latest.values()].sort((a, b) => (a.updated < b.updated ? 1 : -1))
  }

  // Tombstones past their keep time (SPEC §6.3) leave the table; seqs never move back.
  const purge = (now = Date.now()) => {
    let purged = 0
    for (const row of all.all()) {
      const note = JSON.parse(row.doc) as Note
      if (isPurgeable(note, now)) {
        drop.run(note.id)
        purged += 1
      }
    }
    return purged
  }

  // One consistent copy of the database, kept for a week.
  const backup = (now = new Date()) => {
    const dir = join(dataDir, 'backups')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `hub-${now.toISOString().slice(0, 10)}.sqlite`)
    rmSync(file, { force: true })
    db.run(`VACUUM INTO '${file.replaceAll("'", "''")}'`)
    const old = readdirSync(dir)
      .filter(name => /^hub-\d{4}-\d\d-\d\d\.sqlite$/.test(name))
      .sort()
      .slice(0, -KEEP_BACKUPS)
    for (const name of old) rmSync(join(dir, name), { force: true })
    return file
  }

  return { push, changes, waitFor, projects, purge, backup, id: hubId, cursor: () => cursor, close: () => db.close() }
}

export type Hub = ReturnType<typeof openHub>

// Compares a secret in time that doesn't depend on where the first difference is.
const sameText = (a: string, b: string) => {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)]
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const handler = (hub: Hub, auth: { token?: string; login?: string }, { now = Date.now }: { now?: () => number } = {}) => {
  const seenLogins = new Set<string>()
  // One-time pairing codes (code → expiry ms), in memory only: a restart drops them all, which is fine for codes that live 5 minutes.
  const codes = new Map<string, number>()
  const expire = () => {
    for (const [code, expires] of codes) if (expires <= now()) codes.delete(code)
  }
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    const path = url.pathname
    if (path === '/healthz') return new Response(`ok ${VERSION}\n`)

    if (!path.startsWith('/api/')) {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 })
      // A release's page asks for its scripts, styles and fonts under v<release>/ (index.html, sw.js),
      // so it never runs with another release's copies from the phone's cache; they're the same files.
      const name = path === '/' ? 'index.html' : path.slice(1).replace(/^v\d+\//, '')
      // A file in public/, or in one of its folders (fonts/, vendor/); no part may start with a dot.
      if (!/^(?:[a-z0-9][a-z0-9_-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) return new Response('not found', { status: 404 })
      const file = Bun.file(join(PUBLIC, name))
      if (!(await file.exists())) return new Response('not found', { status: 404 })
      // iOS gives a Home Screen app storage of its own: its start URL carries the token, for the
      // right token only. Safari reads the manifest link as the page loads, so the page opened with
      // the token links the manifest with it from the start (docs/phone.md).
      const asked = url.searchParams.get('token')
      const isRight = asked !== null && auth.token !== undefined && auth.token !== '' && sameText(asked, auth.token)
      if (name === 'index.html' || name === 'manifest.json') {
        console.log(
          `${name === 'index.html' ? 'page' : 'manifest'}: token ${asked === null ? 'none' : isRight ? 'ok' : 'wrong'} from ${request.headers.get('user-agent')?.slice(0, 80) ?? 'unknown agent'}`,
        )
      }
      if (name === 'index.html' && isRight) {
        const page = (await file.text()).replace(
          '<link rel="manifest" href="manifest.json">',
          `<link rel="manifest" href="manifest.json?token=${encodeURIComponent(asked)}">`,
        )
        return new Response(page, { headers: { 'content-type': TYPES['.html'] ?? 'text/html', 'cache-control': 'no-store' } })
      }
      if (name === 'manifest.json' && isRight) {
        const manifest = (await file.json()) as Record<string, unknown>
        return new Response(JSON.stringify({ ...manifest, start_url: `./?token=${encodeURIComponent(asked ?? '')}` }), {
          headers: { 'content-type': TYPES['.json'] ?? 'application/json', 'cache-control': 'no-store' },
        })
      }
      const type = TYPES[name.slice(name.lastIndexOf('.'))] ?? 'application/octet-stream'
      return new Response(file, { headers: { 'content-type': type, 'cache-control': 'no-cache' } })
    }

    const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    const login = request.headers.get('tailscale-user-login')
    // Who `tailscale serve` says is asking, once per answer and client (absent for tagged devices, so the token stays the auth).
    const who = login ?? 'absent'
    const agent = request.headers.get('user-agent')?.slice(0, 80) ?? 'unknown agent'
    if (!seenLogins.has(`${who} ${agent}`)) {
      seenLogins.add(`${who} ${agent}`)
      console.log(`identity: Tailscale-User-Login ${who}${login ? ` (${request.headers.get('tailscale-user-name') ?? 'no name'})` : ''} from ${agent}`)
    }
    const hasToken = auth.token !== undefined && auth.token !== '' && sameText(bearer, auth.token)
    // A login alone rides along on any request the browser makes, so a write it authorizes must not
    // come from another site's page.
    const origin = request.headers.get('origin')
    const isOwnPage = origin === null || origin === url.origin || origin === `https://${request.headers.get('host')}`
    // The one /api call without auth: the phone trades a pairing code (from POST /api/pair) for the token. A code is
    // 128 random bits looked up whole, so there is nothing to guess a prefix of; unknown, expired and used look alike.
    if (path === '/api/pair/claim' && request.method === 'POST') {
      if (!isOwnPage) return json({ error: "pairing must come from the hub's own page" }, 403)
      expire()
      const body = (await request.json().catch(() => ({}))) as { code?: unknown }
      const code = typeof body?.code === 'string' ? body.code : ''
      if (!codes.delete(code) || !auth.token) {
        console.log(`pair: claim refused from ${agent}`)
        return json({ error: 'pairing code expired or already used' }, 401)
      }
      console.log(`pair: code claimed by ${agent}`)
      return json({ token: auth.token })
    }
    const hasLogin = auth.login !== undefined && auth.login !== '' && login === auth.login && (request.method === 'GET' || isOwnPage)
    if (!hasToken && !hasLogin) return json({ error: 'unauthorized' }, 401)

    try {
      if (path === '/api/changes' && request.method === 'GET') {
        const after = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0)
        const wait = Math.min(MAX_WAIT_S, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0))
        // A cursor from before a reset of the database (larger than any seq) starts over.
        const from = after > hub.cursor() ? 0 : after
        await hub.waitFor(from, wait * 1000)
        return json(hub.changes(from))
      }
      if (path === '/api/notes' && request.method === 'POST') {
        const body = (await request.json()) as { notes?: unknown }
        if (!Array.isArray(body.notes) || body.notes.length > MAX_BATCH) return json({ error: `expected { notes: [...] }, at most ${MAX_BATCH}` }, 400)
        const accepted: Note[] = []
        const rejected: { id?: unknown; reason: string }[] = []
        for (const raw of body.notes) {
          try {
            accepted.push(toNote(raw))
          } catch (error) {
            rejected.push({ id: (raw as { id?: unknown } | null)?.id, reason: error instanceof Error ? error.message : String(error) })
          }
        }
        return json({ hub: hub.id, notes: hub.push(accepted), rejected, cursor: hub.cursor() })
      }
      // A one-time code for the phone's QR (`ostrakon pair`), good for PAIR_TTL_MS; the oldest go first past MAX_PAIR_CODES.
      if (path === '/api/pair' && request.method === 'POST') {
        if (!auth.token) return json({ error: 'the hub has no HUB_TOKEN to hand out' }, 400)
        expire()
        while (codes.size >= MAX_PAIR_CODES) codes.delete(codes.keys().next().value as string)
        const code = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')
        codes.set(code, now() + PAIR_TTL_MS)
        console.log(`pair: code minted for ${agent}, good for ${PAIR_TTL_MS / 60_000} minutes`)
        return json({ code, expiresIn: PAIR_TTL_MS / 1000 })
      }
      if (path === '/api/projects' && request.method === 'GET') return json({ projects: hub.projects() })
      // A note from one line of text: what an iOS Shortcut or a curl sends (docs/phone.md). Without a
      // `source` it's the phone's; with one (`slack`, a script) it's yours, and the source is its origin.
      if (path === '/api/jot' && request.method === 'POST') {
        const body = (await request.json()) as { text?: unknown; project?: unknown; source?: unknown }
        const text = typeof body.text === 'string' ? body.text.trim() : ''
        if (text === '') return json({ error: 'expected { text }' }, 400)
        const source = body.source === undefined ? undefined : typeof body.source === 'string' ? body.source.trim() : ''
        if (source !== undefined && !SOURCE.test(source)) return json({ error: 'source: expected a short name (letters, digits, . _ -)' }, 400)
        const key = typeof body.project === 'string' ? body.project : ''
        const project = key === '' ? null : (hub.projects().find(known => known.key === key || known.name === key) ?? null)
        const stamp = nextStamp(Date.now())
        const [note] = hub.push([
          toNote({
            id: ulid(Date.now()),
            status: 'open',
            by: source === undefined ? 'phone' : 'you',
            created: stamp,
            updated: stamp,
            origin: source ?? 'iphone',
            text,
            project: project && { key: project.key, name: project.name, path: project.path },
          }),
        ])
        return json({ note })
      }
      return json({ error: 'not found' }, 404)
    } catch (error) {
      // Every check above answers for itself, so what lands here is a body that isn't JSON or the
      // hub's own failure: the caller gets a fixed answer, the details go to the log only.
      if (error instanceof SyntaxError) return json({ error: 'invalid JSON body' }, 400)
      console.error(`${request.method} ${path} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      return json({ error: 'the hub failed; see its log' }, 500)
    }
  }
}

// The link that pairs the phone's page: the hub's public https base plus `?pair=<code>` or, for the
// long-lived link, `?token=<token>`. Throws on a URL that isn't https (an installable PWA needs it).
export const pairLink = (base: string, secret: { pair: string } | { token: string }) => {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    throw new Error(`not a valid URL: ${base}`)
  }
  if (url.protocol !== 'https:') throw new Error(`the hub URL must be https (a phone page can't be installed from ${url.protocol}//): ${base}`)
  const path = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  const [name, value] = 'pair' in secret ? ['pair', secret.pair] : ['token', secret.token]
  return `${url.origin}${path}?${name}=${encodeURIComponent(value)}`
}

const pair = async (args: string[]) => {
  const fail = (message: string): never => {
    console.error(message)
    process.exit(1)
  }
  const isToken = args.includes('--token')
  const arg = args.find(a => a !== '--token')
  const token = process.env.HUB_TOKEN
  if (!token) fail("set HUB_TOKEN to the hub's token, or put it in ~/.config/ostrakon-hub/env and run `ostrakon pair` (bin/ostrakon), which reads that file")
  let base = arg
  if (!base) {
    try {
      const run = Bun.spawnSync(['tailscale', 'status', '--json'], { stderr: 'ignore' })
      const dns = run.exitCode === 0 ? JSON.parse(run.stdout.toString()).Self?.DNSName : undefined
      if (typeof dns === 'string' && dns) base = `https://${dns.replace(/\.$/, '')}:8443`
    } catch {}
    if (!base) fail("could not get this machine's name from `tailscale status --json`; pass the hub's URL: ostrakon pair https://<host>.<tailnet>.ts.net:8443")
  }
  let secret: { pair: string } | { token: string } = { token: token as string }
  if (!isToken) {
    const port = process.env.HUB_PORT ?? 8790
    let response: Response | undefined
    try {
      response = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })
    } catch {
      fail(
        `could not reach the hub on 127.0.0.1:${port}. Is it running? Try \`systemctl --user status ostrakon-hub\` or \`ostrakon hub\`. Without a local hub, \`ostrakon pair --token\` prints a link that carries the token.`,
      )
    }
    const body = (await response?.json().catch(() => ({}))) as { code?: string; error?: string }
    if (response?.status !== 200 || !body.code) fail(`the hub refused to make a pairing code (${response?.status}): ${body.error ?? 'no reason given'}`)
    secret = { pair: body.code as string }
  }
  let link = ''
  try {
    link = pairLink(base as string, secret)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  try {
    const qr = Bun.spawnSync(['qrencode', '-t', 'ansiutf8', link], { stdout: 'inherit', stderr: 'inherit' })
    if (qr.exitCode !== 0) console.error('qrencode failed; use the link below')
  } catch {
    console.error('qrencode is not installed (e.g. `sudo pacman -S qrencode` or `sudo apt install qrencode`); use the link below')
  }
  console.log(`\n${link}\n`)
  if (isToken)
    console.log(
      'The code and the link carry the hub token. Treat a screenshot of either like the token, clear this terminal after scanning, and rotate HUB_TOKEN if it leaks.',
    )
  else console.log('The code and the link work once, within 5 minutes; the phone then holds the hub token.')
}

if (import.meta.main && process.argv[2] === 'pair') {
  await pair(process.argv.slice(3))
} else if (import.meta.main) {
  const port = Number(process.env.HUB_PORT ?? 8790)
  const dataDir = process.env.HUB_DATA ?? join(process.env.HOME ?? '.', '.local/share/ostrakon-hub')
  const auth = { token: process.env.HUB_TOKEN, login: process.env.HUB_LOGIN }
  if (!auth.token && !auth.login) throw new Error('set HUB_TOKEN (and/or HUB_LOGIN)')
  const hub = openHub(dataDir)
  // Long polls hold a request up to MAX_WAIT_S; Bun's default idle timeout is 10 s.
  const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: MAX_WAIT_S + 15, fetch: handler(hub, auth) })
  console.log(`ostrakon hub ${VERSION} on http://127.0.0.1:${server.port} (data ${dataDir})`)
  // A backup and a tombstone purge at start and once a day.
  const backup = () => {
    try {
      console.log(`backup ${hub.backup()}; purged ${hub.purge()} tombstones older than ${PURGE_AFTER_MS / 86_400_000} days`)
    } catch (error) {
      console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  backup()
  setInterval(backup, 24 * 60 * 60 * 1000)
}
