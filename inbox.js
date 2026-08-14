window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const mount = document.getElementById('inboxMount');
  const config = window.DJ_BACKEND_CONFIG || {};
  const moneyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const dateFormatter = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const state = {
    offers: [],
    inquiries: [],
    offerOffset: 0,
    inquiryOffset: 0,
    hasMoreOffers: false,
    hasMoreInquiries: false,
    offerStatus: 'all',
    inquiryStatus: 'all',
    focusOfferId: new URLSearchParams(window.location.search).get('offer') || ''
  };

  if (!mount) return;

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
    return Number.isFinite(value) ? moneyFormatter.format(value / 100) : '—';
  }

  function formatInquiryMoney(amount) {
    const value = Number(amount);
    return Number.isFinite(value) ? moneyFormatter.format(value) : '';
  }

  function moneyInputValue(cents) {
    const value = Number(cents);
    return Number.isFinite(value) ? (value / 100).toFixed(2) : '';
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
  }

  function setBusy(isBusy) {
    mount.setAttribute('aria-busy', String(Boolean(isBusy)));
  }

  function setStatus(message = '', tone = 'info') {
    const status = document.getElementById('inboxRuntimeStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function invoke(payload) {
    if (!DJ.remoteCatalog?.isConfigured?.() || !config.offerWorkflowFunction) {
      return Promise.reject(new Error('The Admin Inbox service is not configured yet.'));
    }
    return DJ.remoteCatalog.invokeFunction(config.offerWorkflowFunction, payload);
  }

  function offerStatusLabel(status) {
    return {
      pending: 'Awaiting review',
      countered: 'Counter sent',
      accepted: 'Accepted',
      declined: 'Declined',
      rejected: 'Customer declined',
      expired: 'Expired',
      purchased: 'Purchased'
    }[status] || 'Offer update';
  }

  function selectOptions(values, selected, labels = {}) {
    return values.map((value) => `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(labels[value] || value)}</option>`).join('');
  }

  function offerControls(offer) {
    if (!['pending', 'countered', 'accepted'].includes(offer.status)) return '<p class="inbox-card__closed-note">No action is needed for this closed offer.</p>';
    const canNegotiate = offer.status !== 'accepted';
    return `
      <form class="inbox-offer-form" data-inbox-offer-form data-offer-id="${escapeHtml(offer.id)}">
        ${canNegotiate ? `<div class="inbox-offer-form__grid"><label>Counter price<input name="amount" type="number" inputmode="decimal" min="0.50" max="999999.99" step="0.01" value="${escapeHtml(moneyInputValue(offer.currentAmountCents))}"></label><label>Valid for days<input name="expiresInDays" type="number" inputmode="numeric" min="1" max="30" value="7"></label></div>` : ''}
        <label>Private note to customer <span class="field-optional">optional</span><textarea name="note" rows="3" maxlength="2000">${escapeHtml(offer.adminNote || '')}</textarea></label>
        <div class="inline-actions">
          ${canNegotiate ? '<button class="button" type="submit" name="decision" value="accept">Accept Current Offer</button><button class="button-secondary" type="submit" name="decision" value="counter">Send Counteroffer</button>' : ''}
          <button class="button-ghost" type="submit" name="decision" value="decline">${offer.status === 'accepted' ? 'Withdraw Offer' : 'Decline'}</button>
        </div>
      </form>
    `;
  }

  function renderOfferCard(offer) {
    const focused = offer.id === state.focusOfferId ? ' inbox-card--focused' : '';
    return `
      <article class="inbox-card inbox-offer-card${focused}" id="offer-${escapeHtml(offer.id)}" data-inbox-offer-card>
        <div class="inbox-card__header">
          <div><span class="kicker">Offer #${escapeHtml(offer.id.slice(0, 8))}</span><h3>${escapeHtml(offer.product?.name || `Listing #${offer.product?.id || ''}`)}</h3></div>
          <span class="offer-status-badge" data-status="${escapeHtml(offer.status)}">${escapeHtml(offerStatusLabel(offer.status))}</span>
        </div>
        <div class="inbox-card__facts">
          <span><strong>Buyer</strong>${escapeHtml(offer.buyerName || '')}<a href="mailto:${escapeHtml(offer.buyerEmail || '')}">${escapeHtml(offer.buyerEmail || '')}</a>${offer.buyerPhone ? `<a href="tel:${escapeHtml(offer.buyerPhone)}">${escapeHtml(offer.buyerPhone)}</a>` : ''}</span>
          <span><strong>Initial offer</strong>${escapeHtml(formatMoney(offer.initialAmountCents))}</span>
          <span><strong>Current amount</strong>${escapeHtml(formatMoney(offer.currentAmountCents))}</span>
          <span><strong>Expires</strong>${escapeHtml(formatDate(offer.expiresAt))}</span>
        </div>
        ${offer.customerNote ? `<div class="inbox-note"><strong>Customer message</strong><p>${escapeHtml(offer.customerNote)}</p></div>` : ''}
        ${offer.stripeSessionId ? `<p class="inbox-card__meta">Stripe checkout opened: ${escapeHtml(offer.stripeSessionId)}</p>` : ''}
        ${offerControls(offer)}
      </article>
    `;
  }

  function renderInquiryCard(inquiry) {
    return `
      <article class="inbox-card inbox-message-card" data-inquiry-id="${escapeHtml(inquiry.id)}">
        <div class="inbox-card__header"><div><span class="kicker">${escapeHtml(String(inquiry.kind || 'message').replaceAll('_', ' '))}</span><h3>${escapeHtml(inquiry.subject || `Message from ${inquiry.name || 'collector'}`)}</h3></div><span class="inbox-status-badge">${escapeHtml(inquiry.status || 'new')}</span></div>
        <div class="inbox-card__facts">
          <span><strong>From</strong>${escapeHtml(inquiry.name || '')}<a href="mailto:${escapeHtml(inquiry.email || '')}">${escapeHtml(inquiry.email || '')}</a>${inquiry.phone ? `<a href="tel:${escapeHtml(inquiry.phone)}">${escapeHtml(inquiry.phone)}</a>` : ''}</span>
          ${inquiry.preferredContact ? `<span><strong>Preferred contact</strong>${escapeHtml(inquiry.preferredContact)}</span>` : ''}
          ${inquiry.offerAmount != null ? `<span><strong>Offer amount</strong>${escapeHtml(formatInquiryMoney(inquiry.offerAmount))}</span>` : ''}
          <span><strong>Received</strong>${escapeHtml(formatDate(inquiry.createdAt))}</span>
        </div>
        ${inquiry.productIds?.length ? `<p class="inbox-card__meta">Listing IDs: ${escapeHtml(inquiry.productIds.join(', '))}</p>` : ''}
        ${inquiry.sourcePath ? `<p class="inbox-card__meta">Submitted from: ${escapeHtml(inquiry.sourcePath)}</p>` : ''}
        <div class="inbox-note"><strong>Message</strong><p>${escapeHtml(inquiry.message || '')}</p></div>
        <form class="inbox-inquiry-form" data-inbox-inquiry-form data-inquiry-id="${escapeHtml(inquiry.id)}"><label>Message status<select name="status">${selectOptions(['new', 'reviewing', 'replied', 'closed', 'spam'], inquiry.status, { new: 'New', reviewing: 'Reviewing', replied: 'Replied', closed: 'Closed', spam: 'Spam' })}</select></label><button class="button-secondary" type="submit">Save Status</button></form>
      </article>
    `;
  }

  function render() {
    setBusy(false);
    mount.innerHTML = `
      <div class="inbox-toolbar panel">
        <div><h2>Messages &amp; offers</h2><p>New site messages and offers send email notifications when the existing notification settings are configured.</p></div>
        <div class="inbox-toolbar__filters"><label>Offer status<select data-inbox-offer-filter>${selectOptions(['all', 'pending', 'countered', 'accepted', 'declined', 'rejected', 'expired', 'purchased'], state.offerStatus, { all: 'All offers', pending: 'Awaiting review', countered: 'Counter sent', accepted: 'Accepted', declined: 'Declined', rejected: 'Customer declined', expired: 'Expired', purchased: 'Purchased' })}</select></label><label>Message status<select data-inbox-inquiry-filter>${selectOptions(['all', 'new', 'reviewing', 'replied', 'closed', 'spam'], state.inquiryStatus, { all: 'All messages', new: 'New', reviewing: 'Reviewing', replied: 'Replied', closed: 'Closed', spam: 'Spam' })}</select></label><button class="button-secondary" type="button" data-inbox-refresh>Refresh</button></div>
        <p class="inbox-runtime-status" id="inboxRuntimeStatus" role="status" aria-live="polite"></p>
      </div>
      <section class="inbox-section" aria-labelledby="inboxOffersHeading">
        <div class="section-heading"><div><span class="kicker">Negotiated checkout</span><h2 id="inboxOffersHeading">Offers</h2></div><span>${state.offers.length} loaded</span></div>
        <div class="inbox-list">${state.offers.length ? state.offers.map(renderOfferCard).join('') : '<div class="panel inbox-empty"><p>No offers match this filter.</p></div>'}</div>
        ${state.hasMoreOffers ? '<div class="inbox-load-more"><button class="button-secondary" type="button" data-inbox-load-offers>Load more offers</button></div>' : ''}
      </section>
      <section class="inbox-section" aria-labelledby="inboxMessagesHeading">
        <div class="section-heading"><div><span class="kicker">Collector messages</span><h2 id="inboxMessagesHeading">Messages</h2></div><span>${state.inquiries.length} loaded</span></div>
        <div class="inbox-list">${state.inquiries.length ? state.inquiries.map(renderInquiryCard).join('') : '<div class="panel inbox-empty"><p>No messages match this filter.</p></div>'}</div>
        ${state.hasMoreInquiries ? '<div class="inbox-load-more"><button class="button-secondary" type="button" data-inbox-load-inquiries>Load more messages</button></div>' : ''}
      </section>
    `;
    if (state.focusOfferId) {
      const card = document.getElementById(`offer-${state.focusOfferId}`);
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      state.focusOfferId = '';
    }
  }

  function renderAccessMessage(message, isError = false) {
    setBusy(false);
    mount.innerHTML = `<div class="panel inbox-empty"><h2>${isError ? 'Admin Inbox unavailable' : 'Admin sign-in required'}</h2><p>${escapeHtml(message)}</p><div class="inline-actions"><a class="button" href="admin.html">Open Admin Dashboard</a><a class="button-secondary" href="account.html">Open Account</a></div></div>`;
  }

  async function loadInbox({ appendOffers = false, appendInquiries = false } = {}) {
    setBusy(true);
    try {
      const data = await invoke({
        action: 'admin-list-inbox',
        limit: 50,
        offerOffset: appendOffers ? state.offerOffset : 0,
        inquiryOffset: appendInquiries ? state.inquiryOffset : 0,
        offerStatus: state.offerStatus,
        inquiryStatus: state.inquiryStatus
      });
      const offers = Array.isArray(data?.offers) ? data.offers : [];
      const inquiries = Array.isArray(data?.inquiries) ? data.inquiries : [];
      state.offers = appendOffers ? [...state.offers, ...offers] : offers;
      state.inquiries = appendInquiries ? [...state.inquiries, ...inquiries] : inquiries;
      state.offerOffset = state.offers.length;
      state.inquiryOffset = state.inquiries.length;
      state.hasMoreOffers = Boolean(data?.hasMoreOffers);
      state.hasMoreInquiries = Boolean(data?.hasMoreInquiries);
      render();
    } catch (error) {
      renderAccessMessage(error?.message || 'The Admin Inbox could not be loaded.', true);
    }
  }

  async function decideOffer(form, decision) {
    const offerId = form.dataset.offerId || '';
    const submitters = [...form.querySelectorAll('button')];
    submitters.forEach((button) => { button.disabled = true; });
    setStatus('Saving offer decision...', 'info');
    try {
      await invoke({
        action: 'admin-decide',
        offerId,
        decision,
        amount: form.elements.amount?.value,
        expiresInDays: form.elements.expiresInDays?.value,
        note: form.elements.note?.value
      });
      await loadInbox();
      setStatus('Offer decision saved and customer notification requested.', 'success');
    } catch (error) {
      setStatus(error?.message || 'The offer decision could not be saved.', 'error');
      submitters.forEach((button) => { button.disabled = false; });
    }
  }

  async function updateInquiry(form) {
    const button = form.querySelector('button');
    button.disabled = true;
    setStatus('Saving message status...', 'info');
    try {
      await invoke({ action: 'admin-update-inquiry', inquiryId: form.dataset.inquiryId || '', status: form.elements.status?.value });
      await loadInbox();
      setStatus('Message status saved.', 'success');
    } catch (error) {
      setStatus(error?.message || 'The message status could not be saved.', 'error');
      button.disabled = false;
    }
  }

  mount.addEventListener('click', (event) => {
    if (event.target.closest('[data-inbox-refresh]')) loadInbox();
    if (event.target.closest('[data-inbox-load-offers]')) loadInbox({ appendOffers: true, appendInquiries: false });
    if (event.target.closest('[data-inbox-load-inquiries]')) loadInbox({ appendOffers: false, appendInquiries: true });
  });
  mount.addEventListener('change', (event) => {
    if (event.target.matches('[data-inbox-offer-filter]')) {
      state.offerStatus = event.target.value;
      state.offerOffset = 0;
      loadInbox();
    }
    if (event.target.matches('[data-inbox-inquiry-filter]')) {
      state.inquiryStatus = event.target.value;
      state.inquiryOffset = 0;
      loadInbox();
    }
  });
  mount.addEventListener('submit', (event) => {
    const form = event.target;
    if (form.matches('[data-inbox-offer-form]')) {
      event.preventDefault();
      const decision = event.submitter?.value || '';
      decideOffer(form, decision);
    }
    if (form.matches('[data-inbox-inquiry-form]')) {
      event.preventDefault();
      updateInquiry(form);
    }
  });

  async function init() {
    if (!DJ.remoteCatalog?.isConfigured?.()) {
      renderAccessMessage('The Supabase browser connection is not configured on this page.', true);
      return;
    }
    const session = await DJ.remoteCatalog.getSession().catch(() => null);
    if (!session?.user) {
      renderAccessMessage('Sign in with the configured admin account to review messages and offers.');
      return;
    }
    await loadInbox();
  }

  init();
})();
