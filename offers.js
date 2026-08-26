window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const mount = document.getElementById('offerMount');
  const config = window.DJ_BACKEND_CONFIG || {};
  const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const state = { offerId: '', token: '', offer: null, events: [], actionInFlight: false };

  if (!mount) return;

  function offerTokenStorageKey(offerId) {
    return `djhc-offer-access:${String(offerId || '').trim()}`;
  }

  function saveOfferToken(offerId, token) {
    if (!offerId || !token) return;
    try {
      sessionStorage.setItem(offerTokenStorageKey(offerId), token);
    } catch {
      // The current in-memory token still supports this page session.
    }
  }

  function savedOfferToken(offerId) {
    try {
      return sessionStorage.getItem(offerTokenStorageKey(offerId)) || '';
    } catch {
      return '';
    }
  }

  function escapeHtml(value = '') {
    return DJ.escapeHtml ? DJ.escapeHtml(String(value ?? '')) : String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(cents) {
    const value = Number(cents);
    return Number.isFinite(value) ? moneyFormatter.format(value / 100) : 'Price on request';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
  }

  function setBusy(isBusy) {
    mount.setAttribute('aria-busy', String(Boolean(isBusy)));
  }

  function setStatus(message = '', tone = 'info') {
    const status = document.getElementById('offerRuntimeStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function invoke(payload) {
    if (!DJ.remoteCatalog?.isConfigured?.() || !config.offerWorkflowFunction) {
      return Promise.reject(new Error('The secure offer service is not configured yet. Please contact DJ.'));
    }
    return DJ.remoteCatalog.invokeFunction(config.offerWorkflowFunction, payload);
  }

  function normalProduct(product = {}) {
    return {
      id: Number(product.id),
      name: String(product.name || `Listing #${product.id || ''}`),
      image: String(product.image || product.imageGallery?.[0] || product.image_gallery?.[0] || ''),
      category: String(product.category || ''),
      publicAmountCents: Number.isFinite(Number(product.checkoutPrice))
        ? Math.round(Number(product.checkoutPrice) * 100)
        : Number.isFinite(Number(product.price)) && Number(product.price) > 0
          ? Math.round(Number(product.price) * 100)
          : null,
      quantityAvailable: Number(product.quantityAvailable ?? product.quantity_available ?? product.copyCount ?? product.copy_count ?? 1) || 1
    };
  }

  async function loadProduct(productId) {
    const numericId = Number(productId);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
    try {
      if (DJ.remoteCatalog?.isConfigured?.()) {
        const products = await DJ.remoteCatalog.listProducts({ ids: [numericId] });
        if (products?.[0]) return normalProduct(products[0]);
      }
    } catch (error) {
      console.warn('[offers] Remote product lookup failed; using the static fallback when available.', error);
    }

    try {
      const cached = DJ.getPreloadedProductsForSource?.('products-public.json')
        || await DJ.loadPreloadedProductsForSource?.('products-public.json');
      const product = Array.isArray(cached) ? cached.find((item) => Number(item?.id) === numericId) : null;
      return product ? normalProduct(product) : null;
    } catch (error) {
      console.warn('[offers] Static product lookup failed.', error);
      return null;
    }
  }

  function productSummary(product = {}, { publicAmountCents = null, negotiatedAmountCents = null } = {}) {
    const image = String(product.image || '').trim();
    const safeImage = image && DJ.safeAssetUrl ? DJ.safeAssetUrl(image) : image;
    const pricing = negotiatedAmountCents != null
      ? `<p class="offer-product-card__price"><span>Agreed price</span><strong>${escapeHtml(formatMoney(negotiatedAmountCents))}</strong></p>`
      : publicAmountCents != null
        ? `<p class="offer-product-card__price"><span>Current public price</span><strong>${escapeHtml(formatMoney(publicAmountCents))}</strong></p>`
        : '<p class="offer-product-card__price"><span>Public price</span><strong>Contact for availability</strong></p>';
    return `
      <article class="offer-product-card">
        ${safeImage ? `<img src="${escapeHtml(safeImage)}" alt="${escapeHtml(product.name || 'Listing image')}" loading="eager" decoding="async">` : '<div class="offer-product-card__image-fallback" aria-hidden="true">DJ</div>'}
        <div>
          <p class="offer-product-card__eyebrow">${escapeHtml(product.category || 'DJ listing')}</p>
          <h2>${escapeHtml(product.name || 'Selected listing')}</h2>
          ${pricing}
        </div>
      </article>
    `;
  }

  function renderUnavailable(message) {
    setBusy(false);
    mount.innerHTML = `
      <div class="panel offer-empty-state">
        <h2>Offer unavailable</h2>
        <p>${escapeHtml(message)}</p>
        <div class="inline-actions"><a class="button" href="shop.html">Browse available listings</a><a class="button-secondary" href="contact.html">Contact DJ</a></div>
      </div>
    `;
  }

  function renderCreate(product) {
    const requestId = crypto.randomUUID();
    setBusy(false);
    mount.innerHTML = `
      <div class="offer-layout">
        ${productSummary(product, { publicAmountCents: product.publicAmountCents })}
        <section class="panel offer-form-panel" aria-labelledby="offerFormHeading">
          <span class="kicker">Send a private offer</span>
          <h2 id="offerFormHeading">What would you like to offer?</h2>
          <p>DJ will review the offer in the site inbox. You will receive email updates and a private link to accept, counter, decline, or purchase an accepted offer.</p>
          <form class="offer-form" id="offerCreateForm" novalidate>
            <input type="text" class="offer-honeypot" name="website" autocomplete="off" tabindex="-1" aria-hidden="true">
            <div class="offer-form-grid">
              <label>Name<input name="name" type="text" autocomplete="name" minlength="2" maxlength="120" required></label>
              <label>Email<input name="email" type="email" autocomplete="email" maxlength="254" required></label>
              <label>Phone <span class="field-optional">optional</span><input name="phone" type="tel" autocomplete="tel" maxlength="80"></label>
              <label>Offer amount<input name="amount" type="number" inputmode="decimal" min="0.50" max="999999.99" step="0.01" required></label>
              <label class="offer-form-grid__full">Message <span class="field-optional">optional</span><textarea name="message" rows="4" maxlength="2000" placeholder="Add any helpful details for DJ."></textarea></label>
            </div>
            <div class="inline-actions"><button class="button" type="submit">Submit Offer</button><a class="button-secondary" href="${escapeHtml(DJ.productPageUrl ? DJ.productPageUrl(product) : 'shop.html')}">Back to Listing</a></div>
            <p class="offer-runtime-status" id="offerRuntimeStatus" role="status" aria-live="polite"></p>
          </form>
        </section>
      </div>
    `;

    document.getElementById('offerCreateForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('button[type="submit"]');
      const values = new FormData(form);
      submit.disabled = true;
      setStatus('Submitting your private offer...', 'info');
      try {
        const data = await invoke({
          action: 'create',
          requestId,
          productId: product.id,
          name: values.get('name'),
          email: values.get('email'),
          phone: values.get('phone'),
          amount: values.get('amount'),
          message: values.get('message'),
          website: values.get('website')
        });
        if (!data?.offerUrl || !data?.offer?.id) {
          setStatus('Your offer was received. DJ will follow up by email.', 'success');
          form.reset();
          return;
        }
        const url = new URL(data.offerUrl, window.location.origin);
        state.offerId = url.searchParams.get('offer') || '';
        state.token = new URLSearchParams(url.hash.replace(/^#/, '')).get('token') || '';
        saveOfferToken(state.offerId, state.token);
        window.history.replaceState({}, '', `${url.pathname}${url.search}`);
        await loadOffer();
      } catch (error) {
        setStatus(error?.message || 'Your offer could not be submitted. Please try again.', 'error');
      } finally {
        submit.disabled = false;
      }
    });
  }

  function offerStatusCopy(status) {
    return {
      pending: 'Awaiting DJ review',
      countered: 'DJ sent a counteroffer',
      accepted: 'Offer accepted',
      declined: 'Offer declined',
      rejected: 'Offer closed',
      expired: 'Offer expired',
      purchased: 'Purchased'
    }[status] || 'Offer update';
  }

  function eventCopy(event = {}) {
    return {
      submitted: 'You submitted an offer',
      customer_counter: 'You sent a counteroffer',
      customer_accept: 'You accepted DJ\'s counteroffer',
      customer_reject: 'You declined the offer',
      admin_accept: 'DJ accepted the offer',
      admin_counter: 'DJ sent a counteroffer',
      admin_decline: 'DJ declined the offer',
      checkout_started: 'Secure checkout was opened',
      checkout_expired: 'A checkout session expired',
      expired: 'The offer expired',
      purchased: 'Payment was completed'
    }[event.action] || 'Offer updated';
  }

  function offerActions(offer) {
    if (offer.status === 'countered') {
      return `
        <div class="offer-action-panel">
          <h3>Respond to the counteroffer</h3>
          <p>DJ offered ${escapeHtml(formatMoney(offer.currentAmountCents))}. This private price expires ${escapeHtml(formatDate(offer.expiresAt))}.</p>
          <div class="inline-actions"><button class="button" type="button" data-offer-customer-action="customer-accept">Accept ${escapeHtml(formatMoney(offer.currentAmountCents))}</button><button class="button-secondary" type="button" data-offer-reject>Decline</button></div>
          <form class="offer-form offer-counter-form" id="offerCounterForm">
            <h4>Send a counteroffer</h4>
            <label>Counteroffer amount<input name="amount" type="number" inputmode="decimal" min="0.50" max="999999.99" step="0.01" required></label>
            <label>Message <span class="field-optional">optional</span><textarea name="message" rows="3" maxlength="2000"></textarea></label>
            <button class="button-secondary" type="submit">Send Counteroffer</button>
          </form>
        </div>
      `;
    }
    if (offer.status === 'accepted') {
      return `
        <div class="offer-action-panel">
          <h3>Your price is ready</h3>
          <p>Use secure Stripe Checkout to purchase this one listing at ${escapeHtml(formatMoney(offer.currentAmountCents))}. The public listing price stays unchanged.</p>
          <div class="inline-actions"><button class="button" type="button" data-negotiated-offer-checkout>Buy at ${escapeHtml(formatMoney(offer.currentAmountCents))}</button><button class="button-secondary" type="button" data-offer-reject>Decline Offer</button></div>
        </div>
      `;
    }
    if (offer.status === 'pending') return '<p class="offer-status-copy">DJ has your offer and will notify you by email after reviewing it.</p>';
    if (offer.status === 'purchased') return '<p class="offer-status-copy">This negotiated purchase is complete. Thank you for shopping with DJ.</p>';
    if (offer.status === 'expired') return '<p class="offer-status-copy">This private price expired before checkout. Contact DJ if you would like to discuss the listing again.</p>';
    return '<p class="offer-status-copy">This offer is closed. You can continue browsing current listings at any time.</p>';
  }

  function renderOffer() {
    const offer = state.offer;
    if (!offer) return;
    setBusy(false);
    mount.innerHTML = `
      <div class="offer-layout">
        ${productSummary(offer.product, { publicAmountCents: offer.publicAmountCents, negotiatedAmountCents: ['accepted', 'purchased'].includes(offer.status) ? offer.currentAmountCents : null })}
        <section class="panel offer-detail-panel" aria-labelledby="offerDetailHeading">
          <div class="offer-detail-panel__header"><div><span class="kicker">Private offer</span><h2 id="offerDetailHeading">${escapeHtml(offerStatusCopy(offer.status))}</h2></div><span class="offer-status-badge" data-status="${escapeHtml(offer.status)}">${escapeHtml(offerStatusCopy(offer.status))}</span></div>
          <dl class="offer-facts"><div><dt>Your offer</dt><dd>${escapeHtml(formatMoney(offer.initialAmountCents))}</dd></div><div><dt>Current amount</dt><dd>${escapeHtml(formatMoney(offer.currentAmountCents))}</dd></div><div><dt>Offer valid until</dt><dd>${escapeHtml(formatDate(offer.expiresAt))}</dd></div></dl>
          ${offer.adminNote ? `<div class="offer-note"><strong>Note from DJ</strong><p>${escapeHtml(offer.adminNote)}</p></div>` : ''}
          ${offerActions(offer)}
          <p class="offer-runtime-status" id="offerRuntimeStatus" role="status" aria-live="polite"></p>
        </section>
      </div>
      <section class="panel offer-timeline" aria-labelledby="offerTimelineHeading">
        <h2 id="offerTimelineHeading">Offer activity</h2>
        <ol>${state.events.length ? state.events.map((event) => `<li><strong>${escapeHtml(eventCopy(event))}</strong>${event.amountCents != null ? `<span>${escapeHtml(formatMoney(event.amountCents))}</span>` : ''}${event.note ? `<p>${escapeHtml(event.note)}</p>` : ''}<time datetime="${escapeHtml(event.createdAt || '')}">${escapeHtml(formatDate(event.createdAt))}</time></li>`).join('') : '<li>No activity is available yet.</li>'}</ol>
      </section>
    `;
    bindOfferActions();
  }

  async function customerAction(action, data = {}) {
    if (state.actionInFlight) return;
    state.actionInFlight = true;
    const controls = [...mount.querySelectorAll('[data-offer-customer-action], [data-offer-reject], #offerCounterForm button')];
    controls.forEach((control) => { control.disabled = true; });
    setBusy(true);
    setStatus('Saving your response...', 'info');
    try {
      await invoke({ action, offerId: state.offerId, token: state.token, ...data });
      await loadOffer();
    } catch (error) {
      setStatus(error?.message || 'Your response could not be saved. Please try again.', 'error');
    } finally {
      state.actionInFlight = false;
      setBusy(false);
      controls.forEach((control) => {
        if (control.isConnected) control.disabled = false;
      });
    }
  }

  function bindOfferActions() {
    document.querySelector('[data-offer-customer-action]')?.addEventListener('click', () => customerAction('customer-accept'));
    document.querySelector('[data-offer-reject]')?.addEventListener('click', () => customerAction('customer-reject'));
    document.getElementById('offerCounterForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      customerAction('customer-counter', { amount: values.get('amount'), message: values.get('message') });
    });
    document.querySelector('[data-negotiated-offer-checkout]')?.addEventListener('click', () => {
      if (!DJ.payments?.startNegotiatedOfferCheckout) {
        setStatus('Secure checkout is still loading. Please try again in a moment.', 'error');
        return;
      }
      DJ.payments.startNegotiatedOfferCheckout({
        id: state.offerId,
        token: state.token,
        product: { ...state.offer.product, quantityAvailable: 1 }
      });
    });
  }

  async function loadOffer() {
    if (!state.offerId || !state.token) {
      renderUnavailable('This private offer link is incomplete. Return to the email DJ sent you.');
      return;
    }
    setBusy(true);
    try {
      const data = await invoke({ action: 'view', offerId: state.offerId, token: state.token });
      state.offer = data?.offer || null;
      state.events = Array.isArray(data?.events) ? data.events : [];
      if (!state.offer) throw new Error('This offer could not be found.');
      renderOffer();
    } catch (error) {
      renderUnavailable(error?.message || 'This offer could not be loaded.');
    }
  }

  async function init() {
    const params = new URLSearchParams(window.location.search);
    state.offerId = String(params.get('offer') || '').trim();
    const fragment = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    state.token = String(fragment.get('token') || params.get('token') || savedOfferToken(state.offerId)).trim();
    if (state.offerId && state.token) saveOfferToken(state.offerId, state.token);
    if (fragment.has('token') || params.has('token')) {
      params.delete('token');
      const query = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
    }
    if (state.offerId || state.token) {
      await loadOffer();
      return;
    }
    const product = await loadProduct(params.get('item'));
    if (!product) {
      renderUnavailable('Choose an available listing before making an offer.');
      return;
    }
    renderCreate(product);
  }

  init();
})();
