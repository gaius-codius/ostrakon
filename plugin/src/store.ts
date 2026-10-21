// Note storage: one Markdown file per note under <root>/notes/ (SPEC §6).
//
// - Writes go to a temp file of their own and are renamed into place, so a reader never sees half
//   a note and two writers never share a staging file.
// - A file that won't parse is reported and skipped. Nothing is ever written over it, and a
//   change to a note whose file won't parse is refused rather than guessed at.
// - Changing a note takes a per-note lock (an atomic mkdir) across sessions and reads every copy
//   of the note fresh under it, so a change always applies on top of the newest copy.
// - In one session, polls and writes run one at a time, so a poll can't roll back a write.
// - Other sessions, Obsidian and sync adapters change files underneath us; a poll of the
//   directory listing re-reads what changed, recently touched files again on the next poll (coarse
//   mtimes), and everything once a minute.
// - The session's view ($.state notes) is always rebuilt from what's on disk, merged by id.
// - What only the folder adapter's mirror needs (files named after their notes, conflict copies
//   folded, files that go read as deletes, notes taken out of the folder) is a layer over this
//   store: src/mirror.ts.

import type { Note, NoteProblem } from '../types'
import { parseNote, serializeNote } from './frontmatter'
import { mergeAll, nextStamp, winner } from './merge'
import { fingerprint, hashOf } from './sync/core'
import { ulid } from './ulid'

// What the store needs from the engine. The hooks module builds it from $ (a mod may only pass $
// to functions in its own file); tests build it over an in-memory directory.
// The machine's own files (memos, locks, sync caches, the doctor's report): ~/.cache/ostrakon, or
// OSTRAKON_CACHE, which keeps a test session's apart from the person's.
export const cacheDirOf = (env: { home?: string; cache?: string }) =>
  (env.cache || `${(env.home ?? '').replace(/\/+$/, '')}/.cache/ostrakon`).replace(/\/+$/, '')

export type StoreIO = {
  env: { dir?: string; home?: string; cache?: string }
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (dir: string) => Promise<readonly { name: string; kind: string; size: number; mtimeMs: number }[]>
  exists: (path: string) => Promise<boolean>
  stat: (path: string) => Promise<{ size: number; mtimeMs: number }>
  // Atomic rename on one filesystem; resolves the exit code and stderr.
  move: (from: string, to: string) => Promise<{ exitCode: number; stderr: string }>
  // Atomic create-if-absent of a directory: true when this call created it.
  mkdir: (path: string) => Promise<boolean>
  // Moves a file to a name nothing holds, never over one that's there (a hard link, then the old
  // name removed); true when it moved.
  place: (from: string, to: string) => Promise<boolean>
  // Removes an empty directory, or one file; true when it's gone.
  rmdir: (path: string) => Promise<boolean>
  remove: (path: string) => Promise<boolean>
  // Creates a directory and its parents; true when it exists afterwards.
  mkdirs: (path: string) => Promise<boolean>
  hostname: () => Promise<string>
  // This Claude Code process, and a process on this machine: running (with its start time; pid
  // plus start time names one process for good, even after its pid is reused), confirmed gone,
  // or undefined when it couldn't be told. Only a confirmed exit ever frees a lock.
  processId: () => Promise<number | undefined>
  processState: (pid: number) => Promise<ProcessState | undefined>
  // A note for the debug log: something went wrong that nothing could act on.
  warn: (text: string) => void
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  // The session's view ($.state): what's shown, and replacing it.
  shown: () => Promise<{ notes: Record<string, Note>; problems: readonly NoteProblem[] }>
  publish: (notes: Record<string, Note>, problems: NoteProblem[]) => Promise<void>
}

export type ProcessState = { isRunning: true; started: string } | { isRunning: false }

export class StorageError extends Error {}

export type NewNote = Pick<Note, 'text' | 'by' | 'project'> & Partial<Pick<Note, 'status' | 'context'>>

// Files modified this recently are read again on the next poll: a second write within one mtime
// tick (coarse on some filesystems) with the same size would otherwise go unseen.
const RECENT_MS = 3000
// Every this many polls, every file is read again whatever its listing says.
const FULL_RESCAN_EVERY = 30
// A lock directory with no owner file is left by a crash between creating it and naming the owner
// (microseconds); after this long nobody can still be about to write that file.
const OWNERLESS_LOCK_MS = 60_000
const LOCK_ATTEMPTS = 120
const LOCK_WAIT_MS = 25

const isNoteFile = (name: string) => name.endsWith('.md') && !name.startsWith('.')

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

type Seen = { id: string; updated: string; print: string }

// v: the memory's format. Files remembered under another one are dropped (their fingerprints were
// taken another way), and so are a layer's parts; whether the folder was used is kept.
type Memo = { v: number; dir: string; isUsed: boolean; files: Record<string, Seen>; [part: string]: unknown }
const MEMO_VERSION = 2

export const randomTag = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => byte.toString(16).padStart(2, '0')).join('')

// One retry: a writer that doesn't rename into place (an editor, a sync client) may be mid-write.
export const readFile = async (io: StoreIO, path: string): Promise<{ note: Note; raw: string }> => {
  try {
    const raw = await io.read(path)
    return { note: parseNote(raw), raw }
  } catch {
    await io.sleep(50)
    const raw = await io.read(path)
    return { note: parseNote(raw), raw }
  }
}

// Ids name files and lock directories, so they're held to a safe alphabet (parseNote checks too).
const SAFE_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/

export type Lock = { path: string; token: string }

// Where a store keeps its notes and locks. By default the notes sit in <root>/notes; with
// `notesFolder` empty, in the folder itself. `lockSpace` puts the locks apart from the notes
// folder's, named `<lockSpace>.<folder tag>` after the folder as resolved, so every spelling of one
// folder shares its locks; the dot keeps the name apart from note ids, which name the notes
// folder's locks.
export type Layout = { notesFolder?: string; lockSpace?: string }

// What a layer over the store (the mirror, src/mirror.ts) hooks into the points only it can decide.
// The notes folder uses none.
export type StoreHooks = {
  // A file stopped holding a note it was known to hold, other than by this store's own doing: it
  // went, or (`isTaken`) it holds another note now.
  lost?: (file: string, held: { id: string; updated: string }, isTaken: boolean) => void
  // Writes the first file of a note taken in from elsewhere that has none here yet, under its lock;
  // without it, that's <id>.md.
  writeFirst?: (io: StoreIO, note: Note, lock: Lock) => Promise<Note>
  // A part of the memory file of the layer's own, kept under `name` beside the files' revisions.
  memo?: MemoPart
}

export type MemoPart = {
  name: string
  // Takes in what the memory file holds under the name: anything, or nothing.
  recall: (saved: unknown) => void
  // A snapshot of what's changed since the last save: whether anything has (`isPending`), laying it
  // over what the file holds now (`over`), and marking it saved once the file is written (`done`).
  saving: () => { isPending: boolean; over: (saved: unknown) => unknown; done: () => void }
}

// A store and its insides. `store` is what the hooks module and the sync core use; the rest is for
// a layer that composes the store (src/mirror.ts), and keeps to the store's own rules: polls and
// writes inside `serial`, changes to a note under its lock (`withLock`), reading every copy fresh.
export const storeKit = (notesDir?: string, layout: Layout = {}, hooks: StoreHooks = {}) => {
  const notesFolder = layout.notesFolder ?? 'notes'
  let root = ''
  let host = ''
  let pid: number | undefined | null = null
  let polls = 0
  const seen = new Map<string, { mtimeMs: number; size: number }>() // file → listing entry last read
  const parsed = new Map<string, Note>() // file → its note, as read or written
  const broken = new Map<string, string>() // file → why it didn't parse
  const written = new Map<string, number>() // file → mtime of this store's own last write
  const recent = new Set<string>() // files to read again on the next poll
  // file → the copy it held before an edit in place was promoted, until the promotion is written.
  const baseline = new Map<string, Note>()
  // file → the revision last seen in it, kept on this machine between sessions
  // (~/.cache/ostrakon/seen-<folder>.json): an edit made while no session ran (Obsidian, Dropbox
  // carrying another machine's Obsidian edit) is still told from the revision it changed.
  const remembered = new Map<string, Seen>()
  // What changed since the last save: a file's revision, or null for a file gone.
  const pending = new Map<string, Seen | null>()
  let isRecalled = false
  let isUsed = false
  let isUsePending = false

  // Polls and writes in this session run one after another.
  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }

  const dirOf = (io: StoreIO) => {
    if (root === '') {
      const home = io.env.home ?? ''
      const chosen = io.env.dir || notesDir || `${home}/.local/share/ostrakon`
      root = chosen.replace(/^~(?=\/)/, home).replace(/\/+$/, '')
    }
    return notesFolder === '' ? root : `${root}/${notesFolder}`
  }

  // The folder the store was pointed at: <root>/notes holds the notes, or the folder itself does.
  const rootOf = (io: StoreIO) => {
    dirOf(io)
    return root
  }

  const hostName = async (io: StoreIO) => {
    if (host === '') host = (await io.hostname().catch(() => '')).trim() || 'unknown'
    return host
  }

  const processId = async (io: StoreIO) => {
    if (pid === null) pid = await io.processId().catch(() => undefined)
    return pid
  }

  // The memory file names its folder, so two folders whose names hash alike never share one.
  const memoPath = (io: StoreIO) => `${cacheDirOf(io.env)}/seen-${hashOf(dirOf(io))}.json`

  const memoOn = async (io: StoreIO): Promise<Memo> => {
    const empty: Memo = { v: MEMO_VERSION, dir: dirOf(io), isUsed: false, files: {} }
    if (!(await io.exists(memoPath(io)).catch(() => false))) return empty
    try {
      const memo = JSON.parse(await io.read(memoPath(io))) as Partial<Memo>
      if (memo.dir !== empty.dir) return empty
      if (memo.v !== MEMO_VERSION) return { ...empty, isUsed: memo.isUsed === true }
      const files = Object.fromEntries(
        Object.entries(memo.files ?? {}).filter(
          ([, value]) => typeof value?.id === 'string' && typeof value.updated === 'string' && typeof value.print === 'string',
        ),
      )
      const part = hooks.memo ? { [hooks.memo.name]: memo[hooks.memo.name] } : {}
      return { ...empty, isUsed: memo.isUsed === true, files, ...part }
    } catch {
      return empty
    }
  }

  const recall = async (io: StoreIO) => {
    if (isRecalled) return
    isRecalled = true
    const memo = await memoOn(io)
    for (const [file, value] of Object.entries(memo.files)) if (!remembered.has(file)) remembered.set(file, value)
    hooks.memo?.recall(memo[hooks.memo.name])
  }

  // By the file's bytes, not the note as read: a change in how notes are written never makes an
  // unchanged file look edited.
  const remember = (file: string, note: Note, raw: string) => {
    const before = remembered.get(file)
    const print = hashOf(raw)
    if (before?.print === print && before.updated === note.updated && before.id === note.id) return
    const value = { id: note.id, updated: note.updated, print }
    remembered.set(file, value)
    pending.set(file, value)
  }

  // `isOurs`: this store removed the file itself (a layer retiring or tidying it), which is no news.
  const forget = (file: string, isOurs = false) => {
    const was = remembered.get(file)
    if (!remembered.delete(file)) return
    pending.set(file, null)
    if (was && !isOurs) hooks.lost?.(file, { id: was.id, updated: was.updated }, false)
  }

  const isBroken = (file: string) => broken.has(file)

  // Only what this session saw change goes into the file, over what other sessions saved there, so
  // a session never puts back an older view of files it hasn't looked at since. What couldn't be
  // saved is tried again with the next save.
  const persist = async (io: StoreIO) => {
    const part = hooks.memo?.saving()
    if (pending.size === 0 && !part?.isPending && !isUsePending) return
    const path = memoPath(io)
    const saving = new Map(pending)
    try {
      const memo = await memoOn(io)
      for (const [file, value] of saving) {
        if (value === null) delete memo.files[file]
        else memo.files[file] = value
      }
      if (hooks.memo && part) memo[hooks.memo.name] = part.over(memo[hooks.memo.name])
      memo.isUsed = memo.isUsed || isUsePending
      const tmp = `${path}.${randomTag()}.tmp`
      if (!(await io.mkdirs(path.replace(/\/[^/]+$/, '')))) throw new Error('no cache folder')
      await io.write(tmp, JSON.stringify(memo))
      const moved = await io.move(tmp, path)
      if (moved.exitCode !== 0) {
        await io.remove(tmp)
        throw new Error(moved.stderr.trim() || 'rename failed')
      }
      for (const [file, value] of saving) if (pending.get(file) === value) pending.delete(file)
      part?.done()
      isUsePending = false
    } catch (error) {
      io.warn(`remembering what ${dirOf(io)} held: ${message(error)}`)
    }
  }

  // Whether this machine has ever had notes in the folder (a mirror that's gone missing since isn't
  // made again empty: SPEC §7.2). Kept apart from the files' memory, which follows what's there.
  // A memory file that's there but can't be read counts as used: when in doubt, don't make a folder.
  const hasHistory = async (io: StoreIO) => {
    if (isUsed) return true
    const path = memoPath(io)
    if (!(await io.exists(path).catch(() => true))) return false
    try {
      const memo = JSON.parse(await io.read(path)) as Partial<Memo>
      return memo.dir !== dirOf(io) ? false : memo.isUsed === true
    } catch {
      return true
    }
  }

  const markUsed = () => {
    if (!isUsed) isUsePending = true
    isUsed = true
  }

  // A file that won't parse and is, or last held, note `id` (its own name, or a name it was given
  // in an editor): the note is never written beside it, which would leave two files once it's mended.
  const unreadableFileOf = (id: string) => (broken.has(`${id}.md`) ? `${id}.md` : [...broken.keys()].find(file => remembered.get(file)?.id === id))

  const filesOf = (id: string) => [...parsed].filter(([, note]) => note.id === id).map(([file]) => file)

  const publish = (io: StoreIO) =>
    io.publish(
      Object.fromEntries(mergeAll(parsed.values())),
      [...broken].map(([file, reason]) => ({ file, reason })),
    )

  // A file whose content changed while its `updated` stayed the same was edited by something that
  // doesn't keep the stamp (Obsidian, a text editor): count that as a change made at its mtime.
  // Only for a file already known with other content; a new file (a copy, a sync conflict copy)
  // keeps its own stamp, so a stale copy can never outrank a newer revision by its mtime.
  const promoted = (file: string, note: Note, mtimeMs: number, raw: string) => {
    const copy = baseline.get(file) ?? parsed.get(file)
    // Against the copy this session read (as a note), or else what this machine remembers of the
    // file from before (by its bytes).
    const before = copy ? { id: copy.id, updated: copy.updated } : remembered.get(file)
    if (!before || before.id !== note.id || before.updated !== note.updated) {
      baseline.delete(file)
      return undefined
    }
    const isSame = copy ? fingerprint(copy) === fingerprint(note) : remembered.get(file)?.print === hashOf(raw)
    if (written.get(file) === mtimeMs || isSame) return undefined
    return { ...note, updated: nextStamp(mtimeMs, before.updated) }
  }

  // Under a lock, the rename only happens while this session still owns it.
  // `text` is the file as written: the note serialized, unless the caller kept a file's own bytes.
  const write = async (io: StoreIO, note: Note, file: string, lock?: Lock, text = serializeNote(note)) => {
    const dir = dirOf(io)
    const path = `${dir}/${file}`
    const tmp = `${dir}/.${note.id}.${randomTag()}.tmp`
    await io.write(tmp, text)
    if (lock && !(await owns(io, lock))) {
      await io.remove(tmp)
      throw new StorageError(`${note.id} was taken over by another session mid-change; not saved`)
    }
    const moved = await io.move(tmp, path)
    if (moved.exitCode !== 0) {
      await io.remove(tmp)
      throw new StorageError(`couldn't save ${file}: ${moved.stderr.trim()}`)
    }
    return settle(io, note, file, text)
  }

  // After a write: what this store knows of the file, unless another writer replaced it meanwhile.
  const settle = async (io: StoreIO, note: Note, file: string, text: string) => {
    const path = `${dirOf(io)}/${file}`
    const stat = await io.stat(path)
    // Another writer may have replaced the file since the rename: then trust nothing about it and
    // let the next poll read what's really there.
    if ((await io.read(path).catch(() => '')) !== text) {
      seen.delete(file)
      written.delete(file)
      recent.add(file)
      return note
    }
    written.set(file, stat.mtimeMs)
    seen.set(file, { mtimeMs: stat.mtimeMs, size: stat.size })
    remember(file, note, text)
    markUsed()
    parsed.set(file, note)
    broken.delete(file)
    baseline.delete(file)
    return note
  }

  // Locks coordinate the sessions on this machine (machines reconcile through copies and merge,
  // never through locks on a synced folder), so they live outside the notes folder:
  // ~/.cache/ostrakon/locks/<id>, made with mkdir (atomic). The owner file names a random token,
  // this process and its start time. A lock is only ever taken from an owner that has exited, and
  // a process that has exited can't resume a rename, so an owner's check before its rename is
  // enough. Taking a lock over happens under a short guard directory, one recoverer at a time.
  const lockRoot = (io: StoreIO) => `${cacheDirOf(io.env)}/locks${layout.lockSpace ? `/${layout.lockSpace}.${hashOf(dirOf(io))}` : ''}`

  const ownerOf = async (io: StoreIO, path: string) => {
    const text = await io.read(`${path}/owner`).catch(() => undefined)
    if (text === undefined) return undefined
    const [token = '', processText = '', ...started] = text.trim().split(' ')
    return { token, pid: Number(processText), started: started.join(' ') }
  }

  const owns = async (io: StoreIO, lock: Lock) => (await ownerOf(io, lock.path))?.token === lock.token

  // Names the abandoned instance of a lock (its dead owner's token, or the creation time of an old
  // ownerless one), or undefined when it may still be in use or that can't be told.
  const abandonedAs = async (io: StoreIO, path: string) => {
    const owner = await ownerOf(io, path)
    if (!owner) {
      const made = await io.stat(path).catch(() => undefined)
      return made && (await io.now()) - made.mtimeMs > OWNERLESS_LOCK_MS ? `ownerless${Math.floor(made.mtimeMs)}` : undefined
    }
    if (!(owner.pid > 0) || owner.started === '') return undefined
    const state = await io.processState(owner.pid).catch(() => undefined)
    if (state === undefined) return undefined
    return !state.isRunning || state.started !== owner.started ? owner.token : undefined
  }

  // Moves a lock directory out of the way and clears it. The move is what frees the name; the
  // leftovers are only cleared, so a failure there can't block anyone.
  const clearLock = async (io: StoreIO, path: string, why: string) => {
    const away = `${path}.${why}-${randomTag()}`
    if ((await io.move(path, away)).exitCode !== 0) return false
    await io.remove(`${away}/owner`)
    if (!(await io.rmdir(away))) io.warn(`couldn't remove ${away}`)
    return true
  }

  // Creates `path` as a lock owned by this process: true when this call got it.
  const take = async (io: StoreIO, path: string, owner: string) => {
    if (!(await io.mkdir(path))) return false
    try {
      await io.write(`${path}/owner`, owner)
    } catch (error) {
      if (!(await clearLock(io, path, 'unowned'))) io.warn(`couldn't roll back lock ${path}`)
      throw new StorageError(`couldn't lock ${path}: ${message(error)}`)
    }
    return true
  }

  const giveBack = async (io: StoreIO, lock: Lock) => {
    if (!(await owns(io, lock))) {
      io.warn(`lock ${lock.path} was no longer ours at release`)
      return
    }
    if (!(await clearLock(io, lock.path, 'released'))) io.warn(`couldn't release lock ${lock.path}`)
  }

  // Clears an abandoned lock. Only under a guard named after that very instance, so one session
  // recovers it, and a guard never outlives what it guards: no guard is ever expired by age. A guard
  // whose own recoverer died is an abandoned lock itself: the walk follows that chain, however
  // long, and clears its deepest dead link, so every attempt makes progress. Guard names stay flat
  // (`<lock>.recovering-<instance>`) whatever the depth.
  const recover = async (io: StoreIO, lockPath: string, self: { token: string; owner: string }) => {
    const visited = new Set<string>()
    let path = lockPath
    while (!visited.has(path)) {
      visited.add(path)
      const instance = await abandonedAs(io, path)
      if (instance === undefined) return
      const guard = `${lockPath}.recovering-${instance}`
      if (await take(io, guard, self.owner)) {
        try {
          if ((await abandonedAs(io, path)) === instance) await clearLock(io, path, 'abandoned')
        } finally {
          await giveBack(io, { path: guard, token: self.token })
        }
        return
      }
      path = guard
    }
  }

  const acquire = async (io: StoreIO, id: string): Promise<Lock> => {
    if (!SAFE_ID.test(id)) throw new StorageError(`"${id}" isn't a note id`)
    const root = lockRoot(io)
    if (!(await io.mkdirs(root))) throw new StorageError(`couldn't create ${root}`)
    // A lock must name a process that can later be confirmed gone, or nobody could ever free it.
    const self = await processId(io)
    const state = self === undefined ? undefined : await io.processState(self).catch(() => undefined)
    if (self === undefined || !state?.isRunning) throw new StorageError("couldn't identify this session's process; not changing notes")
    const path = `${root}/${id}`
    const token = randomTag()
    const owner = `${token} ${self} ${state.started}\n`
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (await take(io, path, owner)) return { path, token }
      await recover(io, path, { token, owner })
      await io.sleep(LOCK_WAIT_MS)
    }
    throw new StorageError(`${id} is being changed by another session; try again`)
  }

  const withLock = async <T>(io: StoreIO, id: string, work: (lock: Lock) => Promise<T>): Promise<T> => {
    const lock = await acquire(io, id)
    try {
      return await work(lock)
    } finally {
      await giveBack(io, lock).catch(error => io.warn(`releasing ${lock.path}: ${message(error)}`))
    }
  }

  const scanNow = async (io: StoreIO) => {
    await recall(io)
    const dir = dirOf(io)
    const isThere = await io.exists(dir)
    const entries = isThere ? await io.list(dir) : []
    const files = entries.filter(entry => entry.kind === 'file' && isNoteFile(entry.name))
    const names = new Set(files.map(entry => entry.name))
    if (files.length > 0) markUsed()
    const now = await io.now()
    const isFull = polls++ % FULL_RESCAN_EVERY === 0
    let isChanged = false

    for (const name of [...seen.keys(), ...parsed.keys(), ...broken.keys()]) {
      if (names.has(name)) continue
      isChanged = isChanged || parsed.has(name) || broken.has(name)
      seen.delete(name)
      parsed.delete(name)
      broken.delete(name)
      written.delete(name)
    }
    // A folder that isn't there (a drive not mounted) says nothing about what its files held.
    if (isThere) for (const name of [...remembered.keys()]) if (!names.has(name)) forget(name)

    const recheck = new Set(recent)
    recent.clear()
    const toRead = files.filter(entry => {
      const last = seen.get(entry.name)
      return isFull || recheck.has(entry.name) || last === undefined || last.mtimeMs !== entry.mtimeMs || last.size !== entry.size
    })
    const toPersist: { file: string; note: Note; observed: string }[] = []
    await Promise.all(
      toRead.map(async entry => {
        const before = parsed.get(entry.name)
        const reason = broken.get(entry.name)
        try {
          const read = await readFile(io, `${dir}/${entry.name}`)
          let note = read.note
          // The file holds another note than it did (its name taken by a new one): the old note's
          // file is gone as surely as if it had been deleted.
          const held = remembered.get(entry.name)
          if (held && held.id !== note.id) hooks.lost?.(entry.name, { id: held.id, updated: held.updated }, true)
          const bumped = promoted(entry.name, note, entry.mtimeMs, read.raw)
          if (bumped) {
            if (before && !baseline.has(entry.name)) baseline.set(entry.name, before)
            toPersist.push({ file: entry.name, note: bumped, observed: serializeNote(note) })
            note = bumped
          } else remember(entry.name, note, read.raw)
          parsed.set(entry.name, note)
          broken.delete(entry.name)
          if (!before || reason !== undefined || serializeNote(before) !== serializeNote(note)) isChanged = true
        } catch (error) {
          parsed.delete(entry.name)
          broken.set(entry.name, message(error))
          if (before || reason !== message(error)) isChanged = true
        }
        seen.set(entry.name, { mtimeMs: entry.mtimeMs, size: entry.size })
      }),
    )
    for (const entry of files) if (now - entry.mtimeMs < RECENT_MS) recent.add(entry.name)

    // Write promoted stamps back, so every machine that syncs the file sees the same revision. Only
    // if the file still holds what was promoted; otherwise the next poll reads what replaced it.
    // Only the `updated` line changes: the file is likely open in the editor that changed it, which
    // takes a one-line change in quietly, cursor and all (a whole new file could add a final
    // newline the editor didn't write, and move the cursor past it).
    for (const { file, note, observed } of toPersist) {
      await withLock(io, note.id, async lock => {
        const raw = await io.read(`${dir}/${file}`)
        if (serializeNote(parseNote(raw)) !== observed) {
          recent.add(file)
          return
        }
        const restamped = raw.replace(/^updated:.*$/m, `updated: ${note.updated}`)
        const isExact = (() => {
          try {
            return serializeNote(parseNote(restamped)) === serializeNote(note)
          } catch {
            return false
          }
        })()
        await write(io, note, file, lock, isExact ? restamped : serializeNote(note))
      }).catch(() => recent.add(file))
    }

    // $.state was reset under us (/clear, /resume, /branch): put the view back even if no file changed.
    const shown = await io.shown()
    const isViewLost = (parsed.size > 0 && Object.keys(shown.notes).length === 0) || (broken.size > 0 && shown.problems.length === 0)
    if (isChanged || isViewLost) await publish(io)
    await persist(io)
    return isChanged || isViewLost
  }

  // Reads every file that changed since the last poll. Resolves whether the view changed.
  const scan = (io: StoreIO) => serial(() => scanNow(io))

  // Forgets what was read and reads the whole directory again.
  const loadAll = (io: StoreIO) =>
    serial(async () => {
      seen.clear()
      parsed.clear()
      broken.clear()
      written.clear()
      recent.clear()
      await scanNow(io)
      await publish(io)
    })

  const create = (io: StoreIO, fields: NewNote) =>
    serial(async () => {
      const now = await io.now()
      const stamp = new Date(now).toISOString()
      const id = ulid(now)
      const note = await write(
        io,
        {
          id,
          status: fields.status ?? 'open',
          by: fields.by,
          created: stamp,
          updated: stamp,
          origin: await hostName(io),
          project: fields.project,
          context: fields.context ?? {},
          sentAt: null,
          deleted: false,
          text: fields.text,
          extra: [],
        },
        `${id}.md`,
      )
      await publish(io)
      await persist(io)
      return note
    })

  // Every file holding note `id`, read fresh; called under the note's lock. Copies can arrive right
  // up to the lock: conflict copies keep the id in their file name, and any copy already read is
  // known by its content. Rejects with StorageError when a file known to hold the note can't be read.
  const copiesOf = async (io: StoreIO, id: string) => {
    const dir = dirOf(io)
    const canonical = `${id}.md`
    // A folder that isn't there yet (a new machine's first synced note) has no copies.
    const listed = ((await io.exists(dir)) ? await io.list(dir) : []).filter(entry => entry.kind === 'file' && isNoteFile(entry.name))
    const isNew = (entry: { name: string; mtimeMs: number; size: number }) => {
      const last = seen.get(entry.name)
      return last === undefined || last.mtimeMs !== entry.mtimeMs || last.size !== entry.size
    }
    const candidates = new Set([...filesOf(id), ...listed.filter(isNew).map(entry => entry.name)])
    const copies: [string, Note][] = []
    for (const file of candidates) {
      let note: Note
      try {
        const stat = await io.stat(`${dir}/${file}`)
        const read = await readFile(io, `${dir}/${file}`)
        note = promoted(file, read.note, stat.mtimeMs, read.raw) ?? read.note
      } catch (error) {
        if (file === canonical || filesOf(id).includes(file)) {
          throw new StorageError(`${file} can't be read (${message(error)}); not changed`)
        }
        continue
      }
      if (note.id === id) copies.push([file, note])
    }
    return copies
  }

  // Applies `edit` to the newest copy of a note: every file holding it is read fresh under the
  // note's lock, so another session's change is never replaced by a stale one. `edit` returning
  // undefined writes nothing. Rejects with StorageError, writing nothing, when the note's own file
  // can't be read.
  const change = (io: StoreIO, id: string, edit: (note: Note) => Note | undefined) =>
    serial(async () => {
      await scanNow(io)
      const unreadable = unreadableFileOf(id)
      if (unreadable !== undefined) throw new StorageError(`${unreadable} can't be read (${broken.get(unreadable)}); not changed`)
      const canonical = `${id}.md`
      const result = await withLock(io, id, async lock => {
        const copies = await copiesOf(io, id)
        const base = mergeAll(copies.map(([, note]) => note)).get(id)
        if (!base) throw new StorageError(`no note ${id}`)
        const next = edit(base)
        if (!next) return base
        const files = copies.map(([file]) => file)
        const target = files.includes(canonical) ? canonical : (files[0] ?? canonical)
        return write(
          io,
          { ...next, id: base.id, created: base.created, updated: nextStamp(await io.now(), base.updated), origin: await hostName(io) },
          target,
          lock,
        )
      })
      await publish(io)
      await persist(io)
      return result
    })

  // Takes in notes from elsewhere (a sync adapter). Each is merged with the local copies under its
  // lock and written only when it wins, as it came: it's that revision, so it keeps its stamp and
  // origin. A note whose file can't be read is left alone (not a failure: it never will be
  // written). Resolves how many were written, and the ids that couldn't be (to try again).
  const absorb = (io: StoreIO, incoming: readonly Note[]) =>
    serial(async () => {
      const failed: string[] = []
      // Notes whose file here won't parse: never written over, so not worth sending again.
      const refused: string[] = []
      if (incoming.length === 0) return { written: 0, failed, refused }
      await scanNow(io)
      // A new machine's first note from elsewhere: the folder may not be there yet.
      const dir = dirOf(io)
      if (!(await io.exists(dir)) && !(await io.mkdirs(dir))) throw new StorageError(`couldn't create ${dir}`)
      const local = mergeAll(parsed.values())
      let written = 0
      for (const note of incoming) {
        if (!SAFE_ID.test(note.id)) continue
        const known = local.get(note.id)
        if (known && winner(known, note) === known) continue
        const canonical = `${note.id}.md`
        const unreadable = unreadableFileOf(note.id)
        if (unreadable !== undefined) {
          io.warn(`sync: ${unreadable} can't be read; not replaced`)
          refused.push(note.id)
          continue
        }
        await withLock(io, note.id, async lock => {
          const copies = await copiesOf(io, note.id)
          const base = mergeAll(copies.map(([, copy]) => copy)).get(note.id)
          if (base && winner(base, note) === base) return
          const files = copies.map(([file]) => file)
          const target = files.includes(canonical) ? canonical : files[0]
          if (target === undefined && hooks.writeFirst) await hooks.writeFirst(io, note, lock)
          else await write(io, note, target ?? canonical, lock)
          written += 1
        }).catch(error => {
          io.warn(`sync: ${note.id}: ${message(error)}`)
          failed.push(note.id)
        })
      }
      if (written > 0) await publish(io)
      await persist(io)
      return { written, failed, refused }
    })

  const store = { scan, loadAll, create, change, absorb, isBroken, hasHistory, root: rootOf }
  // file → note, for each file read or written.
  const files: ReadonlyMap<string, Note> = parsed
  // Whether a file name is in use as far as this store has seen (a note, or a file that won't parse).
  const isTaken = (file: string) => parsed.has(file) || broken.has(file)
  // How many files this machine remembers in the folder.
  const knownCount = () => remembered.size
  // A file this store took out of the folder itself: it's forgotten, and that's no news.
  const drop = (file: string) => {
    parsed.delete(file)
    seen.delete(file)
    forget(file, true)
  }
  const insides = { serial, scanNow, recall, persist, publish, dirOf, withLock, copiesOf, write, settle, owns, unreadableFileOf }
  return { store, ...insides, files, isTaken, knownCount, drop }
}

// One store per loaded module. `notesDir` is the userConfig value; OSTRAKON_DIR overrides it.
export const createStore = (notesDir?: string, layout: Layout = {}) => storeKit(notesDir, layout).store

export type Store = ReturnType<typeof createStore>
