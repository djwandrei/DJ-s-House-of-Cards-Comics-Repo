/**
 * Customer accounts and Stripe Checkout bridge.
 * -----------------------------------------------------------------------------
 * This file only uses browser-safe Supabase auth and Edge Function calls. Stripe
 * secret keys must stay in Supabase function secrets, never in site JavaScript.
 * Deploy cache version: 20260525a.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const config = window.DJ_BACKEND_CONFIG || {};
  const AUTH_SESSION_CHECK_TIMEOUT_MS = 6500;
  const state = {
    session: null,
    pendingCheckoutProduct: null,
    pendingCheckoutOptions: null,
    authReady: false,
    checkoutInFlight: false,
    authHydrationPromise: null,
    authListenerBound: false,
    lastAuthFocusedElement: null
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

  function timeoutAfter(milliseconds, message) {
    return new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error(message)), milliseconds);
    });
  }

  /**
   * Auth now hydrates on demand. Checkout calls ensureAuthSession() before it
   * creates a Stripe session, and the dedicated account page manages its own
   * status. That keeps product-heavy catalog pages from doing background auth
   * network work when shoppers are only browsing.
   */
  function shouldHydrateAuthAtStartup() {
    return Boolean(document.querySelector('[data-customer-auth-autoload]'));
  }

  function setAuthModalOpenState(modal, isOpen) {
    if (!modal) return;
    modal.hidden = !isOpen;
    modal.classList.toggle('active', Boolean(isOpen));
    modal.setAttribute('aria-hidden', String(!isOpen));
    if ('inert' in modal) {
      modal.inert = !isOpen;
    }
  }

  function ensureAuthModal() {
    let modal = document.getElementById('customerAuthModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'customerAuthModal';
    modal.className = 'customer-auth-modal';
    setAuthModalOpenState(modal, false);
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
      if (!modal.classList.contains('active')) {
        return;
      }

      if (event.key === 'Escape') {
        closeAuthModal();
        return;
      }

      if (event.key === 'Tab') {
        trapAuthModalFocus(event, modal);
      }
    });
    return modal;
  }

  function getFocusableAuthElements(modal) {
    return [...modal.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((element) => element instanceof HTMLElement && element.offsetParent !== null);
  }

  function trapAuthModalFocus(event, modal) {
    const focusableElements = getFocusableAuthElements(modal);
    if (!focusableElements.length) return;

    const firstFocusable = focusableElements[0];
    const lastFocusable = focusableElements[focusableElements.length - 1];

    if (!modal.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? lastFocusable : firstFocusable).focus();
    } else if (event.shiftKey && document.activeElement === firstFocusable) {
      event.preventDefault();
      lastFocusable.focus();
    } else if (!event.shiftKey && document.activeElement === lastFocusable) {
      event.preventDefault();
      firstFocusable.focus();
    }
  }

  function focusAuthModal(modal) {
    const focusTarget = modal.querySelector('#customerAuthEmail') || getFocusableAuthElements(modal)[0];
    if (!focusTarget) return;

    const focusWhenOpen = () => {
      if (!modal.classList.contains('active')) return;
      focusTarget.focus({ preventScroll: true });
      if (!modal.contains(document.activeElement)) {
        getFocusableAuthElements(modal)[0]?.focus({ preventScroll: true });
      }
    };

    focusWhenOpen();
    window.requestAnimationFrame(focusWhenOpen);
    window.setTimeout(focusWhenOpen, 90);
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
      state.pendingCheckoutOptions = options.checkoutOptions || null;
    }
    state.lastAuthFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setAuthStatus(options.message || '', 'info');
    setAuthModalOpenState(modal, true);
    document.body.classList.add('customer-auth-open');
    focusAuthModal(modal);
  }

  function closeAuthModal() {
    const modal = document.getElementById('customerAuthModal');
    if (!modal) return;
    setAuthModalOpenState(modal, false);
    document.body.classList.remove('customer-auth-open');
    state.pendingCheckoutProduct = null;
    state.pendingCheckoutOptions = null;
    if (
      state.lastAuthFocusedElement
      && state.lastAuthFocusedElement.isConnected !== false
      && typeof state.lastAuthFocusedElement.focus === 'function'
    ) {
      state.lastAuthFocusedElement.focus();
    }
    state.lastAuthFocusedElement = null;
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
      const checkoutOptions = state.pendingCheckoutOptions || {};
      state.pendingCheckoutProduct = null;
      state.pendingCheckoutOptions = null;
      closeAuthModal();
      if (product) await startCheckout(product, checkoutOptions);
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
        const checkoutOptions = state.pendingCheckoutOptions || {};
        state.pendingCheckoutProduct = null;
        state.pendingCheckoutOptions = null;
        closeAuthModal();
        await startCheckout(product, checkoutOptions);
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
      <a class="primary-nav__link customer-account-button" href="account.html" data-customer-account-button>
        Account
      </a>
    `;
    navList.appendChild(item);
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

  function continueCheckoutIfExistingSession(product, options = {}) {
    Promise.race([
      ensureAuthSession(),
      timeoutAfter(AUTH_SESSION_CHECK_TIMEOUT_MS, 'Customer account check timed out.')
    ])
      .then((session) => {
        const pendingProductId = Number(state.pendingCheckoutProduct?.id);
        if (!session?.user || pendingProductId !== Number(product.id)) return;
        const checkoutOptions = state.pendingCheckoutOptions || options;
        state.pendingCheckoutProduct = null;
        state.pendingCheckoutOptions = null;
        closeAuthModal();
        startCheckout(product, checkoutOptions);
      })
      .catch(() => {
        setAuthStatus('Sign in or create an account to continue checkout.', 'info');
      });
  }

  function updateAccountControls() {
    const email = state.session?.user?.email || '';
    document.querySelectorAll('[data-customer-account-button]').forEach((button) => {
      button.textContent = 'Account';
      button.setAttribute('aria-label', email ? `Open customer account for ${email}` : 'Open customer account sign-in and order history');
      button.classList.toggle('is-signed-in', Boolean(email));
    });
  }

  function showCheckoutMessage(message, tone = 'info') {
    const target = document.getElementById('modalCheckoutStatus') || document.getElementById('customerAuthStatus');
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function shouldOpenInquiryFallback(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return [
      'edge function is not deployed',
      'not deployed to this supabase project',
      'requested function was not found',
      'secure checkout is not fully configured',
      'shipping is not configured',
      'checkout could not be started',
      'stripe checkout did not return a checkout url',
      'could not reach supabase',
      'failed to fetch',
      'this listing needs confirmation before checkout'
    ].some((phrase) => message.includes(phrase));
  }

  function openInquiryFallback(options = {}, message = 'Secure checkout is unavailable right now, so the inquiry email is opening instead.') {
    if (typeof options.fallback !== 'function') return false;
    showCheckoutMessage(message, 'info');
    options.fallback();
    return true;
  }

  function setCheckoutButtonsBusy(isBusy) {
    document.querySelectorAll('[data-checkout-button], #modalBuy').forEach((button) => {
      button.disabled = Boolean(isBusy);
      button.setAttribute('aria-busy', String(Boolean(isBusy)));
      button.classList.toggle('is-busy', Boolean(isBusy));
    });
  }

  async function startCheckout(product = {}, options = {}) {
    if (state.checkoutInFlight) return;

    if (!isCheckoutEnabled() || !isBackendReady() || !DJ.remoteCatalog?.invokeFunction) {
      openInquiryFallback(options);
      return;
    }

    if (!isDirectCheckoutEligible(product)) {
      openInquiryFallback(options, 'This item needs confirmation before checkout, so the inquiry email is opening instead.');
      return;
    }

    if (!state.authReady) {
      openAuthModal({
        product,
        checkoutOptions: options,
        message: 'Checking for an existing customer session. You can sign in or create an account to continue checkout.'
      });
      continueCheckoutIfExistingSession(product, options);
      return;
    }

    if (!state.session?.user) {
      openAuthModal({
        product,
        checkoutOptions: options,
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
      const message = error.message || 'Could not start checkout.';
      if (shouldOpenInquiryFallback(error) && openInquiryFallback(options)) {
        return;
      }
      showCheckoutMessage(message, 'error');
    }
  }

  async function init() {
    injectAccountControl();
    updateAccountControls();

    if (isBackendReady() && shouldHydrateAuthAtStartup()) {
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
