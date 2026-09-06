import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseStudioArgs, createScoutStudioServer } from './preview-scout-studio.mjs';
import { readReadinessMetadata } from './audit-lineup-scout-readiness.mjs';
import { createScoutStudioSource } from './lib/scout-studio-source.mjs';

// Read-only integration spot check of one real team; the full package validator
// remains responsible for all 30. No files, database rows or model fits change.
const browserCheck = process.argv.includes('--browser');
const options = parseStudioArgs(process.argv.slice(2).filter(arg => arg !== '--browser'));
const source = createScoutStudioSource(options);
const status = await source.status();
assert.equal(status.phase, 'ready', 'The exact current package must pass readiness first.');
const { data: manifest } = await readReadinessMetadata(options.manifest);
const smallest = [...manifest.dataShards].sort((a, b) => a.jsonBytes - b.jsonBytes)[0];
const team = status.teams.find(team => team.name === smallest.team);
console.log(JSON.stringify({ stage: 'streaming_one_validated_team', team: team.name, bytes: smallest.jsonBytes }));
const started = Date.now();
const roster = await source.roster(team.id, status.snapshot);
assert.equal(roster.players.length, smallest.rows.playerProfiles);
assert.ok(roster.players.some(player => player.metrics.some(metric => metric.status === 'observed')));
assert.ok(roster.players.some(player => player.tendencies.labels.length));
const selected = [...roster.players].sort((a, b) => b.minutes - a.minutes).slice(0, 2).map(player => player.id);
const result = await source.chemistry(team.id, status.snapshot, selected);
assert.ok(result.combination, 'Most-used pair must have an observed co-presence record.');
assert.equal(result.wowy.length, 4);
assert.doesNotMatch(JSON.stringify({ roster, result }), /"(?:playerId|teamId|rapm|coefficient|archivePath|manifestSha256)"/);
console.log(JSON.stringify({ passed: true, scope: 'one-team integration spot check, not a 30-team UI audit',
  team: team.name, profiles: roster.players.length, chemistryStatus: result.combination.sample.status,
  observedMetrics: roster.players.reduce((sum, player) => sum + player.metrics.filter(metric => metric.status === 'observed').length, 0),
  unavailableMetrics: roster.players.reduce((sum, player) => sum + player.metrics.filter(metric => metric.status === 'unavailable').length, 0),
  independentBoxScore: Object.fromEntries(['complete_and_reconciled', 'not_fully_reconciled'].map(state => [state, roster.players.filter(player => player.coverage.independentBoxScore === state).length])),
  elapsedSeconds: Math.round((Date.now() - started) / 1000) }));

if (browserCheck) {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const executablePath = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(existsSync);
  const server = createScoutStudioServer(source);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const errors = [];
    const base = `http://127.0.0.1:${server.address().port}`;
    const output = path.resolve('outputs/scout-studio-smoke');
    await fs.mkdir(output, { recursive: true });
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/tools/scout-studio/`);
      await page.getByRole('heading', { name: 'Validated for local integration review' }).waitFor();
      await page.locator('#teamSelect').selectOption(team.id);
      await page.getByRole('button', { name: 'Load team evidence' }).click();
      await page.getByText(`${roster.players.length} source player profiles loaded.`, { exact: false }).waitFor();
      await page.locator('#playerSelect').selectOption(selected[0]);
      await page.locator('#compareSelect').selectOption(selected[1]);
      await page.locator('#blueprintTitle').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `real-blueprint-${viewport.width}.png`) });
      await page.getByRole('button', { name: 'Chemistry Lab', exact: true }).click();
      for (const id of selected) await page.getByRole('button', { name: roster.players.find(player => player.id === id).name, exact: true }).click();
      await page.getByRole('button', { name: 'Inspect shared floor' }).click();
      await page.locator('#chemistryContent table').first().waitFor();
      assert.equal(await page.locator('#chemistryContent table').count(), 2);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.locator('#chemistryContent').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(output, `real-chemistry-${viewport.width}.png`) });
      await page.close();
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ realPackageBrowserCheck: 'passed', viewports: [1440, 390], team: team.name, screenshots: output }));
  } finally {
    await browser?.close();
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
