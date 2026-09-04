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
const PUBLIC_PAGE_PATHS = [
  '/index.html',
  '/shop.html',
  '/sports-cards.html',
  '/baseball-cards.html',
  '/basketball-cards.html',
  '/football-cards.html',
  '/comics.html',
  '/collectibles.html',
  '/about.html',
  '/contact.html',
  '/sell-trade-want-list.html',
  '/wishlist.html',
  '/cart.html',
  '/checkout-success.html',
  '/account.html',
  '/admin.html',
  '/inbox.html',
  '/metrics.html',
  '/offer.html',
  '/policies.html',
  '/shipping.html',
  '/returns.html',
  '/offline.html',
  '/tools/index.html',
  '/tools/player-card-matchups/index.html',
  '/tools/workshop/index.html',
  '/lineup-lab/index.html'
];
const VISUAL_MATRIX_VIEWPORTS = [
  { label: 'mobile', width: 390, height: 844 },
  { label: 'tablet', width: 900, height: 900 },
  { label: 'desktop', width: 1280, height: 900 }
];
const NBA_SLAB_STATS_FIXTURE = {
  schemaVersion: 1,
  provider: 'NBA',
  productId: 9000001,
  players: [
    {
      mapping: {
        subjectOrder: 1,
        subjectRole: 'co_subject',
        depictedSeasonLabel: '2003-04',
        depictedSeasonStartYear: 2003,
        depictedSeasonEndYear: 2004,
        seasonMappingMethod: 'title_season_range',
        reviewState: 'auto_verified'
      },
      player: {
        athleteId: 'smoke-athlete-one',
        nbaPlayerId: 'smoke-nba-one',
        name: 'Test Player One',
        primaryPosition: 'G',
        heightInches: 78,
        weightPounds: 210,
        college: 'Test University',
        headshotUrl: ''
      },
      seasons: [
        {
          seasonEndYear: 2004,
          seasonLabel: '2003-04',
          phase: 'regular',
          gamesPlayed: 10,
          minutesPlayed: 350,
          points: 200,
          totalRebounds: 80,
          assists: 60,
          steals: 20,
          blocks: 10,
          turnovers: 30,
          fieldGoalPercentage: 0.5,
          threePointPercentage: 0.4,
          freeThrowPercentage: 0.8,
          trueShootingPercentage: 0.61,
          playerEfficiencyRating: 22.2,
          winShares: 4.5,
          boxPlusMinus: 5.3,
          valueOverReplacementPlayer: 3.1
        },
        {
          seasonEndYear: 2004,
          seasonLabel: '2003-04',
          phase: 'playoffs',
          gamesPlayed: 5,
          minutesPlayed: 170,
          points: 90,
          totalRebounds: 35,
          assists: 25,
          steals: 8,
          blocks: 4,
          turnovers: 12,
          fieldGoalPercentage: 0.48,
          threePointPercentage: 0.37,
          freeThrowPercentage: 0.79,
          trueShootingPercentage: 0.58,
          playerEfficiencyRating: 20.1,
          winShares: 1.2,
          boxPlusMinus: 4.1,
          valueOverReplacementPlayer: 0.8
        }
      ]
    },
    {
      mapping: {
        subjectOrder: 2,
        subjectRole: 'co_subject',
        depictedSeasonEndYear: null,
        seasonMappingMethod: 'unresolved',
        reviewState: 'human_verified'
      },
      player: {
        athleteId: 'smoke-athlete-two',
        nbaPlayerId: 'smoke-nba-two',
        name: 'Test Player Two',
        primaryPosition: 'F',
        heightInches: 81,
        weightPounds: 235,
        college: '',
        headshotUrl: ''
      },
      seasons: [
        {
          seasonEndYear: 2005,
          seasonLabel: '2004-05',
          phase: 'regular',
          gamesPlayed: 12,
          minutesPlayed: 360,
          points: 180,
          totalRebounds: 108,
          assists: 36,
          steals: 12,
          blocks: 18,
          turnovers: 24,
          fieldGoalPercentage: 0.52,
          threePointPercentage: 0.33,
          freeThrowPercentage: 0.75,
          trueShootingPercentage: 0.6,
          playerEfficiencyRating: 21,
          winShares: 3.7,
          boxPlusMinus: 4.4,
          valueOverReplacementPlayer: 2.4
        }
      ]
    }
  ]
};
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
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function traceSmoke(message) {
  if (process.env.DJHC_SMOKE_TRACE === '1') {
    console.error(`[render-smoke] ${message}`);
  }
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
    traceSmoke(`evaluate ${String(expression).replace(/\s+/g, ' ').trim().slice(0, 120)}`);
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Runtime exception'
      );
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
  await client.send('Network.enable');
  return client;
}

async function stopBrowserTree(browser) {
  if (!browser?.pid) return;
  if (process.platform !== 'win32') {
    browser.kill();
    return;
  }

  await new Promise((resolve) => {
    const taskkill = spawn('taskkill.exe', ['/PID', String(browser.pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    });
    taskkill.once('error', () => {
      browser.kill();
      resolve();
    });
    taskkill.once('exit', resolve);
  });
}

async function navigate(client, url) {
  traceSmoke(`navigate ${url}`);
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
      || (event.method === 'Network.responseReceived' && event.params?.response?.status >= 400)
    ))
    .map((event) => {
      if (event.method === 'Network.responseReceived') {
        return `${event.params.response.status} ${event.params.response.url}`;
      }
      return event.params?.entry?.text
        || event.params?.exceptionDetails?.exception?.description
        || event.params?.exceptionDetails?.text
        || event.method;
    })
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
  // CDP can acknowledge the metrics override before the renderer exposes the
  // new innerWidth. Wait for that settled state before synthesizing the resize
  // event, otherwise the application correctly reads the *previous* breakpoint
  // and the harness records a false stale-drawer failure.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const actualWidth = await client.evaluate('window.innerWidth');
    if (actualWidth === width) break;
    await delay(25);
  }
  // The emulation command may also queue an early resize using the previous
  // width. Let the application's 100ms batched fallback finish first, then
  // deliver one event against the verified current width.
  await delay(150);
  // CDP's device-metrics override does not consistently emit the window event
  // that a real resize or device rotation produces.
  await client.evaluate('window.dispatchEvent(new Event("resize"))');
  // Allow both the animation-frame path and its 100ms timer fallback to settle
  // even when the page is busy finishing catalog/image work.
  await delay(500);
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
      // Keep the renderer active long enough for any breakpoint work queued by
      // the emulation resize to finish before the initial state snapshot.
      window.dispatchEvent(new Event('resize'));
      await pause(150);
      const width = ${width};
      const compactNav = width <= 900;
      const mobileFilters = width <= 900;
      const nav = document.getElementById('siteNav');
      const navToggle = document.getElementById('navToggle');
      const filterPanel = document.querySelector('.filter-panel');
      const filterTrigger = document.querySelector('.mobile-filter-trigger');
      const navToggleVisible = !!navToggle && getComputedStyle(navToggle).display !== 'none' && !navToggle.hidden;
      const outcome = {
        width,
        actualWidth: window.innerWidth,
        compactNavMatches: window.matchMedia('(max-width: 900px)').matches,
        mobileFiltersMatch: window.matchMedia('(max-width: 900px)').matches,
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
        filterPanelHidden: !!filterPanel?.hidden,
        filterPanelRole: filterPanel?.getAttribute('role') || '',
        filterPanelAriaModal: filterPanel?.getAttribute('aria-modal') || '',
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
    const compactNav = width <= 900;
    const mobileFilters = width <= 900;
    if (state.navToggleVisible !== compactNav) failures.push(`nav-toggle visibility does not match compact breakpoint at ${width}px`);
    if (compactNav) {
      if (!state.navClosedHidden || state.navClosedAriaHidden !== 'true') failures.push(`closed nav accessibility state is wrong at ${width}px`);
      for (const key of ['navOpen', 'navFocusEntered', 'navTabTrapped', 'navShiftTabTrapped', 'navEscapeClosed', 'navFocusRestored', 'navOutsideClosed']) {
        if (!state[key]) failures.push(`${key} failed at ${width}px`);
      }
    } else if (state.navClosedHidden || state.navClosedAriaHidden !== 'false') {
      failures.push(`desktop nav accessibility state is wrong at ${width}px`);
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

async function inspectStorefrontShell(client, baseUrl) {
  const scenarios = [
    { label: 'mobile home shell', path: '/', width: 390, compact: true, footer: true, maxFooterArtworkHeight: 151 },
    { label: 'mobile comics shell', path: '/comics.html', width: 390, compact: true },
    { label: 'mobile account footer 390px', path: '/account.html', width: 390, compact: true, footer: true, maxFooterArtworkHeight: 151 },
    { label: 'mobile account footer 420px', path: '/account.html', width: 420, compact: true, footer: true, maxFooterArtworkHeight: 160 },
    { label: 'mobile account footer 700px', path: '/account.html', width: 700, compact: true, footer: true, maxFooterArtworkHeight: 173 },
    { label: 'compact tablet home shell 900px', path: '/', width: 900, compact: true },
    { label: 'narrow desktop home shell 901px', path: '/', width: 901, compact: false },
    { label: 'narrow desktop home shell 1024px', path: '/', width: 1024, compact: false },
    { label: 'narrow desktop home shell 1180px', path: '/', width: 1180, compact: false },
    { label: 'narrow desktop account shell 901px', path: '/account.html', width: 901, compact: false, minimumNavWidth: 640 },
    { label: 'narrow desktop account shell 1180px', path: '/account.html', width: 1180, compact: false, minimumNavWidth: 640 }
  ];
  const results = [];

  for (const scenario of scenarios) {
    client.consumeEvents();
    await setViewport(client, scenario.width);
    await navigate(client, `${baseUrl}${scenario.path}${scenario.path.includes('?') ? '&' : '?'}shellSmoke=${scenario.width}`);
    const state = await client.evaluate(`(() => {
      const isVisible = (element) => {
        if (!element || element.hidden || element.closest('[hidden]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity || '1') > 0
          && rect.width > 2
          && rect.height > 2;
      };
      const header = document.querySelector('.site-header');
      const brandCopy = header?.querySelector('.brand-copy');
      const brandScript = header?.querySelector('.brand-script');
      const account = header?.querySelector('.home-header-utility a[href$="account.html"]');
      const cart = header?.querySelector('.home-header-utility a[data-cart-link]');
      const nav = header?.querySelector('#siteNav');
      const navToggle = header?.querySelector('#navToggle');
      const drawerTheme = header?.querySelector('.site-nav .theme-toggle:not(.theme-toggle--footer)');
      const footer = document.querySelector('footer.site-footer');
      const footerGroups = footer?.querySelector('.footer-link-groups');
      const footerBefore = footer ? getComputedStyle(footer, '::before') : null;
      const footerGridColumns = footerGroups
        ? getComputedStyle(footerGroups).gridTemplateColumns.split(/\\s+/).filter(Boolean).length
        : 0;
      return {
        brandCopyVisible: isVisible(brandCopy),
        brandScriptVisible: isVisible(brandScript),
        accountVisible: isVisible(account),
        cartVisible: isVisible(cart),
        navVisible: isVisible(nav),
        navHidden: !!nav?.hidden,
        navAriaHidden: nav?.getAttribute('aria-hidden') || '',
        navInert: !!nav?.hasAttribute('inert'),
        navToggleVisible: isVisible(navToggle),
        navClientWidth: Math.round(nav?.getBoundingClientRect().width || 0),
        headerClientWidth: Math.round(header?.getBoundingClientRect().width || 0),
        drawerThemeEnabled: !!drawerTheme && getComputedStyle(drawerTheme).display !== 'none',
        footerHeight: Math.round(footer?.getBoundingClientRect().height || 0),
        footerArtworkHeight: Math.round(Number.parseFloat(footerBefore?.height || '0')),
        footerGridColumns,
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth
      };
    })()`);
    const failures = [];
    for (const key of ['brandCopyVisible', 'brandScriptVisible', 'accountVisible', 'cartVisible']) {
      if (!state[key]) failures.push(`${key} is not visible`);
    }
    if (state.overflow > 2) failures.push(`horizontal overflow ${state.overflow}`);

    if (scenario.compact) {
      if (!state.navToggleVisible) failures.push('compact header menu toggle is not visible');
      if (scenario.width <= 900 && !state.drawerThemeEnabled) failures.push('drawer theme switcher is not available');
    } else {
      if (!state.navVisible || state.navHidden || state.navAriaHidden !== 'false' || state.navInert) {
        failures.push('horizontal navigation is not available');
      }
      if (state.navToggleVisible) failures.push('desktop menu toggle is still visible');
      const minimumNavWidth = scenario.minimumNavWidth || state.headerClientWidth - 30;
      if (state.navClientWidth < minimumNavWidth) failures.push('horizontal navigation has insufficient usable width');
    }

    if (scenario.footer) {
      if (state.footerHeight > 820) failures.push(`account footer is too tall (${state.footerHeight}px)`);
      if (state.footerArtworkHeight > scenario.maxFooterArtworkHeight) failures.push(`footer artwork separator is too tall (${state.footerArtworkHeight}px)`);
      if (state.footerGridColumns < 2) failures.push('footer link groups do not use the compact two-column layout');
    }

    results.push({ label: scenario.label, state, failures });
  }
  return results;
}

async function inspectNarrowDesktopSubmenus(client, baseUrl) {
  const widths = [901, 1180];
  const results = [];
  for (const width of widths) {
    client.consumeEvents();
    await setViewport(client, width);
    await navigate(client, `${baseUrl}/?submenuSmoke=${width}`);
    const state = await client.evaluate(`(async () => {
      const nav = document.getElementById('siteNav');
      const toggle = nav?.querySelector('.submenu-toggle');
      const submenu = toggle?.getAttribute('aria-controls')
        ? document.getElementById(toggle.getAttribute('aria-controls'))
        : null;
      const list = nav?.querySelector('.primary-nav__list');
      const visible = (element) => {
        if (!element || element.hidden || element.closest('[hidden]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
      };
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const rect = submenu?.getBoundingClientRect();
      const state = {
        width: window.innerWidth,
        togglePresent: !!toggle,
        opened: toggle?.getAttribute('aria-expanded') === 'true',
        visible: visible(submenu),
        withinViewport: !!rect && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
        listOverflow: list ? getComputedStyle(list).overflow : '',
        submenuHeight: Math.round(rect?.height || 0)
      };
      toggle?.click();
      return state;
    })()`);
    const failures = [];
    if (!state.togglePresent) failures.push('submenu toggle is missing');
    if (!state.opened) failures.push('submenu did not open');
    if (!state.visible || !state.withinViewport) failures.push('opened submenu is clipped or outside the viewport');
    if (state.listOverflow !== 'visible') failures.push(`nav list clips submenu overflow (${state.listOverflow})`);
    results.push({ label: `narrow desktop submenu ${width}px`, state, failures });
  }
  return results;
}

async function setPreferredColorScheme(client, value) {
  await client.send('Emulation.setEmulatedMedia', {
    media: 'screen',
    features: [{ name: 'prefers-color-scheme', value }]
  });
}

async function setStorefrontTheme(client, dark) {
  const state = await client.evaluate(`(() => {
    const toggle = document.getElementById('themeToggle');
    return {
      supported: !!toggle,
      dark: document.body.classList.contains('dark-mode')
    };
  })()`);
  if (!state.supported || state.dark === dark) return state.supported;
  await client.evaluate(`document.getElementById('themeToggle')?.click()`);
  await delay(100);
  return true;
}

async function inspectVisualMatrixState(client) {
  return await client.evaluate(`(() => {
    const visibleControlSelector = [
      '.nav-toggle',
      '.theme-toggle',
      '.back-to-top',
      '.mobile-filter-trigger',
      '.filter-panel-dismiss',
      '.modal-close',
      '.product-card-gallery-button',
      '[data-product-wishlist]'
    ].join(',');
    const visibleControlsOutOfBounds = Array.from(document.querySelectorAll(visibleControlSelector))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const pinnedToViewport = style.position === 'fixed' || style.position === 'sticky';
        const horizontallyClipped = rect.left < -2 || rect.right > window.innerWidth + 2;
        const pinnedVerticallyClipped = pinnedToViewport && (rect.top < -2 || rect.bottom > window.innerHeight + 2);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && rect.width > 0
          && rect.height > 0
          && (horizontallyClipped || pinnedVerticallyClipped);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          selector: String(element.className || element.id || element.tagName),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          bottom: Math.round(rect.bottom)
        };
      })
      .slice(0, 8);
    return {
      title: document.title.trim(),
      h1: document.querySelector('h1')?.textContent?.trim() || '',
      header: !!document.querySelector('header'),
      footer: !!document.querySelector('footer'),
      visibleMain: (document.querySelector('main')?.getBoundingClientRect().height || 0) > 0,
      themeToggle: !!document.getElementById('themeToggle'),
      dark: document.body.classList.contains('dark-mode'),
      overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
      brokenImages: Array.from(document.images)
        .filter((image) => (image.currentSrc || image.getAttribute('src')) && image.complete && image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src)
        .slice(0, 8),
      visibleControlsOutOfBounds
    };
  })()`);
}

function visualMatrixFailures(label, pagePath, state, expectedDark) {
  const failures = [];
  if (!state.title) failures.push(`${label}: missing document title`);
  if (!state.h1) failures.push(`${label}: missing h1`);
  if (pagePath !== '/offline.html' && !state.header) failures.push(`${label}: missing header`);
  if (pagePath !== '/offline.html' && !state.footer) failures.push(`${label}: missing footer`);
  if (!state.visibleMain) failures.push(`${label}: main content is not visibly rendered`);
  if (state.overflow > 2) failures.push(`${label}: horizontal overflow ${state.overflow}px`);
  if (state.brokenImages.length) failures.push(`${label}: broken images ${state.brokenImages.join(', ')}`);
  if (state.visibleControlsOutOfBounds.length) {
    failures.push(`${label}: visible controls outside viewport ${JSON.stringify(state.visibleControlsOutOfBounds)}`);
  }
  if (state.themeToggle && state.dark !== expectedDark) {
    failures.push(`${label}: ${expectedDark ? 'dark' : 'light'} theme did not apply`);
  }
  return failures;
}

async function inspectEveryPageVisualMatrix(client, baseUrl) {
  const failures = [];
  let combinations = 0;
  for (const viewport of VISUAL_MATRIX_VIEWPORTS) {
    await setViewport(client, viewport.width);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.width <= 900 ? 2 : 1,
      mobile: viewport.width <= 900,
      screenWidth: viewport.width,
      screenHeight: viewport.height
    });
    for (const pagePath of PUBLIC_PAGE_PATHS) {
      client.consumeEvents();
      await setPreferredColorScheme(client, 'light');
      await navigate(client, `${baseUrl}${pagePath}?visualMatrix=${viewport.width}`);
      for (const colorScheme of ['light', 'dark']) {
        const expectedDark = colorScheme === 'dark';
        await setPreferredColorScheme(client, colorScheme);
        await setStorefrontTheme(client, expectedDark);
        await delay(120);
        const state = await inspectVisualMatrixState(client);
        const label = `${pagePath} at ${viewport.width}px in ${colorScheme} mode`;
        failures.push(...visualMatrixFailures(label, pagePath, state, expectedDark));
        combinations += 1;
      }
      await setStorefrontTheme(client, false);
      failures.push(...eventFailures(client.consumeEvents()).map((event) => `${pagePath} at ${viewport.width}px: ${event}`));
    }
  }
  await setPreferredColorScheme(client, 'light');
  return {
    pages: PUBLIC_PAGE_PATHS.length,
    widths: VISUAL_MATRIX_VIEWPORTS.map(({ width }) => width),
    themes: ['light', 'dark'],
    combinations,
    failures
  };
}

async function inspectNbaSlabStatsPanel(client, baseUrl) {
  const results = [];
  for (const viewport of [
    { label: 'mobile', width: 390, height: 844, scale: 2 },
    { label: 'desktop', width: 1280, height: 900, scale: 1 }
  ]) {
    client.consumeEvents();
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.scale,
      mobile: viewport.width <= 900,
      screenWidth: viewport.width,
      screenHeight: viewport.height
    });
    await navigate(client, `${baseUrl}/basketball-cards.html?slabStatsSmoke=${viewport.width}`);
    const state = await client.evaluate(`(async () => {
      const statsModule = await import('/nba-slab-stats.mjs?renderSmoke=20260824a');
      const modal = document.getElementById('productModal');
      const modalInner = document.getElementById('modalInner');
      if (!modal || !modalInner) return { mounted: false, reason: 'modal host missing' };
      modalInner.innerHTML = '<div class="modal-layout"><div class="modal-media" aria-hidden="true"></div><div class="modal-copy"><h3 id="modalTitle">NBA stats smoke product</h3><section class="nba-slab-stats" id="nbaSlabStatsPanel" aria-label="NBA player statistics for this product"></section></div></div>';
      modal.classList.add('active');
      modal.setAttribute('aria-hidden', 'false');
      modal.removeAttribute('inert');
      const host = document.getElementById('nbaSlabStatsPanel');
      const mounted = await statsModule.mountNbaSlabStatsPanel(host, { id: 9000001 }, {
        requestStats: async () => (${JSON.stringify(NBA_SLAB_STATS_FIXTURE)}),
        isCurrent: () => true
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const tabs = Array.from(host.querySelectorAll('[data-slab-player-tab]'));
      const firstTab = tabs[0];
      firstTab?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const secondTabSelected = tabs[1]?.getAttribute('aria-selected') === 'true'
        && document.activeElement === tabs[1];
      firstTab?.click();
      const select = host.querySelector('[data-slab-season-select="0"]');
      if (select) {
        select.value = '2004:playoffs';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      const hostRect = host.getBoundingClientRect();
      const visiblePlayerPanel = Array.from(host.querySelectorAll('[data-slab-player-panel]'))
        .find((panel) => !panel.hidden);
      const metricGrid = visiblePlayerPanel?.querySelector('.slab-stats-metrics');
      const metricGridRect = metricGrid?.getBoundingClientRect();
      const visibleMetrics = Array.from(visiblePlayerPanel?.querySelectorAll('.slab-stats-metric') || []);
      const metricsFit = visibleMetrics.every((metric) => {
        const rect = metric.getBoundingClientRect();
        return !metricGridRect || (rect.left >= metricGridRect.left - 1 && rect.right <= metricGridRect.right + 1);
      });
      return {
        mounted,
        visible: hostRect.width > 0 && hostRect.height > 0,
        horizontalOverflow: host.scrollWidth - host.clientWidth,
        pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth,
        tabCount: tabs.length,
        secondTabSelected,
        visiblePanelCount: Array.from(host.querySelectorAll('[data-slab-player-panel]')).filter((panel) => !panel.hidden).length,
        seasonChanged: /Playoffs/.test(host.querySelector('[data-slab-season-output="0"]')?.textContent || ''),
        conciseAnnouncement: /Showing 2003-04 Playoffs stats for Test Player One/.test(host.querySelector('[data-slab-season-announcement="0"]')?.textContent || ''),
        metricColumnCount: getComputedStyle(metricGrid).gridTemplateColumns.split(/\\s+/).filter(Boolean).length,
        metricCount: visibleMetrics.length,
        metricsFit,
        disclaimerVisible: /not a card valuation, scouting grade, or projection/i.test(host.textContent || ''),
        fullPanelLiveRegions: host.querySelectorAll('[aria-live]').length
      };
    })()`);
    const failures = [];
    if (!state.mounted || !state.visible) failures.push('panel did not mount visibly');
    if (state.horizontalOverflow > 2 || state.pageOverflow > 2) failures.push('panel caused horizontal overflow');
    if (state.tabCount !== 2 || !state.secondTabSelected || state.visiblePanelCount !== 1) failures.push('keyboard player tabs failed');
    if (!state.seasonChanged || !state.conciseAnnouncement) failures.push('season selector feedback failed');
    if (state.metricColumnCount !== 3 || state.metricCount !== 6 || !state.metricsFit) failures.push('key stat grid is irregular');
    if (!state.disclaimerVisible) failures.push('historical-data disclaimer is missing');
    if (state.fullPanelLiveRegions !== 0) failures.push('full panel became an oversized live region');
    const badEvents = eventFailures(client.consumeEvents());
    failures.push(...badEvents.map((event) => `browser error: ${event}`));
    results.push({ label: `NBA Slab-to-Stats ${viewport.label}`, state, badEvents, failures });
  }
  return results;
}

function usage() {
  return [
    'Usage: node scripts/render-smoke-check.mjs [--interaction-only|--nba-slab-stats-only]',
    '',
    'Runs local rendered storefront checks with an isolated headless browser.',
    '  --interaction-only     Check mobile navigation, filters, gallery, and cart interactions.',
    '  --nba-slab-stats-only  Check the isolated NBA Slab-to-Stats panel fixture.',
    '  --help, -h             Show this usage text without starting a server or browser.'
  ].join('\n');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(usage());
    return;
  }
  const server = await startStaticServer();
  const port = server.address().port;
  const debugPort = 9400 + Math.floor(Math.random() * 300);
  const profileDir = path.join(tmpdir(), `djhc-render-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const browser = spawn(edgePath(), [
    '--headless=new',
    '--disable-gpu',
    // Host-installed extensions can emit unrelated console errors into CDP.
    // The smoke browser needs to exercise only the storefront's own scripts.
    '--disable-extensions',
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
    if (process.argv.includes('--nba-slab-stats-only')) {
      const slabStats = await inspectNbaSlabStatsPanel(client, baseUrl);
      client.websocket.close();
      const failures = slabStats.flatMap((item) => (
        item.failures.map((failure) => `${item.label}: ${failure}`)
      ));
      const summary = {
        ok: failures.length === 0,
        baseUrl,
        slabStats,
        failures
      };
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.ok) process.exitCode = 1;
      return;
    }
    if (process.argv.includes('--interaction-only')) {
      const mobile = await inspectMobileFlow(client, baseUrl);
      const responsive = await inspectResponsiveDrawerContracts(client, baseUrl);
      const storefrontShell = await inspectStorefrontShell(client, baseUrl);
      const narrowDesktopSubmenus = await inspectNarrowDesktopSubmenus(client, baseUrl);
      client.websocket.close();
      const failures = [
        ...mobile.failures.map((failure) => `${mobile.label}: ${failure}`),
        ...mobile.badEvents.map((event) => `${mobile.label}: ${event}`),
        ...responsive.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
        ...storefrontShell.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
        ...narrowDesktopSubmenus.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`))
      ];
      const summary = {
        ok: failures.length === 0,
        baseUrl,
        mobile,
        responsive,
        storefrontShell,
        narrowDesktopSubmenus,
        failures
      };
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.ok) process.exitCode = 1;
      return;
    }
    const desktopPages = [
      { label: 'home', path: '/', expect: { minCards: 7 } },
      { label: 'baseball category', path: '/baseball-cards.html?search=rookie', expect: { catalog: true } },
      { label: 'baseball linked item', path: '/baseball-cards.html?item=6', expect: { modal: true } },
      { label: 'account', path: '/account.html', expect: { account: true } },
      { label: 'cart', path: '/cart.html', expect: { cart: true } },
      { label: 'policies and authenticity', path: '/policies.html', expect: { policy: true } },
      { label: 'private metrics', path: '/metrics.html', expect: { metrics: true } }
    ];
    // Run the module-isolated Slab-to-Stats fixture before the catalog-heavy
    // page sweep. This avoids letting dozens of prior image/cache requests make
    // a deterministic component check depend on browser cache scheduling.
    const slabStats = await inspectNbaSlabStatsPanel(client, baseUrl);
    const desktop = [];
    for (const page of desktopPages) {
      desktop.push(await inspectDesktopPage(client, baseUrl, page));
    }
    const mobile = await inspectMobileFlow(client, baseUrl);
    const responsive = await inspectResponsiveDrawerContracts(client, baseUrl);
    const storefrontShell = await inspectStorefrontShell(client, baseUrl);
    const narrowDesktopSubmenus = await inspectNarrowDesktopSubmenus(client, baseUrl);
    const visualMatrix = await inspectEveryPageVisualMatrix(client, baseUrl);
    client.websocket.close();

    const allFailures = [
      ...desktop.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...desktop.flatMap((item) => item.badEvents.map((event) => `${item.label}: ${event}`)),
      ...mobile.failures.map((failure) => `${mobile.label}: ${failure}`),
      ...mobile.badEvents.map((event) => `${mobile.label}: ${event}`),
      ...slabStats.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...responsive.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...storefrontShell.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...narrowDesktopSubmenus.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...visualMatrix.failures
    ];
    const summary = {
      ok: allFailures.length === 0,
      baseUrl,
      desktop,
      mobile,
      slabStats,
      responsive,
      storefrontShell,
      narrowDesktopSubmenus,
      visualMatrix,
      failures: allFailures
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    await stopBrowserTree(browser);
    await new Promise((resolve) => {
      server.close(resolve);
    });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
