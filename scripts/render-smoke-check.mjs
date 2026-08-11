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
  await navigate(client, `${baseUrl}${page.path}${page.path.includes('?') ? '&' : '?'}smokeVersion=20260811b`);
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
      cartContainer: !!document.getElementById('cartContainer'),
      policyContent: !!document.querySelector('.policy-content'),
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
  if (page.expect?.cart && !metrics.cartContainer) failures.push('cart container missing');
  if (page.expect?.policy && !metrics.policyContent) failures.push('policy content missing');
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
  await navigate(client, `${baseUrl}/baseball-cards.html?smoke=mobile&smokeVersion=20260811b`);
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
      { label: 'privacy policy', path: '/privacy.html', expect: { policy: true } }
    ];
    const desktop = [];
    for (const page of desktopPages) {
      desktop.push(await inspectDesktopPage(client, baseUrl, page));
    }
    const mobile = await inspectMobileFlow(client, baseUrl);
    client.websocket.close();

    const allFailures = [
      ...desktop.flatMap((item) => item.failures.map((failure) => `${item.label}: ${failure}`)),
      ...desktop.flatMap((item) => item.badEvents.map((event) => `${item.label}: ${event}`)),
      ...mobile.failures.map((failure) => `${mobile.label}: ${failure}`),
      ...mobile.badEvents.map((event) => `${mobile.label}: ${event}`)
    ];
    const summary = {
      ok: allFailures.length === 0,
      baseUrl,
      desktop,
      mobile,
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
