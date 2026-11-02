import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Note } from '../plugin/types'
import { handler, openHub, startFiling } from './hub'
import { type Draft, type Filing, type FilingRequest, NotCreated } from './requests'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const A = '01JA7K2M3Q9X4ZB6C8D0EFGH0A'
const B = '01JA7K2M3Q9X4ZB6C8D0EFGH0B'

const note = (id: string, fields: Partial<Note> = {}): Note => ({
  id,
  status: 'open',
  by: 'you',
  created: '2026-10-10T01:00:00.000Z',
  updated: '2026-10-10T01:00:00.000Z',
  origin: 'office',
  project: { key: 'github.com/me/cc', name: 'cc', path: '/home/me/cc' },
  context: {},
  sentAt: null,
  deleted: false,
  text: 'the retry loses the last line',
  extra: [],
  ...fields,
})

// A step the stub holds until the test lets it go, to see the state while it runs.
const held = <T>() => {
  let release: (value: T) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    release = resolve
    fail = reject
  })
  return { promise, release, fail }
}

// Drafting and filing stubbed: each answers as the test sets it, and records what it was given.
const stubFiling = () => {
  const calls = { draft: [] as FilingRequest[], file: [] as FilingRequest[], find: [] as FilingRequest[] }
  const answers = {
    draft: async (request: FilingRequest): Promise<Draft> => ({ title: `Retry loses a line (${request.revision + 1})`, body: request.text, labels: ['bug'] }),
    file: async (_request: FilingRequest): Promise<string> => 'https://github.com/me/cc/issues/7',
    find: async (_request: FilingRequest): Promise<string | null> => null,
  }
  const filing: Filing = {
    repos: async () => [
      { repo: 'me/cc', public: true },
      { repo: 'Me/Secret', public: false },
    ],
    draft: request => {
      calls.draft.push(request)
      return answers.draft(request)
    },
    file: request => {
      calls.file.push(request)
      return answers.file(request)
    },
    find: request => {
      calls.find.push(request)
      return answers.find(request)
    },
  }
  return { filing, calls, answers }
}

// A hub with filing stubbed. `run`: the runner drafts and files as requests come; without it the
// test takes each of the hub's steps itself.
const fresh = ({ run = true, filingOn = true, dir }: { run?: boolean; filingOn?: boolean; dir?: string } = {}) => {
  const data = dir ?? mkdtempSync(join(tmpdir(), 'hub-requests-'))
  if (!dir) dirs.push(data)
  let clock = Date.parse('2026-10-10T02:00:00Z')
  const now = () => (clock += 1000)
  const hub = openHub(data, { now, origin: 'hubhost' })
  const stub = stubFiling()
  const runner = startFiling(hub, stub.filing)
  const fetch = handler(hub, { token: 'secret' }, { filing: filingOn ? stub.filing : undefined, kick: run ? runner.kick : () => {} })
  const call = async (path: string, body?: unknown) => {
    const response = await fetch(
      new Request(`http://hub${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: 'Bearer secret' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return { status: response.status, body: (await response.json()) as { request: FilingRequest; error?: string; requests?: FilingRequest[] } }
  }
  const ask = (id = A) => call('/api/requests', { note: id })
  const step = (id: string, name: string, body: unknown = {}) => call(`/api/requests/${id}/${name}`, body)
  return { dir: data, hub, ...stub, runner, call, ask, step }
}

// A request taken to `drafted` by the runner.
const drafted = async (t: ReturnType<typeof fresh>, id = A) => {
  t.hub.push([note(id)])
  const { body } = await t.ask(id)
  await t.runner.kick()
  return t.hub.requests.get(body.request.id) as FilingRequest
}

describe('requesting', () => {
  test('File as issue on a note under a covered repo makes one waiting request with a snapshot of the note', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const { status, body } = await t.ask()
    expect(status).toBe(200)
    expect(body.request).toMatchObject({
      note: A,
      state: 'waiting',
      text: 'the retry loses the last line',
      project: { key: 'github.com/me/cc' },
      repo: 'me/cc',
      public: true,
      revision: 0,
      draft: null,
    })
    expect(body.request.id).toMatch(/^[0-9A-Z]{26}$/)
    expect(t.hub.requests.open()).toHaveLength(1)
  })

  test('drafting reads the snapshot, not the note as it is now', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const { body } = await t.ask()
    t.hub.push([note(A, { text: 'changed since', updated: '2026-10-10T03:00:00.000Z' })])
    await t.runner.kick()
    expect(t.calls.draft[0]?.text).toBe('the retry loses the last line')
    expect(t.hub.requests.get(body.request.id)?.draft?.body).toBe('the retry loses the last line')
  })

  test('a repo matches whatever its case, and keeps whether it is public', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A, { project: { key: 'github.com/me/secret', name: 'secret', path: '/x' } })])
    const { body } = await t.ask()
    expect(body.request).toMatchObject({ repo: 'me/secret', public: false, state: 'waiting' })
  })

  test("a note that isn't under a covered github.com repo is refused, and nothing is made", async () => {
    const t = fresh({ run: false })
    const cases: Note['project'][] = [
      { key: 'path:/home/me/notes', name: 'notes', path: '/home/me/notes' },
      { key: 'gitlab.com/me/cc', name: 'cc', path: '/x' },
      { key: 'github.com/me/other', name: 'other', path: '/x' },
      { key: 'github.com/me/cc/extra', name: 'cc', path: '/x' },
      null,
    ]
    for (const project of cases) {
      t.hub.push([note(A, { project, updated: new Date(Date.parse('2026-10-11T00:00:00Z') + cases.indexOf(project) * 1000).toISOString() })])
      const { status, body } = await t.ask()
      expect(status).toBe(400)
      expect(body.error).toBeString()
    }
    expect(t.hub.requests.open()).toEqual([])
  })

  test('a note that is not open, deleted or unknown is refused', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A, { status: 'archived' }), note(B, { deleted: true })])
    expect((await t.ask(A)).status).toBe(400)
    expect((await t.ask(B)).status).toBe(404)
    expect((await t.ask('01JA7K2M3Q9X4ZB6C8D0EFGH0Z')).status).toBe(404)
    expect((await t.call('/api/requests', { note: 7 })).status).toBe(400)
  })

  test('with filing off, a request is refused and the hub says it is off', async () => {
    const t = fresh({ filingOn: false })
    t.hub.push([note(A)])
    expect((await t.ask()).status).toBe(409)
    expect((await t.call('/api/filing')).body).toEqual({ on: false, repos: [] } as never)
    expect(t.hub.requests.open()).toEqual([])
  })

  test('with filing on, the hub lists the repos it covers', async () => {
    const t = fresh()
    expect((await t.call('/api/filing')).body).toEqual({
      on: true,
      repos: [
        { repo: 'me/cc', public: true },
        { repo: 'Me/Secret', public: false },
      ],
    } as never)
  })

  test('while a request is open for a note, asking again returns it instead of making a second', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const first = await t.ask()
    const again = await t.ask()
    expect(again.status).toBe(200)
    expect(again.body.request.id).toBe(first.body.request.id)
    expect(t.hub.requests.open()).toHaveLength(1)
  })

  test('once a request is discarded, the note can be asked for again', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const first = await t.ask()
    await t.step(first.body.request.id, 'discard')
    const second = await t.ask()
    expect(second.body.request.id).not.toBe(first.body.request.id)
    expect(second.body.request.state).toBe('waiting')
  })
})

describe('drafting', () => {
  test('waiting → drafting → drafted, the revision counting up', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const { body } = await t.ask()
    const draft = held<Draft>()
    t.answers.draft = () => draft.promise
    const running = t.runner.kick()
    expect(t.hub.requests.get(body.request.id)?.state).toBe('drafting')
    draft.release({ title: 'T', body: 'B', labels: [] })
    await running
    expect(t.hub.requests.get(body.request.id)).toMatchObject({ state: 'drafted', revision: 1, draft: { title: 'T', body: 'B', labels: [] } })
  })

  test('drafting fails or times out → failed in the draft phase, with a short reason', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const { body } = await t.ask()
    t.answers.draft = async () => {
      throw new Error(`claude timed out\n${'and then '.repeat(100)}`)
    }
    await t.runner.kick()
    const failed = t.hub.requests.get(body.request.id)
    expect(failed).toMatchObject({ state: 'failed', phase: 'draft', revision: 0 })
    expect(failed?.error?.length).toBeLessThanOrEqual(300)
    expect(failed?.error).toStartWith('claude timed out and then')
  })

  test('a new draft: drafted → waiting, and the next draft is revision 2', async () => {
    const t = fresh()
    const request = await drafted(t)
    const { body } = await t.step(request.id, 'redraft', { revision: 1 })
    expect(body.request.state).toBe('waiting')
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'drafted', revision: 2, draft: { title: 'Retry loses a line (2)' } })
  })

  test('a failed draft is not tried again on its own; Retry sends it back to waiting', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const { body } = await t.ask()
    t.answers.draft = async () => {
      throw new Error('no')
    }
    await t.runner.kick()
    await t.runner.kick()
    expect(t.calls.draft).toHaveLength(1)
    const retried = await t.step(body.request.id, 'retry')
    expect(retried.body.request).toMatchObject({ state: 'waiting', phase: null, error: null })
  })
})

describe('filing', () => {
  test('filing the current revision: drafted → approved → filing → filed, with the issue URL', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    const approved = await t.step(request.id, 'file', { revision: 1 })
    expect(approved.body.request.state).toBe('approved')
    const file = held<string>()
    t.answers.file = () => file.promise
    const running = t.runner.kick()
    expect(t.hub.requests.get(request.id)?.state).toBe('filing')
    expect(t.calls.file[0]?.draft).toEqual(request.draft)
    file.release('https://github.com/me/cc/issues/7')
    await running
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'filed', issue: 'https://github.com/me/cc/issues/7' })
  })

  test('filing a stale revision is refused and leaves the request as it was', async () => {
    const t = fresh()
    const request = await drafted(t)
    await t.step(request.id, 'redraft', { revision: 1 })
    await t.runner.kick()
    const stale = await t.step(request.id, 'file', { revision: 1 })
    expect(stale.status).toBe(409)
    expect(stale.body.request).toMatchObject({ state: 'drafted', revision: 2 })
    expect(t.hub.requests.get(request.id)).toEqual(stale.body.request)
    expect(t.calls.file).toEqual([])
  })

  test('filing needs a revision', async () => {
    const t = fresh()
    const request = await drafted(t)
    expect((await t.step(request.id, 'file', {})).status).toBe(400)
    expect(t.hub.requests.get(request.id)?.state).toBe('drafted')
  })

  test('the filed issue goes on the note as an ordinary change: issue: <url>, and the note is sent', async () => {
    const t = fresh()
    const request = await drafted(t)
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    const written = t.hub.note(A)
    expect(written).toMatchObject({ status: 'sent', origin: 'hubhost', extra: ['issue: https://github.com/me/cc/issues/7'] })
    expect(written?.sentAt).toBeString()
    expect(Date.parse(written?.updated ?? '')).toBeGreaterThan(Date.parse(note(A).updated))
  })

  test('a note archived meanwhile gets the issue line and stays archived; one with an issue line has it replaced', async () => {
    const t = fresh()
    const request = await drafted(t)
    t.hub.push([note(A, { status: 'archived', extra: ['issue: https://github.com/me/cc/issues/1'], updated: '2026-10-10T05:00:00.000Z' })])
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.note(A)).toMatchObject({ status: 'archived', extra: ['issue: https://github.com/me/cc/issues/7'] })
  })

  test('a note deleted meanwhile is left alone; the request still keeps the issue', async () => {
    const t = fresh()
    const request = await drafted(t)
    const tomb = note(A, { deleted: true, updated: '2026-10-10T05:00:00.000Z' })
    t.hub.push([tomb])
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.note(A)).toEqual(tomb)
    expect(t.hub.requests.get(request.id)?.issue).toBe('https://github.com/me/cc/issues/7')
  })

  test('GitHub refusing before it creates anything → failed in the file phase; Retry approves it again', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new NotCreated('label does not exist')
    }
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'failed', phase: 'file', error: 'label does not exist' })
    const retried = await t.step(request.id, 'retry')
    expect(retried.body.request).toMatchObject({ state: 'approved', phase: null, error: null })
    t.answers.file = async () => 'https://github.com/me/cc/issues/7'
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)?.state).toBe('filed')
  })

  test('no clear answer from GitHub → unsure, looked up once, and never filed again on its own', async () => {
    const t = fresh()
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('gh timed out')
    }
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'unsure', error: 'gh timed out' })
    expect(t.calls.find).toHaveLength(1)
    await t.runner.kick()
    expect(t.calls.file).toHaveLength(1)
    expect(t.calls.find).toHaveLength(1)
  })

  test('unsure → filed when the hub finds the issue by its marker', async () => {
    const t = fresh()
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('502')
    }
    t.answers.find = async () => 'https://github.com/me/cc/issues/9'
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'filed', issue: 'https://github.com/me/cc/issues/9' })
    expect(t.hub.note(A)?.extra).toEqual(['issue: https://github.com/me/cc/issues/9'])
  })

  test('unsure → approved when the person says it was not filed, and then it is filed', async () => {
    const t = fresh()
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('lost')
    }
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    t.answers.file = async () => 'https://github.com/me/cc/issues/8'
    const back = await t.step(request.id, 'not-filed', { seq: t.hub.requests.get(request.id)?.seq })
    expect(back.status).toBe(200)
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'filed', issue: 'https://github.com/me/cc/issues/8' })
  })

  test("unsure → filed with the URL the person found, only an issue in the request's repo", async () => {
    const t = fresh()
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('lost')
    }
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    for (const url of ['https://github.com/me/other/issues/3', 'https://github.com/me/cc/pull/3', 'http://github.com/me/cc/issues/3', 'nope']) {
      const wrong = await t.step(request.id, 'found', { url })
      expect(wrong.status).toBe(409)
      expect(wrong.body.request.state).toBe('unsure')
    }
    const found = await t.step(request.id, 'found', { url: ' https://github.com/Me/CC/issues/3 ' })
    expect(found.body.request).toMatchObject({ state: 'filed', issue: 'https://github.com/Me/CC/issues/3' })
    expect(t.hub.note(A)?.extra).toEqual(['issue: https://github.com/Me/CC/issues/3'])
    // Saying so again changes nothing.
    const updated = t.hub.note(A)?.updated
    expect((await t.step(request.id, 'found', { url: 'https://github.com/Me/CC/issues/3' })).status).toBe(200)
    expect(t.hub.note(A)?.updated).toBe(updated)
  })
})

describe('discarding', () => {
  test('waiting, drafted and failed can be discarded', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A), note(B)])
    const waiting = (await t.ask(A)).body.request
    expect((await t.step(waiting.id, 'discard')).body.request.state).toBe('discarded')
    const later = (await t.ask(B)).body.request
    await t.runner.kick()
    expect(t.hub.requests.get(later.id)?.state).toBe('drafted')
    expect((await t.step(later.id, 'discard')).body.request.state).toBe('discarded')

    const t2 = fresh({ run: false })
    t2.hub.push([note(A)])
    const failing = (await t2.ask()).body.request
    t2.answers.draft = async () => {
      throw new Error('no')
    }
    await t2.runner.kick()
    expect((await t2.step(failing.id, 'discard')).body.request.state).toBe('discarded')
  })

  test('an approved request discarded before filing claims it is never filed', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    await t.step(request.id, 'file', { revision: 1 })
    const discarded = await t.step(request.id, 'discard')
    expect(discarded.status).toBe(200)
    expect(discarded.body.request.state).toBe('discarded')
    await t.runner.kick()
    expect(t.calls.file).toEqual([])
    expect(t.hub.requests.get(request.id)?.state).toBe('discarded')
  })

  test('an unsure request discarded is never looked up or filed again, even after a restart', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('lost')
    }
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)?.state).toBe('unsure')
    expect(t.calls.find).toHaveLength(1)
    expect((await t.step(request.id, 'discard')).body.request.state).toBe('discarded')
    // Not filed after it changes nothing: it stays discarded.
    expect((await t.step(request.id, 'not-filed', { seq: request.seq })).status).toBe(409)
    await t.runner.kick()
    t.hub.close()
    const again = fresh({ run: false, dir: t.dir })
    await again.runner.kick()
    expect(again.calls.find).toEqual([])
    expect(again.calls.file).toEqual([])
    expect(again.hub.requests.get(request.id)?.state).toBe('discarded')
    again.hub.close()
    expect(t.calls.find).toHaveLength(1)
    expect(t.calls.file).toHaveLength(1)
  })

  test('an issue a lookup finds after the person discarded the request is not recorded', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('lost')
    }
    const lookup = held<string | null>()
    t.answers.find = () => lookup.promise
    await t.step(request.id, 'file', { revision: 1 })
    const running = t.runner.kick()
    while (t.calls.find.length === 0) await Bun.sleep(1)
    expect((await t.step(request.id, 'discard')).body.request.state).toBe('discarded')
    lookup.release('https://github.com/me/cc/issues/5')
    await running
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'discarded', issue: null })
    expect(t.hub.note(A)?.extra).toEqual([])
  })

  test("drafting, filing and filed can't be discarded", async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    await t.step(request.id, 'file', { revision: 1 })
    const file = held<string>()
    t.answers.file = () => file.promise
    const running = t.runner.kick()
    const refused = await t.step(request.id, 'discard')
    expect(refused.status).toBe(409)
    expect(refused.body.request.state).toBe('filing')
    file.fail(new Error('lost'))
    await running
    await t.step(request.id, 'found', { url: 'https://github.com/me/cc/issues/2' })
    expect((await t.step(request.id, 'discard')).status).toBe(409)
    expect(t.hub.requests.get(request.id)?.state).toBe('filed')

    t.hub.push([note(B)])
    const other = (await t.ask(B)).body.request
    const draft = held<Draft>()
    t.answers.draft = () => draft.promise
    const drafting = t.runner.kick()
    expect((await t.step(other.id, 'discard')).status).toBe(409)
    draft.release({ title: 'T', body: 'B', labels: [] })
    await drafting
  })
})

describe('repeats', () => {
  test('filing, discarding and retrying again return the request as it is', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    const once = await t.step(request.id, 'file', { revision: 1 })
    const twice = await t.step(request.id, 'file', { revision: 1 })
    expect(twice.status).toBe(200)
    expect(twice.body.request).toEqual(once.body.request)
    await t.runner.kick()
    expect(t.calls.file).toHaveLength(1)
    // Filed: filing it again is still a repeat, and nothing is filed twice.
    expect((await t.step(request.id, 'file', { revision: 1 })).body.request.state).toBe('filed')
    await t.runner.kick()
    expect(t.calls.file).toHaveLength(1)

    t.hub.push([note(B)])
    const other = (await t.ask(B)).body.request
    await t.step(other.id, 'discard')
    const again = await t.step(other.id, 'discard')
    expect(again.status).toBe(200)
    expect(again.body.request.state).toBe('discarded')
  })

  test('retrying twice leaves one waiting draft', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const request = (await t.ask()).body.request
    t.answers.draft = async () => {
      throw new Error('no')
    }
    await t.runner.kick()
    expect((await t.step(request.id, 'retry')).body.request.state).toBe('waiting')
    const again = await t.step(request.id, 'retry')
    expect(again.status).toBe(200)
    expect(again.body.request.state).toBe('waiting')
  })

  test("a step that doesn't fit the state is refused with the request as it stays", async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const request = (await t.ask()).body.request
    expect((await t.step(request.id, 'not-filed', { seq: request.seq })).status).toBe(409)
    expect((await t.step(request.id, 'redraft', { revision: 0 })).status).toBe(200)
    expect((await t.step(request.id, 'file', { revision: 0 })).status).toBe(409)
    expect((await t.step(request.id, 'found', { url: 'https://github.com/me/cc/issues/1' })).status).toBe(409)
    expect(t.hub.requests.get(request.id)?.state).toBe('waiting')
    expect((await t.step('01JA7K2M3Q9X4ZB6C8D0EFGH0Z', 'discard')).status).toBe(404)
  })
})

describe('restarts', () => {
  test('a request caught drafting goes back to waiting', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const request = (await t.ask()).body.request
    t.hub.requests.startDraft(request.id)
    t.hub.close()
    const again = fresh({ run: false, dir: t.dir })
    expect(again.hub.requests.get(request.id)?.state).toBe('waiting')
    again.hub.close()
  })

  test('a request caught filing becomes unsure, and the hub only looks for it, never files it again', async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    await t.step(request.id, 'file', { revision: 1 })
    t.hub.requests.startFile(request.id)
    t.hub.close()
    const again = fresh({ run: false, dir: t.dir })
    expect(again.hub.requests.get(request.id)).toMatchObject({ state: 'unsure', error: 'the hub restarted while filing' })
    await again.runner.kick()
    expect(again.calls.file).toEqual([])
    expect(again.calls.find.map(found => found.id)).toEqual([request.id])
    expect(again.hub.requests.get(request.id)?.state).toBe('unsure')
    again.hub.close()
  })

  test('requests outlive their note: archived, deleted and purged', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const request = (await t.ask()).body.request
    t.hub.push([note(A, { deleted: true, updated: '2026-01-01T00:00:00.000Z' })])
    t.hub.push([note(A, { deleted: true, updated: '2026-10-10T09:00:00.000Z' })])
    t.hub.purge(Date.parse('2027-10-10T00:00:00Z'))
    expect(t.hub.note(A)).toBeUndefined()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'waiting', text: 'the retry loses the last line' })
  })

  test('the database refuses a second open request for one note', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    await t.ask()
    const { Database } = await import('bun:sqlite')
    const db = new Database(join(t.dir, 'hub.sqlite'))
    expect(() =>
      db.run(
        `INSERT INTO requests (id, note, text, project, repo, public, state, revision, created, updated, seq) VALUES ('X', '${A}', '', '{}', 'me/cc', 1, 'drafted', 0, '', '', 99)`,
      ),
    ).toThrow()
    db.close()
  })
})

describe('the change feed', () => {
  test('a long poll asked for requests wakes for a request and carries it', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const cursor = t.hub.cursor()
    const waiting = t.call(`/api/changes?since=${cursor}&wait=5&requests=1`)
    setTimeout(() => void t.ask(), 50)
    const { body } = (await waiting) as unknown as { body: { notes: Note[]; requests: FilingRequest[]; cursor: number } }
    expect(body.notes).toEqual([])
    expect(body.requests.map(request => request.state)).toEqual(['waiting'])
    expect(body.cursor).toBeGreaterThan(cursor)
  })

  test('without asking for requests, the feed is as it was; from 0 it carries only the open ones', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A), note(B)])
    const discarded = (await t.ask(A)).body.request
    await t.step(discarded.id, 'discard')
    const open = (await t.ask(B)).body.request
    const plain = (await t.call('/api/changes?since=0')).body as unknown as Record<string, unknown>
    expect(plain.requests).toBeUndefined()
    const full = (await t.call('/api/changes?since=0&requests=1')).body as unknown as { requests: FilingRequest[] }
    expect(full.requests.map(request => request.id)).toEqual([open.id])
    // From a cursor, a request that closed since is there, so a client can drop it.
    const since = (await t.call('/api/changes?since=3&requests=1')).body as unknown as { requests: FilingRequest[] }
    expect(since.requests.map(request => [request.id, request.state])).toContainEqual([discarded.id, 'discarded'])
    expect((await t.call('/api/requests')).body.requests?.map(request => request.id)).toEqual([open.id])
  })
})

describe('races and answers from outside', () => {
  // A request whose filing went unanswered, its lookup held until the test lets it go.
  const unsureWithLookup = async () => {
    const t = fresh({ run: false })
    const request = await drafted(t)
    t.answers.file = async () => {
      throw new Error('lost')
    }
    const lookup = held<string | null>()
    t.answers.find = () => lookup.promise
    await t.step(request.id, 'file', { revision: 1 })
    const running = t.runner.kick()
    // Filing, then unsure, then the lookup starts.
    while (t.calls.find.length === 0) await Bun.sleep(1)
    return { t, request, lookup, running }
  }

  test('an issue the lookup finds after the person said Not filed is recorded, and not filed again', async () => {
    const { t, request, lookup, running } = await unsureWithLookup()
    const unsure = t.hub.requests.get(request.id) as FilingRequest
    expect((await t.step(request.id, 'not-filed', { seq: unsure.seq })).body.request.state).toBe('approved')
    lookup.release('https://github.com/me/cc/issues/5')
    await running
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'filed', issue: 'https://github.com/me/cc/issues/5' })
    expect(t.calls.file).toHaveLength(1)
  })

  test("a late repeat of Not filed doesn't approve a later attempt that also went unanswered", async () => {
    const { t, request, lookup, running } = await unsureWithLookup()
    const seen = (t.hub.requests.get(request.id) as FilingRequest).seq
    lookup.release(null)
    await running
    expect((await t.step(request.id, 'not-filed', { seq: seen })).body.request.state).toBe('approved')
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)?.state).toBe('unsure')
    const late = await t.step(request.id, 'not-filed', { seq: seen })
    expect(late.status).toBe(409)
    expect(late.body.request.state).toBe('unsure')
    expect((await t.step(request.id, 'not-filed', {})).status).toBe(400)
  })

  test('a stale New draft is refused and keeps the newer draft', async () => {
    const t = fresh()
    const request = await drafted(t)
    await t.step(request.id, 'redraft', { revision: 1 })
    await t.runner.kick()
    const stale = await t.step(request.id, 'redraft', { revision: 1 })
    expect(stale.status).toBe(409)
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'drafted', revision: 2 })
  })

  test("GitHub's URL is trimmed and must be an issue URL; anything else leaves the filing unsure", async () => {
    const t = fresh()
    const request = await drafted(t)
    t.answers.file = async () => 'https://github.com/me/cc/issues/5\n'
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'filed', issue: 'https://github.com/me/cc/issues/5' })
    expect(t.hub.note(A)?.extra).toEqual(['issue: https://github.com/me/cc/issues/5'])

    t.hub.push([note(B)])
    const other = (await t.ask(B)).body.request
    await t.runner.kick()
    t.answers.file = async () => 'https://github.com/me/cc/pull/1'
    await t.step(other.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(other.id)?.state).toBe('unsure')
    expect(t.hub.note(B)?.extra).toEqual([])
  })

  test("GitHub's URL may name the repo by a new name: a renamed repo's issue is recorded", async () => {
    const t = fresh()
    const request = await drafted(t)
    t.answers.file = async () => 'https://github.com/me/renamed/issues/3'
    await t.step(request.id, 'file', { revision: 1 })
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'filed', issue: 'https://github.com/me/renamed/issues/3' })
  })

  test('a draft that is not a title, body and labels fails the draft', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const request = (await t.ask()).body.request
    t.answers.draft = async () => ({ title: 'T', body: 'B' }) as Draft
    await t.runner.kick()
    expect(t.hub.requests.get(request.id)).toMatchObject({ state: 'failed', phase: 'draft' })
  })

  test('asking again returns the open request even after the note moved to a project that could not be asked for', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const first = (await t.ask()).body.request
    t.hub.push([note(A, { project: null, updated: '2026-10-10T05:00:00.000Z' })])
    const again = await t.ask()
    expect(again.status).toBe(200)
    expect(again.body.request.id).toBe(first.id)
  })

  test("a hub that can't read its repos answers 503, and a body that isn't an object is refused", async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    t.filing.repos = async () => {
      throw new Error('GitHub is down')
    }
    expect((await t.ask()).status).toBe(503)
    expect((await t.call('/api/requests', null)).status).toBe(400)
  })

  test('every change to a request moves its seq forward', async () => {
    const t = fresh({ run: false })
    t.hub.push([note(A)])
    const asked = (await t.ask()).body.request
    await t.runner.kick()
    const drafted = t.hub.requests.get(asked.id) as FilingRequest
    expect(drafted.seq).toBeGreaterThan(asked.seq)
    expect(drafted.seq).toBe(t.hub.cursor())
  })
})
