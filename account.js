/**
 * Customer account page helpers.
 * -----------------------------------------------------------------------------
 * Buyer details stay local to this browser. The page focuses on practical buyer
 * utilities: reusable contact/shipping notes, a wishlist preview, saved
 * searches, and a simple email handoff to DJ.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const PROFILE_KEY = 'djCustomerProfileV1';
  const ORDER_HISTORY_KEY = 'djCustomerOrderHistoryV1';
  const PRODUCT_SOURCE = 'products.json';
  const MAX_PROFILE_FIELD_LENGTH = 240;
  const MAX_PROFILE_NOTES_LENGTH = 1200;
  const WISHLIST_PREVIEW_LIMIT = 5;
  const contactEmail = 'djscardscomics13@gmail.com';
  let accountProductsPromise = null;
  let wishlistRenderTimer = 0;

  const fields = [
    'fullName',
    'email',
    'phone',
    'preferredContact',
    'favoritePlayers',
    'favoriteTeams',
    'budgetRange',
    'preferredCondition',
    'shippingName',
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'postalCode',
    'notes'
  ];
  const profileCompletionFields = [
    'fullName',
    'email',
    'preferredContact',
    'favoritePlayers',
    'favoriteTeams',
    'budgetRange',
    'shippingName',
    'addressLine1',
    'city',
    'state',
    'postalCode',
    'notes'
  ];
  const profileFieldLabels = {
    fullName: 'Full name',
    email: 'Email',
    phone: 'Phone',
    preferredContact: 'Preferred contact',
    favoritePlayers: 'Favorite players / characters',
    favoriteTeams: 'Favorite teams / titles',
    budgetRange: 'Budget range',
    preferredCondition: 'Preferred condition',
    shippingName: 'Shipping name',
    addressLine1: 'Address line 1',
    addressLine2: 'Address line 2',
    city: 'City',
    state: 'State',
    postalCode: 'ZIP / postal code',
    notes: 'Collecting notes'
  };

  const $ = (id) => document.getElementById(id);

  function normalizeProfileValue(field, value) {
    const maxLength = field === 'notes' ? MAX_PROFILE_NOTES_LENGTH : MAX_PROFILE_FIELD_LENGTH;
    return String(value || '').trim().slice(0, maxLength);
  }

  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text != null) element.textContent = options.text;
    if (options.href) element.setAttribute('href', options.href);
    if (options.attributes) {
      Object.entries(options.attributes).forEach(([name, value]) => {
        if (value != null) element.setAttribute(name, String(value));
      });
    }
    return element;
  }

  function setStatus(message = '', tone = 'info') {
    const status = $('accountStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function readLocalProfile() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeLocalProfile(profile) {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
      return true;
    } catch {
      return false;
    }
  }

  function removeLocalProfile() {
    try {
      localStorage.removeItem(PROFILE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function readLocalOrders() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ORDER_HISTORY_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function getWishlistIds() {
    return typeof DJ.getWishlist === 'function' ? DJ.getWishlist().map(Number).filter(Number.isFinite) : [];
  }

  function loadProfileForm() {
    const profile = readLocalProfile();
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      if (input) input.value = profile[field] || '';
    });
  }

  function readProfileForm() {
    const storedProfile = readLocalProfile();
    const profile = {};
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      profile[field] = input
        ? normalizeProfileValue(field, input.value)
        : normalizeProfileValue(field, storedProfile[field]);
    });
    profile.updatedAt = storedProfile.updatedAt || '';
    return profile;
  }

  function hasProfileDetails(profile) {
    return fields.some((field) => Boolean(normalizeProfileValue(field, profile?.[field])));
  }

  function getProfileCompletion(profile) {
    const completed = profileCompletionFields.filter((field) => Boolean(normalizeProfileValue(field, profile?.[field]))).length;
    return {
      completed,
      total: profileCompletionFields.length,
      percent: Math.round((completed / profileCompletionFields.length) * 100)
    };
  }

  function hasUnsavedProfileChanges(currentProfile, storedProfile) {
    return fields.some((field) => (
      normalizeProfileValue(field, currentProfile?.[field]) !== normalizeProfileValue(field, storedProfile?.[field])
    ));
  }

  function hasUnsavedProfileFormChanges() {
    return Boolean($('accountProfileForm')) && hasUnsavedProfileChanges(readProfileForm(), readLocalProfile());
  }

  function formatSavedAt(value) {
    if (!value) return 'No saved buyer details yet.';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Buyer details are saved on this device.';
    return `Last saved ${date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })}.`;
  }

  function formatShippingAddress(profile = {}) {
    return [
      profile.shippingName || profile.fullName,
      profile.addressLine1,
      profile.addressLine2,
      [profile.city, profile.state, profile.postalCode].filter(Boolean).join(', ')
    ].map((line) => normalizeProfileValue('addressLine1', line)).filter(Boolean).join('\n');
  }

  function loadAccountProducts() {
    if (accountProductsPromise) return accountProductsPromise;
    const productSource = typeof DJ.versionedProductAsset === 'function'
      ? DJ.versionedProductAsset(PRODUCT_SOURCE)
      : PRODUCT_SOURCE;
    accountProductsPromise = fetch(productSource, { cache: 'default' })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${PRODUCT_SOURCE}`);
        return response.json();
      })
      .catch(async (error) => {
        const bundledProducts = typeof DJ.loadPreloadedProductsForSource === 'function'
          ? await DJ.loadPreloadedProductsForSource(PRODUCT_SOURCE).catch(() => null)
          : null;
        if (Array.isArray(bundledProducts)) return bundledProducts;
        throw error;
      })
      .then((products) => {
        const safeProducts = Array.isArray(products) ? products : [];
        return typeof DJ.applyStoredCatalogMutations === 'function'
          ? DJ.applyStoredCatalogMutations(safeProducts, { includeCustomProducts: true })
          : safeProducts;
      })
      .catch((error) => {
        console.error(error);
        return [];
      });
    return accountProductsPromise;
  }

  async function getWishlistProducts() {
    const wishlistIds = getWishlistIds();
    if (!wishlistIds.length) return [];
    const order = new Map(wishlistIds.map((id, index) => [Number(id), index]));
    const products = await loadAccountProducts();
    return products
      .filter((product) => order.has(Number(product.id)))
      .sort((left, right) => order.get(Number(left.id)) - order.get(Number(right.id)));
  }

  function buildBuyerSummary(profile, wishlistCount, wishlistProducts = []) {
    const lines = [
      'Hi DJ,',
      '',
      'I wanted to send over my saved buyer preferences.',
      '',
      `Wishlist items: ${wishlistCount}`
    ];

    fields.forEach((field) => {
      const value = normalizeProfileValue(field, profile[field]);
      if (value) {
        lines.push(`${profileFieldLabels[field]}: ${value}`);
      }
    });

    if (wishlistProducts.length) {
      lines.push('', 'Wishlist preview:');
      wishlistProducts.slice(0, WISHLIST_PREVIEW_LIMIT).forEach((product, index) => {
        lines.push(`${index + 1}. ${product.name || 'Saved item'} - ${DJ.displayPrice?.(product) || ''} - #${product.id || ''}`.trim());
      });
    }

    lines.push('', 'Thanks!');
    return lines.join('\n');
  }

  function buildPreferencesEmailUrl(profile, wishlistCount, wishlistProducts = []) {
    const subject = 'Saved buyer preferences';
    const body = buildBuyerSummary(profile, wishlistCount, wishlistProducts);
    return `mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function parsePreferenceTerms(value = '') {
    return [...new Set(String(value || '')
      .split(/[,;\n]+/)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2))]
      .slice(0, 8);
  }

  function getSavedSearchTerms(profile = {}) {
    return [
      ...parsePreferenceTerms(profile.favoritePlayers),
      ...parsePreferenceTerms(profile.favoriteTeams)
    ].slice(0, 8);
  }

  function buildSearchUrl(term = '') {
    return `sports-cards.html?search=${encodeURIComponent(term)}`;
  }

  function renderSavedSearches(profile = readProfileForm()) {
    const container = $('accountSavedSearches');
    if (!container) return;

    const terms = getSavedSearchTerms(profile);

    if (!terms.length) {
      container.innerHTML = '';
      return;
    }

    container.replaceChildren(
      createElement('strong', { text: 'Saved searches' }),
      ...terms.map((term) => createElement('a', {
        className: 'account-saved-search-link',
        href: buildSearchUrl(term),
        text: term
      }))
    );
  }

  function renderWishlistInsights(products = [], wishlistIds = getWishlistIds()) {
    const container = $('accountWishlistInsights');
    if (!container) return;

    if (!wishlistIds.length) {
      container.innerHTML = '';
      return;
    }

    const categoryCounts = new Map();
    products.forEach((product) => {
      const category = String(product.category || 'Other').trim() || 'Other';
      categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    });

    const numericProducts = products
      .map((product) => ({ product, price: DJ.numericPrice?.(product) }))
      .filter((entry) => Number.isFinite(entry.price));
    const highest = numericProducts.sort((left, right) => right.price - left.price)[0];
    const topCategory = [...categoryCounts.entries()].sort((left, right) => right[1] - left[1])[0];
    const unresolvedCount = Math.max(0, wishlistIds.length - products.length);

    const insights = [
      {
        label: 'Top category',
        value: topCategory ? `${topCategory[0]} (${topCategory[1]})` : 'No matches'
      },
      {
        label: 'Highest saved price',
        value: highest ? DJ.displayPrice?.(highest.product) || DJ.currency(highest.price) : 'Ask'
      },
      {
        label: 'Catalog matches',
        value: `${products.length} of ${wishlistIds.length}`
      }
    ];

    if (unresolvedCount) {
      insights.push({ label: 'Needs cleanup', value: String(unresolvedCount) });
    }

    container.replaceChildren(...insights.map((insight) => {
      const item = createElement('div', { className: 'account-insight-card' });
      item.append(
        createElement('span', { text: insight.label }),
        createElement('strong', { text: insight.value })
      );
      return item;
    }));
  }

  function saveProfileForm(event) {
    event?.preventDefault();
    const profile = readLocalProfile();
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      if (input) profile[field] = normalizeProfileValue(field, input.value);
    });
    profile.updatedAt = new Date().toISOString();
    const saved = writeLocalProfile(profile);
    setStatus(
      saved ? 'Buyer details saved on this device.' : 'This browser blocked local buyer detail storage.',
      saved ? 'success' : 'error'
    );
    renderAccountSummary();
  }

  function renderReadinessChecklist(profile, wishlistIds) {
    const container = $('accountReadinessChecklist');
    if (!container) return;
    const items = [
      {
        label: 'Contact saved',
        complete: Boolean(profile.fullName && (profile.email || profile.phone))
      },
      {
        label: 'Shipping address ready',
        complete: Boolean(profile.addressLine1 && profile.city && profile.state && profile.postalCode)
      },
      {
        label: 'Wishlist started',
        complete: Boolean(wishlistIds.length)
      },
      {
        label: 'Collecting preferences saved',
        complete: Boolean(profile.favoritePlayers || profile.favoriteTeams || profile.budgetRange || profile.preferredCondition)
      },
      {
        label: 'Collecting notes added',
        complete: Boolean(profile.notes)
      }
    ];

    container.replaceChildren(...items.map((item) => {
      const row = createElement('div', {
        className: `account-checklist-item${item.complete ? ' is-complete' : ''}`
      });
      row.append(
        createElement('span', { text: item.complete ? 'OK' : '--', attributes: { 'aria-hidden': 'true' } }),
        createElement('strong', { text: item.label })
      );
      return row;
    }));
  }

  function renderAccountSummary() {
    const countTarget = $('accountWishlistCount');
    const heroCountTarget = $('accountHeroWishlistCount');
    const heroSavedStatus = $('accountHeroSavedStatus');
    const heroReadiness = $('accountHeroReadiness');
    const completionLabel = $('accountProfileCompletionLabel');
    const completionBar = $('accountProfileCompletionBar');
    const savedAt = $('accountProfileSavedAt');
    const emailLink = $('accountEmailPreferences');
    const clearButton = $('accountClearProfile');
    const profileStatus = $('accountProfileStatus');
    const wishlistIds = getWishlistIds();
    const currentProfile = readProfileForm();
    const storedProfile = readLocalProfile();
    const completion = getProfileCompletion(currentProfile);
    const hasDetails = hasProfileDetails(currentProfile);
    const hasSavedDetails = hasProfileDetails(storedProfile);
    const hasUnsavedChanges = hasUnsavedProfileChanges(currentProfile, storedProfile);

    if (countTarget) countTarget.textContent = String(wishlistIds.length);
    if (heroCountTarget) {
      heroCountTarget.textContent = `${wishlistIds.length} item${wishlistIds.length === 1 ? '' : 's'}`;
    }
    if (heroSavedStatus) {
      heroSavedStatus.textContent = hasSavedDetails
        ? 'Saved on this device'
        : hasDetails
          ? 'Draft in progress'
          : 'Not saved yet';
    }
    if (heroReadiness) heroReadiness.textContent = `${completion.percent}%`;
    if (completionLabel) {
      completionLabel.textContent = `${completion.percent}%`;
      completionLabel.setAttribute('aria-label', `${completion.completed} of ${completion.total} buyer details filled`);
    }
    if (completionBar) completionBar.style.width = `${completion.percent}%`;
    if (savedAt) {
      savedAt.textContent = hasUnsavedChanges && hasDetails
        ? 'Unsaved changes in the form.'
        : formatSavedAt(storedProfile.updatedAt);
    }
    if (profileStatus) {
      profileStatus.textContent = hasDetails
        ? `${completion.completed} of ${completion.total} buyer details filled.`
        : 'Add buyer details once, then reuse them when asking about cards.';
    }
    if (emailLink) {
      emailLink.href = buildPreferencesEmailUrl(currentProfile, wishlistIds.length);
      emailLink.textContent = hasDetails || wishlistIds.length ? 'Email Buyer Summary' : 'Email DJ';
    }
    if (clearButton) clearButton.disabled = !hasSavedDetails;
    renderReadinessChecklist(currentProfile, wishlistIds);
    renderSavedSearches(currentProfile);
  }

  async function renderWishlistPreview() {
    const container = $('accountWishlistPreview');
    const meta = $('accountWishlistPreviewMeta');
    const totalTarget = $('accountWishlistTotal');
    if (!container) return;
    const wishlistIds = getWishlistIds();

    if (!wishlistIds.length) {
      if (meta) meta.textContent = 'No saved items yet.';
      if (totalTarget) totalTarget.textContent = '$0';
      renderWishlistInsights([], wishlistIds);
      container.innerHTML = `
        <div class="account-empty-state">
          <strong>Your wishlist is empty.</strong>
          <p>Save cards, comics, or collectibles while browsing and they will appear here.</p>
          <div class="account-empty-actions">
            <a class="button-secondary" href="sports-cards.html">Browse Cards</a>
            <a class="button-secondary" href="comics.html">Browse Comics</a>
          </div>
        </div>
      `;
      return;
    }

    if (meta) meta.textContent = `Loading ${wishlistIds.length} saved item${wishlistIds.length === 1 ? '' : 's'}...`;
    container.innerHTML = '<div class="account-empty-state"><p>Loading saved items...</p></div>';

    const products = await getWishlistProducts();
    const visible = products.slice(0, WISHLIST_PREVIEW_LIMIT);
    const numericPrices = products.map((product) => DJ.numericPrice?.(product)).filter((price) => Number.isFinite(price));
    const total = numericPrices.reduce((sum, price) => sum + price, 0);
    const unresolvedCount = Math.max(0, wishlistIds.length - products.length);
    renderWishlistInsights(products, wishlistIds);

    if (totalTarget) {
      totalTarget.textContent = numericPrices.length ? DJ.currency(total) : 'Ask';
    }
    if (meta) {
      meta.textContent = unresolvedCount
        ? `${products.length} saved item${products.length === 1 ? '' : 's'} shown. ${unresolvedCount} saved item${unresolvedCount === 1 ? '' : 's'} no longer match the catalog.`
        : `Showing ${visible.length} of ${products.length} saved item${products.length === 1 ? '' : 's'}.`;
    }

    if (!visible.length) {
      container.innerHTML = `
        <div class="account-empty-state">
          <strong>Saved items need a refresh.</strong>
          <p>Open the wishlist to remove stale saved items or browse the latest catalog.</p>
          <div class="account-empty-actions">
            <a class="button-secondary" href="wishlist.html">Open Wishlist</a>
            <a class="button-secondary" href="sports-cards.html">Browse Cards</a>
          </div>
        </div>
      `;
      return;
    }

    container.replaceChildren(...visible.map((product) => {
      const fallback = DJ.fallbackByCategory?.[product.category] || DJ.fallbackByCategory?.Other || 'assets/placeholder-baseball.svg';
      const row = createElement('a', {
        className: 'account-wishlist-row',
        href: DJ.productPageUrl(product)
      });
      const image = createElement('img', {
        attributes: {
          src: DJ.safeAssetUrl?.(product.image || fallback) || product.image || fallback,
          alt: product.name || 'Saved item',
          loading: 'lazy',
          decoding: 'async'
        }
      });
      image.setAttribute('data-fallback-src', DJ.safeAssetUrl?.(fallback) || fallback);
      const copy = createElement('span');
      copy.append(
        createElement('strong', { text: product.name || 'Saved item' }),
        createElement('small', { text: [product.year, product.category, product.team].filter(Boolean).join(' | ') || 'Saved listing' })
      );
      row.append(image, copy, createElement('b', { text: DJ.displayPrice?.(product) || 'Ask' }));
      return row;
    }));

    if (products.length > WISHLIST_PREVIEW_LIMIT) {
      const moreLink = createElement('a', {
        className: 'button-secondary account-view-all-link',
        href: 'wishlist.html',
        text: `View all ${products.length} saved items`
      });
      container.appendChild(moreLink);
    }
    DJ.applyLazyLoading?.(container);
  }

  function scheduleWishlistPreviewRender() {
    if (wishlistRenderTimer) window.clearTimeout(wishlistRenderTimer);
    wishlistRenderTimer = window.setTimeout(() => {
      wishlistRenderTimer = 0;
      renderWishlistPreview();
    }, 80);
  }

  function clearLocalProfile() {
    const storedProfile = readLocalProfile();
    if (!hasProfileDetails(storedProfile)) {
      setStatus('There are no saved buyer details to clear.', 'info');
      return;
    }

    const confirmed = window.confirm('Clear the buyer details saved on this device? Your wishlist will stay intact.');
    if (!confirmed) return;

    const removed = removeLocalProfile();
    loadProfileForm();
    renderAccountSummary();
    setStatus(
      removed ? 'Saved buyer details cleared from this device.' : 'This browser blocked clearing local buyer details.',
      removed ? 'success' : 'error'
    );
  }

  function renderOrderHistory() {
    const container = $('accountOrders');
    if (!container) return;
    const orders = readLocalOrders();
    container.replaceChildren();

    if (!orders.length) {
      const emptyState = createElement('div', { className: 'account-empty-state' });
      emptyState.append(
        createElement('strong', { text: 'No saved checkout activity yet.' }),
        createElement('p', { text: 'Wishlist saves and buyer details are ready here when you want to ask about an item.' })
      );
      container.appendChild(emptyState);
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.slice(0, 6).forEach((order) => {
      const card = createElement('article', { className: 'account-order-card' });
      card.append(
        createElement('strong', { text: order.title || 'Checkout activity' }),
        createElement('span', { text: order.status || 'Pending' }),
        createElement('small', { text: order.date || '' })
      );
      fragment.appendChild(card);
    });
    container.appendChild(fragment);
  }

  function useNameForShipping() {
    const fullName = normalizeProfileValue('fullName', $('account_fullName')?.value);
    const shippingName = $('account_shippingName');
    if (!fullName || !shippingName) {
      setStatus('Enter a full name first.', 'error');
      return;
    }
    shippingName.value = fullName;
    renderAccountSummary();
    setStatus('Shipping name updated from the buyer name.', 'success');
  }

  async function refreshEmailPreferencesLink() {
    const link = $('accountEmailPreferences');
    if (!link) return;
    const products = await getWishlistProducts();
    link.href = buildPreferencesEmailUrl(readProfileForm(), getWishlistIds().length, products);
  }

  function bindEvents() {
    $('accountClearProfile')?.addEventListener('click', clearLocalProfile);
    $('accountUseNameForShipping')?.addEventListener('click', useNameForShipping);
    $('accountEmailPreferences')?.addEventListener('mouseenter', refreshEmailPreferencesLink);
    $('accountEmailPreferences')?.addEventListener('focus', refreshEmailPreferencesLink);

    const profileForm = $('accountProfileForm');
    profileForm?.addEventListener('submit', saveProfileForm);
    profileForm?.addEventListener('input', renderAccountSummary);
    profileForm?.addEventListener('change', renderAccountSummary);
    window.addEventListener('beforeunload', (event) => {
      if (!hasUnsavedProfileFormChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    });
    window.addEventListener('dj:wishlistchange', () => {
      renderAccountSummary();
      scheduleWishlistPreviewRender();
    });
    window.addEventListener('dj:catalogmutation', () => {
      accountProductsPromise = null;
      renderAccountSummary();
      scheduleWishlistPreviewRender();
    });
    window.addEventListener('pageshow', () => {
      renderAccountSummary();
      scheduleWishlistPreviewRender();
    });
  }

  function init() {
    bindEvents();
    loadProfileForm();
    renderAccountSummary();
    renderOrderHistory();
    renderWishlistPreview();
    refreshEmailPreferencesLink();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();


