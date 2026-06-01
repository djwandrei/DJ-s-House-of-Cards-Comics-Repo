/**
 * Customer account page helpers.
 * -----------------------------------------------------------------------------
 * Buyer details stay local to this browser. The page focuses on practical buyer
 * utilities: reusable contact/shipping notes, a wishlist preview, and quick
 * copy/export tools for messages to DJ.
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
  const contactEmail = 'contact@djshouseofcards-comics.com';
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
    accountProductsPromise = fetch(PRODUCT_SOURCE, { cache: 'force-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${PRODUCT_SOURCE}`);
        return response.json();
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

  function buildWishlistText(products = []) {
    if (!products.length) {
      return 'DJ wishlist: no matching saved items in the current catalog.';
    }
    const lines = ['DJ wishlist'];
    products.forEach((product, index) => {
      lines.push(`${index + 1}. ${product.name || 'Saved item'} | ${DJ.displayPrice?.(product) || 'Ask'} | ${DJ.productPageUrl(product)}`);
    });
    return lines.join('\n');
  }

  function buildWishlistCsv(products = []) {
    const escape = typeof DJ.csvEscape === 'function'
      ? DJ.csvEscape
      : (value) => {
        const text = String(value ?? '');
        return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
      };
    const headers = ['Listing ID', 'Title', 'Category', 'Year', 'Team / Publisher', 'Condition', 'Price', 'Storefront URL'];
    const origin = window.location.origin && window.location.origin !== 'null' ? window.location.origin : '';
    const rows = products.map((product) => [
      product.id || '',
      product.name || '',
      product.category || '',
      product.year || '',
      product.team || '',
      product.condition || '',
      DJ.displayPrice?.(product) || '',
      `${origin}/${DJ.productPageUrl(product)}`.replace(/([^:]\/)\/+/g, '$1')
    ]);
    return [headers, ...rows].map((row) => row.map(escape).join(',')).join('\r\n');
  }

  function downloadTextFile(content, filenamePrefix, extension, type) {
    if (typeof DJ.downloadTextFile === 'function') {
      DJ.downloadTextFile(content, filenamePrefix, extension, type);
      return;
    }
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
    const textarea = createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
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
    const completionLabel = $('accountProfileCompletionLabel');
    const completionBar = $('accountProfileCompletionBar');
    const savedAt = $('accountProfileSavedAt');
    const emailLink = $('accountEmailPreferences');
    const clearButton = $('accountClearProfile');
    const cleanWishlistButton = $('accountCleanWishlist');
    const profileStatus = $('accountProfileStatus');
    const wishlistIds = getWishlistIds();
    const currentProfile = readProfileForm();
    const storedProfile = readLocalProfile();
    const completion = getProfileCompletion(currentProfile);
    const hasDetails = hasProfileDetails(currentProfile);
    const hasSavedDetails = hasProfileDetails(storedProfile);
    const hasUnsavedChanges = hasUnsavedProfileChanges(currentProfile, storedProfile);

    if (countTarget) countTarget.textContent = String(wishlistIds.length);
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
    ['accountCopyWishlist', 'accountExportWishlistCsv'].forEach((id) => {
      const button = $(id);
      if (button) button.disabled = !wishlistIds.length;
    });
    if (cleanWishlistButton && !wishlistIds.length) cleanWishlistButton.disabled = true;
    renderReadinessChecklist(currentProfile, wishlistIds);
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
      const cleanButton = $('accountCleanWishlist');
      if (cleanButton) cleanButton.disabled = true;
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
    const cleanButton = $('accountCleanWishlist');
    if (cleanButton) {
      cleanButton.disabled = unresolvedCount === 0;
      cleanButton.textContent = unresolvedCount ? `Clean ${unresolvedCount} Stale Item${unresolvedCount === 1 ? '' : 's'}` : 'Clean Stale Items';
    }

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

  async function copyBuyerSummary() {
    const profile = readProfileForm();
    const wishlistProducts = await getWishlistProducts();
    const summary = buildBuyerSummary(profile, getWishlistIds().length, wishlistProducts);
    try {
      await copyText(summary);
      setStatus('Buyer summary copied.', 'success');
    } catch {
      setStatus('This browser blocked clipboard access.', 'error');
    }
  }

  async function copyShippingAddress() {
    const address = formatShippingAddress(readProfileForm());
    if (!address) {
      setStatus('Add a shipping address before copying it.', 'error');
      return;
    }
    try {
      await copyText(address);
      setStatus('Shipping address copied.', 'success');
    } catch {
      setStatus('This browser blocked clipboard access.', 'error');
    }
  }

  async function copyWishlistList() {
    const products = await getWishlistProducts();
    if (!getWishlistIds().length) {
      setStatus('Your wishlist is empty.', 'info');
      return;
    }
    try {
      await copyText(buildWishlistText(products));
      setStatus('Wishlist copied.', 'success');
    } catch {
      setStatus('This browser blocked clipboard access.', 'error');
    }
  }

  async function exportWishlistCsv() {
    const products = await getWishlistProducts();
    if (!getWishlistIds().length) {
      setStatus('Your wishlist is empty.', 'info');
      return;
    }
    downloadTextFile(buildWishlistCsv(products), 'dj-wishlist', 'csv', 'text/csv');
    setStatus('Wishlist CSV exported.', 'success');
  }

  async function cleanStaleWishlistItems() {
    const wishlistIds = getWishlistIds();
    if (!wishlistIds.length) {
      setStatus('Your wishlist is already empty.', 'info');
      return;
    }
    const products = await getWishlistProducts();
    const activeIds = new Set(products.map((product) => Number(product.id)));
    const cleanedIds = wishlistIds.filter((id) => activeIds.has(Number(id)));
    const removedCount = wishlistIds.length - cleanedIds.length;
    if (!removedCount) {
      setStatus('No stale wishlist items found.', 'info');
      return;
    }
    if (!window.confirm(`Remove ${removedCount} stale wishlist item${removedCount === 1 ? '' : 's'} from this browser?`)) return;
    if (typeof DJ.setWishlist !== 'function') {
      setStatus('Wishlist cleanup is unavailable in this browser.', 'error');
      return;
    }
    DJ.setWishlist(cleanedIds);
    renderAccountSummary();
    await renderWishlistPreview();
    setStatus(`${removedCount} stale wishlist item${removedCount === 1 ? '' : 's'} removed.`, 'success');
  }

  async function refreshEmailPreferencesLink() {
    const link = $('accountEmailPreferences');
    if (!link) return;
    const products = await getWishlistProducts();
    link.href = buildPreferencesEmailUrl(readProfileForm(), getWishlistIds().length, products);
  }

  async function exportBuyerDetails() {
    const products = await getWishlistProducts();
    const payload = {
      exportedAt: new Date().toISOString(),
      profile: readProfileForm(),
      wishlistIds: getWishlistIds(),
      wishlistPreview: products.slice(0, WISHLIST_PREVIEW_LIMIT).map((product) => ({
        id: product.id,
        name: product.name,
        category: product.category || '',
        price: DJ.displayPrice?.(product) || '',
        url: DJ.productPageUrl(product)
      }))
    };
    downloadTextFile(JSON.stringify(payload, null, 2), 'dj-buyer-details', 'json', 'application/json');
    setStatus('Buyer details exported.', 'success');
  }

  async function importBuyerDetails(file) {
    const parsed = JSON.parse(await file.text());
    const sourceProfile = parsed?.profile && typeof parsed.profile === 'object'
      ? parsed.profile
      : parsed;
    if (!sourceProfile || typeof sourceProfile !== 'object' || Array.isArray(sourceProfile)) {
      throw new Error('That file does not contain buyer details.');
    }

    const profile = readLocalProfile();
    fields.forEach((field) => {
      profile[field] = normalizeProfileValue(field, sourceProfile[field]);
    });
    profile.updatedAt = new Date().toISOString();
    if (!writeLocalProfile(profile)) {
      throw new Error('This browser blocked local buyer detail storage.');
    }
    loadProfileForm();
    renderAccountSummary();
    await refreshEmailPreferencesLink();
  }

  function bindEvents() {
    $('accountClearProfile')?.addEventListener('click', clearLocalProfile);
    $('accountUseNameForShipping')?.addEventListener('click', useNameForShipping);
    $('accountCopyProfile')?.addEventListener('click', copyBuyerSummary);
    $('accountCopyShipping')?.addEventListener('click', copyShippingAddress);
    $('accountCopyWishlist')?.addEventListener('click', copyWishlistList);
    $('accountExportWishlistCsv')?.addEventListener('click', exportWishlistCsv);
    $('accountCleanWishlist')?.addEventListener('click', cleanStaleWishlistItems);
    $('accountExportProfile')?.addEventListener('click', exportBuyerDetails);
    $('accountEmailPreferences')?.addEventListener('mouseenter', refreshEmailPreferencesLink);
    $('accountEmailPreferences')?.addEventListener('focus', refreshEmailPreferencesLink);
    const importButton = $('accountImportProfileButton');
    const importInput = $('accountImportProfileInput');
    importButton?.addEventListener('click', () => importInput?.click());
    importInput?.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        await importBuyerDetails(file);
        setStatus('Buyer details imported.', 'success');
      } catch (error) {
        setStatus(error.message || 'Unable to import buyer details.', 'error');
      } finally {
        importInput.value = '';
      }
    });

    const profileForm = $('accountProfileForm');
    profileForm?.addEventListener('submit', saveProfileForm);
    profileForm?.addEventListener('input', renderAccountSummary);
    profileForm?.addEventListener('change', renderAccountSummary);
    window.addEventListener('dj:wishlistchange', () => {
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
