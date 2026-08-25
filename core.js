/**
 * Core utilities shared by every page.
 * -----------------------------------------------------------------------------
 * This module creates the global window.DJ namespace and attaches the low-level
 * helpers that the rest of the site depends on: HTML escaping, image fallback
 * handling, theme persistence, wishlist storage, and a few
 * accessibility helpers such as focus restoration and status messaging.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const preloadedProductsBySource = new Map();
  const preloadedBundlePromises = new Map();
  const scriptLoadPromises = new Map();
  const HTML_ESCAPE_PATTERN = /[&<>"']/g;
  const HTML_ESCAPE_ENTITIES = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  });
  // Bump this whenever storefront product bundles change so JSON/script fallbacks
  // immediately bypass stale browser and service-worker catalog caches.
  const PRODUCT_ASSET_VERSION = '20260825a';
  const ASSET_HELPER_CACHE_LIMIT = 5000;
  // Below this width the theme button moves into the open navigation drawer so
  // the header can preserve the logo/menu lockup without duplicating controls.
  const MOBILE_THEME_BREAKPOINT = 700;
  const MOBILE_THEME_QUERY = typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${MOBILE_THEME_BREAKPOINT}px)`)
    : null;
  // Generated fallbacks expose both a script and a global. Keep those names
  // paired so adding a catalog segment cannot update one registry but not the other.
  const PRELOADED_PRODUCT_BUNDLES = {
    'products.json': ['products-data-full.js', 'DJ_PRODUCTS_FULL'],
    'products-baseball.json': ['products-data-baseball.js', 'DJ_PRODUCTS_BASEBALL'],
    'products-basketball.json': ['products-data-basketball.js', 'DJ_PRODUCTS_BASKETBALL'],
    'products-football.json': ['products-data-football.js', 'DJ_PRODUCTS_FOOTBALL'],
    'products-comics.json': ['products-data-comics.js', 'DJ_PRODUCTS_COMICS'],
    'products-collectibles.json': ['products-data-collectibles.js', 'DJ_PRODUCTS_COLLECTIBLES'],
    'products-sports.json': ['products-data-sports.js', 'DJ_PRODUCTS_SPORTS'],
    'products-featured.json': ['products-data-featured.js', 'DJ_PRODUCTS_FEATURED']
  };
  const CATEGORY_PAGE_ROUTES = [
    [/baseball/, 'baseball-cards.html'],
    [/basketball/, 'basketball-cards.html'],
    [/football/, 'football-cards.html'],
    [/comic/, 'comics.html'],
    [/collect/, 'collectibles.html']
  ];
  const MARKETPLACE_LINKS = [
    ['Whatnot', 'https://www.whatnot.com/user/djshouseofcards'],
    ['Shopify Store', 'https://xy2hik-nq.myshopify.com/'],
    ['TikTok Shop', 'https://www.tiktok.com/@djshouseofcards/shop']
  ];
  const FOOTER_POLICY_LINKS = [
    ['Policies & Authenticity', 'policies.html'],
    ['Shipping', 'shipping.html'],
    ['Returns', 'returns.html']
  ];
  const FOOTER_BROWSE_HREFS = new Set([
    'sports-cards.html',
    'comics.html',
    'collectibles.html'
  ]);
  const FOOTER_UTILITY_HREFS = new Set([
    'wishlist.html',
    'cart.html'
  ]);

  // Centralize localStorage keys so future refactors only need to update them in one place.
  const STORAGE_KEYS = {
    theme: 'theme',
    wishlist: 'wishlist',
    wishlistBackendMigration: 'wishlistBackendMigration',
    cart: 'cart'
  };
  const CHECKOUT_CART_SNAPSHOT_KEY_PREFIX = 'djCheckoutCartSnapshot:';
  const CHECKOUT_CART_SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const CHECKOUT_SESSION_ID_PATTERN = /^cs_(?:test_|live_)?[A-Za-z0-9_]{8,255}$/;
  const safeAssetUrlCache = new Map();
  const assetUrlCandidatesCache = new Map();
  const thumbnailAssetUrlCache = new Map();
  const thumbnailAssetCandidatesCache = new Map();

  function setBoundedCacheValue(cache, key, value) {
    if (!cache.has(key) && cache.size >= ASSET_HELPER_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        cache.delete(oldestKey);
      }
    }

    cache.set(key, value);
    return value;
  }

  function getBoundedCachedValue(cache, key, createValue) {
    if (cache.has(key)) {
      return cache.get(key);
    }

    return setBoundedCacheValue(cache, key, createValue());
  }

  function versionedProductAsset(path) {
    return `${path}${path.includes('?') ? '&' : '?'}v=${PRODUCT_ASSET_VERSION}`;
  }

  function versionedLocalProductImage(path) {
    if (!/^assets\//i.test(path) || /(?:[?&])v=/.test(path)) {
      return path;
    }
    return versionedProductAsset(path);
  }

  function loadScript(src) {
    if (!src) {
      return Promise.reject(new Error('Choose a script to load.'));
    }

    if (scriptLoadPromises.has(src)) {
      return scriptLoadPromises.get(src);
    }

    const pending = new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[src="${src}"]`);
      if (existing?.dataset.loaded === 'true') {
        resolve(existing);
        return;
      }

      const script = existing || document.createElement('script');
      script.src = src;
      script.defer = true;

      script.addEventListener('load', () => {
        script.dataset.loaded = 'true';
        resolve(script);
      }, { once: true });
      script.addEventListener('error', () => {
        scriptLoadPromises.delete(src);
        reject(new Error(`Failed to load ${src}.`));
      }, { once: true });

      if (!existing) {
        document.head.appendChild(script);
      }
    });

    scriptLoadPromises.set(src, pending);
    return pending;
  }

  async function loadScriptsInOrder(sources = []) {
    for (const source of sources) {
      await loadScript(source);
    }
  }

  // Remember the last focused element so modal close handlers can restore focus
  // to the trigger that opened them. This keeps keyboard navigation predictable.
  let lastFocusedElement = null;
  let sharedImageLightbox = null;
  let serviceWorkerRefreshPending = false;
  let wishlistBackendSaveTimer = 0;
  let wishlistBackendSyncPromise = null;
  let wishlistLocalRevision = 0;

  // ---------------------------------------------------------------------------
  // Formatting and storage helpers
  // ---------------------------------------------------------------------------

  /**
   * Convert raw price values into the storefront display format.
   * Accepts numbers, strings with currency text, or empty values.
   */
  function formatCurrency(value) {
    if (value == null || value === '') {
      return 'Contact for price';
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
      return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    }

    const rawText = String(value).trim();
    const rangeMatch = rawText.match(/(\$?\s*-?\d[\d,]*\.?\d*)\s*(?:-|[\u2013\u2014]|\bto\b)\s*(\$?\s*-?\d[\d,]*\.?\d*)/i);
    if (rangeMatch) {
      const lowPrice = formatCurrency(rangeMatch[1]);
      const highPrice = formatCurrency(rangeMatch[2]);
      return lowPrice === highPrice ? lowPrice : `${lowPrice}-${highPrice}`;
    }

    const match = rawText.match(/-?\d[\d,]*\.?\d*/);
    if (!match) {
      return 'Contact for price';
    }

    const numericValue = Number(match[0].replace(/,/g, ''));
    return Number.isFinite(numericValue)
      ? `$${numericValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : 'Contact for price';
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function safeSessionStorageGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function safeSessionStorageSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  function safeSessionStorageRemove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // A missing session store only means the one-time cart snapshot cannot be used.
    }
  }

  function normalizeProductId(value) {
    const productId = Number(value);
    return Number.isSafeInteger(productId) && productId > 0 ? productId : null;
  }

  /**
   * Wishlist IDs are stored separately from product data so the same saved list
   * can work whether products come from static JSON, local overrides, or Supabase.
   */
  function normalizeWishlist(items) {
    return [...new Set((Array.isArray(items) ? items : [])
      .map(normalizeProductId)
      .filter(Boolean))];
  }

  function normalizeCartQuantity(value, { allowZero = false } = {}) {
    const fallback = allowZero ? 0 : 1;
    const quantity = Math.floor(Number(value) || fallback);
    const minimum = allowZero ? 0 : 1;
    return Math.max(minimum, Math.min(99, quantity));
  }

  function getWishlist() {
    try {
      return normalizeWishlist(JSON.parse(safeStorageGet(STORAGE_KEYS.wishlist) || '[]'));
    } catch {
      console.warn('Invalid wishlist storage payload; resetting.');
      safeStorageSet(STORAGE_KEYS.wishlist, '[]');
      return [];
    }
  }

  /**
   * Keep repeated header, footer, and page-level count badges synchronized.
   */
  function updateCountElements(selector, count) {
    document.querySelectorAll(selector).forEach((element) => {
      element.textContent = `(${count})`;
    });
  }

  function updateWishlistCount() {
    updateCountElements('[data-wishlist-count]', getWishlist().length);
  }

  /**
   * Broadcast wishlist changes so page-specific modules can keep heart buttons,
   * modal actions, and dedicated wishlist screens synchronized without polling.
   */
  function emitWishlistChange(items = getWishlist(), source = 'local') {
    const normalized = normalizeWishlist(items);
    window.dispatchEvent(new CustomEvent('dj:wishlistchange', {
      detail: {
        items: normalized,
        count: normalized.length,
        source
      }
    }));
  }

  function persistWishlist(items, source = 'local') {
    const normalized = normalizeWishlist(items);
    if (source === 'local' || source === 'signout') {
      wishlistLocalRevision += 1;
    }
    if (!safeStorageSet(STORAGE_KEYS.wishlist, JSON.stringify(normalized))) {
      console.error('Failed to save wishlist.');
    }
    updateWishlistCount();
    emitWishlistChange(normalized, source);
    return normalized;
  }

  function normalizeCart(items) {
    const normalized = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const productId = normalizeProductId(item?.productId ?? item?.id);
      if (!productId) return;

      const quantity = normalizeCartQuantity(item?.quantity);
      normalized.set(productId, {
        productId,
        quantity: Math.min(99, (normalized.get(productId)?.quantity || 0) + quantity)
      });
    });
    return [...normalized.values()];
  }

  function getCart() {
    try {
      return normalizeCart(JSON.parse(safeStorageGet(STORAGE_KEYS.cart) || '[]'));
    } catch {
      console.warn('Invalid cart storage payload; resetting.');
      safeStorageSet(STORAGE_KEYS.cart, '[]');
      return [];
    }
  }

  function updateCartCount() {
    const count = getCart().reduce((total, item) => total + item.quantity, 0);
    updateCountElements('[data-cart-count]', count);
  }

  function emitCartChange(items = getCart(), source = 'local') {
    const normalized = normalizeCart(items);
    window.dispatchEvent(new CustomEvent('dj:cartchange', {
      detail: {
        items: normalized,
        count: normalized.reduce((total, item) => total + item.quantity, 0),
        source
      }
    }));
  }

  function persistCart(items, source = 'local') {
    const normalized = normalizeCart(items);
    if (!safeStorageSet(STORAGE_KEYS.cart, JSON.stringify(normalized))) {
      console.error('Failed to save cart.');
    }
    updateCartCount();
    emitCartChange(normalized, source);
    return normalized;
  }

  function normalizeCheckoutSessionId(value) {
    const sessionId = String(value || '').trim();
    return CHECKOUT_SESSION_ID_PATTERN.test(sessionId) ? sessionId : '';
  }

  function checkoutCartSnapshotKey(sessionId) {
    return `${CHECKOUT_CART_SNAPSHOT_KEY_PREFIX}${sessionId}`;
  }

  /**
   * Associate the exact cart quantities sent to Stripe with the session returned
   * by the checkout function. The snapshot remains tab-scoped, so it cannot
   * alter another browser tab before the shopper returns from Stripe.
   */
  function recordCheckoutCartSnapshot(sessionId, items = []) {
    const normalizedSessionId = normalizeCheckoutSessionId(sessionId);
    const normalizedItems = normalizeCart(items);
    if (!normalizedSessionId || !normalizedItems.length) return false;

    return safeSessionStorageSet(checkoutCartSnapshotKey(normalizedSessionId), JSON.stringify({
      sessionId: normalizedSessionId,
      items: normalizedItems,
      createdAt: Date.now()
    }));
  }

  function readCheckoutCartSnapshot(sessionId) {
    const normalizedSessionId = normalizeCheckoutSessionId(sessionId);
    if (!normalizedSessionId) return null;

    const storageKey = checkoutCartSnapshotKey(normalizedSessionId);
    try {
      const snapshot = JSON.parse(safeSessionStorageGet(storageKey) || 'null');
      const createdAt = Number(snapshot?.createdAt);
      const items = normalizeCart(snapshot?.items);
      if (
        snapshot?.sessionId !== normalizedSessionId
        || !Number.isFinite(createdAt)
        || Date.now() - createdAt < 0
        || Date.now() - createdAt > CHECKOUT_CART_SNAPSHOT_MAX_AGE_MS
        || !items.length
      ) {
        safeSessionStorageRemove(storageKey);
        return null;
      }
      return { sessionId: normalizedSessionId, items };
    } catch {
      safeSessionStorageRemove(storageKey);
      return null;
    }
  }

  /**
   * Remove only the quantities captured when this exact Stripe session began.
   * Items added later in another tab remain in localStorage and therefore stay
   * in the cart after the customer returns from a successful checkout.
   */
  function reconcileCartAfterCheckoutSuccess(sessionId) {
    const snapshot = readCheckoutCartSnapshot(sessionId);
    if (!snapshot) return { reconciled: false, changed: false, itemsRemoved: 0 };

    const quantitiesToRemove = new Map(snapshot.items.map((item) => [item.productId, item.quantity]));
    const currentCart = getCart();
    let itemsRemoved = 0;
    const reconciledCart = currentCart.flatMap((item) => {
      const quantityToRemove = quantitiesToRemove.get(item.productId) || 0;
      if (!quantityToRemove) return [item];

      const remainingQuantity = Math.max(0, item.quantity - quantityToRemove);
      itemsRemoved += item.quantity - remainingQuantity;
      return remainingQuantity ? [{ ...item, quantity: remainingQuantity }] : [];
    });

    // Consume the snapshot even when the cart was changed elsewhere. Repeated
    // success-page loads must not remove a second quantity from a newer cart.
    safeSessionStorageRemove(checkoutCartSnapshotKey(snapshot.sessionId));

    if (itemsRemoved) {
      persistCart(reconciledCart, 'checkout-success');
    }

    return { reconciled: true, changed: Boolean(itemsRemoved), itemsRemoved };
  }

  async function verifyCheckoutSessionWithRetries(sessionId, verifySession, options = {}) {
    const normalizedSessionId = normalizeCheckoutSessionId(sessionId);
    if (!normalizedSessionId) return { status: 'invalid', attempts: 0 };
    if (typeof verifySession !== 'function') return { status: 'unavailable', attempts: 0 };

    const requestedAttempts = Number(options.maxAttempts);
    const requestedDelay = Number(options.delayMs);
    const maxAttempts = Math.max(1, Math.min(10, Number.isFinite(requestedAttempts) ? requestedAttempts : 6));
    const delayMs = Math.max(0, Math.min(5000, Number.isFinite(requestedDelay) ? requestedDelay : 1250));
    let status = 'unknown';
    let attempts = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts = attempt;
      try {
        const result = await verifySession(normalizedSessionId);
        const nextStatus = String(result?.status || '').trim().toLowerCase();
        status = ['paid', 'pending', 'not_paid', 'unknown'].includes(nextStatus)
          ? nextStatus
          : 'unknown';
        if (status === 'paid' || status === 'not_paid') break;
      } catch {
        status = 'unavailable';
      }
      if (attempt < maxAttempts && delayMs) {
        await new Promise((resolve) => {
          window.setTimeout(resolve, delayMs);
        });
      }
    }
    return { status, attempts };
  }

  async function confirmCheckoutSuccessAndReconcile(sessionId, options = {}) {
    const verifySession = options.verifySession
      || DJ.remoteCatalog?.verifyCheckoutSession?.bind(DJ.remoteCatalog);
    const verification = await verifyCheckoutSessionWithRetries(sessionId, verifySession, options);
    if (verification.status !== 'paid') {
      return {
        verification,
        reconciliation: { reconciled: false, changed: false, itemsRemoved: 0 }
      };
    }
    return {
      verification,
      reconciliation: reconcileCartAfterCheckoutSuccess(sessionId)
    };
  }

  function availableQuantity(product = {}) {
    const explicitQuantity = Number(product.quantityAvailable);
    if (Number.isFinite(explicitQuantity)) {
      return Math.max(0, Math.floor(explicitQuantity));
    }
    const copyCount = Number(product.copyCount);
    if (Number.isFinite(copyCount)) {
      return Math.max(0, Math.floor(copyCount));
    }
    return 1;
  }

  function isProductCheckoutAvailable(product = {}) {
    const saleStatus = String(product.saleStatus || 'available').trim().toLowerCase();
    return product.isDeleted !== true
      && product.checkoutEnabled !== false
      && saleStatus === 'available'
      && availableQuantity(product) > 0;
  }

  function wishlistMigrationKey(userId = '') {
    return `${STORAGE_KEYS.wishlistBackendMigration}:${userId}`;
  }

  function queueWishlistBackendSave(items) {
    const localRevision = wishlistLocalRevision;
    window.clearTimeout(wishlistBackendSaveTimer);
    wishlistBackendSaveTimer = window.setTimeout(async () => {
      try {
        let remote = DJ.remoteCatalog;
        if (
          (!remote?.getSession || !remote?.replaceWishlist) &&
          typeof DJ.ensureCustomerAccountBridge === 'function'
        ) {
          await DJ.ensureCustomerAccountBridge();
          remote = DJ.remoteCatalog;
        }
        if (!remote?.getSession || !remote?.replaceWishlist) return;
        const session = await remote.getSession();
        if (!session?.user?.id) return;
        await remote.replaceWishlist(normalizeWishlist(items));
        safeStorageSet(wishlistMigrationKey(session.user.id), 'true');
        if (localRevision === wishlistLocalRevision) {
          persistWishlist(items, 'backend');
        }
      } catch (error) {
        console.warn('Wishlist could not be synced to the customer account.', error);
      }
    }, 250);
  }

  async function syncWishlistWithAccount(session) {
    const remote = DJ.remoteCatalog;
    const userId = session?.user?.id;
    if (!userId || !remote?.listWishlist || !remote?.replaceWishlist) return getWishlist();
    if (wishlistBackendSyncPromise) return wishlistBackendSyncPromise;

    wishlistBackendSyncPromise = (async () => {
      const localRevision = wishlistLocalRevision;
      const localWishlist = getWishlist();
      const remoteWishlist = normalizeWishlist(await remote.listWishlist());
      const migrationKey = wishlistMigrationKey(userId);
      const hasMigrated = safeStorageGet(migrationKey) === 'true';
      let nextWishlist = hasMigrated
        ? remoteWishlist
        : normalizeWishlist([...remoteWishlist, ...localWishlist]);

      if (!hasMigrated && nextWishlist.length !== remoteWishlist.length) {
        await remote.replaceWishlist(nextWishlist);
      }

      if (localRevision !== wishlistLocalRevision) {
        nextWishlist = getWishlist();
        await remote.replaceWishlist(nextWishlist);
      }

      safeStorageSet(migrationKey, 'true');
      return persistWishlist(nextWishlist, 'backend');
    })().finally(() => {
      wishlistBackendSyncPromise = null;
    });

    return wishlistBackendSyncPromise;
  }

  function clearAccountWishlistCache() {
    return persistWishlist([], 'signout');
  }

  // ---------------------------------------------------------------------------
  // Media behavior helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply browser-native lazy loading and bind category-aware fallback images.
   * This runs once per image element and is reused whenever new cards are rendered.
   */
  function applyLazyLoading(scope = document) {
    scope.querySelectorAll('img').forEach((image) => {
      const hasHighFetchPriority = (image.getAttribute('fetchpriority') || '').toLowerCase() === 'high';
      if (!image.hasAttribute('loading') && !hasHighFetchPriority) {
        image.setAttribute('loading', 'lazy');
      }

      if (!image.hasAttribute('decoding')) {
        image.setAttribute('decoding', 'async');
      }

      if (image.dataset.fallbackBound === 'true') {
        return;
      }

      image.dataset.fallbackBound = 'true';
      if (!image.dataset.originalSrc) {
        image.dataset.originalSrc = image.getAttribute('src') || '';
      }
      image.addEventListener('error', () => {
        const originalSource = image.dataset.originalSrc || image.getAttribute('src') || '';
        const triedSources = new Set((image.dataset.assetRetrySources || '').split('\n').filter(Boolean));
        triedSources.add(image.getAttribute('src') || '');
        image.dataset.assetRetrySources = Array.from(triedSources).join('\n');

        const candidateSources = image.dataset.assetCandidates
          ? image.dataset.assetCandidates.split('\n').map((candidate) => candidate.trim()).filter(Boolean)
          : DJ.getAssetUrlCandidates(originalSource);

        const retrySource = candidateSources.find((candidate) => (
          candidate
          && !triedSources.has(candidate)
        ));

        if (retrySource) {
          image.setAttribute('src', retrySource);
          return;
        }

        const explicitFallback = image.getAttribute('data-fallback-src');
        const category = image.closest('[data-product-category]')?.getAttribute('data-product-category');
        const categoryFallback = DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other;
        const fallbackSource = explicitFallback ? DJ.safeAssetUrl(explicitFallback) : DJ.safeAssetUrl(categoryFallback);

        if (fallbackSource && image.getAttribute('src') !== fallbackSource) {
          image.setAttribute('src', fallbackSource);
          image.setAttribute('data-image-fallback-applied', 'true');

          if (!image.getAttribute('alt')) {
            image.setAttribute('alt', 'Image unavailable');
          }
        }
      });
    });
  }

  /**
   * Defer non-critical UI work until the browser is idle, while keeping a timeout
   * fallback for browsers that do not support requestIdleCallback.
   */
  function scheduleIdle(callback, timeout = 900) {
    if (typeof window.requestIdleCallback !== 'function') {
      window.setTimeout(callback, 1);
      return;
    }

    window.requestIdleCallback(callback, { timeout });
  }

  /**
   * Centralize motion-sensitive scrolling and paint-frame throttling so sticky
   * UI elements stay responsive without doing redundant work on every scroll event.
   */
  function prefersReducedMotion() {
    if (typeof window.matchMedia !== 'function') {
      return false;
    }

    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function getScrollBehavior() {
    return prefersReducedMotion() ? 'auto' : 'smooth';
  }

  function addRafScrollListener(callback) {
    if (typeof callback !== 'function') {
      return;
    }

    let scheduled = false;
    const flush = () => {
      scheduled = false;
      callback();
    };

    const onScroll = () => {
      if (scheduled) {
        return;
      }

      scheduled = true;
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(flush);
      } else {
        window.setTimeout(flush, 16);
      }
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    callback();
  }

  /**
   * Resize events can fire in fast bursts on mobile browsers and desktop drags.
   * Batch resize-driven layout work onto animation frames so shared UI helpers
   * do not fight each other while the viewport is still settling.
   */
  function addRafResizeListener(callback, { runImmediately = true } = {}) {
    if (typeof callback !== 'function') {
      return;
    }

    let scheduled = false;
    const flush = () => {
      scheduled = false;
      callback();
    };

    const onResize = () => {
      if (scheduled) {
        return;
      }

      scheduled = true;
      if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(flush);
      } else {
        window.setTimeout(flush, 16);
      }
    };

    window.addEventListener('resize', onResize);
    if (runImmediately) {
      callback();
    }
  }

  function bindMediaQueryChange(query, handler) {
    if (!query) return false;
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
      return true;
    }
    if (typeof query.addListener === 'function') {
      query.addListener(handler);
      return true;
    }
    return false;
  }

  function isMobileThemeLayout() {
    return MOBILE_THEME_QUERY ? MOBILE_THEME_QUERY.matches : window.innerWidth <= MOBILE_THEME_BREAKPOINT;
  }

  // ---------------------------------------------------------------------------
  // Theme handling
  // ---------------------------------------------------------------------------

  /**
   * Apply the saved light/dark mode preference and update the visible toggle label.
   */
  function enhanceHeaderLayout() {
    const headerInner = document.querySelector('.header-inner');
    const navToggle = document.getElementById('navToggle');
    const themeToggle = document.getElementById('themeToggle');

    if (!headerInner || !navToggle || !themeToggle) {
      return;
    }

    if (!headerInner.querySelector('.header-actions')) {
      const headerActions = document.createElement('div');
      headerActions.className = 'header-actions';
      headerInner.insertBefore(headerActions, themeToggle);
      headerActions.append(navToggle, themeToggle);
    }

    if (navToggle.dataset.enhanced !== 'true') {
      navToggle.dataset.enhanced = 'true';
      navToggle.innerHTML = `
        <span class="nav-toggle__icon" aria-hidden="true">
          <span></span>
          <span></span>
          <span></span>
        </span>
        <span class="button-label">Menu</span>
      `;
      navToggle.setAttribute('aria-label', 'Open menu');
      navToggle.setAttribute('data-state', 'closed');
    }
  }

  function enhanceCartNavigation() {
    const navList = document.querySelector('.site-nav .primary-nav__list');
    if (!navList || navList.querySelector('[data-cart-link]')) return;

    const item = document.createElement('li');
    item.className = 'primary-nav__item header-cart-item';
    item.innerHTML = `
      <a class="header-cart-link primary-nav__link" href="cart.html" data-cart-link>
        Cart <span data-cart-count="0">(0)</span>
      </a>
    `;
    const accountItem = navList.querySelector('a[href="account.html"]')?.closest('.primary-nav__item');
    navList.insertBefore(item, accountItem || null);
  }

  function renderThemeToggleState(isDarkMode) {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) {
      return;
    }

    if (themeToggle.dataset.enhanced !== 'true') {
      themeToggle.dataset.enhanced = 'true';
      themeToggle.innerHTML = `
        <span class="theme-toggle__icon" aria-hidden="true"></span>
        <span class="button-label"></span>
      `;
    }

    const label = themeToggle.querySelector('.button-label');
    if (label) {
      label.textContent = isDarkMode ? 'Light Mode' : 'Dark Mode';
    }

    themeToggle.setAttribute('data-theme-mode', isDarkMode ? 'dark' : 'light');
    themeToggle.setAttribute('aria-label', isDarkMode ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function applySavedTheme() {
    const theme = safeStorageGet(STORAGE_KEYS.theme) || 'light';
    const themeToggle = document.getElementById('themeToggle');
    const isDarkMode = theme === 'dark';

    document.body.classList.toggle('dark-mode', isDarkMode);

    if (themeToggle) {
      renderThemeToggleState(isDarkMode);
      themeToggle.setAttribute('aria-pressed', String(isDarkMode));
    }
  }

  function toggleTheme() {
    const nextTheme = (safeStorageGet(STORAGE_KEYS.theme) || 'light') === 'dark' ? 'light' : 'dark';
    safeStorageSet(STORAGE_KEYS.theme, nextTheme);
    applySavedTheme();
  }

  function initThemeToggle() {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) {
      return;
    }

    applySavedTheme();
    themeToggle.addEventListener('click', toggleTheme);
  }

  function initBackToTop() {
    scheduleIdle(() => {
      const backToTop = document.getElementById('backToTop');
      if (!backToTop) {
        return;
      }

      if (backToTop.dataset.enhanced !== 'true') {
        backToTop.dataset.enhanced = 'true';
        backToTop.innerHTML = `
          <span class="back-to-top__icon" aria-hidden="true"></span>
          <span class="back-to-top__label">Top</span>
        `;
      }

      const updateVisibility = () => {
        backToTop.classList.toggle('visible', window.scrollY > 300);
      };

      addRafScrollListener(updateVisibility);
      backToTop.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: getScrollBehavior() });
      });
    });
  }

  /**
   * Register the service worker only on secure contexts (or localhost during
   * testing) so cached shell assets and the offline page can work without
   * breaking non-secure development snapshots.
   */
  function registerServiceWorker() {
    if (
      !('serviceWorker' in navigator)
      || !navigator.serviceWorker
      || typeof navigator.serviceWorker.register !== 'function'
      || typeof navigator.serviceWorker.addEventListener !== 'function'
    ) {
      return;
    }

    const hostname = String(window.location.hostname || '').toLowerCase();
    const isLocalhost = ['localhost', '127.0.0.1'].includes(hostname);
    if (!window.isSecureContext && !isLocalhost) {
      return;
    }

    window.addEventListener('load', () => {
      const pageWasAlreadyControlled = Boolean(navigator.serviceWorker.controller);

      navigator.serviceWorker.addEventListener('controllerchange', () => {
        // A newly installed worker can claim first-time visitors after load.
        // Avoid reloading that initial session; only refresh pages that were
        // already controlled and are receiving an update.
        if (!pageWasAlreadyControlled) {
          return;
        }

        if (serviceWorkerRefreshPending) {
          return;
        }
        serviceWorkerRefreshPending = true;
        window.location.reload();
      });

      const activateWaitingWorker = (registration) => {
        if (registration?.waiting) {
          registration.waiting.postMessage({ type: 'DJ_SKIP_WAITING' });
        }
      };

      navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((registration) => {
        activateWaitingWorker(registration);

        if (!registration || typeof registration.addEventListener !== 'function') {
          return;
        }

        registration.addEventListener('updatefound', () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener('statechange', () => {
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              activateWaitingWorker(registration);
            }
          });
        });
      }).catch((error) => {
        console.warn('Service worker registration failed.', error);
      });
    }, { once: true });
  }

  function initHeaderScrollState() {
    scheduleIdle(() => {
      const siteHeader = document.querySelector('.site-header');
      if (!siteHeader) {
        return;
      }

      const updateHeaderState = () => {
        siteHeader.classList.toggle('site-header--scrolled', window.scrollY > 18);
      };

      addRafScrollListener(updateHeaderState);
    });
  }

  function enhanceFooterContactLinks() {
    document.querySelectorAll('.footer-links p').forEach((element) => {
      const email = String(element.textContent || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return;
      }

      if (element.dataset.enhancedFooterContact === 'true') {
        return;
      }

      element.dataset.enhancedFooterContact = 'true';
      element.className = 'footer-contact-block';
      element.innerHTML = `
        <a class="footer-contact-link" href="mailto:${DJ.escapeHtml(email)}">Email DJ directly</a>
        <span class="footer-contact-meta">${DJ.escapeHtml(email)}</span>
      `;
    });
  }

  function ensureImageLightbox() {
    if (sharedImageLightbox) {
      return sharedImageLightbox;
    }

    let returnFocusElement = null;
    const lightbox = document.createElement('div');
    lightbox.className = 'image-lightbox';
    lightbox.setAttribute('aria-hidden', 'true');
    lightbox.setAttribute('role', 'dialog');
    lightbox.setAttribute('aria-modal', 'true');
    lightbox.setAttribute('aria-label', 'Full size image preview');
    lightbox.hidden = true;
    lightbox.innerHTML = `
      <button class="image-lightbox__close" type="button" aria-label="Close full size image">&times;</button>
      <figure class="image-lightbox__frame">
        <img alt="" class="image-lightbox__image" loading="eager" decoding="async" fetchpriority="high"/>
        <figcaption class="image-lightbox__caption"></figcaption>
      </figure>
    `;
    document.body.appendChild(lightbox);

    const lightboxImage = lightbox.querySelector('.image-lightbox__image');
    const lightboxCaption = lightbox.querySelector('.image-lightbox__caption');
    const closeButton = lightbox.querySelector('.image-lightbox__close');

    const closeLightbox = () => {
      lightbox.hidden = true;
      lightbox.classList.remove('is-open');
      lightbox.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('image-lightbox-open');
      if (
        returnFocusElement &&
        returnFocusElement.isConnected !== false &&
        typeof returnFocusElement.focus === 'function'
      ) {
        returnFocusElement.focus();
      }
      returnFocusElement = null;
    };

    closeButton.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', (event) => {
      if (event.target === lightbox) {
        closeLightbox();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !lightbox.hidden) {
        closeLightbox();
        return;
      }

      if (event.key === 'Tab' && !lightbox.hidden) {
        event.preventDefault();
        closeButton.focus();
      }
    });

    sharedImageLightbox = {
      lightbox,
      lightboxImage,
      lightboxCaption,
      closeButton,
      closeLightbox,
      setReturnFocusElement(element) {
        returnFocusElement = element;
      }
    };

    return sharedImageLightbox;
  }

  DJ.openImageLightbox = function openImageLightbox(options = {}) {
    const {
      src = '',
      alt = '',
      caption = '',
      trigger = null,
      candidates = [],
      fallbackSrc = ''
    } = options;

    if (!src) {
      return;
    }

    const {
      lightbox,
      lightboxImage,
      lightboxCaption,
      closeButton,
      setReturnFocusElement
    } = ensureImageLightbox();

    setReturnFocusElement(trigger || document.activeElement || null);

    const resolvedCaption = String(caption || alt || 'Full size image').trim();
    const resolvedCandidates = Array.isArray(candidates)
      ? candidates.filter(Boolean)
      : String(candidates || '').split('\n').map((candidate) => candidate.trim()).filter(Boolean);
    lightboxImage.dataset.originalSrc = src;
    lightboxImage.dataset.assetRetrySources = '';
    lightboxImage.dataset.assetCandidates = resolvedCandidates.join('\n');
    if (fallbackSrc) {
      lightboxImage.setAttribute('data-fallback-src', DJ.safeAssetUrl(fallbackSrc));
    } else {
      lightboxImage.removeAttribute('data-fallback-src');
    }
    applyLazyLoading(lightbox);
    lightboxImage.src = src;
    lightboxImage.alt = alt || resolvedCaption;
    lightboxCaption.textContent = resolvedCaption;
    lightbox.hidden = false;
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('image-lightbox-open');
    closeButton.focus();
  };

  function initArchiveImageLightbox() {
    const archiveImages = [...document.querySelectorAll('.about-archive-section img')];

    if (!archiveImages.length) {
      return;
    }

    archiveImages.forEach((image) => {
      if (image.dataset.lightboxBound === 'true') {
        return;
      }

      image.dataset.lightboxBound = 'true';
      image.classList.add('legacy-image-clickable');
      image.setAttribute('role', 'button');
      image.setAttribute('tabindex', '0');
      image.setAttribute('aria-label', `${image.alt || 'Archive image'} - open full size`);
      image.addEventListener('click', () => {
        const figure = image.closest('figure');
        const caption = figure?.querySelector('figcaption')?.textContent?.trim() || image.alt || 'Full size image';
        DJ.openImageLightbox({
          src: image.currentSrc || image.src,
          alt: image.alt || caption,
          caption,
          trigger: image
        });
      });
      image.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const figure = image.closest('figure');
          const caption = figure?.querySelector('figcaption')?.textContent?.trim() || image.alt || 'Full size image';
          DJ.openImageLightbox({
            src: image.currentSrc || image.src,
            alt: image.alt || caption,
            caption,
            trigger: image
          });
        }
      });
    });
  }

  function initArchivePanels() {
    const panels = [...document.querySelectorAll('.about-archive-panel[id]')];
    if (!panels.length) {
      return;
    }

    const syncArchivePanelFromHash = (shouldScroll = false) => {
      const targetId = decodeURIComponent(String(window.location.hash || '').replace(/^#/, ''));
      if (!targetId) {
        return;
      }

      const targetPanel = panels.find((panel) => panel.id === targetId);
      if (!targetPanel) {
        return;
      }

      panels.forEach((panel) => {
        panel.open = panel === targetPanel;
      });

      if (shouldScroll) {
        window.requestAnimationFrame(() => {
          targetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    };

    panels.forEach((panel) => {
      panel.addEventListener('toggle', () => {
        if (panel.open) {
          panels.forEach((otherPanel) => {
            if (otherPanel !== panel) {
              otherPanel.open = false;
            }
          });
          if (window.location.hash !== `#${panel.id}`) {
            history.replaceState(null, '', `#${panel.id}`);
          }
          return;
        }

        if (window.location.hash === `#${panel.id}`) {
          history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
        }
      });
    });

    syncArchivePanelFromHash(false);
    window.addEventListener('hashchange', () => {
      syncArchivePanelFromHash(true);
    });
  }

  function buildFooterLinkGroup(title, links) {
    const group = document.createElement('div');
    const groupSlug = String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    group.className = `footer-link-group${groupSlug ? ` footer-link-group--${groupSlug}` : ''}`;

    const heading = document.createElement('strong');
    heading.textContent = title;
    group.appendChild(heading);

    links.forEach((link) => {
      group.appendChild(link.cloneNode(true));
    });

    return group;
  }

  function enhanceFooterLayout() {
    document.querySelectorAll('.footer').forEach((footer) => {
      if (footer.dataset.enhanced === 'true') {
        return;
      }

      footer.dataset.enhanced = 'true';

      const footerLinks = footer.querySelector('.footer-links');

      if (footerLinks && !footerLinks.querySelector('.footer-link-groups')) {
        FOOTER_POLICY_LINKS.forEach(([label, href]) => {
          if (footerLinks.querySelector(`a[href="${href}"]`)) return;
          const link = document.createElement('a');
          link.href = href;
          link.textContent = label;
          footerLinks.appendChild(link);
        });
        MARKETPLACE_LINKS.forEach(([label, href]) => {
          if (footerLinks.querySelector(`a[href="${href}"]`)) return;
          const link = document.createElement('a');
          link.href = href;
          link.textContent = label;
          link.className = 'footer-marketplace-link';
          link.dataset.footerGroup = 'storefronts';
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          footerLinks.appendChild(link);
        });
        const directLinks = [...footerLinks.querySelectorAll(':scope > a:not(.footer-contact-link)')];
        const browseLinks = directLinks.filter((link) => FOOTER_BROWSE_HREFS.has(link.getAttribute('href')));
        const storefrontLinks = directLinks.filter((link) => link.dataset.footerGroup === 'storefronts');
        const supportLinks = directLinks.filter((link) => (
          !FOOTER_BROWSE_HREFS.has(link.getAttribute('href'))
          && !FOOTER_UTILITY_HREFS.has(link.getAttribute('href'))
          && link.dataset.footerGroup !== 'storefronts'
        ));
        const groups = document.createElement('div');
        groups.className = 'footer-link-groups';

        if (browseLinks.length) {
          groups.appendChild(buildFooterLinkGroup('Browse', browseLinks));
        }

        if (storefrontLinks.length) {
          groups.appendChild(buildFooterLinkGroup('Storefronts', storefrontLinks));
        }

        if (supportLinks.length) {
          groups.appendChild(buildFooterLinkGroup('Support', supportLinks));
        }

        footerLinks.innerHTML = '';
        footerLinks.appendChild(groups);
      }
    });

    document.querySelectorAll('[data-scroll-top]').forEach((button) => {
      if (button.dataset.boundScrollTop === 'true') {
        return;
      }

      button.dataset.boundScrollTop = 'true';
      button.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: getScrollBehavior() });
      });
    });
  }

  /**
   * On compact mobile layouts the theme toggle competes with the brand lockup.
   * Move the existing toggle into the navigation drawer, then restore it to
   * the header on wider screens without duplicating the control in the footer.
   */
  function syncThemeTogglePlacement() {
    const themeToggle = document.getElementById('themeToggle');
    const headerActions = document.querySelector('.header-actions');
    if (!themeToggle || !headerActions) {
      return;
    }

    let mobileActions = document.querySelector('.site-nav__mobile-actions');

    const placeToggle = () => {
      const siteNav = document.getElementById('siteNav');
      mobileActions = mobileActions && mobileActions.isConnected
        ? mobileActions
        : document.querySelector('.site-nav__mobile-actions');

      if (isMobileThemeLayout() && siteNav) {
        if (!mobileActions) {
          mobileActions = document.createElement('div');
          mobileActions.className = 'site-nav__mobile-actions';
          siteNav.appendChild(mobileActions);
        }
        if (themeToggle.parentElement !== mobileActions) {
          mobileActions.appendChild(themeToggle);
        }
        themeToggle.classList.add('theme-toggle--menu');
        return;
      }

      if (themeToggle.parentElement !== headerActions) {
        headerActions.appendChild(themeToggle);
      }
      themeToggle.classList.remove('theme-toggle--menu');
      if (mobileActions && !mobileActions.childElementCount) {
        mobileActions.remove();
        mobileActions = null;
      }
    };

    if (themeToggle.dataset.responsivePlacementBound !== 'true') {
      themeToggle.dataset.responsivePlacementBound = 'true';
      if (!bindMediaQueryChange(MOBILE_THEME_QUERY, placeToggle)) {
        addRafResizeListener(placeToggle, { runImmediately: false });
      }
      window.addEventListener('pageshow', placeToggle);
    }

    placeToggle();
  }

  // ---------------------------------------------------------------------------
  // Public DJ API used by the rest of the site
  // ---------------------------------------------------------------------------

  // Category-specific placeholder art is reused by product cards, admin previews,
  // and image fallback logic so missing images degrade gracefully.
  DJ.fallbackByCategory = {
    Baseball: 'assets/placeholder-baseball.svg',
    Basketball: 'assets/placeholder-basketball.svg',
    Football: 'assets/placeholder-football.svg',
    Comics: 'assets/placeholder-comics.svg',
    Collectibles: 'assets/clubhouse-sign.png',
    Other: 'assets/clubhouse-sign.png'
  };

  DJ.escapeHtml = function escapeHtml(value) {
    return String(value ?? '').replace(HTML_ESCAPE_PATTERN, (character) => HTML_ESCAPE_ENTITIES[character]);
  };

  /**
   * Only expose external links that use explicitly allowed protocols.
   * Product data can come from spreadsheets, local JSON, or Supabase rows, so
   * link rendering should reject malformed or script-like URLs at the final UI
   * boundary instead of trusting every upstream import path.
   */
  DJ.safeExternalUrl = function safeExternalUrl(value, allowedProtocols = ['http:', 'https:']) {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
      return '';
    }

    try {
      const parsedUrl = new URL(rawValue);
      return allowedProtocols.includes(parsedUrl.protocol) ? parsedUrl.href : '';
    } catch {
      return '';
    }
  };

  // Admin and catalog flows both validate outbound URLs before saving or
  // rendering them so malformed spreadsheet/import data cannot leak through.
  DJ.isValidHttpUrl = function isValidHttpUrl(value) {
    return Boolean(DJ.safeExternalUrl(value));
  };

  /**
   * Treat direct image URLs, uploaded assets, and temporary browser object URLs
   * as acceptable image references for admin previews and saved listing fields.
   */
  DJ.isLikelyImageReference = function isLikelyImageReference(value = '') {
    const normalized = String(value || '').trim();
    if (!normalized) return false;
    if (/^data:image\//i.test(normalized)) return true;
    if (/^blob:/i.test(normalized)) return true;
    if (/^https?:\/\/.+\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(normalized)) return true;
    if (/^https?:\/\//i.test(normalized)) return true;
    if (/^assets\//i.test(normalized)) return true;
    if (/^[./A-Za-z0-9 _-]+?\.(avif|gif|jpe?g|png|svg|webp)(?:[?#].*)?$/i.test(normalized)) return true;
    return false;
  };

  DJ.safeAssetUrl = function safeAssetUrl(url) {
    if (typeof url !== 'string') {
      return url;
    }

    const normalizedUrl = url.trim().replace(/\\/g, '/');
    return getBoundedCachedValue(safeAssetUrlCache, normalizedUrl, () => {
      if (!/^assets\//i.test(normalizedUrl)) {
        return normalizedUrl;
      }

      const [, assetPath = normalizedUrl, suffix = ''] = normalizedUrl.match(/^([^?]*)(\?.*)?$/) || [];
      return assetPath
        .split('/')
        .map((segment, index) => {
          if (index === 0) {
            return segment;
          }

          try {
            return encodeURIComponent(decodeURIComponent(segment));
          } catch {
            return encodeURIComponent(segment);
          }
        })
        .join('/')
        .replace(/%28/g, '(')
        .replace(/%29/g, ')') + suffix;
    });
  };

  /**
   * Try both common asset-folder casings before giving up on an image.
   * This cushions live-host uploads that landed in `Assets/` instead of `assets/`.
   */
  DJ.getAssetUrlCandidates = function getAssetUrlCandidates(url) {
    if (typeof url !== 'string' || !url) {
      return [];
    }

    return getBoundedCachedValue(assetUrlCandidatesCache, url, () => {
      const normalizedUrl = String(url).trim().replace(/\\/g, '/');
      const safeUrl = DJ.safeAssetUrl(normalizedUrl);
      if (!/^assets\//i.test(normalizedUrl)) {
        return safeUrl ? [safeUrl] : [];
      }

      const lowerVariant = normalizedUrl.replace(/^Assets\//, 'assets/');
      const upperVariant = normalizedUrl.replace(/^assets\//, 'Assets/');
      return [...new Set([
        safeUrl,
        DJ.safeAssetUrl(lowerVariant),
        DJ.safeAssetUrl(upperVariant)
      ].filter(Boolean).map(versionedLocalProductImage))];
    });
  };

  /**
   * Use generated thumbnails only for live catalog image folders. Everything
   * else continues to use original assets so icons/logos are never rerouted.
   */
  DJ.thumbnailEligibleRoots = [
    'baseball-cards',
    'basketball-cards',
    'collectibles',
    'comics',
    'ebay listing photos',
    'personal collection',
    'football-cards'
  ];

  DJ.isThumbnailEligibleAsset = function isThumbnailEligibleAsset(url) {
    if (typeof url !== 'string' || !url) {
      return false;
    }

    const normalized = String(url).trim().replace(/\\/g, '/');
    if (!/^assets\//i.test(normalized) || /^assets\/thumbnails\//i.test(normalized)) {
      return false;
    }

    const relativePath = normalized.replace(/^assets\//i, '');
    const rootSegment = relativePath.split('/')[0]?.toLowerCase() || '';
    return DJ.thumbnailEligibleRoots.includes(rootSegment);
  };

  /**
   * Derive a non-destructive thumbnail path that mirrors the original asset tree
   * under assets/thumbnails and swaps the file extension to WebP.
   */
  DJ.getThumbnailAssetUrl = function getThumbnailAssetUrl(url) {
    if (typeof url !== 'string' || !url) {
      return '';
    }

    return getBoundedCachedValue(thumbnailAssetUrlCache, url, () => {
      const normalized = String(url).trim();
      if (!DJ.isThumbnailEligibleAsset(normalized)) {
        return DJ.safeAssetUrl(normalized);
      }

      const relativePath = normalized.replace(/^assets\//i, '');
      const extension = relativePath.split('.').pop()?.toLowerCase() || '';
      if (!extension || extension === 'svg') {
        return DJ.safeAssetUrl(normalized);
      }

      const thumbnailPath = `assets/thumbnails/${relativePath.replace(/\.[^.]+$/, '.webp')}`;
      return DJ.safeAssetUrl(thumbnailPath);
    });
  };

  /**
   * Prefer generated thumbnails where available, but always keep the original
   * asset path in the retry chain so the UI still renders if a thumbnail is
   * missing on the host.
   */
  DJ.getThumbnailAssetCandidates = function getThumbnailAssetCandidates(url) {
    if (typeof url !== 'string' || !url) {
      return [];
    }

    return getBoundedCachedValue(thumbnailAssetCandidatesCache, url, () => {
      const baseCandidates = DJ.getAssetUrlCandidates(url);
      if (!DJ.isThumbnailEligibleAsset(url)) {
        return baseCandidates;
      }

      const thumbnailUrl = DJ.getThumbnailAssetUrl(url);
      return [...new Set([
        ...DJ.getAssetUrlCandidates(thumbnailUrl),
        ...baseCandidates
      ].filter(Boolean))];
    });
  };


  DJ.getPreloadedProductsForSource = function getPreloadedProductsForSource(source) {
    if (preloadedProductsBySource.has(source)) {
      return preloadedProductsBySource.get(source);
    }

    const sourceGlobal = PRELOADED_PRODUCT_BUNDLES[source]?.[1];
    if (sourceGlobal && Array.isArray(window[sourceGlobal])) {
      preloadedProductsBySource.set(source, window[sourceGlobal]);
      return window[sourceGlobal];
    }

    if (
      window.DJ_PRELOADED_SOURCE === source &&
      Array.isArray(window.DJ_PRELOADED_PRODUCTS)
    ) {
      preloadedProductsBySource.set(source, window.DJ_PRELOADED_PRODUCTS);
      return window.DJ_PRELOADED_PRODUCTS;
    }

    return null;
  };

  DJ.versionedProductAsset = versionedProductAsset;

  DJ.loadPreloadedProductsForSource = async function loadPreloadedProductsForSource(source) {
    const existing = DJ.getPreloadedProductsForSource(source);
    if (existing) {
      return existing;
    }

    const scriptName = PRELOADED_PRODUCT_BUNDLES[source]?.[0];
    if (!scriptName) {
      return null;
    }

    if (preloadedBundlePromises.has(source)) {
      return preloadedBundlePromises.get(source);
    }

    const pending = new Promise((resolve, reject) => {
      const resolveLoadedBundle = () => {
        const loadedProducts = DJ.getPreloadedProductsForSource(source);
        if (loadedProducts) {
          resolve(loadedProducts);
          return;
        }

        reject(new Error(`Preloaded product bundle ${scriptName} did not expose ${source}.`));
      };

      const existingScript = document.querySelector(`script[data-preloaded-product-source="${source}"]`);
      if (existingScript) {
        // Pages can render shared shells more than once, so reuse an existing
        // preloaded bundle instead of injecting duplicate script tags.
        if (existingScript.dataset.preloadedReady === 'true') {
          resolveLoadedBundle();
          return;
        }

        existingScript.addEventListener('load', () => {
          existingScript.dataset.preloadedReady = 'true';
          resolveLoadedBundle();
        }, { once: true });

        existingScript.addEventListener('error', () => {
          reject(new Error(`Failed to load preloaded product bundle ${scriptName}.`));
        }, { once: true });
        return;
      }

      const script = document.createElement('script');
      script.src = versionedProductAsset(scriptName);
      script.defer = true;
      script.dataset.preloadedProductSource = source;

      script.addEventListener('load', () => {
        script.dataset.preloadedReady = 'true';
        resolveLoadedBundle();
      }, { once: true });

      script.addEventListener('error', () => {
        reject(new Error(`Failed to load preloaded product bundle ${scriptName}.`));
      }, { once: true });

      document.head.appendChild(script);
    }).catch((error) => {
      preloadedBundlePromises.delete(source);
      throw error;
    });

    preloadedBundlePromises.set(source, pending);
    return pending;
  };

  DJ.currency = formatCurrency;

  function parsePriceRangeLabel(value = '') {
    const label = String(value || '').trim();
    const match = label.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:-|[\u2013\u2014]|\bto\b)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (!match) return null;

    const first = Number(match[1].replace(/,/g, ''));
    const second = Number(match[2].replace(/,/g, ''));
    if (!Number.isFinite(first) || !Number.isFinite(second)) return null;

    return {
      label,
      low: Math.min(first, second),
      high: Math.max(first, second)
    };
  }

  function initDeferredServiceWorkerRegistration() {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    let scheduled = false;
    let fallbackTimer = 0;
    const scheduleRegistration = () => {
      if (scheduled) return;
      scheduled = true;
      window.clearTimeout(fallbackTimer);
      window.removeEventListener('pointerdown', scheduleRegistration);
      window.removeEventListener('keydown', scheduleRegistration);
      scheduleIdle(registerServiceWorker, 3000);
    };

    window.addEventListener('pointerdown', scheduleRegistration, { once: true, passive: true });
    window.addEventListener('keydown', scheduleRegistration, { once: true });
    fallbackTimer = window.setTimeout(scheduleRegistration, 10000);
  }

  function initHomeCatalogLoader() {
    if (document.body.dataset.page !== 'home') {
      return;
    }

    const featuredProducts = document.getElementById('featuredProducts');
    if (!featuredProducts) {
      return;
    }

    let observer = null;
    const loadHomeCatalog = () => {
      observer?.disconnect();
      loadScript(versionedProductAsset('catalog.js')).catch((error) => {
        console.error('Failed to load the featured catalog.', error);
      });
    };

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadHomeCatalog();
        }
      }, { rootMargin: '600px 0px' });
      observer.observe(featuredProducts);
      return;
    }

    scheduleIdle(loadHomeCatalog, 2500);
  }

  function setHomeAuthStatus(message = '', state = 'info') {
    const status = document.getElementById('homeAuthStatus');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    if (message) {
      status.dataset.state = state;
    } else {
      status.removeAttribute('data-state');
    }
  }

  async function loadCustomerAccountBridge() {
    if (DJ.payments?.openAuthModal) {
      return DJ.payments;
    }

    await loadScriptsInOrder([
      versionedProductAsset('backend-config.js'),
      versionedProductAsset('supabase-client.js'),
      versionedProductAsset('payments.js')
    ]);
    return DJ.payments || null;
  }

  function initHomeAccountCard() {
    if (document.body.dataset.page !== 'home') {
      return;
    }

    const signInButton = document.getElementById('homeSignIn');
    if (!signInButton) {
      return;
    }

    signInButton.addEventListener('click', async () => {
      signInButton.disabled = true;
      setHomeAuthStatus('Opening secure account sign-in...', 'info');
      try {
        const payments = await loadCustomerAccountBridge();
        if (payments?.openAuthModal) {
          payments.openAuthModal({ message: 'Sign in or create an account while you browse DJ\'s inventory.' });
          setHomeAuthStatus('');
          return;
        }
        window.location.href = 'account.html';
      } catch (error) {
        console.warn('Customer account sign-in could not be opened from home.', error);
        setHomeAuthStatus('Account sign-in is opening on the account page.', 'info');
        window.location.href = 'account.html';
      } finally {
        signInButton.disabled = false;
      }
    });

    window.addEventListener('dj:authchange', (event) => {
      const email = event.detail?.session?.user?.email || '';
      setHomeAuthStatus(email ? `Signed in as ${email}.` : '', 'success');
    });
  }

  function explicitPriceLabel(item) {
    return String(item?.priceLabel || item?.displayPrice || '').trim();
  }

  function rawNumericPrice(item) {
    const price = item?.price;
    if (price == null || price === '') {
      return null;
    }

    if (typeof price === 'number') {
      return Number.isFinite(price) ? price : null;
    }

    const match = String(price).match(/-?\d[\d,]*\.?\d*/);
    if (!match) {
      return null;
    }

    const numericValue = Number(match[0].replace(/,/g, ''));
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  DJ.priceRangeLabel = function priceRangeLabel(item) {
    return parsePriceRangeLabel(explicitPriceLabel(item))?.label || '';
  };

  DJ.payablePrice = function payablePrice(item) {
    const range = parsePriceRangeLabel(explicitPriceLabel(item));
    if (range) return range.high;
    return rawNumericPrice(item);
  };

  DJ.displayPrice = function displayPrice(item) {
    const explicitLabel = explicitPriceLabel(item);
    const range = parsePriceRangeLabel(explicitLabel);
    if (range) return formatCurrency(range.high);
    return explicitLabel || formatCurrency(item?.price);
  };

  DJ.isDirectCheckoutEligible = function isDirectCheckoutEligible(item = {}) {
    const price = DJ.payablePrice(item);
    const priceLabel = String(item?.displayPrice || item?.priceLabel || DJ.displayPrice(item) || '').toLowerCase();
    return Number.isFinite(price)
      && price > 0
      && isProductCheckoutAvailable(item)
      && !/contact|ask|inquir|availability/.test(priceLabel);
  };

  DJ.productPageUrl = function productPageUrl(product = {}) {
    const category = String(product.category || '').toLowerCase();
    const page = CATEGORY_PAGE_ROUTES.find(([pattern]) => pattern.test(category))?.[1] || 'shop.html';
    const id = product.id == null ? '' : String(product.id).trim();
    return id ? `${page}?item=${encodeURIComponent(id)}` : page;
  };

  DJ.getWishlist = getWishlist;
  DJ.setWishlist = function setWishlist(items) {
    const persistedWishlist = persistWishlist(items, 'local');
    queueWishlistBackendSave(persistedWishlist);
  };
  DJ.syncWishlistWithAccount = syncWishlistWithAccount;
  DJ.clearAccountWishlistCache = clearAccountWishlistCache;

  DJ.updateWishlistCount = updateWishlistCount;
  DJ.normalizeProductId = normalizeProductId;
  DJ.normalizeCartQuantity = normalizeCartQuantity;
  DJ.getCart = getCart;
  DJ.setCart = function setCart(items) {
    return persistCart(items, 'local');
  };
  DJ.updateCartQuantity = function updateCartQuantity(productId, quantity) {
    const currentCart = getCart();
    const normalizedId = normalizeProductId(productId);
    if (!normalizedId) return persistCart(currentCart, 'local');

    const normalizedQuantity = normalizeCartQuantity(quantity, { allowZero: true });
    const cart = currentCart
      .filter((item) => item.productId !== normalizedId || normalizedQuantity > 0)
      .map((item) => item.productId === normalizedId ? { ...item, quantity: normalizedQuantity } : item);
    if (
      normalizedQuantity > 0
      && !currentCart.some((item) => item.productId === normalizedId)
    ) {
      cart.push({ productId: normalizedId, quantity: normalizedQuantity });
    }
    return persistCart(cart, 'local');
  };
  DJ.removeFromCart = function removeFromCart(productId) {
    const normalizedId = normalizeProductId(productId);
    const cart = getCart();
    if (!normalizedId) return persistCart(cart, 'local');

    return persistCart(cart.filter((item) => item.productId !== normalizedId), 'local');
  };
  DJ.clearCart = function clearCart(source = 'local') {
    return persistCart([], source);
  };
  DJ.recordCheckoutCartSnapshot = recordCheckoutCartSnapshot;
  DJ.reconcileCartAfterCheckoutSuccess = reconcileCartAfterCheckoutSuccess;
  DJ.verifyCheckoutSessionWithRetries = verifyCheckoutSessionWithRetries;
  DJ.confirmCheckoutSuccessAndReconcile = confirmCheckoutSuccessAndReconcile;
  DJ.updateCartCount = updateCartCount;
  DJ.availableQuantity = availableQuantity;
  DJ.applyLazyLoading = applyLazyLoading;
  DJ.scheduleIdle = scheduleIdle;
  DJ.loadScriptsInOrder = loadScriptsInOrder;
  DJ.getScrollBehavior = getScrollBehavior;
  // Shared responsive helpers keep resize and media-query wiring consistent
  // across navigation, catalog, and future page modules.
  DJ.bindMediaQueryChange = bindMediaQueryChange;
  DJ.addSharedResizeListener = addRafResizeListener;
  DJ.setStatus = function setStatus(elementId, message = '', state = 'info') {
    const element = document.getElementById(elementId);
    if (!element) {
      return;
    }

    if (!message) {
      element.hidden = true;
      element.textContent = '';
      element.removeAttribute('data-state');
      return;
    }

    element.hidden = false;
    element.textContent = message;
    element.setAttribute('data-state', state);
  };

  DJ.setLastFocusedElement = function setLastFocusedElement(element) {
    lastFocusedElement = element;
  };

  DJ.restoreFocus = function restoreFocus() {
    if (
      lastFocusedElement &&
      lastFocusedElement.isConnected !== false &&
      typeof lastFocusedElement.focus === 'function'
    ) {
      lastFocusedElement.focus();
    }
    lastFocusedElement = null;
  };

  function redirectLegacyCheckoutSuccess() {
    const params = new URLSearchParams(window.location.search);
    if (document.body.dataset.page !== 'wishlist' || params.get('checkout') !== 'success') {
      return false;
    }
    window.location.replace(`account.html?${params.toString()}`);
    return true;
  }

  function initFirstPartyMeasurement() {
    // Load measurement after the shared UI has painted. Pages that already
    // include the public backend config reuse it; all other public pages load
    // the same small browser-safe config on demand.
    DJ.scheduleIdle(() => {
      const analyticsSource = versionedProductAsset('analytics.js');
      if (window.DJ?.trackEvent) return;
      if (window.DJ_BACKEND_CONFIG) {
        loadScript(analyticsSource).catch(() => {});
        return;
      }
      loadScript(versionedProductAsset('backend-config.js'))
        .then(() => loadScript(analyticsSource))
        .catch(() => {});
    }, 650);
  }

  // Initialize shared UI behaviors once the DOM is ready. Individual page
  // modules layer their own features on top of these helpers later.
  document.addEventListener('DOMContentLoaded', () => {
    if (redirectLegacyCheckoutSuccess()) return;
    applyLazyLoading(document);
    enhanceHeaderLayout();
    enhanceCartNavigation();
    initThemeToggle();
    initBackToTop();
    enhanceFooterContactLinks();
    enhanceFooterLayout();
    syncThemeTogglePlacement();
    initArchiveImageLightbox();
    initArchivePanels();
    updateWishlistCount();
    updateCartCount();
    if (document.body.dataset.page === 'checkout-success') {
      const sessionId = new URLSearchParams(window.location.search).get('session_id');
      const status = document.getElementById('checkoutSuccessCartStatus');
      if (status) status.textContent = 'Confirming payment before updating this cart...';
      void DJ.confirmCheckoutSuccessAndReconcile(sessionId).then(({ verification, reconciliation }) => {
        if (!status) return;
        if (verification.status === 'paid' && reconciliation.changed) {
          status.textContent = 'Payment confirmed. The purchased quantities were removed from this cart.';
        } else if (verification.status === 'paid' && reconciliation.reconciled) {
          status.textContent = 'Payment confirmed. This cart was already up to date.';
        } else if (verification.status === 'paid') {
          status.textContent = 'Payment confirmed. No matching checkout snapshot was found in this tab, so the cart was left unchanged.';
        } else if (verification.status === 'invalid') {
          status.textContent = 'This checkout return link could not be verified. Your cart was not changed.';
        } else if (verification.status === 'not_paid') {
          status.textContent = 'Payment was not completed. Your cart was not changed.';
        } else {
          status.textContent = 'Payment confirmation is still pending. Your cart has not been changed.';
        }
      }).catch(() => {
        if (status) status.textContent = 'Payment status could not be verified yet. Your cart has not been changed.';
      });
    }
    initHomeCatalogLoader();
    initHomeAccountCard();
    initHeaderScrollState();
    initDeferredServiceWorkerRegistration();
    initFirstPartyMeasurement();
  });

  window.addEventListener('storage', (event) => {
    if (!event.key) return;

    if (event.key === STORAGE_KEYS.theme) {
      applySavedTheme();
      return;
    }

    if (event.key === STORAGE_KEYS.wishlist) {
      updateWishlistCount();
      emitWishlistChange(getWishlist(), 'storage');
      return;
    }

    if (event.key === STORAGE_KEYS.cart) {
      updateCartCount();
      emitCartChange(getCart(), 'storage');
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) {
      return;
    }

    applySavedTheme();
    updateWishlistCount();
    updateCartCount();
    emitWishlistChange(getWishlist(), 'pageshow');
    emitCartChange(getCart(), 'pageshow');
  });
})();

