const CACHE_VERSION = 'dj-house-v2026-04-17-2';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;

const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/sports-cards.html',
  '/baseball-cards.html',
  '/basketball-cards.html',
  '/football-cards.html',
  '/comics.html',
  '/collectibles.html',
  '/wishlist.html',
  '/about.html',
  '/contact.html',
  '/offline.html',
  '/styles.css?v=20260417b',
  '/core.js?v=20260417b',
  '/nav.js?v=20260417b',
  '/catalog.js?v=20260417b',
  '/contact.js?v=20260417b',
  '/backend-config.js?v=20260417b',
  '/supabase-client.js?v=20260417b',
  '/site.webmanifest?v=20260417b',
  '/vendor/supabase.min.js',
  '/assets/dj-logo.png',
  '/assets/grass.jpg',
  '/assets/baseball-main.jpg',
  '/assets/basketball-main.jpg',
  '/assets/football-main.jpg',
  '/assets/comics-main.jpeg',
  '/assets/Jordan.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(APP_SHELL_ASSETS.map(async (asset) => {
      try {
        await cache.add(asset);
      } catch (error) {
        // Individual asset failures should not abort the offline shell install.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => {
      if (![SHELL_CACHE, RUNTIME_CACHE, IMAGE_CACHE].includes(key)) {
        return caches.delete(key);
      }
      return Promise.resolve();
    }));
    await self.clients.claim();
  })());
});

async function putInCache(cacheName, request, response) {
  if (!response) return response;
  if (!(response.ok || response.type === 'opaque')) return response;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => putInCache(cacheName, request, response))
    .catch(() => null);

  if (cached) {
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(networkPromise);
    }
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;
  return caches.match('/offline.html');
}

async function networkFirst(request, cacheName, fallbackUrl = '/offline.html') {
  try {
    const response = await fetch(request);
    await putInCache(cacheName, request, response);
    return response;
  } catch (error) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    return cached || caches.match(fallbackUrl);
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  await putInCache(cacheName, request, response);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isPageRequest = request.mode === 'navigate' || request.destination === 'document';
  const isImageRequest = request.destination === 'image';
  const isStaticAsset = ['style', 'script', 'font', 'manifest'].includes(request.destination);
  const isCatalogData = isSameOrigin && (
    url.pathname.endsWith('.json')
    || url.pathname.endsWith('.webmanifest')
    || url.pathname.includes('products-data-')
  );
  const isRemoteCatalog = /supabase\.co$/i.test(url.hostname);

  if (isPageRequest) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
    return;
  }

  if (isImageRequest) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE));
    return;
  }

  if (isStaticAsset || isCatalogData) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE, event));
    return;
  }

  if (isRemoteCatalog) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE));
  }
});
