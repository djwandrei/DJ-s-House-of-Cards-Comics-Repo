/**
 * Backend-first admin workflow.
 * -----------------------------------------------------------------------------
 * This file powers the Supabase-facing admin experience: sign in, browse remote
 * listings, upload images, seed the database, and edit/delete remote products.
 * It is the only listing editor: saves and permanent deletes go directly to the
 * live Supabase catalog.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;

  // A tiny debounce helper keeps search responsive without rerendering the remote
  // listing manager on every single keystroke while the user is still typing.
  function debounce(callback, delay = 120) {
    let timer = 0;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => callback(...args), delay);
    };
  }

  // Keep the listing manager responsive even with larger catalogs. The full
  // result count still appears in the header, while the grid renders a capped
  // slice for fast admin browsing.
  const REMOTE_LIST_RENDER_LIMIT = 250;
  const BUSY_CONTROL_SELECTOR = '#backendLoginForm button, #backendRefreshProducts, #backendSeedProducts, #backendConnectionTest, #backendSignOut, #backendNewListing, #backendListingForm button, #backendListingForm input, #backendListingForm select, #backendListingForm textarea, #backendListingSearch';

  const state = {
    session: null,
    remoteProducts: [],
    filteredProducts: [],
    search: '',
    remoteCategory: 'All',
    editingId: null,
    gallery: [],
    localFallbackVisible: false,
    authSubscription: null,
    isBusy: false,
    editorDirty: false,
    remoteVisibleLimit: REMOTE_LIST_RENDER_LIMIT
  };

  function getBusyControlledElements() {
    return document.querySelectorAll(BUSY_CONTROL_SELECTOR);
  }

  function normalizeGallery(items = []) {
    return [...new Set((Array.isArray(items) ? items : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean))];
  }

  function setBusy(isBusy) {
    state.isBusy = Boolean(isBusy);
    document.body.classList.toggle('admin-is-busy', state.isBusy);

    // A single busy toggle freezes the remote admin controls while requests are
    // running so sign-in, import, upload, and save actions cannot overlap.
    getBusyControlledElements().forEach((element) => {
      if ('disabled' in element) {
        element.disabled = state.isBusy;
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering and UI state helpers
  // ---------------------------------------------------------------------------

  function backend() {
    return DJ.remoteCatalog;
  }

  function escapeHtml(value = '') {
    if (typeof DJ.escapeHtml === 'function') {
      return DJ.escapeHtml(String(value));
    }
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatCountLabel(count, singular, plural = `${singular}s`) {
    const numeric = Number(count) || 0;
    return `${numeric} ${numeric === 1 ? singular : plural}`;
  }

  function buildRemoteSearchIndex(product = {}) {
    return [
      product.id,
      product.name,
      product.team,
      product.category,
      product.description,
      product.playerAthlete,
      product.sourcePage,
      product.condition,
      product.year
    ].join(' ').toLowerCase();
  }

  function prepareRemoteProduct(product = {}) {
    return {
      ...product,
      _searchIndex: buildRemoteSearchIndex(product)
    };
  }

  function sortRemoteProductsInPlace(products = state.remoteProducts) {
    products.sort((left, right) => {
      const leftRank = Number.isFinite(Number(left.sortRank)) ? Number(left.sortRank) : 0;
      const rightRank = Number.isFinite(Number(right.sortRank)) ? Number(right.sortRank) : 0;
      if (leftRank !== rightRank) return leftRank - rightRank;

      const leftYear = Number.isFinite(Number(left.year)) ? Number(left.year) : -Infinity;
      const rightYear = Number.isFinite(Number(right.year)) ? Number(right.year) : -Infinity;
      if (leftYear !== rightYear) return rightYear - leftYear;

      return Number(left.id || 0) - Number(right.id || 0);
    });
    return products;
  }

  function syncRemoteProductInState(product) {
    const normalized = prepareRemoteProduct(product);
    const productId = Number(normalized.id);
    const index = state.remoteProducts.findIndex((item) => Number(item.id) === productId);

    if (index >= 0) {
      state.remoteProducts[index] = normalized;
    } else {
      state.remoteProducts.push(normalized);
    }

    sortRemoteProductsInPlace();
    return normalized;
  }

  function emitRemoteAdminCatalogProducts() {
    window.dispatchEvent(new CustomEvent('dj:admincatalogproducts', {
      detail: {
        source: 'supabase',
        products: state.remoteProducts
      }
    }));
  }

  function getRemoteDraftName() {
    return document.getElementById('backendName')?.value.trim() || '';
  }

  function getRemoteDraftCategory() {
    return document.getElementById('backendCategory')?.value || 'Other';
  }

  function buildRemoteImageAlt({ name = '', category = 'Other', index = null, isMain = false } = {}) {
    const cleanName = String(name || '').trim();
    const cleanCategory = String(category || 'Other').trim() || 'Other';
    if (cleanName && Number.isFinite(index)) {
      return `${cleanName} gallery image ${index + 1}`;
    }
    if (cleanName && isMain) {
      return `${cleanName} main product image`;
    }
    if (cleanName) {
      return `${cleanName} product image`;
    }
    if (Number.isFinite(index)) {
      return `${cleanCategory} gallery image ${index + 1}`;
    }
    return `${cleanCategory} product image preview`;
  }

  function humanizeConnectionStep(name = '') {
    switch (String(name || '').toLowerCase()) {
      case 'config':
        return 'Configuration';
      case 'sdk':
        return 'Browser SDK';
      case 'client':
        return 'Client session';
      case 'products':
        return 'Products table';
      case 'storage':
        return 'Storage bucket';
      default:
        return 'Connection step';
    }
  }

  function buildHelperList(items = []) {
    if (!Array.isArray(items) || !items.length) return '';
    return `
      <ul class="backend-copy-list">
        ${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ul>
    `;
  }

  function buildConnectionStatus(result = {}) {
    const steps = Array.isArray(result.steps) ? result.steps : [];
    return {
      title: result.ok ? 'Supabase connection test passed.' : 'Supabase connection test found issues.',
      body: result.ok
        ? 'The browser reached the configured project, products table, and storage bucket.'
        : 'Review the steps below to see which part of the connection needs attention.',
      items: steps.map((step) => ({
        ok: step.ok,
        title: humanizeConnectionStep(step.name),
        message: step.message,
        details: Array.isArray(step.details) ? step.details : []
      })),
      meta: result.ok
        ? 'Remote listing loads, image uploads, and seed import should work after sign-in.'
        : 'If the SDK step fails, the browser could not load the Supabase library. If the products or storage steps fail, check table names, bucket names, or RLS policies.'
    };
  }

  function updateSearchShellState(inputId, shellId) {
    const input = document.getElementById(inputId);
    const shell = document.getElementById(shellId);
    if (!input || !shell) return;
    shell.classList.toggle('has-value', Boolean(input.value.trim()));
  }

  /**
   * Create the backend admin shell once. The markup is injected here so the static
   * HTML file can stay lean and the backend UI can evolve independently.
   */
  function buildBackendSection() {
    return `
      <section class="section admin-backend-section" id="backendAdminSection">
        <div class="container">
          <div class="panel admin-backend-panel">
            <div class="admin-panel-header">
              <div>
                <span class="kicker">Backend / CMS Mode</span>
                <h2 class="section-title" style="margin-top:.5rem">Supabase-connected admin</h2>
                <p class="section-subtitle">Sign in to your Supabase-backed catalog, upload product images to Storage, and manage live listings remotely.</p>
              </div>
              <div class="admin-toolbar-actions">
                <button class="button-secondary" id="backendRefreshProducts" type="button">Refresh Remote Listings</button>
                <button class="button-secondary" id="backendSeedProducts" type="button">Import Current products.json</button>
                <button class="button-secondary" id="backendConnectionTest" type="button">Run Connection Test</button>
                <button class="button-ghost" id="backendSignOut" type="button">Sign Out</button>
              </div>
            </div>

            <div class="backend-setup-callout" id="backendSetupCallout">
              <span class="admin-mode-pill admin-mode-pill--remote" id="backendSetupBadge">Checking setup</span>
              <div class="backend-setup-copy">
              <strong>Setup status:</strong>
              <span id="backendSetupMessage">Checking backend configuration...</span>
              </div>
            </div>

            <div class="backend-overview-grid">
              <article class="admin-stat-card backend-summary-card">
                <span class="admin-stat-label">Mode</span>
                <strong class="backend-summary-value" id="backendSummaryMode">Checking</strong>
                <p id="backendSummaryModeCopy">Checking the live Supabase catalog connection.</p>
              </article>
              <article class="admin-stat-card backend-summary-card">
                <span class="admin-stat-label">Admin session</span>
                <strong class="backend-summary-value" id="backendSummarySession">Signed out</strong>
                <p id="backendSummarySessionCopy">Sign in to unlock live listing edits, uploads, and imports.</p>
              </article>
              <article class="admin-stat-card backend-summary-card">
                <span class="admin-stat-label">Remote catalog</span>
                <strong class="backend-summary-value" id="backendSummaryCatalog">--</strong>
                <p id="backendSummaryCatalogCopy">Remote listings will appear here after a successful sign-in.</p>
              </article>
            </div>

            <form class="admin-form backend-auth-form" id="backendLoginForm" novalidate>
              <div class="admin-form-section__header">
                <h3 class="section-title section-title--small" style="margin-top:0">Admin Sign In</h3>
                <p class="helper-text">Use the Supabase admin account that should be allowed to upload photos, import listings, and edit live rows.</p>
              </div>
              <div class="admin-form-grid">
                <div>
                  <label for="backendEmail">Admin Email</label>
                  <input autocomplete="email" id="backendEmail" type="email" placeholder="you@example.com">
                </div>
                <div>
                  <label for="backendPassword">Password</label>
                  <input autocomplete="current-password" id="backendPassword" type="password" placeholder="Enter your password">
                </div>
              </div>
              <div class="inline-actions compact">
                <button type="submit">Sign In</button>
              </div>
            </form>

            <div aria-live="polite" class="status-message" hidden id="backendStatus"></div>

            <div class="admin-layout backend-admin-layout">
              <div class="panel admin-side-panel">
                <div class="admin-panel-header">
                  <div>
                    <span class="admin-mode-pill admin-mode-pill--remote">Live catalog</span>
                    <h3 class="section-title section-title--small" style="margin-top:0">Remote Listings</h3>
                    <p class="section-subtitle" id="backendListingCount">Not connected yet.</p>
                  </div>
                  <div class="admin-toolbar-actions">
                    <button class="button-secondary" id="backendNewListing" type="button">New Remote Listing</button>
                  </div>
                </div>
                <div class="admin-toolbar admin-toolbar--stacked">
                  <div class="admin-search-box">
                    <label for="backendListingSearch">Find remote listings</label>
                    <div class="search-shell admin-search-shell" id="backendSearchShell">
                      <input autocomplete="off" id="backendListingSearch" placeholder="Search by player, set, team, category, keyword, or ID" type="search">
                      <button aria-label="Clear remote listing search" class="search-clear" id="backendClearSearch" type="button">x</button>
                    </div>
                  </div>
                  <p class="helper-text">Search across listing name, team or publisher, category, description, athlete, source page, or listing ID.</p>
                </div>
                <div class="backend-listing-summary" id="backendListingSummary"></div>
                <div class="custom-items" id="backendListingsList"></div>
              </div>

              <aside class="panel admin-side-panel backend-editor-panel">
                <div class="admin-panel-header admin-panel-header--editor">
                  <div>
                    <span class="admin-mode-pill admin-mode-pill--remote" id="backendEditorEyebrow">Remote editor</span>
                    <h3 class="section-title section-title--small" style="margin-top:0">Edit Remote Listing</h3>
                    <p class="section-subtitle" id="backendEditorContext">Save directly to your Supabase database and storage bucket.</p>
                  </div>
                  <span class="admin-unsaved-badge" hidden id="backendDirtyBadge">Unsaved changes</span>
                </div>

                <div class="empty-state compact-empty-state" id="backendEditorEmpty">
                  <h3>Select or create a listing</h3>
                  <p>Choose a remote listing to edit its live details, media, gallery, and storefront visibility.</p>
                </div>

                <form class="admin-form existing-listing-form" hidden id="backendListingForm" novalidate>
                  <div class="admin-form-section">
                    <div class="admin-form-section__header">
                      <h4 class="section-title section-title--small" style="margin-top:0">Listing details</h4>
                      <p class="helper-text">Core product information used in cards, search, filters, and the storefront modal.</p>
                    </div>
                    <div class="admin-form-grid">
                      <div><label for="backendProductId">Listing ID</label><input id="backendProductId" readonly type="number"></div>
                      <div><label for="backendCategory">Category*</label><select id="backendCategory" required><option value="Baseball">Baseball</option><option value="Basketball">Basketball</option><option value="Football">Football</option><option value="Comics">Comics</option><option value="Collectibles">Collectibles</option><option value="Other">Other</option></select></div>
                      <div class="full"><label for="backendName">Name*</label><input id="backendName" required type="text"></div>
                      <div><label for="backendTeam">Team / Publisher</label><input id="backendTeam" type="text"></div>
                      <div><label for="backendYear">Year</label><input id="backendYear" max="2050" min="1900" type="number"></div>
                      <div><label for="backendCondition">Condition</label><input id="backendCondition" type="text"></div>
                    </div>
                  </div>

                  <div class="admin-form-section">
                    <div class="admin-form-section__header">
                      <h4 class="section-title section-title--small" style="margin-top:0">Pricing and merchandising</h4>
                      <p class="helper-text">Use featured and sort rank to influence homepage placement and browse order.</p>
                    </div>
                    <div class="admin-form-grid">
                      <div><label for="backendPrice">Price</label><input id="backendPrice" min="0" step="0.01" type="number"></div>
                      <div><label for="backendCheckoutPrice">Checkout Price</label><input id="backendCheckoutPrice" min="0" step="0.01" type="number"></div>
                      <div><label for="backendPriceLabel">Price Label</label><input id="backendPriceLabel" type="text"></div>
                      <div><label for="backendQuantityAvailable">Quantity Available</label><input id="backendQuantityAvailable" min="0" step="1" type="number"></div>
                      <div><label for="backendCheckoutEnabled">Checkout Enabled</label><select id="backendCheckoutEnabled"><option value="true">Yes</option><option value="false">No</option></select></div>
                      <div><label for="backendSaleStatus">Sale Status</label><select id="backendSaleStatus"><option value="available">Available</option><option value="inquiry_only">Inquiry Only</option><option value="reserved">Reserved</option><option value="sold">Sold</option><option value="hidden">Hidden</option><option value="archived">Archived</option></select></div>
                      <div><label for="backendSortRank">Sort Rank</label><input id="backendSortRank" min="0" step="1" type="number"></div>
                      <div><label for="backendIsFeatured">Featured</label><select id="backendIsFeatured"><option value="false">No</option><option value="true">Yes</option></select></div>
                    </div>
                  </div>

                  <div class="admin-form-section">
                    <div class="admin-form-section__header">
                      <h4 class="section-title section-title--small" style="margin-top:0">Media and gallery</h4>
                      <p class="helper-text">Upload files into Supabase Storage or paste hosted URLs for the main card image and gallery.</p>
                    </div>
                    <div class="admin-form-grid">
                      <div class="full"><label for="backendImage">Main Image URL</label><input autocomplete="url" id="backendImage" type="url"></div>
                      <div class="full"><label for="backendPhotoHostPageUrl">Photo Host Page URL</label><input autocomplete="url" id="backendPhotoHostPageUrl" type="url"></div>
                    </div>

                    <div class="image-preview" hidden id="backendMainImagePreviewWrap">
                      <img alt="Main image preview" id="backendMainImagePreview" src="assets/placeholder-baseball.svg">
                      <div class="image-preview-copy">
                        <strong id="backendMainImageName">Current main image</strong>
                        <div class="inline-actions compact">
                          <button id="backendUploadMainImage" type="button">Upload Main Photo</button>
                          <button class="button-secondary" id="backendRemoveMainImage" type="button">Remove Main Photo</button>
                        </div>
                      </div>
                    </div>
                    <p class="helper-text admin-side-note">The main image is what shoppers see first in the product grid. Use Set as Main in the gallery to promote any photo.</p>
                    <input accept="image/*" aria-hidden="true" aria-label="Upload backend main photo" class="sr-only" id="backendMainImageFile" tabindex="-1" type="file">

                    <div class="admin-gallery-editor">
                      <div class="admin-gallery-editor__header">
                        <h3 class="section-title section-title--small">Gallery Photos</h3>
                        <p class="helper-text">Add image URLs or upload photos into Supabase Storage. Reorder the visual priority by setting any gallery image as the main photo.</p>
                      </div>
                      <div class="admin-gallery-list" id="backendGalleryList"></div>
                      <div class="admin-gallery-add-row">
                        <label class="sr-only" for="backendGalleryUrl">Gallery image URL</label>
                        <input autocomplete="off" id="backendGalleryUrl" placeholder="Paste a gallery image URL" type="text">
                        <button class="button-secondary" id="backendAddGalleryUrl" type="button">Add URL</button>
                        <button class="button-secondary" id="backendAddGalleryFile" type="button">Upload Photo</button>
                        <input accept="image/*" aria-hidden="true" aria-label="Upload backend gallery photo" class="sr-only" id="backendGalleryFile" tabindex="-1" type="file">
                      </div>
                    </div>
                  </div>

                  <div class="admin-form-section">
                    <div class="admin-form-section__header">
                      <h4 class="section-title section-title--small" style="margin-top:0">Description</h4>
                      <p class="helper-text">Use short, scannable copy that explains the item, grade, set, or notable selling points.</p>
                    </div>
                    <div class="admin-form-grid">
                      <div class="full"><label for="backendDescription">Description</label><textarea id="backendDescription"></textarea></div>
                    </div>
                  </div>

                  <div class="inline-actions compact">
                    <button id="backendSaveListing" type="submit">Save Remote Listing</button>
                    <button class="button-secondary" id="backendClearEditor" type="button">Clear Editor</button>
                    <button class="button-ghost" id="backendDeleteListing" type="button">Delete Remote Listing</button>
                  </div>
                </form>
              </aside>
            </div>
          </div>
        </div>
      </section>
    `;
  }

  function ensureBackendSection() {
    if (document.getElementById('backendAdminSection')) return;

    // Prefer a dedicated mount node in the HTML template so backend UI rendering
    // is not coupled to the exact hero-section structure.
    const mount = document.getElementById('backendAdminMount');
    if (mount) {
      mount.innerHTML = buildBackendSection();
      return;
    }

    // Fall back to inserting after the hero if the mount node is unavailable.
    const heroSection = document.querySelector('main#mainContent > section.page-hero');
    if (!heroSection) return;
    heroSection.insertAdjacentHTML('afterend', buildBackendSection());
  }

  function setBackendStatus(message = '', stateName = 'info') {
    const element = document.getElementById('backendStatus');
    if (!element) return;
    if (!message) {
      element.hidden = true;
      element.textContent = '';
      element.innerHTML = '';
      element.removeAttribute('data-state');
      return;
    }
    element.hidden = false;
    element.setAttribute('data-state', stateName);
    if (typeof message === 'object' && message) {
      const title = message.title
        ? `<strong class="status-message__title">${escapeHtml(message.title)}</strong>`
        : '';
      const body = message.body
        ? `<p class="status-message__body">${escapeHtml(message.body)}</p>`
        : '';
      const items = Array.isArray(message.items) && message.items.length
        ? `
          <div class="status-message__list">
            ${message.items.map((item) => `
              <div class="status-message__item${item.ok ? ' is-success' : ' is-error'}">
                <span class="status-message__check">${item.ok ? 'OK' : 'Check'}</span>
                <div>
                  <strong>${escapeHtml(item.title || '')}</strong>
                  <p>${escapeHtml(item.message || '')}</p>
                  ${buildHelperList(item.details)}
                </div>
              </div>
            `).join('')}
          </div>
        `
        : '';
      const meta = message.meta
        ? `<p class="status-message__meta">${escapeHtml(message.meta)}</p>`
        : '';
      element.innerHTML = `${title}${body}${items}${meta}`;
      return;
    }
    element.textContent = message;
  }

  function updateBackendOverview() {
    const configured = Boolean(backend()?.isConfigured());
    const modeValue = document.getElementById('backendSummaryMode');
    const modeCopy = document.getElementById('backendSummaryModeCopy');
    const sessionValue = document.getElementById('backendSummarySession');
    const sessionCopy = document.getElementById('backendSummarySessionCopy');
    const catalogValue = document.getElementById('backendSummaryCatalog');
    const catalogCopy = document.getElementById('backendSummaryCatalogCopy');

    if (modeValue) modeValue.textContent = configured ? 'Supabase live' : 'Setup required';
    if (modeCopy) {
      modeCopy.textContent = configured
        ? 'Every save and delete updates the live Supabase catalog directly.'
        : 'Configure Supabase before using the admin catalog editor.';
    }

    if (sessionValue) {
      sessionValue.textContent = state.session
        ? 'Signed in'
        : configured
          ? 'Ready to sign in'
          : 'Not configured';
    }
    if (sessionCopy) {
      sessionCopy.textContent = state.session
        ? `Using ${state.session.user?.email || 'the current admin'} for live catalog changes.`
        : configured
          ? 'Auth is configured. Sign in to unlock remote listings, uploads, imports, and deletes.'
          : 'Complete backend-config.js before remote auth can be used.';
    }

    if (catalogValue) {
      catalogValue.textContent = state.session ? String(state.remoteProducts.length) : '--';
    }
    if (catalogCopy) {
      catalogCopy.textContent = state.session
        ? (state.search.trim() || state.remoteCategory !== 'All'
            ? `${formatCountLabel(state.filteredProducts.length, 'listing')} in the current browse view.`
            : 'Live rows currently loaded from Supabase.')
        : 'Remote listings will appear here after a successful sign-in.';
    }
  }

  function syncLocalAdminVisibility() {
    const enabled = Boolean(backend()?.isConfigured());

    document.body.classList.toggle('backend-admin-mode', enabled);
  }

  function syncHeroCopy() {
    const title = document.querySelector('.page-hero .page-title');
    const copy = document.querySelector('.page-hero .page-hero-card > p:last-of-type');
    const enabled = Boolean(backend()?.isConfigured());
    if (title) {
      title.textContent = enabled
        ? 'Admin Dashboard'
        : 'Connect Supabase Admin';
    }
    if (copy) {
      copy.textContent = enabled
        ? 'Manage listings, photos, pricing, product details, and storefront checks from the Supabase-backed workspace below.'
        : 'Configure backend-config.js with your Supabase project details, then sign in below to manage the live storefront remotely.';
    }
  }

  function updateSetupMessage() {
    const message = document.getElementById('backendSetupMessage');
    const badge = document.getElementById('backendSetupBadge');
    const signOut = document.getElementById('backendSignOut');
    const seed = document.getElementById('backendSeedProducts');
    const refresh = document.getElementById('backendRefreshProducts');
    const newButton = document.getElementById('backendNewListing');
    const loginForm = document.getElementById('backendLoginForm');
    const diagnostics = backend()?.getConfigDiagnostics?.();
    if (!message) return;

    if (!backend() || !backend().isConfigured()) {
      if (badge) {
        badge.textContent = 'Setup required';
        badge.setAttribute('data-state', 'error');
      }
      message.textContent = [
        'Remote admin is disabled until the browser connection details are complete.',
        ...(diagnostics?.issues?.length ? diagnostics.issues : [
          'Fill in backend-config.js with your Supabase project URL and browser key.',
          'Set enabled: true after the connection details are ready.'
        ])
      ].join(' ');
      [signOut, seed, refresh, newButton].forEach((button) => { if (button) button.disabled = true; });
      if (loginForm) loginForm.hidden = true;
      state.remoteProducts = [];
      state.filteredProducts = [];
      updateBackendOverview();
      syncLocalAdminVisibility();
      syncHeroCopy();
      return;
    }

    const isSignedIn = Boolean(state.session);
    if (loginForm) loginForm.hidden = isSignedIn;
    if (signOut) signOut.disabled = !isSignedIn;
    [seed, refresh, newButton].forEach((button) => { if (button) button.disabled = !isSignedIn; });
    if (badge) {
      badge.textContent = isSignedIn ? 'Connected' : 'Configured';
      badge.setAttribute('data-state', isSignedIn ? 'success' : 'info');
    }
    message.textContent = isSignedIn
      ? `Connected to Supabase as ${state.session.user?.email || 'signed-in user'}. Saves and deletes update the live Supabase catalog immediately.`
      : 'Project URL and browser key look valid. Sign in below to load live listings, upload photos, import products.json, or run a connection test.';
    updateBackendOverview();
    syncLocalAdminVisibility();
    syncHeroCopy();
  }

  function remoteListingCard(product) {
    const fallback = DJ.fallbackByCategory[product.category] || DJ.fallbackByCategory.Other;
    const isEditing = Number(state.editingId) === Number(product.id);
    const galleryCount = Array.isArray(product.imageGallery) ? product.imageGallery.length : 0;
    const statusLabel = product.isFeatured ? 'Featured' : 'Active';
    const listingContext = [
      product.year || 'Year not listed',
      product.team || 'No team / publisher listed'
    ].filter(Boolean).join(' | ');
    return `
      <article class="admin-listing-row admin-listing-card${isEditing ? ' is-selected' : ''}" data-remote-id="${product.id}" aria-current="${isEditing ? 'true' : 'false'}">
        <div class="admin-listing-cell admin-listing-cell--select">
          <span class="admin-live-dot" aria-label="Live Supabase listing" role="img"></span>
        </div>
        <div class="admin-listing-cell admin-listing-cell--photo">
          <img src="${DJ.escapeHtml(DJ.safeAssetUrl(product.image || fallback))}" data-fallback-src="${DJ.escapeHtml(DJ.safeAssetUrl(fallback))}" alt="${DJ.escapeHtml(product.name)}" loading="lazy" decoding="async">
        </div>
        <div class="admin-listing-cell admin-listing-cell--item">
          <span class="admin-listing-kicker">${DJ.escapeHtml(product.category || 'Other')} #${DJ.escapeHtml(String(product.id || ''))}</span>
          <h3>${DJ.escapeHtml(product.name)}</h3>
          <p>${DJ.escapeHtml(listingContext)}</p>
          <p class="helper-text">${galleryCount} gallery photo${galleryCount === 1 ? '' : 's'}</p>
        </div>
        <div class="admin-listing-cell admin-listing-cell--price" data-label="Price">
          <strong>${DJ.escapeHtml(DJ.displayPrice(product))}</strong>
          <span>Fixed price</span>
        </div>
        <div class="admin-listing-cell admin-listing-cell--status" data-label="Status">
          <strong>${DJ.escapeHtml(statusLabel)}</strong>
          <span>${DJ.escapeHtml(product.condition || 'Condition not listed')}</span>
        </div>
        <div class="admin-listing-cell admin-listing-cell--actions">
          <button type="button" data-remote-action="edit" data-remote-id="${product.id}">Edit</button>
        </div>
      </article>
    `;
  }

  function getSearchMatchedRemoteProducts() {
    const term = state.search.trim().toLowerCase();
    if (!term) return state.remoteProducts;
    return state.remoteProducts.filter((product) => String(product._searchIndex || '').includes(term));
  }

  function getFilteredRemoteProducts(searchMatchedProducts = getSearchMatchedRemoteProducts()) {
    if (!state.remoteCategory || state.remoteCategory === 'All') {
      return searchMatchedProducts;
    }
    return searchMatchedProducts.filter((product) => String(product.category || 'Other') === state.remoteCategory);
  }

  function resetRemoteBrowseState(options = {}) {
    const { preserveSearch = false, rerender = true } = options;
    const searchInput = document.getElementById('backendListingSearch');

    if (!preserveSearch) {
      state.search = '';
      if (searchInput) searchInput.value = '';
    }

    state.remoteCategory = 'All';
    state.remoteVisibleLimit = REMOTE_LIST_RENDER_LIMIT;
    updateSearchShellState('backendListingSearch', 'backendSearchShell');

    if (rerender) {
      renderRemoteListings();
    }
  }

  function renderRemoteFilterSummary(searchMatchedProducts) {
    const summary = document.getElementById('backendListingSummary');
    if (!summary) return;

    if (!state.session) {
      summary.innerHTML = '';
      return;
    }

    const categoryOrder = ['All', 'Baseball', 'Basketball', 'Football', 'Comics', 'Collectibles', 'Other'];
    const counts = new Map(categoryOrder.map((category) => [category, 0]));
    counts.set('All', searchMatchedProducts.length);
    searchMatchedProducts.forEach((product) => {
      const category = String(product.category || 'Other');
      counts.set(category, (counts.get(category) || 0) + 1);
    });

    const summaryBits = [];
    if (state.search.trim()) {
      summaryBits.push(`Search: "${state.search.trim()}"`);
    }
    if (state.remoteCategory !== 'All') {
      summaryBits.push(`Category: ${state.remoteCategory}`);
    }
    const filterNote = summaryBits.length
      ? `${formatCountLabel(state.filteredProducts.length, 'match')} in the current browse view. ${summaryBits.map(escapeHtml).join(' - ')}.`
      : `${formatCountLabel(state.filteredProducts.length, 'remote listing')} ready to edit.`;

    summary.innerHTML = `
      <div class="backend-filter-bar">
        ${categoryOrder
          .filter((category) => category === 'All' || counts.get(category) > 0 || state.remoteCategory === category)
          .map((category) => `
            <button
              type="button"
              class="admin-filter-pill${state.remoteCategory === category ? ' is-active' : ''}"
              data-backend-category="${category}">
              <span>${escapeHtml(category)}</span>
              <strong>${counts.get(category) || 0}</strong>
            </button>
          `).join('')}
      </div>
      <p class="helper-text backend-filter-note">
        ${filterNote}
      </p>
    `;
  }

  /**
   * Render the remote listing manager based on the current auth state and search term.
   */
  function renderRemoteListings() {
    const container = document.getElementById('backendListingsList');
    const count = document.getElementById('backendListingCount');
    if (!container || !count) return;

    const searchMatchedProducts = getSearchMatchedRemoteProducts();
    state.filteredProducts = getFilteredRemoteProducts(searchMatchedProducts);
    renderRemoteFilterSummary(searchMatchedProducts);
    updateSearchShellState('backendListingSearch', 'backendSearchShell');

    const selectedIndex = state.filteredProducts.findIndex((product) => Number(product.id) === Number(state.editingId));
    const effectiveLimit = Math.max(
      state.remoteVisibleLimit,
      selectedIndex >= 0 ? selectedIndex + 1 : 0,
      REMOTE_LIST_RENDER_LIMIT
    );
    const visibleProducts = state.filteredProducts.slice(0, effectiveLimit);
    const isTruncated = state.filteredProducts.length > effectiveLimit;

    updateBackendOverview();
    count.textContent = state.session
      ? `${state.filteredProducts.length} remote listing${state.filteredProducts.length === 1 ? '' : 's'} loaded${isTruncated ? ` | showing ${visibleProducts.length} of ${state.filteredProducts.length}` : ''}.`
      : 'Sign in to load remote listings.';

    if (!state.session) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>Remote listings are locked until you sign in</h3>
          <p>Use the Supabase admin account above to browse live rows, upload photos, or run a connection test against this project.</p>
        </div>
      `;
      return;
    }

    if (!state.filteredProducts.length) {
      container.innerHTML = `
        <div class="empty-state">
          <h3>No remote listings matched</h3>
          <p>Try a broader search, switch back to All categories, or refresh the live catalog.</p>
          <div class="inline-actions compact">
            <button type="button" class="button-secondary" data-remote-empty-action="reset">Clear Filters</button>
            <button type="button" class="button-secondary" data-remote-empty-action="refresh">Refresh Listings</button>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="admin-listing-table-header" aria-hidden="true">
        <span>Live</span>
        <span>Photo</span>
        <span>Listing</span>
        <span>Price</span>
        <span>Status</span>
        <span>Actions</span>
      </div>
      ${visibleProducts.map(remoteListingCard).join('')}
      ${isTruncated ? `
        <div class="inline-actions compact backend-load-more-row">
          <button type="button" class="button-secondary" id="backendLoadMoreListings">Load More Listings</button>
        </div>
      ` : ''}
    `;

    DJ.applyLazyLoading(container);
  }

  function showRemoteMainPreview(imageUrl, category = 'Other', name = '') {
    const wrap = document.getElementById('backendMainImagePreviewWrap');
    const image = document.getElementById('backendMainImagePreview');
    const label = document.getElementById('backendMainImageName');
    if (!wrap || !image || !label) return;
    const fallback = DJ.fallbackByCategory[category] || DJ.fallbackByCategory.Other;
    image.src = DJ.safeAssetUrl(imageUrl || fallback);
    image.setAttribute('data-fallback-src', DJ.safeAssetUrl(fallback));
    image.alt = buildRemoteImageAlt({ name, category, isMain: true });
    wrap.hidden = false;
    label.textContent = imageUrl
      ? (name ? `Main photo ready for ${name}` : 'Main photo ready')
      : 'Using category placeholder';
    DJ.applyLazyLoading(wrap);
  }

  function renderRemoteGallery() {
    const list = document.getElementById('backendGalleryList');
    if (!list) return;
    const currentMain = document.getElementById('backendImage')?.value.trim() || '';
    const productName = getRemoteDraftName();
    const category = getRemoteDraftCategory();

    if (!state.gallery.length) {
      list.innerHTML = `
        <div class="empty-state compact-empty-state">
          <h3>No gallery photos yet</h3>
          <p>Add image URLs or upload photos to build out the product gallery for this listing.</p>
        </div>
      `;
      return;
    }

    list.innerHTML = state.gallery.map((url, index) => `
      <div class="admin-gallery-item${currentMain === url ? ' is-main' : ''}" data-backend-gallery-index="${index}">
        <img src="${DJ.escapeHtml(DJ.safeAssetUrl(url))}" alt="${escapeHtml(buildRemoteImageAlt({ name: productName, category, index }))}">
        <div class="admin-gallery-item__body">
          <div class="admin-gallery-item__copy">
            <strong>Photo ${index + 1}${currentMain === url ? ' - Main photo' : ''}</strong>
            <p class="helper-text">${currentMain === url ? 'Used on the product card and shown first in the gallery.' : 'Available in the gallery draft for this listing.'}</p>
          </div>
          <div class="admin-gallery-item__actions">
            <button type="button" class="button-secondary" data-backend-gallery-action="set-main" data-backend-gallery-index="${index}">Set as Main</button>
            <button type="button" class="button-ghost" data-backend-gallery-action="remove" data-backend-gallery-index="${index}">Remove</button>
          </div>
        </div>
      </div>
    `).join('');

    DJ.applyLazyLoading(list);
  }

  function bindRemoteBrowseInteractions() {
    const summary = document.getElementById('backendListingSummary');
    if (summary && summary.dataset.bound !== 'true') {
      summary.dataset.bound = 'true';
      summary.addEventListener('click', (event) => {
        const button = event.target.closest('[data-backend-category]');
        if (!button) return;
        state.remoteCategory = button.dataset.backendCategory || 'All';
        state.remoteVisibleLimit = REMOTE_LIST_RENDER_LIMIT;
        renderRemoteListings();
      });
    }

    const listings = document.getElementById('backendListingsList');
    if (listings && listings.dataset.bound !== 'true') {
      listings.dataset.bound = 'true';
      // Delegate list actions so rerendering the remote results grid does not
      // create a new click listener for every card, button, or empty state.
      listings.addEventListener('click', (event) => {
        const editButton = event.target.closest('[data-remote-action="edit"]');
        if (editButton) {
          if (!confirmDiscardRemoteChanges()) return;
          populateRemoteForm(Number(editButton.dataset.remoteId));
          return;
        }

        if (event.target.closest('#backendLoadMoreListings')) {
          state.remoteVisibleLimit += REMOTE_LIST_RENDER_LIMIT;
          renderRemoteListings();
          return;
        }

        if (event.target.closest('[data-remote-empty-action="reset"]')) {
          resetRemoteBrowseState();
          return;
        }

        if (event.target.closest('[data-remote-empty-action="refresh"]')) {
          refreshRemoteProducts(true);
        }
      });
    }

    const galleryList = document.getElementById('backendGalleryList');
    if (galleryList && galleryList.dataset.bound !== 'true') {
      galleryList.dataset.bound = 'true';
      galleryList.addEventListener('click', (event) => {
        const actionButton = event.target.closest('[data-backend-gallery-action]');
        if (!actionButton) return;

        const index = Number(actionButton.dataset.backendGalleryIndex);
        const selectedUrl = state.gallery[index] || '';
        const imageInput = document.getElementById('backendImage');
        const categorySelect = document.getElementById('backendCategory');
        if (!Number.isFinite(index)) return;

        if (actionButton.dataset.backendGalleryAction === 'remove') {
          state.gallery.splice(index, 1);

          if (imageInput && selectedUrl && imageInput.value.trim() === selectedUrl) {
            imageInput.value = state.gallery[0] || '';
            showRemoteMainPreview(imageInput.value, categorySelect?.value || 'Other', getRemoteDraftName());
          }

          renderRemoteGallery();
          markRemoteEditorDirty();
          return;
        }

        if (actionButton.dataset.backendGalleryAction === 'set-main' && imageInput) {
          imageInput.value = selectedUrl;
          if (selectedUrl) {
            state.gallery = normalizeGallery([selectedUrl, ...state.gallery.filter((item) => item !== selectedUrl)]);
            renderRemoteGallery();
          }
          showRemoteMainPreview(imageInput.value, categorySelect?.value || 'Other', getRemoteDraftName());
          markRemoteEditorDirty();
        }
      });
    }
  }

  function setRemoteEditorDirty(isDirty, message = 'Unsaved changes') {
    state.editorDirty = Boolean(isDirty);
    const badge = document.getElementById('backendDirtyBadge');
    const form = document.getElementById('backendListingForm');

    if (badge) {
      badge.hidden = !state.editorDirty;
      badge.textContent = message;
    }

    if (form) {
      form.classList.toggle('is-dirty', state.editorDirty);
    }
  }

  function markRemoteEditorDirty(message = 'Unsaved changes') {
    if (!Number.isFinite(Number(state.editingId))) return;
    setRemoteEditorDirty(true, message);
  }

  function confirmDiscardRemoteChanges() {
    return !state.editorDirty || window.confirm('Discard unsaved remote listing changes?');
  }

  function highlightRemoteListingSelection() {
    const list = document.getElementById('backendListingsList');
    if (!list) return false;

    let selectedCardIsVisible = false;
    list.querySelectorAll('.admin-listing-card[data-remote-id]').forEach((card) => {
      const isSelected = Number(card.dataset.remoteId) === Number(state.editingId);
      card.classList.toggle('is-selected', isSelected);
      card.setAttribute('aria-current', isSelected ? 'true' : 'false');
      selectedCardIsVisible = selectedCardIsVisible || isSelected;
    });

    return selectedCardIsVisible;
  }

  function updateRemoteEditorContext(options = {}) {
    const eyebrow = document.getElementById('backendEditorEyebrow');
    const copy = document.getElementById('backendEditorContext');
    if (!eyebrow || !copy) return;

    if (options.mode === 'new') {
      eyebrow.textContent = 'New remote draft';
      copy.textContent = `Draft #${options.id || state.editingId || ''} is ready. Save when the listing details, pricing, and media are complete.`;
      return;
    }

    if (options.product) {
      const product = options.product;
      const galleryCount = Array.isArray(product.imageGallery) ? product.imageGallery.length : 0;
      eyebrow.textContent = `${product.category || 'Other'} remote listing`;
      copy.textContent = `Editing #${product.id} with ${galleryCount} gallery photo${galleryCount === 1 ? '' : 's'}. Changes save directly to Supabase.`;
      return;
    }

    eyebrow.textContent = 'Remote editor';
    copy.textContent = 'Save directly to your Supabase database and storage bucket.';
  }

  function clearRemoteForm(options = {}) {
    const { rerender = false } = options;
    state.editingId = null;
    state.gallery = [];
    const form = document.getElementById('backendListingForm');
    const empty = document.getElementById('backendEditorEmpty');
    const preview = document.getElementById('backendMainImagePreviewWrap');
    if (form) {
      form.reset();
      form.hidden = true;
    }
    if (empty) empty.hidden = false;
    if (preview) preview.hidden = true;
    const gallery = document.getElementById('backendGalleryList');
    if (gallery) gallery.innerHTML = '';
    const mainFile = document.getElementById('backendMainImageFile');
    const galleryFile = document.getElementById('backendGalleryFile');
    const galleryUrl = document.getElementById('backendGalleryUrl');
    if (mainFile) mainFile.value = '';
    if (galleryFile) galleryFile.value = '';
    if (galleryUrl) galleryUrl.value = '';
    updateRemoteEditorContext();
    setRemoteEditorDirty(false);
    if (rerender) {
      renderRemoteListings();
      return;
    }
    highlightRemoteListingSelection();
  }

  function populateRemoteForm(productId) {
    const product = state.remoteProducts.find((item) => Number(item.id) === Number(productId));
    if (!product) return;

    state.editingId = Number(product.id);
    state.gallery = normalizeGallery(product.imageGallery);

    document.getElementById('backendProductId').value = String(product.id);
    document.getElementById('backendName').value = product.name || '';
    document.getElementById('backendCategory').value = product.category || 'Other';
    document.getElementById('backendTeam').value = product.team || '';
    document.getElementById('backendYear').value = product.year || '';
    document.getElementById('backendCondition').value = product.condition || '';
    document.getElementById('backendPrice').value = product.price ?? '';
    document.getElementById('backendCheckoutPrice').value = product.checkoutPrice ?? '';
    document.getElementById('backendPriceLabel').value = product.priceLabel || '';
    document.getElementById('backendQuantityAvailable').value = Number.isFinite(Number(product.quantityAvailable ?? product.copyCount)) ? Number(product.quantityAvailable ?? product.copyCount) : 1;
    document.getElementById('backendCheckoutEnabled').value = product.checkoutEnabled === false ? 'false' : 'true';
    document.getElementById('backendSaleStatus').value = product.saleStatus || 'available';
    document.getElementById('backendSortRank').value = Number.isFinite(Number(product.sortRank)) ? product.sortRank : 0;
    document.getElementById('backendIsFeatured').value = product.isFeatured ? 'true' : 'false';
    document.getElementById('backendImage').value = product.image || '';
    document.getElementById('backendPhotoHostPageUrl').value = product.photoHostPageUrl || '';
    document.getElementById('backendDescription').value = product.description || '';

    const form = document.getElementById('backendListingForm');
    const empty = document.getElementById('backendEditorEmpty');
    if (form) form.hidden = false;
    if (empty) empty.hidden = true;

    showRemoteMainPreview(product.image || '', product.category || 'Other', product.name || '');
    renderRemoteGallery();
    updateRemoteEditorContext({ product });
    setRemoteEditorDirty(false);
    if (!highlightRemoteListingSelection()) {
      renderRemoteListings();
    }
    document.getElementById('backendName')?.focus();
  }

  function getNextRemoteId() {
    const usedIds = new Set(
      state.remoteProducts
        .map((item) => Number(item.id))
        .filter(Number.isFinite)
    );
    const randomSuffix = () => {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        const buffer = new Uint16Array(1);
        window.crypto.getRandomValues(buffer);
        return buffer[0] % 1000;
      }

      return Math.floor(Math.random() * 1000);
    };

    let candidate = Date.now() * 1000 + randomSuffix();
    while (usedIds.has(candidate)) {
      candidate += 1;
    }

    return candidate;
  }

  function createNewRemoteListing() {
    state.editingId = getNextRemoteId();
    state.gallery = [];
    const form = document.getElementById('backendListingForm');
    const empty = document.getElementById('backendEditorEmpty');
    if (form) {
      form.reset();
      form.hidden = false;
    }
    if (empty) empty.hidden = true;
    document.getElementById('backendProductId').value = String(state.editingId);
    document.getElementById('backendCategory').value = 'Baseball';
    document.getElementById('backendSortRank').value = '0';
    document.getElementById('backendIsFeatured').value = 'false';
    document.getElementById('backendQuantityAvailable').value = '1';
    document.getElementById('backendCheckoutEnabled').value = 'true';
    document.getElementById('backendSaleStatus').value = 'available';
    showRemoteMainPreview('', 'Baseball', '');
    renderRemoteGallery();
    updateRemoteEditorContext({ mode: 'new', id: state.editingId });
    setRemoteEditorDirty(true, 'New draft not saved');
    highlightRemoteListingSelection();
    document.getElementById('backendName')?.focus();
  }

  // ---------------------------------------------------------------------------
  // Remote editor form helpers
  // ---------------------------------------------------------------------------

  function readRemoteForm() {
    // Preserve any fields not currently exposed in the form by merging over the
    // existing remote row first, then layering the editable fields on top.
    const productId = Number(document.getElementById('backendProductId').value);
    const existingProduct = state.remoteProducts.find((item) => Number(item.id) === productId) || {};
    const yearValue = document.getElementById('backendYear').value;
    const priceValue = document.getElementById('backendPrice').value;
    const checkoutPriceValue = document.getElementById('backendCheckoutPrice').value;
    const quantityAvailableValue = document.getElementById('backendQuantityAvailable').value;
    const sortRankValue = document.getElementById('backendSortRank').value;
    const rawPhotoHostPageUrl = document.getElementById('backendPhotoHostPageUrl').value.trim();

    return {
      ...existingProduct,
      id: productId,
      name: document.getElementById('backendName').value.trim(),
      category: document.getElementById('backendCategory').value,
      team: document.getElementById('backendTeam').value.trim(),
      year: yearValue === '' ? null : Number(yearValue),
      condition: document.getElementById('backendCondition').value.trim(),
      price: priceValue === '' ? null : Number(priceValue),
      checkoutPrice: checkoutPriceValue === '' ? null : Number(checkoutPriceValue),
      priceLabel: document.getElementById('backendPriceLabel').value.trim(),
      quantityAvailable: quantityAvailableValue === '' ? 1 : Math.max(0, Number(quantityAvailableValue)),
      copyCount: quantityAvailableValue === '' ? 1 : Math.max(0, Number(quantityAvailableValue)),
      checkoutEnabled: document.getElementById('backendCheckoutEnabled').value === 'true',
      saleStatus: document.getElementById('backendSaleStatus').value || 'available',
      image: document.getElementById('backendImage').value.trim(),
      imageGallery: normalizeGallery(state.gallery),
      description: document.getElementById('backendDescription').value.trim(),
      photoHostPageUrl: rawPhotoHostPageUrl,
      sortRank: sortRankValue === '' ? 0 : Number(sortRankValue),
      isFeatured: document.getElementById('backendIsFeatured').value === 'true',
      isDeleted: false
    };
  }

  /**
   * Pull the latest remote products into memory. Routine save/delete actions update
   * this local state directly; this full refresh is reserved for sign-in, seed, and
   * explicit refresh so editing does not repeatedly download the whole catalog.
   */
  async function refreshRemoteProducts(force = false) {
    if (!backend() || !backend().isConfigured() || !state.session) {
      state.remoteProducts = [];
      renderRemoteListings();
      emitRemoteAdminCatalogProducts();
      return;
    }

    setBackendStatus('Loading remote products...', 'info');
    try {
      state.remoteProducts = sortRemoteProductsInPlace(
        (await backend().listProducts({ source: 'products.json', force })).map(prepareRemoteProduct)
      );
      state.remoteVisibleLimit = REMOTE_LIST_RENDER_LIMIT;
      renderRemoteListings();
      emitRemoteAdminCatalogProducts();

      if (Number.isFinite(state.editingId)) {
        const stillExists = state.remoteProducts.some((product) => Number(product.id) === Number(state.editingId));
        if (stillExists) {
          populateRemoteForm(state.editingId);
        } else {
          clearRemoteForm();
        }
      }

      setBackendStatus(`Loaded ${state.remoteProducts.length} remote listing${state.remoteProducts.length === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      console.error(error);
      state.remoteProducts = [];
      renderRemoteListings();
      emitRemoteAdminCatalogProducts();
      setBackendStatus(error.message || 'Unable to load remote listings.', 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Auth and CRUD event handlers
  // ---------------------------------------------------------------------------

  async function handleBackendSignIn(event) {
    event.preventDefault();
    if (state.isBusy) return;
    if (!backend() || !backend().isConfigured()) {
      const diagnostics = backend()?.getConfigDiagnostics?.();
      setBackendStatus({
        title: 'Backend mode is not configured yet.',
        body: 'Update backend-config.js with a valid Supabase project URL and browser key before signing in.',
        items: Array.isArray(diagnostics?.issues)
          ? diagnostics.issues.map((item) => ({
              ok: false,
              title: 'Configuration',
              message: item
            }))
          : []
      }, 'error');
      return;
    }

    const email = document.getElementById('backendEmail').value.trim();
    const password = document.getElementById('backendPassword').value;
    if (!email || !password) {
      setBackendStatus('Enter your admin email and password.', 'error');
      return;
    }

    setBusy(true);
    setBackendStatus('Signing in...', 'info');
    try {
      await backend().signIn(email, password);
      state.session = await backend().getSession();
      updateSetupMessage();
      await refreshRemoteProducts(true);
      setBackendStatus(`Signed in as ${state.session?.user?.email || email}.`, 'success');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Sign-in failed.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loadSeedSource(source) {
    const preloaded = typeof DJ.getPreloadedProductsForSource === 'function'
      ? DJ.getPreloadedProductsForSource(source)
      : null;

    let products = preloaded;
    // Local file previews still need a browser-safe fallback path, so use the
    // preloaded bundle when available and only fetch the JSON file when needed.
    if (!products && window.location.protocol === 'file:' && typeof DJ.loadPreloadedProductsForSource === 'function') {
      products = await DJ.loadPreloadedProductsForSource(source).catch(() => null);
    }
    if (!products) {
      const versionedSource = typeof DJ.versionedProductAsset === 'function'
        ? DJ.versionedProductAsset(source)
        : source;
      try {
        const response = await fetch(versionedSource, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Failed to fetch ${source} (${response.status})`);
        products = await response.json();
      } catch (error) {
        products = typeof DJ.loadPreloadedProductsForSource === 'function'
          ? await DJ.loadPreloadedProductsForSource(source).catch(() => null)
          : null;
        if (!products) throw error;
      }
    }

    return Array.isArray(products) ? products : [];
  }

  async function handleSeedProducts() {
    if (state.isBusy) return;
    if (!state.session) {
      setBackendStatus('Sign in before importing your current products.json file.', 'error');
      return;
    }

    if (!window.confirm('Import the current products.json catalog into Supabase? Existing rows with the same id will be updated.')) {
      return;
    }

    setBusy(true);
    setBackendStatus('Importing current catalog into Supabase...', 'info');
    try {
      const staticProducts = await loadSeedSource('products.json');
      const featuredProducts = await loadSeedSource('products-featured.json');
      const total = await backend().seedProducts(staticProducts, {
        chunkSize: 200,
        featuredProducts
      });
      await refreshRemoteProducts(true);
      setBackendStatus(`Imported ${total} product${total === 1 ? '' : 's'} into Supabase, including ${featuredProducts.length} featured listing${featuredProducts.length === 1 ? '' : 's'}.`, 'success');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Unable to import products into Supabase.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleConnectionTest() {
    if (state.isBusy) return;
    setBusy(true);
    setBackendStatus('Running Supabase connection test...', 'info');

    try {
      const result = await backend().testConnection();
      setBackendStatus(buildConnectionStatus(result), result.ok ? 'success' : 'error');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Unable to run the connection test.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveRemoteListing(event) {
    event.preventDefault();
    if (state.isBusy) return;
    if (!state.session) {
      setBackendStatus('Sign in before saving remote listings.', 'error');
      return;
    }

    const product = readRemoteForm();
    if (!product.name) {
      setBackendStatus('Name is required.', 'error');
      document.getElementById('backendName')?.focus();
      return;
    }
    if (!product.category) {
      setBackendStatus('Category is required.', 'error');
      document.getElementById('backendCategory')?.focus();
      return;
    }
    if (!Number.isFinite(Number(product.id))) {
      setBackendStatus('A valid numeric id is required.', 'error');
      return;
    }
    if (product.year !== null && !Number.isFinite(product.year)) {
      setBackendStatus('Year must be a valid number.', 'error');
      return;
    }
    if (product.price !== null && !Number.isFinite(product.price)) {
      setBackendStatus('Price must be a valid number.', 'error');
      return;
    }
    if (!Number.isFinite(Number(product.sortRank))) {
      setBackendStatus('Sort rank must be a valid number.', 'error');
      return;
    }
    if (product.image && !DJ.isLikelyImageReference(product.image)) {
      setBackendStatus('Main image should be an uploaded image URL, an assets path, or a direct image link.', 'error');
      document.getElementById('backendImage')?.focus();
      return;
    }
    if (product.photoHostPageUrl && !DJ.isValidHttpUrl(product.photoHostPageUrl)) {
      setBackendStatus('Photo host page URL must start with http:// or https://.', 'error');
      document.getElementById('backendPhotoHostPageUrl')?.focus();
      return;
    }
    product.photoHostPageUrl = product.photoHostPageUrl ? DJ.safeExternalUrl(product.photoHostPageUrl) : '';

    setBusy(true);
    setBackendStatus('Saving remote listing...', 'info');
    try {
      const saved = await backend().upsertProduct(product);
      const syncedProduct = syncRemoteProductInState(saved);
      renderRemoteListings();
      populateRemoteForm(syncedProduct.id);
      setRemoteEditorDirty(false);
      setBackendStatus(`Saved remote listing #${saved.id}.`, 'success');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Unable to save remote listing.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteRemoteListing() {
    if (state.isBusy) return;
    if (!state.session) {
      setBackendStatus('Sign in before deleting remote listings.', 'error');
      return;
    }

    const productId = Number(document.getElementById('backendProductId').value);
    if (!Number.isFinite(productId)) {
      setBackendStatus('Select a remote listing first.', 'error');
      return;
    }

    if (!window.confirm('Permanently delete this listing from Supabase? This cannot be undone.')) return;

    setBusy(true);
    setBackendStatus('Deleting remote listing...', 'info');
    try {
      await backend().deleteProduct(productId);
      state.remoteProducts = state.remoteProducts.filter((product) => Number(product.id) !== productId);
      state.remoteVisibleLimit = REMOTE_LIST_RENDER_LIMIT;
      clearRemoteForm();
      renderRemoteListings();
      setBackendStatus(`Deleted remote listing #${productId}.`, 'success');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Unable to delete remote listing.', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function uploadMainImage(file) {
    if (state.isBusy) return;
    if (!state.session) {
      setBackendStatus('Sign in before uploading photos.', 'error');
      return;
    }
    try {
      setBusy(true);
      setBackendStatus('Uploading main photo...', 'info');
      const result = await backend().uploadImage(file, { productId: document.getElementById('backendProductId').value || 'draft' });
      const imageInput = document.getElementById('backendImage');
      imageInput.value = result.publicUrl;
      showRemoteMainPreview(result.publicUrl, getRemoteDraftCategory(), getRemoteDraftName());
      markRemoteEditorDirty();
      setBackendStatus('Main photo uploaded to Supabase Storage.', 'success');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Unable to upload main photo.', 'error');
    } finally {
      setBusy(false);
    }
  }


  function addGalleryUrlFromInput() {
    const input = document.getElementById('backendGalleryUrl');
    const value = input?.value.trim();
    if (!value) return false;
    if (!DJ.isLikelyImageReference(value)) {
      setBackendStatus('Gallery image URLs should point to an image file, uploaded asset, or direct image address.', 'error');
      input?.focus();
      return false;
    }

    state.gallery = normalizeGallery([...state.gallery, value]);
    if (input) input.value = '';
    renderRemoteGallery();
    markRemoteEditorDirty();
    setBackendStatus('Gallery image URL added to the draft. Save to apply the change.', 'info');
    return true;
  }

  async function uploadGalleryImage(file) {
    if (state.isBusy) return;
    if (!state.session) {
      setBackendStatus('Sign in before uploading photos.', 'error');
      return;
    }
    try {
      setBusy(true);
      setBackendStatus('Uploading gallery photo...', 'info');
      const result = await backend().uploadImage(file, { productId: document.getElementById('backendProductId').value || 'draft' });
      state.gallery = normalizeGallery([...state.gallery, result.publicUrl]);
      renderRemoteGallery();
      markRemoteEditorDirty();
      setBackendStatus('Gallery photo uploaded to Supabase Storage.', 'success');
    } catch (error) {
      console.error(error);
      setBackendStatus(error.message || 'Unable to upload gallery photo.', 'error');
    } finally {
      setBusy(false);
    }
  }

  function refreshRemoteDraftMediaPreview() {
    const imageInput = document.getElementById('backendImage');
    showRemoteMainPreview(imageInput?.value.trim() || '', getRemoteDraftCategory(), getRemoteDraftName());
    renderRemoteGallery();
  }

  // Name/category/image URL edits only change preview labels and selected state,
  // so debounce the gallery repaint while the admin is typing quickly.
  const debouncedRemoteDraftPreview = debounce(refreshRemoteDraftMediaPreview, 90);

  async function initBackendAdmin() {
    if (document.body.dataset.page !== 'admin') return;
    ensureBackendSection();
    bindRemoteBrowseInteractions();
    updateSetupMessage();
    clearRemoteForm();
    renderRemoteListings();

    const backendApi = backend();
    if (backendApi && backendApi.isConfigured()) {
      try {
        await backendApi.prepare();
        state.session = await backendApi.getSession();
      } catch (error) {
        console.error(error);
        setBackendStatus(error.message || 'Unable to initialize the backend client.', 'error');
      }
      updateSetupMessage();
      if (state.session) {
        await refreshRemoteProducts();
      }
      state.authSubscription = backendApi.onAuthStateChange(async (event, session) => {
        state.session = session || null;
        updateSetupMessage();
        if (state.session) {
          await refreshRemoteProducts(true);
          return;
        }
        state.remoteProducts = [];
        resetRemoteBrowseState();
        clearRemoteForm();
      });
    }

    const onClick = (id, handler) => {
      document.getElementById(id)?.addEventListener('click', handler);
    };

    document.getElementById('backendLoginForm')?.addEventListener('submit', handleBackendSignIn);
    onClick('backendRefreshProducts', () => {
      if (!confirmDiscardRemoteChanges()) return;
      refreshRemoteProducts(true);
    });
    onClick('backendSeedProducts', handleSeedProducts);
    onClick('backendConnectionTest', handleConnectionTest);
    onClick('backendSignOut', async () => {
      if (state.isBusy) return;
      if (!confirmDiscardRemoteChanges()) return;
      try {
        setBusy(true);
        await backend()?.signOut();
        state.session = null;
        state.remoteProducts = [];
        resetRemoteBrowseState({ rerender: false });
        updateSetupMessage();
        renderRemoteListings();
        clearRemoteForm();
        setBackendStatus('Signed out.', 'success');
      } catch (error) {
        console.error(error);
        setBackendStatus(error.message || 'Unable to sign out.', 'error');
      } finally {
        setBusy(false);
      }
    });
    const handleRemoteSearch = debounce((value) => {
      state.search = String(value || '');
      state.remoteVisibleLimit = REMOTE_LIST_RENDER_LIMIT;
      renderRemoteListings();
    }, 120);

    document.getElementById('backendListingSearch')?.addEventListener('input', (event) => {
      handleRemoteSearch(event.target?.value || '');
    });
    onClick('backendClearSearch', () => {
      const input = document.getElementById('backendListingSearch');
      if (!input || !input.value) return;
      resetRemoteBrowseState();
      setBackendStatus('Remote listing search cleared.', 'info');
    });
    document.getElementById('backendListingSearch')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      const input = event.currentTarget;
      if (!input.value) return;
      resetRemoteBrowseState();
      setBackendStatus('Remote listing search cleared.', 'info');
    });
    onClick('backendNewListing', () => {
      if (!confirmDiscardRemoteChanges()) return;
      createNewRemoteListing();
    });
    const backendListingForm = document.getElementById('backendListingForm');
    backendListingForm?.addEventListener('submit', handleSaveRemoteListing);
    backendListingForm?.addEventListener('input', (event) => {
      if (event.target?.id === 'backendProductId') return;
      markRemoteEditorDirty();
    });
    backendListingForm?.addEventListener('change', (event) => {
      if (event.target?.id === 'backendProductId') return;
      markRemoteEditorDirty();
    });
    onClick('backendDeleteListing', handleDeleteRemoteListing);
    onClick('backendClearEditor', () => {
      if (!confirmDiscardRemoteChanges()) return;
      clearRemoteForm();
    });
    onClick('backendUploadMainImage', () => document.getElementById('backendMainImageFile')?.click());
    document.getElementById('backendMainImageFile')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await uploadMainImage(file);
      event.target.value = '';
    });
    onClick('backendRemoveMainImage', () => {
      document.getElementById('backendImage').value = '';
      showRemoteMainPreview('', getRemoteDraftCategory(), getRemoteDraftName());
      renderRemoteGallery();
      markRemoteEditorDirty();
      setBackendStatus('Main photo removed from the draft. Save to apply the change.', 'info');
    });
    document.getElementById('backendImage')?.addEventListener('input', () => {
      debouncedRemoteDraftPreview();
    });
    document.getElementById('backendName')?.addEventListener('input', () => {
      debouncedRemoteDraftPreview();
    });
    document.getElementById('backendCategory')?.addEventListener('change', () => {
      debouncedRemoteDraftPreview();
    });
    onClick('backendAddGalleryUrl', () => {
      addGalleryUrlFromInput();
    });

    document.getElementById('backendGalleryUrl')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      addGalleryUrlFromInput();
    });
    onClick('backendAddGalleryFile', () => document.getElementById('backendGalleryFile')?.click());
    document.getElementById('backendGalleryFile')?.addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (file) await uploadGalleryImage(file);
      event.target.value = '';
    });

    window.addEventListener('beforeunload', (event) => {
      if (!state.editorDirty) return;
      event.preventDefault();
      event.returnValue = '';
    });

    window.addEventListener('pagehide', () => {
      if (state.authSubscription && typeof state.authSubscription.unsubscribe === 'function') {
        state.authSubscription.unsubscribe();
        state.authSubscription = null;
      }
    }, { once: true });

    syncLocalAdminVisibility();
    syncHeroCopy();
  }

  // Wait for the admin page shell and shared DJ helpers before wiring the backend UI.
  document.addEventListener('DOMContentLoaded', initBackendAdmin);
})();

