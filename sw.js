/* NMIET CMS — service worker.
 *
 * Deliberately conservative about what it caches:
 *   app shell (html/css/js/icons) -> cache first, refreshed in the background
 *   /api/*                        -> network only, never cached
 *
 * The CMS is a live multi-user system; serving a stale student list or fee
 * balance from cache would be worse than showing nothing, so API traffic is
 * left alone entirely. Only the shell is cached, which is what makes the
 * installed app open instantly and survive a flaky connection.
 */
/* Bump BUILD together with the ?b= stamp in index.html on every css/js
   change. The cache name carries it, so activate() wipes the old shell
   instead of leaving a phone on a stale app.js. */
const BUILD = '20260821r';
const VERSION = 'nmiet-cms-' + BUILD;
const SHELL = [
  './',
  'index.html',
  'css/styles.css?b=' + BUILD,
  'js/xlsx.js?b=' + BUILD,
  'js/store.js?b=' + BUILD,
  'js/app.js?b=' + BUILD,
  'assets/nmiet-logo.png',
  'assets/campus-building.webp',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/maskable-192.png',
  'assets/icons/maskable-512.png',
  'manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll fails the whole install if any one file 404s, so add them
      // individually and let a missing optional asset pass. cache:'reload'
      // skips the browser's own HTTP cache — otherwise a phone that already
      // cached an old app.js would precache that same stale copy.
      .then((c) => Promise.all(SHELL.map((u) =>
        c.add(new Request(u, { cache: 'reload' })).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // never cache the API or anything off-origin (the attendance portal, fonts)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  // navigations: try the network so a deployed update is picked up, fall back
  // to the cached shell when offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(new Request(req.url, { cache: 'reload', credentials: 'same-origin' }))
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put('index.html', copy));
          return res;
        })
        .catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // static assets: serve from cache, refresh in the background
  e.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});

// lets the page trigger an immediate update after a redeploy
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
});
