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
  const CONTACT_EMAIL = 'contact@djshouseofcards-comics.com';
  const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
      setSubmittingState(false);
    };

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
        DJ.setStatus(
          'contactStatus',
          `If your email app did not open, send your message to ${CONTACT_EMAIL} and mention the subject line you entered above.`,
          'info'
        );
        setSubmittingState(false);
      }, 1400);
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
