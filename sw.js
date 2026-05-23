// Travelmap service worker — enables offline use + home-screen install.
// Bump APP_CACHE whenever the shell changes to invalidate old caches.
const APP_CACHE = 'travelmap-shell-v7';
const TILE_CACHE = 'travelmap-tiles-v1';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(APP_CACHE).then((cache) =>
      // addAll is atomic — if any single asset fails, the SW won't install.
      // For CDN assets we allow individual failures so a flaky network on
      // first install doesn't brick the SW.
      Promise.all(
        SHELL_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn('[SW] failed to cache', url, err)
          )
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== APP_CACHE && k !== TILE_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Live data — never cache. Each of these needs fresh results, and caching
  // partial results would be confusing (stale POIs, routes that don't match
  // the current waypoints, etc.). Just let the browser do its thing.
  const isLiveAPI =
    /overpass|routing\.openstreetmap\.de|nominatim\.openstreetmap\.org|corsproxy\.io/.test(
      url.host
    );
  if (isLiveAPI) return;

  // Map tiles — cache aggressively. They never change for a given coordinate.
  if (/basemaps\.cartocdn\.com/.test(url.host)) {
    event.respondWith(
      caches.open(TILE_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // App shell — network-first with cache fallback. When online, users
  // always get the latest HTML/CSS/JS. When offline, the cached copy keeps
  // the app working. (Stale-while-revalidate showed stale code for an
  // extra reload after every deploy, which is a bad dev experience.)
  if (
    url.origin === self.location.origin ||
    /unpkg\.com\/leaflet/.test(url.host)
  ) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(APP_CACHE);
        try {
          const fresh = await fetch(req);
          if (fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cached = await cache.match(req);
          if (cached) return cached;
          throw e;
        }
      })()
    );
  }
});
