import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const offset = atom({ plugin: 'spx0', key: 'offset' } as const, 0)
const ROWS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']
const WINDOW = 2

// P2 step 0. Questions:
//  1. Do Buttons inside a display:'none' Box fire their hotkeys (letters, digits) and actions?
//  2. Do Tab and the arrows skip them?
//  3. Does focus landing on a "↓ more" sentinel Button report via ui.focus, so the mod can page?
const log = ($: EngineInterface, text: string) => $.ui.log(`SPX0 ${text}`, { to: 'debug' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spx0', description: 'step 0 pane', immediate: true })
    return next(e)
  })

  on('command.run', { command: 'spx0' }, async $ => {
    await update($, offset, () => 0)
    const r = await $.ui.open({ id: 'spx0', title: 'spx0', focus: true, closeOnEscape: true })
    log($, `open ${JSON.stringify(r)}`)
    return { text: '' }
  })

  on('ui.focus', async ($, e, next) => {
    log($, `focus ${JSON.stringify({ element: e.element, origin: e.origin })}`)
    if (e.requestId !== 'spx0' || e.origin.kind !== 'person') return next(e)
    // Hidden action layer: never a stop. Wrap to the search field.
    if (e.element?.startsWith('h')) {
      const r = await next({ ...e, element: 'q' })
      log($, `redirect hidden -> q ${JSON.stringify(r)}`)
      return r
    }
    // Edge sentinel: page down one row, then focus the new last row.
    if (e.element === 'more') {
      const at = (await read($, offset)) + 1
      await update($, offset, () => at)
      const r = await next({ ...e, element: `slot-${WINDOW - 1}` })
      log($, `page -> slot-${WINDOW - 1} at ${at} ${JSON.stringify(r)}`)
      return r
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'spx0' }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    const press = (what: string) => () => log($, `pressed ${what}`)
    const at = await read($, offset)
    return (
      <Box flexDirection="column">
        <Input key="q" placeholder="search" submitLabel="to list" autoFocus onInput={() => undefined} onSubmit={press('submit')} />
        {ROWS.slice(at, at + WINDOW).map((name, i) => (
          <Box key={`box-${name}`} backgroundColor={i === 1 ? "subtle" : undefined}>
            <Button key={`slot-${i}`} plain label=" " onPress={press(name)} />
            <Text color="claude" bold>
              {String(i + 1)}
            </Text>
            <Text> {name}</Text>
          </Box>
        ))}
        {at + WINDOW < ROWS.length && <Button key="more" plain dimColor label="↓" onPress={press('more')} />}
        <Box display="none">
          <Button key="hv" plain hotkey="v" label="pick" onPress={press('hidden v')} />
          
          <Button key="hl" plain action="app:toggleReplTab" label="list" onPress={press('hidden action')} />
        </Box>
        <Box gap={2}>
          <Button key="fs" plain hotkey="s" label="send" onPress={press('visible s')} />
        </Box>
      </Box>
    )
  })
}
