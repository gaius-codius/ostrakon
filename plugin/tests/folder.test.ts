import { describe, expect, test } from 'claude-code/testing'

import { parseNote, serializeNote } from '../src/frontmatter'
import { createMirrorStore, titleOf } from '../src/mirror'
import { createStore } from '../src/store'
import type { Store } from '../src/store'
import { createSync, hashOf } from '../src/sync/core'
import type { Sync, SyncIO, SyncStatus } from '../src/sync/core'
import { VANISH_GRACE_MS, folderAdapter } from '../src/sync/folder'
import type { MirrorIO } from '../src/sync/folder'
import { MemDir, memIO } from './memdir'
import type { MemIO } from './memdir'

const MIRROR = '/sync/Ostrakon'
const CC = { key: 'github.com/example/cc', name: 'cc', path: '/home/user/work/cc' }

// One machine: its own notes folder, and a sync with the mirror folder. Machines share one MemDir,
// which stands for Dropbox having carried the mirror's files across already.
type Machine = { io: MemIO; store: Store; mirror: MirrorIO; archived: MirrorIO; sync: Sync; syncIO: SyncIO; statuses: SyncStatus[]; notes: string }

// A mirror store's IO: its own view, over the shared directory.
const mirrorOf = (dir: MemDir, host = 'office'): MirrorIO => {
  const base = memIO(dir, { host })
  return { ...base, env: { home: '/home/me' }, view: () => base.view, problems: () => base.problems }
}

const machine = (host: string, dir: MemDir): Machine => {
  const io = memIO(dir, { root: `/${host}`, host })
  const store = createStore()
  const mirror = mirrorOf(dir, host)
  const archived = mirrorOf(dir, host)
  const live = createMirrorStore(MIRROR)
  const archive = createMirrorStore(`${MIRROR}/Archive`)
  const sync = createSync(
    folderAdapter(
      live,
      archive,
      async () => mirror,
      async () => archived,
      async () => `/${host}/notes`,
      async (id: string) => io.view[id],
    ),
  )
  const statuses: SyncStatus[] = []
  const cache: { text?: string } = {}
  const syncIO: SyncIO = {
    local: async () => io.view,
    absorb: incoming => store.absorb(io, incoming),
    load: async () => cache.text,
    save: async text => {
      cache.text = text
    },
    status: async status => {
      statuses.push(status)
    },
    warn: text => {
      dir.warnings.push(text)
    },
  }
  return { io, store, mirror, archived, sync, syncIO, statuses, notes: `/${host}/notes` }
}

const twoMachines = async () => {
  const dir = new MemDir()
  dir.dirs.set('/sync', 0)
  const [office, mac] = [machine('office', dir), machine('mac', dir)]
  await office.store.loadAll(office.io)
  await mac.store.loadAll(mac.io)
  return { dir, office, mac }
}

const last = (m: Machine) => m.statuses[m.statuses.length - 1]

// Where a note's first file in the mirror is: named after its first line.
const fileOf = (note: { id: string; text: string }) => `${MIRROR}/${titleOf(note.text) || note.id}.md`
const nameOf = (note: { id: string; text: string }) => fileOf(note).slice(MIRROR.length + 1)
// The mirror folder's own files (not Archive's, not _conflicts').
const live = (dir: MemDir) => dir.names(MIRROR).filter(name => !name.includes('/'))

describe('folder adapter', () => {
  test('a note made on one machine reaches another through the mirror folder, as the same revision', async () => {
    const { dir, office, mac } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'check the flaky test', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    expect(parseNote(dir.get(fileOf(made)) ?? '')).toEqual(made)

    await mac.sync.pull(mac.syncIO)
    expect(parseNote(dir.get(`${mac.notes}/${made.id}.md`) ?? '')).toEqual(made)
    expect(mac.io.view[made.id]?.origin).toBe('office')
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test("a note's file in the mirror is named after its first line, and keeps that name", async () => {
    const { dir, office } = await twoMachines()
    const one = await office.store.create(office.io, { text: '# Buy milk\nand bread', by: 'you', project: CC })
    const two = await office.store.create(office.io, { text: 'Buy milk', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    expect(dir.names(MIRROR).sort()).toEqual(['Buy milk 2.md', 'Buy milk.md'])
    expect(new Set([parseNote(dir.get(`${MIRROR}/Buy milk.md`) ?? '').id, parseNote(dir.get(`${MIRROR}/Buy milk 2.md`) ?? '').id])).toEqual(
      new Set([one.id, two.id]),
    )
    await office.store.change(office.io, one.id, note => ({ ...note, text: 'Something else now' }))
    await office.sync.push(office.syncIO)
    expect(dir.names(MIRROR).sort()).toEqual(['Buy milk 2.md', 'Buy milk.md'])
  })

  test('titles: what a file system or an Obsidian link can take, never a conflict-copy name', () => {
    expect(titleOf('  \n## Fix the: flaky/test? #ci [now]  \nmore')).toBe('Fix the flaky test ci now')
    expect(titleOf('- [ ] call the bank')).toBe('call the bank')
    expect(titleOf('...hidden')).toBe('hidden')
    expect(titleOf('x'.repeat(80))).toBe('x'.repeat(60))
    expect(titleOf('one two three four five six seven eight nine ten eleven twelve thirteen')).toBe('one two three four five six seven eight nine ten eleven')
    expect(titleOf("notes (alice's conflicted copy)")).toBe('')
    expect(titleOf('_conflicts')).toBe('')
    expect(titleOf('   ')).toBe('')
  })

  test("a name another file takes while a note is placed isn't written over", async () => {
    const { dir, office } = await twoMachines()
    await office.sync.pull(office.syncIO)
    await office.store.create(office.io, { text: 'Same title', by: 'you', project: CC })
    const place = office.mirror.place
    office.mirror.place = async (from, to) => {
      if (to.endsWith('/Same title.md') && !dir.files.has(to)) dir.put(to, 'someone else\n')
      return place(from, to)
    }
    await office.sync.push(office.syncIO)
    expect(dir.get(`${MIRROR}/Same title.md`)).toBe('someone else\n')
    expect(parseNote(dir.get(`${MIRROR}/Same title 2.md`) ?? '').text).toBe('Same title')
  })

  test('a change on either machine reaches the other, and both settle on the same revision', async () => {
    const { office, mac } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'draft', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)

    await mac.store.change(mac.io, made.id, note => ({ ...note, text: 'edited on the mac' }))
    await mac.sync.push(mac.syncIO)
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.text).toBe('edited on the mac')

    // Both change it before either hears of the other: the later one wins everywhere.
    await office.store.change(office.io, made.id, note => ({ ...note, text: 'office' }))
    await mac.store.change(mac.io, made.id, note => ({ ...note, text: 'mac, later' }))
    await office.sync.push(office.syncIO)
    await mac.sync.push(mac.syncIO)
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)
    expect(serializeNote(office.io.view[made.id]!)).toBe(serializeNote(mac.io.view[made.id]!))
    expect(office.io.view[made.id]?.text).toBe('mac, later')
    expect(last(office)?.queued).toBe(0)
    expect(last(mac)?.queued).toBe(0)
  })

  test('an archive on one machine moves the file to Archive, and the other machine takes that very revision', async () => {
    const { dir, office, mac } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'done soon', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)
    await mac.store.change(mac.io, made.id, note => ({ ...note, status: 'archived' }))
    await mac.sync.push(mac.syncIO)
    expect(live(dir)).toEqual([])
    expect(dir.names(`${MIRROR}/Archive`)).toEqual([nameOf(made)])
    // No wait: the archived copy explains the file going.
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]).toEqual(mac.io.view[made.id])
    expect(office.io.view[made.id]?.status).toBe('archived')
    expect(last(office)?.queued).toBe(0)
    // Restored on the office: back in the folder, out of Archive, and open again on the mac.
    await office.store.change(office.io, made.id, note => ({ ...note, status: 'open' }))
    await office.sync.push(office.syncIO)
    expect(live(dir)).toEqual([nameOf(made)])
    expect(dir.names(`${MIRROR}/Archive`)).toEqual([])
    await mac.sync.pull(mac.syncIO)
    expect(mac.io.view[made.id]?.status).toBe('open')
  })

  test('archiving many notes at once on one machine archives them on the other, nothing put back', async () => {
    const { dir, office, mac } = await twoMachines()
    for (let i = 0; i < 8; i++) await office.store.create(office.io, { text: `bulk ${i}`, by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)
    for (const id of Object.keys(office.io.view)) await office.store.change(office.io, id, note => ({ ...note, status: 'archived' }))
    await office.sync.push(office.syncIO)
    for (let round = 0; round < 3; round++) {
      dir.clock += VANISH_GRACE_MS
      await mac.sync.pull(mac.syncIO)
      await office.sync.pull(office.syncIO)
    }
    expect(Object.values(mac.io.view).every(note => note.status === 'archived')).toBe(true)
    expect(live(dir)).toEqual([])
    expect(dir.names(`${MIRROR}/Archive`)).toHaveLength(8)
  })

  test('a deletion seen just before a restart still archives the note after it', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'deleted, then restarted', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    dir.files.delete(fileOf(made))
    await office.sync.pull(office.syncIO)
    const later = machine('office', dir)
    await later.store.loadAll(later.io)
    await later.sync.pull(later.syncIO)
    expect(live(dir)).toEqual([])
    dir.clock += VANISH_GRACE_MS
    await later.sync.pull(later.syncIO)
    expect(later.io.view[made.id]?.status).toBe('archived')
  })

  test("a file that comes back unreadable puts the note's archive on hold", async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'mid-edit', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const text = dir.get(fileOf(made)) ?? ''
    dir.files.delete(fileOf(made))
    await office.sync.pull(office.syncIO)
    dir.put(fileOf(made), text.replace('status: open', 'status: [broken'))
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('open')
    dir.put(fileOf(made), text)
    await office.sync.pull(office.syncIO)
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('open')
    expect(live(dir)).toEqual([nameOf(made)])
  })

  test("a note's file name taken by a new note while a machine was away still archives the old one there", async () => {
    const { dir, office, mac } = await twoMachines()
    const old = await office.store.create(office.io, { text: 'Buy milk', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)
    // Obsidian: the old note deleted, a new one made under the same name, while the mac is away.
    dir.files.delete(fileOf(old))
    const fresh = { ...old, id: '01JA00000000000000000000NW', text: 'Buy milk', created: old.updated }
    dir.put(fileOf(old), serializeNote(fresh))
    const later = machine('mac', dir)
    await later.store.loadAll(later.io)
    await later.sync.pull(later.syncIO)
    dir.clock += VANISH_GRACE_MS
    await later.sync.pull(later.syncIO)
    expect(later.io.view[old.id]?.status).toBe('archived')
    expect(later.io.view[fresh.id]?.status).toBe('open')
  })

  test('every note the folder held going at once is put back, however few', async () => {
    const { dir, office } = await twoMachines()
    for (let i = 0; i < 3; i++) await office.store.create(office.io, { text: `few ${i}`, by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const names = live(dir)
    for (const name of names) dir.files.delete(`${MIRROR}/${name}`)
    await office.sync.pull(office.syncIO)
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(live(dir).sort()).toEqual(names.sort())
    expect(Object.values(office.io.view).every(note => note.status === 'open')).toBe(true)
  })

  test("an archived note left in the folder is moved to Archive, and stays put while Archive can't be written", async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'stray', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const newer = { ...made, status: 'archived' as const, updated: new Date(Date.parse(made.updated) + 60_000).toISOString(), origin: 'mac' }
    dir.put(fileOf(made), serializeNote(newer))
    const place = office.archived.place
    office.archived.place = async () => false
    await office.sync.pull(office.syncIO)
    expect(parseNote(dir.get(fileOf(made)) ?? '')).toEqual(newer)
    office.archived.place = place
    await office.sync.pull(office.syncIO)
    expect(live(dir)).toEqual([])
    expect(dir.names(`${MIRROR}/Archive`).map(name => parseNote(dir.get(`${MIRROR}/Archive/${name}`) ?? ''))).toEqual([newer])
    expect(office.io.view[made.id]).toEqual(newer)
  })

  test('a late older live copy of an archived note is taken out, though it changes nothing the core sees', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'late copy', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const old = dir.get(fileOf(made)) ?? ''
    await office.store.change(office.io, made.id, note => ({ ...note, status: 'archived' }))
    await office.sync.push(office.syncIO)
    dir.put(fileOf(made), old)
    await office.sync.pull(office.syncIO)
    await office.sync.pull(office.syncIO)
    expect(live(dir)).toEqual([])
    expect(office.io.view[made.id]?.status).toBe('archived')
  })

  test("an old archived copy arriving late doesn't stop a later delete from archiving", async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'twice', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await office.store.change(office.io, made.id, note => ({ ...note, status: 'archived' }))
    await office.sync.push(office.syncIO)
    const stale = dir.names(`${MIRROR}/Archive`).map(name => dir.get(`${MIRROR}/Archive/${name}`) ?? '')[0] ?? ''
    await office.store.change(office.io, made.id, note => ({ ...note, status: 'open' }))
    await office.sync.push(office.syncIO)
    // The deletion in Obsidian, then the old archive delivered late by the sync client.
    for (const name of live(dir)) dir.files.delete(`${MIRROR}/${name}`)
    await office.sync.pull(office.syncIO)
    dir.put(`${MIRROR}/Archive/twice.md`, stale)
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('archived')
    expect(Date.parse(office.io.view[made.id]?.updated ?? '') > Date.parse(parseNote(stale).updated)).toBe(true)
    expect(live(dir)).toEqual([])
  })

  test('a file renamed with a # in it that comes back unreadable still holds the archive', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'tagged', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const text = dir.get(fileOf(made)) ?? ''
    dir.files.delete(fileOf(made))
    dir.put(`${MIRROR}/N#tag.md`, text)
    await office.sync.pull(office.syncIO)
    dir.files.delete(`${MIRROR}/N#tag.md`)
    await office.sync.pull(office.syncIO)
    dir.put(`${MIRROR}/N#tag.md`, text.replace('status: open', 'status: [broken'))
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('open')
  })

  test('a note reopened right after it was archived stays open', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'back and forth', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await office.store.change(office.io, made.id, note => ({ ...note, status: 'archived' }))
    await office.sync.push(office.syncIO)
    await office.store.change(office.io, made.id, note => ({ ...note, status: 'open' }))
    await office.sync.push(office.syncIO)
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('open')
    expect(live(dir)).toEqual([nameOf(made)])
  })

  test("an edit made in the mirror (Obsidian) comes in as a change, though it didn't touch the stamp", async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'old words', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)

    const file = fileOf(made)
    dir.put(file, (dir.get(file) ?? '').replace('old words', 'new words'))
    await office.sync.pull(office.syncIO)
    const note = office.io.view[made.id]
    expect(note?.text).toBe('new words')
    expect(note && Date.parse(note.updated) > Date.parse(made.updated)).toBe(true)
    // The bumped stamp went back into the mirror file, so every machine sees the same revision.
    expect(parseNote(dir.get(file) ?? '').updated).toBe(note?.updated)
  })

  test("a sync client's conflict copy is merged by id, and the newer copy wins", async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'first', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)

    const newer = { ...made, text: 'from the other machine', updated: new Date(Date.parse(made.updated) + 60_000).toISOString(), origin: 'mac' }
    dir.put(`${MIRROR}/${made.id} (mac's conflicted copy).md`, serializeNote(newer))
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]).toEqual(newer)
    expect(Object.keys(office.io.view)).toEqual([made.id])
    // Folded into the note's own file, and gone; an older copy just goes.
    expect(dir.names(MIRROR)).toEqual([nameOf(made)])
    expect(parseNote(dir.get(fileOf(made)) ?? '')).toEqual(newer)
    dir.put(`${MIRROR}/${made.id}.sync-conflict-20261010-101010-ABCDEF.md`, serializeNote(made))
    await office.sync.pull(office.syncIO)
    expect(dir.names(MIRROR)).toEqual([nameOf(made)])
    expect(office.io.view[made.id]).toEqual(newer)
    // A file the person named is theirs, conflict or not.
    dir.put(`${MIRROR}/My copy.md`, serializeNote({ ...made, text: 'mine' }))
    await office.sync.pull(office.syncIO)
    expect(dir.names(MIRROR).sort()).toEqual([nameOf(made), 'My copy.md'].sort())
  })

  test('a note file deleted from the mirror (in Obsidian) archives the note once it has stayed gone', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'delete me', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)

    dir.files.delete(fileOf(made))
    await office.sync.pull(office.syncIO)
    // Not yet: a rename may be on its way as a delete and a create. Meanwhile it isn't written back.
    expect(office.io.view[made.id]?.status).toBe('open')
    await office.store.change(office.io, made.id, note => ({ ...note, text: 'delete me, edited' }))
    await office.sync.push(office.syncIO)
    expect(live(dir)).toEqual([])
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('archived')
    expect(office.io.view[made.id]?.origin).toBe('office')
    const archived = dir.names(`${MIRROR}/Archive`).map(name => parseNote(dir.get(`${MIRROR}/Archive/${name}`) ?? ''))
    expect(archived).toEqual([office.io.view[made.id]])
    expect(live(dir)).toEqual([])
  })

  test('a delete then a create of the same note (a rename on its way) archives nothing', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'renamed elsewhere', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const text = dir.get(fileOf(made)) ?? ''
    dir.files.delete(fileOf(made))
    await office.sync.pull(office.syncIO)
    dir.put(`${MIRROR}/New name.md`, text)
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.status).toBe('open')
    expect(dir.names(MIRROR)).toEqual(['New name.md'])
  })

  test('a note deleted while no session ran is archived by the next', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'gone while closed', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    dir.files.delete(fileOf(made))
    const later = machine('office', dir)
    await later.store.loadAll(later.io)
    await later.sync.pull(later.syncIO)
    expect(dir.names(MIRROR)).toEqual([])
    dir.clock += VANISH_GRACE_MS
    await later.sync.pull(later.syncIO)
    expect(later.io.view[made.id]?.status).toBe('archived')
  })

  test('many notes going at once are put back, not archived', async () => {
    const { dir, office } = await twoMachines()
    for (let i = 0; i < 8; i++) await office.store.create(office.io, { text: `note ${i}`, by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const names = dir.names(MIRROR)
    for (const name of names) dir.files.delete(`${MIRROR}/${name}`)
    await office.sync.pull(office.syncIO)
    dir.clock += VANISH_GRACE_MS
    await office.sync.pull(office.syncIO)
    expect(dir.names(MIRROR).sort()).toEqual(names.sort())
    expect(Object.values(office.io.view).every(note => note.status === 'open')).toBe(true)
    expect(dir.warnings.some(text => text.includes('8 notes went at once'))).toBe(true)
  })

  test("a file in the mirror that isn't a note is left alone, and noted once", async () => {
    const { dir, office } = await twoMachines()
    dir.put(`${MIRROR}/ideas.md`, '# my own page\n')
    await office.sync.pull(office.syncIO)
    await office.store.create(office.io, { text: 'a note', by: 'you', project: CC })
    await office.sync.push(office.syncIO)
    await office.sync.pull(office.syncIO)
    expect(dir.get(`${MIRROR}/ideas.md`)).toBe('# my own page\n')
    expect(Object.values(office.io.view).map(note => note.text)).toEqual(['a note'])
    expect(dir.warnings.filter(text => text.includes('ideas.md'))).toHaveLength(1)
  })

  test('a note renamed in the mirror lives on in that file, and a broken one is never written beside it', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'named in obsidian', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const renamed = `${MIRROR}/Readable title.md`
    dir.put(renamed, dir.get(fileOf(made)) ?? '')
    dir.files.delete(fileOf(made))
    await office.sync.pull(office.syncIO)
    await office.store.change(office.io, made.id, note => ({ ...note, text: 'changed here' }))
    await office.sync.push(office.syncIO)
    expect(dir.names(MIRROR)).toEqual(['Readable title.md'])
    expect(parseNote(dir.get(renamed) ?? '').text).toBe('changed here')

    // Broken in the editor: the note looks gone from the mirror, but isn't written again beside it.
    const good = dir.get(renamed) ?? ''
    dir.put(renamed, good.replace('status: open', 'status: [broken'))
    await office.sync.pull(office.syncIO)
    await office.sync.pull(office.syncIO)
    expect(dir.names(MIRROR)).toEqual(['Readable title.md'])
    dir.put(renamed, good.replace('changed here', 'mended'))
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.text).toBe('mended')
    expect(dir.names(MIRROR)).toEqual(['Readable title.md'])
  })

  test('a mirror whose parent is missing (a drive not mounted) is a problem, with what waits to go', async () => {
    const dir = new MemDir()
    const office = machine('office', dir)
    await office.store.loadAll(office.io)
    await office.store.create(office.io, { text: 'waiting', by: 'you', project: CC })
    await expect(office.sync.pull(office.syncIO)).rejects.toThrow('mirror folder missing')
    expect(last(office)).toEqual({ isOnline: false, queued: 1, problem: `mirror folder missing: ${MIRROR}` })
    expect(dir.names(MIRROR)).toEqual([])

    // The drive comes back: the folder is made and the note goes out.
    dir.dirs.set('/sync', 0)
    await office.sync.pull(office.syncIO)
    expect(dir.names(MIRROR)).toHaveLength(1)
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test('a waiting pull answers as soon as another machine writes to the mirror', async () => {
    const { dir, office, mac } = await twoMachines()
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)

    // The office's next pull waits; the mac writes while it does.
    let sleeps = 0
    office.mirror.sleep = async () => {
      sleeps += 1
      if (sleeps === 2) {
        await mac.store.create(mac.io, { text: 'from the mac', by: 'you', project: CC })
        await mac.sync.push(mac.syncIO)
      }
    }
    await office.sync.pull(office.syncIO)
    expect(sleeps).toBe(2)
    expect(Object.values(office.io.view).map(note => note.text)).toEqual(['from the mac'])
    expect(dir.warnings).toEqual([])
  })

  test('a mirror that moves back to an older revision (a restored file) gets the newer one again', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'old', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    const file = fileOf(made)
    const old = dir.get(file) ?? ''
    await office.store.change(office.io, made.id, note => ({ ...note, text: 'new' }))
    await office.sync.push(office.syncIO)
    expect(parseNote(dir.get(file) ?? '').text).toBe('new')

    dir.put(file, old)
    await office.sync.pull(office.syncIO)
    expect(parseNote(dir.get(file) ?? '').text).toBe('new')
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test('two spellings of one mirror folder share its locks', async () => {
    const dir = new MemDir()
    dir.dirs.set('/sync', 0)
    const io = memIO(dir)
    const plain = { ...io, env: { home: '/home/me' } }
    const [one, two] = [createMirrorStore('/sync/m'), createMirrorStore('/sync/m/')]
    const note = parseNote(
      serializeNote({
        id: '01JA0000000000000000000001',
        status: 'open',
        by: 'you',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        origin: 'office',
        project: null,
        context: {},
        sentAt: null,
        deleted: false,
        text: 'a',
        extra: [],
      }),
    )
    // The first write stalls holding the note's lock; the second spelling must wait for it.
    let open = () => {}
    const gate = new Promise<void>(resolve => {
      open = resolve
    })
    const stalled = {
      ...plain,
      write: async (path: string, text: string) => (path.endsWith('.tmp') ? gate.then(() => plain.write(path, text)) : plain.write(path, text)),
    }
    const first = one.absorb(stalled, [note])
    for (let i = 0; i < 50; i++) await Promise.resolve()
    const second = await two.absorb(plain, [{ ...note, text: 'b', updated: '2026-10-10T00:00:01.000Z' }])
    open()
    await first
    expect(second.failed).toEqual([note.id])
  })

  test('a mirror set to the notes folder itself is refused', async () => {
    const dir = new MemDir()
    const io = memIO(dir, { root: '/office', host: 'office' })
    const [mirror, archived] = [mirrorOf(dir), mirrorOf(dir)]
    const sync = createSync(
      folderAdapter(
        createMirrorStore('/office/notes'),
        createMirrorStore('/office/notes/Archive'),
        async () => mirror,
        async () => archived,
        async () => '/office/notes',
        async () => undefined,
      ),
    )
    const statuses: SyncStatus[] = []
    const syncIO: SyncIO = {
      local: async () => io.view,
      absorb: async () => ({ failed: [] }),
      load: async () => undefined,
      save: async () => {},
      status: async status => void statuses.push(status),
      warn: () => {},
    }
    await expect(sync.pull(syncIO)).rejects.toThrow('mirror folder is the notes folder')
    expect(statuses[statuses.length - 1]?.problem).toBe('mirror folder is the notes folder')
  })

  test('an edit made in the mirror while no session ran still wins when the next session starts', async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'old words', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)

    // Claude Code is closed; Obsidian edits the file and leaves `updated` alone. Text alone would
    // break the tie the wrong way ('new' sorts before 'old').
    const file = fileOf(made)
    dir.put(file, (dir.get(file) ?? '').replace('old words', 'new words'))
    const later = machine('office', dir)
    await later.store.loadAll(later.io)
    await later.sync.pull(later.syncIO)
    expect(later.io.view[made.id]?.text).toBe('new words')
    expect(parseNote(dir.get(file) ?? '').text).toBe('new words')
    expect(parseNote(dir.get(`${later.notes}/${made.id}.md`) ?? '').text).toBe('new words')
  })

  test('a push that partly fails counts nothing as handed: a newer mirror revision still comes in', async () => {
    const { dir, office, mac } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'shared', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    await mac.sync.pull(mac.syncIO)

    await office.store.change(office.io, made.id, note => ({ ...note, text: 'office, earlier' }))
    await mac.store.change(mac.io, made.id, note => ({ ...note, text: 'mac, later' }))
    await mac.sync.push(mac.syncIO)
    const other = await office.store.create(office.io, { text: 'will not write', by: 'you', project: CC })
    const write = office.mirror.write
    office.mirror.write = async (path, text) => {
      if (path.includes(other.id) && path.endsWith('.tmp')) throw new Error('EIO')
      return write(path, text)
    }
    await office.sync.push(office.syncIO)
    office.mirror.write = write
    await office.sync.pull(office.syncIO)
    expect(office.io.view[made.id]?.text).toBe('mac, later')
    // The failed note goes on the push's own retry (a timer in a session; called here).
    await office.sync.push(office.syncIO)
    expect(dir.names(MIRROR)).toHaveLength(2)
  })

  test("a note whose mirror file won't parse is left for the person to mend, and not sent again", async () => {
    const { dir, office } = await twoMachines()
    const made = await office.store.create(office.io, { text: 'fine', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    dir.put(fileOf(made), '---\nid: [broken\n')
    await office.store.change(office.io, made.id, note => ({ ...note, text: 'changed' }))
    await office.sync.push(office.syncIO)
    await office.sync.push(office.syncIO)
    expect(dir.get(fileOf(made))).toBe('---\nid: [broken\n')
    expect(dir.warnings.filter(text => text.includes("can't be read; not replaced"))).toHaveLength(1)
    expect(last(office)?.queued).toBe(0)
  })

  test("a mirror folder this machine used before isn't made again empty (a drive unmounted, its mount point left)", async () => {
    const { dir, office } = await twoMachines()
    await office.store.create(office.io, { text: 'mine', by: 'you', project: CC })
    await office.sync.pull(office.syncIO)
    for (const name of dir.names(MIRROR)) dir.files.delete(`${MIRROR}/${name}`)
    dir.dirs.delete(MIRROR)

    await expect(office.sync.pull(office.syncIO)).rejects.toThrow('mirror folder missing')
    const later = machine('office', dir)
    await later.store.loadAll(later.io)
    await expect(later.sync.pull(later.syncIO)).rejects.toThrow('mirror folder missing')
    expect(dir.names(MIRROR)).toEqual([])
  })
})

describe("a folder's memory between sessions", () => {
  const NOTES = '/data/ostrakon/notes'
  const memo = (dir: MemDir) =>
    JSON.parse(dir.get(`/home/me/.cache/ostrakon/seen-${hashOf(NOTES)}.json`) ?? '{}') as {
      dir?: string
      isUsed?: boolean
      files?: Record<string, { updated: string }>
    }

  test('a session saves only what it saw change, never its older view of the rest', async () => {
    const dir = new MemDir()
    const [a, b] = [memIO(dir, { host: 'office' }), memIO(dir, { host: 'office' })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'first', by: 'you', project: CC })
    await two.loadAll(b)
    const changed = await two.change(b, made.id, note => ({ ...note, text: 'second' }))
    // The first session hasn't looked since; it saves after making another note.
    await one.create(a, { text: 'other', by: 'you', project: CC })
    expect(memo(dir).files?.[`${made.id}.md`]?.updated).toBe(changed.updated)
  })

  test('a file gone from the folder is forgotten on disk too; the folder stays known as used', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'brief', by: 'you', project: CC })
    dir.files.delete(`${NOTES}/${made.id}.md`)
    dir.dirs.set(NOTES, 0)
    await store.scan(io)
    expect(memo(dir).files).toEqual({})
    expect(memo(dir).isUsed).toBe(true)
    expect(await createStore().hasHistory(io)).toBe(true)
  })

  test('a save that fails is tried again with the next, though nothing new changed', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const move = io.move
    let isFailing = true
    io.move = async (from, to) => (isFailing && to.includes('/seen-') ? { exitCode: 1, stderr: 'EIO' } : move(from, to))
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'kept', by: 'you', project: CC })
    expect(memo(dir).files).toBeUndefined()
    expect(dir.warnings.some(text => text.includes('EIO'))).toBe(true)
    isFailing = false
    await store.scan(io)
    expect(Object.keys(memo(dir).files ?? {})).toEqual([`${made.id}.md`])
  })

  test("a memory file naming another folder (a name that hashed alike) isn't taken for this one's", async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    dir.put(`/home/me/.cache/ostrakon/seen-${hashOf(NOTES)}.json`, JSON.stringify({ dir: '/elsewhere', isUsed: true, files: {} }))
    expect(await createStore().hasHistory(io)).toBe(false)
  })

  test('a file in the nested form written before P6 is never taken for an edit by the next session', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const old = [
      '---',
      'id: 01JA0000000000000000000001',
      'status: open',
      'by: you',
      'created: 2026-10-10T00:00:00.000Z',
      'updated: 2026-10-10T00:00:00.000Z',
      'origin: office',
      'project:',
      '  key: github.com/example/cc',
      '  name: cc',
      '  path: /home/user/work/cc',
      'sentAt: null',
      'deleted: false',
      '---',
      'old form',
      '',
    ].join('\n')
    dir.put(`${NOTES}/01JA0000000000000000000001.md`, old)
    await createStore().loadAll(io)
    const later = memIO(dir)
    await createStore().loadAll(later)
    expect(later.view['01JA0000000000000000000001']?.updated).toBe('2026-10-10T00:00:00.000Z')
    expect(dir.get(`${NOTES}/01JA0000000000000000000001.md`)).toBe(old)
  })

  test("a memory file that can't be read counts as used, and so does what this session saw", async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    await store.create(io, { text: 'seen', by: 'you', project: CC })
    const read = io.read
    io.read = async path => (path.includes('/seen-') ? Promise.reject(new Error('EIO')) : read(path))
    expect(await store.hasHistory(io)).toBe(true)
    expect(await createStore().hasHistory(io)).toBe(true)
  })
})

describe('tidying conflict copies never loses a note', () => {
  const M = '/sync/m'
  const setup = async () => {
    const dir = new MemDir()
    dir.dirs.set('/sync', 0)
    const io = { ...memIO(dir), env: { home: '/home/me' } }
    const store = createMirrorStore(M)
    const base = parseNote(
      serializeNote({
        id: '01JA0000000000000000000001',
        status: 'open',
        by: 'you',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        origin: 'office',
        project: null,
        context: {},
        sentAt: null,
        deleted: false,
        text: 'old',
        extra: [],
      }),
    )
    const newer = { ...base, text: 'newer', updated: '2026-10-10T00:01:00.000Z' }
    dir.put(`${M}/${base.id}.md`, serializeNote(base))
    dir.put(`${M}/${base.id} (conflicted copy).md`, serializeNote(newer))
    return { dir, io, store, base, newer }
  }

  test('a copy that changes while it is tidied is kept', async () => {
    const { dir, io, store, base } = await setup()
    const other = { ...base, id: '01JA0000000000000000000009', text: 'only here' }
    const move = io.move
    io.move = async (from, to) => {
      const result = await move(from, to)
      if (to === `${M}/${base.id}.md`) dir.put(`${M}/${base.id} (conflicted copy).md`, serializeNote(other))
      return result
    }
    await store.tidy(io)
    const texts = dir.names(M).map(name => parseNote(dir.get(`${M}/${name}`) ?? '').text)
    expect(texts).toContain('only here')
  })

  test("copies stay when the winner didn't stick in the note's file", async () => {
    const { dir, io, store, base } = await setup()
    const move = io.move
    io.move = async (from, to) => {
      const result = await move(from, to)
      if (to === `${M}/${base.id}.md`) dir.put(to, serializeNote(base))
      return result
    }
    await store.tidy(io)
    expect(dir.names(M)).toContain(`${base.id} (conflicted copy).md`)
  })

  test("a note's name held by another note is left alone, and so is the copy", async () => {
    const dir = new MemDir()
    dir.dirs.set('/sync', 0)
    const io = { ...memIO(dir), env: { home: '/home/me' } }
    const store = createMirrorStore(M)
    const a = parseNote(
      serializeNote({
        id: '01JA000000000000000000000A',
        status: 'open',
        by: 'you',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        origin: 'office',
        project: null,
        context: {},
        sentAt: null,
        deleted: false,
        text: 'note a',
        extra: [],
      }),
    )
    const b = { ...a, id: '01JA000000000000000000000B', text: 'note b' }
    dir.put(`${M}/${a.id}.md`, serializeNote(b))
    dir.put(`${M}/${a.id} (conflicted copy).md`, serializeNote(a))
    await store.tidy(io)
    expect(parseNote(dir.get(`${M}/${a.id}.md`) ?? '').text).toBe('note b')
    expect(parseNote(dir.get(`${M}/${a.id} (conflicted copy).md`) ?? '').text).toBe('note a')
  })

  test('a changed copy whose name was taken meanwhile stays in _conflicts; nothing is written over', async () => {
    const { dir, io, store, base } = await setup()
    const changed = { ...base, id: '01JA0000000000000000000009', text: 'changed copy' }
    const arrived = { ...base, id: '01JA0000000000000000000008', text: 'arrived meanwhile' }
    const move = io.move
    io.move = async (from, to) => {
      // The sync client rewrites the copy just before it's moved aside, and drops another file at
      // its name just after.
      if (to.includes('/_conflicts/')) dir.put(from, serializeNote(changed))
      const result = await move(from, to)
      if (to.includes('/_conflicts/')) dir.put(from, serializeNote(arrived))
      return result
    }
    await store.tidy(io)
    const all = [...dir.files.keys()].filter(path => path.startsWith(`${M}/`)).map(path => parseNote(dir.get(path) ?? '').text)
    expect(all).toContain('changed copy')
    expect(all).toContain('arrived meanwhile')
    expect(dir.warnings.some(text => text.includes('kept in /sync/m/_conflicts'))).toBe(true)
  })

  test('a note with only conflict copies is left in them', async () => {
    const dir = new MemDir()
    dir.dirs.set('/sync', 0)
    const io = { ...memIO(dir), env: { home: '/home/me' } }
    const store = createMirrorStore(M)
    const a = parseNote(
      serializeNote({
        id: '01JA000000000000000000000A',
        status: 'open',
        by: 'you',
        created: '2026-10-10T00:00:00.000Z',
        updated: '2026-10-10T00:00:00.000Z',
        origin: 'office',
        project: null,
        context: {},
        sentAt: null,
        deleted: false,
        text: 'only a copy',
        extra: [],
      }),
    )
    dir.put(`${M}/${a.id} (conflicted copy).md`, serializeNote(a))
    await store.tidy(io)
    expect(dir.names(M)).toEqual([`${a.id} (conflicted copy).md`])
  })
})
