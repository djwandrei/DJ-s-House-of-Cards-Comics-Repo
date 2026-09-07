import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const ORIGIN = 'https://djshouseofcards-comics.com';
const source = fs.readFileSync(new URL('../../sw.js', import.meta.url), 'utf8');
const cacheVersion = source.match(/const CACHE_VERSION = '([^']+)'/)?.[1];

function request(pathname, { destination = '', headers = {}, mode = 'cors' } = {}) {
  return {
    method: 'GET',
    url: new URL(pathname, ORIGIN).href,
    destination,
    headers: new Headers(headers),
    mode,
  };
}

function createHarness(fetchImpl = async (input) => new Response(`network:${typeof input === 'string' ? input : input.url}`)) {
  const handlers = new Map();
  const stores = new Map();
  const calls = { fetch: [], skipWaiting: 0, claim: 0, navigationPreload: 0 };
  const keyOf = (input) => typeof input === 'string' ? new URL(input, ORIGIN).href : input.url;
  let context;

  function cache(name) {
    if (!stores.has(name)) {
      const entries = new Map();
      stores.set(name, {
        async add(asset) {
          const response = await context.fetch(asset);
          if (!response?.ok) throw new Error(`Unable to cache ${asset}`);
          entries.set(keyOf(asset), response.clone());
        },
        async delete(input) {
          return entries.delete(keyOf(input));
        },
        async keys() {
          return [...entries.keys()].map((url) => ({ url }));
        },
        async match(input) {
          return entries.get(keyOf(input))?.clone();
        },
        async put(input, response) {
          entries.set(keyOf(input), response.clone());
        },
      });
    }
    return stores.get(name);
  }

  context = {
    AbortController,
    Date,
    Headers,
    Map,
    Promise,
    Request,
    Response,
    Set,
    URL,
    clearTimeout,
    setTimeout,
    caches: {
      async delete(name) {
        return stores.delete(name);
      },
      async keys() {
        return [...stores.keys()];
      },
      async match(input) {
        for (const store of stores.values()) {
          const response = await store.match(input);
          if (response) return response;
        }
        return undefined;
      },
      async open(name) {
        return cache(name);
      },
    },
    async fetch(input, init) {
      calls.fetch.push({ input, init });
      return fetchImpl(input, init);
    },
    self: {
      addEventListener(type, handler) {
        handlers.set(type, handler);
      },
      async skipWaiting() {
        calls.skipWaiting += 1;
      },
      clients: {
        async claim() {
          calls.claim += 1;
        },
      },
      location: { origin: ORIGIN },
      registration: {
        navigationPreload: {
          async enable() {
            calls.navigationPreload += 1;
          },
        },
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'sw.js' });

  const settle = async (waits) => {
    for (let index = 0; index < waits.length; index += 1) await waits[index];
  };
  const dispatch = async (type, properties = {}) => {
    const waits = [];
    let response;
    handlers.get(type)({
      ...properties,
      respondWith(value) {
        response = Promise.resolve(value);
      },
      waitUntil(value) {
        waits.push(Promise.resolve(value));
      },
    });
    return {
      handled: Boolean(response),
      response: response ? await response : undefined,
      settle: () => settle(waits),
    };
  };

  return {
    cache: (name) => cache(name),
    calls,
    dispatch,
    hasCache: (name) => stores.has(name),
  };
}

test('service worker installs a usable shell when an individual shell asset is unavailable', async () => {
  const harness = createHarness(async (input) => {
    if (String(input).includes('theme-init.js')) throw new Error('temporary network failure');
    return new Response('ok');
  });

  const event = await harness.dispatch('install');
  await event.settle();

  assert.equal(harness.calls.skipWaiting, 1);
  const shell = await harness.cache(`${cacheVersion}-shell`);
  assert.ok(await shell.match('/offline.html'));
  assert.equal(await shell.match('/theme-init.js?v=20260907c'), undefined);
});

test('service worker returns stale static assets immediately and refreshes them in the background', async () => {
  const harness = createHarness(async () => new Response('fresh stylesheet'));
  const asset = request('/tools/fan-tools.css?v=20260907c', { destination: 'style' });
  const runtime = await harness.cache(`${cacheVersion}-runtime`);
  await runtime.put(asset, new Response('cached stylesheet'));

  const event = await harness.dispatch('fetch', { request: asset });
  assert.equal(event.handled, true);
  assert.equal(await event.response.text(), 'cached stylesheet');
  await event.settle();
  assert.equal(await (await runtime.match(asset)).text(), 'fresh stylesheet');
});

test('service worker keeps authenticated and checkout requests out of Cache Storage', async () => {
  const harness = createHarness(async () => new Response('network only'));
  const authenticated = await harness.dispatch('fetch', {
    request: request('https://project.supabase.co/rest/v1/products', {
      headers: { authorization: 'Bearer user-token' },
    }),
  });
  const checkout = await harness.dispatch('fetch', { request: request('/cart.html', { mode: 'navigate' }) });

  assert.equal(authenticated.handled, false);
  assert.equal(checkout.handled, false);
  assert.equal(harness.calls.fetch.length, 0);
});

test('service worker falls back to a cached page after a transient navigation failure', async () => {
  const harness = createHarness(async () => new Response('upstream unavailable', { status: 503 }));
  const page = request('/shop.html', { mode: 'navigate' });
  const runtime = await harness.cache(`${cacheVersion}-runtime`);
  await runtime.put(page, new Response('cached shop page'));

  const event = await harness.dispatch('fetch', { request: page, preloadResponse: null });
  assert.equal(event.handled, true);
  assert.equal(await event.response.text(), 'cached shop page');
  await event.settle();
});

test('service worker activation retires only obsolete storefront cache generations', async () => {
  const harness = createHarness();
  await harness.cache('dj-house-v2026-09-01-1-runtime');
  await harness.cache('unrelated-tool-cache');

  const event = await harness.dispatch('activate');
  await event.settle();

  assert.equal(harness.hasCache('dj-house-v2026-09-01-1-runtime'), false);
  assert.equal(harness.hasCache('unrelated-tool-cache'), true);
  assert.equal(harness.calls.navigationPreload, 1);
  assert.equal(harness.calls.claim, 1);
});
