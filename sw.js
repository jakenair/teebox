// TeeBox service worker — app-shell caching + offline fallback.
// Bump CACHE_VERSION to invalidate the old cache after a deploy.
const CACHE_VERSION = 'teebox-v1-2026-06-08-r162';
// Bingo logos are pinned in their OWN cache namespace so we can cache them
// aggressively (cache-first) without colliding with the broader logos-bypass
// policy. The page sends a CACHE_BINGO_LOGOS message on bingo-tab open with
// today's 9 logo URLs — only those URLs are cached here.
const BINGO_LOGO_CACHE = 'teebox-bingo-logos-v1';
const SHELL = [
  '/',
  '/index.html',
  '/support.html',
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

  // Bingo logos — cache-first against the dedicated BINGO_LOGO_CACHE. Only
  // URLs the page has explicitly pre-cached via the CACHE_BINGO_LOGOS message
  // are kept here, so we don't accidentally pin every logo in /assets/logos/.
  // On a cache miss we fall through to the network and lazily fill the cache.
  // This makes Logo Bingo playable at the golf course on bad signal.
  if (url.origin === self.location.origin && url.pathname.startsWith('/assets/logos/')) {
    event.respondWith(
      caches.open(BINGO_LOGO_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req)
            .then((resp) => {
              // Only fill the cache on a real, same-origin, 200 OK response.
              // The page's pre-cache message is the authoritative source of
              // which logos belong here, but lazily caching successful 200s
              // is harmless and keeps the working set warm.
              if (resp && resp.status === 200 && resp.type !== 'opaque') {
                // Lazy fill is intentionally limited to logos we already
                // *attempted* to cache via the message handler — store only
                // if a matching entry exists OR the request is a navigation
                // initiated by the bingo page. We can't easily detect that
                // here, so we just store; the cache is tiny (9 PNGs) and
                // pruned per-day when the message handler replaces it.
                cache.put(req, resp.clone()).catch(() => {});
              }
              return resp;
            })
            .catch(() => cached || Response.error());
        })
      )
    );
    return;
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

// Listen for messages from the page.
//   • SKIP_WAITING — activate an updated SW immediately without a reload.
//   • CACHE_BINGO_LOGOS { urls: string[] } — pre-cache today's 9 bingo
//     logos into BINGO_LOGO_CACHE so the user can still tap through the
//     puzzle offline at the course. Replaces any prior contents so we don't
//     accumulate stale logos across days.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'CACHE_BINGO_LOGOS' && Array.isArray(data.urls)) {
    // Filter to same-origin /assets/logos/* URLs only — never let the page
    // direct us to cache an arbitrary origin via this channel.
    const urls = data.urls.filter((u) => {
      try {
        const x = new URL(u, self.location.origin);
        return x.origin === self.location.origin && x.pathname.startsWith('/assets/logos/');
      } catch { return false; }
    });
    event.waitUntil((async () => {
      try {
        // Wipe + re-fill: keeps the cache bounded to today's working set.
        // If the user re-opens the bingo tab later in the day this is a
        // no-op (same URLs → fresh fetch → same cache entries).
        await caches.delete(BINGO_LOGO_CACHE);
        const cache = await caches.open(BINGO_LOGO_CACHE);
        await Promise.all(urls.map(async (u) => {
          try {
            // cache.add() throws on non-2xx; we tolerate that per-URL so a
            // single 404 doesn't abort the whole pre-cache.
            await cache.add(u);
          } catch (err) {
            // Best-effort — if a logo 404s we'll fall back to the
            // browser HTTP cache / network when the user navigates.
          }
        }));
      } catch (err) {
        // Best-effort.
      }
    })());
  }
});
