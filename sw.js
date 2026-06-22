/**
 * Storefront service worker.
 *
 * The app shell is cached up front; catalog payloads and product images are
 * cached only after they are requested. Admin and Supabase traffic always
 * bypass caches so signed-in edits are immediately visible.
 */

const CACHE_VERSION = 'dj-house-v2026-06-21-01';
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
const CACHE_BYPASS_PATHS = new Set(['/admin.html', '/account.html', '/cart.html', '/checkout-success.html']);

// Keep the offline shell limited to the app frame. Large decorative and product
// images are collected by runtime caching only after a shopper actually sees them.
const APP_SHELL_ASSETS = [
  '/offline.html',
  '/styles.css?v=20260621a',
  '/styles-mobile-overrides.css?v=20260621a',
  '/core.js?v=20260621a',
  '/seo.js?v=20260621a',
  '/site.webmanifest?v=20260621a',
  '/offline.js?v=20260621a',
  '/assets/dj-logo.png',
  '/assets/icons/favicon-32.png',
  '/assets/icons/icon-192.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await Promise.all(APP_SHELL_ASSETS.map(async (asset) => {
      try {
        await cache.add(asset);
      } catch {
        // Individual asset failures should not abort the offline shell install.
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const activeCaches = new Set([SHELL_CACHE, RUNTIME_CACHE, CATALOG_CACHE, IMAGE_CACHE]);
    await Promise.all(keys.filter((key) => !activeCaches.has(key)).map((key) => caches.delete(key)));
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
  await cache.put(request, response);
  await maybeTrimCache(cacheName);
  return response;
}

function scheduleCacheWrite(event, cacheName, request, response) {
  if (!response || !(response.ok || response.type === 'opaque')) return;
  let cacheableResponse;
  try {
    // Clone before returning the original response to the page. Waiting until
    // after caches.open() can be too late because the browser may already have
    // started consuming the original response body.
    cacheableResponse = response.clone();
  } catch {
    return;
  }
  const cacheWrite = putInCache(cacheName, request, cacheableResponse).catch(() => null);
  if (event && typeof event.waitUntil === 'function') {
    try {
      event.waitUntil(cacheWrite);
    } catch {
      // The response should still reach the page if the fetch event has already
      // left the phase where it accepts additional background work.
    }
  }
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
async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetchWithTimeout(request)
    .then((response) => {
      scheduleCacheWrite(event, cacheName, request, response);
      return response;
    })
    .catch(() => null);

  if (cached) {
    if (event && typeof event.waitUntil === 'function') {
      event.waitUntil(networkPromise);
    }
    return cached;
  }

  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;
  return Response.error();
}

function isTransientHttpFailure(response) {
  if (!response) return true;
  return response.status === 408
    || response.status === 425
    || response.status === 429
    || response.status >= 500;
}

async function matchCachedFallback(request, fallbackUrl = null) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fallbackUrl ? caches.match(fallbackUrl) : null;
}

// Page navigations prefer the network so live catalog/page changes show quickly,
// but cached pages still keep the site usable during spotty mobile connections
// and brief server-side failures.
async function networkFirst(request, cacheName, fallbackUrl = '/offline.html', event = null, timeoutMs = 6500) {
  try {
    const preloadResponse = event?.preloadResponse ? await event.preloadResponse : null;
    if (preloadResponse) {
      if (isTransientHttpFailure(preloadResponse)) {
        return await matchCachedFallback(request, fallbackUrl) || preloadResponse;
      }
      scheduleCacheWrite(event, cacheName, request, preloadResponse);
      return preloadResponse;
    }
    const response = await fetchWithTimeout(request, timeoutMs);
    if (isTransientHttpFailure(response)) {
      return await matchCachedFallback(request, fallbackUrl) || response;
    }
    scheduleCacheWrite(event, cacheName, request, response);
    return response;
  } catch {
    return await matchCachedFallback(request, fallbackUrl) || Response.error();
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
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE, event));
    return;
  }

  if (isCatalogData) {
    // Product bundles and JSON should favor freshness so live listing, price,
    // and image corrections appear immediately, with cache as the offline backup.
    event.respondWith(networkFirst(request, CATALOG_CACHE, null, event, 4000));
    return;
  }

  if (isStaticAsset) {
    event.respondWith(staleWhileRevalidate(request, RUNTIME_CACHE, event));
    return;
  }

  if (isRemoteCatalog) {
    event.respondWith(networkFirst(request, CATALOG_CACHE, null, event));
  }
});

