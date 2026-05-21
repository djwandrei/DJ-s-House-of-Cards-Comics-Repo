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
  const MAX_PROFILE_FIELD_LENGTH = 240;
  const MAX_PROFILE_NOTES_LENGTH = 1200;
  const state = {
    session: null,
    isReady: false,
    authSubscription: null
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

  function normalizeProfileValue(field, value) {
    const maxLength = field === 'notes' ? MAX_PROFILE_NOTES_LENGTH : MAX_PROFILE_FIELD_LENGTH;
    return String(value || '').trim().slice(0, maxLength);
  }

  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text) element.textContent = options.text;
    if (options.href) element.setAttribute('href', options.href);
    return element;
  }

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
      if (input) profile[field] = normalizeProfileValue(field, input.value);
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
    container.replaceChildren();

    const orders = readLocalOrders();
    if (!orders.length) {
      const emptyState = createElement('div', { className: 'account-empty-state' });
      emptyState.append(
        createElement('strong', { text: 'No online orders are stored here yet.' }),
        createElement('p', { text: 'Once Stripe checkout is connected to a secure order-history function, completed purchases can appear in this panel. Until then, save favorite items to the wishlist or use the contact page for order questions.' })
      );

      const actions = createElement('div', { className: 'account-empty-actions' });
      actions.append(
        createElement('a', { className: 'button-secondary', href: 'wishlist.html', text: 'Open Wishlist' }),
        createElement('a', { className: 'button-secondary', href: 'contact.html', text: 'Ask About An Order' })
      );
      emptyState.appendChild(actions);
      container.appendChild(emptyState);
      return;
    }

    const fragment = document.createDocumentFragment();
    orders.forEach((order) => {
      const card = createElement('article', { className: 'account-order-card' });
      card.append(
        createElement('strong', { text: order.title || 'Order' }),
        createElement('span', { text: order.status || 'Pending' }),
        createElement('small', { text: order.date || '' })
      );
      fragment.appendChild(card);
    });
    container.appendChild(fragment);
  }

  function bindAuthStateSync() {
    if (state.authSubscription || !DJ.remoteCatalog?.onAuthStateChange) {
      return;
    }

    state.authSubscription = DJ.remoteCatalog.onAuthStateChange((_event, session) => {
      state.session = session || null;
      state.isReady = true;
      renderAuthState();
    });
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
      bindAuthStateSync();
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
      bindAuthStateSync();
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
      bindAuthStateSync();
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
