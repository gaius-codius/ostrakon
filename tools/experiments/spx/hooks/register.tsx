import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

// Every result goes to the debug log as "SPX ..." so the experiment runner can grep it.
const pendingFocus = atom({ plugin: 'spx', key: 'pendingFocus' } as const, '')
const stash = atom({ plugin: 'spx', key: 'stash' } as const, '')
const slashVariant = atom({ plugin: 'spx', key: 'slashVariant' } as const, '')
const focusLog = atom({ plugin: 'spx', key: 'focusLog' } as const, [])

const log = ($: EngineInterface, text: string) => $.ui.log(`SPX ${text}`, { to: 'debug' })

// Borrowed-action candidates for ctrl+l / ctrl+n (experiment 3).
const CANDIDATES = [
  'app:toggleReplTab',
  'app:toggleTerminal',
  'app:redraw',
  'pane:next',
  'pane:previous',
  'pane:grow',
  'pane:shrink',
] as const

const DIR = '/tmp/spx-mv'

const timeWrites = async ($: EngineInterface, n: number) => {
  const t0 = await $.clock.now()
  for (let i = 0; i < n; i++) await $.fs.write(`${DIR}/direct-${i}.md`, `note ${i}\n`)
  const t1 = await $.clock.now()
  for (let i = 0; i < n; i++) {
    await $.fs.write(`${DIR}/atomic-${i}.md.tmp`, `note ${i}\n`)
    await $.process.run(['mv', `${DIR}/atomic-${i}.md.tmp`, `${DIR}/atomic-${i}.md`])
  }
  const t2 = await $.clock.now()
  const t3s = await $.clock.now()
  const listed = await $.fs.list(DIR)
  const t3 = await $.clock.now()
  return `direct ${((t1 - t0) / n).toFixed(2)}ms/write, tmp+mv ${((t2 - t1) / n).toFixed(2)}ms/write, list(${listed.length}) ${(t3 - t3s).toFixed(1)}ms`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spx', description: 'experiments: open the test pane' })
    await $.command.register({ name: 'spxi', description: 'experiments: immediate capture', immediate: true, argumentHint: '<note>' })
    await $.command.register({ name: 'spxv', description: 'experiments: // variant', immediate: true })
    await $.command.register({ name: 'spxpid', description: 'experiments: parent pid of process.run' })
    await $.command.register({ name: 'spxmv', description: 'experiments: time tmp+mv writes' })
    await $.command.register({ name: 'spxnotion', description: 'experiments: $.mcp.call Notion' })
    return next(e)
  })

  // Experiments 1 and 2: open from a typed "//x" prompt.
  on('prompt.submit', async ($, e, next) => {
    const m = /^\/\/(a|b|c|d0|d1|e|g)\b/.exec(e.text)
    if (!m || e.origin.kind !== 'composer') return next(e)
    const box = await $.prompt.read()
    log($, `submit ${m[1]} composer="${box.text}"`)
    if (m[1] === 'a') {
      const r = await $.ui.open({ id: 'spxa', title: 'spx a', focus: true })
      log($, `a open ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
      return { drop: '✎ a' }
    }
    if (m[1] === 'b') {
      await update($, pendingFocus, () => 'spxb')
      const r = await $.ui.open({ id: 'spxb', title: 'spx b' })
      log($, `b open ${JSON.stringify(r)}`)
      return { drop: '✎ b' }
    }
    if (m[1] === 'c') {
      $.command.run({ command: 'spx' }).then(
        r => log($, `c command.run ok ${JSON.stringify(r).slice(0, 200)}`),
        err => log($, `c command.run rejected ${String(err)}`),
      )
      return { drop: '✎ c' }
    }
    if (m[1] === 'e') {
      $.clock.after(60, async () => {
        const r = await $.ui.open({ id: 'spxe', title: 'spx e', focus: true })
        log($, `e delayed open ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
      })
      return { drop: '✎ e' }
    }
    if (m[1] === 'g') {
      const r = await $.ui.open({ id: 'spxg', title: 'spx g' })
      log($, `g open ${JSON.stringify(r)}`)
      for (const ms of [60, 250, 600]) {
        $.clock.after(ms, async () => {
          const again = await $.ui.open({ id: 'spxg', title: 'spx g', focus: true })
          log($, `g reopen+focus @${ms}ms ${JSON.stringify(again)} panes=${JSON.stringify(await $.ui.panes())}`)
        })
      }
      return { drop: '✎ g' }
    }
    if (m[1] === 'd0') return { drop: '' }
    return { drop: '✎ noted' }
  })

  on('command.run', { command: 'spx' }, async $ => {
    const r = await $.ui.open({ id: 'spxc', title: 'spx c', focus: true, rows: 30 })
    log($, `c open ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
    return { text: '' }
  })

  on('command.run', { command: 'spxi' }, async ($, e) => {
    log($, `spxi ran args=${JSON.stringify(e.args)} at ${await $.clock.now()}`)
    if (String(e.args).trim() !== '') {
      $.ui.toast(`✎ noted: ${e.args}`)
      return { text: '' }
    }
    const r = await $.ui.open({ id: 'spxi', title: 'spx i', focus: true })
    log($, `spxi open ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
    return { text: '' }
  })

  // "//" as an instant trigger: the second slash typed into an otherwise empty prompt.
  on('prompt.edit', async ($, e, next) => {
    if (e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end) !== '//') return next(e)
    const variant = (await read($, slashVariant)) || 'before'
    if (variant === 'rewrite') {
      log($, 'slash rewrite → /spxi')
      return { text: '/spxi ', cursor: 6 }
    }
    if (variant === 'before') {
      const r = await $.ui.open({ id: 'spxs', title: 'spx slash', focus: true, closeOnEscape: true })
      log($, `slash open-before ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
      return { text: '', cursor: 0 }
    }
    $.clock.after(0, async () => {
      const r = await $.ui.open({ id: 'spxs', title: 'spx slash', focus: true, closeOnEscape: true })
      log($, `slash open-after ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
    })
    return { text: '', cursor: 0 }
  })

  on('command.run', { command: 'spxv' }, async ($, e) => {
    await update($, slashVariant, () => String(e.args).trim())
    return { text: `slash variant: ${String(e.args).trim()}` }
  })

  on('command.run', { command: 'spxpid' }, async $ => {
    const a = await $.process.run(['sh', '-c', 'echo $PPID; ps -o pid=,comm=,args= -p $PPID'])
    const b = await $.process.run(['sh', '-c', 'echo $PPID'])
    log($, `pid ${JSON.stringify(a.stdout)} second=${b.stdout.trim()}`)
    return { text: `spx pid: ${a.stdout.trim()} | second call ppid ${b.stdout.trim()}` }
  })

  // Experiment 5.
  on('command.run', { command: 'spxmv' }, async $ => {
    const out = [await timeWrites($, 100), await timeWrites($, 100)].join(' | ')
    log($, `mv ${out}`)
    return { text: `spx mv: ${out}` }
  })

  // Experiment 7.
  on('command.run', { command: 'spxnotion' }, async $ => {
    try {
      const r = await $.mcp.call('claude.ai Notion', 'notion-get-self', {})
      const text = JSON.stringify(r).slice(0, 300)
      log($, `notion ok ${text}`)
      return { text: `spx notion ok: ${text}` }
    } catch (err) {
      log($, `notion rejected ${String(err)}`)
      return { text: `spx notion rejected: ${String(err)}` }
    }
  })

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    const text = await read($, stash)
    if (text !== '') {
      await update($, stash, () => '')
      const f = await $.prompt.fill({ text, mode: 'replace' })
      log($, `restored draft "${text}" on close of ${e.id} fill=${JSON.stringify(f)}`)
    }
    return r
  })

  // Experiment 4: every focus move, with its origin.
  on('ui.focus', async ($, e, next) => {
    if (!e.requestId.startsWith('spx') && e.component !== 'AbovePrompt') return next(e)
    const r = await next(e)
    const line = `${e.requestId} → ${e.element ?? '(engine stop)'} by ${e.origin.kind}`
    log($, `focus ${line} ${JSON.stringify(r)}`)
    await update($, focusLog, list => [...list, line].slice(-6))
    return r
  })

  // Experiment 1 (band): open from a band Button press.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        {await next(e)}
        <Button
          key="spx-open"
          plain
          hotkey="9"
          label="spx band open"
          action="app:cycleDiffBase"
          onPress={async () => {
            // F23 workaround: stash a non-empty draft, empty the box, then open with focus.
            const box = await $.prompt.read()
            if (box.text !== '') {
              await update($, stash, () => box.text)
              const f = await $.prompt.fill({ text: '', mode: 'replace' })
              log($, `stashed draft "${box.text}" fill=${JSON.stringify(f)}`)
            }
            const r = await $.ui.open({ id: 'spxband', title: 'spx band', focus: true, closeOnEscape: true })
            log($, `band open ${JSON.stringify(r)} panes=${JSON.stringify(await $.ui.panes())}`)
          }}
        />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (!e.requestId.startsWith('spx')) return next(e)
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const want = await read($, pendingFocus)
    if (want === e.requestId) {
      // Experiment 1b: focus on first render. A render hook can't write state, so clear it from a timer.
      $.clock.after(0, async () => {
        await update($, pendingFocus, () => '')
        const r = await $.ui.focus({ requestId: e.requestId, key: 'q' }).catch(err => ({ deny: String(err) }))
        log($, `b focus-on-render ${JSON.stringify(r)}`)
      })
    }
    const lines = await read($, focusLog)
    return (
      <Box flexDirection="column">
        <Input key="q" autoFocus label="search" placeholder="type" onSubmit={() => log($, 'q submit')} />
        <Text>
          {e.requestId} · focused={String(e.props.isFocused)} · {e.props.placement} · {e.props.bodyColumns} cols
        </Text>
        <Button key="row0" plain hotkey="j" label="row 0" onPress={() => log($, 'press row0')} />
        <Button key="row1" plain hotkey="k" label="row 1" onPress={() => log($, 'press row1')} />
        {CANDIDATES.map((action, i) => (
          <Button
            key={`act${i}`}
            plain
            action={action}
            label={`borrow ${action}`}
            onPress={() => log($, `action ${action} pressed`)}
          />
        ))}
        {lines.map(line => (
          <Text dimColor>{line}</Text>
        ))}
      </Box>
    )
  })
}
