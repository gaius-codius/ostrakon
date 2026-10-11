'use strict'
// The ostrakon phone form (SPEC §9.3): capture first, then the inbox. Everything the phone
// changes goes through an outbox in localStorage, so a save never waits for the network.

const $ = id => document.getElementById(id)
const load = (key, fallback) => {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : JSON.parse(value)
  } catch {
    return fallback
  }
}
// False when the phone wouldn't keep it (storage full, or blocked in a private window).
const store = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

// The hub's copy of the notes, the cursor they're current to, and which run of the hub that was,
// under one key: a cursor is never kept without the notes it describes.
const synced = load('sp.sync', null)
let hubId = synced?.hub ?? null
let cursor = synced?.cursor ?? 0
let notes = synced?.notes ?? {} // id → the hub's copy
const saveSync = () => store('sp.sync', { hub: hubId, cursor, notes })

let token = load('sp.token', '')
let outbox = load('sp.outbox', []) // notes not yet accepted by the hub, one per id
let refused = load('sp.refused', []) // { id, text, reason, note }: notes the hub wouldn't take (older entries have no note)
let projects = load('sp.projects', [])
// Set when the outbox couldn't be written: nothing is queued until it can be.
let storageError = ''
let online = null
let flushing = false
let retryMs = 1000
let retryTimer = 0
let pollGen = 0
let pollAbort = null
let editing = null // { id, draft }
// While a finger is on a row, or a row is being edited, the list isn't redrawn under it; a sync that
// arrives meanwhile is drawn when it ends.
let isTouching = false
let isStale = false
let toastTimer = 0
let toastUndo = null
let sheetFor = null // the note the action sheet is open for
// Folded groups, by project key ('' for unfiled); kept on the phone across opens.
let folded = new Set(load('sp.folded', []))

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const ulid = () => {
  let time = Date.now()
  let id = ''
  for (let i = 0; i < 10; i++) {
    id = B32[time % 32] + id
    time = Math.floor(time / 32)
  }
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) id += B32[byte % 32]
  return id
}

// Never earlier than the stamp it replaces, so the phone's change wins over the copy it changed.
const stamp = previous => new Date(Math.max(Date.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString()
// The mod's merge order (plugin/src/merge.ts compareNotes) as far as the origin: later `updated`,
// then the more final status, then the higher origin. Its last step compares the files as written,
// which only the hub can do; so on a tie that far the hub's copy wins, being the hub's answer.
const FINALITY = { proposed: 0, open: 1, dismissed: 2, sent: 3, archived: 4 }
const finality = note => (note.deleted ? 10 : 0) + (FINALITY[note.status] ?? 0)
const time = iso => {
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : ms
}
const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const compareNotes = (a, b) => time(a.updated) - time(b.updated) || finality(a) - finality(b) || order(a.origin, b.origin)
// `local` is this phone's copy (cached or queued), `hub` the hub's: the hub's wins unless the
// phone's is strictly ahead.
const winner = (local, hub) => (!local ? hub : !hub ? local : compareNotes(local, hub) > 0 ? local : hub)
// A send's answer can land after a pull that's already newer (same tie, a later cursor): it only
// fills a gap or wins outright, never on a tie; the pull feed repairs anything it leaves stale.
const acked = (cached, ack) => (cached && compareNotes(ack, cached) <= 0 ? cached : ack)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// What the phone shows: the hub's copy, or a queued change to it when that's newer.
const current = () => {
  const merged = { ...notes }
  for (const note of outbox) merged[note.id] = winner(note, notes[note.id])
  return merged
}

const ageOf = iso => {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return days < 7 ? `${days}d` : days < 365 ? `${Math.floor(days / 7)}w` : `${Math.floor(days / 365)}y`
}

class Unauthorized extends Error {}
// The hub understood the request and said no (4xx): sending it again won't help.
class Refused extends Error {}

// Every call gives up after `timeoutMs`: a hub host that accepts and never answers counts as offline
// rather than leaving a send in flight forever.
const api = async (path, init = {}, timeoutMs = 15000) => {
  const controller = new AbortController()
  let isTimedOut = false
  const timer = setTimeout(() => {
    isTimedOut = true
    controller.abort()
  }, timeoutMs)
  const outer = init.signal
  if (outer) outer.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    return await request(path, { ...init, signal: controller.signal })
  } catch (error) {
    throw isTimedOut ? new Error('hub timed out') : error
  } finally {
    clearTimeout(timer)
  }
}

const request = async (path, init) => {
  const response = await fetch(path, {
    ...init,
    cache: 'no-store',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  })
  if (response.status === 401) {
    showLogin(true)
    throw new Unauthorized()
  }
  if (response.status >= 400 && response.status < 500) {
    const body = await response.json().catch(() => ({}))
    throw new Refused(body.error || `hub answered ${response.status}`)
  }
  if (!response.ok) throw new Error(`hub answered ${response.status}`)
  return response.json()
}

// ---- sync ----

// Queues a change for the hub. False, queueing nothing, when the phone can't keep the outbox: the
// caller keeps what the person typed.
const queue = note => {
  const next = outbox.filter(queued => queued.id !== note.id).concat(note)
  if (!store('sp.outbox', next)) {
    storageError = "Can't save on this phone (storage full or blocked); nothing was queued"
    renderStatus()
    return false
  }
  storageError = ''
  outbox = next
  render()
  flush()
  return true
}

// Dropping sent notes from the outbox. Kept in memory even if the write fails; the hub merges a
// resend.
const unqueue = sent => {
  if (sent.length === 0) return
  outbox = outbox.filter(note => !sent.includes(note))
  store('sp.outbox', outbox)
}

// Refused notes the phone couldn't write to the refused list yet (note → reason). They stay in the
// outbox, the only stored copy, and aren't sent again; each flush tries to store them again.
const held = new Map()

// Moves refused notes from the outbox to the refused list, the list written first: a note leaves
// the outbox only once its refusal is stored.
const refuse = entries => {
  if (entries.length === 0) return
  const ids = new Set(entries.map(([note]) => note.id))
  const next = refused.filter(item => !ids.has(item.id)).concat(entries.map(([note, reason]) => ({ id: note.id, text: note.text, reason, note })))
  if (!store('sp.refused', next)) {
    for (const [note, reason] of entries) held.set(note, reason)
    return
  }
  refused = next
  for (const [note] of entries) held.delete(note)
  unqueue(entries.map(([note]) => note))
}

// A different run of the hub (restarted, restored, wiped): its cursor means nothing here, and what
// this phone thinks it holds may be gone. The outbox stays; it's sent again and merged.
const adoptHub = id => {
  if (id === undefined || id === hubId) return false
  const isKnown = hubId !== null || cursor !== 0
  hubId = id
  cursor = 0
  notes = {}
  saveSync()
  return isKnown
}

const setOnline = value => {
  online = value
  renderStatus()
  renderSaved()
}

const BATCH = 200

const sendable = () => outbox.filter(note => !held.has(note))

const flush = async () => {
  if (flushing || token === '') return
  // Edited since (a new copy in the outbox) or dropped: no longer held.
  for (const note of held.keys()) if (!outbox.includes(note)) held.delete(note)
  refuse([...held])
  // Oldest first, at most BATCH per request.
  const batch = sendable().slice(0, BATCH)
  if (batch.length === 0) return render()
  flushing = true
  clearTimeout(retryTimer)
  try {
    const body = await api('/api/notes', { method: 'POST', body: JSON.stringify({ notes: batch }) })
    if (adoptHub(body.hub)) startPoll()
    for (const note of body.notes) notes[note.id] = acked(notes[note.id], note)
    saveSync()
    // A note the hub won't take never gets in: it moves to the refused list, kept until dismissed.
    const reasons = new Map(body.rejected.map(item => [item.id, item.reason]))
    refuse(batch.filter(note => reasons.has(note.id)).map(note => [note, reasons.get(note.id)]))
    unqueue(batch.filter(note => !reasons.has(note.id)))
    retryMs = 1000
    setOnline(true)
  } catch (error) {
    if (error instanceof Unauthorized) return
    if (error instanceof Refused) {
      // The whole request was turned down: keep its notes in the refused list, go on with the rest.
      refuse(batch.map(note => [note, error.message]))
      setOnline(true)
    } else {
      setOnline(false)
      retryTimer = setTimeout(flush, retryMs)
      retryMs = Math.min(retryMs * 2, 30000)
    }
  } finally {
    flushing = false
    render()
  }
  // Changes queued while that batch was in flight.
  if (online && sendable().length > 0) flush()
}

const poll = async gen => {
  let wait = 0
  let backoff = 1000
  while (gen === pollGen) {
    try {
      const controller = new AbortController()
      pollAbort = controller
      const since = cursor
      const body = await api(`/api/changes?since=${since}&wait=${wait}`, { signal: controller.signal }, (wait + 15) * 1000)
      if (gen !== pollGen) return
      // A new run of the hub: start over from nothing, unless this pull already did.
      if (adoptHub(body.hub) && since !== 0) {
        wait = 0
        render()
        continue
      }
      for (const note of body.notes) notes[note.id] = winner(notes[note.id], note)
      cursor = body.cursor
      saveSync()
      setOnline(true)
      backoff = 1000
      wait = 25
      if (body.notes.some(note => note.project && !projects.some(known => known.key === note.project.key))) loadProjects()
      render()
      if (outbox.length > 0) flush()
    } catch (error) {
      if (gen !== pollGen || error.name === 'AbortError' || error instanceof Unauthorized) return
      setOnline(false)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

const startPoll = () => {
  if (token === '') return
  pollGen += 1
  if (pollAbort) pollAbort.abort()
  poll(pollGen)
}

const loadProjects = async () => {
  try {
    const body = await api('/api/projects')
    projects = body.projects.map(({ key, name, path }) => ({ key, name, path }))
    store('sp.projects', projects)
    renderCapture()
    renderPickerList()
  } catch {}
}

// ---- drawing ----

const renderStatus = () => {
  // The header says nothing while sync works, as the pane's footer does (SPEC §9.4).
  const status = $('status')
  const count = outbox.length
  const text = online === false ? ['hub offline', count > 0 ? `${count} queued` : ''].filter(Boolean).join(' · ') : ''
  const problem =
    storageError ||
    (held.size > 0 ? `Can't save on this phone (storage full or blocked); ${held.size} refused note${held.size === 1 ? '' : 's'} kept in the queue` : '')
  const ring = make('span', 'ring')
  ring.setAttribute('aria-hidden', 'true')
  status.replaceChildren(...(problem === '' && text === '' ? [] : [ring, [problem, text].filter(Boolean).join(' · ')]))
  status.classList.toggle('warn', text !== '' && problem === '')
  status.classList.toggle('error', problem !== '')
}

// An element with a class and children (text or elements).
const make = (tag, className, ...children) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  node.append(...children)
  return node
}
const button = (label, onClick, className = '') => {
  const node = make('button', className, label)
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

// False, never a throw, when nothing was copied: the clipboard API, else the old way.
const copy = async text => {
  try {
    if (navigator.clipboard?.writeText) return await navigator.clipboard.writeText(text).then(() => true)
    const field = document.createElement('textarea')
    field.value = text
    document.body.append(field)
    try {
      field.select()
      return document.execCommand('copy')
    } finally {
      field.remove()
    }
  } catch {
    return false
  }
}

// Notes the hub refused: their only copy is here, so they stay until edited and sent again, or
// discarded.
let refusedEditing = null // { id, draft }

// The note to send again: the refused copy, or (an entry from before notes were kept with their
// refusal) a phone note rebuilt from its text.
const refusedNote = item => {
  if (item.note) return item.note
  const now = new Date().toISOString()
  return { id: item.id, status: 'open', by: 'phone', created: now, updated: now, origin: 'iphone', project: null, context: {}, sentAt: null, deleted: false, text: item.text, extra: [] }
}

const setRefused = next => {
  if (!store('sp.refused', next)) return false
  refused = next
  return true
}

// Sends a refused note again, with `text` when it was edited. It leaves the list once it's queued;
// until then an edit stays open, with what was typed.
const retry = (item, text = item.text) => {
  const note = refusedNote(item)
  if (!queue({ ...note, text, updated: stamp(note.updated), origin: 'iphone' })) {
    if (refusedEditing?.id === item.id) $('refused-list').querySelector(`li[data-id="${CSS.escape(item.id)}"] textarea`)?.focus()
    return
  }
  refusedEditing = null
  setRefused(refused.filter(other => other.id !== item.id))
  renderRefused()
}

const discard = item => {
  if (!setRefused(refused.filter(other => other.id !== item.id))) return
  if (refusedEditing?.id === item.id) refusedEditing = null
  renderRefused()
  toast('Discarded', () => {
    if (!refused.some(other => other.id === item.id) && setRefused([...refused, item])) renderRefused()
  })
}

const renderRefused = () => {
  const items = refused.map(item => {
    const isEditing = refusedEditing?.id === item.id
    const reason = make('p', 'reason', item.reason)
    const only = make('p', 'only', 'Only this phone has it.')
    if (isEditing) {
      const field = document.createElement('textarea')
      field.value = refusedEditing.draft
      field.setAttribute('aria-label', 'Edit note')
      field.addEventListener('input', () => (refusedEditing.draft = field.value))
      const save = button('Retry', () => field.value.trim() !== '' && retry(item, field.value.trim()), 'btn')
      const cancel = button('Cancel', () => {
        refusedEditing = null
        renderRefused()
        $('refused-list').querySelector(`li[data-id="${CSS.escape(item.id)}"] .edit`)?.focus()
      }, 'btn quiet')
      const row = make('li', '', field, reason, only, make('div', 'row', save, cancel))
      row.dataset.id = item.id
      return row
    }
    const bar = make('span', 'bar', '▎')
    bar.setAttribute('aria-hidden', 'true')
    const edit = button('Edit', () => {
      refusedEditing = { id: item.id, draft: item.text }
      renderRefused()
      $('refused-list').querySelector('textarea')?.focus()
    }, 'btn edit')
    const again = button('Retry', () => retry(item), 'btn')
    const drop = button('Discard local copy', () => discard(item), 'btn quiet')
    const row = make('li', '', make('p', 'quote', bar, make('span', '', item.text)), reason, only, make('div', 'row', edit, again, drop))
    row.dataset.id = item.id
    return row
  })
  $('refused-title').textContent = `The hub wouldn't take ${items.length === 1 ? '1 note' : `${items.length} notes`}`
  $('refused-list').replaceChildren(...items)
  $('refused').hidden = items.length === 0
}

const labelOf = project => {
  if (!project) return 'unfiled'
  const twins = projects.filter(known => known.name === project.name).length
  return twins > 1 ? project.key.replace(/^path:/, '') : project.name
}

// A project's colour, as the pane picks it (plugin/src/ui/look.ts colourOf, with no current
// project here): the palette's entry from a hash of the project key; unfiled is grey. The names in
// the pane's order; style.css holds each one's colour per theme (tools/check.sh keeps them in step).
const PALETTE = ['teal', 'sky', 'violet', 'magenta', 'pink', 'gold', 'lime', 'sand']
const colourOf = project => {
  if (!project) return 'inactive'
  let hash = 0
  for (const char of project.key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

// The one place a project's colour is painted: a dot in the colour colourOf names (a CSS custom
// property of that name, per theme, in style.css). Unfiled is a ring.
const dot = project => {
  const node = make('span', project ? 'dot' : 'dot ring')
  node.setAttribute('aria-hidden', 'true')
  if (project) node.style.background = `var(--${colourOf(project)})`
  return node
}

// A group's heading: a button that folds it, with what leads it (a dot), its name, a word after the
// name when there is one, and how many notes it holds.
let groupIds = 0
const heading = (key, lead, name, count, isOpen, note, rowsId) => {
  const toggle = button('', () => {
    if (folded.has(key)) folded.delete(key)
    else folded.add(key)
    store('sp.folded', [...folded])
    renderList()
  })
  toggle.setAttribute('aria-expanded', String(isOpen))
  toggle.dataset.focus = `head:${key}`
  toggle.setAttribute('aria-controls', rowsId)
  toggle.append(make('span', 'lead', lead), make('span', 'name', name))
  if (note) toggle.append(make('span', 'folded', note))
  toggle.append(make('span', 'count', String(count), make('span', 'sr-only', count === 1 ? ' note' : ' notes')))
  return make('h2', '', toggle)
}

const renderList = () => {
  if (editing || isTouching) {
    isStale = true
    return
  }
  isStale = false
  // Filtering: what's typed in the search bar, while it's up.
  const typed = mode === 'search' ? $('filter').value.trim() : ''
  const words = typed.toLowerCase()
  const queued = new Set(outbox.map(note => note.id))
  const open = Object.values(current()).filter(note => !note.deleted && note.status === 'open')
  const shown = open
    .filter(note => words === '' || `${note.text} ${labelOf(note.project)}`.toLowerCase().includes(words))
    .sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated) || (a.id < b.id ? 1 : -1))
  // Grouped as the pane's list view (SPEC §4.6): a heading per project, projects by their latest
  // note, unfiled last; within a group newest first.
  const groups = new Map()
  for (const note of shown) {
    const key = note.project?.key ?? ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(note)
  }
  const order = [...groups.keys()].sort((a, b) => (a === '') - (b === ''))
  const sections = []
  // Claude's proposals (harvest, SPEC §8) come first, to keep or dismiss; a search looks at open notes only.
  const proposals = mode === 'search' ? [] : Object.values(current()).filter(note => !note.deleted && note.status === 'proposed').sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated))
  if (proposals.length > 0) {
    const isFolded = folded.has(PROPOSED)
    const rowsId = `rows-${++groupIds}`
    const lead = make('span', 'diamond', '◆')
    lead.setAttribute('aria-hidden', 'true')
    const head = heading(PROPOSED, lead, 'Proposed by Claude', proposals.length, !isFolded, isFolded ? '▸' : '', rowsId)
    const list = make('ul', 'rows')
    list.id = rowsId
    list.hidden = isFolded
    if (!isFolded) list.append(...proposals.map(proposalRow))
    sections.push(make('div', 'group proposed', head, list))
  }
  for (const key of order) {
    const notes = groups.get(key)
    const project = notes[0].project
    // A search shows every group's matches, folded or not, and says so on a folded one.
    const isFolded = folded.has(key)
    const isShut = isFolded && mode !== 'search'
    const rowsId = `rows-${++groupIds}`
    const head = heading(key, dot(project), labelOf(project), notes.length, !isShut, isShut ? '▸' : isFolded ? 'folded · showing matches' : '', rowsId)
    const list = make('ul', 'rows')
    list.id = rowsId
    list.hidden = isShut
    if (!isShut) for (const note of notes) list.append(noteRow(note, queued.has(note.id), words))
    const group = make('div', 'group', head, list)
    group.dataset.key = key
    sections.push(group)
  }
  // Focus stays on the same control (a row's ⋯, a heading) when the list is drawn again.
  const focused = $('list').contains(document.activeElement) ? document.activeElement.dataset.focus : undefined
  $('list').replaceChildren(...sections)
  if (focused) $('list').querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  const isSearch = mode === 'search'
  const count = `${shown.length} note${shown.length === 1 ? '' : 's'} in ${groups.size} project${groups.size === 1 ? '' : 's'}`
  setText($('search-status'), isSearch && shown.length > 0 ? count : '')
  $('no-match').hidden = !(isSearch && shown.length === 0 && words !== '')
  setText($('no-match-title'), `No open notes match “${typed}”`)
  $('empty').hidden = isSearch || shown.length + proposals.length > 0
  $('open-search').hidden = mode !== 'list' || open.length === 0
}

// Sets an element's text only when it changes, so a live region isn't read out again for nothing.
const setText = (node, text) => {
  if (node.textContent !== text) node.textContent = text
}

// A note's text with each place it matches the filter marked.
const marked = (text, words) => {
  if (words === '') return [text]
  const parts = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(words); at >= 0; at = lower.indexOf(words, at + words.length)) {
    parts.push(text.slice(from, at), make('mark', '', text.slice(at, at + words.length)))
    from = at + words.length
  }
  parts.push(text.slice(from))
  return parts
}
const PROPOSED = ':proposed' // the proposals group's fold key; a project key never starts with ':'

// An inline SVG icon from path data, hidden from assistive tech (the button carries the name).
const SVG_NS = 'http://www.w3.org/2000/svg'
const icon = (markup, { size = 18, fill = false, stroke = 1.8 } = {}) => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('fill', fill ? 'currentColor' : 'none')
  if (!fill) {
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', String(stroke))
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
  }
  svg.innerHTML = markup
  return svg
}
const ICONS = {
  more: '<circle cx="5" cy="12" r="1.6"></circle><circle cx="12" cy="12" r="1.6"></circle><circle cx="19" cy="12" r="1.6"></circle>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"></rect><path d="M5 9v10h14V9M10 13h4"></path>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"></path>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"></rect><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"></path>',
  move: '<path d="M4 12h14M13 6l6 6-6 6"></path>',
  sent: '<circle cx="12" cy="12" r="8.5"></circle><path d="m8.5 12.2 2.4 2.4 4.8-5"></path>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"></circle><path d="M15.5 15.5 20 20"></path>',
  clear: '<path d="M6 6l12 12M18 6 6 18"></path>',
  chevron: '<path d="m6 9 6 6 6-6"></path>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"></path>',
}

let textIds = 0

// One open note: its marker (◆ from Claude, ▪ from the phone), the text, its age and a ⋯ button for
// its actions, over the archive strip a swipe uncovers.
const noteRow = (note, isQueued, words = '') => {
  const marker = make('span', `marker ${note.by}`, note.by === 'claude' ? '◆' : note.by === 'phone' ? '▪' : '')
  if (note.by === 'claude') {
    marker.setAttribute('role', 'img')
    marker.setAttribute('aria-label', 'From Claude')
  } else marker.setAttribute('aria-hidden', 'true')
  const text = make('p', 'text', ...marked(note.text, words))
  text.id = `text-${++textIds}`
  // The note just saved says `now` rather than `queued`: the form already says it's waiting to sync.
  const isFresh = note.id === freshId
  const age = isQueued && !isFresh ? make('span', 'age queued', make('span', '', '↑ '), 'queued') : make('span', 'age', ageOf(note.updated))
  const more = button('', event => openSheet(note.id, event.currentTarget), 'more icon-btn')
  more.append(icon(ICONS.more, { fill: true }))
  more.setAttribute('aria-label', 'Note actions')
  more.dataset.focus = `more:${note.id}`
  more.setAttribute('aria-describedby', text.id)
  more.setAttribute('aria-haspopup', 'dialog')
  const face = make('div', 'face', marker, text, age, more)
  const behind = make('div', 'behind', icon(ICONS.archive, { stroke: 2 }), make('span', '', 'Archive'))
  behind.setAttribute('aria-hidden', 'true')
  const row = make('li', `note${note.id === sheetFor ? ' chosen' : ''}${isFresh ? ' fresh' : ''}`, behind, face)
  row.dataset.id = note.id
  gestures(row, face, behind, note.id)
  return row
}

// A proposal from Claude: its text, the project it's for and its age, Keep and Dismiss.
const proposalRow = note => {
  const text = make('p', 'text', note.text)
  text.id = `text-${++textIds}`
  const keep = button('Keep', () => decide(note.id, 'open'), 'btn keep')
  const dismiss = button('Dismiss', () => decide(note.id, 'dismissed'), 'btn dismiss')
  for (const choice of [keep, dismiss]) {
    choice.setAttribute('aria-describedby', text.id)
    choice.dataset.focus = `${choice.textContent}:${note.id}`
  }
  const article = make('article', 'proposal', text, make('p', 'for', 'for ', dot(note.project), `${labelOf(note.project)} · ${ageOf(note.updated)}`), make('div', 'choices', keep, dismiss))
  article.setAttribute('aria-labelledby', text.id)
  const row = make('li', '', article)
  row.dataset.id = note.id
  return row
}

const render = () => {
  renderStatus()
  // A refused note being edited isn't drawn again under the typing.
  if (!refusedEditing) renderRefused()
  renderSaved()
  renderList()
  if (sheetFor !== null) renderSheet()
  renderPickerList()
}

// ---- inbox actions ----

// `detail`: the note it was about, dim after the words.
const toast = (text, undo, detail = '') => {
  clearTimeout(toastTimer)
  $('toast-text').replaceChildren(text, ...(detail ? [make('span', 'detail', ` · ${detail.split('\n')[0]}`)] : []))
  toastUndo = undo
  $('toast-undo').hidden = !undo
  const wasHidden = $('toast').hidden
  $('toast').hidden = false
  if (wasHidden || toastLeaving) motion.toastIn($('toast'))
  toastLeaving = false
  // Said by a live region that's always there; the toast itself comes and goes.
  $('live').textContent = text
  const shown = ++toasts
  toastTimer = setTimeout(() => {
    toastUndo = null
    toastLeaving = true
    motion.toastOut($('toast'), () => {
      // A newer toast took its place meanwhile.
      if (shown !== toasts) return
      toastLeaving = false
      $('toast').hidden = true
      $('toast').style.opacity = ''
    })
  }, 5000)
}
let toasts = 0
let toastLeaving = false

// One change to a note from this phone, queued; false when the note is gone or nothing was queued.
const change = (id, edit) => {
  const note = current()[id]
  return note !== undefined && queue({ ...note, ...edit(note), updated: stamp(note.updated), origin: 'iphone' })
}

// An Undo puts back what a change replaced, but only while the note still shows that change: a
// newer one (from elsewhere, or another action here) is never overwritten.
const undo = (id, isStill, edit) => () => {
  const note = current()[id]
  if (!note || !isStill(note)) return toast('Changed since; not undone')
  change(id, edit)
}

const setStatus = (id, status) => change(id, () => ({ status }))

const archive = id => {
  if (setStatus(id, 'archived')) {
    toast('Archived', undo(id, note => !note.deleted && note.status === 'archived', () => ({ status: 'open' })), current()[id]?.text)
  }
}

// Keep makes a proposal an open note; Dismiss puts it with the dismissed ones. Each comes with Undo.
const decide = (id, status) => {
  const hadFocus = document.activeElement?.dataset.focus?.endsWith(`:${id}`)
  if (!setStatus(id, status)) return
  toast(status === 'open' ? 'Kept' : 'Dismissed', undo(id, note => !note.deleted && note.status === status, () => ({ status: 'proposed' })))
  // Focus follows a kept note to its row, else goes to the next proposal or the first heading.
  if (hadFocus) ((status === 'open' ? moreOf(id) : null) ?? $('list').querySelector('[data-focus^="Keep:"], h2 button'))?.focus({ preventScroll: true })
}

const startEdit = id => {
  const note = current()[id]
  const row = $('list').querySelector(`li.note[data-id="${id}"]`)
  if (!note || !row) return
  editing = { id, draft: note.text }
  row.className = 'note editing'
  const field = document.createElement('textarea')
  field.value = note.text
  field.setAttribute('aria-label', 'Edit note')
  field.addEventListener('input', () => (editing.draft = field.value))
  field.addEventListener('keydown', event => {
    if (event.key === 'Escape') endEdit(false)
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) endEdit(true)
  })
  row.replaceChildren(field, make('div', 'actions', button('Cancel', () => endEdit(false), 'btn'), button('Save', () => endEdit(true), 'primary')))
  field.focus()
  field.setSelectionRange(field.value.length, field.value.length)
}

const endEdit = isSaved => {
  if (!editing) return
  const { id, draft } = editing
  editing = null
  const note = current()[id]
  const text = draft.trim()
  const hadFocus = $('list').querySelector('li.note.editing')?.contains(document.activeElement)
  if (!(isSaved && note && text !== '' && text !== note.text)) render()
  // Not queued: the editor stays open with the draft.
  else if (!queue({ ...note, text, updated: stamp(note.updated), origin: 'iphone' })) return (editing = { id, draft })
  if (hadFocus) moreOf(id)?.focus({ preventScroll: true })
}

const markSent = id => {
  const note = current()[id]
  if (!note) return
  const { sentAt } = note
  const at = new Date().toISOString()
  if (change(id, () => ({ status: 'sent', sentAt: at }))) {
    toast('Marked sent', undo(id, now => !now.deleted && now.status === 'sent' && now.sentAt === at, () => ({ status: 'open', sentAt })), note.text)
  }
}

const moveTo = (id, project) => {
  const note = current()[id]
  if (!note) return
  const was = note.project
  const to = project ? { key: project.key, name: project.name, path: project.path } : null
  const fields = project => (project ? [project.key, project.name, project.path] : null)
  const isMoved = now => !now.deleted && JSON.stringify(fields(now.project)) === JSON.stringify(fields(to))
  if (change(id, () => ({ project: to }))) toast(`Moved to ${labelOf(to)}`, undo(id, isMoved, () => ({ project: was })))
}

// ---- movement ----

// Springs and exits come from Motion (vendor/motion.js); screen changes are View Transitions. With
// reduced motion nothing moves: things appear and go at once, or fade.
const M = window.Motion
const reduced = matchMedia('(prefers-reduced-motion: reduce)')
const isStill = () => reduced.matches || !M

// Starts an animation through Motion, or jumps to the end when it would move something and nothing
// may move (a fade still fades).
const run = (target, keyframes, options) => {
  const isMove = Object.keys(keyframes).some(key => key !== 'opacity')
  if (!M || (reduced.matches && isMove)) {
    for (const [key, frames] of Object.entries(keyframes)) target.style[key] = Array.isArray(frames) ? frames[frames.length - 1] : frames
    return { stop: () => {}, finished: Promise.resolve() }
  }
  const controls = M.animate(target, keyframes, options)
  return { stop: () => controls.stop(), finished: controls.finished ?? Promise.resolve(controls) }
}

// A number from `from` to `to` on a spring (or a tween), each step handed to `onUpdate`.
const tweenValue = (from, to, options, onUpdate) => {
  if (isStill()) {
    onUpdate(to)
    return { stop: () => {}, finished: Promise.resolve() }
  }
  const controls = M.animate(from, to, { ...options, onUpdate })
  return { stop: () => controls.stop(), finished: controls.finished ?? Promise.resolve(controls) }
}

const SPRING = { type: 'spring', visualDuration: 0.32, bounce: 0.12 }

// Sheets and drawers: the panel rises over a fading scrim, and sinks on the way out. A dialog
// opened again while it's still leaving cancels that leaving (its `done` never runs).
const leaving = new WeakMap()
const enter = dialog => {
  leaving.delete(dialog)
  const panel = dialog.querySelector('.panel')
  const scrim = dialog.querySelector('.scrim')
  if (reduced.matches) {
    run(dialog, { opacity: [0, 1] }, { duration: 0.15 })
    return
  }
  dialog.style.opacity = ''
  run(scrim, { opacity: [0, 1] }, { duration: 0.2 })
  run(panel, { transform: ['translateY(100%)', 'translateY(0%)'] }, SPRING)
}
const leave = (dialog, done) => {
  const token = {}
  leaving.set(dialog, token)
  const finish = () => {
    if (leaving.get(dialog) !== token) return
    leaving.delete(dialog)
    dialog.style.opacity = ''
    dialog.querySelector('.panel').style.transform = ''
    dialog.querySelector('.scrim').style.opacity = ''
    done()
  }
  if (!M) return finish()
  if (reduced.matches) return void run(dialog, { opacity: [1, 0] }, { duration: 0.12 }).finished.then(finish, finish)
  run(dialog.querySelector('.scrim'), { opacity: 0 }, { duration: 0.18 })
  run(dialog.querySelector('.panel'), { transform: 'translateY(100%)' }, { duration: 0.2, ease: [0.4, 0, 1, 1] }).finished.then(finish, finish)
}

const motion = {
  sheetIn: enter,
  sheetOut: leave,
  // The search bar and its matches settle in (entering search can't wait for a View Transition:
  // the field must take focus at once for the keyboard to come up).
  searchIn: () => {
    // Not #main, which holds the toast: a transform there would carry the fixed toast with it.
    for (const node of [$('search-bar'), $('search-status'), $('inbox')]) {
      run(node, { opacity: [0, 1], transform: ['translateY(-6px)', 'translateY(0px)'] }, { duration: 0.18, ease: 'easeOut' }).finished.then(() => (node.style.transform = ''))
    }
  },
  toastIn: node => (reduced.matches ? run(node, { opacity: [0, 1] }, { duration: 0.15 }) : run(node, { opacity: [0, 1], transform: ['translateY(12px)', 'translateY(0px)'] }, SPRING)),
  toastOut: (node, done) => run(node, { opacity: 0 }, { duration: 0.15 }).finished.then(done, done),
}

// A change of screen (list, capture, search) as a View Transition where there are any; `update`
// changes the page.
const viewTransition = update => {
  if (reduced.matches || !document.startViewTransition) return update()
  document.startViewTransition(update)
}

// ---- action sheet (⋯, or a long press on a row) ----

// The sheet opens under a finger that's still down. iOS turns that finger's lift into a click where
// it lands, which may be the scrim or an action: the sheet takes a pointer's click only after a
// press that began on it. Keyboard clicks (detail 0) always count.
let isSheetPressed = false
// Where focus was before the sheet took it; it goes back there on close.
let sheetReturn = null
// What the sheet last drew: a sync that changes none of it leaves the buttons alone (one may be
// under a finger mid-press).
let sheetDrawn = ''

// The sheet acts only on an open note: one archived, sent or deleted meanwhile closes it.
const isActionable = note => note !== undefined && !note.deleted && note.status === 'open'

const moreOf = id => $('list').querySelector(`li.note[data-id="${CSS.escape(id)}"] .more`)

// `trigger`: the ⋯ button it opened from, where focus goes back on close (the row's own ⋯ after a
// long press).
const openSheet = (id, trigger = moreOf(id)) => {
  if (sheetFor !== null || !isActionable(current()[id])) return
  sheetFor = id
  isSheetPressed = false
  sheetReturn = trigger ?? document.activeElement
  renderSheet()
  // Still leaving from last time: gone at once.
  if ($('sheet').open) $('sheet').close()
  $('sheet').showModal()
  $('sheet-actions').querySelector('button')?.focus({ preventScroll: true })
  motion.sheetIn($('sheet'))
  renderList()
}

// Focus goes back to the trigger once the sheet has gone (the page is out of reach until then);
// `after`, when given, runs then instead, handed that trigger.
const closeSheet = after => {
  if (sheetFor === null) return
  const id = sheetFor
  const trigger = sheetReturn
  sheetFor = null
  sheetDrawn = ''
  sheetReturn = null
  renderList()
  motion.sheetOut($('sheet'), () => {
    $('sheet').close()
    // The list was drawn again: the same row's ⋯ is a new button.
    const back = trigger?.isConnected ? trigger : trigger?.classList?.contains('more') ? moreOf(id) : null
    if (after) after(back)
    else if (back && back !== document.body) back.focus({ preventScroll: true })
  })
}

// The ⋯ to focus once note `id` leaves the list: the next row's, else the one before.
const neighbourOf = id => {
  const rows = [...$('list').querySelectorAll('li.note')]
  const at = rows.findIndex(row => row.dataset.id === id)
  return (rows[at + 1] ?? rows[at - 1])?.dataset.id ?? null
}

// Runs a sheet action once the sheet is closed, so the list it redraws is the plain one. Focus then
// goes back to the row's ⋯; `then`: 'gone' when the note leaves the list (focus goes to a
// neighbour's ⋯), 'own' when the action puts focus somewhere itself (Edit, in its field).
const act = (run, then = 'back') => () => {
  const id = sheetFor
  const near = then === 'gone' ? neighbourOf(id) : null
  closeSheet(back => {
    run(id)
    if (then === 'own') return
    const target = then === 'gone' ? (near ? moreOf(near) : null) : back
    target?.focus({ preventScroll: true })
  })
}

const sheetAction = (iconName, label, run, { sub = '', aside = '', className = '' } = {}) => {
  const item = button('', run, `action ${className}`)
  const words = sub ? make('span', 'words', label, make('span', 'sub', sub)) : make('span', 'words', label)
  item.append(icon(ICONS[iconName]), words)
  if (aside) item.append(make('span', 'aside', aside))
  item.dataset.key = label
  return item
}

// Redrawn on every sync while open; keyboard focus stays on the same action.
const renderSheet = () => {
  const note = current()[sheetFor]
  if (!isActionable(note)) return closeSheet()
  const drawn = JSON.stringify([note.text, note.project, note.by, ageOf(note.updated)])
  if (drawn === sheetDrawn) return
  sheetDrawn = drawn
  const list = $('sheet-actions')
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
  const by = note.by === 'claude' ? '◆ Claude' : note.by === 'phone' ? '▪ phone' : 'you'
  $('sheet-text').textContent = note.text
  $('sheet-meta').replaceChildren(dot(note.project), `${labelOf(note.project)} · ${by} · ${ageOf(note.updated)}`)
  const items = [
    sheetAction('edit', 'Edit', act(startEdit, 'own')),
    sheetAction('copy', 'Copy text', act(async id => toast((await copy(current()[id]?.text ?? '')) ? 'Copied' : "Couldn't copy"))),
    sheetAction('move', 'Move to project', () => {
      const id = sheetFor
      closeSheet(back => openPicker({ mode: 'move', id, trigger: back }))
    }, { aside: `${labelOf(note.project)} ›` }),
    sheetAction('sent', 'Mark sent', act(markSent, 'gone'), { sub: 'used elsewhere; leaves open notes' }),
    sheetAction('archive', 'Archive', act(archive, 'gone'), { className: 'danger' }),
  ]
  items[2].setAttribute('aria-haspopup', 'dialog')
  list.replaceChildren(...items)
  if (focused !== undefined) (items.find(item => item.dataset.key === focused) ?? items[0]).focus({ preventScroll: true })
}

$('sheet').addEventListener('pointerdown', () => (isSheetPressed = true))
// Nor does that lift move focus off the first action (to the dialog itself).
$('sheet').addEventListener('mousedown', event => isSheetPressed || event.preventDefault(), true)
$('sheet').addEventListener(
  'click',
  event => {
    if (isSheetPressed || event.detail === 0) return
    event.preventDefault()
    event.stopPropagation()
  },
  true,
)
$('sheet-scrim').addEventListener('click', () => closeSheet())
$('sheet-cancel').addEventListener('click', () => closeSheet())
$('sheet').addEventListener('cancel', event => {
  event.preventDefault()
  closeSheet()
})
// Tab and Shift+Tab go round the open dialog's own buttons and fields.
document.addEventListener('keydown', event => {
  const dialog = $('sheet').open ? $('sheet') : $('picker').open ? $('picker') : null
  if (!dialog || event.key !== 'Tab') return
  const stops = [...dialog.querySelectorAll('button, input')].filter(stop => !stop.disabled && stop.getClientRects().length > 0)
  const at = stops.indexOf(document.activeElement)
  event.preventDefault()
  stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus()
})

// Tap edits; swipe left archives, over a strip that says so and firms up while letting go would
// archive. Letting go archives only while the finger is still heading left past ARCHIVE_PX, or on a
// quick flick left; a finger that turned back right springs the row home. Holding still opens the
// action sheet, at once, with the finger still down; what the finger does after that (a small move,
// the lift) is ignored.
const HOLD_MS = 550
const ARCHIVE_PX = 80
const FLICK_PX_PER_MS = 0.5 // 500 px/s
const FLICK_MIN_PX = 24
const TURN_PX = 4 // a move this far sets which way the finger is heading
const VELOCITY_MS = 100 // velocity over the last this many ms

const gestures = (row, face, behind, id) => {
  let start = null // { x, y, pointer }
  let isDragging = false
  let holdTimer = 0
  let dx = 0 // where the face is, px (≤ 0)
  let heading = 0 // -1 left, 1 right
  let turnX = 0 // where the finger was when `heading` was last set
  let samples = [] // { t, x }, the last VELOCITY_MS of the finger
  let frame = 0
  let spring = null
  let isLeaving = false

  // The face follows the finger once a frame, by transform only.
  const paint = () => {
    frame = 0
    face.style.transform = dx === 0 ? '' : `translate3d(${dx}px, 0, 0)`
    row.classList.toggle('armed', dx < -ARCHIVE_PX && heading < 0)
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint)
  }
  const settle = () => {
    cancelAnimationFrame(frame)
    frame = 0
    clearTimeout(holdTimer)
    start = null
    isDragging = false
    samples = []
  }
  // Done with the row: the list may be drawn again.
  const release = () => {
    row.classList.remove('dragging', 'armed')
    face.style.transform = ''
    dx = 0
    isTouching = false
    if (isStale) renderList()
  }
  const velocity = () => {
    const now = performance.now()
    const recent = samples.filter(sample => now - sample.t <= VELOCITY_MS)
    if (recent.length < 2) return 0
    const first = recent[0]
    const last = recent[recent.length - 1]
    return last.t - first.t < 8 ? 0 : (last.x - first.x) / (last.t - first.t)
  }
  // Home again on a spring that starts at the finger's speed.
  const springBack = v => {
    spring = tweenValue(dx, 0, { type: 'spring', stiffness: 520, damping: 42, velocity: v * 1000 }, x => {
      dx = Math.min(0, x)
      face.style.transform = `translate3d(${dx}px, 0, 0)`
    })
    spring.finished.then(() => {
      spring = null
      release()
    })
  }
  // Off to the left, then the row closes up, then the note is archived (with Undo).
  const throwOut = v => {
    row.classList.add('armed')
    if (reduced.matches || !M) {
      release()
      return archive(id)
    }
    isLeaving = true
    const width = row.offsetWidth
    spring = tweenValue(dx, -width, { type: 'spring', bounce: 0, visualDuration: 0.2, velocity: Math.min(v, 0) * 1000 }, x => {
      dx = x
      face.style.transform = `translate3d(${x}px, 0, 0)`
    })
    spring.finished
      .then(() => run(row, { height: [`${row.offsetHeight}px`, '0px'], opacity: [1, 0] }, { duration: 0.2, ease: [0.2, 0, 0, 1] }).finished)
      .then(() => {
        spring = null
        isTouching = false
        archive(id)
        // Not archived after all (storage refused it): the row comes back.
        if (row.isConnected) {
          isLeaving = false
          row.style.height = ''
          row.style.opacity = ''
          release()
        }
      })
  }

  // A right click (or a browser's own long press) opens the sheet too; the hold has usually opened it.
  row.addEventListener('contextmenu', event => {
    event.preventDefault()
    if (!editing && !isDragging) openSheet(id)
  })
  row.addEventListener('pointerdown', event => {
    // The ⋯ button is a plain button: no swipe, hold or tap-to-edit starts on it. One finger at a
    // time: a second one on the row is ignored.
    if (editing || isLeaving || event.button > 0 || start || event.target.closest('.more')) return
    // Caught mid-spring: the row stays where it is, under the finger.
    if (spring) {
      spring.stop()
      spring = null
      isDragging = dx !== 0
    }
    start = { x: event.clientX - dx, y: event.clientY, pointer: event.pointerId }
    samples = [{ t: performance.now(), x: event.clientX }]
    heading = 0
    turnX = event.clientX
    isTouching = true
    if (!isDragging)
      holdTimer = setTimeout(() => {
        settle()
        release()
        navigator.vibrate?.(10)
        openSheet(id)
      }, HOLD_MS)
    // Moves and the lift stay with this row even when the finger (or mouse) leaves it.
    try {
      row.setPointerCapture(event.pointerId)
    } catch {}
  })
  const isOurs = event => start !== null && event.pointerId === start.pointer
  row.addEventListener('pointermove', event => {
    if (!isOurs(event)) return
    const moved = event.clientX - start.x
    const dy = event.clientY - start.y
    // Mostly up or down before any drag: a scroll, not ours.
    if (!isDragging && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(moved)) {
      settle()
      return release()
    }
    const now = performance.now()
    samples.push({ t: now, x: event.clientX })
    while (samples.length > 2 && now - samples[0].t > VELOCITY_MS) samples.shift()
    if (Math.abs(event.clientX - turnX) >= TURN_PX) {
      heading = Math.sign(event.clientX - turnX)
      turnX = event.clientX
    }
    if (!isDragging && Math.abs(moved) > 10) {
      clearTimeout(holdTimer)
      isDragging = true
      row.classList.add('dragging')
    }
    if (isDragging) {
      dx = Math.min(0, moved)
      schedule()
    }
  })
  row.addEventListener('pointerup', event => {
    if (!isOurs(event)) return
    const wasDragging = isDragging
    const v = velocity()
    settle()
    if (!wasDragging) {
      release()
      return startEdit(id)
    }
    const isFlick = v <= -FLICK_PX_PER_MS && dx <= -FLICK_MIN_PX && heading <= 0
    const isPast = dx < -ARCHIVE_PX && heading < 0 && v <= 0.05
    paint()
    if (isFlick || isPast) throwOut(v)
    else springBack(v)
  })
  const cancel = event => {
    if (!isOurs(event)) return
    const wasDragging = isDragging
    settle()
    if (wasDragging && dx !== 0) springBack(0)
    else release()
  }
  row.addEventListener('pointercancel', cancel)
  row.addEventListener('lostpointercapture', cancel)
}

// ---- screens ----

// `notice`: true for a refused token, or the words to show; false for none.
const showLogin = notice => {
  pollGen += 1
  $('app').hidden = true
  $('login').hidden = false
  $('login-error').hidden = !notice
  if (notice) $('login-error').textContent = typeof notice === 'string' ? notice : 'That token was refused.'
  // A refused token: the token field is open again, ready for another.
  if (notice === true) {
    $('token-details').open = true
    $('token').focus()
  }
}

const start = () => {
  $('login').hidden = true
  $('app').hidden = false
  // What was being typed when the app last closed.
  $('text').value = load('sp.draft', '')
  render()
  renderCapture()
  loadProjects()
  startPoll()
  flush()
}

// ---- capture ----

// Where the next note goes: a project key, or null for unfiled (the default). After a save it names
// where that note went, until the next note starts.
let chosen = null
let isJustSaved = false
// The project of the last note filed under one: offered first among the chips.
let lastProject = load('sp.lastProject', null)
const CHIPS = 3

const projectOf = key => projects.find(project => project.key === key) ?? null

// The chips: the last-used project first, then the hub's most recently active; a project picked
// from the full list takes the last place when it isn't already shown.
const chipProjects = () => {
  const ordered = [...projects].sort((a, b) => (b.key === lastProject) - (a.key === lastProject))
  const shown = ordered.slice(0, CHIPS)
  const picked = projectOf(chosen)
  if (picked && !shown.includes(picked)) shown.splice(CHIPS - 1, 1, picked)
  return shown
}

// The note just saved: the form says so until the next one starts, and its row stands out for a
// few seconds.
let savedId = null
let freshId = null
let freshTimer = 0
const FRESH_MS = 3000

// "✓ saved", then whether it has reached the hub yet; and the field's placeholder, which says when
// a note will sync while the hub is out of reach.
const renderSaved = () => {
  const saved = $('saved')
  if (savedId === null || mode === 'capture') saved.replaceChildren()
  else {
    const tick = make('span', '', '✓')
    tick.setAttribute('aria-hidden', 'true')
    const isSent = !outbox.some(note => note.id === savedId)
    saved.replaceChildren(tick, 'saved', make('span', 'then', isSent ? '· synced' : '· waiting to sync'))
  }
  $('text').placeholder = online === false ? 'A note… will sync when back online' : savedId !== null && mode !== 'capture' ? 'Another…' : 'A note…'
}

const renderCapture = () => {
  const text = $('text')
  $('save').disabled = text.value.trim() === ''
  renderSaved()
  const picked = projectOf(chosen)
  // The pill (outside capture): where the note goes, or went.
  const pill = $('pill')
  pill.replaceChildren(dot(picked), make('span', 'label', labelOf(picked)), icon(ICONS.chevron, { size: 12, stroke: 2.2 }))
  pill.setAttribute('aria-label', `Project: ${labelOf(picked)}`)
  // The chips (while typing), the picked one pressed; a tap on it again goes back to unfiled.
  const shown = chipProjects()
  const chips = shown.map((project, i) => {
    const isOn = project.key === chosen
    const chip = button('', () => pick(isOn ? null : project.key), `chip${isOn ? ' on' : ''}${i === 0 && !isOn && chosen === null ? ' first' : ''}`)
    chip.append(dot(project), make('span', '', labelOf(project)))
    chip.setAttribute('aria-pressed', String(isOn))
    return chip
  })
  const rest = projects.length - shown.length
  if (rest > 0) {
    const more = button('', event => openPicker({ mode: 'file', trigger: event.currentTarget }), 'chip more-chip')
    more.append(icon(ICONS.search, { size: 14, stroke: 2 }), make('span', '', `${rest} more`))
    more.setAttribute('aria-label', `More projects, ${rest} others`)
    more.setAttribute('aria-haspopup', 'dialog')
    chips.push(more)
  }
  // A tap on a chip leaves the keyboard up.
  for (const chip of chips) chip.addEventListener('mousedown', event => event.preventDefault())
  $('chip-list').replaceChildren(...chips)
  $('chips').hidden = mode !== 'capture' || chips.length === 0
  const hint = $('hint')
  hint.replaceChildren(dot(picked), picked ? `${labelOf(picked)} · tap again for unfiled` : 'unfiled · tap a project to file')
  hint.hidden = mode !== 'capture'
  pill.hidden = mode === 'capture'
}

const pick = key => {
  chosen = key
  renderCapture()
  if (mode === 'capture') $('text').focus({ preventScroll: true })
}

// ---- modes: the list, typing a note (capture), filtering (search) ----

let mode = 'list'

// The page for a mode. `after` runs once it's drawn (focus that has to land on what it shows).
const drawMode = after => {
  const isCapture = mode === 'capture'
  const isSearch = mode === 'search'
  document.body.dataset.mode = mode
  $('close-capture').hidden = !isCapture
  // While typing, the list beneath is dimmed and out of reach; a tap on it closes the form.
  for (const id of ['refused', 'inbox']) $(id).inert = isCapture
  // Filtering: the search bar takes the header's place, and the form steps aside.
  $('search-bar').hidden = !isSearch
  $('capture').hidden = isSearch
  if (!isSearch) $('filter').value = ''
  $('clear-filter').hidden = $('filter').value === ''
  renderCapture()
  renderList()
  after?.()
}

// A change of mode is a View Transition, but for going into search: its field has to take focus
// while the tap still counts, for the keyboard to come up, so it's drawn at once and settles in.
const setMode = (next, after) => {
  if (next === mode) return after?.()
  mode = next
  if (next === 'search') {
    drawMode(after)
    return motion.searchIn()
  }
  viewTransition(() => drawMode(after))
}

const startSearch = () => setMode('search', () => $('filter').focus())

const endSearch = () => {
  if (mode !== 'search') return
  setMode('list', () => $('open-search').focus({ preventScroll: true }))
}

$('open-search').addEventListener('click', startSearch)
$('cancel-search').addEventListener('click', endSearch)
$('filter').addEventListener('input', () => {
  $('clear-filter').hidden = $('filter').value === ''
  renderList()
})
$('filter').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    endSearch()
  }
  // Enter puts the keyboard away to read the matches.
  if (event.key === 'Enter') $('filter').blur()
})
$('clear-filter').addEventListener('click', () => {
  $('filter').value = ''
  $('clear-filter').hidden = true
  renderList()
  $('filter').focus()
})

const startCapture = () => {
  // The next note starts unfiled; the pill showed where the last one went.
  if (isJustSaved) {
    isJustSaved = false
    chosen = null
  }
  savedId = null
  setMode('capture')
}

// Leaves the form; whatever was typed stays, here and in storage, for next time.
// `next`: where focus goes once the list is back, when it was in the form (else the pill).
const closeCapture = (next = () => $('pill')) => {
  if (mode !== 'capture') return
  const wasInForm = $('capture').contains(document.activeElement) || document.activeElement === $('close-capture')
  // The keyboard goes away with the form.
  if (document.activeElement === $('text')) $('text').blur()
  setMode('list', () => wasInForm && next()?.focus({ preventScroll: true }))
}

const isShown = node => node.getClientRects().length > 0
// Tab past the form's last control leaves it: the form closes and focus goes on into the list
// (which is out of reach while the form is open).
const tabOut = event => {
  const stops = [...$('capture').querySelectorAll('textarea, button')].filter(stop => !stop.disabled && isShown(stop))
  if (event.shiftKey || event.target !== stops[stops.length - 1]) return
  event.preventDefault()
  closeCapture(() => [...document.querySelectorAll('#refused button, #list button')].find(isShown) ?? $('open-search'))
}

$('text').addEventListener('focus', startCapture)
$('text').addEventListener('input', () => {
  store('sp.draft', $('text').value)
  $('save').disabled = $('text').value.trim() === ''
})
$('pill').addEventListener('click', () => $('text').focus())
$('close-capture').addEventListener('click', () => closeCapture())
$('save').addEventListener('mousedown', event => event.preventDefault())
$('capture').addEventListener('keydown', event => {
  if (event.key === 'Escape') closeCapture()
  if (event.key === 'Tab') tabOut(event)
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('capture').requestSubmit()
})
// A tap outside the form (on the dimmed list) closes it.
document.addEventListener('pointerdown', event => {
  if (mode !== 'capture' || $('picker').open) return
  if ($('capture').contains(event.target) || document.querySelector('.top').contains(event.target)) return
  closeCapture()
})

$('capture').addEventListener('submit', event => {
  event.preventDefault()
  const field = $('text')
  const text = field.value.trim()
  if (text === '') return
  const picked = projectOf(chosen)
  const now = new Date().toISOString()
  const id = ulid()
  // Set before queueing, which draws the list: the new row is drawn fresh at once.
  const wasFresh = freshId
  freshId = id
  const isQueued = queue({
    id,
    status: 'open',
    by: 'phone',
    created: now,
    updated: now,
    origin: 'iphone',
    project: picked ? { key: picked.key, name: picked.name, path: picked.path } : null,
    context: {},
    sentAt: null,
    deleted: false,
    text,
    extra: [],
  })
  // Not queued (the phone can't store it): the text stays in the field.
  if (!isQueued) {
    freshId = wasFresh
    return
  }
  savedId = id
  clearTimeout(freshTimer)
  freshTimer = setTimeout(() => {
    freshId = null
    renderList()
  }, FRESH_MS)
  field.value = ''
  store('sp.draft', '')
  if (picked) {
    lastProject = picked.key
    store('sp.lastProject', lastProject)
  }
  isJustSaved = true
  field.blur()
  // Back to the top, where the form says it's saved (the keyboard may have scrolled the page).
  setMode('list', () => scrollTo({ top: 0, behavior: reduced.matches ? 'auto' : 'smooth' }))
})

// ---- the project picker (File under, Move to) ----

// `mode`: 'file' picks where the next note goes; 'move' moves note `id`. `trigger` gets focus back.
let picking = null

const openPicker = ({ mode: pickMode, id = null, trigger = null }) => {
  picking = { mode: pickMode, id, trigger }
  $('picker-title').textContent = pickMode === 'move' ? 'Move to' : 'File under'
  $('picker-search').value = ''
  renderPickerList()
  // Still leaving from last time: gone at once.
  if ($('picker').open) $('picker').close()
  $('picker').showModal()
  ;($('picker').querySelector('[aria-pressed="true"]') ?? $('picker-search')).focus({ preventScroll: true })
  motion.sheetIn($('picker'))
}

// `picked`: true when something was chosen. A project picked for the next note closes the picker at
// once and puts focus back in the note field while the tap still counts, so the keyboard comes back;
// otherwise it sinks away first and focus goes back to what opened it.
const closePicker = (picked = false) => {
  if (!picking) return
  const { trigger, mode: pickMode, id } = picking
  picking = null
  if (picked && pickMode === 'file') {
    $('picker').close()
    return $('text').focus({ preventScroll: true })
  }
  motion.sheetOut($('picker'), () => {
    $('picker').close()
    // A moved note's row was drawn again, in its new group: focus its new ⋯.
    const back = trigger?.isConnected ? trigger : id ? moreOf(id) : null
    back?.focus({ preventScroll: true })
  })
}

// The current choice: the project the note is under (move), or the next note's (file).
const pickedKey = () => (picking?.mode === 'move' ? current()[picking.id]?.project?.key ?? null : chosen)

const renderPickerList = () => {
  if (!picking) return
  const words = $('picker-search').value.trim().toLowerCase()
  const counts = new Map()
  for (const note of Object.values(current())) if (!note.deleted && note.status === 'open' && note.project) counts.set(note.project.key, (counts.get(note.project.key) ?? 0) + 1)
  const here = pickedKey()
  const items = projects
    .filter(project => words === '' || labelOf(project).toLowerCase().includes(words))
    .map(project => {
      const label = labelOf(project)
      const at = words === '' ? -1 : label.toLowerCase().indexOf(words)
      const name = at < 0 ? make('span', 'label', label) : make('span', 'label', label.slice(0, at), make('b', '', label.slice(at, at + words.length)), label.slice(at + words.length))
      const count = counts.get(project.key) ?? 0
      const item = button('', () => choose(project.key), 'pick')
      item.append(dot(project), name, make('span', 'aside count', count === 0 ? '—' : `${count} open`))
      if (count === 0) item.lastChild.setAttribute('aria-label', 'none open')
      const isHere = project.key === here
      item.setAttribute('aria-pressed', String(isHere))
      if (isHere) item.append(icon(ICONS.check, { stroke: 2.2 }))
      return make('li', '', item)
    })
  $('picker-list').replaceChildren(...items)
  $('picker-none').hidden = items.length > 0
  const unfiled = $('picker-unfiled')
  unfiled.setAttribute('aria-pressed', String(here === null))
  const aside = unfiled.querySelector('.aside')
  aside.replaceChildren(...(picking.mode === 'file' ? ['the default'] : []), ...(here === null ? [icon(ICONS.check, { stroke: 2.2 })] : []))
}

const choose = key => {
  if (!picking) return
  if (picking.mode === 'move') {
    const { id } = picking
    if ((current()[id]?.project?.key ?? null) !== key) moveTo(id, projectOf(key))
    closePicker(true)
    return
  }
  chosen = key
  renderCapture()
  closePicker(true)
}

$('picker-search').addEventListener('input', renderPickerList)
$('picker-unfiled').addEventListener('click', () => choose(null))
$('picker-done').addEventListener('click', () => closePicker())
$('picker').querySelector('[data-close]').addEventListener('click', () => closePicker())
$('picker').addEventListener('cancel', event => {
  event.preventDefault()
  closePicker()
})

$('toast-undo').addEventListener('click', () => {
  const undo = toastUndo
  clearTimeout(toastTimer)
  toasts += 1
  $('toast').hidden = true
  $('toast').style.opacity = ''
  toastUndo = null
  if (undo) undo()
})

$('login').addEventListener('submit', async event => {
  event.preventDefault()
  token = $('token').value.trim()
  if (token === '') return
  store('sp.token', token)
  linkManifest()
  try {
    await api('/api/projects')
    start()
  } catch (error) {
    if (!(error instanceof Unauthorized)) start() // offline: start anyway, the outbox waits
  }
})

addEventListener('online', () => {
  startPoll()
  flush()
})
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  startPoll()
  flush()
  renderList() // ages
})

// A Home Screen app on iOS has its own storage, so the token rides along in the app's start URL:
// the manifest is asked for with the token, and the hub (only for the right token) answers with a
// start URL that carries it. In Safari the token also stays in the address, which Add to Home
// Screen may take instead; inside the installed app it leaves the address bar.
const linkManifest = () => {
  if (token !== '') document.querySelector('link[rel=manifest]').href = `manifest.json?token=${encodeURIComponent(token)}`
}
const isStandalone = () => navigator.standalone || matchMedia('(display-mode: standalone)').matches

// `?pair=<code>` (the QR from `ostrakon pair`): the one-time code is traded for the token, with no
// Authorization header. Resolves to a message for the login screen, or '' when the token is stored.
const claimPair = async code => {
  try {
    const response = await fetch('api/pair/claim', { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) })
    if (response.status === 401) return 'That pairing code has expired or was already used. Run ostrakon pair again.'
    if (!response.ok) return `The hub refused the pairing code (${response.status}).`
    const body = await response.json()
    if (typeof body.token !== 'string' || body.token === '') return 'The hub sent no token. Run ostrakon pair again.'
    token = body.token
    store('sp.token', token)
    return ''
  } catch {
    return "Couldn't reach the hub to pair. Check this phone can reach it, then scan again."
  }
}

const boot = async () => {
  const params = new URLSearchParams(location.search)
  let notice = false
  if (params.has('pair')) {
    notice = (await claimPair(params.get('pair').trim())) || false
    if (notice === false && !isStandalone()) {
      // iOS gives the Home Screen app storage of its own, so its start address must carry the token:
      // the page reloads with `?token=` (the hub then links the manifest with it) for Add to Home
      // Screen. The token is in the address bar on this phone only, never in the QR.
      location.replace(`./?token=${encodeURIComponent(token)}`)
      return
    }
    history.replaceState(null, '', location.pathname)
  } else if (params.has('token')) {
    token = params.get('token').trim()
    store('sp.token', token)
    if (isStandalone()) history.replaceState(null, '', location.pathname)
  }
  linkManifest()
  // A failed code on a phone that's already paired keeps its token; a stale one is refused by the hub.
  if (token === '') showLogin(notice)
  else start()
}

if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {})

boot()
