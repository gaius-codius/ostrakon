import type { Note, NoteProject } from '../types'

// Project identity: a key that's the same on every machine (the normalized git remote), with the
// local path as a fallback for directories that aren't repos or have no remote. A worktree is its
// main checkout's project: the engine's repo root is the main working tree's.

// git@github.com:example/cc.git, ssh://git@github.com:22/example/cc, https://user@github.com/example/cc.git
// all become github.com/example/cc.
export const normalizeRemote = (remote: string) => {
  let text = remote.trim()
  const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(text)
  if (scp && !/^[a-z][\w+.-]*:\/\//i.test(text)) text = `${scp[1]}/${scp[2]}`
  else text = text.replace(/^[a-z][\w+.-]*:\/\//i, '').replace(/^[^@/]+@/, '')
  const [host = '', ...path] = text.split('/')
  const cleanHost = host.replace(/:\d+$/, '').toLowerCase()
  const cleanPath = path
    .join('/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  return cleanPath === '' ? cleanHost : `${cleanHost}/${cleanPath}`
}

export const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() || path

// The key of a folder with no remote: its path on this machine.
export const folderKey = (path: string) => `path:${path}`

// A folder that gained a remote: the notes it kept under its path, which join the remote's project
// so it isn't two projects (SPEC §6). Deleted ones stay as they are.
export const folderNotes = (all: Note[], project: NoteProject) => {
  const key = folderKey(project.path)
  return project.key === key ? [] : all.filter(note => !note.deleted && note.project?.key === key)
}
