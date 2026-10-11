import { describe, expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { parseNote, serializeNote } from '../src/frontmatter'
import { StorageError, createStore } from '../src/store'
import { MemDir, memIO } from './memdir'

const DIR = '/data/ostrakon/notes'
const CC = { key: 'github.com/example/cc', name: 'cc', path: '/home/user/work/cc' }

const texts = (view: Record<string, Note>) =>
  Object.values(view)
    .map(note => note.text)
    .sort()

describe('store', () => {
  test('creates notes as files and reads them back in a new session', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'check the flaky test', by: 'you', project: CC })
    expect(dir.names(DIR)).toEqual([`${made.id}.md`])
    expect(parseNote(dir.get(`${DIR}/${made.id}.md`) ?? '')).toEqual(made)
    expect(made.origin).toBe('office')

    const later = memIO(dir)
    await createStore().loadAll(later)
    expect(later.view[made.id]?.text).toBe('check the flaky test')
  })

  test('two sessions writing at once never lose a note', async () => {
    const dir = new MemDir()
    const [a, b] = [memIO(dir, { host: 'office' }), memIO(dir, { host: 'office' })]
    const [one, two] = [createStore(), createStore()]
    await Promise.all([one.loadAll(a), two.loadAll(b)])
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.all([one.create(a, { text: `a${i}`, by: 'you', project: CC }), two.create(b, { text: `b${i}`, by: 'you', project: null })]),
      ),
    )
    await Promise.all([one.scan(a), two.scan(b)])
    expect(Object.keys(a.view)).toHaveLength(20)
    expect(texts(a.view)).toEqual(texts(b.view))
  })

  test('a change applies on top of the newest copy, not a stale one', async () => {
    const dir = new MemDir()
    const [a, b] = [memIO(dir, { host: 'office' }), memIO(dir, { host: 'mac' })]
    const [one, two] = [createStore(), createStore()]
    await one.loadAll(a)
    const made = await one.create(a, { text: 'draft', by: 'you', project: CC })
    await two.loadAll(b)

    dir.tick()
    await two.change(b, made.id, note => ({ ...note, text: 'edited on the mac' }))
    // Session one hasn't polled yet, so its view is stale; archiving must keep the mac's edit.
    dir.tick()
    const archived = await one.change(a, made.id, note => ({ ...note, status: 'archived' }))
    expect(archived.text).toBe('edited on the mac')
    expect(archived.status).toBe('archived')
    expect(archived.origin).toBe('office')
    expect(Date.parse(archived.updated)).toBeGreaterThan(Date.parse(made.updated))
  })

  test('an unreadable file is reported, skipped and never written over', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    const good = await (async () => {
      await store.loadAll(io)
      return store.create(io, { text: 'fine', by: 'you', project: CC })
    })()
    const garbage = '---\nid: 01JA7K2M3Q9X4ZB6C8D0EFGHJK\nstatus: ???\n'
    dir.put(`${DIR}/01JA7K2M3Q9X4ZB6C8D0EFGHJK.md`, garbage)

    const fresh = memIO(dir)
    const again = createStore()
    await again.loadAll(fresh)
    expect(texts(fresh.view)).toEqual(['fine'])
    expect(fresh.problems).toHaveLength(1)
    expect(fresh.problems[0]?.file).toBe('01JA7K2M3Q9X4ZB6C8D0EFGHJK.md')

    let error: unknown
    await again.change(fresh, '01JA7K2M3Q9X4ZB6C8D0EFGHJK', note => ({ ...note, text: 'x' })).catch(e => (error = e))
    expect(error).toBeInstanceOf(StorageError)
    expect(dir.get(`${DIR}/01JA7K2M3Q9X4ZB6C8D0EFGHJK.md`)).toBe(garbage)
    // Other notes still change normally.
    await again.change(fresh, good.id, note => ({ ...note, text: 'still fine' }))
    expect(fresh.view[good.id]?.text).toBe('still fine')

    // Fixed outside (an editor), it comes back on the next poll and the problem clears.
    dir.put(`${DIR}/01JA7K2M3Q9X4ZB6C8D0EFGHJK.md`, serializeNote({ ...good, id: '01JA7K2M3Q9X4ZB6C8D0EFGHJK', text: 'repaired' }))
    await again.scan(fresh)
    expect(texts(fresh.view)).toEqual(['repaired', 'still fine'])
    expect(fresh.problems).toHaveLength(0)
  })

  test('a half-written file is retried once before it counts as broken', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'whole', by: 'you', project: CC })
    const full = dir.get(`${DIR}/${made.id}.md`) ?? ''
    let reads = 0
    const flaky = memIO(dir)
    flaky.read = async () => (reads++ === 0 ? full.slice(0, 40) : full)
    const other = createStore()
    await other.loadAll(flaky)
    expect(texts(flaky.view)).toEqual(['whole'])
    expect(flaky.problems).toHaveLength(0)
  })

  test('the poll picks up new, changed and removed files, and ignores .tmp', async () => {
    const dir = new MemDir()
    const [a, b] = [memIO(dir), memIO(dir)]
    const [one, two] = [createStore(), createStore()]
    await Promise.all([one.loadAll(a), two.loadAll(b)])
    const made = await one.create(a, { text: 'first', by: 'you', project: CC })
    expect(await two.scan(b)).toBe(true)
    expect(texts(b.view)).toEqual(['first'])
    expect(await two.scan(b)).toBe(false)

    dir.put(`${DIR}/${made.id}.md.tmp`, 'half')
    expect(await two.scan(b)).toBe(false)

    dir.tick()
    await one.change(a, made.id, note => ({ ...note, text: 'second' }))
    await two.scan(b)
    expect(texts(b.view)).toEqual(['second'])

    dir.files.delete(`${DIR}/${made.id}.md`)
    await two.scan(b)
    expect(texts(b.view)).toEqual([])
  })

  test('an edit made outside the store (Obsidian) wins by its mtime', async () => {
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
  })

  test("the stamp an edit in place earns goes back as a one-line change: the editor's bytes are kept", async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'mine', by: 'you', project: CC })
    // Obsidian saves without a final newline.
    const edited = serializeNote({ ...made, text: 'edited in obsidian' }).replace(/\n$/, '')
    dir.put(`${DIR}/${made.id}.md`, edited, dir.clock + 60_000)
    await store.scan(io)
    const stamp = io.view[made.id]?.updated ?? ''
    expect(stamp > made.updated).toBe(true)
    expect(dir.get(`${DIR}/${made.id}.md`)).toBe(edited.replace(`updated: ${made.updated}`, `updated: ${stamp}`))
  })

  test('two files with one id (a sync conflict copy) merge to the winner', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    const made = await store.create(io, { text: 'original', by: 'you', project: CC })
    const newer = { ...made, text: 'newer copy', updated: new Date(dir.clock + 1).toISOString() }
    dir.put(`${DIR}/${made.id} (conflicted copy).md`, serializeNote(newer), dir.clock)
    await store.scan(io)
    expect(Object.keys(io.view)).toEqual([made.id])
    expect(io.view[made.id]?.text).toBe('newer copy')
  })

  test('a reset view ($.state after /clear) is put back without any file changing', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    const store = createStore()
    await store.loadAll(io)
    await store.create(io, { text: 'survives clear', by: 'you', project: CC })
    io.view = {}
    expect(await store.scan(io)).toBe(true)
    expect(texts(io.view)).toEqual(['survives clear'])
  })

  test('a failed rename writes nothing into the view', async () => {
    const dir = new MemDir()
    const io = memIO(dir)
    io.move = async () => ({ exitCode: 1, stderr: 'mv: disk full' })
    const store = createStore()
    await store.loadAll(io)
    let error: unknown
    await store.create(io, { text: 'lost?', by: 'you', project: CC }).catch(e => (error = e))
    expect(error).toBeInstanceOf(StorageError)
    expect(io.view).toEqual({})
    expect(io.publishes).toBe(1) // the initial load only
  })

  test('where notes live: OSTRAKON_DIR, then notesDir, then the default', async () => {
    const dir = new MemDir()
    expect(createStore('/x').root(memIO(dir, { root: '/env' }))).toBe('/env')
    expect(createStore('~/notes').root({ ...memIO(dir), env: { home: '/home/me' } })).toBe('/home/me/notes')
    expect(createStore().root({ ...memIO(dir), env: { home: '/home/me' } })).toBe('/home/me/.local/share/ostrakon')
  })
})
