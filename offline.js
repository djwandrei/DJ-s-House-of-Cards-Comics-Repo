/**
 * Offline page helper.
 * ---------------------------------------------------------------------------
 * Keep the offline fallback lightweight while still giving the user a clear way
 * to retry the current page and understand whether the browser is back online.
 */

(() => {
  function normalizeRequestedPath(value) {
    const candidate = String(value || '').trim();
    if (!candidate) return '';
    try {
      const url = new URL(candidate, window.location.origin);
      if (url.origin !== window.location.origin) return '/';
      return `${url.pathname}${url.search || ''}${url.hash || ''}`;
    } catch {
      return '/';
    }
  }

  function getRequestedPath() {
    const params = new URLSearchParams(window.location.search);
    const requested = normalizeRequestedPath(params.get('from') || params.get('url') || '');
    if (requested) return requested;
    if (window.location.pathname && !window.location.pathname.endsWith('/offline.html')) {
      return `${window.location.pathname}${window.location.search || ''}`;
    }
    try {
      const referrer = new URL(document.referrer);
      if (referrer.origin === window.location.origin) {
        return `${referrer.pathname}${referrer.search || ''}`;
      }
    } catch {
      // Referrer is optional and may be blank or unavailable.
    }
    return '/';
  }

  function updateOfflineStatus() {
    const status = document.getElementById('offlineNetworkStatus');
    const statusPill = document.getElementById('offlineStatusPill');
    const body = document.body;
    const isOnline = navigator.onLine;

    if (body) {
      body.classList.toggle('is-online', isOnline);
      body.classList.toggle('is-offline', !isOnline);
    }

    if (status) {
      status.textContent = isOnline
        ? 'Connection detected. You can try loading this page again.'
        : 'Still offline. Cached pages may still work until the connection returns.';
    }

    if (statusPill) {
      statusPill.textContent = isOnline ? 'Online' : 'Offline';
      statusPill.dataset.state = isOnline ? 'online' : 'offline';
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const requestedPath = document.getElementById('offlineRequestedPath');
    const requestedUrl = getRequestedPath();
    if (requestedPath) {
      requestedPath.textContent = requestedUrl;
    }

    document.querySelectorAll('[data-offline-retry]').forEach((button) => {
      button.addEventListener('click', () => {
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        button.textContent = 'Retrying...';
        if (requestedUrl && requestedUrl !== '/' && !requestedUrl.includes('/offline.html')) {
          window.location.assign(requestedUrl);
          return;
        }
        window.location.reload();
      });
    });

    updateOfflineStatus();
  });

  window.addEventListener('online', updateOfflineStatus);
  window.addEventListener('offline', updateOfflineStatus);
})();
