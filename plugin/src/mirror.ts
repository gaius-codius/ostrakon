// The mirror's store (SPEC §7.2): a plain store (src/store.ts) over the folder adapter's folder,
// with what only a folder that people browse and change by hand needs.
//
// - A note's first file is named after its first line, as Obsidian would title it.
// - Sync clients' conflict copies are folded into the note's file and removed (tidy).
// - A file that goes, or that another note takes over, is noted (takeVanished), and the notes
//   waiting to be archived because of it are kept in the store's memory file (gone, markGone).
// - A note can be taken out of the folder (retire): archived notes live in the Archive folder.
//
// The mirror's notes sit in the folder itself and its locks apart from the notes folder's
// (`mirror.<folder tag>`); everything else is the plain store's.

import type { Note } from '../types'
import { serializeNote } from './frontmatter'
import { mergeAll, winner } from './merge'
import type { Lock, StoreIO } from './store'
import { StorageError, message, randomTag, readFile, storeKit } from './store'

// The names sync clients give the copies they make when two machines changed a file at once.
const CONFLICT_COPY = /conflicted copy|\.sync-conflict-|\(conflict\b/i
// Where tidying puts a conflict copy while it checks it (tidy): a folder in the mirror, so a copy
// that can't go back stays where the person can find it.
const CONFLICTS = '_conflicts'
// A note whose file went from a mirror, waiting to be archived (src/sync/folder.ts): when that was
// seen and which file it was. Kept in the memory, so a restart doesn't forget it.
export type Gone = { since: number; file: string; updated: string }

// A file name from a note's first line: what Obsidian would show as its title. Characters file
// systems or Obsidian links can't take become spaces; empty, or a name a conflict copy or the
// conflicts folder could have, gives '' (the note's id names it instead).
export const titleOf = (text: string) => {
  const line =
    text
      .split('\n')
      .map(part => part.trim())
      .find(part => part !== '') ?? ''
  let title = line
    .replace(/^(#+|[-*+>]|\d+[.)]|- \[[ xX]\])\s+/, '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters can't be in a file name
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .trim()
  if (title.length > 60)
    title =
      title
        .slice(0, 60)
        .replace(/\s+\S*$/, '')
        .trim() || title.slice(0, 60).trim()
  return title === '' || CONFLICT_COPY.test(title) || title === CONFLICTS || title.toLowerCase().endsWith('.tmp') ? '' : title
}

const readNote = async (io: StoreIO, path: string) => (await readFile(io, path)).note

// The waiting notes as the memory file holds them, leaving out any entry that isn't one.
const goneIn = (saved: unknown): Record<string, Gone> =>
  Object.fromEntries(
    Object.entries((saved ?? {}) as Record<string, Partial<Gone> | undefined>).filter(
      ([, value]) => typeof value?.since === 'number' && typeof value.file === 'string' && typeof value.updated === 'string',
    ),
  ) as Record<string, Gone>

// A mirror folder's store; `dir` is the folder as resolved (src/sync/folder.ts).
export const createMirrorStore = (dir?: string) => {
  // file → the note it held (and that revision's stamp), for files gone since last asked
  // (takeVanished). A file another note took over is keyed `<file>\0<old id>`.
  const vanished = new Map<string, { id: string; updated: string }>()
  // id → a note waiting to be archived, and what's changed of that since the last save.
  const goneNotes = new Map<string, Gone>()
  const pendingGone = new Map<string, Gone | null>()

  const kit = storeKit(
    dir,
    { notesFolder: '', lockSpace: 'mirror' },
    {
      lost: (file, held, isTaken) => void vanished.set(isTaken ? `${file}\u0000${held.id}` : file, held),
      writeFirst: (io, note, lock) => writeNew(io, note, lock),
      memo: {
        name: 'gone',
        recall: saved => {
          for (const [id, value] of Object.entries(goneIn(saved))) if (!goneNotes.has(id)) goneNotes.set(id, value)
        },
        saving: () => {
          const saving = new Map(pendingGone)
          return {
            isPending: saving.size > 0,
            over: saved => {
              const gone = goneIn(saved)
              for (const [id, value] of saving) {
                if (value === null) delete gone[id]
                else gone[id] = value
              }
              return gone
            },
            done: () => {
              for (const [id, value] of saving) if (pendingGone.get(id) === value) pendingGone.delete(id)
            },
          }
        },
      },
    },
  )
  const { serial, scanNow, persist, publish, withLock, copiesOf, write, unreadableFileOf } = kit

  // A note's first file: its first line, then " 2", " 3"… when that's taken. The name is placed,
  // never renamed over, so a file that appears under it meanwhile (another note, another session)
  // is never replaced. The name stays when the text changes, so links to it hold.
  const writeNew = async (io: StoreIO, note: Note, lock: Lock) => {
    const title = titleOf(note.text)
    const names = title === '' ? [] : [`${title}.md`, ...Array.from({ length: 20 }, (_, i) => `${title} ${i + 2}.md`)]
    const folder = kit.dirOf(io)
    const text = serializeNote(note)
    for (const file of [...names, `${note.id}.md`]) {
      if (kit.isTaken(file) || (await io.exists(`${folder}/${file}`))) continue
      const tmp = `${folder}/.${note.id}.${randomTag()}.tmp`
      await io.write(tmp, text)
      if (!(await kit.owns(io, lock))) {
        await io.remove(tmp)
        throw new StorageError(`${note.id} was taken over by another session mid-change; not saved`)
      }
      if (await io.place(tmp, `${folder}/${file}`)) return kit.settle(io, note, file, text)
      await io.remove(tmp)
    }
    throw new StorageError(`no free name for ${note.id}`)
  }

  // The notes waiting to be archived (Gone), as this machine last saved them.
  const gone = async (io: StoreIO) => {
    await kit.recall(io)
    return new Map(goneNotes)
  }

  const markGone = (id: string, value: Gone | null) => {
    if (value === null && !goneNotes.has(id)) return
    if (value === null) goneNotes.delete(id)
    else goneNotes.set(id, value)
    pendingGone.set(id, value)
  }

  // The notes whose files went from the folder (this session, or while none ran: the memory says
  // they were there) and that no file holds now: a mirror reads that as the person deleting them.
  // Each is reported once.
  const takeVanished = () => {
    const present = new Set([...kit.files.values()].map(note => note.id))
    const files = [...vanished]
      .filter(([, { id }]) => !present.has(id) && unreadableFileOf(id) === undefined)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the key joins file and id with a NUL
      .map(([file, { id, updated }]) => ({ id, file: file.replace(/\u0000.*$/, ''), updated }))
    vanished.clear()
    return { files, known: kit.knownCount() + files.length }
  }

  // Removes a file holding `captured`, safely against writers that don't take our locks (editors,
  // sync clients): it's moved to a name of its own that nothing else writes, and only removed if what
  // was moved is what was captured. Anything else goes back where it was, never over a file that
  // took that name since (or stays in the conflicts folder, where the person can see it). Called
  // under the note's lock; true when the file is gone.
  const discard = async (io: StoreIO, file: string, captured: Note, why: string) => {
    const folder = kit.dirOf(io)
    const aside = `${folder}/${CONFLICTS}`
    if (!(await io.mkdirs(aside))) return false
    try {
      const away = `${aside}/${file.replace(/\.md$/, '')}.${randomTag()}.md`
      if ((await io.move(`${folder}/${file}`, away)).exitCode !== 0) return false
      const moved = await readNote(io, away).catch(() => undefined)
      if (moved && serializeNote(moved) === serializeNote(captured)) {
        await io.remove(away)
        kit.drop(file)
        return true
      }
      if (await io.place(away, `${folder}/${file}`)) io.warn(`${why}: ${file} changed meanwhile; kept`)
      else io.warn(`${why}: ${file} changed meanwhile; kept in ${aside}`)
      return false
    } finally {
      await io.rmdir(aside)
    }
  }

  // Takes a note out of the folder (an archived or deleted note, which a mirror doesn't hold): every
  // file holding it goes, unless one holds a revision that beats it (an edit made since). Resolves
  // the folder's revision when that won, else the note given.
  const retire = (io: StoreIO, note: Note) =>
    serial(async () => {
      await scanNow(io)
      if (unreadableFileOf(note.id) !== undefined) return note
      let held = note
      let isRetired = false
      await withLock(io, note.id, async () => {
        const copies = await copiesOf(io, note.id)
        const best = mergeAll(copies.map(([, copy]) => copy)).get(note.id)
        if (best && winner(best, note) === best && serializeNote(best) !== serializeNote(note)) {
          held = best
          return
        }
        for (const [file, captured] of copies) if (await discard(io, file, captured, `retiring ${note.id}`)) isRetired = true
      }).catch(error => io.warn(`retiring ${note.id}: ${message(error)}`))
      if (isRetired) await publish(io)
      await persist(io)
      return held
    })

  // Folds sync clients' conflict copies (Dropbox's "… conflicted copy …", Syncthing's
  // ".sync-conflict-…") into the note's own file and removes them: the merge already counts only the
  // winner, so a copy holds nothing the note's file won't. Only files named as conflict copies are
  // touched; a name the person gave a note is theirs.
  const tidy = (io: StoreIO) =>
    serial(async () => {
      await scanNow(io)
      const folder = kit.dirOf(io)
      const ids = new Set([...kit.files].filter(([file]) => CONFLICT_COPY.test(file)).map(([, note]) => note.id))
      let isTidied = false
      for (const id of ids) {
        if (unreadableFileOf(id) !== undefined) continue
        await withLock(io, id, async lock => {
          const copies = await copiesOf(io, id)
          const best = mergeAll(copies.map(([, copy]) => copy)).get(id)
          // A note that only has conflict copies lives in them; nothing is installed beside them.
          const keep = copies.map(([file]) => file).find(file => !CONFLICT_COPY.test(file))
          if (!best || keep === undefined) return
          const held = copies.find(([file]) => file === keep)?.[1]
          if (!held || serializeNote(held) !== serializeNote(best)) await write(io, best, keep, lock)
          // Nothing is removed unless the winner is really there now (a sync client may have put
          // another revision back meanwhile).
          const there = await readNote(io, `${folder}/${keep}`).catch(() => undefined)
          if (!there || serializeNote(there) !== serializeNote(best)) return
          for (const [file, captured] of copies) {
            if (!CONFLICT_COPY.test(file) || file === keep) continue
            if (await discard(io, file, captured, `tidying ${id}`)) isTidied = true
          }
        }).catch(error => io.warn(`tidying ${id}: ${message(error)}`))
      }
      if (isTidied) await publish(io)
      await persist(io)
    })

  // Saves what's changed in the memory (the waiting notes, say) without a scan.
  const save = (io: StoreIO) => serial(() => persist(io))

  return { ...kit.store, tidy, retire, takeVanished, gone, markGone, save }
}

export type MirrorStore = ReturnType<typeof createMirrorStore>
