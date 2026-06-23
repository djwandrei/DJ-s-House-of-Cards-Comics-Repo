/**
 * Customer account page helpers.
 * -----------------------------------------------------------------------------
 * Authenticated buyer details, collector preferences, wishlists, and checkout
 * history are stored in Supabase.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const PRODUCT_SOURCE = 'products.json';
  const DEFAULT_PROFILE_FIELD_LENGTH = 240;
  const WISHLIST_PREVIEW_LIMIT = 5;
  const SAVED_SEARCH_ROUTES = [
    ['Baseball', 'baseball-cards.html'],
    ['Basketball', 'basketball-cards.html'],
    ['Football', 'football-cards.html']
  ];
  const contactEmail = 'djscardscomics13@gmail.com';
  let accountProductsPromise = null;
  let wishlistRenderTimer = 0;
  let accountSession = null;
  let savedProfile = {};
  let hydratedUserId = '';
  let accountRefreshPromise = null;

  // Keep labels, completion scoring, and exceptional limits in one registry so
  // profile fields cannot drift between forms, summaries, and validation.
  const PROFILE_FIELDS = {
    fullName: { label: 'Full name', countsTowardCompletion: true },
    email: { label: 'Email', countsTowardCompletion: true },
    phone: { label: 'Phone' },
    preferredContact: { label: 'Preferred contact', countsTowardCompletion: true },
    favoritePlayers: { label: 'Favorite players / characters', countsTowardCompletion: true },
    favoriteTeams: { label: 'Favorite teams / titles', countsTowardCompletion: true },
    budgetRange: { label: 'Budget range', countsTowardCompletion: true },
    preferredCondition: { label: 'Preferred condition' },
    collectorDisplayName: { label: 'Collector display name' },
    profileVisibility: { label: 'Profile visibility' },
    collectorFocus: { label: 'Collecting focus' },
    favoriteEra: { label: 'Favorite era' },
    tradeStatus: { label: 'Trade status' },
    wishlistSharing: { label: 'Wishlist sharing' },
    collectorBio: { label: 'Collector bio', maxLength: 520 },
    shippingName: { label: 'Shipping name', countsTowardCompletion: true },
    addressLine1: { label: 'Address line 1', countsTowardCompletion: true },
    addressLine2: { label: 'Address line 2' },
    city: { label: 'City', countsTowardCompletion: true },
    state: { label: 'State', countsTowardCompletion: true },
    postalCode: { label: 'ZIP / postal code', countsTowardCompletion: true },
    notes: { label: 'Collecting notes', countsTowardCompletion: true, maxLength: 1200 }
  };
  const fields = Object.keys(PROFILE_FIELDS);
  const profileCompletionFields = fields.filter((field) => PROFILE_FIELDS[field].countsTowardCompletion);
  const MULTI_CHOICE_PROFILE_FIELDS = new Set(['collectorFocus', 'tradeStatus']);

  const $ = (id) => document.getElementById(id);
  const pageParam = (name) => new URLSearchParams(window.location.search).get(name);

  function normalizeProfileValue(field, value) {
    const maxLength = PROFILE_FIELDS[field]?.maxLength || DEFAULT_PROFILE_FIELD_LENGTH;
    return String(value || '').trim().slice(0, maxLength);
  }

  function splitProfileSelections(value = '') {
    return [...new Set(String(value || '')
      .split(/\s*\|\s*|[,;\n]+/)
      .map((selection) => selection.trim())
      .filter(Boolean))]
      .slice(0, 12);
  }

  function joinProfileSelections(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((selection) => String(selection || '').trim())
      .filter(Boolean))]
      .join(' | ');
  }

  function getMultiChoiceInputs(field) {
    return [...document.querySelectorAll(`[data-profile-multi="${field}"]`)];
  }

  function updateMultiChoiceHiddenField(field, value) {
    const hidden = $(`account_${field}`);
    if (hidden) hidden.value = normalizeProfileValue(field, value);
  }

  function readMultiChoiceField(field) {
    const selected = getMultiChoiceInputs(field)
      .filter((input) => input.checked)
      .map((input) => input.value);
    const value = normalizeProfileValue(field, joinProfileSelections(selected));
    updateMultiChoiceHiddenField(field, value);
    return value;
  }

  function syncMultiChoiceField(field, value = '') {
    const selected = new Set(splitProfileSelections(value).map((selection) => selection.toLowerCase()));
    getMultiChoiceInputs(field).forEach((input) => {
      input.checked = selected.has(String(input.value || '').trim().toLowerCase());
    });
    updateMultiChoiceHiddenField(field, joinProfileSelections(splitProfileSelections(value)));
  }

  function profileSelectionTags(value = '') {
    return splitProfileSelections(value).slice(0, 6);
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
      if (MULTI_CHOICE_PROFILE_FIELDS.has(field)) {
        const value = profile[field] || '';
        syncMultiChoiceField(field, value);
        return;
      }

      const input = $(`account_${field}`);
      if (input) {
        input.value = profile[field]
          || (field === 'email' ? accountSession?.user?.email : '')
          || '';
      }
    });
  }

  function readProfileForm() {
    const profile = {};
    fields.forEach((field) => {
      if (MULTI_CHOICE_PROFILE_FIELDS.has(field)) {
        profile[field] = readMultiChoiceField(field);
        return;
      }

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
    return Boolean($('accountProfileForm') || $('collectorProfileForm')) && hasUnsavedProfileChanges(readProfileForm(), savedProfile);
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

  async function getWishlistProducts() {
    const wishlistIds = getWishlistIds();
    if (!wishlistIds.length) return [];
    const order = new Map(wishlistIds.map((id, index) => [Number(id), index]));
    if (DJ.remoteCatalog.isConfigured()) {
      const remoteProducts = await DJ.remoteCatalog.listProducts({ ids: wishlistIds }).catch(() => null);
      if (Array.isArray(remoteProducts)) {
        return remoteProducts
          .filter((product) => order.has(Number(product.id)))
          .sort((left, right) => order.get(Number(left.id)) - order.get(Number(right.id)));
      }
    }
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
        lines.push(`${PROFILE_FIELDS[field].label}: ${value}`);
      }
    });

    if (wishlistProducts.length) {
      lines.push('', 'Wishlist preview:');
      wishlistProducts.slice(0, WISHLIST_PREVIEW_LIMIT).forEach((product, index) => {
        lines.push(`${index + 1}. ${product.name || 'Saved item'} - ${DJ.displayPrice(product) || ''} - #${product.id || ''}`.trim());
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

  function buildSearchUrl(route, term = '') {
    return `${route}?search=${encodeURIComponent(term)}`;
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
      createElement('strong', { text: 'Saved sports searches' }),
      ...terms.flatMap((term) => SAVED_SEARCH_ROUTES.map(([label, route]) => createElement('a', {
        className: 'account-saved-search-link',
        href: buildSearchUrl(route, term),
        text: `${term} - ${label}`
      })))
    );
  }

  function getCollectorDisplayName(profile = {}) {
    return normalizeProfileValue('collectorDisplayName', profile.collectorDisplayName)
      || normalizeProfileValue('fullName', profile.fullName);
  }

  function hasCollectorProfileDetails(profile = {}) {
    return Boolean(
      getCollectorDisplayName(profile)
      || normalizeProfileValue('collectorFocus', profile.collectorFocus)
      || normalizeProfileValue('favoriteEra', profile.favoriteEra)
      || normalizeProfileValue('tradeStatus', profile.tradeStatus)
      || normalizeProfileValue('collectorBio', profile.collectorBio)
      || normalizeProfileValue('favoritePlayers', profile.favoritePlayers)
      || normalizeProfileValue('favoriteTeams', profile.favoriteTeams)
      || normalizeProfileValue('preferredCondition', profile.preferredCondition)
    );
  }

  function getCollectorProfileCompletion(profile = {}) {
    const checks = [
      getCollectorDisplayName(profile),
      normalizeProfileValue('collectorFocus', profile.collectorFocus),
      normalizeProfileValue('favoriteEra', profile.favoriteEra)
        || normalizeProfileValue('favoritePlayers', profile.favoritePlayers)
        || normalizeProfileValue('favoriteTeams', profile.favoriteTeams),
      normalizeProfileValue('tradeStatus', profile.tradeStatus),
      normalizeProfileValue('collectorBio', profile.collectorBio)
    ];
    const completed = checks.filter(Boolean).length;
    return {
      completed,
      total: checks.length,
      percent: Math.round((completed / checks.length) * 100)
    };
  }

  function getCollectorProfileStatus(profile = {}) {
    if (!hasCollectorProfileDetails(profile)) return 'Not started';
    const visibility = normalizeProfileValue('profileVisibility', profile.profileVisibility);
    if (/public/i.test(visibility)) return 'Public-ready';
    if (/shareable/i.test(visibility)) return 'Shareable';
    return 'Private draft';
  }

  function getCollectorInitials(displayName = '') {
    const parts = String(displayName || '')
      .split(/\s+/)
      .map((part) => part.replace(/[^a-z0-9]/gi, ''))
      .filter(Boolean);
    return (parts.length ? parts.slice(0, 2).map((part) => part[0]).join('') : 'DJ').toUpperCase();
  }

  function renderCollectorTags(container, tags = []) {
    container.replaceChildren();
    tags.filter(Boolean).slice(0, 6).forEach((tag) => {
      container.appendChild(createElement('span', { text: tag }));
    });
  }

  function renderCollectorProfile(profile = readProfileForm(), wishlistIds = getWishlistIds()) {
    const heroStatus = $('accountHeroCollectorStatus');
    const completionLabel = $('collectorProfileCompletionLabel');
    const completionBar = $('collectorProfileCompletionBar');
    const preview = $('collectorProfilePreview');
    const completion = getCollectorProfileCompletion(profile);
    const displayName = getCollectorDisplayName(profile);
    const visibility = normalizeProfileValue('profileVisibility', profile.profileVisibility) || 'Private account profile';
    const focus = normalizeProfileValue('collectorFocus', profile.collectorFocus);
    const focusTags = profileSelectionTags(focus);
    const era = normalizeProfileValue('favoriteEra', profile.favoriteEra);
    const tradeStatus = normalizeProfileValue('tradeStatus', profile.tradeStatus);
    const tradeStatusTags = profileSelectionTags(tradeStatus);
    const preferredCondition = normalizeProfileValue('preferredCondition', profile.preferredCondition);
    const collectorBio = normalizeProfileValue('collectorBio', profile.collectorBio)
      || normalizeProfileValue('notes', profile.notes);
    const favorites = [
      normalizeProfileValue('favoritePlayers', profile.favoritePlayers),
      normalizeProfileValue('favoriteTeams', profile.favoriteTeams)
    ].filter(Boolean).join(' | ');
    const wishlistSharing = normalizeProfileValue('wishlistSharing', profile.wishlistSharing);
    const wishlistLabel = wishlistIds.length
      ? `${wishlistIds.length} saved item${wishlistIds.length === 1 ? '' : 's'}`
      : '';

    if (heroStatus) heroStatus.textContent = getCollectorProfileStatus(profile);
    if (completionLabel) {
      completionLabel.textContent = `${completion.percent}%`;
      completionLabel.setAttribute('aria-label', `${completion.completed} of ${completion.total} collector profile fields filled`);
    }
    if (completionBar) completionBar.style.width = `${completion.percent}%`;
    if (!preview) return;

    const card = createElement('article', {
      className: `collector-profile-preview-card${hasCollectorProfileDetails(profile) ? '' : ' is-empty'}`
    });
    const header = createElement('div', { className: 'collector-profile-preview-head' });
    const avatar = createElement('span', {
      className: 'collector-profile-avatar',
      text: getCollectorInitials(displayName || focusTags[0] || profile.fullName)
    });
    const titleWrap = createElement('div');
    titleWrap.append(
      createElement('strong', { text: displayName || 'Collector profile' }),
      createElement('small', { text: [visibility, focusTags.join(' + ')].filter(Boolean).join(' | ') || 'Private collector notes' })
    );
    header.append(avatar, titleWrap);

    const copy = createElement('p', {
      text: collectorBio || 'Add a short collector bio to make offers, trade ideas, and wishlist conversations easier to qualify.'
    });
    const tags = createElement('div', { className: 'collector-profile-tags' });
    renderCollectorTags(tags, [
      ...focusTags,
      era,
      favorites,
      preferredCondition,
      ...tradeStatusTags,
      wishlistSharing,
      wishlistLabel
    ]);

    card.append(header, copy, tags);
    preview.replaceChildren(card);
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
      .map((product) => ({ product, price: DJ.payablePrice(product) }))
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
        value: highest ? DJ.displayPrice(highest.product) || DJ.currency(highest.price) : 'Ask'
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

  async function saveProfileForm(event) {
    event?.preventDefault();
    const isCollectorForm = event?.target?.id === 'collectorProfileForm';
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
      setStatus(
        isCollectorForm ? 'Collector profile synced to your account.' : 'Buyer details synced to your account.',
        'success'
      );
      renderAccountSummary();
    } catch (error) {
      setStatus(error.message || 'Buyer details could not be synced.', 'error');
    }
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
        className: `account-checklist-item${item.complete ? ' is-complete' : ''}`,
        attributes: { role: 'listitem' }
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
    const storedProfile = savedProfile;
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
        ? 'Synced to account'
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
    renderCollectorProfile(currentProfile, wishlistIds);
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
    const numericPrices = products.map((product) => DJ.payablePrice(product)).filter((price) => Number.isFinite(price));
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
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: String(order.currency || 'usd').toUpperCase()
      }).format(cents / 100);
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
    $('accountClearProfile')?.addEventListener('click', clearSavedProfile);
    $('accountUseNameForShipping')?.addEventListener('click', useNameForShipping);
    $('accountEmailPreferences')?.addEventListener('mouseenter', refreshEmailPreferencesLink);
    $('accountEmailPreferences')?.addEventListener('focus', refreshEmailPreferencesLink);

    const bindProfileForm = (formId) => {
      const form = $(formId);
      form?.addEventListener('submit', saveProfileForm);
      form?.addEventListener('input', renderAccountSummary);
      form?.addEventListener('change', renderAccountSummary);
    };
    bindProfileForm('accountProfileForm');
    bindProfileForm('collectorProfileForm');

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
    refreshEmailPreferencesLink();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();


