/**
 * Offline page helper.
 * ---------------------------------------------------------------------------
 * Keep the offline fallback lightweight while still giving the user a clear way
 * to retry the current page and understand whether the browser is back online.
 */

(() => {
  function updateOfflineStatus() {
    const status = document.getElementById('offlineNetworkStatus');
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
  }

  document.addEventListener('DOMContentLoaded', () => {
    const requestedPath = document.getElementById('offlineRequestedPath');
    if (requestedPath) {
      requestedPath.textContent = window.location.pathname || '/';
    }

    document.querySelectorAll('[data-offline-retry]').forEach((button) => {
      button.addEventListener('click', () => {
        window.location.reload();
      });
    });

    updateOfflineStatus();
  });

  window.addEventListener('online', updateOfflineStatus);
  window.addEventListener('offline', updateOfflineStatus);
})();
