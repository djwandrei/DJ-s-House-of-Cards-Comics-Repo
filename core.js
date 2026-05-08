/**
 * Core utilities shared by every page.
 * -----------------------------------------------------------------------------
 * This module creates the global window.DJ namespace and attaches the low-level
 * helpers that the rest of the site depends on: HTML escaping, image fallback
 * handling, theme persistence, wishlist storage, local admin storage, and a few
 * accessibility helpers such as focus restoration and status messaging.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const preloadedProductsBySource = new Map();
  const preloadedBundlePromises = new Map();
  // Bump this whenever storefront product bundles change so JSON/script fallbacks
  // immediately bypass stale browser and service-worker catalog caches.
  const PRODUCT_ASSET_VERSION = '20260507b';
  const ASSET_HELPER_CACHE_LIMIT = 5000;
  // Below this width the theme button moves out of the header to preserve the
  // logo/menu lockup on narrow mobile screens.
  const FOOTER_THEME_BREAKPOINT = 700;
  const FOOTER_THEME_QUERY = typeof window.matchMedia === 'function'
    ? window.matchMedia(`(max-width: ${FOOTER_THEME_BREAKPOINT}px)`)
    : null;
  const PRELOADED_PRODUCT_SCRIPT_BY_SOURCE = {
    'products.json': 'products-data-full.js',
    'products-baseball.json': 'products-data-baseball.js',
    'products-basketball.json': 'products-data-basketball.js',
    'products-football.json': 'products-data-football.js',
    'products-comics.json': 'products-data-comics.js',
    'products-collectibles.json': 'products-data-collectibles.js',
    'products-sports.json': 'products-data-sports.js',
    'products-featured.json': 'products-data-featured.js'
  };

  // Centralize localStorage keys so future refactors only need to update them in one place.
  const STORAGE_KEYS = {
    theme: 'theme',
    wishlist: 'wishlist',
    customProducts: 'customProducts',
    productOverrides: 'productOverrides',
    deletedProductIds: 'deletedProductIds',
    siteMetrics: 'djSiteMetricsV1'
  };
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

  // Remember the last focused element so modal close handlers can restore focus
  // to the trigger that opened them. This keeps keyboard navigation predictable.
  let lastFocusedElement = null;
  let sharedImageLightbox = null;
  let serviceWorkerRefreshPending = false;

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
      return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
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
      ? `$${numericValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
      : 'Contact for price';
  }

  function safeStorageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (error) {
      return false;
    }
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Read JSON from localStorage and normalize it through a transform function.
   * Returning normalized data here prevents scattered validation throughout the app.
   */
  function readJSONFromStorage(key, transform) {
    try {
      const parsed = JSON.parse(safeStorageGet(key) || 'null');
      return transform(parsed);
    } catch (error) {
      console.warn(`Invalid localStorage payload for ${key}; resetting.`);
      safeStorageRemove(key);
      return null;
    }
  }

  /**
   * Wishlist IDs are stored separately from product data so the same saved list
   * can work whether products come from static JSON, local overrides, or Supabase.
   */
  function getWishlist() {
    const wishlist = readJSONFromStorage(STORAGE_KEYS.wishlist, (value) => {
      if (!Array.isArray(value)) {
        return [];
      }

      return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
    });

    return Array.isArray(wishlist) ? wishlist : [];
  }

  /**
   * Update every visible wishlist counter in the header/footer/UI chips.
   * Keeping this in one place avoids desynchronized badge counts.
   */
  function updateWishlistCount() {
    const count = getWishlist().length;
    document.querySelectorAll('[data-wishlist-count]').forEach((element) => {
      element.textContent = `(${count})`;
    });
  }

  /**
   * Broadcast wishlist changes so page-specific modules can keep heart buttons,
   * modal actions, and dedicated wishlist screens synchronized without polling.
   */
  function emitWishlistChange(items = getWishlist(), source = 'local') {
    const normalized = [...new Set((Array.isArray(items) ? items : []).map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
    window.dispatchEvent(new CustomEvent('dj:wishlistchange', {
      detail: {
        items: normalized,
        count: normalized.length,
        source
      }
    }));
  }

  function createEmptySiteMetrics() {
    const now = new Date().toISOString();
    return {
      version: 1,
      createdAt: now,
      updatedAt: now,
      totals: {},
      pageViews: {},
      productEvents: {}
    };
  }

  function normalizeSiteMetrics(value) {
    const base = createEmptySiteMetrics();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return base;
    }

    return {
      ...base,
      ...value,
      totals: value.totals && typeof value.totals === 'object' && !Array.isArray(value.totals) ? value.totals : {},
      pageViews: value.pageViews && typeof value.pageViews === 'object' && !Array.isArray(value.pageViews) ? value.pageViews : {},
      productEvents: value.productEvents && typeof value.productEvents === 'object' && !Array.isArray(value.productEvents) ? value.productEvents : {}
    };
  }

  function getSiteMetrics() {
    return readJSONFromStorage(STORAGE_KEYS.siteMetrics, normalizeSiteMetrics) || createEmptySiteMetrics();
  }

  function pruneProductMetrics(productEvents = {}, limit = 500) {
    const entries = Object.entries(productEvents);
    if (entries.length <= limit) return productEvents;

    return Object.fromEntries(
      entries
        .sort(([, left], [, right]) => String(right?.lastEventAt || '').localeCompare(String(left?.lastEventAt || '')))
        .slice(0, limit)
    );
  }

  function recordSiteMetric(eventName, detail = {}) {
    const eventType = String(eventName || '').trim();
    if (!eventType) return null;

    const now = new Date().toISOString();
    const metrics = getSiteMetrics();
    metrics.updatedAt = now;
    metrics.totals[eventType] = (Number(metrics.totals[eventType]) || 0) + 1;

    if (eventType === 'page_view') {
      const pageKey = String(detail.page || document.body.dataset.page || window.location.pathname || 'unknown');
      metrics.pageViews[pageKey] = (Number(metrics.pageViews[pageKey]) || 0) + 1;
    }

    const productId = Number(detail.productId ?? detail.id);
    if (Number.isFinite(productId)) {
      const key = String(productId);
      const current = metrics.productEvents[key] || {};
      metrics.productEvents[key] = {
        ...current,
        productId,
        name: detail.name || current.name || '',
        category: detail.category || current.category || '',
        lastEventAt: now,
        [eventType]: (Number(current[eventType]) || 0) + 1
      };
      metrics.productEvents = pruneProductMetrics(metrics.productEvents);
    }

    safeStorageSet(STORAGE_KEYS.siteMetrics, JSON.stringify(metrics));
    return metrics;
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

  function isFooterThemeLayout() {
    return FOOTER_THEME_QUERY ? FOOTER_THEME_QUERY.matches : window.innerWidth <= FOOTER_THEME_BREAKPOINT;
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
    if (!('serviceWorker' in navigator)) {
      return;
    }

    const hostname = String(window.location.hostname || '').toLowerCase();
    const isLocalhost = ['localhost', '127.0.0.1'].includes(hostname);
    if (!window.isSecureContext && !isLocalhost) {
      return;
    }

    window.addEventListener('load', () => {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
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
        <img alt="" class="image-lightbox__image"/>
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
      DJ.restoreFocus();
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
      closeLightbox
    };

    return sharedImageLightbox;
  }

  DJ.openImageLightbox = function openImageLightbox(options = {}) {
    const {
      src = '',
      alt = '',
      caption = '',
      trigger = null
    } = options;

    if (!src) {
      return;
    }

    const {
      lightbox,
      lightboxImage,
      lightboxCaption,
      closeButton
    } = ensureImageLightbox();

    if (trigger) {
      DJ.setLastFocusedElement(trigger);
    }

    const resolvedCaption = String(caption || alt || 'Full size image').trim();
    lightboxImage.src = src;
    lightboxImage.alt = alt || resolvedCaption;
    lightboxCaption.textContent = resolvedCaption;
    lightbox.hidden = false;
    lightbox.classList.add('is-open');
    lightbox.setAttribute('aria-hidden', 'false');
    document.body.classList.add('image-lightbox-open');
    closeButton.focus();
  };

  DJ.closeImageLightbox = function closeImageLightbox() {
    ensureImageLightbox().closeLightbox();
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
    group.className = 'footer-link-group';

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

      const footerBrand = footer.querySelector('.footer-brand');
      const footerLinks = footer.querySelector('.footer-links');

      if (footerBrand && !footerBrand.querySelector('.footer-actions')) {
        const footerActions = document.createElement('div');
        footerActions.className = 'footer-actions';
        footerActions.innerHTML = `
          <a class="footer-action-link footer-action-link--secondary" href="wishlist.html">Wishlist <span class="footer-action-count" data-wishlist-count="0">(0)</span></a>
          <a aria-label="Visit DJ's House of Cards and Comics on Facebook" class="footer-action-link footer-action-link--secondary footer-action-link--facebook social-link" href="https://www.facebook.com/DJCardsComics/" rel="noopener noreferrer" target="_blank">
            <svg aria-hidden="true" class="social-link__icon social-link__icon--facebook" focusable="false" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="12" fill="#1877F2"></circle>
              <path d="M13.5 20v-6h2l.3-2.4h-2.3V10c0-.7.2-1.2 1.2-1.2H16V6.6c-.2 0-.9-.1-1.8-.1-1.8 0-3 1.1-3 3.2v1.8H9.4V14h1.8v6h2.3Z" fill="#FFFFFF"></path>
            </svg>
            Facebook
          </a>
        `;
        footerBrand.appendChild(footerActions);
      }

      if (footerLinks && !footerLinks.querySelector('.footer-link-groups')) {
        const directLinks = [...footerLinks.querySelectorAll(':scope > a:not(.footer-contact-link)')];
        const browseLinks = directLinks.filter((link) => ['sports-cards.html', 'comics.html', 'collectibles.html'].includes(link.getAttribute('href')));
        const supportLinks = directLinks.filter((link) => !['sports-cards.html', 'comics.html', 'collectibles.html'].includes(link.getAttribute('href')));
        const groups = document.createElement('div');
        groups.className = 'footer-link-groups';

        if (browseLinks.length) {
          groups.appendChild(buildFooterLinkGroup('Browse', browseLinks));
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
   * Move the existing toggle into the footer action stack so the header can
   * prioritize the logo and menu, then restore it to the header on wider screens.
   */
  function syncThemeTogglePlacement() {
    const themeToggle = document.getElementById('themeToggle');
    const headerActions = document.querySelector('.header-actions');
    if (!themeToggle || !headerActions) {
      return;
    }

    let footerActions = document.querySelector('.footer-actions');

    const placeToggle = () => {
      footerActions = footerActions && footerActions.isConnected ? footerActions : document.querySelector('.footer-actions');
      // Mobile headers need the brand and menu to stay readable, so the theme
      // toggle lives with footer actions until the viewport has room again.
      const useFooterPlacement = isFooterThemeLayout() && footerActions;

      if (useFooterPlacement) {
        const backToTopAction = footerActions.querySelector('[data-scroll-top]');
        if (themeToggle.parentElement !== footerActions) {
          footerActions.insertBefore(themeToggle, backToTopAction || null);
        }
        themeToggle.classList.add('theme-toggle--footer');
        return;
      }

      if (themeToggle.parentElement !== headerActions) {
        headerActions.appendChild(themeToggle);
      }
      themeToggle.classList.remove('theme-toggle--footer');
    };

    if (themeToggle.dataset.responsivePlacementBound !== 'true') {
      themeToggle.dataset.responsivePlacementBound = 'true';
      if (!bindMediaQueryChange(FOOTER_THEME_QUERY, placeToggle)) {
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
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[character]));
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
    } catch (error) {
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

    return getBoundedCachedValue(safeAssetUrlCache, url, () => {
      if (!/^assets\//i.test(url)) {
        return url;
      }

      return url
        .split('/')
        .map((segment, index) => {
          if (index === 0) {
            return segment;
          }

          try {
            return encodeURIComponent(decodeURIComponent(segment));
          } catch (error) {
            return encodeURIComponent(segment);
          }
        })
        .join('/')
        .replace(/%28/g, '(')
        .replace(/%29/g, ')');
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
      const safeUrl = DJ.safeAssetUrl(url);
      if (!/^assets\//i.test(url)) {
        return safeUrl ? [safeUrl] : [];
      }

      const lowerVariant = url.replace(/^Assets\//, 'assets/');
      const upperVariant = url.replace(/^assets\//, 'Assets/');
      return [...new Set([
        safeUrl,
        DJ.safeAssetUrl(lowerVariant),
        DJ.safeAssetUrl(upperVariant)
      ].filter(Boolean))];
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

    const scriptName = PRELOADED_PRODUCT_SCRIPT_BY_SOURCE[source];
    if (!scriptName) {
      return null;
    }

    if (preloadedBundlePromises.has(source)) {
      return preloadedBundlePromises.get(source);
    }

    const pending = new Promise((resolve, reject) => {
      const existingScript = document.querySelector(`script[data-preloaded-product-source="${source}"]`);
      if (existingScript) {
        // Pages can render shared shells more than once, so reuse an existing
        // preloaded bundle instead of injecting duplicate script tags.
        if (existingScript.dataset.preloadedReady === 'true') {
          const loadedProducts = DJ.getPreloadedProductsForSource(source);
          if (loadedProducts) {
            resolve(loadedProducts);
            return;
          }

          reject(new Error(`Preloaded product bundle ${scriptName} did not expose ${source}.`));
          return;
        }

        existingScript.addEventListener('load', () => {
          existingScript.dataset.preloadedReady = 'true';
          const loadedProducts = DJ.getPreloadedProductsForSource(source);
          if (loadedProducts) {
            resolve(loadedProducts);
            return;
          }

          reject(new Error(`Preloaded product bundle ${scriptName} did not expose ${source}.`));
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
        const loadedProducts = DJ.getPreloadedProductsForSource(source);
        if (loadedProducts) {
          resolve(loadedProducts);
          return;
        }

        reject(new Error(`Preloaded product bundle ${scriptName} did not expose ${source}.`));
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

  DJ.displayPrice = function displayPrice(item) {
    return item?.priceLabel && String(item.priceLabel).trim() ? item.priceLabel : formatCurrency(item?.price);
  };

  DJ.numericPrice = function numericPrice(item) {
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
  };

  DJ.getWishlist = getWishlist;
  DJ.getSiteMetrics = getSiteMetrics;
  DJ.recordSiteMetric = recordSiteMetric;
  DJ.setWishlist = function setWishlist(items) {
    const normalized = [...new Set((Array.isArray(items) ? items : []).map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
    if (!safeStorageSet(STORAGE_KEYS.wishlist, JSON.stringify(normalized))) {
      console.error('Failed to save wishlist.');
    }
    const persistedWishlist = getWishlist();
    updateWishlistCount();
    emitWishlistChange(persistedWishlist, 'local');
  };

  DJ.getCustomProducts = function getCustomProducts() {
    const customProducts = readJSONFromStorage(STORAGE_KEYS.customProducts, (value) => (Array.isArray(value) ? value : []));
    return Array.isArray(customProducts) ? customProducts : [];
  };

  DJ.saveCustomProducts = function saveCustomProducts(items) {
    if (!safeStorageSet(STORAGE_KEYS.customProducts, JSON.stringify(Array.isArray(items) ? items : []))) {
      console.error('Failed to save custom products.');
      return false;
    }
    return true;
  };

  DJ.getProductOverrides = function getProductOverrides() {
    const overrides = readJSONFromStorage(STORAGE_KEYS.productOverrides, (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}));
    return overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {};
  };

  DJ.saveProductOverrides = function saveProductOverrides(overrides) {
    if (!safeStorageSet(STORAGE_KEYS.productOverrides, JSON.stringify(overrides && typeof overrides === 'object' && !Array.isArray(overrides) ? overrides : {}))) {
      console.error('Failed to save product overrides.');
      return false;
    }
    return true;
  };

  DJ.getDeletedProductIds = function getDeletedProductIds() {
    const ids = readJSONFromStorage(STORAGE_KEYS.deletedProductIds, (value) => {
      if (!Array.isArray(value)) {
        return [];
      }

      return [...new Set(value.map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
    });

    return Array.isArray(ids) ? ids : [];
  };

  DJ.saveDeletedProductIds = function saveDeletedProductIds(ids) {
    const normalized = [...new Set((Array.isArray(ids) ? ids : []).map((item) => Number(item)).filter((item) => Number.isFinite(item)))];
    if (!safeStorageSet(STORAGE_KEYS.deletedProductIds, JSON.stringify(normalized))) {
      console.error('Failed to save deleted product IDs.');
      return false;
    }
    return true;
  };

  DJ.applyStoredCatalogMutations = function applyStoredCatalogMutations(baseProducts, options = {}) {
    const products = Array.isArray(baseProducts) ? [...baseProducts] : [];
    const includeCustomProducts = options.includeCustomProducts !== false;
    const overrides = DJ.getProductOverrides();
    const deletedIds = new Set(DJ.getDeletedProductIds().map((item) => Number(item)));
    const seenIds = new Set();

    const mergedProducts = products
      .filter((product) => product && !deletedIds.has(Number(product.id)))
      .map((product) => {
        const productId = Number(product.id);
        if (Number.isFinite(productId)) {
          seenIds.add(productId);
        }

        const override = overrides[String(product.id)] || overrides[productId] || null;
        if (!override || typeof override !== 'object' || Array.isArray(override)) {
          return product;
        }

        const merged = { ...product, ...override };

        if (Object.prototype.hasOwnProperty.call(override, 'image')) {
          merged.image = override.image;
        }

        if (Object.prototype.hasOwnProperty.call(override, 'imageGallery')) {
          merged.imageGallery = Array.isArray(override.imageGallery) ? override.imageGallery : [];
        }

        return merged;
      });

    if (!includeCustomProducts) {
      return mergedProducts;
    }

    const uniqueCustomProducts = DJ.getCustomProducts().filter((product) => {
      const productId = Number(product?.id);
      if (!Number.isFinite(productId)) {
        return false;
      }

      if (deletedIds.has(productId) || seenIds.has(productId)) {
        return false;
      }

      seenIds.add(productId);
      return true;
    });

    return mergedProducts.concat(uniqueCustomProducts);
  };

  DJ.updateWishlistCount = updateWishlistCount;
  DJ.applyLazyLoading = applyLazyLoading;
  DJ.scheduleIdle = scheduleIdle;
  DJ.getScrollBehavior = getScrollBehavior;
  // Shared responsive helpers keep resize and media-query wiring consistent
  // across navigation, catalog, and future page modules.
  DJ.bindMediaQueryChange = bindMediaQueryChange;
  DJ.addRafResizeListener = addRafResizeListener;
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

  // Initialize shared UI behaviors once the DOM is ready. Individual page
  // modules layer their own features on top of these helpers later.
  document.addEventListener('DOMContentLoaded', () => {
    applyLazyLoading(document);
    enhanceHeaderLayout();
    initThemeToggle();
    initBackToTop();
    enhanceFooterContactLinks();
    enhanceFooterLayout();
    syncThemeTogglePlacement();
    initArchiveImageLightbox();
    initArchivePanels();
    updateWishlistCount();
    // Local metrics power the admin dashboard, but they are not critical to
    // first paint. Defer the storage write so page rendering stays responsive.
    scheduleIdle(() => {
      recordSiteMetric('page_view', {
        page: document.body.dataset.page || window.location.pathname,
        title: document.title
      });
    }, 1800);
    initHeaderScrollState();
    registerServiceWorker();
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
    }
  });

  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) {
      return;
    }

    applySavedTheme();
    updateWishlistCount();
    emitWishlistChange(getWishlist(), 'pageshow');
  });
})();
