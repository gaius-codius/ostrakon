// Regression tests for the P1 review (Claude and Codex lanes): interleavings that could lose or
// hide a change, and copies of one note that must merge the same way everywhere.

import { describe, expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { parseNote, serializeNote } from '../src/frontmatter'
import { mergeAll } from '../src/merge'
import { createStore } from '../src/store'
import { MemDir, memIO } from './memdir'

const DIR = '/data/ostrakon/notes'
const LOCKS = '/home/me/.cache/ostrakon/locks'
const CC = { key: 'github.com/example/cc', name: 'cc', path: '/home/user/work/cc' }

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const gate = () => {
  let open = () => {}
  const opened = new Promise<void>(resolve => (open = resolve))
  return { opened, open }
}

const onDisk = (dir: MemDir, id: string) => parseNote(dir.get(`${DIR}/${id}.md`) ?? '')

describe('two sessions changing one note', () => {
  test('a change held mid-write never overwrites the other session’s change', async () => {
    const dir = new MemDir()
    const [a, b] = [memIO(dir, { host: 'office' }), memIO(dir, { host: 'mac' })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'original', by: 'you', project: CC })
    await two.loadAll(b)

    // B reads, then stalls before its rename. A asks for the lock meanwhile and has to wait.
    const bStalled = gate()
    const moveB = b.move
    b.move = async (from, to) => {
      await bStalled.opened
      return moveB(from, to)
    }
    const aWaits = gate()
    a.sleep = () => aWaits.opened
    dir.tick()
    const archiving = two.change(b, made.id, note => ({ ...note, status: 'archived' }))
    await settle()
    const editing = one.change(a, made.id, note => ({ ...note, text: 'edited by A' }))
    await settle()
    expect(onDisk(dir, made.id).text).toBe('original')

    bStalled.open()
    await archiving
    aWaits.open()
    await editing

    const final = onDisk(dir, made.id)
    expect(final.text).toBe('edited by A')
    expect(final.status).toBe('archived')
    expect(dir.names(DIR).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(dir.dirs.size).toBe(0)
  })

  test('a lock is taken over only from an owner that has exited', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'x', by: 'you', project: CC })
    const lock = `${LOCKS}/${made.id}`
    const holdLock = (owner: string | undefined, age = 0) => {
      dir.dirs.set(lock, dir.clock - age)
      if (owner === undefined) dir.files.delete(`${lock}/owner`)
      else dir.put(`${lock}/owner`, owner, dir.clock - age)
    }
    const attempt = () =>
      store
        .change(io, made.id, note => ({ ...note, text: `${note.text}+` }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        )

    holdLock('tok 999 boot') // process 999 isn't running
    expect(await attempt()).toBe('saved')
    holdLock('tok 4242 earlier') // pid 4242 runs, but it's a later process that reused the pid
    expect(await attempt()).toBe('saved')
    holdLock('tok 4242 boot', 24 * 60 * 60_000) // a live owner, however old: never taken
    expect(await attempt()).toContain('being changed by another session')
    expect(dir.get(`${lock}/owner`)).toBe('tok 4242 boot')
    holdLock(undefined) // ownerless and fresh: its owner may be about to write the file
    expect(await attempt()).toContain('being changed by another session')
    holdLock(undefined, 2 * 60_000) // ownerless and old: a crash between mkdir and the owner file
    expect(await attempt()).toBe('saved')
    expect(onDisk(dir, made.id).text).toBe('x+++')
    expect([...dir.dirs.keys()]).toEqual([])
  })

  test('a stalled live owner keeps its lock; one that exited loses it and saves nothing', async () => {
    const dir = new MemDir()
    dir.running.set(1, 'a').set(2, 'b')
    const [a, b] = [memIO(dir, { pid: 1 }), memIO(dir, { pid: 2 })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'original', by: 'you', project: CC })
    await two.loadAll(b)
    const stall = () => {
      const stalled = gate()
      const write = b.write
      b.write = async (path, text) => {
        await write(path, text)
        if (path.endsWith('.tmp')) {
          b.write = write
          await stalled.opened
        }
      }
      return stalled
    }

    let stalled = stall()
    let bChange = two
      .change(b, made.id, note => ({ ...note, text: 'from B' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    await settle()
    dir.clock += 60 * 60_000
    expect(
      await one
        .change(a, made.id, note => ({ ...note, text: 'from A' }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toContain('being changed')
    stalled.open()
    expect(await bChange).toBe('saved')
    expect(onDisk(dir, made.id).text).toBe('from B')

    stalled = stall()
    bChange = two
      .change(b, made.id, note => ({ ...note, text: 'from B again' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    await settle()
    dir.running.delete(2) // B's process is gone
    await one.change(a, made.id, note => ({ ...note, text: 'from A' }))
    stalled.open()
    expect(await bChange).toContain('taken over')
    expect(onDisk(dir, made.id).text).toBe('from A')
    expect(dir.names(DIR).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('a recoverer never clears a lock someone took after it judged the old one abandoned', async () => {
    const dir = new MemDir()
    dir.running.set(1, 'a').set(2, 'b')
    const [a, b] = [memIO(dir, { pid: 1 }), memIO(dir, { pid: 2 })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'original', by: 'you', project: CC })
    await two.loadAll(b)
    dir.dirs.set(`${LOCKS}/${made.id}`, dir.clock)
    dir.put(`${LOCKS}/${made.id}/owner`, 'dead 999 gone')

    // A judges the lock abandoned, then stalls before its recovery guard.
    const aPaused = gate()
    const mkdir = a.mkdir
    a.mkdir = async path => {
      if (path.includes('.recovering-')) {
        a.mkdir = mkdir
        await aPaused.opened
      }
      return mkdir(path)
    }
    const aWaits = gate()
    a.sleep = () => aWaits.opened
    const aChange = one
      .change(a, made.id, note => ({ ...note, status: 'archived' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    await settle()
    // Meanwhile B recovers it, takes a fresh lock and stalls mid-write holding it.
    const bStalled = gate()
    const write = b.write
    b.write = async (path, text) => {
      await write(path, text)
      if (path.endsWith('.tmp')) {
        b.write = write
        await bStalled.opened
      }
    }
    const bChange = two
      .change(b, made.id, note => ({ ...note, text: 'from B' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    await settle()
    aPaused.open()
    await settle()
    bStalled.open()
    expect(await bChange).toBe('saved')
    aWaits.open()
    expect(await aChange).toBe('saved')
    const final = onDisk(dir, made.id)
    expect(final.text).toBe('from B')
    expect(final.status).toBe('archived')
  })

  test('a stalled recoverer keeps its guard; nobody else clears the lock it is recovering', async () => {
    const dir = new MemDir()
    dir.running.set(1, 'a').set(2, 'b')
    const [a, b] = [memIO(dir, { pid: 1 }), memIO(dir, { pid: 2 })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'original', by: 'you', project: CC })
    await two.loadAll(b)
    dir.dirs.set(`${LOCKS}/${made.id}`, dir.clock)
    dir.put(`${LOCKS}/${made.id}/owner`, 'dead 999 gone')
    // A has judged the dead lock abandoned under its guard and stalls just before moving it away.
    const aPaused = gate()
    const move = a.move
    a.move = async (from, to) => {
      if (to.includes('.abandoned-')) {
        a.move = move
        await aPaused.opened
      }
      return move(from, to)
    }
    const aChange = one
      .change(a, made.id, note => ({ ...note, status: 'archived' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    await settle()
    dir.clock += 24 * 60 * 60_000
    const bChange = await two
      .change(b, made.id, note => ({ ...note, text: 'from B' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    expect(bChange).toContain('being changed')
    aPaused.open()
    expect(await aChange).toBe('saved')
    expect(onDisk(dir, made.id).status).toBe('archived')
    expect(onDisk(dir, made.id).text).toBe('original')
  })

  test('a recoverer that died holding its guard doesn’t strand the lock', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'x', by: 'you', project: CC })
    dir.dirs.set(`${LOCKS}/${made.id}`, dir.clock)
    dir.put(`${LOCKS}/${made.id}/owner`, 'dead 999 gone')
    dir.dirs.set(`${LOCKS}/${made.id}.recovering-dead`, dir.clock)
    dir.put(`${LOCKS}/${made.id}.recovering-dead/owner`, 'alsodead 998 gone')
    expect(
      await store
        .change(io, made.id, note => ({ ...note, text: 'y' }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toBe('saved')
    expect(onDisk(dir, made.id).text).toBe('y')
  })

  test('any chain of dead recoverers is unwound', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'x', by: 'you', project: CC })
    const lock = `${LOCKS}/${made.id}`
    dir.dirs.set(lock, dir.clock)
    dir.put(`${lock}/owner`, 't0 900 gone')
    for (let i = 1; i <= 6; i++) {
      dir.dirs.set(`${lock}.recovering-t${i - 1}`, dir.clock)
      dir.put(`${lock}.recovering-t${i - 1}/owner`, `t${i} ${900 + i} gone`)
    }
    expect(
      await store
        .change(io, made.id, note => ({ ...note, text: 'y' }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toBe('saved')
  })

  test('an owner whose state can’t be looked up is never taken over', async () => {
    const dir = new MemDir()
    dir.running.set(1, 'a').set(2, 'b')
    const [a, b] = [memIO(dir, { pid: 1 }), memIO(dir, { pid: 2 })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'original', by: 'you', project: CC })
    await two.loadAll(b)
    const bStalled = gate()
    const write = b.write
    b.write = async (path, text) => {
      await write(path, text)
      if (path.endsWith('.tmp')) {
        b.write = write
        await bStalled.opened
      }
    }
    const bChange = two
      .change(b, made.id, note => ({ ...note, text: 'from B' }))
      .then(
        () => 'saved',
        (e: Error) => e.message,
      )
    await settle()
    dir.unknowable.add(2)
    expect(
      await one
        .change(a, made.id, note => ({ ...note, text: 'from A' }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toContain('being changed')
    bStalled.open()
    expect(await bChange).toBe('saved')
    expect(onDisk(dir, made.id).text).toBe('from B')
  })

  test('a session that can’t identify its own process doesn’t lock', async () => {
    const dir = new MemDir()
    dir.unknowable.add(4242)
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'x', by: 'you', project: CC })
    expect(
      await store
        .change(io, made.id, note => note)
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toContain("couldn't identify")
    expect([...dir.dirs.keys()]).toEqual([])
  })

  test('a lock whose owner file can’t be written is rolled back, not leaked', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'x', by: 'you', project: CC })
    const write = io.write
    io.write = async (path, text) => {
      if (path.endsWith('/owner')) {
        io.write = write
        throw new Error('disk full')
      }
      return write(path, text)
    }
    expect(
      await store
        .change(io, made.id, note => note)
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toContain('disk full')
    expect(
      await store
        .change(io, made.id, note => ({ ...note, text: 'y' }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toBe('saved')
  })

  test('a release whose cleanup fails is logged and still frees the lock', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'x', by: 'you', project: CC })
    const rmdir = io.rmdir
    io.rmdir = async () => false
    await store.change(io, made.id, note => ({ ...note, text: 'y' }))
    io.rmdir = rmdir
    expect(dir.warnings.join('\n')).toContain("couldn't remove")
    expect(
      await store
        .change(io, made.id, note => ({ ...note, text: 'z' }))
        .then(
          () => 'saved',
          (e: Error) => e.message,
        ),
    ).toBe('saved')
  })

  test('a file replaced right after our rename is re-read, not cached as ours', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'mine', by: 'you', project: CC })
    const move = io.move
    io.move = async (from, to) => {
      const moved = await move(from, to)
      // Another writer lands between our rename and our stat.
      dir.put(to, serializeNote({ ...made, text: 'theirs', updated: new Date(dir.clock + 5000).toISOString() }))
      return moved
    }
    await store.change(io, made.id, note => ({ ...note, text: 'mine, edited' }))
    io.move = move
    await store.scan(io)
    expect(io.view[made.id]?.text).toBe('theirs')
  })
})

describe('one session', () => {
  test('a poll in flight can’t roll back a write that lands during it', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const first = await store.create(io, { text: 'existing', by: 'you', project: CC })
    const held = gate()
    const list = io.list
    io.list = async path => {
      const listed = await list(path)
      await held.opened
      return listed
    }
    const polling = store.scan(io)
    await settle()
    dir.tick()
    const creating = store.create(io, { text: 'just made', by: 'you', project: CC })
    const changing = store.change(io, first.id, note => ({ ...note, text: 'changed' }))
    await settle()
    held.open()
    io.list = list
    const [, made] = await Promise.all([polling, creating, changing])
    expect(io.view[made.id]?.text).toBe('just made')
    expect(io.view[first.id]?.text).toBe('changed')
  })

  test('a same-size rewrite within one mtime tick is still seen', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'original', by: 'you', project: CC })
    await store.scan(io)
    const file = dir.files.get(`${DIR}/${made.id}.md`)
    if (!file) throw new Error('no file')
    dir.files.set(`${DIR}/${made.id}.md`, { text: file.text.replace('original', 'replaced'), mtimeMs: file.mtimeMs })
    await store.scan(io)
    expect(io.view[made.id]?.text).toBe('replaced')
  })

  test('problems come back after a reset even when no note parses', async () => {
    const dir = new MemDir()
    dir.put(`${DIR}/only.md`, 'not a note')
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    expect(io.problems).toHaveLength(1)
    io.problems = []
    await store.scan(io)
    expect(io.problems).toHaveLength(1)
  })
})

describe('copies of one note', () => {
  test('a change applies to the winning copy, not the first file found', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'original', by: 'you', project: CC })
    const newer = { ...made, text: 'newer copy', updated: new Date(dir.clock + 1).toISOString() }
    dir.put(`${DIR}/${made.id} (conflicted copy).md`, serializeNote(newer))
    await store.scan(io)
    expect(io.view[made.id]?.text).toBe('newer copy')
    dir.tick()
    const archived = await store.change(io, made.id, note => ({ ...note, status: 'archived' }))
    expect(archived.text).toBe('newer copy')
    expect(io.view[made.id]?.status).toBe('archived')
    expect(io.view[made.id]?.text).toBe('newer copy')
  })

  test('a copy under any name that arrives just before the lock is merged in', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'original', by: 'you', project: CC })
    const mkdir = io.mkdir
    io.mkdir = async path => {
      io.mkdir = mkdir
      dir.put(`${DIR}/renamed.md`, serializeNote({ ...made, text: 'newer, renamed', updated: new Date(dir.clock + 5).toISOString() }))
      return mkdir(path)
    }
    dir.tick()
    const archived = await store.change(io, made.id, note => ({ ...note, status: 'archived' }))
    expect(archived.text).toBe('newer, renamed')
    expect(io.view[made.id]?.status).toBe('archived')
  })

  test('a stale copy with a late mtime never outranks a newer revision', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'stale', by: 'you', project: CC })
    dir.tick()
    await store.change(io, made.id, note => ({ ...note, text: 'newest edit' }))
    dir.put(`${DIR}/${made.id}.sync-conflict.md`, serializeNote(made), dir.clock + 60_000)
    await store.scan(io)
    expect(io.view[made.id]?.text).toBe('newest edit')
  })

  test('an edit in place (Obsidian) is promoted to its mtime and written back', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'mine', by: 'you', project: CC })
    const later = dir.clock + 60_000
    dir.put(`${DIR}/${made.id}.md`, serializeNote({ ...made, text: 'edited in obsidian' }), later)
    await store.scan(io)
    expect(io.view[made.id]?.text).toBe('edited in obsidian')
    expect(io.view[made.id]?.updated).toBe(new Date(later).toISOString())
    expect(onDisk(dir, made.id).updated).toBe(new Date(later).toISOString())

    // A second edit in place before the next poll still survives a change from this session.
    const promoted = onDisk(dir, made.id)
    dir.put(`${DIR}/${made.id}.md`, serializeNote({ ...promoted, text: 'edited again' }), later + 60_000)
    dir.clock = later + 61_000
    const archived = await store.change(io, made.id, note => ({ ...note, status: 'archived' }))
    expect(archived.text).toBe('edited again')
  })

  test('a promotion never overwrites a save that lands before its lock', async () => {
    const dir = new MemDir()
    const [a, b] = [memIO(dir, { host: 'office' }), memIO(dir, { host: 'office' })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'mine', by: 'you', project: CC })
    await two.loadAll(b)
    dir.put(`${DIR}/${made.id}.md`, serializeNote({ ...made, text: 'external' }), dir.clock + 60_000)
    dir.clock += 61_000
    // Session B saves between session A's read of the edit and A taking the lock to write it back.
    const mkdir = a.mkdir
    let isFirst = true
    a.mkdir = async path => {
      if (isFirst) {
        isFirst = false
        await two.change(b, made.id, note => ({ ...note, text: 'saved by B', status: 'archived' }))
      }
      return mkdir(path)
    }
    await one.scan(a)
    a.mkdir = mkdir
    expect(onDisk(dir, made.id).text).toBe('saved by B')
    await one.scan(a)
    expect(a.view[made.id]?.text).toBe('saved by B')
    expect(a.view[made.id]?.status).toBe('archived')
  })

  test('a promotion that can’t be written back is kept and retried', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'mine', by: 'you', project: CC })
    const later = dir.clock + 60_000
    dir.put(`${DIR}/${made.id}.md`, serializeNote({ ...made, text: 'external' }), later)
    const mkdir = io.mkdir
    io.mkdir = async () => false
    dir.dirs.set(`${LOCKS}/${made.id}`, dir.clock)
    dir.put(`${LOCKS}/${made.id}/owner`, 'tok 4242 boot')
    await store.scan(io)
    expect(io.view[made.id]?.updated).toBe(new Date(later).toISOString())
    expect(onDisk(dir, made.id).updated).toBe(made.updated)
    io.mkdir = mkdir
    dir.dirs.clear()
    dir.files.delete(`${LOCKS}/${made.id}/owner`)
    await store.scan(io)
    expect(io.view[made.id]?.updated).toBe(new Date(later).toISOString())
    expect(onDisk(dir, made.id).updated).toBe(new Date(later).toISOString())
  })

  test('copies that differ in any field merge to one winner in every order', () => {
    const base: Note = {
      id: '01JA7K2M3Q9X4ZB6C8D0EFGHJK',
      status: 'open',
      by: 'you',
      created: '2026-10-09T14:02:11.000Z',
      updated: '2026-10-09T14:02:11.000Z',
      origin: 'office',
      project: CC,
      context: {},
      sentAt: null,
      deleted: false,
      text: 'same',
      extra: [],
    }
    const copies: Note[] = [
      base,
      { ...base, extra: ['tags: [x]'] },
      { ...base, project: { ...CC, key: 'github.com/example/other' } },
      { ...base, by: 'phone' },
      { ...base, deleted: true, status: 'open' },
      { ...base, deleted: true, status: 'archived' },
    ]
    const winners = new Set<string>()
    for (let shift = 0; shift < copies.length; shift++) {
      const order = [...copies.slice(shift), ...copies.slice(0, shift)]
      winners.add(serializeNote(mergeAll(order).get(base.id) as Note))
      winners.add(serializeNote(mergeAll([...order].reverse()).get(base.id) as Note))
    }
    expect(winners.size).toBe(1)
    expect([...winners][0]).toContain('status: archived')
  })
})

describe('front matter written by other tools', () => {
  const good = serializeNote({
    id: '01JA7K2M3Q9X4ZB6C8D0EFGHJK',
    status: 'open',
    by: 'you',
    created: '2026-10-09T14:02:11.000Z',
    updated: '2026-10-09T14:02:11.000Z',
    origin: 'office',
    project: CC,
    context: { branch: 'main' },
    sentAt: null,
    deleted: false,
    text: 'body',
    extra: [],
  })
  const withExtra = (lines: string) => good.replace('deleted: false\n', `deleted: false\n${lines}\n`)
  // The nested form written before P6.
  const nested = good.replace(
    'project: cc\nprojectKey: github.com/example/cc\nprojectPath: /home/user/work/cc\nbranch: main\n',
    'project:\n  key: github.com/example/cc\n  name: cc\n  path: /home/user/work/cc\ncontext:\n  branch: main\n',
  )

  test('the project and context are flat keys; the nested form before them reads the same', () => {
    expect(good).toContain('project: cc\nprojectKey: github.com/example/cc\nprojectPath: /home/user/work/cc\nbranch: main\n')
    expect(nested).not.toBe(good)
    expect(parseNote(nested)).toEqual(parseNote(good))
    expect(serializeNote(parseNote(nested))).toBe(good)
    // The name cleared in Obsidian: the key still says which project.
    expect(parseNote(good.replace('project: cc\n', 'project:\n')).project).toEqual({ key: 'github.com/example/cc', name: 'cc', path: '/home/user/work/cc' })
    // A property of the person's own that shares a context key's name, as a list, stays theirs.
    const theirs = parseNote(good.replace('branch: main\n', 'branch:\n  - one\n  - two\n'))
    expect(theirs.context.branch).toBeUndefined()
    expect(serializeNote(theirs)).toContain('branch:\n  - one\n  - two')
    expect(() => parseNote(nested.replace('deleted: false\n', 'deleted: false\nbranch: other\n'))).toThrow('both flat and under context')
  })

  test('accepts and keeps what Obsidian and YAML tools write', () => {
    const accepted = [
      withExtra('date created: 2026-10-09'),
      withExtra('überschrift: x'),
      withExtra('tags:\n- ostrakon\n- cc'),
      withExtra('notes: |\n  line one\n\n  line three'),
      nested.replace('  key: github.com/example/cc', '  # a comment\n  key: github.com/example/cc'),
      good.replace('origin: office', 'origin: "office" # host'),
      nested.replace('  path: /home/user/work/cc', '  path: /home/user/work/cc\n  host: gh'),
    ]
    for (const source of accepted) {
      const note = parseNote(source)
      expect(note.text).toBe('body')
      expect(parseNote(serializeNote(note))).toEqual(note)
    }
    expect(parseNote(accepted[2] ?? '').extra).toEqual(['tags:\n- ostrakon\n- cc'])
    expect(serializeNote(parseNote(accepted[6] ?? ''))).toContain('  host: gh')
    expect(parseNote(nested.replace(/project:\n( {2}.*\n)+/, 'project:\n')).project).toBeNull()
    expect(parseNote(nested.replace(/project:\n( {2}.*\n)+/, 'project: null\n  # no project yet\n')).project).toBeNull()
  })

  test('rejects timestamps without a zone and unsupported values', () => {
    const rejected = [
      good.replace('updated: 2026-10-09T14:02:11.000Z', 'updated: 2026-10-09T14:02:11'),
      good.replace('updated: 2026-10-09T14:02:11.000Z', 'updated: 1'),
      good.replace('origin: office', 'origin: [office'),
      good.replace('origin: office', 'origin: &anchor office'),
      good.replace('origin: office', 'origin: office: laptop'),
      good.replace('id: 01JA7K2M3Q9X4ZB6C8D0EFGHJK', 'id: ../../etc/x'),
    ]
    for (const source of rejected) expect(() => parseNote(source)).toThrow()
  })

  test('values other YAML readers would retype stay strings, and CRLF in the body is kept', () => {
    for (const origin of ['0x1F', '+1', '.5', '1_000', '2026-10-09', 'yes', '12:30']) {
      const note = parseNote(good.replace('origin: office', `origin: ${JSON.stringify(origin)}`))
      expect(serializeNote(note)).toContain(`origin: "${origin}"`)
    }
    const crlf = parseNote(good.replace('body', 'a\r\nb'))
    expect(parseNote(serializeNote(crlf)).text).toBe('a\r\nb')
  })
})
