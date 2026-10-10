import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Probe: an Input whose `value` is only the last W cells
// of a full draft kept in state. `/spw [boxWidth] [margin] [remount]` opens the pane (remount: back | always | nothing);
// every result goes to the debug log as "SPW ...". The helpers below are the pure part (what model.ts would hold).

const state = atom({ plugin: 'spw', key: 'state' } as const, { full: '', pairs: [] as { head: string; tail: string }[], width: 60 })
const margin = atom({ plugin: 'spw', key: 'margin' } as const, 4)
// remount: '' (never), 'back' (a new Input key, so a new cursor at the end, when the window scrolls back or an edit lands mid-window), 'always' (every input)
const remount = atom({ plugin: 'spw', key: 'remount' } as const, { mode: '', gen: 0 })

const log = ($: EngineInterface, text: string) => $.ui.log(`SPW ${text}`, { to: 'debug' })
const hash = (text: string) => { let h = 5381; for (const ch of text) h = ((h * 33) ^ ch.codePointAt(0)!) >>> 0; return h.toString(16) }
const show = (text: string) => JSON.stringify(text.length > 90 ? `${text.slice(0, 20)}…(${text.length})…${text.slice(-50)}` : text)

const WIDE =
  /[ᄀ-ᅟ〈〉⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
const ZERO = /[̀-ͯ᪰-᫿᷀-᷿​-‏⃐-⃿︀-️]/u
const cellsOf = (char: string) => (ZERO.test(char) ? 0 : WIDE.test(char) ? 2 : 1)
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const clustersOf = (text: string) => Array.from(segmenter.segment(text), part => part.segment)
const clusterCells = (cluster: string) => Math.max(0, ...Array.from(cluster, cellsOf))
const cells = (text: string) => clustersOf(text).reduce((sum, c) => sum + clusterCells(c), 0)

type Pair = { head: string; tail: string }

// The last `width` cells of the draft by whole clusters; head is the rest.
const windowOf = (draft: string, width: number): Pair => {
  let used = 0
  const kept: string[] = []
  const all = clustersOf(draft)
  for (let i = all.length - 1; i >= 0; i--) {
    const size = clusterCells(all[i]!)
    if (used + size > width) break
    kept.unshift(all[i]!)
    used += size
  }
  const tail = kept.join('')
  return { head: draft.slice(0, draft.length - tail.length), tail }
}

// pairs: newest first. Typing: tail is a prefix of value; backspacing: value is a prefix of tail.
const rejoin = (pairs: Pair[], value: string): { full: string; via: number } => {
  for (let i = 0; i < pairs.length; i++) {
    const { head, tail } = pairs[i]!
    if (value.startsWith(tail) || tail.startsWith(value)) return { full: head + value, via: i }
  }
  // Neither is a prefix of the other: an edit inside the window (the Input has arrows). The head is unchanged.
  if (pairs.length > 0) return { full: pairs[0]!.head + value, via: -2 }
  return { full: value, via: -1 }
}

async function onInput($: EngineInterface, value: string) {
  const was = await read($, state)
  const m = await read($, margin)
  const { full, via } = rejoin(was.pairs, value)
  const drawn = windowOf(full, was.width - m)
  await update($, state, s => ({ ...s, full, pairs: [drawn, ...s.pairs].slice(0, 2) }))
  const mode = await read($, remount)
  // A new key (a fresh Input, cursor at the end) is needed when the Input would otherwise keep a value or a cursor of its own:
  // the drawn tail is the one already drawn (the engine skips the redraw), is longer than the value (the cursor stays where it was,
  // short of the end), or the edit was mid-window (the cursor is mid-text).
  const same = drawn.tail === was.pairs[0]?.tail && value !== drawn.tail
  const longer = drawn.tail.length > value.length
  if (mode.mode === 'always' || (mode.mode === 'back' && (via === -2 || same || longer))) await update($, remount, r => ({ ...r, gen: r.gen + 1 }))
  log($, `input value=${show(value)} (${cells(value)}c) via=${via} full=${show(full)} (${cells(full)}c) h=${hash(full)} head=${cells(drawn.head)}c draws=${show(drawn.tail)} (${cells(drawn.tail)}c)`)
}


async function onSubmit($: EngineInterface, value: string) {
  const was = await read($, state)
  const { full } = rejoin(was.pairs, value)
  log($, `submit value=${show(value)} full=${show(full)} (${cells(full)}c)`)
  await update($, state, st => ({ ...st, full: '', pairs: [] }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spw', description: 'Windowed Input probe: /spw [boxWidth] [margin]', argumentHint: '[boxWidth] [margin]' })
    return next(e)
  })

  on('command.run', { command: 'spw' }, async ($, e) => {
    const [w, m, mode] = (e.args ?? '').trim().split(/\s+/).map((part, i) => (i < 2 ? Number(part) : part)) as [number, number, string]
    await update($, remount, () => ({ mode: mode ?? '', gen: 0 }))
    await update($, state, () => ({ full: '', pairs: [], width: w || 60 }))
    await update($, margin, () => (Number.isFinite(m) ? (m as number) : 4))
    const r = await $.ui.open({ id: 'spw', title: 'spw', focus: true, closeOnEscape: true, rows: 12 })
    log($, `open box=${w || 60} margin=${Number.isFinite(m) ? m : 4} ${JSON.stringify(r)}`)
    return { text: 'spw' }
  })

  on('ui.render', { component: 'Pane', requestId: 'spw' }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e) as any
    const s = await read($, state)
    const m = await read($, margin)
    const rm = await read($, remount)
    const w = s.width - m
    const shown = s.pairs[0]?.tail ?? ''
    // Below the width the window is the whole draft (head empty), so the draw is value === draft.
    log($, `render full=${cells(s.full)}c drawn=${show(shown)} (${cells(shown)}c) box=${s.width} W=${w} gen=${rm.gen} mode=${rm.mode}`)
    return (
      <Box flexDirection="column">
        <Box width={e.props.bodyColumns}>
          <Box flexShrink={0}>
            <Text color="cyan" bold>
              ✎ spw{' '}
            </Text>
          </Box>
          <Box key={`spw-box-${rm.gen}`} width={s.width}>
            <Input
              key={`spw-input-${rm.gen}`}
              placeholder="type here"
              value={shown}
              submitLabel=""
              autoFocus
              onInput={(value: string) => onInput($, value)}
              onSubmit={(value: string) => onSubmit($, value)}
            />
          </Box>
          <Text dimColor> ◂box</Text>
        </Box>
        <Text>
          full draft ({cells(s.full)} cells, head {s.pairs[0] ? cells(s.pairs[0].head) : 0}): {s.full}
        </Text>
      </Box>
    )
  })
}
