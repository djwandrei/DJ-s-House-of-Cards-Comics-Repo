window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const REPORT_WINDOWS = new Set([7, 30, 90]);
  const USD_FORMATTER = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const mount = document.getElementById('metricsMount');
  let reportRequestId = 0;

  if (!mount) return;

  function escapeHtml(value = '') {
    return DJ.escapeHtml ? DJ.escapeHtml(String(value ?? '')) : String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function asNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function formatCount(value) {
    return asNumber(value).toLocaleString('en-US');
  }

  function formatPercent(numerator, denominator) {
    if (!asNumber(denominator)) return '—';
    return `${((asNumber(numerator) / asNumber(denominator)) * 100).toFixed(1)}%`;
  }

  function formatCurrency(cents) {
    return USD_FORMATTER.format(asNumber(cents) / 100);
  }

  function formatMilliseconds(value) {
    const milliseconds = asNumber(value);
    return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)}s` : `${Math.round(milliseconds)}ms`;
  }

  function totalContactSubmissions(events = {}) {
    return asNumber(events.contact_submit) + asNumber(events.inquiry_submit);
  }

  function announce(message = '') {
    const status = document.getElementById('metricsLiveStatus');
    if (status) status.textContent = message;
  }

  function metricCard(label, value, note = '') {
    return `<article class="stat-card metrics-card"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong>${note ? `<span class="metrics-section-note">${escapeHtml(note)}</span>` : ''}</article>`;
  }

  function renderLoading(days = 30) {
    mount.innerHTML = '<div class="panel"><p class="metrics-status">Loading private reporting…</p></div>';
    announce(`Loading metrics for the last ${days} days.`);
  }

  function renderAccessMessage(message, isError = false) {
    mount.innerHTML = `<div class="panel"><h2>${isError ? 'Metrics unavailable' : 'Admin sign-in required'}</h2><p class="metrics-status">${escapeHtml(message)}</p><div class="inline-actions compact"><a class="button" href="admin.html">Open Admin Dashboard</a><a class="button-secondary" href="account.html">Open Account</a></div></div>`;
    announce(message);
  }

  function renderReport(report) {
    const events = report?.eventCounts && typeof report.eventCounts === 'object' ? report.eventCounts : {};
    const sales = report?.sales && typeof report.sales === 'object' ? report.sales : {};
    const vitals = report?.webVitals && typeof report.webVitals === 'object' ? report.webVitals : {};
    const topPages = Array.isArray(report?.topPages) ? report.topPages : [];
    const daily = Array.isArray(report?.daily) ? report.daily : [];
    const requestedWindowDays = asNumber(report?.windowDays);
    const windowDays = REPORT_WINDOWS.has(requestedWindowDays) ? requestedWindowDays : 30;
    const checkoutStarts = asNumber(events.begin_checkout);
    const paidOrders = asNumber(sales.paidOrders);
    const latestDays = daily.slice(-7).reverse();

    mount.innerHTML = `
      <div class="panel">
        <div class="metrics-toolbar">
          <label>Reporting window
            <select data-metrics-window aria-label="Reporting window">
              ${[7, 30, 90].map((days) => `<option value="${days}"${days === windowDays ? ' selected' : ''}>Last ${days} days</option>`).join('')}
            </select>
          </label>
          <button class="button-secondary" type="button" data-metrics-refresh>Refresh metrics</button>
        </div>
        <p class="metrics-status">First-party aggregate reporting only. Buyer details, cart contents, and message text are not shown here.</p>
        <div class="metrics-grid">
          ${metricCard('Page views', formatCount(events.page_view), `Last ${windowDays} days`)}
          ${metricCard('Product detail views', formatCount(events.product_open))}
          ${metricCard('Add to cart', formatCount(events.add_to_cart))}
          ${metricCard('Checkout starts', formatCount(checkoutStarts))}
          ${metricCard('Paid website orders', formatCount(paidOrders))}
          ${metricCard('Checkout-to-paid', formatPercent(paidOrders, checkoutStarts), 'Website checkout only')}
          ${metricCard('Bundle requests', formatCount(events.bundle_open))}
          ${metricCard('Offer requests', formatCount(events.offer_open))}
        </div>
        <section class="metrics-section" aria-labelledby="metrics-sales-heading">
          <h2 id="metrics-sales-heading">Website sales</h2>
          <p class="metrics-section-note">Completed orders recorded by the website checkout. Marketplace sales remain in their respective channel dashboards.</p>
          <div class="metrics-grid">
            ${metricCard('Paid revenue', formatCurrency(sales.revenueCents))}
            ${metricCard('Items sold', formatCount(sales.itemsSold))}
            ${metricCard('Guest checkout attempts', formatCount(events.guest_checkout))}
            ${metricCard('Contact submissions', formatCount(totalContactSubmissions(events)))}
          </div>
        </section>
        <section class="metrics-section" aria-labelledby="metrics-performance-heading">
          <h2 id="metrics-performance-heading">Experience measurements</h2>
          <p class="metrics-section-note">Average values from sampled browser measurements in the selected window.</p>
          <div class="metrics-grid">
            ${metricCard('LCP', vitals.lcp ? formatMilliseconds(vitals.lcp) : '—')}
            ${metricCard('INP', vitals.inp ? formatMilliseconds(vitals.inp) : '—')}
            ${metricCard('CLS', vitals.cls ? asNumber(vitals.cls).toFixed(3) : '—')}
            ${metricCard('TTFB', vitals.ttfb ? formatMilliseconds(vitals.ttfb) : '—')}
          </div>
        </section>
        <section class="metrics-section" aria-labelledby="metrics-pages-heading">
          <h2 id="metrics-pages-heading">Most-viewed pages</h2>
          <div class="metrics-table-wrap">
            ${topPages.length ? `<table class="metrics-table"><thead><tr><th scope="col">Page</th><th scope="col">Views</th></tr></thead><tbody>${topPages.map((page) => `<tr><td>${escapeHtml(page.path || '/')}</td><td>${escapeHtml(formatCount(page.views))}</td></tr>`).join('')}</tbody></table>` : '<p class="metrics-empty">No page-view events have been recorded in this reporting window.</p>'}
          </div>
        </section>
        <section class="metrics-section" aria-labelledby="metrics-daily-heading">
          <h2 id="metrics-daily-heading">Recent daily activity</h2>
          <div class="metrics-table-wrap">
            ${latestDays.length ? `<table class="metrics-table"><thead><tr><th scope="col">Date</th><th scope="col">Views</th><th scope="col">Adds</th><th scope="col">Checkout starts</th></tr></thead><tbody>${latestDays.map((day) => `<tr><td>${escapeHtml(day.date || '')}</td><td>${escapeHtml(formatCount(day.pageViews))}</td><td>${escapeHtml(formatCount(day.addToCart))}</td><td>${escapeHtml(formatCount(day.checkoutStarts))}</td></tr>`).join('')}</tbody></table>` : '<p class="metrics-empty">No daily activity has been recorded in this reporting window.</p>'}
          </div>
        </section>
      </div>
    `;
    announce(`Metrics updated for the last ${windowDays} days.`);
  }

  async function loadReport(days = 30) {
    const requestId = ++reportRequestId;
    const normalizedDays = REPORT_WINDOWS.has(Number(days)) ? Number(days) : 30;
    if (!DJ.remoteCatalog?.isConfigured?.()) {
      renderAccessMessage('The Supabase browser connection is not configured on this page.', true);
      return;
    }

    const session = await DJ.remoteCatalog.getSession().catch(() => null);
    if (requestId !== reportRequestId) return;
    if (!session?.user) {
      renderAccessMessage('Sign in with the configured admin account to view this private report.');
      return;
    }

    renderLoading(normalizedDays);
    try {
      const response = await DJ.remoteCatalog.invokeFunction('analytics-report', { days: normalizedDays });
      if (requestId !== reportRequestId) return;
      renderReport(response?.report || {});
    } catch (error) {
      if (requestId !== reportRequestId) return;
      renderAccessMessage(error?.message || 'The metrics report could not be loaded.', true);
    }
  }

  mount.addEventListener('click', (event) => {
    if (!event.target.closest('[data-metrics-refresh]')) return;
    loadReport(mount.querySelector('[data-metrics-window]')?.value);
  });
  mount.addEventListener('change', (event) => {
    if (!event.target.matches('[data-metrics-window]')) return;
    loadReport(event.target.value);
  });

  loadReport();
})();
