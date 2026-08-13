/**
 * Collector inquiry forms and photo preparation.
 * The browser sends form data to a public Edge Function; validation, rate
 * limiting, storage, and owner notification all stay server-side.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const config = window.DJ_BACKEND_CONFIG || {};
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const MAX_PHOTOS = 3;
  const MAX_TOTAL_PHOTO_BYTES = 6 * 1024 * 1024;
  const validKinds = new Set(['contact', 'sell', 'trade', 'want_list', 'offer', 'bundle']);
  const inquiryEndpoint = (
    config.supabaseUrl
    && config.supabasePublishableKey
    && config.collectorInquiryFunction
  )
    ? `${String(config.supabaseUrl).replace(/\/+$/, '')}/functions/v1/${encodeURIComponent(config.collectorInquiryFunction)}`
    : '';

  function normalizeProductIds(value = '') {
    return [...new Set(String(value || '')
      .split(/[,\s]+/)
      .map((entry) => Number(entry.trim()))
      .filter((entry) => Number.isSafeInteger(entry) && entry > 0))]
      .slice(0, 20);
  }

  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name || 'a photo'}.`));
      reader.onload = () => {
        const result = String(reader.result || '');
        const data = result.includes(',') ? result.split(',').pop() : result;
        resolve({ name: String(file.name || ''), type: String(file.type || ''), data });
      };
      reader.readAsDataURL(file);
    });
  }

  async function prepareInquiryPhotos(files) {
    const selected = [...(files || [])];
    if (selected.length > MAX_PHOTOS) throw new Error('Attach no more than three photos.');
    const totalBytes = selected.reduce((total, file) => total + (Number(file?.size) || 0), 0);
    if (totalBytes > MAX_TOTAL_PHOTO_BYTES) throw new Error('Your combined photos must be 6 MB or smaller.');
    if (selected.some((file) => !['image/jpeg', 'image/png', 'image/webp'].includes(String(file?.type || '').toLowerCase()))) {
      throw new Error('Use JPG, PNG, or WebP photos.');
    }
    return Promise.all(selected.map(readFileAsBase64));
  }

  async function submitCollectorInquiry(payload = {}, files = []) {
    if (!inquiryEndpoint) throw new Error('The inquiry form is temporarily unavailable. Please use the direct email link.');
    const photos = await prepareInquiryPhotos(files);
    const response = await fetch(inquiryEndpoint, {
      method: 'POST',
      headers: { apikey: config.supabasePublishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, photos }),
      credentials: 'omit'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data?.accepted !== true) {
      throw new Error(data?.error || 'Could not send your inquiry. Please try again.');
    }
    return data;
  }

  function setFormStatus(form, message = '', tone = 'info') {
    const status = document.getElementById(form.dataset.status || 'collectorInquiryStatus');
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
    status.dataset.tone = tone;
  }

  function prefillFromUrl(form) {
    const params = new URLSearchParams(window.location.search);
    const requestedKind = String(params.get('kind') || '').toLowerCase();
    const kindField = form.elements.namedItem('kind');
    if (validKinds.has(requestedKind) && kindField) kindField.value = requestedKind;
    const productIds = normalizeProductIds(params.get('productIds') || '');
    const listingField = form.elements.namedItem('listingIds');
    if (listingField && productIds.length) listingField.value = productIds.join(', ');
    const subjectField = form.elements.namedItem('subject');
    if (subjectField && !subjectField.value && requestedKind === 'offer') subjectField.value = 'Offer for site listing';
    if (subjectField && !subjectField.value && requestedKind === 'bundle') subjectField.value = 'Bundle request for saved listings';
  }

  function syncInquiryKind(form) {
    const kind = String(form.elements.namedItem('kind')?.value || '').toLowerCase();
    const offerField = form.querySelector('[data-offer-field]');
    if (offerField) offerField.hidden = !['offer', 'bundle'].includes(kind);
    const message = form.elements.namedItem('message');
    if (message?.dataset && !message.value.trim()) {
      const prompts = {
        sell: 'Tell DJ what you have, including year, brand or publisher, condition, quantity, and asking range.',
        trade: 'Tell DJ what you have and what you would like in return.',
        want_list: 'List the players, teams, titles, eras, grades, or items you are hunting.',
        offer: 'Share your offer and any details that would help DJ review it.',
        bundle: 'Tell DJ which listings you want to combine and the price or trade idea you have in mind.'
      };
      if (prompts[kind]) message.placeholder = prompts[kind];
    }
  }

  function bindCollectorInquiryForm(form) {
    if (form.dataset.collectorInquiryBound === 'true') return;
    form.dataset.collectorInquiryBound = 'true';
    prefillFromUrl(form);
    syncInquiryKind(form);
    form.elements.namedItem('kind')?.addEventListener('change', () => syncInquiryKind(form));

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = String(form.elements.namedItem('name')?.value || '').trim();
      const email = String(form.elements.namedItem('email')?.value || '').trim();
      const message = String(form.elements.namedItem('message')?.value || '').trim();
      const kind = String(form.elements.namedItem('kind')?.value || '').trim().toLowerCase();
      if (!validKinds.has(kind) || name.length < 2 || !EMAIL_PATTERN.test(email) || message.length < 3) {
        setFormStatus(form, 'Please provide your name, a valid email address, and a message.', 'error');
        return;
      }

      const submitButton = form.querySelector('button[type="submit"]');
      if (submitButton) {
        submitButton.disabled = true;
        submitButton.setAttribute('aria-busy', 'true');
      }
      setFormStatus(form, 'Sending your request securely…', 'info');
      try {
        await submitCollectorInquiry({
          kind,
          name,
          email,
          phone: String(form.elements.namedItem('phone')?.value || '').trim(),
          preferredContact: String(form.elements.namedItem('preferredContact')?.value || '').trim(),
          subject: String(form.elements.namedItem('subject')?.value || '').trim(),
          message,
          offerAmount: String(form.elements.namedItem('offerAmount')?.value || '').trim(),
          productIds: normalizeProductIds(form.elements.namedItem('listingIds')?.value || ''),
          sourcePath: `${window.location.pathname}${window.location.search}`,
          website: String(form.elements.namedItem('website')?.value || '').trim()
        }, form.elements.namedItem('photos')?.files || []);
        form.reset();
        prefillFromUrl(form);
        syncInquiryKind(form);
        setFormStatus(form, 'Thanks — DJ received your request and will follow up by email.', 'success');
        DJ.trackEvent?.('inquiry_submit', { kind });
      } catch (error) {
        setFormStatus(form, error?.message || 'Could not send your request. Please use the direct email link.', 'error');
      } finally {
        if (submitButton) {
          submitButton.disabled = false;
          submitButton.removeAttribute('aria-busy');
        }
      }
    });
  }

  DJ.submitCollectorInquiry = submitCollectorInquiry;
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-collector-inquiry-form]').forEach(bindCollectorInquiryForm);
  });
})();
