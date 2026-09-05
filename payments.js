/**
 * Customer accounts and Stripe Checkout bridge.
 * -----------------------------------------------------------------------------
 * This file only uses browser-safe Supabase auth and Edge Function calls. Stripe
 * secret keys must stay in Supabase function secrets, never in site JavaScript.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const config = window.DJ_BACKEND_CONFIG || {};
  const AUTH_SESSION_CHECK_TIMEOUT_MS = 6500;
  const PENDING_CHECKOUT_KEY = 'djPendingCheckout';
  const PENDING_CHECKOUT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const state = {
    session: null,
    pendingCheckoutRequest: null,
    authReady: false,
    checkoutInFlight: false,
    authHydrationPromise: null,
    authListenerBound: false,
    lastAuthFocusedElement: null,
    activeCheckoutIntentId: ''
  };

  function normalizeCheckoutItems(items = []) {
    const normalized = new Map();
    (Array.isArray(items) ? items : []).forEach((item) => {
      const product = item?.product || item;
      const productId = DJ.normalizeProductId(item?.productId ?? product?.id);
      if (!productId) return;

      const quantity = DJ.normalizeCartQuantity(item?.quantity);
      normalized.set(productId, {
        productId,
        quantity: (normalized.get(productId)?.quantity || 0) + quantity,
        product: product?.id ? product : null
      });
    });
    return [...normalized.values()];
  }

  function createCheckoutIntentId() {
    const randomId = typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return `checkout-${randomId}`;
  }

  function isCheckoutIntentActive(intentId) {
    return Boolean(
      intentId
      && state.activeCheckoutIntentId === intentId
      && state.pendingCheckoutRequest?.intentId === intentId
    );
  }

  function invalidateCheckoutIntent() {
    state.activeCheckoutIntentId = '';
    persistPendingCheckout(null);
  }

  function persistPendingCheckout(request = null) {
    state.pendingCheckoutRequest = request;
    try {
      if (!request) {
        sessionStorage.removeItem(PENDING_CHECKOUT_KEY);
        return;
      }
      sessionStorage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify({
        items: request.items.map(({ productId, quantity }) => ({ productId, quantity })),
        returnPath: request.returnPath,
        intentId: request.intentId,
        createdAt: Date.now()
      }));
    } catch {
      // Checkout can still continue in memory when sessionStorage is unavailable.
    }
  }

  function restorePendingCheckout() {
    if (state.pendingCheckoutRequest) {
      if (!state.activeCheckoutIntentId && state.pendingCheckoutRequest.intentId) {
        state.activeCheckoutIntentId = state.pendingCheckoutRequest.intentId;
      }
      return state.pendingCheckoutRequest;
    }
    try {
      const stored = JSON.parse(sessionStorage.getItem(PENDING_CHECKOUT_KEY) || 'null');
      if (!stored || Date.now() - Number(stored.createdAt || 0) > PENDING_CHECKOUT_MAX_AGE_MS) {
        sessionStorage.removeItem(PENDING_CHECKOUT_KEY);
        return null;
      }
      const items = normalizeCheckoutItems(stored.items);
      if (!items.length) return null;
      const intentId = typeof stored.intentId === 'string' && stored.intentId.startsWith('checkout-')
        ? stored.intentId
        : createCheckoutIntentId();
      state.pendingCheckoutRequest = {
        items,
        returnPath: stored.returnPath || '/account.html',
        options: {},
        intentId
      };
      state.activeCheckoutIntentId = intentId;
      return state.pendingCheckoutRequest;
    } catch {
      return null;
    }
  }

  function isBackendReady() {
    return DJ.remoteCatalog.isConfigured();
  }

  function isCheckoutEnabled() {
    return Boolean(config.stripeCheckoutEnabled && config.stripeCheckoutFunction);
  }

  function withTimeout(promise, milliseconds, message) {
    let timeoutId = 0;
    const timeout = new Promise((_, reject) => {
      timeoutId = window.setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
      window.clearTimeout(timeoutId);
    });
  }

  async function syncCustomerAccount(session) {
    if (!session?.user) return;
    await DJ.syncWishlistWithAccount(session);
  }

  function syncCustomerAccountInBackground(session) {
    if (!session?.user) return;
    Promise.resolve()
      .then(() => syncCustomerAccount(session))
      .catch((error) => {
        console.warn('Wishlist could not be synced to the customer account.', error);
      });
  }

  function emitAuthChange(event, session) {
    window.dispatchEvent(new CustomEvent('dj:authchange', {
      detail: { event, session: session || null }
    }));
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
        <h2 id="customerAuthTitle">Sign in, create an account, or check out as a guest</h2>
        <p class="customer-auth-copy">Accounts keep order history together. Guest checkout uses a secure, rate-limited inventory hold.</p>
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
          ${config.stripeGuestCheckoutEnabled === true ? '<button type="button" class="customer-auth-guest" data-auth-action="guest">Continue as Guest</button>' : ''}
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
      modal.querySelector('#customerAuthPassword')?.setAttribute('autocomplete', 'current-password');
      await signInFromModal();
    });

    modal.querySelector('[data-auth-action="signup"]')?.addEventListener('click', () => {
      modal.querySelector('#customerAuthPassword')?.setAttribute('autocomplete', 'new-password');
      signUpFromModal();
    });
    modal.querySelector('[data-auth-action="reset"]')?.addEventListener('click', resetPasswordFromModal);
    modal.querySelector('[data-auth-action="guest"]')?.addEventListener('click', continueAsGuestFromModal);
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

  function isAuthModalOpen() {
    return Boolean(document.getElementById('customerAuthModal')?.classList.contains('active'));
  }

  function openAuthModal(options = {}) {
    const modal = ensureAuthModal();
    let checkoutIntentId = '';
    if (options.items?.length) {
      checkoutIntentId = createCheckoutIntentId();
      state.activeCheckoutIntentId = checkoutIntentId;
      persistPendingCheckout({
        items: normalizeCheckoutItems(options.items),
        returnPath: options.returnPath || `${window.location.pathname}${window.location.search}`,
        options: options.checkoutOptions || {},
        intentId: checkoutIntentId
      });
    }
    state.lastAuthFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    setAuthStatus(options.message || '', 'info');
    setAuthModalOpenState(modal, true);
    document.body.classList.add('customer-auth-open');
    focusAuthModal(modal);
    return checkoutIntentId;
  }

  function closeAuthModal(options = {}) {
    const { cancelCheckout = true, restoreFocus = true } = options;
    const modal = document.getElementById('customerAuthModal');
    if (cancelCheckout && state.activeCheckoutIntentId) {
      invalidateCheckoutIntent();
    }
    if (!modal) return;
    setAuthModalOpenState(modal, false);
    document.body.classList.remove('customer-auth-open');
    if (
      restoreFocus
      && state.lastAuthFocusedElement
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

  async function continueAsGuestFromModal() {
    const { email } = getAuthFields();
    if (!EMAIL_PATTERN.test(email)) {
      setAuthStatus('Enter a valid email address to continue as a guest.', 'error');
      document.getElementById('customerAuthEmail')?.focus();
      return;
    }
    const pending = state.pendingCheckoutRequest || restorePendingCheckout();
    const intentId = pending?.intentId || '';
    if (!pending?.items?.length || !isCheckoutIntentActive(intentId)) {
      setAuthStatus('Your checkout request expired. Please try again from the listing.', 'error');
      return;
    }
    setAuthStatus('Opening secure guest checkout...', 'info');
    closeAuthModal({ cancelCheckout: false, restoreFocus: false });
    await startCheckoutItems(pending.items, {
      ...(pending.options || {}),
      guestEmail: email,
      guestCheckout: true
    }, pending.returnPath, intentId);
  }

  async function resumePendingCheckoutAfterAuthentication(requestedIntentId, {
    requireSession = false,
    closeWhenIdle = false,
    canceledMessage = ''
  } = {}) {
    const pending = state.pendingCheckoutRequest || restorePendingCheckout();
    if (requestedIntentId && !isCheckoutIntentActive(requestedIntentId)) {
      showCheckoutMessage(canceledMessage, 'info');
      return true;
    }

    const canResume = Boolean(
      pending?.items?.length
      && (!requestedIntentId || pending.intentId === requestedIntentId)
      && (!requireSession || state.session)
    );
    if (canResume) {
      closeAuthModal({ cancelCheckout: false, restoreFocus: false });
      await startCheckoutItems(pending.items, pending.options || {}, pending.returnPath, pending.intentId || '');
      return true;
    }

    if (closeWhenIdle) closeAuthModal({ cancelCheckout: false });
    return false;
  }

  async function signInFromModal() {
    const { email, password } = getAuthFields();
    if (!email || !password) return;
    const requestedIntentId = (state.pendingCheckoutRequest || restorePendingCheckout())?.intentId || '';
    setAuthStatus('Signing you in...', 'info');
    try {
      await DJ.remoteCatalog.signIn(email, password);
      state.session = await DJ.remoteCatalog.getSession();
      state.authReady = true;
      bindAuthStateSync();
      emitAuthChange('SIGNED_IN', state.session);
      setAuthStatus('Signed in. Opening checkout...', 'success');
      updateAccountControls();
      await resumePendingCheckoutAfterAuthentication(requestedIntentId, {
        closeWhenIdle: true,
        canceledMessage: 'You signed in, but the checkout request was canceled.'
      });
    } catch (error) {
      const message = error.message || 'Sign-in failed.';
      setAuthStatus(message, 'error');
      if (!isAuthModalOpen()) showCheckoutMessage(message, 'error');
    }
  }

  async function signUpFromModal() {
    const { email, password } = getAuthFields();
    if (!email || !password) return;
    const requestedIntentId = (state.pendingCheckoutRequest || restorePendingCheckout())?.intentId || '';
    setAuthStatus('Creating your account...', 'info');
    try {
      await DJ.remoteCatalog.signUp(email, password, { resumeCheckout: Boolean(state.pendingCheckoutRequest) });
      state.session = await DJ.remoteCatalog.getSession();
      state.authReady = true;
      bindAuthStateSync();
      emitAuthChange('SIGNED_IN', state.session);
      updateAccountControls();
      setAuthStatus('Account created. If Supabase requires confirmation, check your email before checkout.', 'success');
      await resumePendingCheckoutAfterAuthentication(requestedIntentId, {
        requireSession: true,
        canceledMessage: 'Your account was created, but the checkout request was canceled.'
      });
    } catch (error) {
      const message = error.message || 'Account creation failed.';
      setAuthStatus(message, 'error');
      if (!isAuthModalOpen()) showCheckoutMessage(message, 'error');
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
    if (!navList) return;

    const accountLinks = [...navList.querySelectorAll('a[href="account.html"]')];
    accountLinks.slice(1).forEach((link) => {
      link.closest('.primary-nav__item')?.remove();
    });

    if (navList.querySelector('[data-customer-account-button]')) return;

    const existingAccountLink = accountLinks[0];
    if (existingAccountLink) {
      existingAccountLink.classList.add('customer-account-button');
      existingAccountLink.setAttribute('data-customer-account-button', '');
      return;
    }

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
    if (state.authListenerBound) return;
    state.authListenerBound = true;
    DJ.remoteCatalog.onAuthStateChange((event, session) => {
      state.session = session || null;
      state.authReady = true;
      updateAccountControls();
      emitAuthChange(event, state.session);
      if (event === 'SIGNED_OUT') {
        DJ.clearAccountWishlistCache();
        return;
      }
      syncCustomerAccountInBackground(state.session);
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
        // Wishlist reconciliation is optional account enrichment. It must not
        // delay checkout or turn a valid Supabase session into a signed-out one.
        syncCustomerAccountInBackground(state.session);
        emitAuthChange('INITIAL_SESSION', state.session);
      } catch {
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

  function continueCheckoutIfExistingSession(options = {}, returnPath = '', intentId = '') {
    withTimeout(
      ensureAuthSession(),
      AUTH_SESSION_CHECK_TIMEOUT_MS,
      'Customer account check timed out.'
    )
      .then((session) => {
        const pending = state.pendingCheckoutRequest || restorePendingCheckout();
        if (
          !session?.user
          || !pending?.items?.length
          || !isCheckoutIntentActive(intentId)
          || pending.intentId !== intentId
        ) return;
        closeAuthModal({ cancelCheckout: false, restoreFocus: false });
        startCheckoutItems(pending.items, pending.options || options, pending.returnPath || returnPath, intentId);
      })
      .catch((error) => {
        if (!isCheckoutIntentActive(intentId)) return;
        const message = error.message || 'Sign in or create an account to continue checkout.';
        setAuthStatus(message, 'info');
        if (!isAuthModalOpen()) showCheckoutMessage(message, 'error');
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

  function isVisibleStatusTarget(target) {
    return Boolean(
      target
      && !target.hidden
      && !target.closest('[hidden], [aria-hidden="true"]')
    );
  }

  function ensureCheckoutStatusRegion() {
    let target = document.getElementById('checkoutRuntimeStatus');
    if (target) return target;

    target = document.createElement('p');
    target.id = 'checkoutRuntimeStatus';
    target.className = 'checkout-runtime-status';
    target.setAttribute('role', 'status');
    target.setAttribute('aria-live', 'polite');
    const main = document.getElementById('mainContent') || document.querySelector('main');
    main?.prepend(target);
    return target;
  }

  function showCheckoutMessage(message, tone = 'info') {
    const target = [
      document.getElementById('cartStatus'),
      document.getElementById('modalCheckoutStatus'),
      document.getElementById('offerRuntimeStatus'),
      isAuthModalOpen() ? document.getElementById('customerAuthStatus') : null
    ].find(isVisibleStatusTarget) || ensureCheckoutStatusRegion();
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
    const hasFallback = typeof options.fallback === 'function';
    showCheckoutMessage(
      hasFallback ? message : message.replace(/,\s*so the inquiry email is opening instead\.?/i, '.'),
      'info'
    );
    if (!hasFallback) return false;
    options.fallback();
    return true;
  }

  function setCheckoutButtonsBusy(isBusy) {
    document.querySelectorAll('[data-checkout-button], [data-negotiated-offer-checkout], #modalBuy').forEach((button) => {
      button.disabled = Boolean(isBusy);
      button.setAttribute('aria-busy', String(Boolean(isBusy)));
      button.classList.toggle('is-busy', Boolean(isBusy));
    });
  }

  async function startCheckoutItems(items = [], options = {}, returnPath = '', checkoutIntentId = '') {
    if (state.checkoutInFlight) return;
    if (checkoutIntentId && !isCheckoutIntentActive(checkoutIntentId)) return;
    const normalizedItems = normalizeCheckoutItems(items);
    const negotiatedOffer = options.negotiatedOffer && typeof options.negotiatedOffer === 'object'
      ? {
          offerId: String(options.negotiatedOffer.offerId || '').trim(),
          token: String(options.negotiatedOffer.token || '').trim()
        }
      : null;
    const hasNegotiatedOffer = Boolean(negotiatedOffer?.offerId && negotiatedOffer?.token);
    if (!normalizedItems.length) {
      showCheckoutMessage('Add at least one available item before checkout.', 'error');
      return;
    }

    if (!isCheckoutEnabled() || !isBackendReady()) {
      openInquiryFallback(options);
      return;
    }

    const unavailableItem = normalizedItems.find((item) => (
      item.product && (
        (!hasNegotiatedOffer && !DJ.isDirectCheckoutEligible(item.product))
        || item.quantity > DJ.availableQuantity(item.product)
      )
    ));
    if (unavailableItem) {
      openInquiryFallback(options, 'This item needs confirmation before checkout, so the inquiry email is opening instead.');
      return;
    }

    const requestedGuestEmail = String(options.guestEmail || '').trim().toLowerCase();
    const canUseGuestCheckout = config.stripeGuestCheckoutEnabled === true
      && (
        hasNegotiatedOffer
        || (options.guestCheckout === true && EMAIL_PATTERN.test(requestedGuestEmail))
      );

    if (!canUseGuestCheckout && !state.authReady) {
      const intentId = openAuthModal({
        items: normalizedItems,
        returnPath,
        checkoutOptions: options,
        message: config.stripeGuestCheckoutEnabled === true
          ? 'Checking for an existing customer session. You can sign in, create an account, or continue as a guest.'
          : 'Checking for an existing customer session. You can sign in or create an account to continue checkout.'
      });
      continueCheckoutIfExistingSession(options, returnPath, intentId);
      return;
    }

    if (!canUseGuestCheckout && !state.session?.user) {
      openAuthModal({
        items: normalizedItems,
        returnPath,
        checkoutOptions: options,
        message: config.stripeGuestCheckoutEnabled === true
          ? 'Sign in, create a customer account, or enter your email to continue as a guest.'
          : 'Sign in or create a customer account before checkout.'
      });
      return;
    }

    if (checkoutIntentId && !isCheckoutIntentActive(checkoutIntentId)) return;

    state.checkoutInFlight = true;
    setCheckoutButtonsBusy(true);
    showCheckoutMessage('Creating secure Stripe checkout...', 'info');

    try {
      const payload = {
        items: normalizedItems.map(({ productId, quantity }) => ({ productId, quantity })),
        returnPath: returnPath || `${window.location.pathname}${window.location.search}`,
        ...(hasNegotiatedOffer
          ? { negotiatedOffer }
          : canUseGuestCheckout && !state.session?.user ? { guestEmail: requestedGuestEmail } : {})
      };
      DJ.trackEvent?.('begin_checkout', { resultCount: normalizedItems.length });
      if (canUseGuestCheckout && !state.session?.user && !hasNegotiatedOffer) {
        DJ.trackEvent?.('guest_checkout', { resultCount: normalizedItems.length });
      }
      const data = await DJ.remoteCatalog.invokeFunction(config.stripeCheckoutFunction, payload);
      if (!data?.url) {
        throw new Error('Stripe checkout did not return a checkout URL.');
      }
      if (checkoutIntentId && !isCheckoutIntentActive(checkoutIntentId)) {
        state.checkoutInFlight = false;
        setCheckoutButtonsBusy(false);
        return;
      }
      if (!options.skipCartSnapshot) {
        DJ.recordCheckoutCartSnapshot?.(data.sessionId, normalizedItems);
      }
      state.activeCheckoutIntentId = '';
      persistPendingCheckout(null);
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

  function startCheckout(product = {}, options = {}) {
    return startCheckoutItems(
      [{
        product,
        productId: DJ.normalizeProductId(product.id),
        quantity: DJ.normalizeCartQuantity(options.quantity)
      }],
      options,
      `${window.location.pathname}${window.location.search}`
    );
  }

  function startCartCheckout(items = [], options = {}) {
    return startCheckoutItems(items, options, options.returnPath || '/cart.html');
  }

  function startNegotiatedOfferCheckout(offer = {}) {
    const offerId = String(offer.id || offer.offerId || '').trim();
    const token = String(offer.token || '').trim();
    const product = offer.product && typeof offer.product === 'object' ? offer.product : {};
    const productId = DJ.normalizeProductId(product.id || offer.productId);
    if (!offerId || !token || !productId) {
      showCheckoutMessage('This negotiated offer is missing its secure checkout details. Return to your offer email and try again.', 'error');
      return Promise.resolve();
    }

    return startCheckoutItems([{
      product: {
        ...product,
        id: productId,
        quantityAvailable: product.quantityAvailable ?? product.quantity_available ?? 1
      },
      productId,
      quantity: 1
    }], {
      negotiatedOffer: { offerId, token },
      skipCartSnapshot: true
    }, `${window.location.pathname}${window.location.search}`);
  }

  async function init() {
    injectAccountControl();
    updateAccountControls();

    if (isBackendReady() && document.querySelector('[data-customer-auth-autoload]')) {
      const hydrateAfterPaint = () => ensureAuthSession()
        .then((session) => {
          const params = new URLSearchParams(window.location.search);
          const pending = restorePendingCheckout();
          if (
            session?.user
            && pending?.items?.length
            && isCheckoutIntentActive(pending.intentId)
            && params.get('checkout') === 'resume'
          ) {
            startCheckoutItems(pending.items, pending.options || {}, pending.returnPath, pending.intentId);
          }
        })
        .catch(() => {});
      DJ.scheduleIdle(hydrateAfterPaint, 2400);
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
    startCartCheckout,
    startNegotiatedOfferCheckout,
    isDirectCheckoutEligible: DJ.isDirectCheckoutEligible,
    hydrateAccount: ensureAuthSession
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();

