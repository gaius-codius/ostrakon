// Opens the app from its cache at once, even when the hub is down or hangs, and refreshes the
// cache in the background (stale-while-revalidate): a new version shows on the next open.
// /api is never cached, nor the manifest: it carries the token for the Home Screen app.
const CACHE = 'ostrakon-shell-v11'
const SHELL = ['/', '/app.js', '/style.css', '/icon.svg', '/icon-180.png']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const { request } = event
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/manifest.json') return
  // A page opened with its token comes from the hub, which links the manifest with it (the Home
  // Screen app's start address needs it); every other page load is the cached page. A pairing
  // link goes to the hub too, so it never lands in the cache.
  if (request.mode === 'navigate' && (url.searchParams.has('token') || url.searchParams.has('pair'))) return
  const key = request.mode === 'navigate' ? '/' : url.pathname
  event.respondWith(
    caches.open(CACHE).then(async cache => {
      const fresh = fetch(request).then(response => {
        if (response.ok) cache.put(key, response.clone())
        return response
      })
      const hit = await cache.match(key)
      if (!hit) return fresh
      event.waitUntil(fresh.catch(() => undefined))
      return hit
    }),
  )
})
