import type { EngineInterface, Register } from 'claude-code'

// Probe: can a Client take the keys without a click?
// Variants (/spc <v>): only | focuscall | mixed | mixedcall | mixedredirect | band | tall.
// Results go to the debug log as "SPC ...".
const log = ($: EngineInterface, text: string) => $.ui.log(`SPC ${text}`, { to: 'debug' })
let variant = ''

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'spc', description: 'Client focus probe' })
    return next(e)
  })

  on('command.run', { command: 'spc' }, async ($, e) => {
    variant = (e.args ?? '').trim()
    log($, `variant ${variant}`)
    if (variant === 'band') return { text: 'band drawn' }
    const r = await $.ui.open({ id: 'spc', title: `spc ${variant}`, focus: true, closeOnEscape: true, rows: 12 })
    log($, `open ${JSON.stringify(r)}`)
    if (variant.includes('call')) {
      const f = await $.ui.focus({ requestId: 'spc', key: 'ed' })
      log($, `focus(ed) ${JSON.stringify(f)}`)
    }
    return { text: `spc ${variant}` }
  })

  on('ui.message', async ($, e) => {
    log($, `msg ${e.component} ${e.element} ${JSON.stringify(e.data)}`)
    return {}
  })

  on('ui.focus', async ($, e, next) => {
    log($, `ui.focus ${JSON.stringify(e)}`)
    if (variant.includes('redirect') && e.element !== 'ed') {
      const r = await next({ ...e, element: 'ed' })
      log($, `redirect -> ${JSON.stringify(r)}`)
      return r
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: 'spc' }, async ($, e) => {
    const { Box, Text, Client, Input } = $.ui.resolve(e) as any
    return (
      <Box flexDirection="column">
        <Text>variant: {variant}</Text>
        {variant.startsWith('mixed') && <Input key="inp" label="input" autoFocus onInput={() => {}} onSubmit={() => {}} />}
        {variant === 'tall' && (
          <Box flexDirection="column" width="100%" height={6} borderStyle="single">
            <Input key="tall" autoFocus onInput={() => {}} onSubmit={() => {}} />
          </Box>
        )}
        {variant !== 'tall' && <Client key="ed" module="./probe.tsx" props={{ label: variant }} width={60} height={4} />}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (variant !== 'band') return next(e)
    const { Box, Client } = $.ui.resolve(e) as any
    return (
      <Box>
        <Client key="ed" module="./probe.tsx" props={{ label: 'band' }} width={60} height={4} />
      </Box>
    )
  })
}
