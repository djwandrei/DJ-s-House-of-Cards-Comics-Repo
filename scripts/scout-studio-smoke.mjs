import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createScoutStudioServer } from './preview-scout-studio.mjs';
import { fixtureSource, readyStatus } from './tests/fixtures/scout-studio-fixture.mjs';

// Uses synthetic fixtures to exercise the UI. The actual package is never
// replaced with test data by preview-scout-studio.mjs.
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const executablePath = [process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'An installed Chromium browser is required.');
const source = fixtureSource();
const server = createScoutStudioServer(source);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const output = path.resolve('outputs/scout-studio-smoke');
await fs.mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/tools/scout-studio/`);
    await page.getByRole('heading', { name: 'Validated for local integration review' }).waitFor();
    await page.getByRole('button', { name: 'Load team evidence' }).click();
    await page.getByText('6 source player profiles loaded.', { exact: false }).waitFor();
    await page.locator('#compareSelect').selectOption('p1');
    await page.getByRole('heading', { name: 'Side-by-side blueprint' }).waitFor();
    assert.equal(await page.locator('.studio-metric').count(), 10);
    assert.ok(await page.locator('#blueprintContent').innerText().then(text => text.includes('60 twos with unlocated distance')));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page-level horizontal overflow');
    await page.screenshot({ path: path.join(output, `blueprint-${viewport.width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Chemistry Lab', exact: true }).click();
    for (let i = 1; i <= 6; i++) await page.getByRole('button', { name: `Test Player ${i}`, exact: true }).click();
    await page.getByText('Five selected. Deselect a player before adding another.', { exact: true }).waitFor();
    assert.equal(await page.locator('#chemistryPlayers [aria-pressed="true"]').count(), 5);
    await page.getByRole('button', { name: 'Inspect shared floor' }).click();
    await page.getByText('No observed combination in this team sample.', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Test Player 5', exact: true }).click();
    await page.getByRole('button', { name: 'Test Player 4', exact: true }).click();
    await page.getByRole('button', { name: 'Test Player 3', exact: true }).click();
    await page.getByRole('button', { name: 'Inspect shared floor' }).click();
    await page.getByRole('cell', { name: '115', exact: true }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Chemistry does not overflow the viewport');
    await page.screenshot({ path: path.join(output, `chemistry-${viewport.width}.png`), fullPage: true });
    await page.locator('#themeToggle').click();
    assert.ok(await page.locator('body').evaluate(body => body.classList.contains('dark-mode')));
    await page.screenshot({ path: path.join(output, `chemistry-dark-${viewport.width}.png`), fullPage: true });
    await page.locator('#teamSelect').selectOption('t1');
    assert.equal(await page.locator('#analysis').isVisible(), false, 'Team change clears old results');
    await page.getByRole('button', { name: 'Refresh checkpoint' }).click();
    await page.getByRole('heading', { name: 'Validated for local integration review' }).waitFor();
    assert.equal(await page.locator('#analysis').isVisible(), false, 'Refresh clears results');
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on('pageerror', error => errors.push(error.message));
  source.status = async () => ({ ...readyStatus(), phase: 'pending', teams: [] });
  await page.goto(`${base}/tools/scout-studio/`);
  await page.getByRole('heading', { name: 'Waiting for the current Scout build' }).waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.equal(await page.locator('#pendingPanel').isVisible(), true);
  await page.screenshot({ path: path.join(output, 'pending-mobile.png'), fullPage: true });
  source.status = async () => ({ ...readyStatus(), phase: 'blocked', teams: [] });
  await page.getByRole('button', { name: 'Refresh checkpoint' }).click();
  await page.getByRole('heading', { name: 'Package validation needs attention' }).waitFor();
  assert.equal(await page.locator('#workspace').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, viewports: [1440, 390], tested: ['blueprint', 'comparison', 'chemistry', 'selection cap', 'unknown combination', 'dark mode', 'team switch', 'refresh', 'pending', 'blocked'], screenshots: output }));
} finally {
  await browser?.close();
  await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
}
