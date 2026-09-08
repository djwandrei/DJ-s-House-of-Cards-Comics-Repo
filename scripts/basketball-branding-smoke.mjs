// Offline presentation checks. Game scoring is exercised separately by
// fan-games-design-smoke.mjs; this server never exposes credentials or submits.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd();
const output = path.join(root, 'outputs/basketball-branding');
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.svg':'image/svg+xml', '.woff2':'font/woff2', '.ttf':'font/ttf', '.json':'application/json' };
const shared = new Set(['core.js','nav.js','theme-init.js','styles.css','styles-mobile-overrides.css']);
const server = createServer(async (req, res) => {
  try {
    let relative = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    if (relative.endsWith('/')) relative += 'index.html';
    if (['backend-config.js','supabase-client.js','analytics.js'].includes(relative)) {
      res.writeHead(200, { 'Content-Type':'text/javascript' });
      res.end('window.DJ ||= {}; window.DJ.remoteCatalog = { getSession: async () => null, invokeFunction: async () => { throw new Error("Offline presentation check"); } };'); return;
    }
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep) || !types[path.extname(target)] ||
      !(shared.has(relative) || ['tools/','assets/','lineup-lab/'].some(prefix => relative.startsWith(prefix)))) {
      res.writeHead(404); res.end(); return;
    }
    const data = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type':types[path.extname(target)], 'Cache-Control':'no-store' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
const errors = [], missing = [], checks = [];
let browser;
async function loadedImages(page, selector) {
  assert.ok(await page.locator(selector).count(), `Expected images: ${selector}`);
  let openedMenu = false;
  for (const image of await page.locator(selector).all()) {
    if (!(await image.isVisible()) && await page.locator('#navToggle').isVisible()) {
      await page.locator('#navToggle').click();
      await page.waitForFunction(() => !document.querySelector('#siteNav')?.hidden);
      openedMenu = true;
    }
    if (await image.getAttribute('loading') === 'lazy') {
      await image.scrollIntoViewIfNeeded();
      await image.evaluate(el => el.decode());
    }
  }
  await page.waitForFunction(selector => [...document.querySelectorAll(selector)].every(img => img.complete && img.naturalWidth > 0), selector);
  if (openedMenu) await page.keyboard.press('Escape');
}
async function noOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No page-level horizontal overflow');
}
async function badgeInteraction(page, reduced) {
  const badge = page.locator('[data-badge-replay]');
  await loadedImages(page, '[data-badge-replay] img');
  if (reduced) {
    assert.ok(await badge.isDisabled(), 'Reduced motion keeps the decorative badge still');
    assert.equal(await badge.locator('img').evaluate(el => el.getAnimations().length), 0);
  } else {
    await badge.focus(); await page.keyboard.press('Enter');
    assert.ok(await badge.locator('img').evaluate(el => el.getAnimations().some(a => a.playState === 'running')), 'Keyboard starts the badge bounce');
    await page.emulateMedia({ reducedMotion:'reduce' });
    await page.waitForFunction(() => document.querySelector('[data-badge-replay]').disabled);
    assert.equal(await badge.locator('img').evaluate(el => el.getAnimations().length), 0, 'Changing preference stops motion');
    await page.emulateMedia({ reducedMotion:'no-preference' });
    await page.waitForFunction(() => !document.querySelector('[data-badge-replay]').disabled);
    if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await badge.tap(); else await badge.click();
    await page.waitForFunction(() => document.querySelector('[data-badge-replay] img').getAnimations().length === 0);
  }
}
try {
  browser = await chromium.launch({ executablePath, headless:true });
  await fs.mkdir(output, { recursive:true });
  for (const width of [320,390,900,1440]) for (const theme of ['light','dark']) {
    const context = await browser.newContext({ viewport:{ width, height:1000 }, reducedMotion:width === 900 ? 'reduce':'no-preference', hasTouch:width <= 390 });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', r => { if (r.status() === 404 && /basketball-branding|assets\/games|lab-experience/.test(r.url())) missing.push(r.url()); });
    for (const game of ['fix-the-five','draft-night']) {
      await page.goto(`${base}/tools/${game}/`);
      await badgeInteraction(page, width === 900);
      assert.equal(await page.locator('.fan-suite-nav__link[aria-current="page"]').count(), 1);
      assert.ok((await page.locator('.fan-suite-nav__link[aria-current="page"]').getAttribute('href')).includes(game));
      await loadedImages(page, '.fan-suite-nav__link img');
      assert.match(await page.locator('link[rel="icon"]').getAttribute('href'), new RegExp(`${game}-icon`));
      assert.match(await page.locator('footer').evaluate(el => getComputedStyle(el, '::before').backgroundImage), /basketball-footer/);
      await noOverflow(page);
      if ([390,1440].includes(width) && theme === 'dark') {
        await page.screenshot({ path:path.join(output, `${game}-${width}.png`) });
        await page.locator('footer').scrollIntoViewIfNeeded();
        await page.screenshot({ path:path.join(output, `${game}-${width}-footer.png`) });
      }
      checks.push(`${game} ${width} ${theme}`);
    }
    await page.goto(`${base}/tools/`);
    await loadedImages(page, '.tools-featured-card__marker.has-game-emblem img');
    assert.equal(await page.locator('.tools-featured-card__marker.has-game-emblem img').count(), 5);
    await noOverflow(page);
    if ([390,1440].includes(width) && theme === 'dark') {
      await page.locator('[data-tool-id="fix-the-five"]', { has:page.locator('.has-game-emblem') }).scrollIntoViewIfNeeded();
      await page.screenshot({ path:path.join(output, `fan-tools-${width}-games.png`) });
    }
    checks.push(`hub ${width} ${theme}`);
    await context.close();
  }
  for (const width of [320,390,1440]) {
    const context = await browser.newContext({ viewport:{ width, height:1000 }, reducedMotion:width === 320 ? 'reduce':'no-preference' });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${base}/lineup-lab/`);
    await page.waitForFunction(() => document.querySelector('#datasetCount')?.textContent === '15' && document.querySelector('.journey-draft-status')?.textContent.includes('saved'));
    await badgeInteraction(page, width === 320);
    await noOverflow(page);
    await page.screenshot({ path:path.join(output, `lineup-lab-${width}.png`) });
    await page.locator('#workflowNext').click();
    await page.locator('#coachingBrief > summary').click();
    const selected = () => page.locator('#presetGrid [aria-pressed="true"]').getAttribute('data-preset');
    const before = await selected();
    const constraints = () => page.locator('#modeInput,#sizeInput,#minGuardsInput,#minForwardsInput,#minCentersInput').evaluateAll(inputs => inputs.map(input => [input.id,input.value]));
    const originalConstraints = await constraints();
    for (let i = 0; i < 3; i++) { await page.locator('#nextCoachingBrief').click(); assert.equal(await selected(), before, 'Browsing prompts does not change focus'); }
    assert.match(await page.locator('#coachingBriefNumber').textContent(), /1 of 3/);
    await page.locator('#nextCoachingBrief').click();
    await page.locator('#applyCoachingBrief').focus(); await page.keyboard.press('Enter');
    assert.equal(await selected(), 'defense');
    assert.deepEqual(await constraints(), originalConstraints, 'Coaching prompts preserve roster rules');
    assert.equal(await page.locator('#results').isVisible(), false, 'Applying a prompt never runs the optimizer');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.preset), 'defense');
    await noOverflow(page);
    await page.locator('#coachingBrief').scrollIntoViewIfNeeded();
    await page.screenshot({ path:path.join(output, `lineup-lab-${width}-coach-prompt.png`) });
    await page.locator('.lab-footer-art').scrollIntoViewIfNeeded();
    await loadedImages(page, '.lab-footer-art img');
    await page.screenshot({ path:path.join(output, `lineup-lab-${width}-footer.png`) });
    checks.push(`lineup-lab ${width} prompts, badge, footer`);
    await context.close();
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
  const report = { status:'passed', checks, errors, missing, note:'Offline fixtures only; no live Scout game readiness claim.' };
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
