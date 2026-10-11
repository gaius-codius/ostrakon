// The engine's fs and process ops answered from a MemDir, for hook tests: the same semantics as
// memIO, reached through the real StoreIO in hooks/register.tsx.

import type { On } from 'claude-code'

import { MemDir, memIO } from './memdir'

const ran = (exitCode: number, stdout = '', stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

export const engineOver = (on: On, dir: MemDir) => {
  const io = memIO(dir)
  on('fs.exists', async ($, e) => ({ value: await io.exists(e.path) }))
  on('fs.read', ($, e) => {
    const text = dir.get(e.path)
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('fs.write', async ($, e) => {
    await dir.writeGate
    await dir.holdWrite?.(e.path)
    if (dir.failWrites) return { deny: 'EROFS: read-only file system' }
    dir.put(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => ({
    value: dir
      .names(e.path)
      .filter(name => !name.includes('/'))
      .map(name => ({ name, kind: 'file', size: dir.get(`${e.path}/${name}`)?.length ?? 0, mtimeMs: dir.files.get(`${e.path}/${name}`)?.mtimeMs ?? 0, isLink: false })),
  }))
  on('fs.stat', async ($, e) => {
    try {
      const stat = await io.stat(e.path)
      return { value: { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, isLink: false } }
    } catch {
      return { deny: 'ENOENT' }
    }
  })
  on('process.run', async ($, e) => {
    const [command = '', ...args] = e.argv
    const last = args[args.length - 1] ?? ''
    switch (command) {
      case 'mv': {
        if (dir.failMovesTo.has(last)) return ran(1, '', `mv: cannot move '${args[1]}' to '${last}': Read-only file system`)
        const moved = await io.move(args[1] ?? '', args[2] ?? '')
        return ran(moved.exitCode, '', moved.stderr)
      }
      case 'mkdir':
        return ran(args[0] === '-p' || (await io.mkdir(last)) ? 0 : 1)
      case 'rmdir':
        return ran((await io.rmdir(last)) ? 0 : 1)
      case 'rm':
        await io.remove(last)
        return ran(0)
      case 'sh':
        return ran(0, '4242\n')
      case 'uname':
        return ran(0, 'office\n')
      case 'ps': {
        const state = await io.processState(Number(last))
        return state?.isRunning ? ran(0, `${state.started}\n`) : ran(1)
      }
      default:
        return ran(127, '', `${command}: not mocked`)
    }
  })
}
