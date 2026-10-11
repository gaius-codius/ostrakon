// The hub adapter (SPEC §9.4): HTTP to the Tailscale service in server/hub.ts.

import type { Note } from '../../types'
import type { SyncAdapter } from './core'
import { SyncRefused, checked } from './core'

export type Fetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; text: string }>

export const hubAdapter = (fetch: Fetch, hubUrl: string, token: string): SyncAdapter => {
  const base = hubUrl.replace(/\/+$/, '')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

  const call = async (path: string, init: { method?: string; body?: string } = {}) => {
    const response = await fetch(`${base}${path}`, { ...init, headers })
    if (response.status === 401) throw new SyncRefused('hub refused the token')
    // A 4xx is the hub's answer, not a network problem: say what it said.
    if (response.status >= 400 && response.status < 500) {
      let reason = `${response.status}`
      try {
        reason = String((JSON.parse(response.text) as { error?: unknown }).error ?? reason)
      } catch {}
      throw new SyncRefused(`hub refused: ${reason}`.slice(0, 80))
    }
    if (!response.ok) throw new Error(`hub answered ${response.status}`)
    return JSON.parse(response.text) as unknown
  }

  const notesOf = (value: unknown) => (Array.isArray(value) ? value.map(checked).filter((note): note is Note => note !== undefined) : [])

  return {
    name: 'hub',
    pull: async (cursor, waitS) => {
      const body = (await call(`/api/changes?since=${encodeURIComponent(cursor ?? '0')}&wait=${waitS}`)) as { notes?: unknown; cursor?: unknown; hub?: unknown }
      return { notes: notesOf(body.notes), cursor: String(body.cursor ?? cursor ?? '0'), ...(typeof body.hub === 'string' ? { hub: body.hub } : {}) }
    },
    push: async notes => {
      const body = (await call('/api/notes', { method: 'POST', body: JSON.stringify({ notes }) })) as { notes?: unknown; hub?: unknown }
      return { notes: notesOf(body.notes), ...(typeof body.hub === 'string' ? { hub: body.hub } : {}) }
    },
  }
}
