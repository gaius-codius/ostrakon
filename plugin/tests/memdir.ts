// An in-memory directory tree and a StoreIO over it, for store tests. Several StoreIOs can share
// one MemDir: that's several sessions (or machines on a synced folder) writing the same notes.

import type { Note, NoteProblem } from '../types'
import type { StoreIO } from '../src/store'

export type MemFile = { text: string; mtimeMs: number }

export class MemDir {
  files = new Map<string, MemFile>()
  dirs = new Map<string, number>() // lock directories → creation time
  running = new Map<number, string>([[4242, 'boot']]) // running process ids → start time
  unknowable = new Set<number>() // pids whose state can't be looked up
  warnings: string[] = []
  writeGate: Promise<void> | undefined // fs.write waits for it: a slow disk
  failWrites = false // fs.write refuses (a full disk, a read-only mount)
  holdWrite: ((path: string) => Promise<void> | undefined) | undefined // fs.write waits for what it returns: one slow file
  failMovesTo = new Set<string>() // mv onto these exits 1, leaving the source (a mount gone read-only)
  clock = 1_760_000_000_000

  tick() {
    this.clock += 1000
    return this.clock
  }

  put(path: string, text: string, mtimeMs = this.tick()) {
    this.files.set(path, { text, mtimeMs })
  }

  get(path: string) {
    return this.files.get(path)?.text
  }

  names(dir: string) {
    return [...this.files.keys()].filter(path => path.startsWith(`${dir}/`)).map(path => path.slice(dir.length + 1))
  }
}

export type MemIO = StoreIO & { view: Record<string, Note>; problems: NoteProblem[]; publishes: number }

export const memIO = (dir: MemDir, options: { root?: string; host?: string; pid?: number } = {}): MemIO => {
  const io: MemIO = {
    view: {},
    problems: [],
    publishes: 0,
    env: { dir: options.root ?? '/data/ostrakon', home: '/home/me' },
    read: async path => {
      const file = dir.files.get(path)
      if (!file) throw new Error(`ENOENT: ${path}`)
      return file.text
    },
    write: async (path, text) => {
      if (dir.failWrites) throw new Error('EROFS: read-only file system')
      dir.put(path, text)
    },
    list: async path => {
      // Like the engine's $.fs.list: a folder that doesn't exist is an error, not an empty list.
      if (dir.names(path).length === 0 && !dir.dirs.has(path)) throw new Error(`ENOENT: scandir '${path}'`)
      return dir
        .names(path)
        .filter(name => !name.includes('/'))
        .map(name => {
          const file = dir.files.get(`${path}/${name}`)
          return { name, kind: 'file', size: file?.text.length ?? 0, mtimeMs: file?.mtimeMs ?? 0 }
        })
    },
    exists: async path => dir.files.has(path) || dir.dirs.has(path) || dir.names(path).length > 0,
    stat: async path => {
      const made = dir.dirs.get(path)
      if (made !== undefined) return { size: 0, mtimeMs: made }
      const file = dir.files.get(path)
      if (!file) throw new Error(`ENOENT: ${path}`)
      return { size: file.text.length, mtimeMs: file.mtimeMs }
    },
    move: async (from, to) => {
      const made = dir.dirs.get(from)
      if (made !== undefined) {
        if (dir.dirs.has(to)) return { exitCode: 1, stderr: 'exists' }
        dir.dirs.delete(from)
        dir.dirs.set(to, made)
        for (const name of dir.names(from)) {
          const inner = dir.files.get(`${from}/${name}`)
          dir.files.delete(`${from}/${name}`)
          if (inner) dir.files.set(`${to}/${name}`, inner)
        }
        return { exitCode: 0, stderr: '' }
      }
      const file = dir.files.get(from)
      if (!file) return { exitCode: 1, stderr: `mv: cannot stat '${from}'` }
      dir.files.delete(from)
      dir.files.set(to, file)
      return { exitCode: 0, stderr: '' }
    },
    place: async (from, to) => {
      const file = dir.files.get(from)
      if (!file || dir.files.has(to)) return false
      dir.files.delete(from)
      dir.files.set(to, file)
      return true
    },
    mkdir: async path => {
      if (dir.dirs.has(path)) return false
      dir.dirs.set(path, dir.clock)
      return true
    },
    rmdir: async path => {
      if (dir.names(path).length > 0) return false
      return dir.dirs.delete(path)
    },
    remove: async path => dir.files.delete(path),
    mkdirs: async () => true,
    processId: async () => options.pid ?? 4242,
    processState: async pid => {
      if (dir.unknowable.has(pid)) return undefined
      const started = dir.running.get(pid)
      return started === undefined ? { isRunning: false } : { isRunning: true, started }
    },
    warn: text => {
      dir.warnings.push(text)
    },
    hostname: async () => options.host ?? 'office',
    now: async () => dir.clock,
    sleep: async () => {},
    shown: async () => ({ notes: io.view, problems: io.problems }),
    publish: async (notes, problems) => {
      io.view = notes
      io.problems = problems
      io.publishes += 1
    },
  }
  return io
}
