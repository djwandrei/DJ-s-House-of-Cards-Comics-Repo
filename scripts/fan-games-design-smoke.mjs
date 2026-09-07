// Offline UI playtest. Synthetic boards exist only inside this process;
// all external requests are blocked and no production game is submitted.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { buildScoutDailyGame } from './lib/scout-daily-games.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = process.cwd();
const seed = '2026-09-05';
const output = path.resolve('outputs/fan-games-design');
const players = ['G', 'F', 'C'].flatMap((position, group) => Array.from({ length: position === 'C' ? 3 : 6 }, (_, index) => ({
  playerId: `test-${position}-${index}`, name: `Test ${position} Player ${index + 1}`, positions: [position],
  teamCode: 'MIN', teamName: 'UI Test Team', franchiseId: 'MIN', sourceSeasonEndYear: 2025,
  publicStats: { games: 70, minutes: 28, points: 10 + index, assists: 3, rebounds: 5 },
  scout: { offense: index + 1 + group, defense: 8 - index },
})));
const scope = { id: 'ui-test-only', status: 'ready', players,
  model: { publicLabel: 'Synthetic UI test model', seasonEndYears: [2025], calibration: { status: 'validated', allComponentsImproved: true } } };
const games = Object.fromEntries(['fix-the-five', 'draft-night'].map(gameKind => [gameKind,
  buildScoutDailyGame({ gameKind, dailySeed: seed, scopes: [scope] })]));
const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.png':'image/png', '.webp':'image/webp', '.jpg':'image/jpeg', '.woff2':'font/woff2', '.svg':'image/svg+xml' };
const shared = new Set(['core.js', 'nav.js', 'theme-init.js', 'styles.css', 'styles-mobile-overrides.css']);
const server = createServer(async (request, response) => {
  try {
    let relative = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname).replace(/^\/+/, '');
    if (relative.endsWith('/')) relative += 'index.html';
    const target = path.resolve(root, relative);
    if (['backend-config.js', 'analytics.js', 'supabase-client.js'].includes(relative)) {
      response.writeHead(200, { 'Content-Type':'text/javascript' });
      response.end('window.DJ ||= {}; window.DJ.remoteCatalog = { invokeFunction: (_, body) => window.uiTestInvoke(body), getSession: async () => null };'); return;
    }
    if (!target.startsWith(root + path.sep) || !types[path.extname(target)] ||
      !(shared.has(relative) || relative.startsWith('tools/') || relative.startsWith('assets/'))) {
      response.writeHead(404); response.end(); return;
    }
    response.writeHead(200, { 'Content-Type':types[path.extname(target)], 'Cache-Control':'no-store' });
    response.end(await fs.readFile(target));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
let browser;
try {
  browser = await chromium.launch({ executablePath, headless:true });
  await fs.mkdir(output, { recursive:true });
  const errors = [];
  for (const width of [390, 900, 1440]) for (const theme of ['dark', 'light']) for (const gameKind of Object.keys(games)) {
    const context = await browser.newContext({ viewport:{ width, height:950 }, reducedMotion:'reduce' });
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    await context.addInitScript(theme => localStorage.setItem('theme', theme), theme);
    let unavailable = false, failReveal = false;
    await context.exposeFunction('uiTestInvoke', async body => {
      if (unavailable || (failReveal && body.action === 'reveal')) throw new Error('Simulated unavailable board');
      const game = games[body.gameKind];
      if (body.action === 'board') return { board:game.publicBoard };
      const outcome = body.gameKind === 'fix-the-five' ? game.sealedResults[body.challengeId][body.candidateId]
        : Object.values(game.sealedResults).find(outcome => outcome.selectionIds.join('|') === body.selectionIds.join('|'));
      assert.ok(outcome);
      return { contractVersion:1, gameKind:body.gameKind, dailySeed:seed, outcome };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/tools/${gameKind}/?seed=${seed}`);
    const choices = page.locator('button[data-action="choose"]');
    await choices.first().waitFor();
    assert.equal(await choices.count(), 3);
    if (theme === 'dark' && width !== 900) await page.screenshot({ path:path.join(output, `${gameKind}-${width}-opening.png`) });
    const entry = page.locator('.game-entry-link');
    const entryBox = await entry.boundingBox();
    assert.ok(entryBox && entryBox.y + entryBox.height <= 950, 'Board entry is visible without scrolling');
    await entry.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'gameBoard');
    assert.ok(await page.locator('#gameBoard').evaluate(el => el.getBoundingClientRect().top >= 75), 'Board heading clears the sticky header');
    assert.equal(await page.locator('.game-field-notes').getAttribute('open'), null);
    const guide = page.locator('.game-field-notes > summary');
    await guide.focus(); await page.keyboard.press('Enter');
    assert.notEqual(await page.locator('.game-field-notes').getAttribute('open'), null);
    await page.keyboard.press('Enter');
    if (gameKind === 'draft-night') assert.equal(await page.locator('.draft-night-open-slot').count(), 5);
    await choices.first().focus();
    await page.screenshot({ path:path.join(output, `${gameKind}-${width}-${theme}-choices.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Choices fit viewport');
    for (let pick = 0; pick < 5; pick++) {
      await choices.first().focus(); await page.keyboard.press('Enter');
      if (gameKind === 'fix-the-five') {
        await page.locator('button[data-action="next"]').waitFor();
        if (pick === 0) {
          await page.locator('button[data-action="change"]').click();
          await choices.nth(1).click();
          await page.locator('button[data-action="next"]').waitFor();
        }
        await page.locator('button[data-action="next"]').click();
      } else if (pick === 0) {
        assert.equal(await page.locator('.draft-night-open-slot').count(), 4);
        await page.locator('#undoPick').click();
        assert.equal(await page.locator('.draft-night-open-slot').count(), 5);
        await choices.nth(1).click();
      }
    }
    await page.locator('#completionPanel .fix-five-total-score').waitFor();
    await page.screenshot({ path:path.join(output, `${gameKind}-${width}-${theme}-result.png`) });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Result fits viewport');
    await page.locator('#completionPanel button[data-action="restart"]').click();
    await choices.first().waitFor();
    failReveal = true;
    for (let pick = 0; pick < (gameKind === 'draft-night' ? 5 : 1); pick++) await choices.first().click();
    await page.locator('#gameStatus.is-error').waitFor();
    assert.equal(await page.locator('#completionPanel .fix-five-total-score:visible').count(), 0);
    failReveal = false;
    if (gameKind === 'draft-night') await page.locator('button[data-action="retry"]').click();
    else await choices.first().click();
    await page.locator(gameKind === 'draft-night' ? '#completionPanel .fix-five-total-score' : '.fix-five-round-score').waitFor();
    unavailable = true; await page.reload();
    await page.locator('#gameStatus.is-error').waitFor();
    assert.equal(await choices.count(), 0);
    await page.locator('#retryBoard').waitFor();
    unavailable = false;
    await page.locator('#retryBoard').click();
    await page.locator(gameKind === 'draft-night' ? '#completionPanel .fix-five-total-score' : 'button[data-action="choose"]').first().waitFor();
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed:true, widths:[390,900,1440], themes:['dark','light'], fixture:'synthetic offline only',
    checked:['visible board entry', 'keyboard board entry', 'keyboard choices', 'collapsible rules', 'draft slots', 'undo', 'change swap', 'complete', 'restart', 'reveal failure and retry', 'unavailable board', 'overflow'], screenshots:output }));
} finally { await browser?.close(); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); }
