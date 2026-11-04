import { describe, expect, test } from 'claude-code/testing'

import { UPDATE_CHECK_MS, UPDATE_LOOK_MS, cacheOf, isMarketplaceRoot, isStale, newestTag, noticeOf, versionOf } from '../src/update'
import { MemDir } from './memdir'
import { mountPane, startSession, texts } from './world'

const NOW = Date.parse('2026-10-09T12:00:00.000Z')
const CACHE = '/home/me/.cache/ostrakon/update.json'
// The mod's folder, as the engine loads it for these tests (beside this one).
const ROOT = decodeURIComponent(new URL('..', (import.meta as unknown as { url: string }).url).pathname).replace(/\/+$/, '')
const TAGS = ['abc\trefs/tags/v0.8.0', 'def\trefs/tags/v0.10.0', 'ghi\trefs/tags/v0.9.0', 'jkl\trefs/tags/v0.11.0-rc1', 'mno\trefs/tags/nightly'].join('\n')

describe('the update notice, worked out', () => {
  test('the newest release tag, by number rather than by spelling', () => {
    expect(newestTag(TAGS)).toEqual([0, 10, 0])
    expect(newestTag('')).toBeUndefined()
  })

  test('a newer release says so; a newer copy on disk asks for a restart first', () => {
    const v = (text: string) => versionOf(text)
    expect(noticeOf(v('0.9.0'), v('0.9.0'), v('0.10.0'))).toBe('0.10.0 out · ostrakon update')
    expect(noticeOf(v('0.9.0'), v('0.10.0'), v('0.10.0'))).toBe('restart to use 0.10.0')
    expect(noticeOf(v('0.9.0'), v('0.9.0'), v('0.9.0'))).toBe('')
    // A branch ahead of the newest release (release prep) isn't told to go back.
    expect(noticeOf(v('0.10.0'), v('0.10.0'), v('0.9.0'))).toBe('')
    expect(noticeOf(undefined, v('0.9.0'), v('0.10.0'))).toBe('')
  })

  test('the cache goes stale after a day, and a cache from the future is stale too', () => {
    expect(isStale(undefined, NOW)).toBe(true)
    expect(isStale({ checkedAt: NOW, newest: '' }, NOW + UPDATE_CHECK_MS - 1)).toBe(false)
    expect(isStale({ checkedAt: NOW, newest: '' }, NOW + UPDATE_CHECK_MS)).toBe(true)
    expect(isStale({ checkedAt: NOW + 1000, newest: '' }, NOW)).toBe(true)
    expect(cacheOf('not json')).toBeUndefined()
    expect(cacheOf('{"checkedAt":1,"newest":"0.9.0"}')).toEqual({ checkedAt: 1, newest: '0.9.0' })
  })

  test("a marketplace copy isn't the install script's checkout", () => {
    expect(isMarketplaceRoot('/home/me/.claude/plugins/cache/ostrakon/ostrakon/0.9.0')).toBe(true)
    expect(isMarketplaceRoot('/home/me/.claude/plugins/marketplaces/ostrakon/plugin')).toBe(true)
    expect(isMarketplaceRoot('/home/me/.local/share/ostrakon-src/plugin')).toBe(false)
  })
})

// The mod's own folder as the test engine loads it, laid out as the install script's checkout.
const asCheckout = (dir: MemDir, root: string, version: string) => {
  dir.put(`${root.replace(/\/plugin$/, '')}/.git`, 'gitdir: elsewhere')
  dir.put(`${root}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'ostrakon', version }))
}

const footer = async ($: Parameters<typeof mountPane>[0]) => {
  const ui = await mountPane($)
  const shown = await texts(ui)
  await ui.unmount()
  return shown
}

describe('the update notice, in a session', () => {
  test('a newer release shows in the footer, and the answer is kept for a day', async ($, on) => {
    const dir = new MemDir()
    asCheckout(dir, ROOT, '0.9.0')
    const asked: { argv: readonly string[]; env: Record<string, string> }[] = []
    dir.git = (argv, env) => {
      asked.push({ argv, env })
      return { exitCode: 0, stdout: TAGS }
    }
    const { clock } = await startSession($, on, dir)
    await clock.advance(10)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.argv).toContain('ls-remote')
    expect(asked[0]?.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(cacheOf(dir.get(CACHE))?.newest).toBe('0.10.0')
    expect(await footer($)).toContain('0.10.0 out · ostrakon update')
    // An hour on, the cache answers: no second ask.
    await clock.advance(UPDATE_LOOK_MS)
    expect(asked).toHaveLength(1)
  })

  test('after an update on disk, the footer asks for a restart', async ($, on) => {
    const dir = new MemDir()
    asCheckout(dir, ROOT, '0.9.0')
    dir.put(CACHE, JSON.stringify({ checkedAt: NOW, newest: '0.10.0' }))
    dir.git = () => ({ exitCode: 0, stdout: TAGS })
    const { clock } = await startSession($, on, dir)
    await clock.advance(10)
    asCheckout(dir, ROOT, '0.10.0')
    await clock.advance(UPDATE_LOOK_MS)
    expect(await footer($)).toContain('restart to use 0.10.0')
  })

  test('off, it never asks and shows nothing', { options: { updateCheck: false } }, async ($, on) => {
    const dir = new MemDir()
    asCheckout(dir, ROOT, '0.9.0')
    dir.put(CACHE, JSON.stringify({ checkedAt: NOW - UPDATE_CHECK_MS, newest: '0.10.0' }))
    let asked = 0
    dir.git = () => {
      asked += 1
      return { exitCode: 0, stdout: TAGS }
    }
    const { clock } = await startSession($, on, dir)
    await clock.advance(10)
    expect(asked).toBe(0)
    expect((await footer($)).some(text => text.includes('ostrakon update'))).toBe(false)
  })

  test("with non-essential traffic turned off it doesn't ask, but still reads the cache", async ($, on) => {
    const dir = new MemDir()
    asCheckout(dir, ROOT, '0.9.0')
    dir.put(CACHE, JSON.stringify({ checkedAt: NOW - UPDATE_CHECK_MS, newest: '0.10.0' }))
    let asked = 0
    dir.git = () => {
      asked += 1
      return { exitCode: 0, stdout: TAGS }
    }
    const { clock } = await startSession($, on, dir, '', undefined, { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' })
    await clock.advance(10)
    expect(asked).toBe(0)
    expect(await footer($)).toContain('0.10.0 out · ostrakon update')
  })

  test('offline, nothing shows and nothing is cached', async ($, on) => {
    const dir = new MemDir()
    asCheckout(dir, ROOT, '0.9.0')
    dir.git = () => ({ exitCode: 128, stdout: '' })
    const { clock } = await startSession($, on, dir)
    await clock.advance(10)
    expect(dir.get(CACHE)).toBeUndefined()
    expect((await footer($)).some(text => text.includes('ostrakon update'))).toBe(false)
  })
})
