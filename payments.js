/**
 * Customer accounts and Stripe Checkout bridge.
 * -----------------------------------------------------------------------------
 * This file only uses browser-safe Supabase auth and Edge Function calls. Stripe
 * secret keys must stay in Supabase function secrets, never in site JavaScript.
 * Deploy cache version: 20260507b.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const config = window.DJ_BACKEND_CONFIG || {};
  const state = {
    session: null,
    pendingCheckoutProduct: null,
    authReady: false,
    checkoutInFlight: false,
    authHydrationPromise: null,
    authListenerBound: false
  };

  function isBackendReady() {
    return Boolean(DJ.remoteCatalog?.isConfigured?.());
  }

  function isCheckoutEnabled() {
    return Boolean(config.stripeCheckoutEnabled && config.stripeCheckoutFunction);
  }

  function getPriceLabel(product = {}) {
    return String(product.displayPrice || product.priceLabel || DJ.displayPrice?.(product) || '').trim();
  }

  function isDirectCheckoutEligible(product = {}) {
    const price = Number(product.price);
    const displayPrice = getPriceLabel(product).toLowerCase();
    if (!Number.isFinite(price) || price <= 0) return false;
    if (/contact|ask|inquir|availability/.test(displayPrice)) return false;
    if (/\$\s*[\d,.]+\s*(?:-|\u2013|\u2014|\bto\b)\s*\$?\s*[\d,.]+/.test(displayPrice)) return false;
    return true;
  }

  function ensureAuthModal() {
    let modal = document.getElementById('customerAuthModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'customerAuthModal';
    modal.className = 'customer-auth-modal';
    modal.setAttribute('aria-hidden', 'true');
    modal.innerHTML = `
      <div class="customer-auth-backdrop" data-customer-auth-close></div>
      <section class="customer-auth-panel" role="dialog" aria-modal="true" aria-labelledby="customerAuthTitle">
        <button type="button" class="customer-auth-close" aria-label="Close account panel" data-customer-auth-close>&times;</button>
        <p class="customer-auth-eyebrow">Customer Account</p>
        <h2 id="customerAuthTitle">Sign in to buy or save your place</h2>
        <p class="customer-auth-copy">Create a customer account with email and password so checkout can connect your order to the right listing.</p>
        <form class="customer-auth-form" id="customerAuthForm">
          <label>
            Email
            <input id="customerAuthEmail" type="email" autocomplete="email" required>
          </label>
          <label>
            Password
            <input id="customerAuthPassword" type="password" autocomplete="current-password" minlength="8" required>
          </label>
          <div class="customer-auth-actions">
            <button type="submit" class="button" data-auth-action="signin">Sign In</button>
            <button type="button" class="button-secondary" data-auth-action="signup">Create Account</button>
          </div>
          <button type="button" class="customer-auth-reset" data-auth-action="reset">Send password reset email</button>
          <p class="customer-auth-status" id="customerAuthStatus" aria-live="polite"></p>
        </form>
      </section>
    `;
    document.body.appendChild(modal);

    modal.querySelectorAll('[data-customer-auth-close]').forEach((button) => {
      button.addEventListener('click', closeAuthModal);
    });

    modal.querySelector('#customerAuthForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      await signInFromModal();
    });

    modal.querySelector('[data-auth-action="signup"]')?.addEventListener('click', signUpFromModal);
    modal.querySelector('[data-auth-action="reset"]')?.addEventListener('click', resetPasswordFromModal);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal.classList.contains('active')) {
        closeAuthModal();
      }
    });
    return modal;
  }

  function setAuthStatus(message = '', tone = 'info') {
    const status = document.getElementById('customerAuthStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function openAuthModal(options = {}) {
    const modal = ensureAuthModal();
    if (options.product) {
      state.pendingCheckoutProduct = options.product;
    }
    setAuthStatus(options.message || '', 'info');
    modal.classList.add('active');
    modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('customer-auth-open');
    window.setTimeout(() => modal.querySelector('#customerAuthEmail')?.focus(), 40);
  }

  function closeAuthModal() {
    const modal = document.getElementById('customerAuthModal');
    if (!modal) return;
    modal.classList.remove('active');
    modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('customer-auth-open');
    state.pendingCheckoutProduct = null;
  }

  function getAuthFields() {
    const email = String(document.getElementById('customerAuthEmail')?.value || '').trim();
    const password = String(document.getElementById('customerAuthPassword')?.value || '');
    return { email, password };
  }

  async function signInFromModal() {
    const { email, password } = getAuthFields();
    if (!email || !password) return;
    setAuthStatus('Signing you in...', 'info');
    try {
      await DJ.remoteCatalog.signIn(email, password);
      state.session = await DJ.remoteCatalog.getSession();
      state.authReady = true;
      bindAuthStateSync();
      setAuthStatus('Signed in. Opening checkout...', 'success');
      updateAccountControls();
      const product = state.pendingCheckoutProduct;
      state.pendingCheckoutProduct = null;
      closeAuthModal();
      if (product) await startCheckout(product);
    } catch (error) {
      setAuthStatus(error.message || 'Sign-in failed.', 'error');
    }
  }

  async function signUpFromModal() {
    const { email, password } = getAuthFields();
    if (!email || !password) return;
    setAuthStatus('Creating your account...', 'info');
    try {
      await DJ.remoteCatalog.signUp(email, password);
      state.session = await DJ.remoteCatalog.getSession();
      state.authReady = true;
      bindAuthStateSync();
      updateAccountControls();
      setAuthStatus('Account created. If Supabase requires confirmation, check your email before checkout.', 'success');
      if (state.session && state.pendingCheckoutProduct) {
        const product = state.pendingCheckoutProduct;
        state.pendingCheckoutProduct = null;
        closeAuthModal();
        await startCheckout(product);
      }
    } catch (error) {
      setAuthStatus(error.message || 'Account creation failed.', 'error');
    }
  }

  async function resetPasswordFromModal() {
    const { email } = getAuthFields();
    if (!email) {
      setAuthStatus('Enter your email first, then request a reset link.', 'error');
      return;
    }
    setAuthStatus('Sending reset email...', 'info');
    try {
      await DJ.remoteCatalog.resetPassword(email);
      setAuthStatus('Password reset email sent.', 'success');
    } catch (error) {
      setAuthStatus(error.message || 'Password reset failed.', 'error');
    }
  }

  function injectAccountControl() {
    const navList = document.querySelector('.site-nav .primary-nav__list');
    if (!navList || navList.querySelector('[data-customer-account-button]')) return;

    const item = document.createElement('li');
    item.className = 'primary-nav__item customer-account-item';
    item.innerHTML = `
      <button type="button" class="primary-nav__link customer-account-button" data-customer-account-button>
        Account
      </button>
    `;
    navList.appendChild(item);
    item.querySelector('[data-customer-account-button]')?.addEventListener('click', handleAccountButtonClick);
  }

  function bindAuthStateSync() {
    if (state.authListenerBound || !DJ.remoteCatalog?.onAuthStateChange) return;
    state.authListenerBound = true;
    DJ.remoteCatalog.onAuthStateChange((_event, session) => {
      state.session = session || null;
      state.authReady = true;
      updateAccountControls();
    });
  }

  /**
   * Hydrate Supabase auth lazily so static pages do not spend their critical
   * startup time creating a backend client or doing auth network work. Checkout
   * and the Account button both call this before they need the session.
   */
  async function ensureAuthSession() {
    if (!isBackendReady()) {
      state.session = null;
      state.authReady = false;
      updateAccountControls();
      return null;
    }

    if (state.authHydrationPromise) {
      return state.authHydrationPromise;
    }

    state.authHydrationPromise = (async () => {
      try {
        state.session = await DJ.remoteCatalog.getSession();
        state.authReady = true;
        bindAuthStateSync();
      } catch (error) {
        state.session = null;
        state.authReady = false;
      }
      updateAccountControls();
      return state.session;
    })().finally(() => {
      state.authHydrationPromise = null;
    });

    return state.authHydrationPromise;
  }

  async function handleAccountButtonClick() {
    if (!isBackendReady()) {
      openAuthModal({ message: 'Customer accounts need the Supabase backend to be configured.' });
      return;
    }

    await ensureAuthSession();

    if (state.session?.user) {
      try {
        await DJ.remoteCatalog.signOut();
        state.session = null;
        updateAccountControls();
      } catch (error) {
        openAuthModal({ message: error.message || 'Could not sign out.' });
      }
      return;
    }

    openAuthModal();
  }

  function updateAccountControls() {
    const email = state.session?.user?.email || '';
    document.querySelectorAll('[data-customer-account-button]').forEach((button) => {
      button.textContent = email ? 'Sign Out' : 'Account';
      button.setAttribute('aria-label', email ? `Signed in as ${email}. Sign out.` : 'Sign in or create a customer account');
      button.classList.toggle('is-signed-in', Boolean(email));
    });
  }

  function showCheckoutMessage(message, tone = 'info') {
    const target = document.getElementById('modalCheckoutStatus') || document.getElementById('customerAuthStatus');
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function setCheckoutButtonsBusy(isBusy) {
    document.querySelectorAll('[data-checkout-button], #modalBuy').forEach((button) => {
      button.disabled = Boolean(isBusy);
      button.classList.toggle('is-busy', Boolean(isBusy));
    });
  }

  async function startCheckout(product = {}, options = {}) {
    if (state.checkoutInFlight) return;

    if (!isCheckoutEnabled() || !isBackendReady() || !DJ.remoteCatalog?.invokeFunction) {
      options.fallback?.();
      return;
    }

    if (!isDirectCheckoutEligible(product)) {
      showCheckoutMessage('This item needs confirmation before checkout, so the inquiry email is opening instead.', 'info');
      options.fallback?.();
      return;
    }

    try {
      state.session = await ensureAuthSession();
    } catch (error) {
      options.fallback?.();
      return;
    }

    if (!state.session?.user) {
      openAuthModal({
        product,
        message: 'Sign in or create a customer account before checkout.'
      });
      return;
    }

    state.checkoutInFlight = true;
    setCheckoutButtonsBusy(true);
    showCheckoutMessage('Creating secure Stripe checkout...', 'info');

    try {
      const payload = {
        productId: Number(product.id),
        returnPath: `${window.location.pathname}${window.location.search}`
      };
      const data = await DJ.remoteCatalog.invokeFunction(config.stripeCheckoutFunction, payload);
      if (!data?.url) {
        throw new Error('Stripe checkout did not return a checkout URL.');
      }
      window.location.assign(data.url);
    } catch (error) {
      state.checkoutInFlight = false;
      setCheckoutButtonsBusy(false);
      showCheckoutMessage(error.message || 'Could not start checkout.', 'error');
    }
  }

  async function init() {
    injectAccountControl();
    updateAccountControls();

    if (isBackendReady()) {
      const hydrateAfterPaint = () => ensureAuthSession().catch(() => {});
      if (typeof DJ.scheduleIdle === 'function') {
        DJ.scheduleIdle(hydrateAfterPaint, 2400);
      } else {
        window.setTimeout(hydrateAfterPaint, 1200);
      }
    }

    window.addEventListener('pageshow', () => {
      state.checkoutInFlight = false;
      setCheckoutButtonsBusy(false);
    });
  }

  DJ.payments = {
    init,
    openAuthModal,
    closeAuthModal,
    startCheckout,
    isDirectCheckoutEligible
  };

  document.addEventListener('DOMContentLoaded', init);
})();
