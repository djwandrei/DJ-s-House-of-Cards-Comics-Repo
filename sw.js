const CACHE_VERSION = 'dj-house-v2026-05-26-01';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;
const CATALOG_CACHE = `${CACHE_VERSION}-catalog`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;
const CACHE_TRIM_INTERVAL_MS = 30000;
const cacheTrimTimestamps = new Map();
const CACHE_ENTRY_LIMITS = {
  [RUNTIME_CACHE]: 120,
  [CATALOG_CACHE]: 36,
  [IMAGE_CACHE]: 350
};
const STATIC_ASSET_DESTINATIONS = new Set(['style', 'script', 'font', 'manifest']);
const SUPABASE_HOST_PATTERN = /supabase\.co$/i;
const CACHE_BYPASS_PATHS = new Set(['/admin.html']);

// Keep the offline shell limited to public storefront files, then let runtime
// caching collect product data and thumbnails as shoppers browse.
const APP_SHELL_ASSETS = [
  '/',
  '/index.html',
  '/shop.html',
  '/sports-cards.html',
  '/baseball-cards.html',
  '/basketball-cards.html',
  '/football-cards.html',
  '/comics.html',
  '/collectibles.html',
  '/wishlist.html',
  '/account.html',
  '/about.html',
  '/contact.html',
  '/offline.html',
  '/styles.css?v=20260525b',
  '/styles-mobile-overrides.css?v=20260526a',
  '/core.js?v=20260526a',
  '/nav.js?v=20260520a',
  '/catalog.js?v=20260526a',
  '/contact.js?v=20260423d',
  '/backend-config.js?v=20260525a',
  '/supabase-client.js?v=20260525a',
  '/payments.js?v=20260525a',
  '/account.js?v=20260521c',
  '/site.webmanifest?v=20260423d',
  '/offline.js?v=20260423d',
  '/vendor/supabase.min.js',
  '/assets/fonts/bebas-neue-400.woff2',
  '/assets/fonts/inter-400.woff2',
  '/assets/fonts/inter-500.woff2',
  '/assets/fonts/inter-600.woff2',
  '/assets/fonts/inter-700.woff2',
  '/assets/fonts/inter-800.woff2',
  '/assets/fonts/lobster-two-400.woff2',
  '/assets/fonts/lobster-two-700.woff2',
  '/assets/dj-logo.png',
  '/assets/grass.webp',
  '/assets/grass.jpg',
  '/assets/baseball-main.webp',
  '/assets/baseball-main.jpg',
  '/assets/basketball-main.webp',
  '/assets/basketball-main.jpg',
  '/assets/football-main.webp',
  '/assets/football-main.jpg',
  '/assets/comics-main.webp',
  '/assets/comics-main.jpeg',
  '/assets/Jordan.webp',
  '/assets/Jordan.jpg',
  '/assets/clubhouse-sign.webp',
  '/assets/baseball-footer.webp',
  '/assets/basketball-footer.webp',
  '/assets/football-footer.webp',
  '/assets/comics-footer.webp'
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
      if (![SHELL_CACHE, RUNTIME_CACHE, CATALOG_CACHE, IMAGE_CACHE].includes(key)) {
        return caches.delete(key);
      }
      return Promise.resolve();
    }));
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable();
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'DJ_SKIP_WAITING') {
    self.skipWaiting();
  }
});

async function trimCache(cacheName) {
  const limit = CACHE_ENTRY_LIMITS[cacheName];
  if (!limit) return;

  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= limit) return;

  await Promise.all(keys.slice(0, keys.length - limit).map((key) => cache.delete(key)));
}

async function maybeTrimCache(cacheName) {
  const limit = CACHE_ENTRY_LIMITS[cacheName];
  if (!limit) return;

  const now = Date.now();
  const lastTrim = cacheTrimTimestamps.get(cacheName) || 0;
  if (now - lastTrim < CACHE_TRIM_INTERVAL_MS) return;

  cacheTrimTimestamps.set(cacheName, now);
  await trimCache(cacheName);
}

async function putInCache(cacheName, request, response) {
  if (!response) return response;
  if (!(response.ok || response.type === 'opaque')) return response;
  const cache = await caches.open(cacheName);
  await cache.put(request, response.clone());
  await maybeTrimCache(cacheName);
  return response;
}

async function fetchWithTimeout(request, timeoutMs = 6500) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// Static assets and images should appear instantly from cache, then refresh in
// the background so returning shoppers see updates without a hard reload.
async function staleWhileRevalidate(request, cacheName, event, fallbackUrl = null) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetchWithTimeout(request)
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
  return fallbackUrl ? caches.match(fallbackUrl) : Response.error();
}

// Page navigations prefer the network so live catalog/page changes show quickly,
// but cached pages still keep the site usable during spotty mobile connections.
async function networkFirst(request, cacheName, fallbackUrl = '/offline.html', event = null, timeoutMs = 6500) {
  try {
    const preloadResponse = event?.preloadResponse ? await event.preloadResponse : null;
    if (preloadResponse) {
      await putInCache(cacheName, request, preloadResponse);
      return preloadResponse;
    }
    const response = await fetchWithTimeout(request, timeoutMs);
    await putInCache(cacheName, request, response);
    return response;
  } catch (error) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    return fallbackUrl ? caches.match(fallbackUrl) : Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isPageRequest = request.mode === 'navigate' || request.destination === 'document';
  const isImageRequest = request.destination === 'image';
  const isStaticAsset = STATIC_ASSET_DESTINATIONS.has(request.destination);
  const isCatalogData = isSameOrigin && (
    url.pathname.endsWith('.json')
    || url.pathname.endsWith('.webmanifest')
    || url.pathname.includes('products-data-')
  );
  const isRemoteCatalog = SUPABASE_HOST_PATTERN.test(url.hostname);
  const hasAuthorizationHeader = request.headers.has('authorization');
  const shouldBypassCache = isSameOrigin && CACHE_BYPASS_PATHS.has(url.pathname);

  // Authenticated Supabase calls may include user-specific data, so let the
  // browser/network handle them instead of writing those responses to cache.
  if (isRemoteCatalog && hasAuthorizationHeader) {
    return;
  }

  if (shouldBypassCache) {
    return;
  }

  if (isPageRequest) {
    event.respondWith(networkFirst(request, RUNTIME_CACHE, '/offline.html', event));
    return;
  }

  if (isImageRequest) {
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, event, null));
    return;
  }

  if (isCatalogData) {
    // Product bundles and JSON should favor freshness so live listing, price,
    // and image corrections appear immediately, with cache as the offline backup.
    event.respondWith(networkFirst(request, CATALOG_CACHE, null, event, 4000));
    return;
  }

  if (isStaticAsset) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE, event, null));
    return;
  }

  if (isRemoteCatalog) {
    event.respondWith(networkFirst(request, CATALOG_CACHE, null, event));
  }
});