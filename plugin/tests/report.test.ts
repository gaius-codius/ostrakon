import { describe, expect, test } from 'claude-code/testing'

import { REPORT_MAX_PROBLEMS, freshReport, withProblem } from '../src/report'
import { MemDir } from './memdir'
import { startSession } from './world'

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
    const report = JSON.parse(dir.get('/home/me/.cache/ostrakon/report.json') ?? '{}')
    expect(report).toMatchObject({ claude: '2.1.294', loadedAt: '2026-10-09T12:00:00.000Z', problems: [] })
  })
})
