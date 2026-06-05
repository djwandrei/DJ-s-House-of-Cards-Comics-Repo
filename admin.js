/**
 * Browser-local admin tools.
 * -----------------------------------------------------------------------------
 * This file powers the original static-site admin workflow: add custom products,
 * edit browser-only overrides for existing listings, export/import local changes,
 * and manage storefront-only deletions. In the backend-first build these tools are
 * still valuable as an offline/fallback editing layer.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;

  // Cache the static catalog request so the editor can reuse the same base data
  // across search, edit, restore, and import flows without refetching products.json.
  let baseProductsPromise = null;
  const customState = { search: '', category: 'All' };
  const ADMIN_VIEW_PREFS_KEY = 'djAdminViewPrefsV1';
  const MAX_ADMIN_JSON_IMPORT_BYTES = 15 * 1024 * 1024;
  // Existing listings are managed like a compact Seller Hub table: filters and
  // selected ids stay separate so bulk actions only touch the rows the user chose.
  const existingState = {
    search: '',
    category: 'All',
    status: 'All',
    sort: 'name-asc',
    density: readAdminViewPreference('density', 'comfortable'),
    selectedIds: new Set(),
    visibleIds: [],
    baseProducts: [],
    effectiveProducts: [],
    editingId: null,
    currentGallery: []
  };
  const MAX_EXISTING_RESULTS = 80;
  let existingEditorInitialized = false;
  let existingListingsReadyPromise = null;
  let adminInsightsRemoteProducts = null;
  let adminInsightsRefreshTimer = 0;
  let adminPageIsUnloading = false;

  window.addEventListener('pagehide', () => {
    adminPageIsUnloading = true;
  });
  window.addEventListener('pageshow', () => {
    adminPageIsUnloading = false;
  });

  // ---------------------------------------------------------------------------
  // Shared helpers for the browser-local admin experience
  // ---------------------------------------------------------------------------

  function updateSearchShellState(inputId, shellId) {
    const input = document.getElementById(inputId);
    const shell = document.getElementById(shellId);
    if (!input || !shell) return;
    shell.classList.toggle('has-value', Boolean(input.value.trim()));
  }

  function formatCountLabel(count, singular, plural = `${singular}s`) {
    const numeric = Number(count) || 0;
    return `${numeric} ${numeric === 1 ? singular : plural}`;
  }

  function debounce(callback, delay = 120) {
    let timer = 0;
    const debounced = (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
    debounced.cancel = () => window.clearTimeout(timer);
    return debounced;
  }

  function readAdminViewPrefs() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ADMIN_VIEW_PREFS_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function readAdminViewPreference(key, fallback) {
    const preferences = readAdminViewPrefs();
    return preferences[key] || fallback;
  }

  function writeAdminViewPreference(key, value) {
    try {
      localStorage.setItem(ADMIN_VIEW_PREFS_KEY, JSON.stringify({
        ...readAdminViewPrefs(),
        [key]: value
      }));
      return true;
    } catch {
      return false;
    }
  }

  function applyExistingDensityPreference() {
    const panel = document.querySelector('.admin-existing-panel');
    const select = document.getElementById('existingListingDensity');
    const density = existingState.density === 'compact' ? 'compact' : 'comfortable';
    if (panel) panel.dataset.density = density;
    if (select) select.value = density;
  }

  function buildAdminSearchIndex(product = {}) {
    return [
      product.id,
      product.name,
      product.team,
      product.category,
      product.description,
      product.playerAthlete,
      product.sourcePage,
      product.condition,
      product.year,
      product.isFeatured ? 'featured' : 'not featured'
    ].join(' ').toLowerCase();
  }

  function indexAdminProduct(product = {}) {
    return {
      ...product,
      _adminSearchIndex: buildAdminSearchIndex(product)
    };
  }

  function invalidateExistingProductsCache() {
    existingState.effectiveProducts = [];
  }

  function setBaseProducts(products = []) {
    existingState.baseProducts = Array.isArray(products) ? products : [];
    invalidateExistingProductsCache();
    return existingState.baseProducts;
  }

  function getStorageFailureMessage() {
    return 'This browser is out of storage space. Try smaller images or clear older custom items or storefront edits.';
  }

  function exportJsonFile(payload, filenamePrefix) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `${filenamePrefix}-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function exportTextFile(content, filenamePrefix, extension = 'txt', type = 'text/plain') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `${filenamePrefix}-${date}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function validateAdminJsonImportFile(file) {
    if (!file) {
      throw new Error('Choose a JSON backup file to import.');
    }

    if (file.size > MAX_ADMIN_JSON_IMPORT_BYTES) {
      throw new Error('That backup is too large for a browser-local import.');
    }

    if (file.name && !/\.json$/i.test(file.name)) {
      throw new Error('Admin imports must be JSON backup files.');
    }
  }

  async function resizeImageToDataUrl(file) {
    if (!file || !file.type.startsWith('image/')) {
      throw new Error('Please choose an image file.');
    }

    const objectUrl = URL.createObjectURL(file);

    try {
      const image = await new Promise((resolve, reject) => {
        const imageElement = new Image();
        imageElement.onload = () => resolve(imageElement);
        imageElement.onerror = () => reject(new Error('That image could not be processed.'));
        // Object URLs avoid creating a second base64 copy of large admin uploads
        // before the canvas resize step, keeping browser memory use noticeably lower.
        imageElement.src = objectUrl;
      });

      const maxDimension = 1400;
      let { width, height } = image;

      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.max(1, Math.round(width * ratio));
        height = Math.max(1, Math.round(height * ratio));
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('This browser could not prepare the image editor.');
      }
      context.drawImage(image, 0, 0, width, height);
      return canvas.toDataURL('image/jpeg', 0.88);
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function isKeyboardInteractiveDropzone(element) {
    const tabIndex = Number(element.getAttribute('tabindex'));
    return element.getAttribute('role') === 'button' || (Number.isFinite(tabIndex) && tabIndex >= 0);
  }

  function wireDropzone(element, handlers = {}) {
    if (!element) return;
    const { onFiles, onClick } = handlers;

    ['dragenter', 'dragover'].forEach((eventName) => {
      element.addEventListener(eventName, (event) => {
        event.preventDefault();
        element.classList.add('is-dragover');
      });
    });

    ['dragleave', 'dragend', 'drop'].forEach((eventName) => {
      element.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (eventName !== 'dragleave' || event.target === element) {
          element.classList.remove('is-dragover');
        }
      });
    });

    element.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer?.files || []);
      if (files.length && typeof onFiles === 'function') {
        onFiles(files);
      }
    });

    element.addEventListener('click', () => {
      if (typeof onClick === 'function') onClick();
    });

    if (isKeyboardInteractiveDropzone(element)) {
      element.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (typeof onClick === 'function') onClick();
        }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // New custom product form helpers
  // ---------------------------------------------------------------------------

  function updateDraftImagePreview(imageUrl = '', label = '') {
    const wrap = document.getElementById('imagePreviewWrap');
    const image = document.getElementById('imagePreview');
    const name = document.getElementById('imagePreviewName');
    const imageInput = document.getElementById('image');
    if (!wrap || !image || !name || !imageInput) return;

    if (!imageUrl) {
      wrap.hidden = true;
      image.removeAttribute('src');
      name.textContent = 'Selected image';
      wrap.removeAttribute('data-ready');
      return;
    }

    image.src = imageUrl;
    name.textContent = label || 'Selected image';
    wrap.hidden = false;
    wrap.setAttribute('data-ready', 'true');
    if (imageInput.value !== imageUrl) imageInput.value = imageUrl;
  }

  function clearDraftImage(options = {}) {
    const { keepUrl = false } = options;
    const imageInput = document.getElementById('image');
    const imageFile = document.getElementById('imageFile');
    if (imageFile) imageFile.value = '';
    if (imageInput && !keepUrl) imageInput.value = '';
    if (!keepUrl) updateDraftImagePreview('', '');
  }

  function replaceCustomProductImage(productId, imageUrl) {
    const customProducts = DJ.getCustomProducts();
    const index = customProducts.findIndex((item) => Number(item.id) === Number(productId));
    if (index === -1) return false;
    customProducts[index] = { ...customProducts[index], image: imageUrl };
    return DJ.saveCustomProducts(customProducts);
  }

  async function handleCustomProductImage(file, productId) {
    try {
      const imageUrl = await resizeImageToDataUrl(file);
      if (!replaceCustomProductImage(productId, imageUrl)) {
        DJ.setStatus('adminStatus', 'That image was too large to save locally. Try a smaller photo.', 'error');
        return;
      }
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Item photo updated successfully.', 'success');
    } catch (error) {
      DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
    }
  }

  function deleteCustomProduct(productId) {
    const customProducts = DJ.getCustomProducts().filter((item) => Number(item.id) !== Number(productId));
    if (DJ.saveCustomProducts(customProducts)) {
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Item removed.', 'success');
    } else {
      DJ.setStatus('adminStatus', 'Unable to delete that item right now.', 'error');
    }
  }

  function renderCustomItemCard(item) {
    return `
      <div class="custom-item-card" data-custom-item-id="${item.id}">
        <div class="custom-item-media">
          <img src="${DJ.escapeHtml(DJ.safeAssetUrl(item.image))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(DJ.fallbackByCategory[item.category] || DJ.fallbackByCategory.Other))}" alt="${DJ.escapeHtml(item.name)}" loading="lazy" decoding="async">
          <div class="mini-dropzone" data-image-drop-id="${item.id}" role="button" tabindex="0">Drop new photo here or click to upload</div>
          <input accept="image/*" class="sr-only replace-image-input" data-replace-id="${item.id}" id="replaceImage-${item.id}" type="file">
        </div>
        <div>
          <h4>${DJ.escapeHtml(item.name)}</h4>
          <p>${DJ.escapeHtml(item.year)} | ${DJ.escapeHtml(item.category)}</p>
          <p>${DJ.escapeHtml(item.team || 'No team / publisher listed')}</p>
          <p>${DJ.escapeHtml(DJ.displayPrice(item))} | ${DJ.escapeHtml(item.condition || 'Condition not listed')}</p>
        </div>
        <button type="button" class="delete-button" data-delete-id="${item.id}">Delete</button>
      </div>
    `;
  }

  function updateAdminStats(items = DJ.getCustomProducts()) {
    const count = items.length;
    const withPhotos = items.filter((item) => item.image && !String(item.image).includes('placeholder-')).length;
    const categories = new Set(items.map((item) => item.category).filter(Boolean)).size;

    const countElement = document.getElementById('adminStatCount');
    const photosElement = document.getElementById('adminStatPhotos');
    const categoriesElement = document.getElementById('adminStatCategories');

    if (countElement) countElement.textContent = String(count);
    if (photosElement) photosElement.textContent = String(withPhotos);
    if (categoriesElement) categoriesElement.textContent = String(categories);
  }

  function formatAdminCurrency(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'Not priced';
    if (typeof DJ.currency === 'function') return DJ.currency(numeric);
    return `$${numeric.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }

  function renderAdminMetricCard(label, value, helper = '') {
    return `
      <article class="admin-metric-card">
        <span class="admin-stat-label">${DJ.escapeHtml(label)}</span>
        <strong class="admin-stat-value">${DJ.escapeHtml(value)}</strong>
        ${helper ? `<p>${DJ.escapeHtml(helper)}</p>` : ''}
      </article>
    `;
  }

  function getProductPlayers(product = {}) {
    const raw = product.playerAthlete || product.metadata?.playerAthlete || product.metadata?.excelFields?.['C:Player/Athlete'] || '';
    return String(raw)
      .split(/\s+\|\s+|[,;/]+|\s+&\s+/)
      .map((item) => item.trim())
      .filter((item) => item && !/^n\/?a$/i.test(item));
  }

  function productHasKeyword(product = {}, pattern) {
    const haystack = [
      product.name,
      product.condition,
      Array.isArray(product.attributes) ? product.attributes.join(' ') : product.attributes,
      product.description,
      product.metadata?.excelFields?.['C:Features'],
      product.metadata?.excelFields?.['C:Autographed']
    ].join(' ');
    return pattern.test(haystack);
  }

  function isSportsCard(product = {}) {
    return ['Baseball', 'Basketball', 'Football'].includes(product.category) || ['Baseball', 'Basketball', 'Football'].includes(product.sport);
  }

  function isGradedProduct(product = {}) {
    return productHasKeyword(product, /\b(PSA|BGS|SGC|CGC|CSG|BCCG|GMA)\b\s*(?:\d+(?:\.\d+)?|auth|auto)?/i);
  }

  function countBy(items = [], getKey) {
    const counts = new Map();
    items.forEach((item) => {
      const key = getKey(item);
      if (!key) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
  }

  function renderRankList(elementId, rows = [], emptyText = 'No data available yet.') {
    const container = document.getElementById(elementId);
    if (!container) return;

    if (!rows.length) {
      container.innerHTML = `<p class="helper-text">${DJ.escapeHtml(emptyText)}</p>`;
      return;
    }

    container.innerHTML = rows.slice(0, 10).map((row, index) => `
      <div class="admin-rank-item">
        <span class="admin-rank-index">${index + 1}</span>
        <span class="admin-rank-copy">
          <strong>${DJ.escapeHtml(row.label)}</strong>
          ${row.helper ? `<small>${DJ.escapeHtml(row.helper)}</small>` : ''}
        </span>
        <b>${DJ.escapeHtml(String(row.count))}</b>
      </div>
    `).join('');
  }

  function getAdminInsightProducts() {
    if (Array.isArray(adminInsightsRemoteProducts) && adminInsightsRemoteProducts.length) {
      return {
        products: adminInsightsRemoteProducts,
        source: 'Supabase live catalog'
      };
    }

    return {
      products: DJ.applyStoredCatalogMutations(existingState.baseProducts, { includeCustomProducts: true }),
      source: 'products.json plus browser overrides'
    };
  }

  function summarizeProducts(products = []) {
    const pricedValues = products.map((product) => DJ.numericPrice(product)).filter((price) => Number.isFinite(price));
    const totalValue = pricedValues.reduce((sum, price) => sum + price, 0);
    const averagePrice = pricedValues.length ? totalValue / pricedValues.length : 0;
    const sportsCards = products.filter(isSportsCard);
    const players = new Map();

    products.forEach((product) => {
      getProductPlayers(product).forEach((player) => {
        players.set(player, (players.get(player) || 0) + 1);
      });
    });

    return {
      totalProducts: products.length,
      sportsCards: sportsCards.length,
      totalValue,
      averagePrice,
      pricedCount: pricedValues.length,
      gradedCount: products.filter(isGradedProduct).length,
      autographCount: products.filter((product) => productHasKeyword(product, /\b(auto|autograph|autographed|signed)\b/i)).length,
      memorabiliaCount: products.filter((product) => productHasKeyword(product, /\b(memorabilia|relic|patch|jersey|bat|ball)\b/i)).length,
      categoryRows: countBy(products, (product) => product.category || product.sport || 'Other'),
      playerRows: Array.from(players.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
    };
  }

  function renderEngagementInsights(products = []) {
    const metrics = typeof DJ.getSiteMetrics === 'function' ? DJ.getSiteMetrics() : null;
    const totals = metrics?.totals || {};
    const productNames = new Map(products.map((product) => [Number(product.id), product.name]));
    const productEvents = Object.values(metrics?.productEvents || {})
      .map((item) => ({
        label: item.name || productNames.get(Number(item.productId)) || `Product #${item.productId}`,
        count: Number(item.product_view) || 0,
        helper: [
          `${Number(item.wishlist_add) || 0} wishlist adds`,
          `${Number(item.checkout_start) || 0} checkout starts`
        ].join(' | ')
      }))
      .filter((item) => item.count || !item.helper.startsWith('0 wishlist adds | 0 checkout starts'))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    const pageRows = Object.entries(metrics?.pageViews || {})
      .map(([label, count]) => ({ label, count: Number(count) || 0 }))
      .filter((row) => row.count)
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
    const grid = document.getElementById('adminEngagementMetricGrid');

    if (grid) {
      grid.innerHTML = [
        renderAdminMetricCard('Page visits', String(Number(totals.page_view) || 0), 'Views recorded in this browser.'),
        renderAdminMetricCard('Product opens', String(Number(totals.product_view) || 0), 'Detail-card opens from product grids.'),
        renderAdminMetricCard('Wishlist adds', String(Number(totals.wishlist_add) || 0), 'Saved-item actions on this browser.'),
        renderAdminMetricCard('Checkout starts', String(Number(totals.checkout_start) || 0), 'Buy Now attempts before Stripe/mail fallback.')
      ].join('');
    }

    renderRankList('adminEngagementList', productEvents, 'No product engagement recorded in this browser yet.');
    renderRankList('adminPageVisitList', pageRows, 'No page visits recorded in this browser yet.');
  }

  async function renderAdminInsights() {
    const status = document.getElementById('adminMetricsStatus');
    if (!document.getElementById('adminInsightsSection')) return;

    if (!existingState.baseProducts.length) {
      await loadBaseProducts();
    }

    const { products, source } = getAdminInsightProducts();
    const summary = summarizeProducts(products);
    const summaryGrid = document.getElementById('adminSummaryMetricGrid');

    if (summaryGrid) {
      summaryGrid.innerHTML = [
        renderAdminMetricCard('Total listings', String(summary.totalProducts), 'Visible products after local deletes/overrides.'),
        renderAdminMetricCard('Sports cards', String(summary.sportsCards), 'Baseball, basketball, and football listings.'),
        renderAdminMetricCard('Total collection value', formatAdminCurrency(summary.totalValue), `${summary.pricedCount} priced listings included.`),
        renderAdminMetricCard('Average price', formatAdminCurrency(summary.averagePrice), 'Based on numeric product price values.'),
        renderAdminMetricCard('Graded listings', String(summary.gradedCount), 'Detected PSA/BGS/SGC/CGC/CSG/BCCG/GMA labels.'),
        renderAdminMetricCard('Autograph listings', String(summary.autographCount), 'Detected auto, autograph, or signed wording.')
      ].join('');
    }

    renderEngagementInsights(products);
    renderRankList('adminCategorySummary', summary.categoryRows);
    renderRankList('adminPlayerSummary', summary.playerRows, 'No player/subject attributes found yet.');

    if (status) {
      status.textContent = `Metrics refreshed from ${source}.`;
    }
  }

  function scheduleAdminInsightsRender() {
    window.clearTimeout(adminInsightsRefreshTimer);
    adminInsightsRefreshTimer = window.setTimeout(() => {
      renderAdminInsights().catch((error) => {
        if (shouldSuppressExistingListingsLoadError(error)) return;
        console.error(error);
        const status = document.getElementById('adminMetricsStatus');
        if (status) status.textContent = 'Metrics could not be refreshed right now.';
      });
    }, 80);
  }

  function initAdminInsights() {
    const tabs = document.querySelectorAll('[data-admin-insight-tab]');
    const panels = document.querySelectorAll('[data-admin-insight-panel]');

    tabs.forEach((tab) => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.adminInsightTab;
        tabs.forEach((node) => {
          const isActive = node === tab;
          node.classList.toggle('is-active', isActive);
          node.setAttribute('aria-selected', String(isActive));
        });
        panels.forEach((panel) => {
          panel.hidden = panel.dataset.adminInsightPanel !== target;
        });
      });
    });

    window.addEventListener('dj:admincatalogproducts', (event) => {
      adminInsightsRemoteProducts = Array.isArray(event.detail?.products) ? event.detail.products : null;
      scheduleAdminInsightsRender();
    });

    scheduleAdminInsightsRender();
  }

  function getFilteredCustomProducts() {
    const searchText = customState.search.trim().toLowerCase();
    return DJ.getCustomProducts().filter((item) => {
      const matchesCategory = customState.category === 'All' || item.category === customState.category;
      const matchesSearch = !searchText || buildAdminSearchIndex(item).includes(searchText);
      return matchesCategory && matchesSearch;
    });
  }

  function renderCustomItems() {
    const container = document.getElementById('customItemsList');
    const count = document.getElementById('customItemsCount');
    if (!container) return;

    const customProducts = DJ.getCustomProducts();
    const filteredProducts = getFilteredCustomProducts();
    updateAdminStats(customProducts);
    scheduleAdminInsightsRender();
    updateSearchShellState('customItemSearch', 'customItemSearchShell');

    if (count) {
      count.textContent = !customProducts.length
        ? 'No browser-saved items yet.'
        : filteredProducts.length === customProducts.length
          ? `${formatCountLabel(filteredProducts.length, 'local item')} saved in this browser.`
          : `${formatCountLabel(filteredProducts.length, 'local item')} shown from ${formatCountLabel(customProducts.length, 'saved item')}.`;
    }

    if (!customProducts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No custom items yet</h3>
          <p>Use the form to add inventory. Everything is stored locally in your browser for now.</p>
        </div>
      `;
      DJ.applyLazyLoading(container);
      return;
    }

    if (!filteredProducts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No saved items match those filters</h3>
          <p>Try a broader search, switch the category filter, or clear the filter bar.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filteredProducts.map(renderCustomItemCard).join('');

    container.querySelectorAll('[data-image-drop-id]').forEach((dropzone) => {
      const productId = dropzone.dataset.imageDropId;
      const input = container.querySelector(`#replaceImage-${productId}`);
      wireDropzone(dropzone, {
        onClick: () => input?.click(),
        onFiles: (files) => {
          const file = files[0];
          if (file) handleCustomProductImage(file, productId);
        }
      });
    });

    DJ.applyLazyLoading(container);
  }

  function bindCustomItemInteractions() {
    const container = document.getElementById('customItemsList');
    if (!container || container.dataset.bound === 'true') {
      return;
    }

    container.dataset.bound = 'true';
    container.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const deleteButton = event.target.closest('[data-delete-id]');
      if (!deleteButton) return;
      deleteCustomProduct(deleteButton.dataset.deleteId);
    });

    container.addEventListener('change', (event) => {
      if (!(event.target instanceof Element)) return;
      const input = event.target.closest('.replace-image-input');
      if (!input) return;
      const file = input.files?.[0];
      if (file) handleCustomProductImage(file, input.dataset.replaceId);
      input.value = '';
    });
  }

  function exportCustomProducts(items) {
    exportJsonFile(items, 'dj-house-custom-items');
  }

  function parseImportedCustomProducts(rawItems) {
    if (!Array.isArray(rawItems)) {
      throw new Error('That file did not contain an item list.');
    }

    return rawItems
      .filter((item) => item && typeof item === 'object')
      .map((item, index) => {
        const category = String(item.category || 'Other').trim() || 'Other';
        return {
          id: Number(item.id) || Date.now() + index,
          name: String(item.name || '').trim(),
          category,
          team: String(item.team || '').trim(),
          year: Number(item.year),
          condition: String(item.condition || '').trim(),
          price: Number(item.price),
          image: String(item.image || '').trim() || DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other,
          description: String(item.description || '').trim()
        };
      })
      .filter((item) => item.name && Number.isFinite(item.year) && Number.isFinite(item.price));
  }

  function initCustomProductsPanel() {
    const searchInput = document.getElementById('customItemSearch');
    const clearSearchButton = document.getElementById('customItemSearchClear');
    const categoryFilter = document.getElementById('customItemFilter');
    const exportButton = document.getElementById('exportCustomItems');
    const importInput = document.getElementById('importCustomItems');
    const clearButton = document.getElementById('clearCustomItems');
    const categoryPills = document.querySelectorAll('[data-category-pill]');
    const categorySelect = document.getElementById('category');

    const handleCustomSearch = debounce((value) => {
      customState.search = String(value || '');
      renderCustomItems();
    }, 120);

    searchInput?.addEventListener('input', () => {
      handleCustomSearch(searchInput.value);
    });

    searchInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !searchInput.value) return;
      event.preventDefault();
      searchInput.value = '';
      customState.search = '';
      handleCustomSearch.cancel?.();
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Local item search cleared.', 'info');
    });

    clearSearchButton?.addEventListener('click', () => {
      if (!searchInput || !searchInput.value) return;
      searchInput.value = '';
      customState.search = '';
      handleCustomSearch.cancel?.();
      renderCustomItems();
      DJ.setStatus('adminStatus', 'Local item search cleared.', 'info');
    });

    categoryFilter?.addEventListener('change', () => {
      customState.category = categoryFilter.value;
      renderCustomItems();
    });

    exportButton?.addEventListener('click', () => {
      const customProducts = DJ.getCustomProducts();
      if (!customProducts.length) {
        DJ.setStatus('adminStatus', 'There are no local items to export yet.', 'info');
        return;
      }

      exportCustomProducts(customProducts);
      DJ.setStatus('adminStatus', 'Local inventory exported as a JSON backup.', 'success');
    });

    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;

      try {
        validateAdminJsonImportFile(file);
        const imported = parseImportedCustomProducts(JSON.parse(await file.text()));
        if (!imported.length) {
          throw new Error('No valid items were found in that file.');
        }
        const merged = [...imported, ...DJ.getCustomProducts()];
        if (!DJ.saveCustomProducts(merged)) {
          throw new Error('Unable to save the imported items in this browser.');
        }
        customState.search = '';
        customState.category = 'All';
        if (searchInput) searchInput.value = '';
        if (categoryFilter) categoryFilter.value = 'All';
        handleCustomSearch.cancel?.();
        renderCustomItems();
        DJ.setStatus('adminStatus', `${imported.length} item${imported.length === 1 ? '' : 's'} imported successfully.`, 'success');
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to import that JSON file.', 'error');
      } finally {
        importInput.value = '';
      }
    });

    clearButton?.addEventListener('click', () => {
      if (!DJ.getCustomProducts().length) {
        DJ.setStatus('adminStatus', 'There are no local items to clear.', 'info');
        return;
      }

      if (window.confirm('Remove all locally added items from this browser? This will not affect the main catalog files.')) {
        if (DJ.saveCustomProducts([])) {
          customState.search = '';
          customState.category = 'All';
          if (searchInput) searchInput.value = '';
          if (categoryFilter) categoryFilter.value = 'All';
          handleCustomSearch.cancel?.();
          renderCustomItems();
          DJ.setStatus('adminStatus', 'All local items were cleared from this browser.', 'success');
        } else {
          DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
        }
      }
    });

    categoryPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        const category = pill.dataset.categoryPill || '';
        if (categorySelect) categorySelect.value = category;
        categoryPills.forEach((candidate) => candidate.classList.toggle('active', candidate === pill));
        document.getElementById('name')?.focus();
      });
    });

    categorySelect?.addEventListener('change', () => {
      categoryPills.forEach((pill) => {
        pill.classList.toggle('active', pill.dataset.categoryPill === categorySelect.value);
      });
    });
  }

  function initNewItemForm() {
    const form = document.getElementById('adminForm');
    if (!form) return;

    const dropzone = document.getElementById('imageDropzone');
    const imageFileInput = document.getElementById('imageFile');
    const browseButton = document.getElementById('imageBrowseButton');
    const removeButton = document.getElementById('imageRemoveButton');
    const imageInput = document.getElementById('image');

    if (dropzone && imageFileInput && browseButton && imageInput) {
      const openPicker = () => imageFileInput.click();

      wireDropzone(dropzone, {
        onClick: openPicker,
        onFiles: async (files) => {
          const file = files[0];
          if (!file) return;
          try {
            updateDraftImagePreview(await resizeImageToDataUrl(file), file.name || 'Selected image');
            DJ.setStatus('adminStatus', 'Photo attached to the new entry.', 'success');
          } catch (error) {
            DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
          }
        }
      });

      browseButton.addEventListener('click', (event) => {
        event.stopPropagation();
        openPicker();
      });

      imageFileInput.addEventListener('change', async () => {
        const file = imageFileInput.files?.[0];
        if (!file) return;
        try {
          updateDraftImagePreview(await resizeImageToDataUrl(file), file.name || 'Selected image');
          DJ.setStatus('adminStatus', 'Photo attached to the new entry.', 'success');
        } catch (error) {
          DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
        }
      });

      imageInput.addEventListener('input', () => {
        const value = imageInput.value.trim();
        if (value) updateDraftImagePreview(value, value.startsWith('data:image') ? 'Uploaded image' : 'Image URL preview');
        else clearDraftImage();
      });

      removeButton?.addEventListener('click', () => {
        clearDraftImage();
        DJ.setStatus('adminStatus', 'Image cleared from the draft entry.', 'info');
      });
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      DJ.setStatus('adminStatus');

      const image = form.image.value.trim();
      const category = form.category.value.trim() || 'Other';
      const item = {
        id: Date.now(),
        name: form.name.value.trim(),
        category,
        team: form.team.value.trim(),
        year: Number(form.year.value),
        condition: form.condition.value.trim(),
        price: Number(form.price.value),
        image: image || DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other,
        description: form.description.value.trim()
      };

      if (!(item.name && item.category && Number.isFinite(item.year) && Number.isFinite(item.price))) {
        DJ.setStatus('adminStatus', 'Please complete the required fields: name, category, year, and price.', 'error');
        form.querySelector('[required]')?.focus();
        return;
      }

      const customProducts = DJ.getCustomProducts();
      customProducts.unshift(item);
      if (DJ.saveCustomProducts(customProducts)) {
        form.reset();
        clearDraftImage();
        renderCustomItems();
        DJ.setStatus('adminStatus', 'Item added successfully. It now appears in the shop views on this browser.', 'success');
      } else {
        DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Existing listing editor helpers
  // ---------------------------------------------------------------------------

  async function loadBaseProducts() {
    if (existingState.baseProducts.length) return existingState.baseProducts;

    if (!baseProductsPromise) {
      baseProductsPromise = (async () => {
        const preloaded = typeof DJ.getPreloadedProductsForSource === 'function'
          ? DJ.getPreloadedProductsForSource('products.json')
          : null;

        if (preloaded) {
          return setBaseProducts(preloaded);
        }

        if (window.location.protocol === 'file:' && typeof DJ.loadPreloadedProductsForSource === 'function') {
          const localBundleProducts = await DJ.loadPreloadedProductsForSource('products.json').catch(() => null);
          if (localBundleProducts) {
            return setBaseProducts(localBundleProducts);
          }
        }

        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        const abortOnPageHide = () => controller?.abort();
        if (controller) {
          window.addEventListener('pagehide', abortOnPageHide, { once: true });
        }

        try {
          const productSource = typeof DJ.versionedProductAsset === 'function'
            ? DJ.versionedProductAsset('products.json')
            : 'products.json';
          const response = await fetch(productSource, {
            cache: 'default',
            signal: controller?.signal
          });
          if (!response.ok) {
            throw new Error(`Failed to load products.json (${response.status})`);
          }

          const products = await response.json();
          return setBaseProducts(products);
        } catch (error) {
          const bundledProducts = typeof DJ.loadPreloadedProductsForSource === 'function'
            ? await DJ.loadPreloadedProductsForSource('products.json').catch(() => null)
            : null;
          if (bundledProducts) {
            return setBaseProducts(bundledProducts);
          }
          throw error;
        } finally {
          if (controller) {
            window.removeEventListener('pagehide', abortOnPageHide);
          }
        }
      })().catch((error) => {
        baseProductsPromise = null;
        throw error;
      });
    }

    return baseProductsPromise;
  }

  function shouldSuppressExistingListingsLoadError(error) {
    return adminPageIsUnloading || error?.name === 'AbortError';
  }

  function reportExistingListingsLoadError(error) {
    if (shouldSuppressExistingListingsLoadError(error)) return;
    console.error(error);
    DJ.setStatus('adminStatus', 'Existing listings could not be loaded for editing right now.', 'error');
    const count = document.getElementById('existingListingsCount');
    if (count) count.textContent = 'Existing listings could not be loaded.';
  }

  function requestExistingListingsLoad() {
    if (existingListingsReadyPromise) {
      return existingListingsReadyPromise;
    }

    // Treat the static catalog load like a singleton bootstrap task so search,
    // edit, and restore flows all wait on the same in-flight work instead of
    // kicking off overlapping requests and duplicate editor setup.
    const count = document.getElementById('existingListingsCount');
    if (count && !existingState.baseProducts.length) {
      count.textContent = 'Loading listings...';
    }

    existingListingsReadyPromise = (async () => {
      await loadBaseProducts();

      if (!existingEditorInitialized) {
        initExistingListingEditor();
        existingEditorInitialized = true;
      }

      renderExistingListings();
    })().catch((error) => {
      existingListingsReadyPromise = null;
      if (shouldSuppressExistingListingsLoadError(error)) return;
      reportExistingListingsLoadError(error);
      throw error;
    });

    return existingListingsReadyPromise;
  }

  function getEffectiveBaseProducts() {
    if (!existingState.effectiveProducts.length && existingState.baseProducts.length) {
      existingState.effectiveProducts = DJ.applyStoredCatalogMutations(existingState.baseProducts, { includeCustomProducts: false })
        .map(indexAdminProduct);
    }

    return existingState.effectiveProducts;
  }

  function hasMainPhoto(product = {}) {
    const image = String(product.image || '').trim();
    return Boolean(image && !/placeholder-/i.test(image));
  }

  function isContactPriceProduct(product = {}) {
    return /contact|ask|inquir/i.test(String(DJ.displayPrice(product) || product.priceLabel || product.price || ''));
  }

  function getExistingListingSku(product = {}) {
    const categoryPrefix = String(product.category || 'X').trim().slice(0, 3).toUpperCase() || 'DJH';
    return `DJH-${categoryPrefix}-${String(product.id || '').padStart(4, '0')}`;
  }

  function productHasLocalOverride(productId) {
    return Object.prototype.hasOwnProperty.call(DJ.getProductOverrides(), String(productId));
  }

  function productMatchesExistingStatus(product = {}) {
    const status = existingState.status;
    if (!status || status === 'All') return true;
    if (status === 'Edited') return productHasLocalOverride(product.id);
    if (status === 'NoPhoto') return !hasMainPhoto(product);
    if (status === 'NoGallery') return !(Array.isArray(product.imageGallery) && product.imageGallery.length);
    if (status === 'Priced') return Number.isFinite(DJ.numericPrice(product));
    if (status === 'Unpriced') return !Number.isFinite(DJ.numericPrice(product));
    if (status === 'ContactPrice') return isContactPriceProduct(product);
    if (status === 'Featured') return Boolean(product.isFeatured);
    if (status === 'NotFeatured') return !product.isFeatured;
    if (status === 'NeedsReview') return productNeedsListingReview(product);
    if (status === 'Selected') return existingState.selectedIds.has(Number(product.id));
    return true;
  }

  function productNeedsListingReview(product = {}) {
    return !hasMainPhoto(product)
      || !(Array.isArray(product.imageGallery) && product.imageGallery.length)
      || !Number.isFinite(DJ.numericPrice(product))
      || !String(product.condition || '').trim();
  }

  function compareExistingListings(left = {}, right = {}) {
    const sort = existingState.sort || 'name-asc';
    const compareName = () => String(left.name || '').localeCompare(String(right.name || ''));
    const leftPrice = DJ.numericPrice(left);
    const rightPrice = DJ.numericPrice(right);
    const leftYear = Number(left.year) || 0;
    const rightYear = Number(right.year) || 0;
    const leftId = Number(left.id) || 0;
    const rightId = Number(right.id) || 0;

    if (sort === 'price-desc') return (rightPrice ?? -Infinity) - (leftPrice ?? -Infinity) || compareName();
    if (sort === 'price-asc') return (leftPrice ?? Infinity) - (rightPrice ?? Infinity) || compareName();
    if (sort === 'year-desc') return rightYear - leftYear || compareName();
    if (sort === 'year-asc') return leftYear - rightYear || compareName();
    if (sort === 'id-desc') return rightId - leftId || compareName();
    return compareName();
  }

  function getSortedEffectiveBaseProducts() {
    return [...getEffectiveBaseProducts()].sort(compareExistingListings);
  }

  function getDeletedBaseProducts() {
    const deletedIds = new Set(DJ.getDeletedProductIds().map((item) => Number(item)));
    return existingState.baseProducts.filter((product) => deletedIds.has(Number(product.id)));
  }

  /**
   * Save a partial override for a base product. The storefront later merges this
   * object over the original product data so edits stay non-destructive.
   */
  function saveProductOverride(productId, patch) {
    const overrides = DJ.getProductOverrides();
    const key = String(productId);
    overrides[key] = {
      ...(overrides[key] || {}),
      ...patch
    };
    const saved = DJ.saveProductOverrides(overrides);
    if (saved) invalidateExistingProductsCache();
    return saved;
  }

  function resetProductOverride(productId) {
    const overrides = DJ.getProductOverrides();
    delete overrides[String(productId)];
    const saved = DJ.saveProductOverrides(overrides);
    if (saved) invalidateExistingProductsCache();
    return saved;
  }

  function addDeletedProductId(productId) {
    const deletedIds = [...new Set(
      [...DJ.getDeletedProductIds(), Number(productId)]
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item))
    )];
    const saved = DJ.saveDeletedProductIds(deletedIds);
    if (saved) invalidateExistingProductsCache();
    return saved;
  }

  function removeDeletedProductId(productId) {
    const saved = DJ.saveDeletedProductIds(DJ.getDeletedProductIds().filter((item) => Number(item) !== Number(productId)));
    if (saved) invalidateExistingProductsCache();
    return saved;
  }

  function exportStorefrontEdits() {
    exportJsonFile({
      exportedAt: new Date().toISOString(),
      productOverrides: DJ.getProductOverrides(),
      deletedProductIds: DJ.getDeletedProductIds()
    }, 'dj-storefront-edits');
  }

  async function importStorefrontEdits(file) {
    validateAdminJsonImportFile(file);

    // Storefront edit exports are intentionally forgiving: missing sections keep
    // the current local values so partial backups can be restored without
    // accidentally wiping unrelated browser edits.
    const parsed = JSON.parse(await file.text());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('That file did not contain storefront edit data.');
    }

    const hasOverridesSection = Object.prototype.hasOwnProperty.call(parsed, 'productOverrides');
    const hasDeletedIdsSection = Object.prototype.hasOwnProperty.call(parsed, 'deletedProductIds');
    if (!hasOverridesSection && !hasDeletedIdsSection) {
      throw new Error('That backup does not include product overrides or deleted listing ids.');
    }

    if (hasOverridesSection && (
      !parsed.productOverrides
      || typeof parsed.productOverrides !== 'object'
      || Array.isArray(parsed.productOverrides)
    )) {
      throw new Error('Product overrides in that backup are not valid.');
    }

    if (hasDeletedIdsSection && !Array.isArray(parsed.deletedProductIds)) {
      throw new Error('Deleted listing ids in that backup are not valid.');
    }

    const nextOverrides = hasOverridesSection ? parsed.productOverrides : DJ.getProductOverrides();
    const nextDeletedIds = hasDeletedIdsSection ? parsed.deletedProductIds : DJ.getDeletedProductIds();

    if (!DJ.saveProductOverrides(nextOverrides) || !DJ.saveDeletedProductIds(nextDeletedIds)) {
      throw new Error(getStorageFailureMessage());
    }

    invalidateExistingProductsCache();
  }

  // ---------------------------------------------------------------------------
  // Existing listing image and gallery management
  // ---------------------------------------------------------------------------

  function buildExistingImageAlt(product = {}, index = null) {
    const name = String(product?.name || '').trim();
    const category = String(product?.category || 'Other').trim() || 'Other';
    if (name && Number.isFinite(index)) {
      return `${name} gallery image ${index + 1}`;
    }
    if (name) {
      return `${name} product image`;
    }
    if (Number.isFinite(index)) {
      return `${category} gallery image ${index + 1}`;
    }
    return `${category} product image preview`;
  }

  function renderMainImagePreview(imageUrl, product) {
    const wrap = document.getElementById('existingMainImagePreviewWrap');
    const image = document.getElementById('existingMainImagePreview');
    const name = document.getElementById('existingMainImageName');
    if (!wrap || !image || !name) return;

    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const source = imageUrl || fallback;
    image.src = DJ.safeAssetUrl(source);
    image.setAttribute('data-fallback-src', DJ.safeAssetUrl(fallback));
    image.alt = buildExistingImageAlt(product);
    name.textContent = imageUrl ? `Main photo ready for ${product.name || 'listing'}` : 'Using category placeholder';
    wrap.hidden = false;
    DJ.applyLazyLoading(wrap);
  }

  function renderGalleryEditor() {
    const galleryList = document.getElementById('existingGalleryList');
    if (!galleryList) return;
    const currentMain = document.getElementById('existingImage')?.value.trim() || '';
    const product = getCurrentEditingProduct() || {
      name: document.getElementById('existingName')?.value.trim() || '',
      category: document.getElementById('existingCategory')?.value || 'Other'
    };

    if (!existingState.currentGallery.length) {
      galleryList.innerHTML = `
        <div class="empty-state compact-empty-state">
          <h3>No gallery photos yet</h3>
          <p>Add URLs or upload photos to build out the storefront gallery for this local override.</p>
        </div>
      `;
      return;
    }

    galleryList.innerHTML = existingState.currentGallery.map((imageUrl, index) => `
      <div class="admin-gallery-item${currentMain === imageUrl ? ' is-main' : ''}" data-gallery-index="${index}">
        <img src="${DJ.escapeHtml(DJ.safeAssetUrl(imageUrl))}" alt="${DJ.escapeHtml(buildExistingImageAlt(product, index))}">
        <div class="admin-gallery-item__body">
          <div class="admin-gallery-item__copy">
            <strong>Photo ${index + 1}${currentMain === imageUrl ? ' - Main photo' : ''}</strong>
            <p class="helper-text">${currentMain === imageUrl ? 'Used on the product card and shown first in the gallery.' : 'Saved in the local gallery draft for this listing.'}</p>
          </div>
          <div class="admin-gallery-item__actions">
            <button type="button" class="button-secondary" data-gallery-action="set-main" data-gallery-index="${index}">Set as Main</button>
            <button type="button" class="button-ghost" data-gallery-action="remove" data-gallery-index="${index}">Remove</button>
          </div>
        </div>
      </div>
    `).join('');

    DJ.applyLazyLoading(galleryList);
  }

  function getCurrentEditingProduct() {
    if (!existingState.editingId) return null;
    return getEffectiveBaseProducts().find((product) => Number(product.id) === Number(existingState.editingId)) || null;
  }

  function highlightExistingListingSelection() {
    document.getElementById('existingListingsList')?.querySelectorAll('[data-existing-id]').forEach((card) => {
      const isSelected = Number(card.getAttribute('data-existing-id')) === Number(existingState.editingId);
      card.classList.toggle('is-selected', isSelected);
      card.setAttribute('aria-current', isSelected ? 'true' : 'false');
    });
  }

  function formatAdminCondition(value = '') {
    if (typeof DJ.formatConditionLabel === 'function') {
      return DJ.formatConditionLabel(value);
    }

    const parts = String(value || '')
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    const uniqueParts = [];
    const seen = new Set();

    parts.forEach((part) => {
      const key = part.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      uniqueParts.push(part);
    });

    if (uniqueParts.some((part) => /^ungraded$/i.test(part))) {
      return 'Ungraded';
    }

    if (uniqueParts.some((part) => /^graded$/i.test(part))) {
      return uniqueParts.find((part) => !/^graded$/i.test(part)) || 'Graded';
    }

    if (uniqueParts.some((part) => /^guide range listed$/i.test(part))) {
      return 'Ungraded';
    }

    return uniqueParts.join(' | ') || 'Condition not listed';
  }

  function getExistingListingBadges(product = {}) {
    const badges = [];
    if (product.isFeatured) badges.push({ label: 'Featured', tone: 'success' });
    if (productHasLocalOverride(product.id)) badges.push({ label: 'Edited', tone: 'accent' });
    if (!hasMainPhoto(product)) badges.push({ label: 'No main photo', tone: 'warning' });
    if (!(Array.isArray(product.imageGallery) && product.imageGallery.length)) badges.push({ label: 'No gallery', tone: 'muted' });
    if (!Number.isFinite(DJ.numericPrice(product))) badges.push({ label: 'No price', tone: 'warning' });
    if (isContactPriceProduct(product)) badges.push({ label: 'Contact price', tone: 'accent' });
    if (!String(product.condition || '').trim()) badges.push({ label: 'No condition', tone: 'warning' });
    return badges;
  }

  function renderExistingListingBadges(product = {}) {
    const badges = getExistingListingBadges(product);
    if (!badges.length) return '';
    return `
      <div class="admin-listing-badges" aria-label="Listing review flags">
        ${badges.map((badge) => `
          <span class="admin-listing-badge admin-listing-badge--${DJ.escapeHtml(badge.tone)}">${DJ.escapeHtml(badge.label)}</span>
        `).join('')}
      </div>
    `;
  }

  function populateExistingListingForm(productId) {
    const product = getEffectiveBaseProducts().find((item) => Number(item.id) === Number(productId));
    if (!product) return;

    existingState.editingId = Number(productId);
    existingState.currentGallery = Array.isArray(product.imageGallery) ? [...product.imageGallery] : [];

    document.getElementById('existingProductId').value = String(product.id);
    document.getElementById('existingName').value = product.name || '';
    document.getElementById('existingCategory').value = product.category || 'Other';
    document.getElementById('existingTeam').value = product.team || '';
    document.getElementById('existingIsFeatured').value = product.isFeatured ? 'true' : 'false';
    document.getElementById('existingYear').value = product.year || '';
    document.getElementById('existingCondition').value = product.condition || '';
    document.getElementById('existingPrice').value = product.price ?? '';
    document.getElementById('existingPriceLabel').value = product.priceLabel || '';
    document.getElementById('existingPhotoHostPageUrl').value = product.photoHostPageUrl || '';
    document.getElementById('existingImage').value = product.image || '';
    document.getElementById('existingDescription').value = product.description || '';

    document.getElementById('existingEditorEmpty').hidden = true;
    document.getElementById('existingListingForm').hidden = false;
    renderMainImagePreview(product.image || '', product);
    renderGalleryEditor();
    highlightExistingListingSelection();

    // Keep the editor fixed in place on desktop instead of pulling the entire
    // page around whenever a listing is selected from the left column.
    if (window.innerWidth <= 900) {
      const editorPanel = document.querySelector('.admin-editor-panel');
      editorPanel?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    document.getElementById('existingName').focus();
  }

  function clearExistingListingEditor(message = '') {
    existingState.editingId = null;
    existingState.currentGallery = [];
    const form = document.getElementById('existingListingForm');
    const empty = document.getElementById('existingEditorEmpty');
    const previewWrap = document.getElementById('existingMainImagePreviewWrap');
    const galleryList = document.getElementById('existingGalleryList');

    if (form) {
      form.hidden = true;
      form.reset();
    }
    if (empty) {
      empty.hidden = false;
      empty.textContent = message || 'Choose a listing from the left to edit its details, photos, or gallery.';
    }
    if (previewWrap) previewWrap.hidden = true;
    if (galleryList) galleryList.innerHTML = '';
    highlightExistingListingSelection();
  }

  function renderExistingListingCard(product) {
    const galleryCount = Array.isArray(product.imageGallery) ? product.imageGallery.length : 0;
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const isSelected = Number(existingState.editingId) === Number(product.id);
    const isBulkSelected = existingState.selectedIds.has(Number(product.id));
    const conditionLabel = formatAdminCondition(product.condition);
    const sku = getExistingListingSku(product);
    const listingPath = DJ.productPageUrl(product);
    const listingContext = [
      product.year || 'Year not listed',
      product.team || 'No team / publisher'
    ].filter(Boolean).join(' | ');

    // Match the scan pattern of eBay's active listings: thumbnail, item,
    // price, status, then action buttons. That keeps bulk edits faster than
    // card-style blocks when the catalog is long.
    return `
      <article class="admin-listing-row admin-listing-card${isSelected ? ' is-selected' : ''}${isBulkSelected ? ' is-bulk-selected' : ''}" data-existing-id="${product.id}" aria-current="${isSelected ? 'true' : 'false'}">
        <div class="admin-listing-cell admin-listing-cell--select">
          <input type="checkbox" data-existing-select-id="${product.id}" aria-label="${DJ.escapeHtml(`Select listing ${product.name}`)}"${isBulkSelected ? ' checked' : ''}>
        </div>
        <div class="admin-listing-cell admin-listing-cell--photo">
          <img src="${DJ.escapeHtml(DJ.safeAssetUrl(product.image || fallback))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(product.name)}" loading="lazy" decoding="async">
        </div>
        <div class="admin-listing-cell admin-listing-cell--item">
          <span class="admin-listing-kicker">${DJ.escapeHtml(product.category || 'Other')} #${DJ.escapeHtml(String(product.id || ''))} | SKU ${DJ.escapeHtml(sku)}</span>
          <h4>${DJ.escapeHtml(product.name)}</h4>
          <p>${DJ.escapeHtml(listingContext)}</p>
          <p class="helper-text">${galleryCount} gallery photo${galleryCount === 1 ? '' : 's'}</p>
          ${renderExistingListingBadges(product)}
        </div>
        <div class="admin-listing-cell admin-listing-cell--price" data-label="Price">
          <strong>${DJ.escapeHtml(DJ.displayPrice(product))}</strong>
          <span>Fixed price</span>
        </div>
        <div class="admin-listing-cell admin-listing-cell--status" data-label="Status">
          <strong>Active</strong>
          <span>${DJ.escapeHtml(conditionLabel)}</span>
        </div>
        <div class="admin-listing-cell admin-listing-cell--actions">
          <button type="button" data-existing-action="edit" data-existing-id="${product.id}">Edit</button>
          <a class="button-secondary admin-row-link" href="${DJ.escapeHtml(listingPath)}" target="_blank" rel="noopener">View</a>
          <button type="button" class="button-secondary" data-existing-action="replace-main" data-existing-id="${product.id}">Photo</button>
          <button type="button" class="button-secondary" data-existing-action="remove-main" data-existing-id="${product.id}">Clear</button>
          <button type="button" class="button-ghost" data-existing-action="hide" data-existing-id="${product.id}">End</button>
        </div>
        <input accept="image/*" aria-hidden="true" class="sr-only" data-existing-main-input="${product.id}" tabindex="-1" type="file">
      </article>
    `;
  }

  function getFilteredExistingProducts() {
    const search = existingState.search.trim().toLowerCase();
    const sorted = getSortedEffectiveBaseProducts();
    const selectedId = Number(existingState.editingId);

    const fullList = sorted.filter((product) => {
      const matchesSearch = !search || String(product._adminSearchIndex || '').includes(search);
      const matchesCategory = existingState.category === 'All' || String(product.category || 'Other') === existingState.category;
      return matchesSearch && matchesCategory && productMatchesExistingStatus(product);
    });

    let visible = fullList.slice(0, MAX_EXISTING_RESULTS);

    if (selectedId) {
      const selectedProduct = fullList.find((product) => Number(product.id) === selectedId);
      const selectedVisible = visible.some((product) => Number(product.id) === selectedId);
      if (selectedProduct && !selectedVisible) {
        visible = [selectedProduct, ...visible.slice(0, Math.max(0, MAX_EXISTING_RESULTS - 1))];
      }
    }

    return {
      products: visible,
      total: fullList.length,
      limited: fullList.length > MAX_EXISTING_RESULTS
    };
  }

  function renderHiddenListings() {
    const container = document.getElementById('hiddenListingsList');
    if (!container) return;

    const hiddenProducts = getDeletedBaseProducts().sort((left, right) => left.name.localeCompare(right.name));
    if (!hiddenProducts.length) {
      container.innerHTML = `
        <div class="empty-state compact-empty-state">
          <p>No hidden base listings.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = hiddenProducts.map((product) => `
      <div class="custom-item-card custom-item-card--compact">
        <div>
          <h4>${DJ.escapeHtml(product.name)}</h4>
          <p>${DJ.escapeHtml(String(product.year || 'Year not listed'))} | ${DJ.escapeHtml(product.category || 'Other')}</p>
        </div>
        <button type="button" class="button-secondary" data-restore-id="${product.id}">Restore</button>
      </div>
    `).join('');
  }

  async function quickReplaceMainPhoto(productId, file) {
    try {
      const dataUrl = await resizeImageToDataUrl(file);
      if (!saveProductOverride(productId, { image: dataUrl })) {
        throw new Error(getStorageFailureMessage());
      }
      DJ.setStatus('adminStatus', 'Main photo updated.', 'success');
      renderExistingListings();
      if (Number(existingState.editingId) === Number(productId)) {
        populateExistingListingForm(productId);
      }
    } catch (error) {
      DJ.setStatus('adminStatus', error.message || 'Unable to replace the main photo.', 'error');
    }
  }

  function removeMainPhoto(productId) {
    if (saveProductOverride(productId, { image: '' })) {
      DJ.setStatus('adminStatus', 'Main photo removed. The category placeholder will be used.', 'success');
      renderExistingListings();
      if (Number(existingState.editingId) === Number(productId)) {
        populateExistingListingForm(productId);
      }
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function hideExistingListing(productId) {
    if (!window.confirm('Delete this listing from the storefront on this browser? This will not remove it from the source JSON file.')) {
      return;
    }

    if (addDeletedProductId(productId)) {
      DJ.setStatus('adminStatus', 'Listing removed from the storefront on this browser.', 'success');
      if (Number(existingState.editingId) === Number(productId)) {
        clearExistingListingEditor('That listing is currently hidden from the storefront. Restore it below to edit it again.');
      }
      renderExistingListings();
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function updateExistingListingSummary(total = 0, visible = 0) {
    const summary = document.getElementById('existingListingsSummary');
    if (!summary) return;

    const products = getEffectiveBaseProducts();
    const overrideIds = new Set(Object.keys(DJ.getProductOverrides()).map(Number));
    const hiddenCount = DJ.getDeletedProductIds().length;
    const editedCount = products.filter((product) => overrideIds.has(Number(product.id))).length;
    const noPhotoCount = products.filter((product) => !hasMainPhoto(product)).length;
    const noGalleryCount = products.filter((product) => !(Array.isArray(product.imageGallery) && product.imageGallery.length)).length;
    const contactPriceCount = products.filter(isContactPriceProduct).length;
    const needsReviewCount = products.filter(productNeedsListingReview).length;
    const featuredCount = products.filter((product) => product.isFeatured).length;

    summary.innerHTML = [
      { label: 'Shown', value: visible, status: null },
      { label: 'Matches', value: total, status: null },
      { label: 'Featured', value: featuredCount, status: 'Featured' },
      { label: 'Edited', value: editedCount, status: 'Edited' },
      { label: 'No main photo', value: noPhotoCount, status: 'NoPhoto' },
      { label: 'No gallery', value: noGalleryCount, status: 'NoGallery' },
      { label: 'Contact price', value: contactPriceCount, status: 'ContactPrice' },
      { label: 'Needs review', value: needsReviewCount, status: 'NeedsReview' },
      { label: 'Ended', value: hiddenCount, status: null }
    ].map(({ label, value, status }) => {
      const isActive = status && existingState.status === status;
      const tagName = status ? 'button' : 'span';
      const attributes = status
        ? ` type="button" data-existing-summary-filter="${DJ.escapeHtml(status)}" aria-pressed="${isActive ? 'true' : 'false'}"`
        : '';
      return `
      <${tagName} class="admin-listing-summary-chip${isActive ? ' is-active' : ''}"${attributes}>
        <b>${DJ.escapeHtml(String(value))}</b>
        ${DJ.escapeHtml(label)}
      </${tagName}>
    `;
    }).join('');
  }

  function updateExistingBulkControls() {
    const selectedCount = existingState.selectedIds.size;
    const selectionCount = document.getElementById('existingSelectionCount');
    const selectionMeta = document.getElementById('existingSelectionMeta');
    const selectedButtons = [
      'existingBulkClearSelection',
      'existingBulkApplyPriceChange',
      'existingBulkApplyPriceLabel',
      'existingBulkApplyCondition',
      'existingBulkApplyCategory',
      'existingBulkApplyFeatured',
      'existingBulkSyncPriceLabels',
      'existingBulkClearPhotos',
      'existingBulkResetOverrides',
      'existingBulkEndListings',
      'existingExportSelectedCsv',
      'existingCopySelectedLinks'
    ];
    const selectVisibleButton = document.getElementById('existingBulkSelectVisible');
    const selectNeedsReviewButton = document.getElementById('existingBulkSelectNeedsReview');
    const selectNoPhotoButton = document.getElementById('existingBulkSelectNoPhoto');
    const selectNoGalleryButton = document.getElementById('existingBulkSelectNoGallery');
    const selectContactPriceButton = document.getElementById('existingBulkSelectContactPrice');
    const selectEditedButton = document.getElementById('existingBulkSelectEdited');
    const exportVisibleButton = document.getElementById('existingExportVisibleCsv');
    const copyVisibleButton = document.getElementById('existingCopyVisibleLinks');
    const visibleSet = new Set(existingState.visibleIds);
    const selectedVisibleCount = [...existingState.selectedIds].filter((id) => visibleSet.has(id)).length;
    const allVisibleSelected = Boolean(existingState.visibleIds.length && selectedVisibleCount === existingState.visibleIds.length);
    const selectedProducts = getSelectedExistingProducts();
    const selectedPrices = selectedProducts
      .map((product) => DJ.numericPrice(product))
      .filter((price) => Number.isFinite(price));
    const selectedValue = selectedPrices.reduce((sum, price) => sum + price, 0);
    const selectedReviewCount = selectedProducts.filter(productNeedsListingReview).length;

    if (selectionCount) {
      selectionCount.textContent = `${formatCountLabel(selectedCount, 'listing')} selected`;
    }
    if (selectionMeta) {
      selectionMeta.textContent = selectedCount
        ? `${formatCountLabel(selectedPrices.length, 'priced listing')} | ${DJ.currency(selectedValue)} selected value${selectedReviewCount ? ` | ${selectedReviewCount} need review` : ''}`
        : 'No listings selected.';
    }

    if (selectVisibleButton) {
      selectVisibleButton.disabled = !existingState.visibleIds.length;
      selectVisibleButton.textContent = allVisibleSelected ? 'Unselect Visible' : 'Select Visible';
    }
    if (selectNeedsReviewButton) {
      selectNeedsReviewButton.disabled = !getEffectiveBaseProducts().some(productNeedsListingReview);
    }
    if (selectNoPhotoButton) {
      selectNoPhotoButton.disabled = !getEffectiveBaseProducts().some((product) => !hasMainPhoto(product));
    }
    if (selectNoGalleryButton) {
      selectNoGalleryButton.disabled = !getEffectiveBaseProducts().some((product) => !(Array.isArray(product.imageGallery) && product.imageGallery.length));
    }
    if (selectContactPriceButton) {
      selectContactPriceButton.disabled = !getEffectiveBaseProducts().some(isContactPriceProduct);
    }
    if (selectEditedButton) {
      selectEditedButton.disabled = !getEffectiveBaseProducts().some((product) => productHasLocalOverride(product.id));
    }
    if (exportVisibleButton) {
      exportVisibleButton.disabled = !existingState.visibleIds.length;
    }
    if (copyVisibleButton) {
      copyVisibleButton.disabled = !existingState.visibleIds.length;
    }

    selectedButtons.forEach((id) => {
      const button = document.getElementById(id);
      if (button) button.disabled = !selectedCount;
    });

    document.querySelectorAll('[data-existing-select-id]').forEach((input) => {
      const productId = Number(input.getAttribute('data-existing-select-id'));
      const checked = existingState.selectedIds.has(productId);
      input.checked = checked;
      input.closest('.admin-listing-row')?.classList.toggle('is-bulk-selected', checked);
    });
  }

  function clearInvisibleExistingSelections() {
    const activeIds = new Set(getEffectiveBaseProducts().map((product) => Number(product.id)));
    existingState.selectedIds.forEach((id) => {
      if (!activeIds.has(Number(id))) {
        existingState.selectedIds.delete(id);
      }
    });
  }

  function clearExistingSelection(message = '') {
    existingState.selectedIds.clear();
    updateExistingBulkControls();
    if (message) DJ.setStatus('adminStatus', message, 'info');
  }

  function selectVisibleExistingListings() {
    const visibleSet = new Set(existingState.visibleIds);
    const selectedVisibleCount = [...existingState.selectedIds].filter((id) => visibleSet.has(id)).length;
    const shouldSelect = selectedVisibleCount !== existingState.visibleIds.length;

    existingState.visibleIds.forEach((id) => {
      if (shouldSelect) {
        existingState.selectedIds.add(Number(id));
      } else {
        existingState.selectedIds.delete(Number(id));
      }
    });

    updateExistingBulkControls();
  }

  function selectExistingListingsByPredicate(predicate, successMessage) {
    const matches = getSortedEffectiveBaseProducts()
      .filter((product) => predicate(product))
      .map((product) => Number(product.id))
      .filter(Number.isFinite);

    existingState.selectedIds = new Set(matches);
    if (existingState.status === 'Selected') {
      renderExistingListings();
    } else {
      updateExistingBulkControls();
    }
    DJ.setStatus('adminStatus', matches.length ? successMessage(matches.length) : 'No matching listings found.', matches.length ? 'success' : 'info');
  }

  function selectNeedsReviewListings() {
    selectExistingListingsByPredicate(
      productNeedsListingReview,
      (count) => `${formatCountLabel(count, 'listing')} needing review selected.`
    );
  }

  function selectNoPhotoListings() {
    selectExistingListingsByPredicate(
      (product) => !hasMainPhoto(product),
      (count) => `${formatCountLabel(count, 'listing')} without a main photo selected.`
    );
  }

  function selectNoGalleryListings() {
    selectExistingListingsByPredicate(
      (product) => !(Array.isArray(product.imageGallery) && product.imageGallery.length),
      (count) => `${formatCountLabel(count, 'listing')} without gallery photos selected.`
    );
  }

  function selectContactPriceListings() {
    selectExistingListingsByPredicate(
      isContactPriceProduct,
      (count) => `${formatCountLabel(count, 'contact-price listing')} selected.`
    );
  }

  function selectEditedListings() {
    selectExistingListingsByPredicate(
      (product) => productHasLocalOverride(product.id),
      (count) => `${formatCountLabel(count, 'edited listing')} selected.`
    );
  }

  function getSelectedExistingProducts() {
    const selectedIds = new Set([...existingState.selectedIds].map(Number));
    return getEffectiveBaseProducts().filter((product) => selectedIds.has(Number(product.id)));
  }

  function buildStorefrontUrl(product = {}) {
    const origin = window.location.origin && window.location.origin !== 'null'
      ? window.location.origin
      : '';
    return `${origin}/${DJ.productPageUrl(product)}`.replace(/([^:]\/)\/+/g, '$1');
  }

  function csvEscape(value = '') {
    if (typeof DJ.csvEscape === 'function') return DJ.csvEscape(value);
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  function buildExistingListingsCsv(products = []) {
    const headers = [
      'SKU',
      'Listing ID',
      'Title',
      'Category',
      'Price',
      'Price Label',
      'Year',
      'Team / Publisher',
      'Condition',
      'Main Image',
      'Gallery Count',
      'Photo Host URL',
      'Storefront URL',
      'Featured',
      'Edited Locally',
      'Needs Review'
    ];
    const rows = products.map((product) => [
      getExistingListingSku(product),
      product.id || '',
      product.name || '',
      product.category || 'Other',
      Number.isFinite(DJ.numericPrice(product)) ? DJ.numericPrice(product) : '',
      DJ.displayPrice(product),
      product.year || '',
      product.team || '',
      formatAdminCondition(product.condition),
      product.image || '',
      Array.isArray(product.imageGallery) ? product.imageGallery.length : 0,
      product.photoHostPageUrl || '',
      buildStorefrontUrl(product),
      product.isFeatured ? 'Yes' : 'No',
      productHasLocalOverride(product.id) ? 'Yes' : 'No',
      productNeedsListingReview(product) ? 'Yes' : 'No'
    ]);

    return [headers, ...rows]
      .map((row) => row.map(csvEscape).join(','))
      .join('\r\n');
  }

  function exportExistingListingsCsv(products = [], filenamePrefix = 'dj-existing-listings') {
    if (!products.length) {
      DJ.setStatus('adminStatus', 'No listings are available to export.', 'info');
      return;
    }
    exportTextFile(buildExistingListingsCsv(products), filenamePrefix, 'csv', 'text/csv');
    DJ.setStatus('adminStatus', `${formatCountLabel(products.length, 'listing')} exported to CSV.`, 'success');
  }

  function saveBulkExistingOverrides(patchesById) {
    // Batch local catalog patches into one storage write so multi-row actions do
    // not thrash localStorage or partially refresh the editor state.
    const overrides = DJ.getProductOverrides();

    patchesById.forEach((patch, productId) => {
      overrides[String(productId)] = {
        ...(overrides[String(productId)] || {}),
        ...patch
      };
    });

    const saved = DJ.saveProductOverrides(overrides);
    if (saved) invalidateExistingProductsCache();
    return saved;
  }

  function bulkClearMainPhotos() {
    const products = getSelectedExistingProducts();
    if (!products.length) return;
    if (!window.confirm(`Clear the main photo on ${formatCountLabel(products.length, 'selected listing')}?`)) return;

    const patches = new Map(products.map((product) => [Number(product.id), { image: '' }]));
    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `Main photos cleared for ${formatCountLabel(products.length, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkResetOverrides() {
    const ids = [...existingState.selectedIds].map(Number);
    if (!ids.length) return;
    if (!window.confirm(`Reset browser-saved edits for ${formatCountLabel(ids.length, 'selected listing')}?`)) return;

    const overrides = DJ.getProductOverrides();
    ids.forEach((id) => delete overrides[String(id)]);
    if (DJ.saveProductOverrides(overrides)) {
      invalidateExistingProductsCache();
      DJ.setStatus('adminStatus', `Browser edits reset for ${formatCountLabel(ids.length, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkEndListings() {
    const ids = [...existingState.selectedIds].map(Number);
    if (!ids.length) return;
    if (!window.confirm(`End ${formatCountLabel(ids.length, 'selected listing')} from the storefront on this browser?`)) return;

    const deletedIds = [...new Set([...DJ.getDeletedProductIds().map(Number), ...ids])].filter(Number.isFinite);
    if (DJ.saveDeletedProductIds(deletedIds)) {
      invalidateExistingProductsCache();
      if (ids.some((id) => Number(existingState.editingId) === id)) {
        clearExistingListingEditor('That listing is currently hidden from the storefront. Restore it below to edit it again.');
      }
      existingState.selectedIds.clear();
      DJ.setStatus('adminStatus', `${formatCountLabel(ids.length, 'listing')} ended from this browser storefront.`, 'success');
      renderExistingListings();
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkApplyPricePercent() {
    const input = document.getElementById('existingBulkPricePercent');
    const percent = Number(input?.value);
    const products = getSelectedExistingProducts();
    if (!products.length) return;
    if (!Number.isFinite(percent) || percent === 0) {
      DJ.setStatus('adminStatus', 'Enter a positive or negative percent, such as -10 or 12.5.', 'error');
      input?.focus();
      return;
    }

    const patches = new Map();
    products.forEach((product) => {
      const currentPrice = DJ.numericPrice(product);
      if (!Number.isFinite(currentPrice)) return;
      const nextPrice = Math.max(0, Math.round((currentPrice * (1 + percent / 100)) * 100) / 100);
      patches.set(Number(product.id), {
        price: nextPrice,
        priceLabel: DJ.currency(nextPrice)
      });
    });

    if (!patches.size) {
      DJ.setStatus('adminStatus', 'No selected listings have a numeric price to adjust.', 'error');
      return;
    }

    if (!window.confirm(`Apply a ${percent > 0 ? '+' : ''}${percent}% price change to ${formatCountLabel(patches.size, 'selected listing')}?`)) return;

    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `Prices updated for ${formatCountLabel(patches.size, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkApplyPriceLabel() {
    const input = document.getElementById('existingBulkPriceLabel');
    const priceLabel = String(input?.value || '').trim();
    const products = getSelectedExistingProducts();
    if (!products.length) return;
    if (!priceLabel) {
      DJ.setStatus('adminStatus', 'Enter the price label to apply to the selected listings.', 'error');
      input?.focus();
      return;
    }
    if (!window.confirm(`Set display price to "${priceLabel}" for ${formatCountLabel(products.length, 'selected listing')}?`)) return;

    const patches = new Map(products.map((product) => [Number(product.id), { priceLabel }]));
    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `Display price updated for ${formatCountLabel(products.length, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkApplyCondition() {
    const input = document.getElementById('existingBulkCondition');
    const condition = String(input?.value || '').trim();
    const products = getSelectedExistingProducts();
    if (!products.length) return;
    if (!condition) {
      DJ.setStatus('adminStatus', 'Enter the condition to apply to the selected listings.', 'error');
      input?.focus();
      return;
    }
    if (!window.confirm(`Set condition to "${condition}" for ${formatCountLabel(products.length, 'selected listing')}?`)) return;

    const patches = new Map(products.map((product) => [Number(product.id), { condition }]));
    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `Condition updated for ${formatCountLabel(products.length, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkApplyCategory() {
    const select = document.getElementById('existingBulkCategory');
    const category = String(select?.value || '').trim();
    const products = getSelectedExistingProducts();
    if (!products.length) return;
    if (!category) {
      DJ.setStatus('adminStatus', 'Choose a category before applying it to selected listings.', 'error');
      select?.focus();
      return;
    }
    if (!window.confirm(`Move ${formatCountLabel(products.length, 'selected listing')} to ${category}?`)) return;

    const patches = new Map(products.map((product) => [Number(product.id), { category }]));
    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `Category updated for ${formatCountLabel(products.length, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkApplyFeaturedMode() {
    const select = document.getElementById('existingBulkFeaturedMode');
    const value = String(select?.value || '').trim();
    const products = getSelectedExistingProducts();
    if (!products.length) return;
    if (!value) {
      DJ.setStatus('adminStatus', 'Choose Featured or Not featured before applying it to selected listings.', 'error');
      select?.focus();
      return;
    }
    const isFeatured = value === 'true';
    if (!window.confirm(`${isFeatured ? 'Feature' : 'Remove featured status from'} ${formatCountLabel(products.length, 'selected listing')}?`)) return;

    const patches = new Map(products.map((product) => [Number(product.id), { isFeatured }]));
    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `${formatCountLabel(products.length, 'listing')} ${isFeatured ? 'marked featured' : 'removed from featured'}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  function bulkSyncPriceLabels() {
    const products = getSelectedExistingProducts();
    if (!products.length) return;

    const patches = new Map();
    products.forEach((product) => {
      const price = DJ.numericPrice(product);
      if (!Number.isFinite(price)) return;
      const nextLabel = DJ.currency(price);
      if (String(product.priceLabel || '') !== nextLabel) {
        patches.set(Number(product.id), { priceLabel: nextLabel });
      }
    });

    if (!patches.size) {
      DJ.setStatus('adminStatus', 'Selected listings already have matching price labels.', 'info');
      return;
    }

    if (!window.confirm(`Sync price labels for ${formatCountLabel(patches.size, 'selected listing')}?`)) return;

    if (saveBulkExistingOverrides(patches)) {
      DJ.setStatus('adminStatus', `Price labels synced for ${formatCountLabel(patches.size, 'listing')}.`, 'success');
      renderExistingListings();
      if (existingState.editingId) populateExistingListingForm(existingState.editingId);
    } else {
      DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
    }
  }

  async function copyListingLinks(products = [], label = 'listing link') {
    if (!products.length) return;

    const lines = products.map((product) => [
      product.name || `Listing #${product.id}`,
      DJ.displayPrice(product),
      buildStorefrontUrl(product)
    ].filter(Boolean).join(' | '));

    try {
      if (typeof DJ.copyText === 'function') {
        await DJ.copyText(lines.join('\n'));
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = lines.join('\n');
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
      }
      DJ.setStatus('adminStatus', `${formatCountLabel(products.length, label)} copied.`, 'success');
    } catch {
      DJ.setStatus('adminStatus', 'This browser blocked clipboard access.', 'error');
    }
  }

  async function copySelectedListingLinks() {
    await copyListingLinks(getSelectedExistingProducts(), 'selected listing link');
  }

  async function copyVisibleListingLinks() {
    await copyListingLinks(getFilteredExistingProducts().products, 'visible listing link');
  }

  function renderExistingListings() {
    const container = document.getElementById('existingListingsList');
    const count = document.getElementById('existingListingsCount');
    if (!container) return;

    applyExistingDensityPreference();
    const { products, total, limited } = getFilteredExistingProducts();
    existingState.visibleIds = products.map((product) => Number(product.id));
    clearInvisibleExistingSelections();
    updateSearchShellState('existingListingSearch', 'existingListingSearchShell');
    updateExistingListingSummary(total, products.length);

    if (count) {
      count.textContent = limited
        ? `Showing ${products.length} of ${total} listings. Refine the search to narrow the results.`
        : `${formatCountLabel(total, 'listing')} available to edit on this browser.`;
    }

    if (!products.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No listings matched</h3>
          <p>Try a broader search to find the product you want to edit.</p>
        </div>
      `;
      updateExistingBulkControls();
      renderHiddenListings();
      return;
    }

    container.innerHTML = `
      <div class="admin-listing-table-header" aria-hidden="true">
        <span>Select</span>
        <span>Photo</span>
        <span>Listing</span>
        <span>Price</span>
        <span>Status</span>
        <span>Actions</span>
      </div>
      ${products.map(renderExistingListingCard).join('')}
    `;

    DJ.applyLazyLoading(container);
    highlightExistingListingSelection();
    updateExistingBulkControls();
    renderHiddenListings();
    scheduleAdminInsightsRender();
  }

  async function addGalleryImageFromFile(file) {
    const dataUrl = await resizeImageToDataUrl(file);
    existingState.currentGallery.push(dataUrl);
    renderGalleryEditor();
  }

  function bindExistingListingInteractions() {
    const galleryList = document.getElementById('existingGalleryList');
    if (galleryList && galleryList.dataset.bound !== 'true') {
      galleryList.dataset.bound = 'true';
      galleryList.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-gallery-action]');
        if (!button) return;

        const index = Number(button.dataset.galleryIndex);
        if (!Number.isFinite(index)) return;

        if (button.dataset.galleryAction === 'remove') {
          existingState.currentGallery.splice(index, 1);
          renderGalleryEditor();
          return;
        }

        if (button.dataset.galleryAction === 'set-main') {
          const imageInput = document.getElementById('existingImage');
          const product = getCurrentEditingProduct();
          if (!imageInput || !product) return;
          imageInput.value = existingState.currentGallery[index] || '';
          renderMainImagePreview(imageInput.value.trim(), product);
          renderGalleryEditor();
        }
      });
    }

    const hiddenListings = document.getElementById('hiddenListingsList');
    if (hiddenListings && hiddenListings.dataset.bound !== 'true') {
      hiddenListings.dataset.bound = 'true';
      hiddenListings.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-restore-id]');
        if (!button) return;

        if (removeDeletedProductId(button.dataset.restoreId)) {
          DJ.setStatus('adminStatus', 'Listing restored to the storefront.', 'success');
          renderExistingListings();
        } else {
          DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
        }
      });
    }

    const summary = document.getElementById('existingListingsSummary');
    if (summary && summary.dataset.bound !== 'true') {
      summary.dataset.bound = 'true';
      summary.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const button = event.target.closest('[data-existing-summary-filter]');
        if (!button) return;
        const status = button.getAttribute('data-existing-summary-filter') || 'All';
        existingState.status = existingState.status === status ? 'All' : status;
        const statusFilter = document.getElementById('existingListingStatusFilter');
        if (statusFilter) statusFilter.value = existingState.status;
        renderExistingListings();
      });
    }

    const listings = document.getElementById('existingListingsList');
    if (listings && listings.dataset.bound !== 'true') {
      listings.dataset.bound = 'true';
      listings.addEventListener('click', (event) => {
        if (!(event.target instanceof Element)) return;
        const selectionInput = event.target.closest('[data-existing-select-id]');
        if (selectionInput) {
          event.stopPropagation();
          return;
        }

        const actionButton = event.target.closest('[data-existing-action]');
        if (actionButton) {
          const productId = actionButton.dataset.existingId;
          if (!productId) return;

          if (actionButton.dataset.existingAction === 'edit') {
            populateExistingListingForm(productId);
            return;
          }

          if (actionButton.dataset.existingAction === 'replace-main') {
            listings.querySelector(`[data-existing-main-input="${productId}"]`)?.click();
            return;
          }

          if (actionButton.dataset.existingAction === 'remove-main') {
            removeMainPhoto(productId);
            return;
          }

          if (actionButton.dataset.existingAction === 'hide') {
            hideExistingListing(productId);
            return;
          }
        }

        const card = event.target.closest('[data-existing-id]');
        if (!card || event.target.closest('button, input, label, a')) {
          return;
        }

        populateExistingListingForm(card.getAttribute('data-existing-id'));
      });

      listings.addEventListener('change', (event) => {
        if (!(event.target instanceof Element)) return;
        const selectionInput = event.target.closest('[data-existing-select-id]');
        if (selectionInput) {
          const productId = Number(selectionInput.getAttribute('data-existing-select-id'));
          if (Number.isFinite(productId)) {
            if (selectionInput.checked) {
              existingState.selectedIds.add(productId);
            } else {
              existingState.selectedIds.delete(productId);
            }
            if (existingState.status === 'Selected') {
              renderExistingListings();
            } else {
              updateExistingBulkControls();
            }
          }
          return;
        }

        const input = event.target.closest('[data-existing-main-input]');
        if (!input) return;
        const file = input.files?.[0];
        if (file) quickReplaceMainPhoto(input.getAttribute('data-existing-main-input'), file);
        input.value = '';
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Existing listing editor wiring
  // ---------------------------------------------------------------------------

  function initExistingListingEditor() {
    const searchInput = document.getElementById('existingListingSearch');
    const clearSearchButton = document.getElementById('existingListingSearchClear');
    const categoryFilter = document.getElementById('existingListingCategoryFilter');
    const statusFilter = document.getElementById('existingListingStatusFilter');
    const sortSelect = document.getElementById('existingListingSort');
    const densitySelect = document.getElementById('existingListingDensity');
    const resetFiltersButton = document.getElementById('resetExistingListingFilters');
    const bulkSelectVisibleButton = document.getElementById('existingBulkSelectVisible');
    const bulkSelectNeedsReviewButton = document.getElementById('existingBulkSelectNeedsReview');
    const bulkSelectNoPhotoButton = document.getElementById('existingBulkSelectNoPhoto');
    const bulkSelectNoGalleryButton = document.getElementById('existingBulkSelectNoGallery');
    const bulkSelectContactPriceButton = document.getElementById('existingBulkSelectContactPrice');
    const bulkSelectEditedButton = document.getElementById('existingBulkSelectEdited');
    const bulkClearSelectionButton = document.getElementById('existingBulkClearSelection');
    const bulkApplyPriceButton = document.getElementById('existingBulkApplyPriceChange');
    const bulkApplyPriceLabelButton = document.getElementById('existingBulkApplyPriceLabel');
    const bulkApplyConditionButton = document.getElementById('existingBulkApplyCondition');
    const bulkApplyCategoryButton = document.getElementById('existingBulkApplyCategory');
    const bulkApplyFeaturedButton = document.getElementById('existingBulkApplyFeatured');
    const bulkSyncPriceLabelsButton = document.getElementById('existingBulkSyncPriceLabels');
    const bulkPriceInput = document.getElementById('existingBulkPricePercent');
    const bulkPriceLabelInput = document.getElementById('existingBulkPriceLabel');
    const bulkConditionInput = document.getElementById('existingBulkCondition');
    const bulkCategorySelect = document.getElementById('existingBulkCategory');
    const bulkFeaturedSelect = document.getElementById('existingBulkFeaturedMode');
    const bulkClearPhotosButton = document.getElementById('existingBulkClearPhotos');
    const bulkResetOverridesButton = document.getElementById('existingBulkResetOverrides');
    const bulkEndListingsButton = document.getElementById('existingBulkEndListings');
    const exportVisibleCsvButton = document.getElementById('existingExportVisibleCsv');
    const exportSelectedCsvButton = document.getElementById('existingExportSelectedCsv');
    const copySelectedLinksButton = document.getElementById('existingCopySelectedLinks');
    const copyVisibleLinksButton = document.getElementById('existingCopyVisibleLinks');
    const form = document.getElementById('existingListingForm');
    const replaceMainInput = document.getElementById('existingReplaceMainPhotoInput');
    const replaceMainButton = document.getElementById('existingReplaceMainPhotoButton');
    const removeMainButton = document.getElementById('existingRemoveMainPhotoButton');
    const hideButton = document.getElementById('existingHideListingButton');
    const resetButton = document.getElementById('existingResetOverrideButton');
    const imageInput = document.getElementById('existingImage');
    const addGalleryUrlButton = document.getElementById('existingAddGalleryUrlButton');
    const addGalleryFileButton = document.getElementById('existingAddGalleryFileButton');
    const galleryUrlInput = document.getElementById('existingGalleryUrl');
    const galleryFileInput = document.getElementById('existingGalleryFileInput');
    const exportEditsButton = document.getElementById('exportStorefrontEdits');
    const importEditsButton = document.getElementById('importStorefrontEditsButton');
    const importEditsInput = document.getElementById('importStorefrontEditsInput');

    bindExistingListingInteractions();
    applyExistingDensityPreference();

    const handleExistingSearch = debounce((value) => {
      existingState.search = String(value || '');
      renderExistingListings();
    }, 120);

    searchInput?.addEventListener('input', () => {
      handleExistingSearch(searchInput.value);
    });

    clearSearchButton?.addEventListener('click', () => {
      if (!searchInput || !searchInput.value) return;
      searchInput.value = '';
      existingState.search = '';
      handleExistingSearch.cancel?.();
      renderExistingListings();
      DJ.setStatus('adminStatus', 'Existing listing search cleared.', 'info');
    });

    searchInput?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!searchInput.value) return;
      event.preventDefault();
      searchInput.value = '';
      existingState.search = '';
      handleExistingSearch.cancel?.();
      renderExistingListings();
      DJ.setStatus('adminStatus', 'Existing listing search cleared.', 'info');
    });

    categoryFilter?.addEventListener('change', () => {
      existingState.category = categoryFilter.value || 'All';
      renderExistingListings();
    });

    statusFilter?.addEventListener('change', () => {
      existingState.status = statusFilter.value || 'All';
      renderExistingListings();
    });

    sortSelect?.addEventListener('change', () => {
      existingState.sort = sortSelect.value || 'name-asc';
      renderExistingListings();
    });

    densitySelect?.addEventListener('change', () => {
      existingState.density = densitySelect.value === 'compact' ? 'compact' : 'comfortable';
      writeAdminViewPreference('density', existingState.density);
      applyExistingDensityPreference();
      DJ.setStatus('adminStatus', existingState.density === 'compact' ? 'Compact listing rows enabled.' : 'Comfortable listing rows enabled.', 'info');
    });

    resetFiltersButton?.addEventListener('click', () => {
      existingState.search = '';
      existingState.category = 'All';
      existingState.status = 'All';
      existingState.sort = 'name-asc';
      existingState.selectedIds.clear();
      if (searchInput) searchInput.value = '';
      if (categoryFilter) categoryFilter.value = 'All';
      if (statusFilter) statusFilter.value = 'All';
      if (sortSelect) sortSelect.value = 'name-asc';
      existingState.density = readAdminViewPreference('density', 'comfortable');
      applyExistingDensityPreference();
      if (bulkPriceInput) bulkPriceInput.value = '';
      if (bulkPriceLabelInput) bulkPriceLabelInput.value = '';
      if (bulkConditionInput) bulkConditionInput.value = '';
      if (bulkCategorySelect) bulkCategorySelect.value = '';
      if (bulkFeaturedSelect) bulkFeaturedSelect.value = '';
      handleExistingSearch.cancel?.();
      renderExistingListings();
      DJ.setStatus('adminStatus', 'Existing listing filters cleared.', 'info');
    });

    bulkSelectVisibleButton?.addEventListener('click', selectVisibleExistingListings);
    bulkSelectNeedsReviewButton?.addEventListener('click', selectNeedsReviewListings);
    bulkSelectNoPhotoButton?.addEventListener('click', selectNoPhotoListings);
    bulkSelectNoGalleryButton?.addEventListener('click', selectNoGalleryListings);
    bulkSelectContactPriceButton?.addEventListener('click', selectContactPriceListings);
    bulkSelectEditedButton?.addEventListener('click', selectEditedListings);
    bulkClearSelectionButton?.addEventListener('click', () => clearExistingSelection('Selection cleared.'));
    bulkApplyPriceButton?.addEventListener('click', bulkApplyPricePercent);
    bulkApplyPriceLabelButton?.addEventListener('click', bulkApplyPriceLabel);
    bulkApplyConditionButton?.addEventListener('click', bulkApplyCondition);
    bulkApplyCategoryButton?.addEventListener('click', bulkApplyCategory);
    bulkApplyFeaturedButton?.addEventListener('click', bulkApplyFeaturedMode);
    bulkSyncPriceLabelsButton?.addEventListener('click', bulkSyncPriceLabels);
    bulkClearPhotosButton?.addEventListener('click', bulkClearMainPhotos);
    bulkResetOverridesButton?.addEventListener('click', bulkResetOverrides);
    bulkEndListingsButton?.addEventListener('click', bulkEndListings);
    exportVisibleCsvButton?.addEventListener('click', () => {
      exportExistingListingsCsv(getFilteredExistingProducts().products, 'dj-visible-listings');
    });
    exportSelectedCsvButton?.addEventListener('click', () => {
      exportExistingListingsCsv(getSelectedExistingProducts(), 'dj-selected-listings');
    });
    copySelectedLinksButton?.addEventListener('click', copySelectedListingLinks);
    copyVisibleLinksButton?.addEventListener('click', copyVisibleListingLinks);

    exportEditsButton?.addEventListener('click', () => {
      exportStorefrontEdits();
      DJ.setStatus('adminStatus', 'Storefront edits exported.', 'success');
    });

    importEditsButton?.addEventListener('click', () => importEditsInput?.click());
    importEditsInput?.addEventListener('change', async () => {
      const file = importEditsInput.files?.[0];
      if (!file) return;

      try {
        await importStorefrontEdits(file);
        DJ.setStatus('adminStatus', 'Storefront edits imported.', 'success');
        renderExistingListings();
        if (existingState.editingId) {
          const stillVisible = getEffectiveBaseProducts().some((product) => Number(product.id) === Number(existingState.editingId));
          if (stillVisible) {
            populateExistingListingForm(existingState.editingId);
          } else {
            clearExistingListingEditor('The current listing is hidden from the storefront. Restore it below to edit it again.');
          }
        }
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to import storefront edits.', 'error');
      } finally {
        importEditsInput.value = '';
      }
    });

    imageInput?.addEventListener('input', () => {
      const product = getCurrentEditingProduct();
      if (!product) return;
      renderMainImagePreview(imageInput.value.trim(), { ...product, category: document.getElementById('existingCategory').value || product.category });
      renderGalleryEditor();
    });

    replaceMainButton?.addEventListener('click', () => replaceMainInput?.click());
    replaceMainInput?.addEventListener('change', async () => {
      const file = replaceMainInput.files?.[0];
      const product = getCurrentEditingProduct();
      if (!file || !product) return;
      try {
        imageInput.value = await resizeImageToDataUrl(file);
        renderMainImagePreview(imageInput.value, product);
        renderGalleryEditor();
        DJ.setStatus('adminStatus', 'Main photo ready to save.', 'success');
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to use that image.', 'error');
      } finally {
        replaceMainInput.value = '';
      }
    });

    removeMainButton?.addEventListener('click', () => {
      const product = getCurrentEditingProduct();
      if (!product || !imageInput) return;
      imageInput.value = '';
      renderMainImagePreview('', { ...product, category: document.getElementById('existingCategory').value || product.category });
      renderGalleryEditor();
      DJ.setStatus('adminStatus', 'Main photo removed. Save changes to apply the placeholder image.', 'info');
    });

    hideButton?.addEventListener('click', () => {
      const productId = document.getElementById('existingProductId').value;
      if (productId) hideExistingListing(productId);
    });

    resetButton?.addEventListener('click', () => {
      const productId = document.getElementById('existingProductId').value;
      if (!productId) return;
      if (!window.confirm('Reset all browser-saved changes for this listing?')) return;

      if (resetProductOverride(productId)) {
        DJ.setStatus('adminStatus', 'Listing changes were reset to the source data.', 'success');
        populateExistingListingForm(productId);
        renderExistingListings();
      } else {
        DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
      }
    });

    addGalleryUrlButton?.addEventListener('click', () => {
      const value = galleryUrlInput?.value.trim();
      if (!value) return;
      if (!DJ.isLikelyImageReference(value)) {
        DJ.setStatus('adminStatus', 'Gallery image URLs should point to an image file, uploaded asset, or direct image address.', 'error');
        galleryUrlInput?.focus();
        return;
      }
      existingState.currentGallery.push(value);
      galleryUrlInput.value = '';
      renderGalleryEditor();
      DJ.setStatus('adminStatus', 'Gallery image added. Save changes to apply it.', 'success');
    });

    addGalleryFileButton?.addEventListener('click', () => galleryFileInput?.click());
    galleryFileInput?.addEventListener('change', async () => {
      const file = galleryFileInput.files?.[0];
      if (!file) return;
      try {
        await addGalleryImageFromFile(file);
        DJ.setStatus('adminStatus', 'Gallery image added. Save changes to apply it.', 'success');
      } catch (error) {
        DJ.setStatus('adminStatus', error.message || 'Unable to add that gallery image.', 'error');
      } finally {
        galleryFileInput.value = '';
      }
    });

    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const productId = Number(document.getElementById('existingProductId').value);
      if (!Number.isFinite(productId)) return;

      const yearInput = document.getElementById('existingYear');
      const priceInput = document.getElementById('existingPrice');
      const rawPhotoHostPageUrl = document.getElementById('existingPhotoHostPageUrl').value.trim();
      const patch = {
        name: document.getElementById('existingName').value.trim(),
        category: document.getElementById('existingCategory').value.trim() || 'Other',
        team: document.getElementById('existingTeam').value.trim(),
        isFeatured: document.getElementById('existingIsFeatured').value === 'true',
        year: yearInput.value === '' ? null : Number(yearInput.value),
        condition: document.getElementById('existingCondition').value.trim(),
        price: priceInput.value === '' ? null : Number(priceInput.value),
        priceLabel: document.getElementById('existingPriceLabel').value.trim(),
        photoHostPageUrl: rawPhotoHostPageUrl,
        image: document.getElementById('existingImage').value.trim(),
        description: document.getElementById('existingDescription').value.trim(),
        imageGallery: [...existingState.currentGallery]
      };

      if (!patch.name) {
        DJ.setStatus('adminStatus', 'Name is required for an existing listing.', 'error');
        document.getElementById('existingName').focus();
        return;
      }

      if (document.getElementById('existingYear').value && !Number.isFinite(patch.year)) {
        DJ.setStatus('adminStatus', 'Year must be a valid number.', 'error');
        document.getElementById('existingYear').focus();
        return;
      }

      if (document.getElementById('existingPrice').value && !Number.isFinite(patch.price)) {
        DJ.setStatus('adminStatus', 'Price must be a valid number.', 'error');
        document.getElementById('existingPrice').focus();
        return;
      }
      if (patch.image && !DJ.isLikelyImageReference(patch.image)) {
        DJ.setStatus('adminStatus', 'Main image should be an uploaded image URL, an assets path, or a direct image link.', 'error');
        document.getElementById('existingImage').focus();
        return;
      }
      if (patch.photoHostPageUrl && !DJ.isValidHttpUrl(patch.photoHostPageUrl)) {
        DJ.setStatus('adminStatus', 'Photo host URL must start with http:// or https://.', 'error');
        document.getElementById('existingPhotoHostPageUrl').focus();
        return;
      }
      patch.photoHostPageUrl = patch.photoHostPageUrl ? DJ.safeExternalUrl(patch.photoHostPageUrl) : '';

      if (saveProductOverride(productId, patch)) {
        DJ.setStatus('adminStatus', 'Listing updated successfully on this browser.', 'success');
        renderExistingListings();
        populateExistingListingForm(productId);
      } else {
        DJ.setStatus('adminStatus', getStorageFailureMessage(), 'error');
      }
    });
  }

  document.addEventListener('dj:local-admin-visibility', (event) => {
    if (event.detail?.visible) {
      requestExistingListingsLoad().catch(() => {});
    }
  });

  // Boot the local admin panels after the page and shared DJ helpers are ready.
  document.addEventListener('DOMContentLoaded', () => {
    initAdminInsights();
    initNewItemForm();
    initCustomProductsPanel();
    bindCustomItemInteractions();
    renderCustomItems();

    if (!DJ.remoteCatalog?.isConfigured?.()) {
      requestExistingListingsLoad().catch(() => {});
    }
  });

  window.deleteCustomItem = deleteCustomProduct;
})();

