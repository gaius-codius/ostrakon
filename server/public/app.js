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
let refused = load('sp.refused', []) // { id, text, reason }: notes the hub wouldn't take
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
  const next = refused.filter(item => !ids.has(item.id)).concat(entries.map(([note, reason]) => ({ id: note.id, text: note.text, reason })))
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
    renderPicker()
    if (sheetView === 'move') renderSheet()
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

// Notes the hub refused: their only copy is here, so they stay until dismissed.
const renderRefused = () => {
  const items = refused.map(item => {
    const copied = button('Copy', async () => toast((await copy(item.text)) ? 'Copied' : "Couldn't copy"), 'btn')
    const dismiss = button('Dismiss', () => {
      refused = refused.filter(other => other !== item)
      store('sp.refused', refused)
      renderRefused()
    }, 'btn')
    return make('li', '', make('p', 'quote', item.text), make('div', 'meta error', `Refused by the hub: ${item.reason}`), make('div', 'row', copied, dismiss))
  })
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

const renderPicker = () => {
  const select = $('project')
  const chosen = select.value
  const options = [new Option('unfiled', '')]
  for (const project of projects) options.push(new Option(labelOf(project), project.key))
  select.replaceChildren(...options)
  select.value = projects.some(project => project.key === chosen) ? chosen : ''
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
  const words = $('filter').value.trim().toLowerCase()
  const queued = new Set(outbox.map(note => note.id))
  const shown = Object.values(current())
    .filter(note => !note.deleted && note.status === 'open')
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
  for (const key of order) {
    const notes = groups.get(key)
    const project = notes[0].project
    // While filtering every group shows its matches, folded or not.
    const isFolded = words === '' && folded.has(key)
    const rowsId = `rows-${++groupIds}`
    const head = heading(key, dot(project), labelOf(project), notes.length, !isFolded, isFolded ? '▸' : '', rowsId)
    const list = make('ul', 'rows')
    list.id = rowsId
    list.hidden = isFolded
    if (!isFolded) for (const note of notes) list.append(noteRow(note, queued.has(note.id)))
    const group = make('div', 'group', head, list)
    group.dataset.key = key
    sections.push(group)
  }
  $('list').replaceChildren(...sections)
  $('empty').hidden = shown.length > 0
  $('empty').textContent = words === '' ? 'No open notes.' : 'No notes match.'
}

// One open note: its marker (◆ from Claude, ▪ from the phone), the text and its age, over the
// archive strip a swipe uncovers.
const noteRow = (note, isQueued) => {
  const marker = make('span', `marker ${note.by}`, note.by === 'claude' ? '◆' : note.by === 'phone' ? '▪' : '')
  if (note.by === 'claude') {
    marker.setAttribute('role', 'img')
    marker.setAttribute('aria-label', 'From Claude')
  } else marker.setAttribute('aria-hidden', 'true')
  const age = isQueued ? make('span', 'age queued', make('span', '', '↑ '), 'queued') : make('span', 'age', ageOf(note.updated))
  const face = make('div', 'face', marker, make('p', 'text', note.text), age)
  const behind = make('div', 'behind', make('span', '', 'Archive'))
  behind.setAttribute('aria-hidden', 'true')
  const row = make('li', note.id === sheetFor ? 'note chosen' : 'note', behind, face)
  row.dataset.id = note.id
  gestures(row, face, behind, note.id)
  return row
}

const render = () => {
  renderStatus()
  renderRefused()
  renderList()
  if (sheetFor !== null) renderSheet()
}

// ---- inbox actions ----

const toast = (text, undo) => {
  clearTimeout(toastTimer)
  $('toast-text').textContent = text
  toastUndo = undo
  $('toast-undo').hidden = !undo
  $('toast').hidden = false
  toastTimer = setTimeout(() => {
    $('toast').hidden = true
    toastUndo = null
  }, 5000)
}

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
    toast('Archived', undo(id, note => !note.deleted && note.status === 'archived', () => ({ status: 'open' })))
  }
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
  if (!(isSaved && note && text !== '' && text !== note.text)) return render()
  // Not queued: the editor stays open with the draft.
  if (!queue({ ...note, text, updated: stamp(note.updated), origin: 'iphone' })) editing = { id, draft }
}

const markSent = id => {
  const note = current()[id]
  if (!note) return
  const { sentAt } = note
  const at = new Date().toISOString()
  if (change(id, () => ({ status: 'sent', sentAt: at }))) {
    toast('Marked sent', undo(id, now => !now.deleted && now.status === 'sent' && now.sentAt === at, () => ({ status: 'open', sentAt })))
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

// ---- action sheet (long press on a row) ----

let sheetView = null // 'actions' | 'move'
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

const openSheet = id => {
  if (sheetFor !== null || !isActionable(current()[id])) return
  sheetFor = id
  sheetView = 'actions'
  isSheetPressed = false
  sheetReturn = document.activeElement
  renderSheet()
  $('sheet').hidden = false
  // The page beneath can't be focused, tapped or read while the sheet is up.
  $('app').inert = true
  // Drawn hidden first, so the panel slides up from below; focus goes in once it's drawn.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      $('sheet').classList.add('open')
      $('sheet-actions').querySelector('button')?.focus({ preventScroll: true })
    }),
  )
  renderList()
}

const closeSheet = () => {
  if (sheetFor === null) return
  sheetFor = null
  sheetView = null
  sheetDrawn = ''
  $('sheet').classList.remove('open')
  $('sheet').hidden = true
  $('app').inert = false
  renderList()
  if (sheetReturn?.isConnected && sheetReturn !== document.body) sheetReturn.focus({ preventScroll: true })
  sheetReturn = null
}

// Runs a sheet action once the sheet is closed, so the list it redraws is the plain one.
const act = run => () => {
  const id = sheetFor
  closeSheet()
  run(id)
}

// Redrawn on every sync while open. Keyboard focus stays on the same row of the list; `isEntering`
// puts it on the current project (or the first) as the move list opens.
const renderSheet = (isEntering = false) => {
  const note = current()[sheetFor]
  if (!isActionable(note)) return closeSheet()
  const drawn = JSON.stringify([sheetView, note.text, note.project, sheetView === 'move' ? projects : null])
  if (drawn === sheetDrawn && !isEntering) return
  sheetDrawn = drawn
  const list = $('sheet-actions')
  // Kept by what it is (a project's key, an action's label), since a sync can reorder the projects.
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.key : undefined
  const items =
    sheetView === 'move'
      ? [null, ...projects].map(project => {
          const isHere = (project?.key ?? null) === (note.project?.key ?? null)
          const item = button(labelOf(project), isHere ? closeSheet : act(id => moveTo(id, project)), isHere ? 'here' : '')
          item.dataset.key = project?.key ?? ''
          if (isHere) item.setAttribute('aria-current', 'true')
          return item
        })
      : [
          button('Edit', act(startEdit)),
          button('Copy text', act(async id => toast((await copy(current()[id]?.text ?? '')) ? 'Copied' : "Couldn't copy"))),
          button('Move to project…', () => {
            sheetView = 'move'
            renderSheet(true)
            loadProjects()
          }),
          button('Mark sent', act(markSent)),
          button('Archive', act(archive)),
        ]
  $('sheet-title').textContent = sheetView === 'move' ? `Move to project · now ${labelOf(note.project)}` : note.text
  $('sheet-title').classList.toggle('quote', sheetView !== 'move')
  if (sheetView !== 'move') for (const item of items) item.dataset.key = item.textContent
  list.replaceChildren(...items)
  const target = isEntering ? list.querySelector('.here') ?? items[0] : focused === undefined ? null : items.find(item => item.dataset.key === focused) ?? items[0]
  target?.focus({ preventScroll: true })
}

$('sheet').addEventListener('pointerdown', () => (isSheetPressed = true))
$('sheet').addEventListener(
  'click',
  event => {
    if (isSheetPressed || event.detail === 0) return
    event.preventDefault()
    event.stopPropagation()
  },
  true,
)
$('sheet-scrim').addEventListener('click', closeSheet)
$('sheet-cancel').addEventListener('click', closeSheet)
// Tab and Shift+Tab go round the sheet's own buttons (the toast sits outside the inert page).
document.addEventListener('keydown', event => {
  if (sheetFor === null) return
  if (event.key === 'Escape') return closeSheet()
  if (event.key !== 'Tab') return
  const stops = [...$('sheet').querySelectorAll('button')]
  const at = stops.indexOf(document.activeElement)
  event.preventDefault()
  stops[(at + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]?.focus()
})

// Tap edits; swipe left archives, over a strip that says so and firms up past the point where
// letting go archives. Holding still opens the action sheet, at once, with the finger still down;
// what the finger does after that (a small move, the lift) is ignored.
const HOLD_MS = 550
const ARCHIVE_PX = 80
const gestures = (row, face, behind, id) => {
  let start = null
  let isDragging = false
  let holdTimer = 0
  const reset = () => {
    clearTimeout(holdTimer)
    row.classList.remove('dragging', 'armed')
    face.style.transform = ''
    start = null
    isDragging = false
    isTouching = false
    if (isStale) renderList()
  }
  // A right click (or a browser's own long press) opens the sheet too; the hold has usually opened it.
  row.addEventListener('contextmenu', event => {
    event.preventDefault()
    if (!editing) openSheet(id)
  })
  row.addEventListener('pointerdown', event => {
    // One finger at a time: a second one on the row is ignored.
    if (editing || event.button > 0 || start) return
    start = { x: event.clientX, y: event.clientY, pointer: event.pointerId }
    isTouching = true
    holdTimer = setTimeout(() => {
      reset()
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
    const dx = event.clientX - start.x
    const dy = event.clientY - start.y
    if (!isDragging && Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return reset()
    if (Math.abs(dx) > 10) {
      clearTimeout(holdTimer)
      isDragging = true
      row.classList.add('dragging')
      row.classList.toggle('armed', dx < -ARCHIVE_PX)
      face.style.transform = `translateX(${Math.min(0, dx)}px)`
    }
  })
  row.addEventListener('pointerup', event => {
    if (!isOurs(event)) return
    const dx = event.clientX - start.x
    const wasDragging = isDragging
    reset()
    if (wasDragging) {
      if (dx < -ARCHIVE_PX) archive(id)
    } else startEdit(id)
  })
  row.addEventListener('pointercancel', event => isOurs(event) && reset())
  row.addEventListener('lostpointercapture', event => isOurs(event) && reset())
}

// ---- screens ----

// `notice`: true for a refused token, or the words to show; false for none.
const showLogin = notice => {
  pollGen += 1
  $('app').hidden = true
  $('login').hidden = false
  $('login-error').hidden = !notice
  if (notice) $('login-error').textContent = typeof notice === 'string' ? notice : 'That token was refused.'
  $('token').focus()
}

const start = () => {
  $('login').hidden = true
  $('app').hidden = false
  renderPicker()
  render()
  $('text').focus()
  loadProjects()
  startPoll()
  flush()
}

$('capture').addEventListener('submit', event => {
  event.preventDefault()
  const field = $('text')
  const text = field.value.trim()
  field.focus()
  if (text === '') return
  const key = $('project').value
  const picked = projects.find(project => project.key === key)
  const now = new Date().toISOString()
  const isQueued = queue({
    id: ulid(),
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
  if (isQueued) field.value = ''
})

$('text').addEventListener('keydown', event => {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) $('capture').requestSubmit()
})

$('filter').addEventListener('input', renderList)

$('toast-undo').addEventListener('click', () => {
  const undo = toastUndo
  clearTimeout(toastTimer)
  $('toast').hidden = true
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
    return "Couldn't reach the hub to pair. Check that Tailscale is connected, then scan again."
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
