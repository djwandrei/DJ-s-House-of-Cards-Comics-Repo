/**
 * Customer account page helpers.
 * -----------------------------------------------------------------------------
 * This page is intentionally browser-safe: Supabase Auth handles sign-in, while
 * profile preferences are stored locally until a server-side customer profile
 * table/function is added. Stripe order history must come from a trusted backend
 * endpoint, so the order panel gracefully explains that state instead of guessing.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const PROFILE_KEY = 'djCustomerProfileV1';
  const ORDER_HISTORY_KEY = 'djCustomerOrderHistoryV1';
  const state = {
    session: null,
    isReady: false
  };

  const fields = [
    'fullName',
    'phone',
    'preferredContact',
    'shippingName',
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'postalCode',
    'notes'
  ];

  const $ = (id) => document.getElementById(id);

  function setStatus(message = '', tone = 'info') {
    const status = $('accountStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function isBackendReady() {
    return Boolean(DJ.remoteCatalog?.isConfigured?.());
  }

  function getEmail() {
    return String(state.session?.user?.email || '').trim();
  }

  function readLocalProfile() {
    try {
      const parsed = JSON.parse(localStorage.getItem(PROFILE_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
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

  function readLocalOrders() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ORDER_HISTORY_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function loadProfileForm() {
    const profile = readLocalProfile();
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      if (input) input.value = profile[field] || '';
    });
  }

  function saveProfileForm(event) {
    event?.preventDefault();
    const profile = readLocalProfile();
    fields.forEach((field) => {
      const input = $(`account_${field}`);
      if (input) profile[field] = String(input.value || '').trim();
    });
    profile.email = getEmail() || profile.email || '';
    profile.updatedAt = new Date().toISOString();
    const saved = writeLocalProfile(profile);
    setStatus(
      saved ? 'Account details saved on this device.' : 'This browser blocked local profile storage.',
      saved ? 'success' : 'error'
    );
  }

  function renderAuthState() {
    const signedInPanel = $('accountSignedIn');
    const signedOutPanel = $('accountSignedOut');
    const signInForm = $('accountSignInForm');
    const emailTarget = $('accountEmailDisplay');
    const email = getEmail();

    if (signedInPanel) signedInPanel.hidden = !email;
    if (signedOutPanel) signedOutPanel.hidden = Boolean(email);
    if (signInForm) signInForm.hidden = Boolean(email);
    if (emailTarget) emailTarget.textContent = email || 'Not signed in';
  }

  function renderWishlistSummary() {
    const countTarget = $('accountWishlistCount');
    const wishlistIds = typeof DJ.getWishlist === 'function' ? DJ.getWishlist() : [];
    if (countTarget) {
      countTarget.textContent = String(wishlistIds.length);
    }
  }

  function renderOrderHistory() {
    const container = $('accountOrders');
    if (!container) return;

    const orders = readLocalOrders();
    if (!orders.length) {
      container.innerHTML = `
        <div class="account-empty-state">
          <strong>No online orders are stored here yet.</strong>
          <p>Once Stripe checkout is connected to a secure order-history function, completed purchases can appear in this panel. Until then, save favorite items to the wishlist or use the contact page for order questions.</p>
          <div class="account-empty-actions">
            <a class="button-secondary" href="wishlist.html">Open Wishlist</a>
            <a class="button-secondary" href="contact.html">Ask About An Order</a>
          </div>
        </div>
      `;
      return;
    }

    container.innerHTML = orders.map((order) => `
      <article class="account-order-card">
        <strong>${DJ.escapeHtml(order.title || 'Order')}</strong>
        <span>${DJ.escapeHtml(order.status || 'Pending')}</span>
        <small>${DJ.escapeHtml(order.date || '')}</small>
      </article>
    `).join('');
  }

  async function hydrateSession() {
    if (!isBackendReady()) {
      state.session = null;
      state.isReady = true;
      renderAuthState();
      setStatus('Customer sign-in needs the Supabase backend to be enabled. You can still save account details on this device.', 'info');
      return;
    }

    try {
      state.session = await DJ.remoteCatalog.getSession();
      setStatus(state.session?.user ? 'Signed in and ready.' : 'Sign in to connect checkout and account tools.', 'info');
    } catch (error) {
      state.session = null;
      setStatus(error.message || 'Could not load account session.', 'error');
    } finally {
      state.isReady = true;
      renderAuthState();
    }
  }

  async function signIn(event) {
    event.preventDefault();
    const email = String($('accountEmail')?.value || '').trim();
    const password = String($('accountPassword')?.value || '');
    if (!email || !password) return;
    if (!isBackendReady()) {
      setStatus('Customer sign-in is not available until the backend is configured.', 'error');
      return;
    }

    setStatus('Signing in...', 'info');
    try {
      await DJ.remoteCatalog.signIn(email, password);
      state.session = await DJ.remoteCatalog.getSession();
      renderAuthState();
      setStatus('Signed in successfully.', 'success');
    } catch (error) {
      setStatus(error.message || 'Sign-in failed.', 'error');
    }
  }

  async function createAccount() {
    const email = String($('accountEmail')?.value || '').trim();
    const password = String($('accountPassword')?.value || '');
    if (!email || !password) return;
    if (!isBackendReady()) {
      setStatus('Customer account creation is not available until the backend is configured.', 'error');
      return;
    }

    setStatus('Creating account...', 'info');
    try {
      await DJ.remoteCatalog.signUp(email, password);
      state.session = await DJ.remoteCatalog.getSession();
      renderAuthState();
      setStatus('Account created. If email confirmation is required, check your inbox before checkout.', 'success');
    } catch (error) {
      setStatus(error.message || 'Account creation failed.', 'error');
    }
  }

  async function resetPassword() {
    const email = String($('accountEmail')?.value || getEmail() || '').trim();
    if (!email || !isBackendReady()) {
      setStatus('Enter your email first, then request a reset link.', 'error');
      return;
    }

    setStatus('Sending password reset email...', 'info');
    try {
      await DJ.remoteCatalog.resetPassword(email);
      setStatus('Password reset email sent.', 'success');
    } catch (error) {
      setStatus(error.message || 'Password reset failed.', 'error');
    }
  }

  async function signOut() {
    if (!isBackendReady()) return;
    setStatus('Signing out...', 'info');
    try {
      await DJ.remoteCatalog.signOut();
      state.session = null;
      renderAuthState();
      setStatus('Signed out.', 'success');
    } catch (error) {
      setStatus(error.message || 'Could not sign out.', 'error');
    }
  }

  function bindEvents() {
    $('accountSignInForm')?.addEventListener('submit', signIn);
    $('accountCreateButton')?.addEventListener('click', createAccount);
    $('accountResetButton')?.addEventListener('click', resetPassword);
    $('accountSignOutButton')?.addEventListener('click', signOut);
    $('accountProfileForm')?.addEventListener('submit', saveProfileForm);
    window.addEventListener('dj:wishlistchange', renderWishlistSummary);
  }

  async function init() {
    bindEvents();
    loadProfileForm();
    renderWishlistSummary();
    renderOrderHistory();
    await hydrateSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
