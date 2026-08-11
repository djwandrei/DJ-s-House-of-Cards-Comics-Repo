/**
 * Contact form helper.
 * The form keeps a short local draft, then submits through the rate-limited
 * collector inquiry service. Direct email remains a visible fallback.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const DRAFT_KEY = 'djContactDraftV2';
  const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const FIELDS = ['name', 'email', 'subject', 'message'];
  const TOPICS = {
    buying: { subject: 'Buying Inquiry', prompt: "I'm interested in this item or category:", kind: 'contact' },
    trade: { subject: 'Trade Discussion', prompt: "I'd like to discuss a trade involving:", kind: 'trade' },
    sell: { subject: 'Sell or Consign', prompt: "I'd like to sell or consign:", kind: 'sell' }
  };

  function field(form, name) {
    const control = form?.elements?.namedItem(name);
    return control && typeof control.value === 'string' ? control : null;
  }

  function value(form, name) {
    return field(form, name)?.value.trim() || '';
  }

  function setStatus(message = '', tone = 'info') {
    DJ.setStatus('contactStatus', message, tone);
  }

  function setInvalid(form, name, invalid) {
    const control = field(form, name);
    if (!control) return;
    if (invalid) control.setAttribute('aria-invalid', 'true');
    else control.removeAttribute('aria-invalid');
  }

  function saveDraft(form) {
    try {
      const draft = Object.fromEntries(FIELDS.map((name) => [name, value(form, name)]));
      if (Object.values(draft).some(Boolean)) localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...draft, updatedAt: Date.now() }));
      else localStorage.removeItem(DRAFT_KEY);
    } catch {}
  }

  function restoreDraft(form) {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}');
      if (!draft || Date.now() - Number(draft.updatedAt || 0) > DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      const restored = FIELDS.some((name) => {
        const control = field(form, name);
        if (!control || control.value || !draft[name]) return false;
        control.value = String(draft[name]);
        return true;
      });
      if (restored) setStatus('Restored your saved contact draft from this browser.', 'info');
    } catch {}
  }

  function clearDraft() {
    try { localStorage.removeItem(DRAFT_KEY); } catch {}
  }

  function initTopics(form) {
    document.querySelectorAll('[data-contact-topic]').forEach((button) => {
      button.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const topic = TOPICS[button.dataset.contactTopic];
        if (!topic) return;
        event.preventDefault();
        field(form, 'subject').value = topic.subject;
        const message = field(form, 'message');
        if (message && !message.value.trim()) message.value = `${topic.prompt}\n\n`;
        field(form, 'kind').value = topic.kind;
        document.querySelectorAll('[data-contact-topic]').forEach((candidate) => candidate.classList.toggle('is-selected', candidate === button));
        setStatus('Topic selected. Add the details DJ needs, then send your message.', 'info');
        saveDraft(form);
        message?.focus();
      });
    });
  }

  function initContactForm() {
    const form = document.getElementById('contactForm');
    if (!form || form.dataset.boundContactForm === 'true') return;
    form.dataset.boundContactForm = 'true';
    const submitButton = form.querySelector('button[type="submit"]');
    restoreDraft(form);
    initTopics(form);

    form.addEventListener('input', (event) => {
      if (FIELDS.includes(event.target?.name)) setInvalid(form, event.target.name, false);
      saveDraft(form);
    });
    form.addEventListener('change', () => saveDraft(form));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = value(form, 'name');
      const email = value(form, 'email');
      const message = value(form, 'message');
      const kind = value(form, 'kind') || 'contact';
      FIELDS.forEach((name) => setInvalid(form, name, false));
      if (!name || !EMAIL_PATTERN.test(email) || !message) {
        setInvalid(form, 'name', !name);
        setInvalid(form, 'email', !EMAIL_PATTERN.test(email));
        setInvalid(form, 'message', !message);
        setStatus('Please provide your name, a valid email address, and a message.', 'error');
        field(form, !name ? 'name' : !EMAIL_PATTERN.test(email) ? 'email' : 'message')?.focus();
        return;
      }

      submitButton.disabled = true;
      submitButton.setAttribute('aria-busy', 'true');
      setStatus('Sending your message securely…', 'info');
      try {
        await DJ.submitCollectorInquiry({
          kind,
          name,
          email,
          subject: value(form, 'subject') || 'Website Inquiry',
          message,
          sourcePath: `${window.location.pathname}${window.location.search}`,
          website: value(form, 'website')
        }, form.elements.namedItem('photos')?.files || []);
        form.reset();
        clearDraft();
        setStatus('Thanks — DJ received your message and will follow up by email.', 'success');
        DJ.trackEvent?.('contact_submit', { kind });
      } catch (error) {
        setStatus(error?.message || 'Could not send your message. Please use the direct email link.', 'error');
      } finally {
        submitButton.disabled = false;
        submitButton.removeAttribute('aria-busy');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initContactForm);
})();
