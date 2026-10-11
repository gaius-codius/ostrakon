import { describe, expect, test } from 'claude-code/testing'

import type { Note } from '../types'
import { parseNote, serializeNote } from '../src/frontmatter'
import { compareNotes, isPurgeable, mergeAll, nextStamp, winner } from '../src/merge'
import { normalizeRemote } from '../src/project'
import { isUlid, ulid, ulidTime } from '../src/ulid'

const note = (over: Partial<Note> = {}): Note => ({
  id: '01JA7K2M3Q9X4ZB6C8D0EFGHJK',
  status: 'open',
  by: 'you',
  created: '2026-10-09T14:02:11.000Z',
  updated: '2026-10-09T14:02:11.000Z',
  origin: 'office',
  project: { key: 'github.com/example/cc', name: 'cc', path: '/home/user/work/cc' },
  context: { sessionId: '0463fee3', branch: 'main' },
  sentAt: null,
  deleted: false,
  text: 'check why the cache test is flaky on CI',
  extra: [],
  ...over,
})

describe('front matter', () => {
  test('round-trips awkward text and values', () => {
    const texts = [
      'plain',
      '',
      'multi\nline\n\nwith gaps',
      '---\nlooks like a fence',
      'ends with newline\n',
      '\nstarts with newline',
      'key: value # not a comment',
      '"quoted" and \\backslash',
    ]
    for (const text of texts) expect(parseNote(serializeNote(note({ text }))).text).toBe(text)

    const awkward = note({
      origin: 'true',
      project: { key: 'path:/home/me/a: b', name: '#hash', path: ' spaced ' },
      context: { harvestOf: 'fix "auth" tests: part 2', turnId: '123' },
      sentAt: '2026-10-09T15:00:00.000Z',
      status: 'sent',
      by: 'claude',
    })
    expect(parseNote(serializeNote(awkward))).toEqual(awkward)
  })

  test('unfiled notes and empty context', () => {
    const unfiled = note({ project: null, context: {} })
    const text = serializeNote(unfiled)
    expect(text).toContain('project: null')
    expect(text).not.toContain('context:')
    expect(parseNote(text)).toEqual(unfiled)
  })

  test('keeps keys it does not own (Obsidian tags) verbatim', () => {
    const source = serializeNote(note()).replace('deleted: false\n', 'deleted: false\ntags:\n  - ostrakon\n  - cc\naliases: [x]\n')
    const parsed = parseNote(source)
    expect(parsed.extra).toEqual(['tags:\n  - ostrakon\n  - cc', 'aliases: [x]'])
    expect(serializeNote(parsed)).toBe(source)
  })

  test('keeps the sentTurnId an older version wrote, flat or under context, through a rewrite', () => {
    const flat = serializeNote(note({ status: 'sent' })).replace('sentAt: null\n', 'sentTurnId: d72cc127\nsentAt: null\n')
    const parsedFlat = parseNote(flat)
    expect(parsedFlat.extra).toEqual(['sentTurnId: d72cc127'])
    expect(serializeNote(parsedFlat)).toContain('sentTurnId: d72cc127\n')
    const nested = serializeNote(note())
      .replace(/\n(sessionId|branch): .*/g, '')
      .replace('sentAt: null', 'context:\n  sessionId: s1\n  sentTurnId: d72cc127\nsentAt: null')
    const parsedNested = parseNote(nested)
    expect(parsedNested.context.sessionId).toBe('s1')
    expect(serializeNote(parsedNested)).toContain('sentTurnId: d72cc127')
  })

  test('reads the fixture style: comments, CRLF, BOM', () => {
    const source =
      '﻿---\r\nid: 01JA7K2M3Q9X4ZB6C8D0EFGHJK      # ULID\r\nstatus: open\r\nby: phone\r\n' +
      'created: 2026-10-09T14:02:11.000Z\r\nupdated: 2026-10-09T14:02:11.000Z\r\norigin: iphone\r\n' +
      'project: null\r\nsentAt: null\r\ndeleted: false\r\n---\r\nbuy milk\r\n'
    const parsed = parseNote(source)
    expect(parsed.id).toBe('01JA7K2M3Q9X4ZB6C8D0EFGHJK')
    expect(parsed.by).toBe('phone')
    expect(parsed.text).toBe('buy milk')
  })

  test('rejects anything it does not understand', () => {
    const good = serializeNote(note())
    const broken = [
      'no front matter at all',
      good.replace(/\n---\n/, '\n'), // never closes
      good.replace('status: open', 'status: done'),
      good.replace('by: you', 'by: someone'),
      good.replace('created: 2026-10-09T14:02:11.000Z', 'created: yesterday'),
      good.replace('id: 01JA7K2M3Q9X4ZB6C8D0EFGHJK', 'id: 01JA7K2M3Q9X4ZB6C8D0EFGHJK\nid: other'),
      good.replace('deleted: false', 'deleted: maybe'),
      good.replace('origin: office', 'origin office'),
      good.slice(0, 60), // cut off mid-write
    ]
    for (const source of broken) expect(() => parseNote(source)).toThrow()
  })
})

describe('merge', () => {
  test('later update wins, either way round', () => {
    const older = note({ text: 'old' })
    const newer = note({ text: 'new', updated: '2026-10-09T14:05:00.000Z' })
    expect(winner(older, newer).text).toBe('new')
    expect(winner(newer, older).text).toBe('new')
  })

  test('ties go to the more final status, then origin, then text', () => {
    const open = note({ status: 'open' })
    const archived = note({ status: 'archived' })
    const sent = note({ status: 'sent' })
    const gone = note({ status: 'open', deleted: true })
    expect(winner(open, archived).status).toBe('archived')
    expect(winner(sent, archived).status).toBe('archived')
    expect(winner(archived, gone).deleted).toBe(true)
    expect(winner(note({ status: 'proposed' }), note({ status: 'dismissed' })).status).toBe('dismissed')
    expect(winner(note({ origin: 'desktop' }), note({ origin: 'office' })).origin).toBe('office')
    expect(winner(note({ text: 'b' }), note({ text: 'a' })).text).toBe('b')
  })

  test('every order of the same copies merges to the same note', () => {
    const copies = [
      note({ text: 'a', origin: 'office' }),
      note({ text: 'b', origin: 'iphone', status: 'archived' }),
      note({ text: 'c', origin: 'mac', updated: '2026-10-09T14:02:11.001Z' }),
      note({ text: 'd', origin: 'office', updated: '2026-10-09T14:02:11.001Z', status: 'sent' }),
    ]
    const orders = [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
      [2, 0, 3, 1],
    ]
    const results = orders.map(order => mergeAll(order.map(i => copies[i] as Note)).get(copies[0]?.id ?? '')?.text)
    expect(new Set(results)).toEqual(new Set(['d']))
    for (const a of copies) for (const b of copies) expect(Math.sign(compareNotes(a, b)) + Math.sign(compareNotes(b, a))).toBe(0)
  })

  test('the clock never steps back, even behind a skewed peer', () => {
    const ahead = '2026-10-09T15:00:00.000Z'
    expect(nextStamp(Date.parse('2026-10-09T14:00:00.000Z'), ahead)).toBe('2026-10-09T15:00:00.001Z')
    expect(nextStamp(Date.parse('2026-10-09T16:00:00.000Z'), ahead)).toBe('2026-10-09T16:00:00.000Z')
    expect(nextStamp(Date.parse('2026-10-09T16:00:00.000Z'))).toBe('2026-10-09T16:00:00.000Z')
  })

  test('tombstones are purgeable after 60 days, live notes never', () => {
    const now = Date.parse('2026-12-31T00:00:00.000Z')
    expect(isPurgeable(note({ deleted: true }), now)).toBe(true)
    expect(isPurgeable(note({ deleted: true, updated: '2026-12-01T00:00:00.000Z' }), now)).toBe(false)
    expect(isPurgeable(note({ status: 'archived' }), now)).toBe(false)
  })
})

describe('ids and projects', () => {
  test('ulids sort by time and stay unique within a millisecond', () => {
    const t = Date.parse('2026-10-09T14:02:11.000Z')
    const ids = [ulid(t), ulid(t), ulid(t), ulid(t + 1), ulid(t + 1000)]
    for (const id of ids) expect(isUlid(id)).toBe(true)
    expect(ulidTime(ids[0] ?? '')).toBe(t)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(ids)
  })

  test('remotes normalize to one key per repo', () => {
    const forms = [
      'git@github.com:example/cc.git',
      'https://github.com/example/cc.git',
      'https://user@GitHub.com/example/cc',
      'ssh://git@github.com:22/example/cc.git',
      'git+ssh://git@github.com/example/cc/',
    ]
    for (const form of forms) expect(normalizeRemote(form)).toBe('github.com/example/cc')
  })
})
