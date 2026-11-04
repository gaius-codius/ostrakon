// The update notice (SPEC §4.6): a dim footer line when a newer release is out, or when the code on
// disk is newer than the code this session loaded. Pure: register.tsx runs git and reads the files.
// Releases are git tags `vX.Y.Z`, as update.sh finds them, so the notice offers what update installs.

// How often the machine asks the remote, at most; sessions share the answer through the cache file.
export const UPDATE_CHECK_MS = 24 * 60 * 60 * 1000
// How often a session looks at the cache and the files on disk (no network).
export const UPDATE_LOOK_MS = 60 * 60 * 1000

export type Version = [number, number, number]

export const versionOf = (text: unknown): Version | undefined => {
  if (typeof text !== 'string') return undefined
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

export const isNewer = (a: Version, b: Version) => (a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2])

export const shown = (v: Version) => v.join('.')

// The newest release among `git ls-remote --tags --refs` lines (`<sha>\trefs/tags/v0.9.0`).
// Other tags and pre-releases are skipped.
export const newestTag = (lsRemote: string): Version | undefined => {
  let newest: Version | undefined
  for (const line of lsRemote.split('\n')) {
    const version = versionOf(/\trefs\/tags\/(v\d+\.\d+\.\d+)$/.exec(line.trim())?.[1])
    if (version && (!newest || isNewer(version, newest))) newest = version
  }
  return newest
}

// The cache file at ~/.cache/ostrakon/update.json, shared by every session on the machine.
export type UpdateCache = { checkedAt: number; newest: string }

export const cacheOf = (text: string | undefined): UpdateCache | undefined => {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as { checkedAt?: unknown; newest?: unknown }
    if (typeof value.checkedAt !== 'number' || typeof value.newest !== 'string') return undefined
    return { checkedAt: value.checkedAt, newest: value.newest }
  } catch {
    return undefined
  }
}

// A clock set back (a cache from the future) counts as stale, so it can't silence the check.
export const isStale = (cache: UpdateCache | undefined, now: number) => !cache || now < cache.checkedAt || now - cache.checkedAt >= UPDATE_CHECK_MS

// Restarting comes first: `ostrakon update` already ran, and only a restart picks it up.
export const noticeOf = (running: Version | undefined, onDisk: Version | undefined, newest: Version | undefined) => {
  if (!running) return ''
  if (onDisk && isNewer(onDisk, running)) return `restart to use ${shown(onDisk)}`
  if (newest && isNewer(newest, running)) return `${shown(newest)} out · ostrakon update`
  return ''
}

// Only a checkout the install script loads gets the notice: a marketplace install updates through
// Claude Code, from its plugins folder.
export const isMarketplaceRoot = (root: string) => /\/plugins\/(cache|marketplaces)\//.test(root)
