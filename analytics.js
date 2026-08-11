/**
 * Small first-party measurement client.
 * It intentionally sends only allowlisted, aggregate interaction data: no names,
 * emails, search terms, cart contents, or persistent browser identifier.
 */

window.DJ = window.DJ || {};

(() => {
  const DJ = window.DJ;
  const config = window.DJ_BACKEND_CONFIG || {};
  let vitalsSent = false;
  let largestContentfulPaint = 0;
  let cumulativeLayoutShift = 0;
  let interactionLatency = 0;

  function currentPagePath() {
    const path = String(window.location.pathname || '/').replace(/\/+/g, '/');
    return path.startsWith('/') ? path : `/${path}`;
  }

  function endpoint() {
    if (
      config.measurementEnabled !== true
      || !config.supabaseUrl
      || !config.supabasePublishableKey
      || !config.analyticsEventFunction
    ) return '';
    return `${String(config.supabaseUrl).replace(/\/+$/, '')}/functions/v1/${encodeURIComponent(config.analyticsEventFunction)}`;
  }

  function compactData(data = {}) {
    const source = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    const number = (value, maximum) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? Math.round(parsed * 100) / 100 : undefined;
    };
    const text = (value, maximum) => String(value || '').trim().slice(0, maximum);
    const productId = number(source.productId, 9_999_999_999);
    const resultCount = number(source.resultCount, 100_000);
    const queryLength = number(source.queryLength, 200);
    const filterCount = number(source.filterCount, 100);
    const lcp = number(source.lcp, 120_000);
    const cls = number(source.cls, 100);
    const inp = number(source.inp, 120_000);
    const ttfb = number(source.ttfb, 120_000);
    const domContentLoaded = number(source.domContentLoaded, 120_000);
    const load = number(source.load, 120_000);
    return {
      ...(productId !== undefined ? { productId } : {}),
      ...(resultCount !== undefined ? { resultCount } : {}),
      ...(queryLength !== undefined ? { queryLength } : {}),
      ...(filterCount !== undefined ? { filterCount } : {}),
      ...(lcp !== undefined ? { lcp } : {}),
      ...(cls !== undefined ? { cls } : {}),
      ...(inp !== undefined ? { inp } : {}),
      ...(ttfb !== undefined ? { ttfb } : {}),
      ...(domContentLoaded !== undefined ? { domContentLoaded } : {}),
      ...(load !== undefined ? { load } : {}),
      ...(text(source.category, 80) ? { category: text(source.category, 80) } : {}),
      ...(text(source.kind, 40) ? { kind: text(source.kind, 40) } : {})
    };
  }

  function trackEvent(event, data = {}) {
    const url = endpoint();
    if (!url || !event) return;
    const payload = JSON.stringify({ event: String(event).slice(0, 40), page: currentPagePath(), data: compactData(data) });
    // Keep this fire-and-forget so measurement cannot delay catalog rendering,
    // checkout redirects, or form submission feedback.
    fetch(url, {
      method: 'POST',
      headers: {
        apikey: config.supabasePublishableKey,
        'Content-Type': 'application/json'
      },
      body: payload,
      keepalive: true,
      credentials: 'omit'
    }).catch(() => {});
  }

  function observeVitals() {
    if (!('PerformanceObserver' in window)) return;
    try {
      new PerformanceObserver((entries) => {
        entries.getEntries().forEach((entry) => {
          largestContentfulPaint = Math.max(largestContentfulPaint, entry.startTime || 0);
        });
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((entries) => {
        entries.getEntries().forEach((entry) => {
          if (!entry.hadRecentInput) cumulativeLayoutShift += entry.value || 0;
        });
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((entries) => {
        entries.getEntries().forEach((entry) => {
          interactionLatency = Math.max(interactionLatency, entry.duration || 0);
        });
      }).observe({ type: 'event', buffered: true, durationThreshold: 40 });
    } catch {}
  }

  function sendVitals() {
    if (vitalsSent) return;
    vitalsSent = true;
    const navigation = performance.getEntriesByType?.('navigation')?.[0];
    trackEvent('web_vitals', {
      lcp: largestContentfulPaint,
      cls: cumulativeLayoutShift,
      inp: interactionLatency,
      ttfb: navigation?.responseStart,
      domContentLoaded: navigation?.domContentLoadedEventEnd,
      load: navigation?.loadEventEnd
    });
  }

  DJ.trackEvent = trackEvent;
  observeVitals();
  document.addEventListener('DOMContentLoaded', () => trackEvent('page_view'), { once: true });
  window.addEventListener('pagehide', sendVitals, { once: true });
})();
