// TeeBox service worker — app-shell caching + offline fallback.
// Bump CACHE_VERSION to invalidate the old cache after a deploy.
const CACHE_VERSION = 'teebox-v1-2026-04-30-r23';
const SHELL = [
  '/',
  '/index.html',
  '/bingo-courses.js',
  '/firebase-messaging-sw.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/offline.html',
  '/404.html',
];

// API hosts that must always go to the network (no cache, no offline).
const NETWORK_ONLY_HOSTS = [
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'securetoken.googleapis.com',
  'firebaseinstallations.googleapis.com',
  'firebasestorage.googleapis.com',
  'api.stripe.com',
  'm.stripe.com',
  'm.stripe.network',
  'q.stripe.com',
  'r.stripe.com',
  'js.stripe.com',
];

// Install: precache the app shell.
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(SHELL).catch((err) => {
        // Some shell items (e.g. /offline.html) may not exist yet on
        // first deploy — that's fine.
        console.warn('[sw] shell precache partial:', err);
      })
    )
  );
  self.skipWaiting();
});

// Activate: drop any older caches.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch strategy:
//   - Same-origin HTML navigation → network-first (fall back to cache when
//     offline). HTML must be fresh on every load or PWA users stay pinned to
//     stale UI when we ship — exactly the bug we hit shipping v1.1.
//   - Other same-origin GETs (JS, CSS, images, JSON, manifest) →
//     stale-while-revalidate for speed.
//   - Cross-origin to network-only hosts → bypass entirely
//   - Other cross-origin GETs → network-first, fall back to cache
//   - Non-GET → bypass entirely (Firestore/Stripe POSTs)
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (NETWORK_ONLY_HOSTS.some((h) => url.host === h || url.host.endsWith('.' + h))) {
    return; // Let the request proceed without SW interference.
  }

  // Same-origin /assets/logos/* — bypass SW cache entirely. These swap out as
  // we commission real brand logos; we don't want users pinned to a stale
  // copy. Browser HTTP cache still applies.
  if (url.pathname.startsWith('/assets/logos/')) {
    return; // let the browser handle it
  }

  // Same-origin HTML navigation → network-first.
  const isHtmlNav =
    req.mode === 'navigate' ||
    (req.destination === 'document') ||
    (url.origin === self.location.origin && /\.html?$/.test(url.pathname));
  if (url.origin === self.location.origin && isHtmlNav) {
    event.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp && resp.status === 200 && resp.type !== 'opaque') {
            const copy = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return resp;
        })
        .catch(() =>
          caches.open(CACHE_VERSION).then((cache) =>
            cache.match(req).then((cached) => cached || cache.match('/offline.html'))
          )
        )
    );
    return;
  }

  // Same-origin (non-HTML): stale-while-revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_VERSION).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((resp) => {
              if (resp && resp.status === 200 && resp.type !== 'opaque') {
                cache.put(req, resp.clone()).catch(() => {});
              }
              return resp;
            })
            .catch(() => cached || cache.match('/offline.html'));
          return cached || network;
        })
      )
    );
    return;
  }

  // Cross-origin: skip caching for image hosts entirely. Demo Unsplash photos
  // are remoted by URL hash; if Unsplash ever swaps the underlying image we
  // don't want to pin users to a stale cached copy. Browser HTTP cache still
  // applies as a normal CDN would.
  if (req.destination === 'image') {
    return; // browser handles via standard HTTP cache
  }

  // Cross-origin static (fonts, CDN scripts): network-first, fall back to cache.
  event.respondWith(
    fetch(req)
      .then((resp) => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const copy = resp.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy)).catch(() => {});
        }
        return resp;
      })
      .catch(() => caches.match(req))
  );
});

// Listen for "skip waiting" message from the page so an update can
// activate immediately without a reload.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
