/**
 * Static contact form helper.
 * -----------------------------------------------------------------------------
 * The site remains a static frontend, so the contact page builds a mailto link
 * instead of posting to a backend. This file validates the required fields first
 * so the user gets immediate feedback before their email client opens.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  let mailtoFallbackTimer = 0;
  let contactDraftTimer = 0;
  let mailtoHandoffPending = false;
  const CONTACT_EMAIL = 'djscardscomics13@gmail.com';
  const CONTACT_DRAFT_KEY = 'djContactDraftV1';
  const CONTACT_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
  const CONTACT_DRAFT_FIELDS = ['name', 'email', 'subject', 'message'];
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CONTACT_TOPICS = {
    buying: {
      subject: 'Buying Inquiry',
      prompt: "I'm interested in this item or category:",
      status: 'Buying inquiry selected. Add the item name, listing ID, or link before creating the email draft.'
    },
    trade: {
      subject: 'Trade Discussion',
      prompt: "I'd like to discuss a trade involving:",
      status: 'Trade discussion selected. Add what you have, what you are looking for, and any condition details.'
    },
    sell: {
      subject: 'Sell or Consign',
      prompt: "I'd like to sell or consign:",
      status: 'Sell or consign selected. Add the item, year, condition, asking range, and photo notes if available.'
    }
  };

  function getFieldValue(form, fieldName) {
    const field = form?.elements?.namedItem(fieldName);
    if (!field || typeof field.value !== 'string') return '';
    return field.value.trim();
  }

  function focusField(form, fieldName) {
    const field = form?.elements?.namedItem(fieldName);
    if (field && typeof field.focus === 'function') {
      field.focus();
    }
  }

  function readContactDraft() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CONTACT_DRAFT_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const updatedAt = Date.parse(parsed.updatedAt || '');
      if (Number.isFinite(updatedAt) && Date.now() - updatedAt > CONTACT_DRAFT_MAX_AGE_MS) {
        localStorage.removeItem(CONTACT_DRAFT_KEY);
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  function writeContactDraft(form) {
    try {
      const draft = CONTACT_DRAFT_FIELDS.reduce((payload, fieldName) => {
        payload[fieldName] = getFieldValue(form, fieldName);
        return payload;
      }, { updatedAt: new Date().toISOString() });

      if (CONTACT_DRAFT_FIELDS.some((fieldName) => draft[fieldName])) {
        localStorage.setItem(CONTACT_DRAFT_KEY, JSON.stringify(draft));
      } else {
        localStorage.removeItem(CONTACT_DRAFT_KEY);
      }
    } catch {
      // Contact drafts are a convenience only; blocked storage should not stop the form.
    }
  }

  function scheduleContactDraftSave(form) {
    window.clearTimeout(contactDraftTimer);
    contactDraftTimer = window.setTimeout(() => {
      contactDraftTimer = 0;
      writeContactDraft(form);
    }, 180);
  }

  function restoreContactDraft(form) {
    const draft = readContactDraft();
    let restored = false;
    CONTACT_DRAFT_FIELDS.forEach((fieldName) => {
      const field = form.elements.namedItem(fieldName);
      if (!field || typeof field.value !== 'string' || field.value.trim() || !draft[fieldName]) return;
      field.value = String(draft[fieldName]);
      restored = true;
    });

    if (restored) {
      DJ.setStatus('contactStatus', 'Restored your saved contact draft from this browser.', 'info');
    }
  }

  function clearContactDraft() {
    window.clearTimeout(contactDraftTimer);
    contactDraftTimer = 0;
    try {
      localStorage.removeItem(CONTACT_DRAFT_KEY);
    } catch {
      // Ignore blocked storage cleanup.
    }
  }

  function initContactTopics(form) {
    const topicLinks = [...document.querySelectorAll('[data-contact-topic]')];
    if (!topicLinks.length || form.dataset.boundContactTopics === 'true') return;
    form.dataset.boundContactTopics = 'true';

    topicLinks.forEach((link) => {
      link.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

        const topic = CONTACT_TOPICS[link.dataset.contactTopic];
        if (!topic) return;

        event.preventDefault();
        const subjectField = form.elements.namedItem('subject');
        const messageField = form.elements.namedItem('message');

        if (subjectField && typeof subjectField.value === 'string') {
          subjectField.value = topic.subject;
        }

        if (messageField && typeof messageField.value === 'string' && !messageField.value.trim()) {
          messageField.value = `${topic.prompt}\n\n`;
        }

        topicLinks.forEach((candidate) => candidate.classList.toggle('is-selected', candidate === link));
        DJ.setStatus('contactStatus', topic.status, 'info');
        writeContactDraft(form);
        focusField(form, 'message');
      });
    });
  }

  /**
   * Attach validation to the static contact form and build the outgoing mailto link.
   */
  function initContactForm() {
    const form = document.getElementById('contactForm');
    if (!form || form.dataset.boundContactForm === 'true') {
      return;
    }
    form.dataset.boundContactForm = 'true';

    const submitButton = form.querySelector('button[type="submit"]');
    restoreContactDraft(form);
    initContactTopics(form);

    const setSubmittingState = (isSubmitting) => {
      if (!submitButton) return;
      submitButton.disabled = isSubmitting;
      submitButton.setAttribute('aria-busy', String(isSubmitting));
    };

    const clearFallbackState = () => {
      if (mailtoFallbackTimer) {
        window.clearTimeout(mailtoFallbackTimer);
        mailtoFallbackTimer = 0;
      }
      if (mailtoHandoffPending) {
        clearContactDraft();
        mailtoHandoffPending = false;
      }
      setSubmittingState(false);
    };

    form.addEventListener('input', () => scheduleContactDraftSave(form));
    form.addEventListener('change', () => writeContactDraft(form));

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      window.clearTimeout(mailtoFallbackTimer);
      DJ.setStatus('contactStatus');
      setSubmittingState(true);

      const name = getFieldValue(form, 'name');
      const email = getFieldValue(form, 'email');
      const subject = getFieldValue(form, 'subject') || 'Website Inquiry';
      const message = getFieldValue(form, 'message');

      if (!name || !email || !message) {
        DJ.setStatus(
          'contactStatus',
          'Please complete your name, email, and message before creating the email draft.',
          'error'
        );
        focusField(form, !name ? 'name' : !email ? 'email' : 'message');
        setSubmittingState(false);
        return;
      }

      if (!EMAIL_PATTERN.test(email)) {
        DJ.setStatus(
          'contactStatus',
          'Enter a valid email address before creating the email draft.',
          'error'
        );
        focusField(form, 'email');
        setSubmittingState(false);
        return;
      }

      DJ.setStatus('contactStatus', 'Opening your email app with a prefilled draft...', 'success');

      const encodedSubject = encodeURIComponent(`Website Inquiry: ${subject}`);
      const encodedBody = encodeURIComponent(
        `Hello DJ,\n\nName: ${name}\nEmail: ${email}\nPage: ${window.location.href}\n\n${message}\n`
      );
      mailtoFallbackTimer = window.setTimeout(() => {
        mailtoFallbackTimer = 0;
        mailtoHandoffPending = false;
        DJ.setStatus(
          'contactStatus',
          `If your email app did not open, send your message to ${CONTACT_EMAIL} and mention the subject line you entered above.`,
          'info'
        );
        setSubmittingState(false);
      }, 1400);
      mailtoHandoffPending = true;
      window.location.assign(`mailto:${CONTACT_EMAIL}?subject=${encodedSubject}&body=${encodedBody}`);
      window.setTimeout(() => {
        setSubmittingState(false);
      }, 300);
    });

    // When the browser leaves this page for the user's email client, treat that
    // as a successful handoff and cancel the stale fallback message/timer.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        clearFallbackState();
      }
    });

    window.addEventListener('pagehide', clearFallbackState);
  }

  // Wait for the contact form markup to exist before attaching listeners.
  document.addEventListener('DOMContentLoaded', initContactForm);
})();


