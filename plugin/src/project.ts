// Project identity: a key that's the same on every machine (the normalized git remote), with the
// local path as a fallback for directories that aren't repos or have no remote.

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
