// The folder adapter (SPEC §7.2): keeps a second folder of note files in step with the notes
// folder. Dropbox, Syncthing or any synced drive carries that folder to other machines; pointed at
// a folder in an Obsidian vault, Obsidian edits the same files.
//
// The mirror is a store of its own over that folder (src/mirror.ts, a layer over src/store.ts),
// so everything the notes folder gets, it gets too: whole-file writes renamed into place, a lock
// per note between this machine's sessions, conflict copies merged by id, and edits made by other
// tools (Obsidian, an editor) counted as changes at their mtime. The adapter only turns that store
// into pulls and pushes.
//
// Live notes have their files in the mirror folder; archived and deleted ones in its Archive
// folder, a second store. Archiving moves a note's file across (written there, then taken out of
// the folder), so every machine sees the archive itself, stamp and all. A note file that goes from
// the folder with no archived copy to explain it (deleted in Obsidian) archives the note once it
// has stayed gone a few seconds: a sync client may deliver a rename as a delete and a create, or an
// archive's two halves out of order. Many going at once with nothing to explain them looks like a
// sync client's trouble rather than a person deleting notes: those are put back instead.

import type { Note } from '../../types'
import { mergeAll, nextStamp, winner } from '../merge'
import type { Gone, MirrorStore } from '../mirror'
import type { StoreIO } from '../store'
import type { SyncAdapter } from './core'
import { SyncRefused, fingerprint } from './core'

// A mirror store's view of the engine, with the merged notes it last published.
export type MirrorIO = StoreIO & { view: () => Record<string, Note>; problems: () => readonly { file: string; reason: string }[] }

// How often a waiting pull looks at the folder again (the notes folder's own poll, SPEC §6.4).
export const MIRROR_POLL_MS = 2000
// How long a note's file must stay gone, with no archived copy, before the note is archived.
export const VANISH_GRACE_MS = 6000
// More notes than this going unexplained at once, and over half the folder, are put back instead.
const MASS_VANISH = 5
// The mirror's folder for archived and deleted notes.
export const ARCHIVE_FOLDER = 'Archive'

export const isRetired = (note: Note) => note.deleted || note.status === 'archived'

// `live` and `archive` are the stores over the mirror folder and its Archive folder; `notesFolder`
// resolves the notes folder this mirrors, which the mirror must not be; `localNote` is a note as the
// notes folder has it.
export const folderAdapter = (
  live: MirrorStore,
  archive: MirrorStore,
  liveIO: () => Promise<MirrorIO>,
  archiveIO: () => Promise<MirrorIO>,
  notesFolder: () => Promise<string>,
  localNote: (id: string) => Promise<Note | undefined>,
): SyncAdapter => {
  // id → fingerprint of each copy last handed to the core: a pull answers only what differs.
  let handed = new Map<string, string>()
  let isLoaded = false
  let pulls = 0
  let cursor = ''
  // Names this run of the mirror for the core. Putting notes back changes it, which makes the core
  // start over with a full pull and so send them again.
  const run = Math.random().toString(36).slice(2, 10)
  let restores = 0
  const runOf = () => `${run}.${restores}`
  const reported = new Set<string>()

  // The folder must be there. It's made the first time, when its parent exists (a vault, a Dropbox
  // folder), never with its parents. A missing parent is a drive that isn't mounted, and so is a
  // folder this machine has seen notes in before (its mount point may still be there): both stay a
  // problem to show rather than a new empty folder that every note would be written into.
  const ready = async (io: MirrorIO) => {
    const dir = live.root(io)
    if (dir === (await notesFolder())) throw new SyncRefused('mirror folder is the notes folder')
    if (await io.exists(dir)) return
    const parent = dir.replace(/\/[^/]*$/, '') || '/'
    const isNew = !(await live.hasHistory(io))
    if (isNew && (await io.exists(parent)) && ((await io.mkdir(dir)) || (await io.exists(dir)))) return
    throw new SyncRefused(`mirror folder missing: ${dir}`.slice(0, 80))
  }

  // Both folders' notes, one copy per note: the winner where both hold it (mid-archive, mid-restore).
  const viewOf = (io: MirrorIO, aio: MirrorIO) => Object.fromEntries(mergeAll([...Object.values(io.view()), ...Object.values(aio.view())]))

  // Reads what changed in both folders; a file that isn't a note is reported once and left be.
  // Notes whose files went from the folder are noted (kept in the memory), to be archived once
  // they've stayed gone.
  const look = async (io: MirrorIO, aio: MirrorIO) => {
    await ready(io)
    if (isLoaded) {
      await live.scan(io)
      await archive.scan(aio)
    } else {
      await live.loadAll(io)
      await archive.loadAll(aio)
      isLoaded = true
    }
    await live.tidy(io)
    await archive.tidy(aio)
    const now = await io.now()
    const waiting = await live.gone(io)
    for (const { id, file, updated } of live.takeVanished().files) if (!waiting.has(id)) live.markGone(id, { since: now, file, updated })
    // Back again (a rename delivered as a delete and a create, a restore), or explained by an
    // archived copy: not waiting any more.
    for (const [id, gone] of await live.gone(io)) if (io.view()[id] !== undefined || isExplained(aio, id, gone)) live.markGone(id, null)
    await live.save(io)
    for (const problem of [...io.problems(), ...aio.problems()]) {
      if (reported.has(problem.file)) continue
      reported.add(problem.file)
      io.warn(`mirror: ${problem.file} isn't a note (${problem.reason}); left as it is`)
    }
  }

  // An archived copy explains a file going only if it's that revision's archive or later: an old
  // archive arriving late (the note was restored since) doesn't.
  const isExplained = (aio: MirrorIO, id: string, gone: Gone) => {
    const archived = aio.view()[id]
    return archived !== undefined && Date.parse(archived.updated) >= Date.parse(gone.updated)
  }

  const changed = (view: Record<string, Note>) => Object.values(view).filter(note => handed.get(note.id) !== fingerprint(note))

  const due = async (io: MirrorIO) => {
    const now = await io.now()
    return [...(await live.gone(io))].filter(([, gone]) => now - gone.since >= VANISH_GRACE_MS)
  }

  // Settles the notes whose files have stayed gone. One the Archive folder now holds was archived
  // elsewhere (the pull brings that copy). One whose file is back but won't parse waits. The rest
  // are archived here, now, as the person's change in another tool would be, unless there are many:
  // those are put back.
  const settle = async (io: MirrorIO, aio: MirrorIO) => {
    const made: Note[] = []
    const unexplained: string[] = []
    for (const [id, gone] of await due(io)) {
      if (isExplained(aio, id, gone) || io.view()[id] !== undefined) live.markGone(id, null)
      else if (!live.isBroken(gone.file)) unexplained.push(id)
    }
    // Many at once, or every note the folder held: a sync client's trouble, not a person's deletes.
    const left = Object.keys(io.view()).length
    if ((unexplained.length > MASS_VANISH && unexplained.length > left) || (unexplained.length >= 2 && left === 0)) {
      io.warn(`mirror: ${unexplained.length} notes went at once; putting them back rather than archiving them`)
      for (const id of unexplained) live.markGone(id, null)
      restores += 1
    } else {
      for (const id of unexplained) {
        live.markGone(id, null)
        const note = await localNote(id)
        if (!note || isRetired(note)) continue
        made.push({ ...note, status: 'archived', updated: nextStamp(await io.now(), note.updated), origin: (await io.hostname()).trim() || 'unknown' })
      }
    }
    await live.save(io)
    // Written to Archive here: the core counts what a pull brings as held by the mirror, so it
    // would never send these.
    const archived = await archive.absorb(aio, made)
    if (archived.failed.length > 0) io.warn(`mirror: couldn't write ${archived.failed.length} archived notes to ${ARCHIVE_FOLDER}`)
    for (const note of made) if (aio.view()[note.id] !== undefined) handed.set(note.id, fingerprint(aio.view()[note.id] as Note))
    return made
  }

  // A note with a copy in the folder its state doesn't belong in (an archived one in the folder:
  // another machine's half-done archive, a late older copy; a live one in Archive: a half-done
  // restore) has its winning revision written to its own folder, and only once that's there is the
  // other copy taken out (unless it holds a newer revision). A handover that fails is tried again
  // on the next look.
  const sort = async (io: MirrorIO, aio: MirrorIO, notes: Note[]) => {
    for (const note of notes) {
      const [to, toIO, from, fromIO] = isRetired(note) ? [archive, aio, live, io] : [live, io, archive, aio]
      const result = await to.absorb(toIO, [note])
      const there = toIO.view()[note.id]
      if (result.failed.length > 0 || result.refused.length > 0 || !there || winner(there, note) !== there) {
        io.warn(`mirror: couldn't move ${note.id} to its folder; trying again`)
        continue
      }
      await from.retire(fromIO, note)
    }
  }

  // The winning revision of each note whose copy sits in the folder its state doesn't belong in.
  const misplaced = (io: MirrorIO, aio: MirrorIO) =>
    Object.values(viewOf(io, aio)).filter(note => (isRetired(note) ? io.view()[note.id] !== undefined : aio.view()[note.id] !== undefined))

  return {
    name: 'folder',
    pull: async (since, waitS) => {
      const [io, aio] = [await liveIO(), await archiveIO()]
      await look(io, aio)
      const isFull = since === null || since !== cursor
      const asked = runOf()
      if (!isFull) {
        let waited = 0
        while (waited < waitS * 1000 && runOf() === asked && changed(viewOf(io, aio)).length === 0 && (await due(io)).length === 0) {
          await io.sleep(MIRROR_POLL_MS)
          waited += MIRROR_POLL_MS
          await look(io, aio)
        }
      }
      const view = viewOf(io, aio)
      const found = isFull ? Object.values(view) : changed(view)
      handed = isFull ? new Map() : handed
      for (const note of found) handed.set(note.id, fingerprint(note))
      for (const id of [...handed.keys()]) if (view[id] === undefined) handed.delete(id)
      await sort(io, aio, misplaced(io, aio))
      const notes = [...found, ...(await settle(io, aio))]
      cursor = String(++pulls)
      return { notes, cursor, hub: runOf() }
    },
    push: async notes => {
      const [io, aio] = [await liveIO(), await archiveIO()]
      await look(io, aio)
      const waiting = await live.gone(io)
      // Live notes go to the folder, archived and deleted ones to Archive; one whose file was just
      // seen going waits to be archived rather than being written back.
      const toLive = notes.filter(note => !isRetired(note) && !waiting.has(note.id))
      const toArchive = notes.filter(isRetired)
      const written = await live.absorb(io, toLive)
      const archived = await archive.absorb(aio, toArchive)
      // The core takes nothing from a push that fails, so neither is anything counted as handed.
      const failed = written.failed.length + archived.failed.length
      if (failed > 0) throw new Error(`couldn't write ${failed} notes to the mirror`)
      // An archive's other half: its file comes out of the folder (unless it holds a newer edit),
      // and a restored note's out of Archive.
      for (const note of toArchive) if (io.view()[note.id] !== undefined) await live.retire(io, note)
      for (const note of toLive) if (aio.view()[note.id] !== undefined) await archive.retire(aio, note)
      // Settled through the stores' queues, so this is the mirror as the writes left it. A note
      // whose file there won't parse is left for the person to mend (it was logged) and not sent again.
      const view = viewOf(io, aio)
      const kept = new Set([...written.refused, ...archived.refused])
      const held: Note[] = []
      for (const note of notes) {
        if (kept.has(note.id) || (waiting.has(note.id) && !isRetired(note))) held.push(note)
        else {
          const there = view[note.id]
          if (there === undefined) continue
          handed.set(there.id, fingerprint(there))
          held.push(there)
        }
      }
      return { notes: held, hub: runOf() }
    },
  }
}
