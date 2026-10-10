import { describe, expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { parseNote, serializeNote } from '../src/frontmatter'
import { winner } from '../src/merge'
import { createStore } from '../src/store'
import type { Store } from '../src/store'
import { PUSH_BATCH, SyncRefused, createSync, fingerprint } from '../src/sync/core'
import type { SyncAdapter, SyncIO, SyncStatus } from '../src/sync/core'
import { MemDir, memIO } from './memdir'
import type { MemIO } from './memdir'

const DIR = '/data/ostrakon/notes'
const CC = { key: 'github.com/example/cc', name: 'cc', path: '/home/user/work/cc' }

// The hub's rules in memory (server/hub.ts keeps them in SQLite): merge per note, a new seq only
// when the stored copy changes.
class FakeHub {
  notes = new Map<string, { note: Note; seq: number }>()
  seq = 0
  down = false
  token = 'right'
  pushes = 0
  waits: number[] = []
  id = 'run-1'
  hold: Promise<void> | undefined
  refuse = '' // set: every push is refused with this reason (the pulls still work)

  // A restart (the id changes) that may also lose everything (a wiped or restored database).
  restart(isWiped: boolean) {
    this.id = `run-${Math.random()}`
    if (isWiped) this.notes.clear()
  }

  adapter(token = 'right'): SyncAdapter {
    const check = () => {
      if (this.down) throw new Error('connect ECONNREFUSED')
      if (token !== this.token) throw new SyncRefused('hub refused the token')
    }
    return {
      name: 'hub',
      pull: async (cursor, waitS) => {
        this.waits.push(waitS)
        check()
        const after = Number(cursor ?? 0)
        const rows = [...this.notes.values()].filter(row => row.seq > after).sort((a, b) => a.seq - b.seq)
        return { notes: rows.map(row => row.note), cursor: String(this.seq), hub: this.id }
      },
      push: async notes => {
        check()
        this.pushes += 1
        if (this.refuse !== '') throw new SyncRefused(this.refuse)
        if (notes.length > 500) throw new SyncRefused('hub refused: at most 500')
        const id = this.id
        const answer = { notes: notes.map(note => this.put(note)), hub: id }
        // A slow answer: the test lets it go, by which time the hub may have restarted.
        if (this.hold) await this.hold
        return answer
      },
    }
  }

  put(note: Note) {
    const stored = this.notes.get(note.id)?.note
    const best = stored ? winner(stored, note) : note
    if (!stored || serializeNote(best) !== serializeNote(stored)) this.notes.set(best.id, { note: best, seq: ++this.seq })
    return best
  }
}

type Machine = { dir: MemDir; io: MemIO; store: Store; statuses: SyncStatus[]; cache: { text?: string }; sync: SyncIO }

const machine = (host: string, dir = new MemDir(), cache: { text?: string } = {}): Machine => {
  const io = memIO(dir, { host })
  const store = createStore()
  const statuses: SyncStatus[] = []
  const sync: SyncIO = {
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
  return { dir, io, store, statuses, cache, sync }
}

// Lets a loop's unawaited round run to its end.
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const last = (m: Machine) => m.statuses[m.statuses.length - 1]

describe('sync', () => {
  test('a note made on one machine reaches another through the hub, as the same revision', async () => {
    const hub = new FakeHub()
    const [office, mac] = [machine('office'), machine('mac')]
    await office.store.loadAll(office.io)
    await mac.store.loadAll(mac.io)
    const made = await office.store.create(office.io, { text: 'check the flaky test', by: 'you', project: CC })
    const [one, two] = [createSync(hub.adapter()), createSync(hub.adapter())]
    await one.pull(office.sync)
    expect(hub.notes.get(made.id)?.note).toEqual(made)

    await two.pull(mac.sync)
    const copy = parseNote(mac.dir.get(`${DIR}/${made.id}.md`) ?? '')
    expect(copy).toEqual(made)
    expect(copy.origin).toBe('office')
    expect(mac.io.view[made.id]?.text).toBe('check the flaky test')
  })

  test('the later revision wins on both sides; the older side never sends its copy back over it', async () => {
    const hub = new FakeHub()
    const [office, mac] = [machine('office'), machine('mac')]
    await office.store.loadAll(office.io)
    await mac.store.loadAll(mac.io)
    const made = await office.store.create(office.io, { text: 'draft', by: 'you', project: CC })
    const [one, two] = [createSync(hub.adapter()), createSync(hub.adapter())]
    await one.pull(office.sync)
    await two.pull(mac.sync)

    mac.dir.tick()
    await mac.store.change(mac.io, made.id, note => ({ ...note, text: 'edited on the mac' }))
    await two.push(mac.sync)
    await one.pull(office.sync)
    expect(office.io.view[made.id]?.text).toBe('edited on the mac')
    // The office now holds what the hub has: nothing queued, nothing sent back.
    const pushes = hub.pushes
    await one.push(office.sync)
    expect(hub.pushes).toBe(pushes)
    expect(last(office)?.queued).toBe(0)
  })

  test('a local change newer than the hub copy survives a pull and is pushed', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const made = await office.store.create(office.io, { text: 'v1', by: 'you', project: CC })
    const sync = createSync(hub.adapter())
    await sync.pull(office.sync)
    office.dir.tick()
    const archived = await office.store.change(office.io, made.id, note => ({ ...note, status: 'archived' }))
    await sync.pull(office.sync)
    expect(office.io.view[made.id]?.status).toBe('archived')
    await sync.push(office.sync)
    expect(hub.notes.get(made.id)?.note).toEqual(archived)
  })

  test('offline: changes queue with a count, and go out when the hub is back', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const sync = createSync(hub.adapter())
    await sync.pull(office.sync)
    hub.down = true
    await office.store.create(office.io, { text: 'one', by: 'you', project: CC })
    await office.store.create(office.io, { text: 'two', by: 'you', project: null })
    await sync.push(office.sync)
    expect(last(office)).toEqual({ isOnline: false, queued: 2, problem: 'offline' })
    await expect(sync.pull(office.sync)).rejects.toThrow()

    hub.down = false
    hub.waits = []
    await sync.pull(office.sync)
    // Back from offline, the first look doesn't wait for news: the queue goes out at once.
    expect(hub.waits).toEqual([0])
    expect(hub.notes.size).toBe(2)
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test('a refused token says so, and nothing is lost', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    await office.store.create(office.io, { text: 'kept', by: 'you', project: CC })
    const sync = createSync(hub.adapter('wrong'))
    await expect(sync.pull(office.sync)).rejects.toThrow('hub refused the token')
    let rounds = 0
    const timers: (() => void)[] = []
    sync.run(office.sync, (_, fn) => timers.push(fn), () => rounds++ < 1)
    await settle()
    expect(last(office)?.problem).toBe('hub refused the token')
    expect(last(office)?.queued).toBe(1)
    expect(Object.values(office.io.view).map(note => note.text)).toEqual(['kept'])
  })

  test("a note whose local file can't be read is never replaced by the hub's copy", async () => {
    const hub = new FakeHub()
    const [office, mac] = [machine('office'), machine('mac')]
    await office.store.loadAll(office.io)
    const made = await office.store.create(office.io, { text: 'from the office', by: 'you', project: CC })
    await createSync(hub.adapter()).pull(office.sync)
    mac.dir.put(`${DIR}/${made.id}.md`, '---\nid: broken\n')
    await mac.store.loadAll(mac.io)
    await createSync(hub.adapter()).pull(mac.sync)
    expect(mac.dir.get(`${DIR}/${made.id}.md`)).toBe('---\nid: broken\n')
    expect(mac.dir.warnings.some(text => text.includes("can't be read"))).toBe(true)
  })

  test('what the hub holds is remembered between sessions: offline at start, only real changes count as queued', async () => {
    const hub = new FakeHub()
    const dir = new MemDir()
    const cache: { text?: string } = {}
    const first = machine('office', dir, cache)
    await first.store.loadAll(first.io)
    await first.store.create(first.io, { text: 'synced', by: 'you', project: CC })
    await first.store.create(first.io, { text: 'synced too', by: 'you', project: CC })
    await createSync(hub.adapter()).pull(first.sync)

    const second = machine('office', dir, cache)
    await second.store.loadAll(second.io)
    await second.store.create(second.io, { text: 'new while offline', by: 'you', project: null })
    hub.down = true
    const sync = createSync(hub.adapter())
    sync.run(second.sync, () => {}, () => true)
    await settle()
    expect(last(second)).toEqual({ isOnline: false, queued: 1, problem: 'offline' })
  })

  test('a phone note (by phone, origin iphone) lands as a file like any other', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const stamp = '2026-10-10T08:00:00.000Z'
    const phone: Note = {
      id: '01JA7K2M3Q9X4ZB6C8D0EFGH0P',
      status: 'open',
      by: 'phone',
      created: stamp,
      updated: stamp,
      origin: 'iphone',
      project: null,
      context: {},
      sentAt: null,
      deleted: false,
      text: 'buy the long USB-C cable',
      extra: [],
    }
    hub.put(phone)
    await createSync(hub.adapter()).pull(office.sync)
    expect(office.io.view[phone.id]).toEqual(phone)
    expect(fingerprint(office.io.view[phone.id] as Note)).toBe(fingerprint(phone))
  })

  test('a hub that restarted with an empty database gets back every note this machine had sent it', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const made = await office.store.create(office.io, { text: 'sent once', by: 'you', project: CC })
    const sync = createSync(hub.adapter())
    await sync.pull(office.sync)
    expect(hub.notes.has(made.id)).toBe(true)

    hub.restart(true)
    await sync.pull(office.sync)
    expect(hub.notes.get(made.id)?.note).toEqual(made)
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test('a new session against a wiped hub sends everything again, whatever the cache said', async () => {
    const hub = new FakeHub()
    const dir = new MemDir()
    const cache: { text?: string } = {}
    const first = machine('office', dir, cache)
    await first.store.loadAll(first.io)
    await first.store.create(first.io, { text: 'one', by: 'you', project: CC })
    await createSync(hub.adapter()).pull(first.sync)
    hub.restart(true)
    const second = machine('office', dir, cache)
    await second.store.loadAll(second.io)
    await createSync(hub.adapter()).pull(second.sync)
    expect(hub.notes.size).toBe(1)
  })

  test('more notes than one request takes go out in batches', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    for (let i = 0; i < 450; i++) await office.store.create(office.io, { text: `n${i}`, by: 'you', project: null })
    await createSync(hub.adapter()).pull(office.sync)
    expect(hub.notes.size).toBe(450)
    expect(hub.pushes).toBe(Math.ceil(450 / PUSH_BATCH))
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test('pushes the hub keeps refusing back off on their own; pulls keep long-polling', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    await office.store.create(office.io, { text: 'refused', by: 'you', project: null })
    hub.refuse = 'hub refused: too large'
    const timers: { ms: number; fn: () => void }[] = []
    const sync = createSync(hub.adapter())
    let rounds = 0
    sync.run(office.sync, (ms, fn) => timers.push({ ms, fn }), () => rounds++ < 6)
    for (let i = 0; i < 6; i++) {
      await settle()
      const next = timers.shift()
      next?.fn()
    }
    await settle()
    // The first pull is full (no wait); every later one long-polls, refused pushes or not.
    expect(hub.waits.slice(1).every(wait => wait === 25)).toBe(true)
    expect(hub.pushes).toBeLessThanOrEqual(4)
    expect(last(office)).toEqual({ isOnline: false, queued: 1, problem: 'hub refused: too large' })
  })

  test("a pulled note that couldn't be written here is tried again on the next pull", async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const stamp = '2026-10-10T08:00:00.000Z'
    const phone: Note = { id: '01JA7K2M3Q9X4ZB6C8D0EFGH0Q', status: 'open', by: 'phone', created: stamp, updated: stamp, origin: 'iphone', project: null, context: {}, sentAt: null, deleted: false, text: 'retry me', extra: [] }
    hub.put(phone)
    const sync = createSync(hub.adapter())
    office.dir.failWrites = true
    await sync.pull(office.sync)
    expect(office.io.view[phone.id]).toBeUndefined()
    office.dir.failWrites = false
    await sync.pull(office.sync)
    expect(office.io.view[phone.id]).toEqual(phone)
  })

  test("a push answered by the hub's previous run never counts as held by the new one", async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const sync = createSync(hub.adapter())
    await sync.pull(office.sync)
    const made = await office.store.create(office.io, { text: 'in flight', by: 'you', project: null })
    let release = () => {}
    hub.hold = new Promise<void>(resolve => (release = resolve))
    const before = hub.pushes
    const pushing = sync.push(office.sync)
    for (let i = 0; i < 20 && hub.pushes === before; i++) await settle()
    expect(hub.notes.has(made.id)).toBe(true)
    // The hub restarts on an empty database while the answer is on its way, and the session has
    // already pulled from the new run when the old answer finally lands.
    hub.restart(true)
    hub.hold = undefined
    await sync.pull(office.sync)
    release()
    await pushing
    await sync.pull(office.sync)
    expect(hub.notes.get(made.id)?.note).toEqual(made)
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test('a waiting unwritten revision is only replaced by one that beats it', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const base = { id: '01JA7K2M3Q9X4ZB6C8D0EFGH0R', status: 'open', by: 'phone', created: '2026-10-10T08:00:00.000Z', origin: 'iphone', project: null, context: {}, sentAt: null, deleted: false, extra: [] } as const
    const newer: Note = { ...base, extra: [], updated: '2026-10-10T09:00:00.000Z', text: 'newer' }
    const older: Note = { ...base, extra: [], updated: '2026-10-10T08:00:00.000Z', text: 'older' }
    let failing = true
    const absorbed: string[] = []
    const io: SyncIO = {
      ...office.sync,
      absorb: async notes => {
        absorbed.push(...notes.map(note => note.text))
        return failing ? { failed: notes.map(note => note.id) } : office.store.absorb(office.io, notes)
      },
    }
    hub.put(newer)
    const sync = createSync(hub.adapter())
    await sync.pull(io)
    // An old copy turns up afterwards (a late answer): the newer one stays queued for writing.
    hub.notes.set(base.id, { note: older, seq: ++hub.seq })
    failing = false
    await sync.pull(io)
    expect(office.io.view[base.id]?.text).toBe('newer')
  })

  test('an old push error clears once nothing is left to send', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const sync = createSync(hub.adapter())
    await sync.pull(office.sync)
    const made = await office.store.create(office.io, { text: 'x', by: 'you', project: null })
    hub.refuse = 'refused'
    await sync.push(office.sync)
    expect(last(office)?.problem).toBe('refused')
    // The same revision reaches the hub another way (another session's push).
    hub.put(made)
    await sync.pull(office.sync)
    expect(last(office)).toEqual({ isOnline: true, queued: 0, problem: '' })
  })

  test("a full pull's snapshot replaces the cache instead of merging old entries back", async () => {
    const hub = new FakeHub()
    const cache: { text?: string } = { text: JSON.stringify({ hub: 'run-1', known: { '01JA7K2M3Q9X4ZB6C8D0EFGH0S': 'stale' } }) }
    const office = machine('office', new MemDir(), cache)
    await office.store.loadAll(office.io)
    await createSync(hub.adapter()).pull(office.sync)
    expect(JSON.parse(cache.text ?? '{}').known).toEqual({})
  })

  test("a push taking notes in at the same time as a pull doesn't drop the pull's unwritten note", async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    let calls = 0
    let blockAt = -1
    let release = () => {}
    const gate = new Promise<void>(resolve => (release = resolve))
    let failing = false
    const io: SyncIO = {
      ...office.sync,
      local: async () => {
        if (++calls === blockAt) await gate
        return office.io.view
      },
      absorb: async notes => (failing ? { failed: notes.map(note => note.id) } : office.store.absorb(office.io, notes)),
    }
    const sync = createSync(hub.adapter())
    await sync.pull(io)
    await office.store.create(office.io, { text: 'mine', by: 'you', project: null })
    // The push reads the local view once for its queue, then pauses inside taking the answer in.
    blockAt = calls + 2
    const pushing = sync.push(io)
    for (let i = 0; i < 20 && calls < blockAt; i++) await settle()
    const stamp = '2026-10-10T08:00:00.000Z'
    const phone: Note = { id: '01JA7K2M3Q9X4ZB6C8D0EFGH0T', status: 'open', by: 'phone', created: stamp, updated: stamp, origin: 'iphone', project: null, context: {}, sentAt: null, deleted: false, text: 'from the phone', extra: [] }
    hub.put(phone)
    failing = true
    await sync.pull(io)
    release()
    await pushing
    failing = false
    await sync.pull(io)
    expect(office.io.view[phone.id]?.text).toBe('from the phone')
  })

  test('a retry armed before the queue emptied is called off, and a later failure arms a fresh one', async () => {
    const hub = new FakeHub()
    const office = machine('office')
    await office.store.loadAll(office.io)
    const timers: { ms: number; fn: () => void }[] = []
    const sync = createSync(hub.adapter())
    sync.run(office.sync, (ms, fn) => timers.push({ ms, fn }), () => false)
    await settle()
    await sync.pull(office.sync)
    const made = await office.store.create(office.io, { text: 'x', by: 'you', project: null })
    hub.refuse = 'refused'
    await sync.push(office.sync)
    expect(timers).toHaveLength(1)
    hub.put(made)
    await sync.pull(office.sync)
    // The old retry does nothing now.
    const pushes = hub.pushes
    timers.shift()?.fn()
    await settle()
    expect(hub.pushes).toBe(pushes)
    await office.store.create(office.io, { text: 'y', by: 'you', project: null })
    await sync.push(office.sync)
    expect(timers).toHaveLength(1)
  })
})
