import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseNote, serializeNote } from '../src/frontmatter'
import { engineOver } from './engine'
import { MemDir } from './memdir'

// The prefix of this plugin's tools; tools/check.sh fails when plugin.json names another plugin.
export const TOOL_PREFIX = 'mcp__ostrakon__'

export const PANE = {
  component: 'Pane',
  requestId: 'ostrakon',
  props: {
    title: 'ostrakon',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 37 },
    view: {},
  },
} as const

export const CC = { key: 'github.com/me/cc', name: 'cc', path: '/home/me/Work/cc' }
export const INFRA = { key: 'github.com/me/infra', name: 'infra', path: '/home/me/code/infra' }

export const NOTE = {
  status: 'open',
  by: 'you',
  origin: 'office',
  context: {},
  sentAt: null,
  deleted: false,
  extra: [] as string[],
} as const

// Ids in time order; `minutes` ago from the mocked clock's start.
export const put = (dir: MemDir, id: string, text: string, project: typeof CC | null, minutes: number) => {
  const stamp = new Date(Date.parse('2026-10-09T12:00:00.000Z') - minutes * 60_000).toISOString()
  dir.put(`/data/notes/${id}.md`, serializeNote({ ...NOTE, id, text, project, created: stamp, updated: stamp }))
}

export type World = { box: { text: string }; toasts: string[]; submitted: string[]; opened: number; closed: number; focused: string[]; tools: { name: string; description: string; isDeferred?: unknown; registeredAs: string }[]; drop?: string; turnOnSubmit?: string; heldCompletion?: { turnId: string; gate: Promise<void>; isHeld?: boolean } }

export const startSession = async ($: Engine, on: On, dir: MemDir, draft = '') => {
  const engine = $
  const world: World = { box: { text: draft }, toasts: [], submitted: [], opened: 0, closed: 0, focused: [], tools: [] }
  const clock = mock.clock(on, { now: Date.parse('2026-10-09T12:00:00.000Z') })
  mock.env(on, { OSTRAKON_DIR: '/data', HOME: '/home/me' })
  mock.store(on)
  engineOver(on, dir)
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  // The engine names a plugin's tool mcp__<plugin>__<name>, with the name in plugin.json (the kit
  // loads no JSON, so tools/check.sh checks this prefix against it). The name it gave is kept, so
  // tests call the tool by it and a pattern that doesn't match it fails.
  on('tool.register', ($, e) => {
    const tool = `${TOOL_PREFIX}${e.name}`
    world.tools.push({ ...e, registeredAs: tool })
    return { value: { tool } }
  })
  on('session.repo', () => ({ value: { root: '/home/me/Work/cc', remote: 'git@github.com:me/cc.git', name: 'cc', internal: false } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.version', () => ({ value: { version: '2.1.294', base: '2.1.294' } }))
  on('session.root', () => ({ value: '/home/me/Work/cc' }))
  on('prompt.read', () => ({ value: { text: world.box.text, cursor: world.box.text.length } }))
  on('prompt.fill', ($, e) => {
    world.box.text = e.text
    return { isFilled: true }
  })
  on('prompt.submit', async (_, e) => {
    world.submitted.push(e.text)
    // The engine starts the turn inside the submit, before the mod's submit hook returns.
    if (world.turnOnSubmit !== undefined) await engine.turn.start({ text: e.text, turnId: world.turnOnSubmit })
    return world.drop !== undefined ? { drop: world.drop } : { text: e.text }
  })
  on('ui.open', () => {
    world.opened += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    world.closed += 1
    return { value: undefined }
  })
  on('ui.focus', ($, e) => {
    if (e.element) world.focused.push(e.element)
    return {}
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  // A completion the test holds in the engine (beneath the mod's next) until its gate opens.
  on('turn.complete', async (_, e) => {
    const held = world.heldCompletion
    if (held?.turnId === e.turnId) {
      held.isHeld = true
      await held.gate
    }
    return { text: e.answer }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  const started = $.session.start({ cwd: '/home/me/Work/cc', surface: 'terminal', isInteractive: true })
  await clock.advance(100)
  await started
  return { world, clock }
}

export const run = ($: Engine, command: string, args: string) =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })

export const mountPane = ($: Engine) => $.ui.mount({ plugin: 'ostrakon', surface: 'terminal', ...PANE })

export const texts = async (ui: Awaited<ReturnType<typeof mountPane>>) => (await ui.findAll({ type: 'Text' })).map((found: { text?: unknown }) => String(found.text ?? ''))

export const noteIn = (dir: MemDir, id: string) => parseNote(dir.get(`/data/notes/${id}.md`) ?? '')

