// Minimal service worker — makes the app installable and lets the shell open
// offline. Data is always fetched live from Turso (never cached), so the app
// never shows stale build status.
const SHELL = 'axion-shell-v2'
const FILES = ['./', './index.html', './manifest.webmanifest', './icon.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // Turso / any API call: always go to the network, never cache.
  if (url.pathname.includes('/v2/pipeline') || url.origin !== location.origin) return
  // App shell: cache-first so it opens instantly and works offline.
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)))
})
