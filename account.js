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
  const profileCompletionFields = [
    'fullName',
    'phone',
    'preferredContact',
    'shippingName',
    'addressLine1',
    'city',
    'state',
    'postalCode',
    'notes'
  ];
  const profileFieldLabels = {
    fullName: 'Full name',
    phone: 'Phone',
    preferredContact: 'Preferred contact',
    shippingName: 'Shipping name',
    addressLine1: 'Address line 1',
    addressLine2: 'Address line 2',
    city: 'City',
    state: 'State',
    postalCode: 'ZIP / postal code',
    notes: 'Collecting notes'
  };
  const contactEmail = 'contact@djshouseofcards-comics.com';

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
    profile.email = getEmail() || storedProfile.email || '';
    profile.updatedAt = storedProfile.updatedAt || '';
    return profile;
  }

  function hasProfileDetails(profile) {
    return fields.some((field) => Boolean(normalizeProfileValue(field, profile?.[field])));
  }

  function getProfileCompletion(profile) {
    const completed = profileCompletionFields.filter((field) => (
      Boolean(normalizeProfileValue(field, profile?.[field]))
    )).length;
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

  function buildPreferencesEmailUrl(profile, wishlistCount) {
    const lines = [
      'Hi DJ,',
      '',
      'I wanted to send over my saved buyer preferences.',
      '',
      `Wishlist items: ${wishlistCount}`
    ];
    const email = getEmail() || profile.email || '';
    if (email) {
      lines.push(`Account email: ${email}`);
    }
    fields.forEach((field) => {
      const value = normalizeProfileValue(field, profile[field]);
      if (value) {
        lines.push(`${profileFieldLabels[field]}: ${value}`);
      }
    });
    lines.push('', 'Thanks!');

    return `mailto:${contactEmail}?subject=${encodeURIComponent('Saved buyer preferences')}&body=${encodeURIComponent(lines.join('\n'))}`;
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
    renderAccountSummary();
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
    renderAccountSummary();
  }

  function getWishlistIds() {
    return typeof DJ.getWishlist === 'function' ? DJ.getWishlist() : [];
  }

  function renderAccountSummary() {
    const countTarget = $('accountWishlistCount');
    const completionLabel = $('accountProfileCompletionLabel');
    const completionBar = $('accountProfileCompletionBar');
    const savedAt = $('accountProfileSavedAt');
    const emailLink = $('accountEmailPreferences');
    const clearButton = $('accountClearProfile');
    const wishlistIds = getWishlistIds();
    const currentProfile = readProfileForm();
    const storedProfile = readLocalProfile();
    const completion = getProfileCompletion(currentProfile);
    const hasDetails = hasProfileDetails(currentProfile);
    const hasSavedDetails = hasProfileDetails(storedProfile);
    const hasUnsavedChanges = hasUnsavedProfileChanges(currentProfile, storedProfile);

    if (countTarget) {
      countTarget.textContent = String(wishlistIds.length);
    }
    if (completionLabel) {
      completionLabel.textContent = `${completion.percent}%`;
      completionLabel.setAttribute('aria-label', `${completion.completed} of ${completion.total} profile details filled`);
    }
    if (completionBar) {
      completionBar.style.width = `${completion.percent}%`;
    }
    if (savedAt) {
      savedAt.textContent = hasUnsavedChanges && hasDetails
        ? 'Unsaved changes in the form.'
        : formatSavedAt(storedProfile.updatedAt);
    }
    if (emailLink) {
      emailLink.href = buildPreferencesEmailUrl(currentProfile, wishlistIds.length);
      emailLink.textContent = hasDetails || wishlistIds.length ? 'Email Saved Preferences' : 'Email DJ';
    }
    if (clearButton) {
      clearButton.disabled = !hasSavedDetails;
    }
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
      removed ? 'Saved buyer details cleared from this device.' : 'This browser blocked clearing local profile storage.',
      removed ? 'success' : 'error'
    );
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
    $('accountClearProfile')?.addEventListener('click', clearLocalProfile);
    const profileForm = $('accountProfileForm');
    profileForm?.addEventListener('submit', saveProfileForm);
    profileForm?.addEventListener('input', renderAccountSummary);
    profileForm?.addEventListener('change', renderAccountSummary);
    window.addEventListener('dj:wishlistchange', renderAccountSummary);
  }

  async function init() {
    bindEvents();
    loadProfileForm();
    renderAccountSummary();
    renderOrderHistory();
    await hydrateSession();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
