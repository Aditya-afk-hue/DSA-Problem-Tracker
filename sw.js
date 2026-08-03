// DSA Tracker service worker.
//
// Deliberately narrow scope: this ONLY caches the three same-origin app
// shell files (index.html, styles.css, problems-data.js), and only lazily
// as they're actually requested — no install-time cache.addAll(), and no
// interception of CDN requests (CodeMirror, Pyodide, CheerpJ, sql.js).
//
// An earlier version of this file also tried to cache-first the CDN
// runtime assets and eagerly re-fetch the app shell on install. Both of
// those made the FIRST visit slower, not faster:
//   - Pyodide loads dozens of files from inside its own dedicated Worker.
//     Routing every one of those through this service worker's fetch
//     handler added an async cache lookup in front of each request —
//     latency stacked on exactly the thing people are waiting on.
//   - cache.addAll() on install re-downloaded the app shell immediately,
//     competing for bandwidth with the runtime download happening at the
//     same time.
// Browsers already do standard HTTP caching for CDN scripts on their own
// (version-pinned URLs like .../5.65.16/... are cached long-term by
// default), so this service worker doesn't need to get involved there at
// all — it only helps with the app's own three files, on repeat visits.
//
// Bump CACHE_VERSION whenever you deploy a new APP_VERSION so old caches
// get cleaned up automatically instead of accumulating forever.
const CACHE_VERSION = 'v1.7.2';
const CACHE_NAME = 'dsa-tracker-' + CACHE_VERSION;

const APP_SHELL_FILES = ['/', '/index.html', '/styles.css', '/problems-data.js'];

self.addEventListener('install', (event) => {
  // No eager cache.addAll() here on purpose — see notes above. Just take
  // over as soon as possible; caching happens lazily via the fetch handler.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin (CDN) requests

  const isAppShellFile = APP_SHELL_FILES.some((p) => url.pathname === p || url.pathname.endsWith(p));
  if (!isAppShellFile) return;

  // Stale-while-revalidate: serve from cache immediately if we have it,
  // and refresh the cache in the background so the NEXT load picks up
  // whatever changed. On a first-ever visit there's nothing cached yet, so
  // this is just a normal network fetch with no added overhead.
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => cache.match(req).then((cached) => {
      const networkFetch = fetch(req).then((res) => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    }))
  );
});
