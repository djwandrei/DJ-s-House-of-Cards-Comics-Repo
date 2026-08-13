/**
 * Customer account page helpers.
 * -----------------------------------------------------------------------------
 * Authenticated buyer details, wishlists, and checkout history are stored in
 * Supabase.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const PRODUCT_SOURCE = 'products.json';
  const DEFAULT_PROFILE_FIELD_LENGTH = 240;
  const WISHLIST_PREVIEW_LIMIT = 5;
  let accountProductsPromise = null;
  let accountProductsByIdPromise = null;
  let wishlistRenderTimer = 0;
  let accountSession = null;
  let savedProfile = {};
  let hydratedUserId = '';
  let accountRefreshPromise = null;
  const orderCurrencyFormatters = new Map();

  const fields = [
    'fullName',
    'email',
    'phone',
    'preferredContact',
    'addressLine1',
    'addressLine2',
    'addressCity',
    'addressState',
    'addressPostalCode',
    'addressCountry'
  ];

  const $ = (id) => document.getElementById(id);
  const pageParam = (name) => new URLSearchParams(window.location.search).get(name);

  function normalizeProfileValue(field, value) {
    return String(value || '').trim().slice(0, DEFAULT_PROFILE_FIELD_LENGTH);
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

  function setStatusElement(id, message = '', tone = 'info') {
    const status = $(id);
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function setStatus(message = '', tone = 'info') {
    setStatusElement('accountStatus', message, tone);
  }

  function setAuthStatus(message = '', tone = 'info') {
    setStatusElement('accountAuthStatus', message, tone);
  }

  function getWishlistIds() {
    return DJ.getWishlist();
  }

  function loadProfileForm(profile = savedProfile) {
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      if (input) {
        input.value = profile[field]
          || (field === 'email' ? accountSession?.user?.email : '')
          || '';
      }
    });
  }

  function readProfileForm() {
    // Preserve any older optional data already stored in the account. The
    // streamlined page no longer surfaces or overwrites it.
    const profile = { ...savedProfile };
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      profile[field] = input
        ? normalizeProfileValue(field, input.value)
        : normalizeProfileValue(field, savedProfile[field]);
    });
    profile.updatedAt = savedProfile.updatedAt || '';
    return profile;
  }

  function hasProfileDetails(profile) {
    return fields.some((field) => Boolean(normalizeProfileValue(field, profile?.[field])));
  }

  function hasUnsavedProfileChanges(currentProfile, storedProfile) {
    return fields.some((field) => (
      normalizeProfileValue(field, currentProfile?.[field]) !== normalizeProfileValue(field, storedProfile?.[field])
    ));
  }

  function hasUnsavedProfileFormChanges() {
    return Boolean($('accountProfileForm')) && hasUnsavedProfileChanges(readProfileForm(), savedProfile);
  }

  function formatSavedAt(value) {
    if (!value) return 'No saved buyer details yet.';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Buyer details are synced to your account.';
    return `Last synced ${date.toLocaleString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })}.`;
  }

  function loadAccountProducts() {
    if (accountProductsPromise) return accountProductsPromise;
    const productSource = DJ.versionedProductAsset(PRODUCT_SOURCE);
    accountProductsPromise = fetch(productSource, { cache: 'default' })
      .then((response) => {
        if (!response.ok) throw new Error(`Unable to load ${PRODUCT_SOURCE}`);
        return response.json();
      })
      .catch(async (error) => {
        const bundledProducts = await DJ.loadPreloadedProductsForSource(PRODUCT_SOURCE).catch(() => null);
        if (Array.isArray(bundledProducts)) return bundledProducts;
        throw error;
      })
      .then((products) => (Array.isArray(products) ? products : []))
      .catch((error) => {
        console.error(error);
        return [];
      });
    return accountProductsPromise;
  }

  function createProductIdLookup(products = []) {
    const productsById = new Map();
    for (const product of products) {
      const productId = Number(product?.id);
      if (Number.isFinite(productId) && !productsById.has(productId)) {
        productsById.set(productId, product);
      }
    }
    return productsById;
  }

  function loadAccountProductsById() {
    if (accountProductsByIdPromise) return accountProductsByIdPromise;

    accountProductsByIdPromise = loadAccountProducts().then(createProductIdLookup);
    return accountProductsByIdPromise;
  }

  function orderWishlistProducts(products = [], wishlistIds = []) {
    const productsById = createProductIdLookup(products);
    return wishlistIds.map((id) => productsById.get(Number(id))).filter(Boolean);
  }

  async function getWishlistProducts() {
    const wishlistIds = getWishlistIds();
    if (!wishlistIds.length) return [];
    if (DJ.remoteCatalog.isConfigured()) {
      const remoteProducts = await DJ.remoteCatalog.listProducts({ ids: wishlistIds }).catch(() => null);
      if (Array.isArray(remoteProducts)) {
        return orderWishlistProducts(remoteProducts, wishlistIds);
      }
    }
    const productsById = await loadAccountProductsById();
    return wishlistIds.map((id) => productsById.get(Number(id))).filter(Boolean);
  }

  async function saveProfileForm(event) {
    event?.preventDefault();
    const profile = readProfileForm();
    profile.updatedAt = new Date().toISOString();

    if (!accountSession?.user) {
      setStatus('Sign in to save these details to your customer account.', 'info');
      DJ.payments.openAuthModal({ message: 'Sign in or create an account to save your buyer details.' });
      return;
    }

    try {
      const result = await DJ.remoteCatalog.saveAccountProfile(profile);
      savedProfile = {
        ...result.profile,
        updatedAt: result.updatedAt || profile.updatedAt
      };
      loadProfileForm(savedProfile);
      setStatus('Account details synced.', 'success');
      renderAccountSummary();
    } catch (error) {
      setStatus(error.message || 'Buyer details could not be synced.', 'error');
    }
  }

  function renderAccountSummary() {
    const countTarget = $('accountWishlistCount');
    const heroCountTarget = $('accountHeroWishlistCount');
    const heroSavedStatus = $('accountHeroSavedStatus');
    const wishlistPlural = document.querySelector('.account-wishlist-summary-plural');
    const savedAt = $('accountProfileSavedAt');
    const clearButton = $('accountClearProfile');
    const wishlistIds = getWishlistIds();
    const currentProfile = readProfileForm();
    const storedProfile = savedProfile;
    const hasDetails = hasProfileDetails(currentProfile);
    const hasSavedDetails = hasProfileDetails(storedProfile);
    const hasUnsavedChanges = hasUnsavedProfileChanges(currentProfile, storedProfile);

    if (countTarget) countTarget.textContent = String(wishlistIds.length);
    if (wishlistPlural) wishlistPlural.textContent = wishlistIds.length === 1 ? '' : 's';
    if (heroCountTarget) {
      heroCountTarget.textContent = `${wishlistIds.length} item${wishlistIds.length === 1 ? '' : 's'}`;
    }
    if (heroSavedStatus) {
      heroSavedStatus.textContent = hasSavedDetails
        ? 'Synced to account'
        : hasDetails
          ? 'Draft in progress'
          : 'Not saved yet';
    }
    if (savedAt) {
      savedAt.textContent = hasUnsavedChanges && hasDetails
        ? 'Unsaved changes in the form.'
        : formatSavedAt(storedProfile.updatedAt);
    }
    if (clearButton) clearButton.disabled = !hasSavedDetails;
  }

  async function renderWishlistPreview() {
    const container = $('accountWishlistPreview');
    const meta = $('accountWishlistPreviewMeta');
    if (!container) return;
    const wishlistIds = getWishlistIds();

    if (!wishlistIds.length) {
      if (meta) meta.textContent = 'No saved items yet.';
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
    const unresolvedCount = Math.max(0, wishlistIds.length - products.length);
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
      const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
      const row = createElement('a', {
        className: 'account-wishlist-row',
        href: DJ.productPageUrl(product)
      });
      const image = createElement('img', {
        attributes: {
          src: DJ.safeAssetUrl(product.image || fallback),
          alt: product.name || 'Saved item',
          loading: 'lazy',
          decoding: 'async'
        }
      });
      image.setAttribute('data-fallback-src', DJ.safeAssetUrl(fallback));
      const copy = createElement('span');
      copy.append(
        createElement('strong', { text: product.name || 'Saved item' }),
        createElement('small', { text: [product.year, product.category, product.team].filter(Boolean).join(' | ') || 'Saved listing' })
      );
      row.append(image, copy, createElement('b', { text: DJ.displayPrice(product) || 'Ask' }));
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
    DJ.applyLazyLoading(container);
  }

  function scheduleWishlistPreviewRender() {
    if (wishlistRenderTimer) window.clearTimeout(wishlistRenderTimer);
    wishlistRenderTimer = window.setTimeout(() => {
      wishlistRenderTimer = 0;
      renderWishlistPreview();
    }, 80);
  }

  async function clearSavedProfile() {
    if (!accountSession?.user) {
      setStatus('Sign in to clear buyer details from your customer account.', 'info');
      DJ.payments.openAuthModal({ message: 'Sign in to manage your saved buyer details.' });
      return;
    }

    const storedProfile = savedProfile;
    if (!hasProfileDetails(storedProfile)) {
      setStatus('There are no saved buyer details to clear.', 'info');
      return;
    }

    const confirmed = window.confirm('Clear the buyer details saved in your account? Your wishlist will stay intact.');
    if (!confirmed) return;

    try {
      await DJ.remoteCatalog.clearAccountProfile();
      savedProfile = {};
      loadProfileForm(savedProfile);
      renderAccountSummary();
      setStatus('Buyer details cleared from your account.', 'success');
    } catch (error) {
      setStatus(error.message || 'Buyer details could not be cleared.', 'error');
    }
  }

  function formatOrderAmount(order = {}) {
    const cents = Number(order.amount_total);
    if (!Number.isFinite(cents)) return '';
    const currency = String(order.currency || 'usd').toUpperCase();
    try {
      let formatter = orderCurrencyFormatters.get(currency);
      if (!formatter) {
        formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency });
        orderCurrencyFormatters.set(currency, formatter);
      }
      return formatter.format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  }

  function renderOrderHistoryMessage(container, title, message) {
    const emptyState = createElement('div', { className: 'account-empty-state' });
    emptyState.append(
      createElement('strong', { text: title }),
      createElement('p', { text: message })
    );
    container.appendChild(emptyState);
  }

  async function renderOrderHistory(session = null) {
    const container = $('accountOrders');
    if (!container) return;
    container.replaceChildren();

    if (!DJ.remoteCatalog.isConfigured()) {
      renderOrderHistoryMessage(container, 'Checkout history is unavailable.', 'Secure customer accounts are not configured for this site.');
      return;
    }

    if (!session?.user) {
      renderOrderHistoryMessage(container, 'Sign in to review checkout activity.', 'Completed and pending checkout orders tied to your customer account will appear here.');
      return;
    }

    let orders = [];
    try {
      orders = await DJ.remoteCatalog.listOrders();
    } catch (error) {
      console.error(error);
      renderOrderHistoryMessage(container, 'Checkout history could not be loaded.', 'Please refresh the page or try again shortly.');
      return;
    }

    if (!orders.length) {
      const checkoutSucceeded = pageParam('checkout') === 'success';
      renderOrderHistoryMessage(
        container,
        checkoutSucceeded ? 'Payment received.' : 'No checkout orders yet.',
        checkoutSucceeded
          ? 'Your order is being confirmed and will appear here shortly.'
          : 'Orders completed through secure checkout will appear here.'
      );
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.slice(0, 12).forEach((order) => {
      const card = createElement('article', { className: 'account-order-card' });
      const amount = formatOrderAmount(order);
      const status = String(order.status || 'pending').replaceAll('_', ' ');
      const createdAt = order.created_at ? new Date(order.created_at) : null;
      const orderItems = Array.isArray(order.checkout_order_items) ? order.checkout_order_items : [];
      const itemCount = orderItems.reduce((total, item) => total + Math.max(1, Number(item.quantity) || 1), 0)
        || Math.max(1, Number(order.item_count) || 1);
      const itemsList = createElement('ul', { className: 'account-order-items' });
      orderItems.forEach((item) => {
        itemsList.appendChild(createElement('li', {
          text: `${Math.max(1, Number(item.quantity) || 1)} × ${item.product_name || `Listing #${item.product_id}`}`
        }));
      });
      card.append(
        createElement('strong', {
          text: orderItems.length > 1
            ? `${itemCount} items`
            : (orderItems[0]?.product_name || order.products?.name || `Listing #${order.product_id}`)
        }),
        createElement('span', { text: [status, amount].filter(Boolean).join(' - ') }),
        createElement('small', { text: createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt.toLocaleString() : '' })
      );
      if (orderItems.length) card.appendChild(itemsList);
      fragment.appendChild(card);
    });
    container.appendChild(fragment);
  }

  async function hydrateAccountData(session) {
    accountSession = session || null;
    const userId = session?.user?.id || '';

    if (!userId) {
      hydratedUserId = '';
      savedProfile = {};
      loadProfileForm(savedProfile);
      renderAccountSummary();
      scheduleWishlistPreviewRender();
      return;
    }

    if (hydratedUserId === userId) return;

    const remoteResult = await DJ.remoteCatalog.getAccountProfile();
    let profile = {
      ...remoteResult.profile,
      updatedAt: remoteResult.updatedAt || remoteResult.profile?.updatedAt || ''
    };

    if (!hasProfileDetails(profile) && session.user.email) {
      const created = await DJ.remoteCatalog.saveAccountProfile({ email: session.user.email });
      profile = {
        ...created.profile,
        updatedAt: created.updatedAt || ''
      };
    }

    savedProfile = profile;
    hydratedUserId = userId;
    await DJ.syncWishlistWithAccount(session);
    loadProfileForm(savedProfile);
    renderAccountSummary();
    scheduleWishlistPreviewRender();
  }

  async function runAccountAuthRefresh() {
    const summary = $('accountAuthSummary');
    const signIn = $('accountSignIn');
    const signOut = $('accountSignOut');
    const passwordForm = $('accountPasswordForm');
    const recoveryMode = pageParam('mode') === 'reset-password';

    if (!DJ.remoteCatalog.isConfigured()) {
      if (summary) summary.textContent = 'Secure customer accounts are not configured for this site.';
      if (signIn) signIn.hidden = true;
      if (signOut) signOut.hidden = true;
      if (passwordForm) passwordForm.hidden = true;
      await renderOrderHistory();
      return;
    }

    const session = await DJ.remoteCatalog.getSession().catch(() => null);
    try {
      await hydrateAccountData(session);
    } catch (error) {
      console.error(error);
      setStatus('Your account data could not be loaded. Please refresh and try again.', 'error');
    }
    if (summary) {
      summary.textContent = session?.user?.email
        ? `Signed in as ${session.user.email}.`
        : 'Sign in to review checkout orders tied to your email.';
    }
    if (signIn) signIn.hidden = Boolean(session?.user);
    if (signOut) signOut.hidden = !session?.user;
    if (passwordForm) passwordForm.hidden = !(recoveryMode && session?.user);
    if (pageParam('checkout') === 'success') {
      setAuthStatus('Payment submitted. Your secure order status will appear below as soon as Stripe confirms it.', 'success');
    }
    await renderOrderHistory(session);
  }

  function refreshAccountAuth() {
    if (!accountRefreshPromise) {
      accountRefreshPromise = runAccountAuthRefresh().finally(() => {
        accountRefreshPromise = null;
      });
    }
    return accountRefreshPromise;
  }

  function bindAccountAuth() {
    $('accountSignIn')?.addEventListener('click', () => {
      DJ.payments.openAuthModal({ message: 'Sign in to review your secure checkout orders.' });
    });
    $('accountSignOut')?.addEventListener('click', async () => {
      try {
        await DJ.remoteCatalog.signOut();
        setAuthStatus('Signed out of the secure customer account.', 'success');
        await refreshAccountAuth();
      } catch (error) {
        setAuthStatus(error.message || 'Sign-out failed.', 'error');
      }
    });
    $('accountPasswordForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const password = String($('accountNewPassword')?.value || '');
      if (password.length < 8) {
        setAuthStatus('Use at least 8 characters for the new password.', 'error');
        return;
      }
      try {
        await DJ.remoteCatalog.updatePassword(password);
        if ($('accountNewPassword')) $('accountNewPassword').value = '';
        const url = new URL(window.location.href);
        url.searchParams.delete('mode');
        window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
        setAuthStatus('Password updated successfully.', 'success');
        await refreshAccountAuth();
      } catch (error) {
        setAuthStatus(error.message || 'Password could not be updated.', 'error');
      }
    });
    window.addEventListener('dj:authchange', (event) => {
      if (event.detail?.session?.user) {
        setAuthStatus('');
      }
      window.setTimeout(() => refreshAccountAuth().catch(console.error), 0);
    });
  }

  function bindEvents() {
    $('accountClearProfile')?.addEventListener('click', clearSavedProfile);
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
    window.addEventListener('pageshow', () => {
      renderAccountSummary();
      scheduleWishlistPreviewRender();
    });
  }

  function init() {
    bindEvents();
    bindAccountAuth();
    loadProfileForm(savedProfile);
    renderAccountSummary();
    refreshAccountAuth().catch(console.error);
    if (pageParam('checkout') === 'success') {
      window.setTimeout(() => refreshAccountAuth().catch(console.error), 4000);
    }
    renderWishlistPreview();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();


