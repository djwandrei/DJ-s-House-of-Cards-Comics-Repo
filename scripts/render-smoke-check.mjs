import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const EDGE_PATHS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'
];
const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2']
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function edgePath() {
  const configured = process.env.EDGE_PATH || process.env.CHROME_PATH || '';
  if (configured && existsSync(configured)) return configured;
  const found = EDGE_PATHS.find((candidate) => existsSync(candidate));
  if (!found) throw new Error('No Edge/Chrome executable was found for rendered smoke checks.');
  return found;
}

function safeLocalPath(requestUrl) {
  const url = new URL(requestUrl, 'http://127.0.0.1/');
  let pathname = decodeURIComponent(url.pathname);
  if (!pathname || pathname === '/') pathname = '/index.html';
  const fullPath = path.resolve(ROOT, `.${pathname}`);
  if (!fullPath.startsWith(ROOT)) return null;
  return fullPath;
}

function startStaticServer() {
  const server = createServer((request, response) => {
    const fullPath = safeLocalPath(request.url || '/');
    if (!fullPath || !existsSync(fullPath) || !statSync(fullPath).isFile()) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES.get(path.extname(fullPath).toLowerCase()) || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    createReadStream(fullPath).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function fetchJson(url, attempts = 80) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(websocket) {
    this.websocket = websocket;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    websocket.onmessage = (event) => this.handleMessage(JSON.parse(event.data));
  }

  handleMessage(payload) {
    if (payload.id && this.pending.has(payload.id)) {
      const pending = this.pending.get(payload.id);
      this.pending.delete(payload.id);
      if (payload.error) {
        pending.reject(new Error(payload.error.message || JSON.stringify(payload.error)));
      } else {
        pending.resolve(payload.result || {});
      }
      return;
    }
    if (payload.method) this.events.push(payload);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    this.websocket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Runtime exception');
    }
    return result.result?.value;
  }

  consumeEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}

async function connectBrowser(debugUrl) {
  const targets = await fetchJson(`${debugUrl}/json/list`);
  const page = targets.find((item) => item.type === 'page') || targets[0];
  if (!page?.webSocketDebuggerUrl) throw new Error('No debuggable browser page target found.');
  const websocket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    websocket.onopen = resolve;
    websocket.onerror = () => reject(new Error('Failed to connect to browser WebSocket.'));
  });
  const client = new CdpClient(websocket);
  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Log.enable');
  return client;
}

async function navigate(client, url) {
  await client.send('Page.navigate', { url });
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await client.evaluate('document.readyState') === 'complete') break;
    await delay(100);
  }
  await delay(900);
}

function eventFailures(events) {
  return events
    .filter((event) => (
      event.method === 'Runtime.exceptionThrown'
      || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error')
    ))
    .map((event) => event.params?.entry?.text || event.params?.exceptionDetails?.text || event.method)
    .slice(0, 10);
}

async function inspectDesktopPage(client, baseUrl, page) {
  client.consumeEvents();
  await navigate(client, `${baseUrl}${page.path}${page.path.includes('?') ? '&' : '?'}smokeVersion=20260812a`);
  if (page.expect?.modal) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await client.evaluate('Boolean(document.querySelector("#productModal.active"))')) break;
      await delay(150);
    }
  }
  const metrics = await client.evaluate(`(() => {
    const modal = document.querySelector('#productModal.active');
    const brokenImages = Array.from(document.images)
      .filter((image) => image.complete && image.naturalWidth === 0)
      .map((image) => image.currentSrc || image.src)
      .slice(0, 10);
    return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent?.trim() || '',
      productCards: document.querySelectorAll('.product-card[data-product-id]').length,
      modalOpen: !!modal,
      modalCloseVisible: !!modal?.querySelector('.modal-close')?.getBoundingClientRect().width,
      accountForm: !!document.getElementById('accountProfileForm'),
      accountAddressFields: ['addressLine1', 'addressCity', 'addressState', 'addressPostalCode', 'addressCountry']
        .every((field) => !!document.getElementById('account_' + field)),
      cartContainer: !!document.getElementById('cartContainer'),
      policyContent: !!document.querySelector('.policy-content'),
      metricsMount: !!document.getElementById('metricsMount'),
      footer: !!document.querySelector('footer'),
      brokenImages,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth
    };
  })()`);
  const failures = [];
  if (!metrics.h1) failures.push('missing h1');
  if (!metrics.footer) failures.push('missing footer');
  if (metrics.brokenImages.length) failures.push('broken images');
  if (metrics.overflow > 2) failures.push(`horizontal overflow ${metrics.overflow}`);
  if (page.expect?.minCards && metrics.productCards < page.expect.minCards) failures.push(`expected at least ${page.expect.minCards} product cards`);
  if (page.expect?.catalog && metrics.productCards < 1) failures.push('catalog did not render cards');
  if (page.expect?.modal && (!metrics.modalOpen || !metrics.modalCloseVisible)) failures.push('linked product modal did not open visibly');
  if (page.expect?.account && !metrics.accountForm) failures.push('account form missing');
  if (page.expect?.account && !metrics.accountAddressFields) failures.push('saved address fields missing');
  if (page.expect?.cart && !metrics.cartContainer) failures.push('cart container missing');
  if (page.expect?.policy && !metrics.policyContent) failures.push('policy content missing');
  if (page.expect?.metrics && !metrics.metricsMount) failures.push('metrics mount missing');
  return {
    label: page.label,
    metrics,
    badEvents: eventFailures(client.consumeEvents()),
    failures
  };
}

async function inspectMobileFlow(client, baseUrl) {
  client.consumeEvents();
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
    screenWidth: 390,
    screenHeight: 844
  });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await navigate(client, `${baseUrl}/baseball-cards.html?smoke=mobile&smokeVersion=20260812a`);
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await client.evaluate('document.querySelectorAll(".product-card[data-product-id]").length > 0 && !!document.querySelector(".mobile-filter-trigger")');
    if (ready) break;
    await delay(150);
  }
  const state = await client.evaluate(`(async () => {
    const trigger = document.querySelector('.mobile-filter-trigger');
    const navToggle = document.getElementById('navToggle');
    const nav = document.getElementById('siteNav');
    trigger?.click();
    await new Promise((resolve) => setTimeout(resolve, 350));
    const filterPanel = document.querySelector('.filter-panel');
    const filterOpen = document.body.classList.contains('filters-open') && filterPanel && filterPanel.hidden === false;
    document.querySelector('.filter-panel-dismiss')?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    navToggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 180));
    const navOpen = nav?.classList.contains('open') && navToggle?.getAttribute('aria-expanded') === 'true';
    navToggle?.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    document.querySelector('.product-card[data-product-id]')?.click();
    for (let attempt = 0; attempt < 25; attempt += 1) {
      if (document.querySelector('#productModal.active')) break;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
    const modal = document.querySelector('#productModal.active');
    const closeRect = modal?.querySelector('.modal-close')?.getBoundingClientRect();
    return {
      productCards: document.querySelectorAll('.product-card[data-product-id]').length,
      triggerPresent: !!trigger,
      filterOpen: !!filterOpen,
      navOpen: !!navOpen,
      modalOpen: !!modal,
      modalCloseWithinViewport: !!closeRect && closeRect.top >= 0 && closeRect.right <= window.innerWidth && closeRect.bottom <= window.innerHeight,
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth
    };
  })()`);
  const failures = [];
  if (!state.triggerPresent || !state.filterOpen) failures.push('mobile filter drawer did not open');
  if (!state.navOpen) failures.push('mobile nav did not open');
  if (!state.modalOpen || !state.modalCloseWithinViewport) failures.push('mobile product modal close not visible');
  if (state.overflow > 2) failures.push(`mobile horizontal overflow ${state.overflow}`);
  return {
    label: 'mobile baseball flow',
    state,
    badEvents: eventFailures(client.consumeEvents()),
    failures
  };
}

async function setViewport(client, width) {
  await client.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: width <= 900 ? 2 : 1,
    mobile: width <= 900,
    screenWidth: width,
    screenHeight: 900
  });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: width <= 900 });
  await delay(240);
}

async function inspectResponsiveDrawerContracts(client, baseUrl) {
  const widths = [390, 700, 900, 901, 1024, 1180, 1280];
  const results = [];
  await setViewport(client, 1280);
  await navigate(client, `${baseUrl}/baseball-cards.html?smoke=responsive&smokeVersion=20260813b`);
  for (const width of widths) {
    await setViewport(client, width);
    const state = await client.evaluate(`(async () => {
      const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
      const focusable = (container) => Array.from(container?.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') || [])
        .filter((element) => element.getClientRects().length > 0 && !element.closest('[hidden]'));
      const key = (keyName, shiftKey = false) => document.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, shiftKey, bubbles: true }));
      const width = ${width};
      const compactNav = width <= 1180;
      const mobileFilters = width <= 900;
      const nav = document.getElementById('siteNav');
      const navToggle = document.getElementById('navToggle');
      const filterPanel = document.querySelector('.filter-panel');
      const filterTrigger = document.querySelector('.mobile-filter-trigger');
      const navToggleVisible = !!navToggle && getComputedStyle(navToggle).display !== 'none' && !navToggle.hidden;
      const outcome = {
        width,
        navToggleVisible,
        navClosedHidden: !!nav?.hidden,
        navClosedAriaHidden: nav?.getAttribute('aria-hidden') || '',
        navOpen: false,
        navFocusEntered: false,
        navTabTrapped: false,
        navShiftTabTrapped: false,
        navEscapeClosed: false,
        navFocusRestored: false,
        navOutsideClosed: false,
        filterTriggerVisible: !!filterTrigger && !filterTrigger.hidden && getComputedStyle(filterTrigger).display !== 'none',
        filterDialogOpen: false,
        filterBackgroundInert: false,
        filterTabTrapped: false,
        filterShiftTabTrapped: false,
        filterEscapeClosed: false,
        filterFocusRestored: false,
        filterOutsideClosed: false,
        desktopFilterSemanticReset: false,
        galleryControlsOverlay: false,
        galleryButtonSmaller: false,
        galleryArrowChangedImage: false,
        gallerySwipeChangedImage: false,
        cartFeedbackVisible: false
      };

      if (compactNav && navToggleVisible) {
        navToggle.focus();
        navToggle.click();
        await pause(120);
        const navFocusables = focusable(nav);
        outcome.navOpen = nav?.classList.contains('open') && navToggle.getAttribute('aria-expanded') === 'true' && nav?.getAttribute('aria-hidden') === 'false' && !nav?.hasAttribute('inert');
        outcome.navFocusEntered = !!nav && nav.contains(document.activeElement);
        if (navFocusables.length > 1) {
          const first = navFocusables[0];
          const last = navFocusables[navFocusables.length - 1];
          last.focus();
          key('Tab');
          outcome.navTabTrapped = document.activeElement === first;
          first.focus();
          key('Tab', true);
          outcome.navShiftTabTrapped = document.activeElement === last;
        }
        key('Escape');
        await pause(80);
        outcome.navEscapeClosed = !nav?.classList.contains('open') && navToggle.getAttribute('aria-expanded') === 'false';
        outcome.navFocusRestored = document.activeElement === navToggle;
        navToggle.focus();
        navToggle.click();
        await pause(80);
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await pause(80);
        outcome.navOutsideClosed = !nav?.classList.contains('open');
      }

      if (mobileFilters && filterTrigger) {
        filterTrigger.focus();
        filterTrigger.click();
        await pause(120);
        const filterFocusables = focusable(filterPanel);
        outcome.filterDialogOpen = filterPanel?.getAttribute('role') === 'dialog'
          && filterPanel?.getAttribute('aria-modal') === 'true'
          && filterPanel?.hidden === false;
        outcome.filterBackgroundInert = document.querySelector('.site-header')?.hasAttribute('inert')
          && document.querySelector('.catalog-results-column')?.hasAttribute('inert');
        if (filterFocusables.length > 1) {
          const first = filterFocusables[0];
          const last = filterFocusables[filterFocusables.length - 1];
          last.focus();
          key('Tab');
          outcome.filterTabTrapped = document.activeElement === first;
          first.focus();
          key('Tab', true);
          outcome.filterShiftTabTrapped = document.activeElement === last;
        }
        key('Escape');
        await pause(80);
        outcome.filterEscapeClosed = filterPanel?.hidden === true && !document.body.classList.contains('filters-open') && !document.querySelector('.site-header')?.hasAttribute('inert');
        outcome.filterFocusRestored = document.activeElement === filterTrigger;
        filterTrigger.click();
        await pause(80);
        document.querySelector('.mobile-filter-overlay')?.click();
        await pause(80);
        outcome.filterOutsideClosed = filterPanel?.hidden === true && !document.body.classList.contains('filters-open');
      } else if (!mobileFilters && filterPanel) {
        outcome.desktopFilterSemanticReset = filterPanel.hidden === false
          && !filterPanel.hasAttribute('role')
          && !filterPanel.hasAttribute('aria-modal');
      }

      const galleryCard = Array.from(document.querySelectorAll('.product-card[data-product-id]'))
        .find((card) => card.querySelector('.product-card-gallery-button--next'));
      const galleryMedia = galleryCard?.querySelector('[data-card-gallery]');
      const galleryNext = galleryCard?.querySelector('.product-card-gallery-button--next');
      const galleryPrevious = galleryCard?.querySelector('.product-card-gallery-button--prev');
      if (galleryCard && galleryMedia && galleryNext && galleryPrevious) {
        const mediaRect = galleryMedia.getBoundingClientRect();
        const nextRect = galleryNext.getBoundingClientRect();
        const previousRect = galleryPrevious.getBoundingClientRect();
        const before = galleryMedia.dataset.cardGalleryIndex || '0';
        outcome.galleryControlsOverlay = previousRect.left >= mediaRect.left
          && nextRect.right <= mediaRect.right
          && previousRect.top >= mediaRect.top
          && nextRect.bottom <= mediaRect.bottom;
        outcome.galleryButtonSmaller = nextRect.width <= 34 && nextRect.height <= 40;
        galleryNext.click();
        await pause(40);
        const afterArrow = galleryMedia.dataset.cardGalleryIndex || '0';
        outcome.galleryArrowChangedImage = afterArrow !== before;
        if (width <= 900) {
          const swipeBefore = galleryMedia.dataset.cardGalleryIndex || '0';
          galleryMedia.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 41, pointerType: 'touch', clientX: 180, clientY: 120 }));
          galleryMedia.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 41, pointerType: 'touch', clientX: 60, clientY: 120 }));
          await pause(40);
          outcome.gallerySwipeChangedImage = (galleryMedia.dataset.cardGalleryIndex || '0') !== swipeBefore;
        }
      }

      const addButton = Array.from(document.querySelectorAll('[data-product-cart]'))
        .find((button) => button.closest('.product-card') !== galleryCard)
        || document.querySelector('[data-product-cart]');
      if (addButton) {
        localStorage.setItem('cart', '[]');
        window.DJ?.updateCartCount?.();
        addButton.click();
        await pause(40);
        const feedback = document.getElementById('catalogCartFeedback');
        outcome.cartFeedbackVisible = !!feedback && !feedback.hidden && /added to cart/i.test(feedback.textContent || '');
      }
      return outcome;
    })()`);
    const failures = [];
    const compactNav = width <= 1180;
    const mobileFilters = width <= 900;
    if (state.navToggleVisible !== compactNav) failures.push(`nav-toggle visibility does not match compact breakpoint at ${width}px`);
    if (compactNav) {
      if (!state.navClosedHidden || state.navClosedAriaHidden !== 'true') failures.push(`closed nav accessibility state is wrong at ${width}px`);
      for (const key of ['navOpen', 'navFocusEntered', 'navTabTrapped', 'navShiftTabTrapped', 'navEscapeClosed', 'navFocusRestored', 'navOutsideClosed']) {
        if (!state[key]) failures.push(`${key} failed at ${width}px`);
      }
    }
    if (state.filterTriggerVisible !== mobileFilters) failures.push(`filter trigger visibility does not match 900px contract at ${width}px`);
    if (mobileFilters) {
      for (const key of ['filterDialogOpen', 'filterBackgroundInert', 'filterTabTrapped', 'filterShiftTabTrapped', 'filterEscapeClosed', 'filterFocusRestored', 'filterOutsideClosed']) {
        if (!state[key]) failures.push(`${key} failed at ${width}px`);
      }
    } else if (!state.desktopFilterSemanticReset) {
      failures.push(`desktop filter semantics were not restored at ${width}px`);
    }
    for (const key of ['galleryControlsOverlay', 'galleryButtonSmaller', 'galleryArrowChangedImage', 'cartFeedbackVisible']) {
      if (!state[key]) failures.push(`${key} failed at ${width}px`);
    }
    if (mobileFilters && !state.gallerySwipeChangedImage) failures.push(`gallerySwipeChangedImage failed at ${width}px`);
    results.push({ label: `responsive drawer contract ${width}px`, state, failures });
  }
  return results;
}

async function main() {
  const server = await startStaticServer();
  const port = server.address().port;
  const debugPort = 9400 + Math.floor(Math.random() * 300);
  const profileDir = path.join(tmpdir(), `djhc-render-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const browser = spawn(edgePath(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = await connectBrowser(`http://127.0.0.1:${debugPort}`);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 1000
    });
    const desktopPages = [
      { label: 'home', path: '/', expect: { minCards: 7 } },
      { label: 'baseball category', path: '/baseball-cards.html?search=rookie', expect: { catalog: true } },
      { label: 'baseball linked item', path: '/baseball-cards.html?item=6', expect: { modal: true } },
      { label: 'account', path: '/account.html', expect: { account: true } },
      { label: 'cart', path: '/cart.html', expect: { cart: true } },
      { label: 'policies and authenticity', path: '/policies.html', expect: { policy: true } },
      { label: 'private metrics', path: '/metrics.html', expect: { metrics: true } }
    ];
    const desktop = [];
    for (const page of desktopPages) {
      desktop.push(await inspectDesktopPage(client, baseUrl, page));
    }
    const mobile = await inspectMobileFlow(client, baseUrl);
    const responsive = await inspectResponsiveDrawerContracts(client, baseUrl);
    client.websocket.close();

    const allFailures = [
      ...desktop.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...desktop.flatMap((item) => item.badEvents.map((event) => `${item.label}: ${event}`)),
      ...mobile.failures.map((failure) => `${mobile.label}: ${failure}`),
      ...mobile.badEvents.map((event) => `${mobile.label}: ${event}`),
      ...responsive.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`))
    ];
    const summary = {
      ok: allFailures.length === 0,
      baseUrl,
      desktop,
      mobile,
      responsive,
      failures: allFailures
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    browser.kill();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
