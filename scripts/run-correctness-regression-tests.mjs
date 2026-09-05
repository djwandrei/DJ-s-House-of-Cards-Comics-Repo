#!/usr/bin/env node
/**
 * Deterministic local safeguards for checkout intent cancellation, cart
 * reconciliation, and resilient catalog-source selection. No network, payment,
 * Supabase write, or deployment is performed by this file.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreAssetVersion = readFileSync(path.join(root, 'core.js'), 'utf8')
  .match(/PRODUCT_ASSET_VERSION\s*=\s*'([^']+)'/)?.[1] || '';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  assert(left === right, `${message}\nExpected: ${right}\nActual: ${left}`);
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(String(key)) ? values.get(String(key)) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
    clear() { values.clear(); }
  };
}

function createClassList() {
  const values = new Set();
  return {
    add(...names) { names.forEach((name) => values.add(name)); },
    remove(...names) { names.forEach((name) => values.delete(name)); },
    contains(name) { return values.has(name); },
    toggle(name, force) {
      const next = force == null ? !values.has(name) : Boolean(force);
      if (next) values.add(name);
      else values.delete(name);
      return next;
    }
  };
}

function evaluateCore({
  pageHref = 'https://example.test/cart.html',
  coreScriptSrc = '/core.js?v=test'
} = {}) {
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const coreScript = { src: new URL(coreScriptSrc, pageHref).href };
  const document = {
    readyState: 'loading',
    body: { dataset: {}, classList: createClassList() },
    currentScript: coreScript,
    scripts: [coreScript],
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const window = {
    DJ: {},
    location: {
      pathname: new URL(pageHref).pathname,
      search: new URL(pageHref).search,
      href: pageHref
    },
    matchMedia() { return { matches: false, addEventListener() {} }; },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { callback(); }
  };
  const context = {
    window,
    document,
    localStorage,
    sessionStorage,
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    URL,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout
  };
  vm.runInNewContext(readFileSync(path.join(root, 'core.js'), 'utf8'), context, { filename: 'core.js' });
  return { DJ: window.DJ };
}

function testSharedAssetResolution() {
  const { DJ } = evaluateCore({
    pageHref: 'https://example.test/tools/index.html',
    coreScriptSrc: '../core.js?v=existing'
  });

  equal(
    DJ.versionedProductAsset('backend-config.js'),
    `/backend-config.js?v=${coreAssetVersion}`,
    'Nested pages must load shared scripts from the site root.'
  );
  equal(
    DJ.versionedProductAsset('products-public.json?segment=all'),
    `/products-public.json?segment=all&v=${coreAssetVersion}`,
    'Root resolution must preserve an existing query string before adding the cache version.'
  );
  equal(
    DJ.versionedProductAsset('/analytics.js'),
    `/analytics.js?v=${coreAssetVersion}`,
    'Already root-relative shared paths must remain stable.'
  );
}

function checkoutSessionId(name) {
  return `cs_test_${name.replace(/[^a-z0-9]/gi, '')}12345678`;
}

function evaluateSupabaseAdapter() {
  const window = {
    DJ: {},
    DJ_BACKEND_CONFIG: { enabled: false },
    location: { origin: 'https://example.test' },
    addEventListener() {}
  };
  const document = {
    visibilityState: 'visible',
    addEventListener() {},
    querySelector() { return null; },
    createElement() { return { addEventListener() {}, dataset: {} }; },
    head: { appendChild() {} }
  };
  vm.runInNewContext(
    readFileSync(path.join(root, 'supabase-client.js'), 'utf8'),
    { window, document, console, URL, setTimeout, clearTimeout },
    { filename: 'supabase-client.js' }
  );
  return window.DJ.remoteCatalog;
}

function evaluateCatalogQueryAdapter() {
  const queries = [];
  const publicRow = {
    id: 71,
    name: 'Public catalog fixture',
    category: 'Basketball',
    price: 12,
    metadata: { playerAthlete: 'Public Fixture' },
    is_deleted: false
  };
  const adminRow = {
    ...publicRow,
    item_photo_url: 'https://example.test/private-import-photo.jpg',
    item_photo_urls: ['https://example.test/private-import-photo.jpg'],
    html_full_link: 'https://example.test/private-import.html',
    html_image_urls: ['https://example.test/private-import-image.html'],
    sold_at: '2026-08-25T00:00:00.000Z',
    hidden_reason: 'Admin-only fixture',
    archived_at: '2026-08-25T01:00:00.000Z'
  };
  const client = {
    from(table) {
      const queryRecord = { table, selectColumns: '', filters: [] };
      queries.push(queryRecord);
      const query = {
        select(columns) {
          queryRecord.selectColumns = String(columns || '');
          return query;
        },
        eq(...args) {
          queryRecord.filters.push(['eq', ...args]);
          return query;
        },
        in(...args) {
          queryRecord.filters.push(['in', ...args]);
          return query;
        },
        order(...args) {
          queryRecord.filters.push(['order', ...args]);
          return query;
        },
        range(...args) {
          queryRecord.filters.push(['range', ...args]);
          return query;
        },
        limit(...args) {
          queryRecord.filters.push(['limit', ...args]);
          return query;
        },
        then(resolve, reject) {
          const data = table === 'products' ? [adminRow] : [publicRow];
          return Promise.resolve({ data, error: null }).then(resolve, reject);
        }
      };
      return query;
    }
  };
  const window = {
    DJ: {},
    DJ_BACKEND_CONFIG: {
      enabled: true,
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'test-browser-key',
      productsTable: 'products',
      storefrontProductsTable: 'storefront_products'
    },
    supabase: { createClient: () => client },
    location: { origin: 'https://example.test', href: 'https://example.test/shop.html' },
    addEventListener() {},
    setTimeout,
    clearTimeout
  };
  const document = {
    visibilityState: 'visible',
    scripts: [],
    addEventListener() {},
    querySelector() { return null; },
    createElement() { return { addEventListener() {}, dataset: {} }; },
    head: { appendChild() {} }
  };
  vm.runInNewContext(
    readFileSync(path.join(root, 'supabase-client.js'), 'utf8'),
    { window, document, console, URL, setTimeout, clearTimeout },
    { filename: 'supabase-client.js' }
  );
  return { adapter: window.DJ.remoteCatalog, queries };
}

function evaluatePinnedSupabaseLoaderFailure() {
  const scripts = [];
  const window = {
    DJ: {},
    DJ_BACKEND_CONFIG: {
      enabled: true,
      provider: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'test-browser-key'
    },
    location: { origin: 'https://example.test', href: 'https://example.test/shop.html' },
    addEventListener() {},
    setTimeout,
    clearTimeout
  };
  const document = {
    visibilityState: 'visible',
    addEventListener() {},
    querySelector(selector) {
      return scripts.find((script) => selector.includes(script.dataset.supabaseLibraryUrl)) || null;
    },
    createElement() {
      const listeners = new Map();
      return {
        dataset: {},
        addEventListener(type, listener) { listeners.set(type, listener); },
        removeEventListener(type, listener) {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
        remove() {},
        dispatch(type) { listeners.get(type)?.(); }
      };
    },
    head: {
      appendChild(script) {
        scripts.push(script);
        setTimeout(() => script.dispatch('error'), 0);
      }
    }
  };
  vm.runInNewContext(
    readFileSync(path.join(root, 'supabase-client.js'), 'utf8'),
    { window, document, console, URL, setTimeout, clearTimeout },
    { filename: 'supabase-client.js' }
  );
  return { adapter: window.DJ.remoteCatalog, scripts };
}

async function testPinnedSupabaseLoaderFailure() {
  const { adapter, scripts } = evaluatePinnedSupabaseLoaderFailure();
  await adapter.listProducts().then(
    () => { throw new Error('A failed local Supabase bundle must reject the public catalog request.'); },
    (error) => {
      assert(/local Supabase client library/i.test(String(error?.message || error)), 'SDK loader failures must name the local pinned bundle.');
    }
  );
  equal(scripts.length, 1, 'A Supabase SDK failure must not try another script host.');
  equal(
    scripts[0].src,
    'https://example.test/vendor/supabase.min.js?v=2.49.4',
    'The adapter must request only the pinned same-origin Supabase bundle.'
  );
}

function testCatalogImportStateIsolation() {
  const adapter = evaluateSupabaseAdapter();
  const product = {
    id: 501,
    name: 'State isolation fixture',
    category: 'Basketball',
    price: 10,
    checkoutPrice: 9,
    copyCount: 4,
    quantityAvailable: 0,
    checkoutEnabled: false,
    saleStatus: 'sold',
    soldAt: '2026-08-14T00:00:00.000Z',
    hiddenReason: 'Sold elsewhere',
    archivedAt: '2026-08-14T01:00:00.000Z',
    isDeleted: true,
    metadata: {
      manufacturer: 'Fixture Brand',
      sold_via: 'stale-static-source',
      stripe_session_id: 'stale-static-session',
      last_shopify_inventory_at: '2026-08-14T01:00:00.000Z'
    }
  };
  const contentOnly = adapter.toRemoteProduct(product);
  for (const field of [
    'copy_count', 'quantity_available', 'checkout_enabled', 'sale_status',
    'sold_at', 'hidden_reason', 'archived_at', 'is_deleted'
  ]) {
    assert(!Object.prototype.hasOwnProperty.call(contentOnly, field), `Catalog imports must omit live operational field ${field}.`);
  }
  assert(contentOnly.checkout_price === 9, 'Catalog imports should retain explicit catalog checkout pricing.');
  equal(contentOnly.metadata, { manufacturer: 'Fixture Brand' }, 'Catalog imports must strip stale operational metadata.');

  const editorPayload = adapter.toRemoteProduct(product, { includeOperationalState: true });
  assert(editorPayload.quantity_available === 0, 'Explicit listing edits must retain quantity changes.');
  assert(editorPayload.sale_status === 'sold' && editorPayload.is_deleted === true, 'Explicit listing edits must retain live state changes.');
  assert(editorPayload.metadata.stripe_session_id === 'stale-static-session', 'Explicit editor saves should retain the complete loaded metadata object.');
}

async function testPublicAndAdminCatalogFieldSeparation() {
  const { adapter, queries } = evaluateCatalogQueryAdapter();
  const publicProducts = await adapter.listProducts({ force: true });
  const adminProducts = await adapter.listAdminProducts();
  const publicQuery = queries.find((query) => query.table === 'storefront_products');
  const adminQuery = queries.find((query) => query.table === 'products');

  assert(publicQuery, 'Storefront catalog reads must use the buyer-safe storefront_products projection.');
  assert(adminQuery, 'Admin catalog reads must use the protected products table.');

  const publicColumns = publicQuery.selectColumns.split(',');
  const adminColumns = adminQuery.selectColumns.split(',');
  const adminOnlyColumns = [
    'item_photo_url',
    'item_photo_urls',
    'html_full_link',
    'html_image_urls',
    'sold_at',
    'hidden_reason',
    'archived_at'
  ];
  for (const column of adminOnlyColumns) {
    assert(!publicColumns.includes(column), `Public catalog queries must not select private admin field ${column}.`);
    assert(adminColumns.includes(column), `Admin catalog queries must retain protected field ${column}.`);
  }

  assert(publicProducts[0].itemPhotoUrl === '', 'Public catalog mapping must not receive import-photo URLs.');
  assert(publicProducts[0].htmlFullLink === '', 'Public catalog mapping must not receive source HTML links.');
  assert(adminProducts[0].itemPhotoUrl === 'https://example.test/private-import-photo.jpg', 'Admin catalog mapping must retain private import-photo URLs.');
  assert(adminProducts[0].htmlFullLink === 'https://example.test/private-import.html', 'Admin catalog mapping must retain private source HTML links.');
}

async function testBoundedRemoteCatalogCache() {
  const { adapter, queries } = evaluateCatalogQueryAdapter();
  // Each direct ID lookup has its own cache key. Sequential requests represent
  // a long browsing session without relying on timing-sensitive TTL expiry.
  for (let productId = 1; productId <= 129; productId += 1) {
    await adapter.listProducts({ ids: [productId] });
  }

  const queriesBeforeOldestRetry = queries.length;
  await adapter.listProducts({ ids: [1] });
  assert(
    queries.length === queriesBeforeOldestRetry + 1,
    'The oldest remote cache entry must be evicted once the bounded cache is full.'
  );

  const queriesBeforeRecentRetry = queries.length;
  await adapter.listProducts({ ids: [129] });
  assert(
    queries.length === queriesBeforeRecentRetry,
    'A recent remote cache entry must remain available after oldest-entry eviction.'
  );
}

function testCartReconciliation() {
  const { DJ } = evaluateCore();

  const multi = checkoutSessionId('multi');
  DJ.setCart([{ productId: 1, quantity: 2 }, { productId: 2, quantity: 1 }]);
  DJ.recordCheckoutCartSnapshot(multi, DJ.getCart());
  equal(DJ.reconcileCartAfterCheckoutSuccess(multi), { reconciled: true, changed: true, itemsRemoved: 3 }, 'Multi-item checkout should remove only its snapshot quantities.');
  equal(DJ.getCart(), [], 'Multi-item checkout should leave no purchased items.');

  const single = checkoutSessionId('single');
  DJ.setCart([{ productId: 9, quantity: 1 }]);
  DJ.recordCheckoutCartSnapshot(single, DJ.getCart());
  equal(DJ.reconcileCartAfterCheckoutSuccess(single), { reconciled: true, changed: true, itemsRemoved: 1 }, 'Single-item checkout should reconcile safely.');
  equal(DJ.getCart(), [], 'Single checkout should remove the purchased item.');

  const crossTab = checkoutSessionId('cross-tab');
  DJ.setCart([{ productId: 3, quantity: 1 }]);
  DJ.recordCheckoutCartSnapshot(crossTab, DJ.getCart());
  DJ.setCart([{ productId: 3, quantity: 2 }, { productId: 4, quantity: 1 }]);
  equal(DJ.reconcileCartAfterCheckoutSuccess(crossTab), { reconciled: true, changed: true, itemsRemoved: 1 }, 'Cross-tab additions should only subtract the original checkout quantity.');
  equal(DJ.getCart(), [{ productId: 3, quantity: 1 }, { productId: 4, quantity: 1 }], 'Cross-tab cart additions must survive checkout reconciliation.');
  equal(DJ.reconcileCartAfterCheckoutSuccess(crossTab), { reconciled: false, changed: false, itemsRemoved: 0 }, 'Repeated success-page loads must not remove cart items twice.');

  DJ.setCart([{ productId: 11, quantity: 1 }]);
  equal(DJ.reconcileCartAfterCheckoutSuccess('not-a-stripe-session'), { reconciled: false, changed: false, itemsRemoved: 0 }, 'Malformed session parameters must not change the cart.');
  equal(DJ.getCart(), [{ productId: 11, quantity: 1 }], 'Malformed session parameters must preserve the latest cart.');
}

async function testVerifiedCheckoutReconciliation() {
  const { DJ } = evaluateCore();
  const paidSession = checkoutSessionId('verified-paid');
  DJ.setCart([{ productId: 21, quantity: 2 }]);
  DJ.recordCheckoutCartSnapshot(paidSession, [{ productId: 21, quantity: 1 }]);
  const paid = await DJ.confirmCheckoutSuccessAndReconcile(paidSession, {
    verifySession: async () => ({ status: 'paid' }),
    maxAttempts: 1,
    delayMs: 0
  });
  assert(paid.verification.status === 'paid', 'A server-confirmed paid checkout should be recognized.');
  equal(DJ.getCart(), [{ productId: 21, quantity: 1 }], 'Paid checkout should subtract only its saved quantity.');

  const pendingSession = checkoutSessionId('verified-pending');
  DJ.setCart([{ productId: 22, quantity: 1 }]);
  DJ.recordCheckoutCartSnapshot(pendingSession, DJ.getCart());
  const pending = await DJ.confirmCheckoutSuccessAndReconcile(pendingSession, {
    verifySession: async () => ({ status: 'pending' }),
    maxAttempts: 2,
    delayMs: 0
  });
  assert(pending.verification.status === 'pending', 'A pending server order should remain pending after bounded polling.');
  equal(DJ.getCart(), [{ productId: 22, quantity: 1 }], 'Pending checkout must leave the cart untouched.');
  const eventuallyPaid = await DJ.confirmCheckoutSuccessAndReconcile(pendingSession, {
    verifySession: async () => ({ status: 'paid' }),
    maxAttempts: 1,
    delayMs: 0
  });
  assert(eventuallyPaid.reconciliation.changed, 'A later paid confirmation should still consume the preserved snapshot.');
  equal(DJ.getCart(), [], 'The preserved snapshot should reconcile exactly once after payment is confirmed.');

  const failedSession = checkoutSessionId('verification-failed');
  DJ.setCart([{ productId: 23, quantity: 1 }]);
  DJ.recordCheckoutCartSnapshot(failedSession, DJ.getCart());
  const unavailable = await DJ.confirmCheckoutSuccessAndReconcile(failedSession, {
    verifySession: async () => { throw new Error('mock network failure'); },
    maxAttempts: 2,
    delayMs: 0
  });
  assert(unavailable.verification.status === 'unavailable', 'Verification errors must fail closed.');
  equal(DJ.getCart(), [{ productId: 23, quantity: 1 }], 'Failed verification must preserve the cart and checkout snapshot.');

  let malformedCalls = 0;
  const malformed = await DJ.confirmCheckoutSuccessAndReconcile('bad-session', {
    verifySession: async () => { malformedCalls += 1; return { status: 'paid' }; },
    maxAttempts: 1,
    delayMs: 0
  });
  assert(malformed.verification.status === 'invalid' && malformedCalls === 0, 'Malformed session ids must never reach the status endpoint.');
}

function evaluateCatalog({ remoteListProducts, staticFetch, backendConfig = {}, initialWishlist = [] }) {
  const source = readFileSync(path.join(root, 'catalog.js'), 'utf8');
  const hookedSource = source.replace(
    /\n  window\.closeModal = closeModal;[\s\S]*?\n\}\)\(\);\s*$/,
    `\n  window.__catalogTestHooks = {\n    getBestAvailableSourceResult,\n    firstSuccessfulResult,\n    getRankedSearchSuggestions,\n    sortProductAttributes,\n    normalizeTeamFacetValue,\n    normalizeProducts,\n    buildFacetSummary,\n    toCountedFacetOptions,\n    hasUsableCatalogSnapshot,\n    reconcileWishlistIds,\n    applyStaticLegacyListingOverlay,\n    loadProducts,\n    loadSavedProductsByIds,\n    clearCatalogDataCaches,\n    getTestWishlist: () => DJ.getWishlist()\n  };\n  window.closeModal = closeModal;\n  DJ.ensureCustomerAccountBridge = ensureCustomerAccountBridge;\n})();\n`
  );
  assert(hookedSource !== source, 'Could not install catalog test hooks.');
  const document = {
    readyState: 'loading',
    body: { dataset: {}, classList: createClassList() },
    addEventListener() {},
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const window = {
    DJ: {
      getWishlist: () => [...initialWishlist],
      setWishlist(items) {
        initialWishlist = [...items];
        return [...initialWishlist];
      },
      getPreloadedProductsForSource: () => null,
      loadPreloadedProductsForSource: async () => { throw new Error('No preloaded fixture'); },
      versionedProductAsset: (sourceName) => sourceName,
      fallbackByCategory: { Basketball: 'assets/basketball-placeholder.svg', Other: 'assets/other-placeholder.svg' },
      availableQuantity: (product) => Math.max(0, Number(product?.quantityAvailable ?? product?.copyCount ?? 1) || 0),
      safeExternalUrl: (value) => String(value || ''),
      payablePrice: (product) => {
        const price = Number(product?.price);
        return Number.isFinite(price) ? price : null;
      },
      remoteCatalog: {
        isConfigured: () => true,
        listProducts: remoteListProducts
      }
    },
    DJ_BACKEND_CONFIG: backendConfig,
    location: { protocol: 'https:', pathname: '/basketball-cards.html', search: '', href: 'https://example.test/basketball-cards.html' },
    matchMedia() { return { matches: false, addEventListener() {} }; },
    addEventListener() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { callback(); }
  };
  const quietConsole = { log() {}, warn() {}, error() {} };
  vm.runInNewContext(hookedSource, {
    window,
    document,
    fetch: staticFetch,
    URL,
    URLSearchParams,
    console: quietConsole,
    setTimeout,
    clearTimeout
  }, { filename: 'catalog.js' });
  return window.__catalogTestHooks;
}

function wait(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function staticResponse(products = []) {
  return { ok: true, status: 200, json: async () => products };
}

async function testCatalogFallbacks() {
  const remoteSlow = evaluateCatalog({
    remoteListProducts: async () => { await wait(480); return [{ id: 'remote-slow' }]; },
    staticFetch: async () => { throw new Error('Static source failed quickly'); }
  });
  let started = Date.now();
  let result = await remoteSlow.getBestAvailableSourceResult('remote-slow.json');
  assert(result.origin === 'remote' && result.products[0].id === 'remote-slow', 'A slow successful remote response must beat a failed static fallback.');
  assert(Date.now() - started >= 430, 'Remote-preference test returned before the slow remote source resolved.');

  const staticAfterDelay = evaluateCatalog({
    remoteListProducts: async () => { await wait(720); return [{ id: 'remote-late' }]; },
    staticFetch: async () => staticResponse([{ id: 'static-after-delay' }])
  });
  started = Date.now();
  result = await staticAfterDelay.getBestAvailableSourceResult('static-after-delay.json');
  const staticElapsed = Date.now() - started;
  assert(result.origin === 'static-fast-fallback', 'Static catalog should become available after the configured fallback delay.');
  assert(staticElapsed >= 300 && staticElapsed < 680, `Static fallback timing should honor the 350ms delay; received ${staticElapsed}ms.`);

  const remoteRejects = evaluateCatalog({
    remoteListProducts: async () => { throw new Error('Remote rejected'); },
    staticFetch: async () => staticResponse([{ id: 'static-after-remote-rejection' }])
  });
  result = await remoteRejects.getBestAvailableSourceResult('remote-rejection.json');
  assert(result.origin === 'static-fast-fallback', 'A remote rejection must not prevent the delayed static fallback from succeeding.');

  const remoteTimeout = evaluateCatalog({
    remoteListProducts: () => new Promise(() => {}),
    staticFetch: async () => { await wait(520); return staticResponse([{ id: 'static-after-timeout' }]); }
  });
  started = Date.now();
  result = await remoteTimeout.getBestAvailableSourceResult('remote-timeout.json');
  assert(result.origin === 'static-fast-fallback', 'Static catalog should recover after a remote timeout.');
  assert(Date.now() - started >= 800, 'Remote timeout test completed before the 800ms timeout contract.');

  const bothFail = evaluateCatalog({
    remoteListProducts: async () => { throw new Error('Remote failed'); },
    staticFetch: async () => { throw new Error('Static failed'); }
  });
  await bothFail.getBestAvailableSourceResult('both-fail.json')
    .then(() => { throw new Error('Both failing sources should reject.'); })
    .catch((error) => {
      assert(/Remote and static catalog sources are unavailable/.test(error.message), 'Both-source failure should preserve a useful aggregate error.');
    });
}

function testCatalogSearchUtilities() {
  const catalog = evaluateCatalog({
    remoteListProducts: async () => [],
    staticFetch: async () => staticResponse([])
  });
  const suggestions = catalog.getRankedSearchSuggestions([
    { id: 'alpha', name: 'Rookie Alpha', _searchNormalized: 'rookie alpha' },
    { id: 'beta', name: 'Rookie Beta', _searchNormalized: 'rookie beta' },
    { id: 'later', name: 'Later Rookie', _searchNormalized: 'later rookie' },
    { id: 'none', name: 'Signed Card', _searchNormalized: 'signed card' }
  ], 'rookie', 2);
  equal(
    suggestions.map((entry) => entry.product.id),
    ['alpha', 'beta'],
    'Search suggestions must retain the existing score, name tie-breaker, and limit behavior.'
  );
  equal(catalog.getRankedSearchSuggestions([], 'rookie'), [], 'An empty catalog must produce no suggestions.');
  equal(
    catalog.sortProductAttributes(['Insert', 'Rookie', 'Autograph']),
    ['Autograph', 'Rookie', 'Insert'],
    'Attribute ordering must remain stable when its order index is reused.'
  );
  equal(
    [
      catalog.normalizeTeamFacetValue('Basketball', { category: 'Basketball' }),
      catalog.normalizeTeamFacetValue('Los Angeles Lakers', { category: 'Basketball' })
    ],
    ['', 'Los Angeles Lakers'],
    'Team facet normalization must retain category-aware generic-team handling.'
  );
  const normalizedProducts = catalog.normalizeProducts([{
    id: 41,
    name: 'Rookie Sample',
    category: 'Basketball',
    team: 'Basketball',
    price: 3,
    attributes: ['Autograph', 'Rookie'],
    metadata: { excelFields: { 'C:Features': 'Autograph|Rookie', 'C:Autographed': 'Yes' } }
  }]);
  equal(
    normalizedProducts.map((product) => ({ team: product.team, attributes: product.attributes, price: product._price })),
    [{ team: '', attributes: ['Autograph', 'Rookie'], price: 3 }],
    'Catalog normalization must retain team, attribute, and price output without cloning the full source item.'
  );
  const facets = catalog.buildFacetSummary([
    { conditionFacet: 'Graded', _teamFacet: 'Lakers', attributes: ['Autograph', 'Rookie'] },
    { conditionFacet: 'Ungraded', _teamFacet: 'Lakers', attributes: ['Rookie'] },
    { conditionFacet: 'Graded', _teamFacet: '', attributes: [] }
  ]);
  equal(
    catalog.toCountedFacetOptions(['Rookie', 'Autograph'], facets.attributeCounts, ['Autograph']),
    [
      { value: 'Autograph', count: 1, selected: true },
      { value: 'Rookie', count: 2, selected: false }
    ],
    'Facet option ordering and counts must stay stable after allocation reductions.'
  );

  const preservedWishlist = evaluateCatalog({
    remoteListProducts: async () => [],
    staticFetch: async () => staticResponse([]),
    initialWishlist: [41, 42]
  });
  equal(
    preservedWishlist.reconcileWishlistIds([], { persist: true }),
    [41, 42],
    'An unavailable/empty catalog snapshot must preserve the shopper wishlist.'
  );
  equal(preservedWishlist.getTestWishlist(), [41, 42], 'Empty catalog failures must not persist an erased wishlist.');
  equal(
    preservedWishlist.reconcileWishlistIds([{ id: 42 }], { persist: true }),
    [42],
    'A usable catalog snapshot should still remove genuinely stale wishlist ids.'
  );
}

async function testCatalogStaticOverlayPricePrecedence() {
  const catalog = evaluateCatalog({
    remoteListProducts: async () => [],
    staticFetch: async () => staticResponse([{
      id: 801,
      price: 12,
      priceLabel: '$12.00',
      displayPrice: '$12.00',
      description: 'Legacy fixture',
      legacyImageLabel: 'legacy-photo.jpg'
    }])
  });
  const livePrice = {
    id: 801,
    price: 18.5,
    priceLabel: '$18.50',
    displayPrice: '$18.50',
    description: 'Legacy fixture',
    legacyImageLabel: 'legacy-photo.jpg'
  };
  const [preserved] = await catalog.applyStaticLegacyListingOverlay('overlay-price.json', [livePrice]);
  equal(
    {
      price: preserved.price,
      priceLabel: preserved.priceLabel,
      displayPrice: preserved.displayPrice
    },
    { price: 18.5, priceLabel: '$18.50', displayPrice: '$18.50' },
    'A valid live catalog price must not be overwritten by a stale static fallback.'
  );

  const [recovered] = await catalog.applyStaticLegacyListingOverlay('overlay-price.json', [{
    ...livePrice,
    price: null,
    priceLabel: '',
    displayPrice: ''
  }]);
  equal(
    {
      price: recovered.price,
      priceLabel: recovered.priceLabel,
      displayPrice: recovered.displayPrice
    },
    { price: 12, priceLabel: '$12.00', displayPrice: '$12.00' },
    'Static data may recover a price only when the live row has no numeric price.'
  );
}

async function testCatalogCacheInvalidation() {
  let requestCount = 0;
  const catalog = evaluateCatalog({
    remoteListProducts: async () => [{
      id: 901,
      name: `Cache fixture ${++requestCount}`,
      category: 'Basketball',
      price: 10
    }],
    staticFetch: async () => staticResponse([])
  });

  const first = await catalog.loadProducts({ source: 'cache-fixture.json' });
  const cached = await catalog.loadProducts({ source: 'cache-fixture.json' });
  assert(requestCount === 1, 'A fresh catalog source should reuse its normalized in-memory result.');
  assert(first[0].name === cached[0].name, 'Cached catalog reads must preserve the first normalized snapshot.');

  catalog.clearCatalogDataCaches();
  const refreshed = await catalog.loadProducts({ source: 'cache-fixture.json' });
  assert(requestCount === 2, 'Catalog cache invalidation must request a new remote snapshot.');
  assert(refreshed[0].name === 'Cache fixture 2', 'A refreshed catalog read must not reuse the pre-invalidation object.');
}

async function testSavedProductIdLookup() {
  const remoteRequests = [];
  let staticFetches = 0;
  const remoteFirst = evaluateCatalog({
    remoteListProducts: async (options) => {
      remoteRequests.push(options);
      return [
        { id: 12, name: 'Twelve fixture', category: 'Basketball', price: 12 },
        { id: 7, name: 'Seven fixture', category: 'Basketball', price: 7 }
      ];
    },
    staticFetch: async () => {
      staticFetches += 1;
      return staticResponse([]);
    }
  });
  const remoteResult = await remoteFirst.loadSavedProductsByIds([12, 7, 12]);
  equal(remoteRequests, [{ ids: [12, 7] }], 'Saved product lookup must make one de-duplicated direct-ID remote request.');
  equal(remoteResult.products.map((product) => product.id), [12, 7], 'Saved product lookup must preserve shopper-saved ID order.');
  assert(remoteResult.isUsable && remoteResult.origin === 'remote-ids', 'A successful direct-ID response is authoritative even for a small saved set.');
  assert(staticFetches === 0, 'A successful direct-ID remote lookup must not fetch the full static catalog.');

  const noLongerAvailable = evaluateCatalog({
    remoteListProducts: async () => [],
    staticFetch: async () => {
      throw new Error('Static data must not revive a product omitted by the authoritative remote lookup.');
    }
  });
  const emptyResult = await noLongerAvailable.loadSavedProductsByIds([44]);
  assert(emptyResult.isUsable && emptyResult.products.length === 0, 'An empty successful remote lookup must be treated as a valid current inventory answer.');

  let fallbackFetches = 0;
  const staticFallback = evaluateCatalog({
    remoteListProducts: async () => { throw new Error('Remote unavailable'); },
    staticFetch: async () => {
      fallbackFetches += 1;
      return staticResponse([
        { id: 22, name: 'Twenty-two fixture', category: 'Basketball', price: 22 },
        { id: 31, name: 'Thirty-one fixture', category: 'Basketball', price: 31 }
      ]);
    }
  });
  const fallbackResult = await staticFallback.loadSavedProductsByIds([31]);
  equal(fallbackResult.products.map((product) => product.id), [31], 'Static fallback must still resolve requested saved IDs when remote catalog access fails.');
  assert(fallbackResult.isUsable && fallbackFetches === 1, 'Static fallback should be attempted once after a direct-ID remote failure.');
}

function evaluateDeferredAnalytics(origin) {
  const requests = [];
  const document = {
    readyState: 'complete',
    addEventListener() {
      throw new Error('DOMContentLoaded must not be awaited after the document is complete.');
    }
  };
  const window = {
    DJ: {},
    DJ_BACKEND_CONFIG: {
      measurementEnabled: true,
      supabaseUrl: 'https://example.supabase.co',
      supabasePublishableKey: 'publishable-test-key',
      analyticsEventFunction: 'analytics-event',
      measurementAllowedOrigins: ['https://www.djshouseofcards-comics.com']
    },
    location: { origin, pathname: '/shop.html' },
    addEventListener() {}
  };
  vm.runInNewContext(readFileSync(path.join(root, 'analytics.js'), 'utf8'), {
    window,
    document,
    fetch: (url, options) => {
      requests.push({ url, options });
      return Promise.resolve({ ok: true });
    },
    console
  }, { filename: 'analytics.js' });
  return requests;
}

function testDeferredAnalyticsPageView() {
  const productionRequests = evaluateDeferredAnalytics('https://www.djshouseofcards-comics.com');
  assert(productionRequests.length === 1, 'Deferred analytics loading must record exactly one page view after DOMContentLoaded.');
  const payload = JSON.parse(productionRequests[0].options.body);
  assert(payload.event === 'page_view' && payload.page === '/shop.html', 'Deferred analytics must preserve the page-view payload.');
  assert(evaluateDeferredAnalytics('http://127.0.0.1:4173').length === 0, 'Local previews must not send production analytics or create CORS noise.');
}

function testMetricsAggregation() {
  const source = readFileSync(path.join(root, 'metrics.js'), 'utf8');
  const hookedSource = source.replace(
    /\n  loadReport\(\);\s*\n\}\)\(\);\s*$/,
    '\n  window.__metricsTestHooks = { totalContactSubmissions };\n})();\n'
  );
  assert(hookedSource !== source, 'Could not install metrics test hooks.');
  const mount = { addEventListener() {}, innerHTML: '' };
  const window = { DJ: {} };
  const document = { getElementById: (id) => id === 'metricsMount' ? mount : null };
  vm.runInNewContext(hookedSource, { window, document, console, Intl }, { filename: 'metrics.js' });
  assert(window.__metricsTestHooks.totalContactSubmissions({ contact_submit: 10, inquiry_submit: 2 }) === 12, 'Contact and inquiry totals must be added numerically, not concatenated.');
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function evaluatePayments({
  signIn,
  invokeFunction,
  getSession = async () => ({ user: { email: 'collector@example.com' } }),
  syncWishlistWithAccount = async () => {}
}) {
  const source = readFileSync(path.join(root, 'payments.js'), 'utf8');
  const hookedSource = source.replace(
    '  DJ.payments = {',
    `  window.__paymentsTestHooks = {
    closeAuthModal,
    continueAsGuestFromModal,
    continueCheckoutIfExistingSession,
    signInFromModal,
    startCheckoutItems,
    showCheckoutMessage,
    getState: () => ({ ...state }),
    setAuthenticatedSession(session) {
      state.session = session;
      state.authReady = Boolean(session?.user);
    },
    setPendingCheckout(request) {
      state.pendingCheckoutRequest = request;
      state.activeCheckoutIntentId = request?.intentId || '';
      state.checkoutInFlight = false;
      state.authReady = false;
      state.session = null;
    }
  };

  DJ.payments = {`
  );
  assert(hookedSource !== source, 'Could not install payment test hooks.');
  const cartStatus = { hidden: false, textContent: '', dataset: {}, closest: () => null };
  const fields = {
    customerAuthEmail: { value: 'collector@example.com', focus() {} },
    customerAuthPassword: { value: 'test-password', focus() {} },
    cartStatus
  };
  const document = {
    readyState: 'loading',
    body: {
      classList: createClassList(),
      dataset: {},
      appendChild(element) {
        if (element?.id) fields[element.id] = element;
      }
    },
    activeElement: null,
    addEventListener() {},
    getElementById(id) { return fields[id] || null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return {
        dataset: {},
        classList: createClassList(),
        setAttribute() {},
        querySelector() { return null; },
        querySelectorAll() { return []; }
      };
    }
  };
  let invokeCount = 0;
  const invocations = [];
  const backgroundSyncWarnings = [];
  const testConsole = {
    log: (...args) => console.log(...args),
    warn: (...args) => backgroundSyncWarnings.push(args),
    error: (...args) => backgroundSyncWarnings.push(args)
  };
  const window = {
    DJ: {
      normalizeProductId: (value) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
      normalizeCartQuantity: (value) => Math.max(1, Math.min(99, Math.floor(Number(value) || 1))),
      isDirectCheckoutEligible: () => true,
      availableQuantity: () => 9,
      syncWishlistWithAccount,
      clearAccountWishlistCache() {},
      restoreFocus() {},
      trackEvent() {},
      remoteCatalog: {
        isConfigured: () => true,
        signIn,
        signUp: async () => ({}),
        getSession,
        onAuthStateChange() {},
        invokeFunction: async (...args) => {
          invokeCount += 1;
          invocations.push(args);
          return invokeFunction(...args);
        }
      }
    },
    DJ_BACKEND_CONFIG: {
      stripeCheckoutEnabled: true,
      stripeCheckoutFunction: 'create-checkout-session',
      stripeGuestCheckoutEnabled: true
    },
    location: { pathname: '/cart.html', search: '', href: 'https://example.test/cart.html', assign() {} },
    addEventListener() {},
    dispatchEvent() {},
    setTimeout,
    clearTimeout,
    requestAnimationFrame(callback) { callback(); }
  };
  const context = {
    window,
    document,
    sessionStorage: createStorage(),
    CustomEvent: class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    HTMLElement: class HTMLElement {},
    console: testConsole,
    setTimeout,
    clearTimeout,
    URLSearchParams
  };
  vm.runInNewContext(hookedSource, context, { filename: 'payments.js' });
  return {
    hooks: window.__paymentsTestHooks,
    cartStatus,
    getInvokeCount: () => invokeCount,
    getInvocations: () => invocations.map(([name, payload]) => ({ name, payload: { ...payload } })),
    getAuthModal: () => fields.customerAuthModal || null,
    getBackgroundSyncWarnings: () => [...backgroundSyncWarnings]
  };
}

async function testCheckoutIdentityPayloads() {
  const guest = evaluatePayments({
    signIn: async () => ({}),
    getSession: async () => null,
    invokeFunction: async () => { throw new Error('Mock guest checkout failure.'); }
  });
  guest.hooks.setPendingCheckout({
    items: [{ productId: 2, quantity: 1, product: { id: 2 } }],
    options: {},
    returnPath: '/cart.html',
    intentId: 'checkout-guest-payload'
  });
  await guest.hooks.continueAsGuestFromModal();
  equal(guest.getInvokeCount(), 1, 'Guest checkout must invoke the Edge Function exactly once through the mocked adapter.');
  const guestRequest = guest.getInvocations()[0];
  equal(guestRequest.name, 'create-checkout-session', 'Guest checkout must use the configured Edge Function name.');
  equal(guestRequest.payload.guestEmail, 'collector@example.com', 'Guest checkout must pass the validated email address to the Edge Function.');
  assert(!Object.prototype.hasOwnProperty.call(guestRequest.payload, 'guestCheckout'), 'The browser-only guest marker must not be sent to the Edge Function.');
  assert(!Object.prototype.hasOwnProperty.call(guestRequest.payload, 'password'), 'Guest checkout must never send the account password to the Edge Function.');

  const verified = evaluatePayments({
    signIn: async () => ({}),
    invokeFunction: async () => { throw new Error('Mock verified checkout failure.'); }
  });
  verified.hooks.setAuthenticatedSession({
    user: { id: 'verified-user', email: 'collector@example.com' }
  });
  await verified.hooks.startCheckoutItems([
    { productId: 3, quantity: 1, product: { id: 3 } }
  ], {}, '/cart.html');
  equal(verified.getInvokeCount(), 1, 'Verified checkout must invoke the Edge Function exactly once through the mocked adapter.');
  const verifiedRequest = verified.getInvocations()[0];
  equal(verifiedRequest.name, 'create-checkout-session', 'Verified checkout must use the configured Edge Function name.');
  assert(!Object.prototype.hasOwnProperty.call(verifiedRequest.payload, 'guestEmail'), 'Verified checkout must not send a guest email override to the Edge Function.');
  assert(!Object.prototype.hasOwnProperty.call(verifiedRequest.payload, 'guestCheckout'), 'Verified checkout must not send browser-only guest state to the Edge Function.');
}

async function testCheckoutIntentCancellation() {
  const pendingSession = createDeferred();
  const staleSession = evaluatePayments({
    signIn: async () => ({}),
    getSession: () => pendingSession.promise,
    invokeFunction: async () => ({ url: 'https://example.test/should-not-run' })
  });
  const sessionIntent = 'checkout-stale-session';
  staleSession.hooks.setPendingCheckout({
    items: [{ productId: 7, quantity: 1, product: { id: 7 } }],
    options: {},
    returnPath: '/cart.html',
    intentId: sessionIntent
  });
  staleSession.hooks.continueCheckoutIfExistingSession({}, '/cart.html', sessionIntent);
  staleSession.hooks.closeAuthModal();
  pendingSession.resolve({ user: { email: 'collector@example.com' } });
  await pendingSession.promise;
  await wait(0);
  assert(staleSession.getInvokeCount() === 0, 'A stale ensureAuthSession result after modal cancellation must never create a checkout session.');

  const pendingSignIn = createDeferred();
  const staleAuth = evaluatePayments({
    signIn: () => pendingSignIn.promise,
    invokeFunction: async () => ({ url: 'https://example.test/should-not-run' })
  });
  const staleIntent = 'checkout-stale-auth';
  staleAuth.hooks.setPendingCheckout({
    items: [{ productId: 1, quantity: 1, product: { id: 1 } }],
    options: {},
    returnPath: '/cart.html',
    intentId: staleIntent
  });
  const signInWork = staleAuth.hooks.signInFromModal();
  staleAuth.hooks.closeAuthModal();
  pendingSignIn.resolve({ user: { email: 'collector@example.com' } });
  await signInWork;
  assert(staleAuth.getInvokeCount() === 0, 'A stale authentication result after modal cancellation must never create a checkout session.');
  assert(staleAuth.hooks.getState().activeCheckoutIntentId === '', 'Closing the auth modal must invalidate the active checkout intent.');
  assert(/checkout request was canceled/i.test(staleAuth.cartStatus.textContent), 'Canceled authentication must report visible contextual feedback.');

  const unauthenticated = evaluatePayments({
    signIn: async () => ({}),
    getSession: async () => null,
    invokeFunction: async () => ({ url: 'https://example.test/should-not-run' })
  });
  await unauthenticated.hooks.startCheckoutItems([
    { productId: 2, quantity: 1, product: { id: 2 } }
  ], {}, '/cart.html');
  await wait(0);
  assert(unauthenticated.getInvokeCount() === 0, 'Unauthenticated checkout must never invoke the checkout Edge Function.');
  assert(unauthenticated.getAuthModal()?.classList.contains('active'), 'Unauthenticated checkout must keep the sign-in modal open.');
}

async function testWishlistSyncDoesNotBlockAuthenticatedCheckout() {
  const session = { user: { id: 'wishlist-sync-user', email: 'collector@example.com' } };
  const rejectedSync = evaluatePayments({
    signIn: async () => ({}),
    getSession: async () => session,
    syncWishlistWithAccount: async () => {
      throw new Error('Mock wishlist sync failure.');
    },
    invokeFunction: async () => ({ url: 'https://example.test/checkout/rejected-sync' })
  });
  const rejectedIntent = 'checkout-rejected-wishlist-sync';
  rejectedSync.hooks.setPendingCheckout({
    items: [{ productId: 4, quantity: 1, product: { id: 4 } }],
    options: {},
    returnPath: '/cart.html',
    intentId: rejectedIntent
  });
  rejectedSync.hooks.continueCheckoutIfExistingSession({}, '/cart.html', rejectedIntent);
  await wait(0);
  assert(rejectedSync.hooks.getState().session?.user?.id === session.user.id, 'A rejected wishlist sync must not clear a valid authenticated session.');
  assert(rejectedSync.hooks.getState().authReady, 'A rejected wishlist sync must leave auth ready for checkout.');
  assert(rejectedSync.getInvokeCount() === 1, 'A rejected wishlist sync must not block checkout continuation.');
  assert(rejectedSync.getBackgroundSyncWarnings().length === 1, 'Rejected wishlist sync must be handled as a background warning.');

  const hungSync = evaluatePayments({
    signIn: async () => ({}),
    getSession: async () => session,
    syncWishlistWithAccount: () => new Promise(() => {}),
    invokeFunction: async () => ({ url: 'https://example.test/checkout/hung-sync' })
  });
  const hungIntent = 'checkout-hung-wishlist-sync';
  hungSync.hooks.setPendingCheckout({
    items: [{ productId: 5, quantity: 1, product: { id: 5 } }],
    options: {},
    returnPath: '/cart.html',
    intentId: hungIntent
  });
  hungSync.hooks.continueCheckoutIfExistingSession({}, '/cart.html', hungIntent);
  await wait(0);
  assert(hungSync.hooks.getState().session?.user?.id === session.user.id, 'A hung wishlist sync must not clear a valid authenticated session.');
  assert(hungSync.hooks.getState().authReady, 'A hung wishlist sync must leave auth ready for checkout.');
  assert(hungSync.getInvokeCount() === 1, 'A hung wishlist sync must not block checkout continuation.');
}

async function main() {
  const { DJ } = evaluateCore();
  equal(DJ.escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;', 'HTML escaping must preserve every supported entity.');
  testSharedAssetResolution();
  testCatalogImportStateIsolation();
  await testPublicAndAdminCatalogFieldSeparation();
  await testBoundedRemoteCatalogCache();
  await testPinnedSupabaseLoaderFailure();
  testCartReconciliation();
  await testVerifiedCheckoutReconciliation();
  await testCatalogFallbacks();
  testCatalogSearchUtilities();
  await testCatalogStaticOverlayPricePrecedence();
  await testCatalogCacheInvalidation();
  await testSavedProductIdLookup();
  testDeferredAnalyticsPageView();
  testMetricsAggregation();
  await testCheckoutIdentityPayloads();
  await testCheckoutIntentCancellation();
  await testWishlistSyncDoesNotBlockAuthenticatedCheckout();
  console.log('Correctness regression tests passed: core helpers and nested asset paths, public/admin catalog separation, pinned SDK loading, cart reconciliation, catalog fallback/search, saved-state resilience, analytics/metrics, and guest/verified checkout payloads.');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
