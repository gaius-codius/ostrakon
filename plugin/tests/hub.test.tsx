import { expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { MemDir } from './memdir'
import { CC, mountPane, noteIn, put, startSession, texts } from './world'

const HUB = { hubUrl: 'https://hub.test/', hubToken: 'secret' }
const PHONE = '01JA7K2M3Q9X4ZB6C8D0EFGH9P'
const MINE = '01JA7K2M3Q9X4ZB6C8D0EFGH91'

const phoneNote: Note = {
  id: PHONE,
  status: 'open',
  by: 'phone',
  created: '2026-10-09T11:59:00.000Z',
  updated: '2026-10-09T11:59:00.000Z',
  origin: 'iphone',
  project: CC,
  context: {},
  sentAt: null,
  deleted: false,
  text: 'from the phone: check the deploy log',
  extra: [],
}

test('a note made on the phone shows in the open pane and is written as a file', { options: HUB }, async ($, on) => {
  const dir = new MemDir()
  put(dir, MINE, 'a local note', CC, 5)
  const calls: string[] = []
  const pushed: Note[] = []
  // Long polls after the first answer only when the test lets them.
  const waiting: (() => void)[] = []
  on('http.fetch', async ($, e) => {
    calls.push(`${e.init?.method ?? 'GET'} ${e.url} ${e.init?.headers?.authorization ?? ''}`)
    if (e.url.includes('/api/notes')) {
      const notes = (JSON.parse(e.init?.body ?? '{}') as { notes: Note[] }).notes
      pushed.push(...notes)
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ notes, cursor: 2 }) } }
    }
    if (e.url.includes('wait=25')) await new Promise<void>(resolve => waiting.push(resolve))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ notes: [phoneNote], cursor: 1 }) } }
  })
  const { clock } = await startSession($, on, dir)
  await clock.advance(10)
  expect(calls[0]).toBe('GET https://hub.test/api/changes?since=0&wait=0 Bearer secret')
  expect(noteIn(dir, PHONE)).toEqual(phoneNote)
  // The local note the hub didn't have went up on the first round.
  expect(pushed.map(note => note.id)).toEqual([MINE])

  const ui = await mountPane($)
  expect((await texts(ui)).some(text => text.includes('from the phone: check the deploy log'))).toBe(true)
  await ui.unmount()
  for (const release of waiting) release()
})

test('the footer says when the hub is unreachable and how much waits for it', { options: HUB }, async ($, on) => {
  const dir = new MemDir()
  put(dir, MINE, 'a local note', CC, 5)
  on('http.fetch', () => ({ deny: 'connect ECONNREFUSED' }))
  const { clock } = await startSession($, on, dir)
  await clock.advance(10)
  const ui = await mountPane($)
  expect(await texts(ui)).toContain('hub offline · 1 queued')
  await ui.unmount()
})

test('without a hub nothing is fetched and the footer stays quiet', async ($, on) => {
  const dir = new MemDir()
  put(dir, MINE, 'a local note', CC, 5)
  let fetched = 0
  on('http.fetch', () => {
    fetched += 1
    return { deny: 'no' }
  })
  const { clock } = await startSession($, on, dir)
  await clock.advance(3000)
  const ui = await mountPane($)
  expect((await texts(ui)).some(text => text.startsWith('hub'))).toBe(false)
  expect(fetched).toBe(0)
  await ui.unmount()
})
