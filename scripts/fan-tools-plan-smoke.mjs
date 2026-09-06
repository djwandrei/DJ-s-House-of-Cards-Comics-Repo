import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = process.cwd();
const removed = ['two-truths-one-box-score', 'evidence-court', 'statline-sleuth',
  'optimizer-sensitivity-studio', 'franchise-fingerprints', 'phase-flip'];
const publicFiles = new Set(['tools/index.html', 'tools/registry.js', 'tools/fan-tools.js', 'tools/fan-tools.css',
  'tools/workshop/index.html', 'tools/workshop/definitions.js', 'tools/workshop/tool-workshop.js',
  'tools/workshop/workshop-state.js', 'tools/workshop/tool-workshop.css',
  'styles.css', 'styles-mobile-overrides.css', 'core.js', 'nav.js', 'theme-init.js', 'site.webmanifest']);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (relative.endsWith('/')) relative += 'index.html';
    if (relative === 'backend-config.js' || relative === 'analytics.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end('/* Measurement disabled in local smoke checks. */'); return;
    }
    const asset = /^assets\/(?:fonts\/|icons\/)?[a-z0-9-]+\.(?:png|webp|jpg|woff2)$/.test(relative);
    if (!publicFiles.has(relative) && !asset) { response.writeHead(404); response.end(); return; }
    const data = await fs.readFile(path.join(root, relative));
    response.writeHead(200, { 'Content-Type': types[path.extname(relative)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(data);
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const live = process.argv.includes('--live');
const base = live ? 'https://www.djshouseofcards-comics.com' : `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
  browser = await chromium.launch({ executablePath, headless: true });
  const output = path.resolve('outputs/fan-tools-plan-smoke'); await fs.mkdir(output, { recursive: true });
  const errors = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport });
    // Production smoke checks never submit analytics, checkout, or other writes.
    await context.route('**/*', route => new URL(route.request().url()).origin === base
      && ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/tools/?release-check=20260906a`);
    await page.locator('#toolsGrid article').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('#toolsGrid article').count(), 6);
    assert.equal(await page.locator('[data-status-count="planned"]').innerText(), '6');
    assert.equal(await page.locator('#toolsFeatured article').count(), 5);
    await page.locator('[data-play-filter="games"]').click();
    assert.equal(await page.locator('#toolsFeatured article:visible').count(), 2);
    await page.locator('[data-play-filter="tools"]').click();
    assert.equal(await page.locator('#toolsFeatured article:visible').count(), 3);
    await page.locator('#suggestPlay').click();
    assert.equal(await page.locator('#toolsFeatured article.is-suggested:visible').count(), 1);
    await page.locator('[data-play-filter="all"]').click();
    assert.equal(await page.locator('#toolsFeatured article:visible').count(), 5);
    await page.locator('#playNow').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `play-picker-${viewport.width}.png`) });
    for (const id of removed) assert.equal(await page.locator(`[data-tool-id="${id}"]`).count(), 0);
    await page.locator('.tools-roadmap-disclosure summary').click();
    await page.locator('#toolsRoadmap').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `roadmap-${viewport.width}.png`) });
    for (const id of removed) {
      await page.goto(`${base}/tools/workshop/?experience=${id}`);
      await page.getByRole('heading', { name: 'Rotation Rescue', exact: true }).waitFor();
      assert.equal(await page.locator('#experiencePicker option').count(), 3);
      assert.match(await page.locator('#workshopStatus').innerText(), /requested framework was not recognized/);
      for (const retired of removed) assert.equal(await page.locator(`#experiencePicker option[value="${retired}"]`).count(), 0);
    }
    await page.locator('#experiencePicker').selectOption('scouts-call');
    await page.getByRole('heading', { name: "Scout's Call", exact: true }).waitFor();
    await page.getByRole('button', { name: 'Save setup locally' }).click();
    await page.getByText('Setup saved in this browser.', { exact: false }).waitFor();
    await page.reload();
    await page.getByText('Your saved setup is loaded locally.', { exact: false }).waitFor();
    await page.locator('#experiencePickerHeading').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `workshop-${viewport.width}.png`) });
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], planned: 6, workshops: 3,
    environment: live ? 'production' : 'local',
    checked: ['all six absent from hub and picker', 'live experience filters and suggestion', 'retired deep links', 'retained workshop save/reload'], screenshots: output }));
} finally {
  await browser?.close();
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
}
