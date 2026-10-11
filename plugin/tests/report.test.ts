import { describe, expect, test } from 'claude-code/testing'

import { REPORT_MAX_PROBLEMS, freshReport, withProblem } from '../src/report'
import { MemDir } from './memdir'
import { CC, put, startSession } from './world'

const HUB = { hubUrl: 'https://hub.test/', hubToken: 'secret' }
const MINE = '01JA7K2M3Q9X4ZB6C8D0EFGH91'
const REPORT = '/home/me/.cache/ostrakon/report.json'
const problemsIn = (dir: MemDir) => (JSON.parse(dir.get(REPORT) ?? '{}') as { problems?: { where: string; message: string; count: number }[] }).problems ?? []

describe('the load report', () => {
  test('counts a repeated problem once, and keeps the latest ten distinct ones', () => {
    let report = freshReport('2026-10-09T12:00:00.000Z', '2.1.294')
    report = withProblem(report, 'sync', 'offline', '2026-10-09T12:00:02.000Z')
    report = withProblem(report, 'storage', 'disk full', '2026-10-09T12:00:03.000Z')
    report = withProblem(report, 'sync', 'offline', '2026-10-09T12:00:04.000Z')
    expect(report.problems.map(p => `${p.where}:${p.count}`)).toEqual(['storage:1', 'sync:2'])
    expect(report.problems[1]).toMatchObject({ first: '2026-10-09T12:00:02.000Z', last: '2026-10-09T12:00:04.000Z' })
    for (let i = 0; i < 12; i++) report = withProblem(report, 'sync', `problem ${i}`, '2026-10-09T12:01:00.000Z')
    expect(report.problems).toHaveLength(REPORT_MAX_PROBLEMS)
    expect(report.problems.at(-1)?.message).toBe('problem 11')
  })

  test('a session start writes which Claude Code loaded the mod', async ($, on) => {
    const dir = new MemDir()
    await startSession($, on, dir)
    const report = JSON.parse(dir.get(REPORT) ?? '{}')
    expect(report).toMatchObject({ claude: '2.1.294', loadedAt: '2026-10-09T12:00:00.000Z', problems: [] })
  })

  // A refused pull is in hub.test.tsx; a push fails apart from it, in the core's retry.
  test('a push the hub refuses goes in it, with the pulls answered', { options: HUB }, async ($, on) => {
    const dir = new MemDir()
    put(dir, MINE, 'a local note', CC, 5)
    const waiting: (() => void)[] = []
    on('http.fetch', async ($, e) => {
      if (e.url.includes('/api/notes')) return { value: { status: 401, ok: false, headers: {}, text: '' } }
      if (e.url.includes('wait=25')) await new Promise<void>(resolve => waiting.push(resolve))
      return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ notes: [], cursor: 1 }) } }
    })
    const { clock } = await startSession($, on, dir)
    await clock.advance(2000)
    expect(problemsIn(dir)).toEqual([expect.objectContaining({ where: 'hub', message: 'hub refused the token' })])
    for (const release of waiting) release()
  })
})

describe('saving the load report', () => {
  test('a slow save never lands over a newer one, and what came during it is saved after', { options: HUB }, async ($, on) => {
    const dir = new MemDir()
    let answer = { status: 401, ok: false, headers: {}, text: '' }
    on('http.fetch', () => ({ value: answer }))
    const { clock } = await startSession($, on, dir)
    // The poll's save of the refused token is held at its write; the hub then refuses otherwise.
    let release = () => {}
    const held = new Promise<void>(resolve => (release = resolve))
    let isHeld = false
    dir.holdWrite = path => {
      if (!path.startsWith(`${REPORT}.`) || isHeld) return undefined
      isHeld = true
      return held
    }
    await clock.advance(2000)
    expect(isHeld).toBe(true)
    answer = { status: 403, ok: false, headers: {}, text: '{"error":"forbidden"}' }
    await clock.advance(10_000)
    release()
    await clock.advance(4000)
    expect(problemsIn(dir).map(p => p.message)).toEqual(['hub refused the token', 'hub refused: forbidden'])
  })

  test('a save whose move fails leaves no temp file behind and is tried again on the next poll', async ($, on) => {
    const dir = new MemDir()
    dir.failMovesTo.add(REPORT)
    const { clock } = await startSession($, on, dir)
    expect(dir.get(REPORT)).toBeUndefined()
    expect(dir.names('/home/me/.cache/ostrakon').filter(name => name.startsWith('report.json'))).toEqual([])
    dir.failMovesTo.delete(REPORT)
    await clock.advance(2000)
    expect(JSON.parse(dir.get(REPORT) ?? '{}')).toMatchObject({ claude: '2.1.294', problems: [] })
  })
})
