/**
 * Remote catalog adapter used when backend mode is enabled.
 * -----------------------------------------------------------------------------
 * The storefront and admin both talk to this file instead of talking to Supabase
 * directly. That keeps auth, storage uploads, row mapping, and caching in one
 * place and makes it easier to swap providers later if needed.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;

  // Read user-editable backend settings from backend-config.js and merge them
  // with safe defaults so the site can still run in static-only mode.
  const userConfig = window.DJ_BACKEND_CONFIG || {};
  const config = {
    enabled: false,
    provider: 'supabase',
    supabaseUrl: '',
    supabasePublishableKey: '',
    productsTable: 'products',
    storageBucket: 'product-images',
    imageFolder: 'products',
    siteUrl: window.location.origin || '',
    ...userConfig
  };
  const requestedEnabled = Boolean(config.enabled);

  function hasPlaceholderApiKey(value = '') {
    const key = String(value || '').trim();
    if (!key) return true;
    return [
      'REPLACE_WITH_',
      'YOUR_SUPABASE_',
      'YOUR_PROJECT_',
      'SUPABASE_ANON_KEY',
      'YOUR_ANON_KEY'
    ].some((token) => key.toUpperCase().includes(token));
  }

  config.supabaseUrl = String(config.supabaseUrl || '').trim();
  config.supabasePublishableKey = String(config.supabasePublishableKey || '').trim();
  config.productsTable = String(config.productsTable || 'products').trim() || 'products';
  config.storageBucket = String(config.storageBucket || 'product-images').trim() || 'product-images';
  config.imageFolder = String(config.imageFolder || 'products').trim().replace(/^\/+|\/+$/g, '') || 'products';
  config.siteUrl = String(config.siteUrl || window.location.origin || '').trim();

  const hasSupabaseProvider = config.provider === 'supabase';
  const hasValidProjectUrl = /^https:\/\/[a-z0-9-]+\.supabase\.co(?:\/)?$/i.test(config.supabaseUrl);

  config.enabled = Boolean(
    requestedEnabled &&
    hasSupabaseProvider &&
    hasValidProjectUrl &&
    !hasPlaceholderApiKey(config.supabasePublishableKey)
  );

  let supabaseClient = null;
  let preparePromise = null;
  let remoteCacheLifecycleBound = false;

  // Cache list queries by source/filters so repeated storefront views do not
  // keep hitting the backend during a single page lifetime.
  const remoteCache = new Map();
  const REMOTE_CACHE_TTL_MS = 2 * 60 * 1000;

  const SOURCE_CATEGORY_FILTERS = {
    'products-sports.json': ['Baseball', 'Basketball', 'Football'],
    'products-baseball.json': ['Baseball'],
    'products-basketball.json': ['Basketball'],
    'products-football.json': ['Football'],
    'products-comics.json': ['Comics'],
    'products-collectibles.json': ['Collectibles', 'Other']
  };
  const REMOTE_LIST_SALE_STATE_COLUMNS = [
    'quantity_available',
    'checkout_enabled',
    'checkout_price',
    'sale_status',
    'sold_at',
    'hidden_reason',
    'archived_at'
  ];
  const REMOTE_LIST_SELECT_COLUMNS = [
    'id',
    'name',
    'category',
    'team',
    'year',
    'condition',
    'price',
    'price_label',
    'display_price',
    'image',
    'image_gallery',
    'description',
    'photo_host_page_url',
    'legacy_image_label',
    'source_page',
    'league',
    'sport',
    'player_athlete',
    'copy_count',
    'quantity_available',
    'checkout_enabled',
    'checkout_price',
    'sale_status',
    'sold_at',
    'hidden_reason',
    'archived_at',
    'item_photo_url',
    'item_photo_urls',
    'html_full_link',
    'html_image_urls',
    'metadata',
    'is_featured',
    'is_deleted',
    'sort_rank',
    'created_at',
    'updated_at'
  ].join(',');
  const LEGACY_REMOTE_LIST_SELECT_COLUMNS = REMOTE_LIST_SELECT_COLUMNS
    .split(',')
    .filter((column) => !REMOTE_LIST_SALE_STATE_COLUMNS.includes(column))
    .join(',');
  let remoteListSelectColumns = REMOTE_LIST_SELECT_COLUMNS;

  function isMissingRemoteListColumnError(error) {
    const code = String(error?.code || error?.status || '').trim();
    const message = [
      error?.message,
      error?.details,
      error?.hint,
      error?.error_description
    ].filter(Boolean).join(' ').toLowerCase();

    return (
      code === '42703' ||
      code === 'PGRST204' ||
      (message.includes('column') && (message.includes('does not exist') || message.includes('schema cache')))
    );
  }

  function projectRefFromUrl(url = '') {
    const match = String(url).match(/^https:\/\/([^.]+)\.supabase\.co(?:\/|$)/i);
    return match?.[1] || 'supabase';
  }

  function getConfigDiagnostics() {
    const issues = [];

    if (!requestedEnabled) {
      issues.push('Set enabled: true in backend-config.js to turn on backend mode.');
    }

    if (!hasSupabaseProvider) {
      issues.push('Set provider to "supabase" in backend-config.js.');
    }

    if (!config.supabaseUrl) {
      issues.push('Add your Supabase project URL in backend-config.js.');
    } else if (!hasValidProjectUrl) {
      issues.push('Use the full project URL, for example https://your-project.supabase.co.');
    }

    if (hasPlaceholderApiKey(config.supabasePublishableKey)) {
      issues.push('Replace the placeholder Supabase browser key with the current publishable key from Project Settings > API.');
    }

    return {
      enabled: config.enabled,
      provider: config.provider,
      requestedEnabled,
      projectUrl: config.supabaseUrl,
      hasBrowserKey: !hasPlaceholderApiKey(config.supabasePublishableKey),
      productsTable: config.productsTable,
      storageBucket: config.storageBucket,
      imageFolder: config.imageFolder,
      issues
    };
  }

  function describeSupabaseError(error, context = 'general') {
    const originalMessage = String(
      error?.message ||
      error?.error_description ||
      error?.details ||
      error?.hint ||
      ''
    ).trim();
    const lower = originalMessage.toLowerCase();
    const code = String(error?.code || error?.status || '').trim();

    if (!originalMessage) {
      return 'Unexpected Supabase error.';
    }

    if (String(context || '').startsWith('function:')) {
      const functionMessage = describeFunctionMessage(originalMessage, context);
      if (functionMessage !== originalMessage) return functionMessage;
    }

    if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
      return 'Could not reach Supabase. Check the project URL, network access, and whether the Supabase project is paused.';
    }

    if (lower.includes('invalid api key') || lower.includes('apikey') || lower.includes('invalid jwt')) {
      return 'Supabase rejected the API key. Make sure backend-config.js contains the current publishable browser key for this project under supabasePublishableKey.';
    }

    if (lower.includes('invalid login credentials')) {
      return 'Sign-in failed. Check the admin email and password in Supabase Auth.';
    }

    if (lower.includes('email not confirmed')) {
      return 'That Supabase user has not confirmed their email yet. Confirm the account in Supabase Auth before signing in.';
    }

    if (lower.includes('relation') && lower.includes(config.productsTable.toLowerCase()) && lower.includes('does not exist')) {
      return `The ${config.productsTable} table does not exist yet. Run the current supabase-schema.sql in the Supabase SQL Editor.`;
    }

    if (context === 'listProducts' && isMissingRemoteListColumnError(error)) {
      return `The ${config.productsTable} table is missing the current storefront catalog columns. Run the current supabase-schema.sql in the Supabase SQL Editor.`;
    }

    if (lower.includes('bucket') && lower.includes(config.storageBucket.toLowerCase()) && lower.includes('not found')) {
      return `The ${config.storageBucket} storage bucket is missing. Run the current supabase-schema.sql in the Supabase SQL Editor.`;
    }

    if (code === '42501' || lower.includes('row-level security') || lower.includes('permission denied')) {
      return 'Supabase rejected that action. Make sure you are signed in as the admin email and that the current RLS policies from supabase-schema.sql have been applied.';
    }

    if (context === 'listProducts' && lower.includes('jwt expired')) {
      return 'Your Supabase session expired. Sign in again in the admin page.';
    }

    return originalMessage;
  }

  function createFriendlyError(error, context) {
    return new Error(describeSupabaseError(error, context));
  }

  function describeFunctionMessage(message = '', context = '') {
    const text = String(message || '').trim();
    const lower = text.toLowerCase();
    const functionName = String(context || '').replace(/^function:/, '').trim();

    if (
      lower.includes('requested function was not found') ||
      lower.includes('function was not found') ||
      (lower.includes('function') && lower.includes('not found'))
    ) {
      const label = functionName ? `The ${functionName} Supabase Edge Function` : 'The Supabase Edge Function';
      return `${label} is not deployed to this Supabase project yet. Secure checkout is unavailable right now, so please use the purchase inquiry email.`;
    }

    return text;
  }

  async function createFunctionError(error, context) {
    const response = error?.context || error?.response;
    if (response && typeof response.clone === 'function') {
      try {
        const payload = await response.clone().json();
        const message = String(payload?.error || payload?.message || '').trim();
        if (message) return new Error(describeFunctionMessage(message, context));
      } catch {
        // Fall through to the normal Supabase message if the response is not JSON.
      }
    }

    return createFriendlyError(error, context);
  }

  // ---------------------------------------------------------------------------
  // Setup and bootstrapping helpers
  // ---------------------------------------------------------------------------

  function isConfigured() {
    return config.enabled;
  }

  function clearCache() {
    remoteCache.clear();
  }

  /**
   * Keep the in-memory remote cache fresh when the browser reconnects, restores
   * a cached page, or regains focus after the user has been away for a while.
   */
  function bindRemoteCacheLifecycle() {
    if (remoteCacheLifecycleBound || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    remoteCacheLifecycleBound = true;
    window.addEventListener('online', clearCache);
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) {
        clearCache();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        clearCache();
      }
    });
  }

  function getCachedRemotePromise(cacheKey, { force = false } = {}) {
    if (force) {
      remoteCache.delete(cacheKey);
      return null;
    }

    const entry = remoteCache.get(cacheKey);
    if (!entry) {
      return null;
    }

    const age = Date.now() - Number(entry.createdAt || 0);
    if (!Number.isFinite(age) || age > REMOTE_CACHE_TTL_MS) {
      remoteCache.delete(cacheKey);
      return null;
    }

    return entry.promise || null;
  }

  function setCachedRemotePromise(cacheKey, promise) {
    remoteCache.set(cacheKey, {
      createdAt: Date.now(),
      promise
    });
  }

  let supabaseLibraryPromise = null;
  const SUPABASE_LIBRARY_LOAD_TIMEOUT_MS = 8000;

  function hasSupabaseLibrary() {
    return Boolean(window.supabase && typeof window.supabase.createClient === 'function');
  }

  function waitForSupabaseScript(script, url) {
    if (hasSupabaseLibrary()) return Promise.resolve(true);
    if (script.dataset.supabaseLoadState === 'failed' || script.dataset.supabaseLoadState === 'loaded') {
      script.remove();
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (loaded) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
        script.dataset.supabaseLoadState = loaded ? 'loaded' : 'failed';
        if (!loaded) script.remove();
        resolve(loaded);
      };
      const onLoad = () => finish(hasSupabaseLibrary());
      const onError = () => finish(false);
      const timer = window.setTimeout(() => finish(false), SUPABASE_LIBRARY_LOAD_TIMEOUT_MS);
      script.addEventListener('load', onLoad, { once: true });
      script.addEventListener('error', onError, { once: true });
      script.dataset.supabaseLoadState = script.dataset.supabaseLoadState || 'loading';
      script.dataset.supabaseCdnUrl = url;
    });
  }

  /**
   * Lazy-load the Supabase browser SDK only when backend mode is enabled.
   * Public storefront pages stay lightweight when the site is running in static mode.
   */
  function ensureSupabaseLibrary() {
    if (!isConfigured()) return Promise.resolve(false);
    if (hasSupabaseLibrary()) {
      return Promise.resolve(true);
    }

    if (supabaseLibraryPromise) {
      return supabaseLibraryPromise;
    }

    const sdkVersion = '2.49.4';
    const candidateUrls = [
      'vendor/supabase.min.js',
      `https://cdn.jsdelivr.net/npm/@supabase/supabase-js@${sdkVersion}/dist/umd/supabase.min.js`,
      `https://unpkg.com/@supabase/supabase-js@${sdkVersion}/dist/umd/supabase.min.js`
    ];

    supabaseLibraryPromise = (async () => {
      for (const url of candidateUrls) {
        const existing = document.querySelector(`script[data-supabase-cdn-url="${url}"]`);
        if (existing) {
          if (await waitForSupabaseScript(existing, url)) return true;
          continue;
        }

        const script = document.createElement('script');
        script.src = url;
        script.defer = true;
        script.crossOrigin = 'anonymous';
        script.dataset.supabaseCdn = 'true';
        const loadResult = waitForSupabaseScript(script, url);
        document.head.appendChild(script);
        const loaded = await loadResult;

        if (loaded) {
          return true;
        }
      }

      throw new Error('Failed to load the Supabase client library from the local bundle or the approved fallback CDNs. Check file uploads, network access, or a Content-Security-Policy that blocks those sources.');
    })().catch((error) => {
      supabaseLibraryPromise = null;
      throw error;
    });

    return supabaseLibraryPromise;
  }

  /**
   * Create and memoize the browser client. We keep a single instance so auth state
   * and realtime subscriptions are not duplicated.
   */
  function getClient() {
    if (!isConfigured()) return null;
    if (supabaseClient) return supabaseClient;
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      throw new Error('Supabase client library is not loaded.');
    }

    supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: `dj-house-auth-${projectRefFromUrl(config.supabaseUrl)}`
      }
    });

    return supabaseClient;
  }

  // ---------------------------------------------------------------------------
  // Product shape conversion helpers
  // ---------------------------------------------------------------------------

  function normalizeStringArray(value) {
    return Array.isArray(value)
      ? [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
      : [];
  }

  function normalizeObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : {};
  }

  const OPERATIONAL_METADATA_KEYS = new Set([
    'sold_via',
    'stripe_session_id',
    'last_quantity_sold',
    'last_sold_at',
    'last_inventory_source',
    'last_shopify_webhook_id',
    'last_shopify_inventory_at',
    'last_shopify_source_updated_at'
  ]);

  function isOperationalMetadataKey(key = '') {
    const normalized = String(key || '').trim().toLowerCase();
    return OPERATIONAL_METADATA_KEYS.has(normalized)
      || normalized.startsWith('stripe_')
      || normalized.startsWith('last_shopify_');
  }

  function catalogMetadata(value, includeOperationalState = false) {
    const source = normalizeObject(value);
    return Object.fromEntries(Object.entries(source).filter(([key]) => (
      includeOperationalState || !isOperationalMetadataKey(key)
    )));
  }

  function mergeRemoteOperationalMetadata(payload, remoteMetadata) {
    const merged = { ...catalogMetadata(payload?.metadata, false) };
    for (const [key, value] of Object.entries(normalizeObject(remoteMetadata))) {
      if (isOperationalMetadataKey(key)) merged[key] = value;
    }
    payload.metadata = merged;
    return payload;
  }

  function normalizePlayerAthlete(value = '') {
    return String(value || '').trim().replace(/\s*\|\s*/g, '|');
  }

  function prepareSeedProducts(products = [], options = {}) {
    if (!Array.isArray(products)) return [];

    const featuredRankMap = new Map();
    const featuredProducts = Array.isArray(options.featuredProducts) ? options.featuredProducts : [];

    featuredProducts.forEach((product, index) => {
      const id = Number(product?.id);
      if (!Number.isFinite(id) || featuredRankMap.has(id)) return;
      featuredRankMap.set(id, index + 1);
    });

    return products.map((product) => {
      const id = Number(product?.id);
      const rawSortRank = Number(product?.sortRank);
      const hasExplicitSortRank =
        product?.sortRank !== '' &&
        product?.sortRank !== null &&
        product?.sortRank !== undefined &&
        Number.isFinite(rawSortRank);
      const featuredRank = featuredRankMap.get(id);

      return {
        ...product,
        isFeatured: Boolean(product?.isFeatured || featuredRankMap.has(id)),
        sortRank: featuredRank && (!hasExplicitSortRank || rawSortRank === 0)
          ? featuredRank
          : (hasExplicitSortRank ? rawSortRank : 0)
      };
    });
  }

  /**
   * Convert a database row into the exact product shape expected by the storefront.
   */
  function toLocalProduct(row = {}) {
    return {
      id: row.id,
      name: row.name || '',
      category: row.category || 'Other',
      team: row.team || '',
      year: row.year,
      condition: row.condition || '',
      price: row.price,
      priceLabel: row.price_label || '',
      displayPrice: row.display_price || '',
      image: row.image || '',
      imageGallery: normalizeStringArray(row.image_gallery),
      description: row.description || '',
      photoHostPageUrl: row.photo_host_page_url || '',
      legacyImageLabel: row.legacy_image_label || '',
      sourcePage: row.source_page || '',
      league: row.league || '',
      sport: row.sport || '',
      playerAthlete: normalizePlayerAthlete(row.player_athlete),
      copyCount: Number.isFinite(Number(row.copy_count)) ? Number(row.copy_count) : null,
      quantityAvailable: Number.isFinite(Number(row.quantity_available)) ? Number(row.quantity_available) : null,
      checkoutEnabled: row.checkout_enabled !== false,
      checkoutPrice: Number.isFinite(Number(row.checkout_price)) ? Number(row.checkout_price) : null,
      saleStatus: row.sale_status || 'available',
      soldAt: row.sold_at || '',
      hiddenReason: row.hidden_reason || '',
      archivedAt: row.archived_at || '',
      itemPhotoUrl: row.item_photo_url || '',
      itemPhotoUrls: normalizeStringArray(row.item_photo_urls),
      htmlFullLink: row.html_full_link || '',
      htmlImageUrls: normalizeStringArray(row.html_image_urls),
      metadata: normalizeObject(row.metadata),
      isFeatured: Boolean(row.is_featured),
      isDeleted: Boolean(row.is_deleted),
      sortRank: Number.isFinite(Number(row.sort_rank)) ? Number(row.sort_rank) : 0,
      createdAt: row.created_at || '',
      updatedAt: row.updated_at || ''
    };
  }

  function toRemoteProduct(product = {}, options = {}) {
    const normalizedYear = product.year === '' || product.year === null || product.year === undefined
      ? null
      : Number(product.year);
    const normalizedPrice = product.price === '' || product.price === null || product.price === undefined
      ? null
      : Number(product.price);
    const normalizedCopyCount = product.copyCount === '' || product.copyCount === null || product.copyCount === undefined
      ? null
      : Number(product.copyCount);
    const normalizedQuantityAvailable = product.quantityAvailable === '' || product.quantityAvailable === null || product.quantityAvailable === undefined
      ? normalizedCopyCount
      : Number(product.quantityAvailable);
    const normalizedCheckoutPrice = product.checkoutPrice === '' || product.checkoutPrice === null || product.checkoutPrice === undefined
      ? null
      : Number(product.checkoutPrice);
    const normalizedGallery = normalizeStringArray(product.imageGallery);
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(product, key);
    const includeOperationalState = options.includeOperationalState === true;
    const payload = {
      id: Number(product.id),
      name: String(product.name || '').trim(),
      category: String(product.category || 'Other').trim() || 'Other',
      team: String(product.team || '').trim(),
      year: Number.isFinite(normalizedYear) ? normalizedYear : null,
      condition: String(product.condition || '').trim(),
      price: Number.isFinite(normalizedPrice) ? normalizedPrice : null,
      price_label: String(product.priceLabel || '').trim(),
      image: String(product.image || '').trim(),
      image_gallery: normalizedGallery,
      description: String(product.description || '').trim(),
      is_featured: Boolean(product.isFeatured),
      sort_rank: Number.isFinite(Number(product.sortRank)) ? Number(product.sortRank) : 0
    };

    if (hasOwn('photoHostPageUrl')) {
      payload.photo_host_page_url = String(product.photoHostPageUrl || '').trim();
    }

    if (hasOwn('legacyImageLabel')) {
      payload.legacy_image_label = String(product.legacyImageLabel || '').trim();
    }

    if (hasOwn('sourcePage')) {
      payload.source_page = String(product.sourcePage || '').trim();
    }

    if (hasOwn('league')) {
      payload.league = String(product.league || '').trim();
    }

    if (hasOwn('sport')) {
      payload.sport = String(product.sport || '').trim();
    }

    if (hasOwn('playerAthlete')) {
      payload.player_athlete = normalizePlayerAthlete(product.playerAthlete);
    }

    if (hasOwn('displayPrice')) {
      payload.display_price = String(product.displayPrice || '').trim();
    }

    if (includeOperationalState && hasOwn('copyCount')) {
      payload.copy_count = Number.isFinite(normalizedCopyCount) ? normalizedCopyCount : null;
    }

    if (includeOperationalState && (hasOwn('quantityAvailable') || hasOwn('copyCount'))) {
      payload.quantity_available = Number.isFinite(normalizedQuantityAvailable) ? normalizedQuantityAvailable : 1;
    }

    if (includeOperationalState && hasOwn('checkoutEnabled')) {
      payload.checkout_enabled = Boolean(product.checkoutEnabled);
    }

    if (hasOwn('checkoutPrice')) {
      payload.checkout_price = Number.isFinite(normalizedCheckoutPrice) ? normalizedCheckoutPrice : null;
    }

    if (includeOperationalState && hasOwn('saleStatus')) {
      payload.sale_status = String(product.saleStatus || 'available').trim() || 'available';
    }

    if (includeOperationalState && hasOwn('soldAt')) {
      payload.sold_at = product.soldAt || null;
    }

    if (includeOperationalState && hasOwn('hiddenReason')) {
      payload.hidden_reason = String(product.hiddenReason || '').trim();
    }

    if (includeOperationalState && hasOwn('archivedAt')) {
      payload.archived_at = product.archivedAt || null;
    }

    if (includeOperationalState && hasOwn('isDeleted')) {
      payload.is_deleted = Boolean(product.isDeleted);
    }

    if (hasOwn('itemPhotoUrl')) {
      payload.item_photo_url = String(product.itemPhotoUrl || '').trim();
    }

    if (hasOwn('itemPhotoUrls')) {
      payload.item_photo_urls = normalizeStringArray(product.itemPhotoUrls);
    }

    if (hasOwn('htmlFullLink')) {
      payload.html_full_link = String(product.htmlFullLink || '').trim();
    }

    if (hasOwn('htmlImageUrls')) {
      payload.html_image_urls = normalizeStringArray(product.htmlImageUrls);
    }

    if (hasOwn('metadata')) {
      payload.metadata = catalogMetadata(product.metadata, includeOperationalState);
    }

    return payload;
  }

  /**
   * Reuse the same per-page source filters that the static JSON build uses so the
   * storefront behaves the same whether it is reading from files or from Supabase.
   */
  function applySourceFilters(query, source) {
    if (!source) return query;

    if (source === 'products-featured.json') {
      return query.eq('is_featured', true).limit(12);
    }

    const allowedCategories = SOURCE_CATEGORY_FILTERS[source];
    if (Array.isArray(allowedCategories) && allowedCategories.length) {
      return query.in('category', allowedCategories);
    }

    return query;
  }

  /**
   * Prepare the backend client once and reuse the same promise for concurrent calls.
   * This avoids duplicate script loads and duplicate client bootstrapping work.
   */
  async function prepare() {
    if (!isConfigured()) return null;
    bindRemoteCacheLifecycle();
    if (!preparePromise) {
      preparePromise = ensureSupabaseLibrary()
        .then(() => getClient())
        .catch((error) => {
          preparePromise = null;
          throw error;
        });
    }
    return preparePromise;
  }

  async function getRequiredClient() {
    const client = await prepare();
    if (!client) throw new Error('Backend is not configured.');
    return client;
  }

  // ---------------------------------------------------------------------------
  // Read operations used by the storefront
  // ---------------------------------------------------------------------------

  async function runRemoteListQuery(buildQuery) {
    const selectColumns = remoteListSelectColumns;
    let { data, error } = await buildQuery(selectColumns);

    if (error && selectColumns === REMOTE_LIST_SELECT_COLUMNS && isMissingRemoteListColumnError(error)) {
      // Older live databases may not have the sale-state columns yet. The row
      // mapper already defaults those fields, so storefront reads can continue
      // while the SQL migration is applied.
      remoteListSelectColumns = LEGACY_REMOTE_LIST_SELECT_COLUMNS;
      ({ data, error } = await buildQuery(remoteListSelectColumns));
    }

    return { data: data || [], error };
  }

  /**
   * Load products from Supabase with the same source semantics as the static JSON files.
   */
  async function listProducts(options = {}) {
    const client = await prepare();
    if (!client) return [];
    // Direct-ID lookups back wishlist/detail flows, so normalize once and preserve
    // the requested order in the final mapped result instead of relying on SQL sort.
    const normalizedIds = Array.isArray(options.ids)
      ? [...new Set(options.ids.map((value) => Number(value)).filter(Number.isFinite))]
      : null;

    if (Array.isArray(normalizedIds) && !normalizedIds.length) {
      return [];
    }

    const cacheKey = JSON.stringify({
      source: options.source || 'products.json',
      ids: normalizedIds,
      featuredOnly: Boolean(options.featuredOnly)
    });

    const cachedPromise = getCachedRemotePromise(cacheKey, { force: options.force });
    if (cachedPromise) {
      return cachedPromise;
    }

    const pending = (async () => {
      try {
        let rows = [];

        if (Array.isArray(normalizedIds) && normalizedIds.length) {
          const { data, error } = await runRemoteListQuery((selectColumns) => client
            .from(config.productsTable)
            .select(selectColumns)
            .eq('is_deleted', false)
            .in('id', normalizedIds)
            .order('sort_rank', { ascending: true, nullsFirst: false })
            .order('year', { ascending: false, nullsFirst: false })
            .order('id', { ascending: true }));

          if (error) throw createFriendlyError(error, 'listProducts');
          rows = data;
          const productsById = new Map(rows.map((row) => {
            const normalizedProduct = toLocalProduct(row);
            return [Number(normalizedProduct.id), normalizedProduct];
          }));
          return normalizedIds.map((id) => productsById.get(id)).filter(Boolean);
        }

        if (options.featuredOnly) {
          const { data, error } = await runRemoteListQuery((selectColumns) => client
            .from(config.productsTable)
            .select(selectColumns)
            .eq('is_deleted', false)
            .eq('is_featured', true)
            .order('sort_rank', { ascending: true, nullsFirst: false })
            .order('year', { ascending: false, nullsFirst: false })
            .order('id', { ascending: true })
            .limit(12));

          if (error) throw error;
          rows = data;
          return rows.map(toLocalProduct);
        }

        const pageSize = 1000;
        let start = 0;
        while (true) {
          const { data, error } = await runRemoteListQuery((selectColumns) => {
            let query = client
            .from(config.productsTable)
            .select(selectColumns)
            .eq('is_deleted', false);

            query = applySourceFilters(query, options.source)
              .order('sort_rank', { ascending: true, nullsFirst: false })
              .order('year', { ascending: false, nullsFirst: false })
              .order('id', { ascending: true })
              .range(start, start + pageSize - 1);

            return query;
          });

          if (error) throw error;

          const page = data;
          rows.push(...page);

          if (page.length < pageSize) {
            break;
          }

          start += pageSize;
        }

        return rows.map(toLocalProduct);
      } catch (error) {
        throw createFriendlyError(error, 'listProducts');
      }
    })();

    // Force-refresh calls should bypass the shared cache without overwriting the
    // in-flight promise used by the steady-state storefront loads.
    if (!options.force) {
      setCachedRemotePromise(cacheKey, pending);
    }

    try {
      return await pending;
    } catch (error) {
      if (!options.force) {
        remoteCache.delete(cacheKey);
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Auth operations used by the remote admin
  // ---------------------------------------------------------------------------

  async function getSession() {
    const client = await prepare();
    if (!client) return null;
    const { data, error } = await client.auth.getSession();
    if (error) throw createFriendlyError(error, 'getSession');
    return data.session || null;
  }

  async function signIn(email, password) {
    const client = await getRequiredClient();
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw createFriendlyError(error, 'signIn');
    return data;
  }

  async function signUp(email, password, options = {}) {
    const client = await getRequiredClient();
    const siteOrigin = String(config.siteUrl || window.location.origin).replace(/\/+$/, '');
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${siteOrigin}/account.html${options.resumeCheckout ? '?checkout=resume' : ''}`
      }
    });
    if (error) throw createFriendlyError(error, 'signUp');
    return data;
  }

  async function resetPassword(email) {
    const client = await getRequiredClient();
    const siteOrigin = String(config.siteUrl || window.location.origin).replace(/\/+$/, '');
    const { data, error } = await client.auth.resetPasswordForEmail(email, {
      redirectTo: `${siteOrigin}/account.html?mode=reset-password`
    });
    if (error) throw createFriendlyError(error, 'resetPassword');
    return data;
  }

  async function updatePassword(password) {
    const client = await getRequiredClient();
    const { data, error } = await client.auth.updateUser({ password });
    if (error) throw createFriendlyError(error, 'updatePassword');
    return data;
  }

  async function listOrders() {
    const client = await prepare();
    if (!client) return [];
    const { data, error } = await client
      .from('checkout_orders')
      .select('id,product_id,item_count,amount_total,currency,status,created_at,updated_at,products(name),checkout_order_items(product_id,quantity,unit_amount,product_name,product_image,product_price_label,product_category,product_year,product_condition)')
      .order('created_at', { ascending: false })
      .limit(12);
    if (error) throw createFriendlyError(error, 'listOrders');
    return Array.isArray(data) ? data : [];
  }

  async function requireAuthenticatedUser(client) {
    const { data, error } = await client.auth.getUser();
    if (error) throw createFriendlyError(error, 'account');
    if (!data?.user) throw new Error('Sign in to use your customer account.');
    return data.user;
  }

  async function getAccountProfile() {
    const client = await prepare();
    if (!client) return { profile: {}, updatedAt: '' };
    await requireAuthenticatedUser(client);
    const { data, error } = await client
      .from('customer_account_profiles')
      .select('profile,updated_at')
      .maybeSingle();
    if (error) throw createFriendlyError(error, 'getAccountProfile');
    return {
      profile: normalizeObject(data?.profile),
      updatedAt: data?.updated_at || ''
    };
  }

  async function saveAccountProfile(profile = {}) {
    const client = await getRequiredClient();
    const user = await requireAuthenticatedUser(client);
    const { data, error } = await client
      .from('customer_account_profiles')
      .upsert({ id: user.id, profile: normalizeObject(profile) }, { onConflict: 'id' })
      .select('profile,updated_at')
      .single();
    if (error) throw createFriendlyError(error, 'saveAccountProfile');
    return {
      profile: normalizeObject(data?.profile),
      updatedAt: data?.updated_at || ''
    };
  }

  async function clearAccountProfile() {
    const client = await getRequiredClient();
    const user = await requireAuthenticatedUser(client);
    const { error } = await client
      .from('customer_account_profiles')
      .delete()
      .eq('id', user.id);
    if (error) throw createFriendlyError(error, 'clearAccountProfile');
  }

  async function listWishlist() {
    const client = await prepare();
    if (!client) return [];
    await requireAuthenticatedUser(client);
    const { data, error } = await client
      .from('customer_wishlist_items')
      .select('product_id')
      .order('created_at', { ascending: true });
    if (error) throw createFriendlyError(error, 'listWishlist');
    return [...new Set((data || []).map((row) => Number(row.product_id)).filter(Number.isFinite))];
  }

  async function replaceWishlist(productIds = []) {
    const client = await getRequiredClient();
    await requireAuthenticatedUser(client);
    const normalized = [...new Set(productIds.map(Number).filter(Number.isFinite))];
    const { error } = await client.rpc('replace_customer_wishlist', { product_ids: normalized });
    if (error) throw createFriendlyError(error, 'replaceWishlist');
    return normalized;
  }

  async function signOut() {
    const client = await prepare();
    if (!client) return;
    const { error } = await client.auth.signOut();
    if (error) throw createFriendlyError(error, 'signOut');
    clearCache();
  }

  function onAuthStateChange(callback) {
    if (!isConfigured()) return { unsubscribe() {} };
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      return { unsubscribe() {} };
    }
    const client = getClient();
    if (!client) return { unsubscribe() {} };
    const { data } = client.auth.onAuthStateChange((event, session) => {
      clearCache();
      if (typeof callback === 'function') {
        callback(event, session);
      }
    });
    return data?.subscription || { unsubscribe() {} };
  }

  async function invokeFunction(functionName, body = {}, options = {}) {
    const client = await getRequiredClient();

    const safeName = String(functionName || '').trim();
    if (!safeName) throw new Error('Choose a Supabase Edge Function to call.');

    const { data, error } = await client.functions.invoke(safeName, {
      body,
      method: options.method || 'POST'
    });

    if (error) throw await createFunctionError(error, `function:${safeName}`);
    return data;
  }

  function sanitizeFileName(name = 'file') {
    return String(name)
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/(^-|-$)/g, '') || 'file';
  }

  // ---------------------------------------------------------------------------
  // Storage and write operations used by the remote admin
  // ---------------------------------------------------------------------------

  /**
   * Upload a photo to Supabase Storage and return the resulting public URL.
   */
  async function uploadImage(file, options = {}) {
    const client = await getRequiredClient();
    if (!(file instanceof File)) throw new Error('Choose a valid image file.');
    const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!allowedImageTypes.has(String(file.type || '').toLowerCase())) {
      throw new Error('Choose a JPG, PNG, WebP, or GIF image to upload.');
    }

    const safeName = sanitizeFileName(file.name || 'image');
    const path = [
      String(options.folder || config.imageFolder || 'products').replace(/^\/+|\/+$/g, ''),
      `${Date.now()}-${options.productId || 'draft'}-${safeName}`
    ].filter(Boolean).join('/');

    const { error: uploadError } = await client
      .storage
      .from(config.storageBucket)
      .upload(path, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type || 'application/octet-stream'
      });

    if (uploadError) throw createFriendlyError(uploadError, 'uploadImage');

    const { data } = client.storage.from(config.storageBucket).getPublicUrl(path);
    return {
      path,
      publicUrl: data?.publicUrl || ''
    };
  }

  async function upsertProduct(product) {
    const client = await getRequiredClient();

    const payload = toRemoteProduct(product, { includeOperationalState: true });
    if (!Number.isFinite(payload.id)) {
      throw new Error('Product id is required for remote saves.');
    }
    if (!payload.name) throw new Error('Product name is required.');
    if (!payload.category) throw new Error('Product category is required.');

    const { data, error } = await client
      .from(config.productsTable)
      .upsert(payload, { onConflict: 'id' })
      .select()
      .single();

    if (error) throw createFriendlyError(error, 'upsertProduct');
    clearCache();
    return toLocalProduct(data);
  }

  async function syncProductToShopify(productId) {
    const id = Number(productId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('A valid product id is required for Shopify sync.');
    }
    return invokeFunction('shopify-catalog-sync', {
      action: 'sync-product',
      productId: id
    });
  }

  async function deleteProduct(productId) {
    const id = Number(productId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('A valid product id is required for deletion.');
    const result = await invokeFunction('shopify-catalog-sync', {
      action: 'delete-product',
      productId: id,
      confirmProductId: id,
      reason: 'Deleted from the DJHC admin listing editor.'
    });
    clearCache();
    return result;
  }

  async function verifyCheckoutSession(sessionId) {
    const normalized = String(sessionId || '').trim();
    if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{12,255}$/.test(normalized)) {
      throw new Error('A valid checkout session is required.');
    }
    const functionName = String(config.checkoutSessionStatusFunction || 'checkout-session-status').trim();
    const result = await invokeFunction(functionName, { sessionId: normalized });
    return { status: String(result?.status || 'unknown').trim().toLowerCase() };
  }

  async function seedProducts(products, options = {}) {
    const client = await getRequiredClient();
    const normalized = prepareSeedProducts(products, options)
      .map((product) => toRemoteProduct(product, {
        includeOperationalState: options.includeOperationalState === true
      }))
      .filter((item) => Number.isFinite(item.id) && item.name);
    if (!normalized.length) return 0;

    const chunkSize = Math.max(1, Number(options.chunkSize) || 200);
    let total = 0;

    for (let index = 0; index < normalized.length; index += chunkSize) {
      const slice = normalized.slice(index, index + chunkSize);
      if (options.includeOperationalState !== true && slice.some((item) => Object.hasOwn(item, 'metadata'))) {
        const ids = slice.map((item) => Number(item.id)).filter(Number.isSafeInteger);
        const { data: currentRows, error: currentError } = await client
          .from(config.productsTable)
          .select('id,metadata')
          .in('id', ids);
        if (currentError) throw createFriendlyError(currentError, 'seedProducts');
        const currentMetadata = new Map((currentRows || []).map((row) => [Number(row.id), row.metadata]));
        slice.forEach((item) => mergeRemoteOperationalMetadata(item, currentMetadata.get(Number(item.id))));
      }
      const { error } = await client
        .from(config.productsTable)
        .upsert(slice, { onConflict: 'id' });
      if (error) throw createFriendlyError(error, 'seedProducts');
      total += slice.length;
    }

    clearCache();
    return total;
  }


  async function testConnection() {
    const diagnostics = getConfigDiagnostics();
    if (!isConfigured()) {
      return {
        ok: false,
        steps: [{
          name: 'config',
          ok: false,
          message: 'Backend configuration needs attention before Supabase can be reached.',
          details: diagnostics.issues.length ? diagnostics.issues : ['Backend is not configured.']
        }]
      };
    }

    const steps = [{
      name: 'config',
      ok: true,
      message: `Using ${config.supabaseUrl} with table ${config.productsTable} and bucket ${config.storageBucket}.`
    }];

    try {
      await ensureSupabaseLibrary();
      steps.push({ name: 'sdk', ok: true, message: 'Supabase browser SDK loaded.' });
    } catch (error) {
      return {
        ok: false,
        steps: [{ name: 'sdk', ok: false, message: error.message || 'Failed to load Supabase SDK.' }]
      };
    }

    let client = null;
    try {
      client = getClient();
      steps.push({ name: 'client', ok: true, message: 'Supabase client created.' });
    } catch (error) {
      steps.push({ name: 'client', ok: false, message: error.message || 'Failed to create Supabase client.' });
      return { ok: false, steps };
    }

    try {
      const { error } = await client
        .from(config.productsTable)
        .select('id', { head: true, count: 'exact' })
        .eq('is_deleted', false)
        .limit(1);
      if (error) throw error;
      steps.push({ name: 'products', ok: true, message: `Reached ${config.productsTable}.` });
    } catch (error) {
      steps.push({ name: 'products', ok: false, message: describeSupabaseError(error, 'listProducts') });
    }

    try {
      const { error } = await client.storage.from(config.storageBucket).list(config.imageFolder || '', { limit: 1 });
      if (error) throw error;
      steps.push({ name: 'storage', ok: true, message: `Reached ${config.storageBucket} storage bucket.` });
    } catch (error) {
      steps.push({ name: 'storage', ok: false, message: describeSupabaseError(error, 'uploadImage') });
    }

    return {
      ok: steps.every((step) => step.ok),
      steps
    };
  }

  DJ.remoteCatalog = {
    provider: 'supabase',
    config,
    getConfigDiagnostics,
    isConfigured,
    prepare,
    getClient,
    getSession,
    signIn,
    signUp,
    resetPassword,
    updatePassword,
    signOut,
    onAuthStateChange,
    invokeFunction,
    listProducts,
    listOrders,
    getAccountProfile,
    saveAccountProfile,
    clearAccountProfile,
    listWishlist,
    replaceWishlist,
    upsertProduct,
    deleteProduct,
    syncProductToShopify,
    verifyCheckoutSession,
    uploadImage,
    seedProducts,
    testConnection,
    clearCache,
    toLocalProduct,
    toRemoteProduct
  };
})();

