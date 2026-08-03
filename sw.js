// DSA Tracker service worker.
//
// Two things this buys you on repeat visits:
//   1. The app shell (index.html, styles.css, problems-data.js) loads from
//      cache instantly instead of re-downloading ~430KB+ every time, while
//      still refreshing the cache in the background so the NEXT load picks
//      up any update (stale-while-revalidate).
//   2. CDN runtime assets (CodeMirror, Pyodide, sql.js, CheerpJ) are cached
//      cache-first — these are versioned URLs (e.g. .../5.65.16/...) that
//      never change content for a given URL, so once fetched once, the
//      Python/Java/editor "cold start" cost basically disappears on every
//      visit after the first.
//
// Bump CACHE_VERSION whenever you deploy a new APP_VERSION so old caches
// get cleaned up automatically instead of accumulating forever.
const CACHE_VERSION = 'v1.7.1';
const CACHE_NAME = 'dsa-tracker-' + CACHE_VERSION;

const PRECACHE_URLS = [
  './',
  './index.html',
  './styles.css',
  './problems-data.js'
];

// Third-party origins it's safe to cache aggressively (cache-first) because
// their URLs are version-pinned — the content behind a given URL never
// changes, so there's no staleness risk, only a speed win.
const CDN_CACHE_HOSTS = [
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'cjrtnc.leaningtech.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
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
  const isCdnAsset = CDN_CACHE_HOSTS.includes(url.hostname);
  const isAppShell = url.origin === self.location.origin;

  if (!isCdnAsset && !isAppShell) return; // let everything else (API calls etc.) hit the network normally

  if (isCdnAsset) {
    // Cache-first: version-pinned URL, so a cache hit is always correct.
    event.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  if (isAppShell && PRECACHE_URLS.some((p) => url.pathname.endsWith(p.replace('./', '')) || url.pathname === '/')) {
    // Stale-while-revalidate: serve from cache immediately, refresh in the
    // background so the next load has whatever changed.
    event.respondWith(
      caches.open(CACHE_NAME).then((cache) => cache.match(req).then((cached) => {
        const networkFetch = fetch(req).then((res) => {
          if (res.ok) cache.put(req, res.clone());
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      }))
    );
  }
});
