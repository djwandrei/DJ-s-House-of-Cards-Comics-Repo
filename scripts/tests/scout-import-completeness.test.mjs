import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { seasonDownloadCompleteness } from '../audit-scout-import-completeness.mjs';

test('download completeness includes never-attempted games, not just current manifest errors', () => {
  const summary = seasonDownloadCompleteness({ uniqueEligibleGames: 4, games: { a: { status: 'completed' }, b: { status: 'failed' } } });
  assert.equal(summary.completedGames, 1);
  assert.equal(summary.notYetAttemptedGames, 2);
  assert.equal(summary.allScheduledGamesDownloaded, false);
  assert.deepEqual(summary.unresolved, [{ gameId: 'b', status: 'failed' }]);
});

test('missing schedule denominator cannot be certified as complete', () => {
  assert.equal(seasonDownloadCompleteness({ games: { a: { status: 'completed' } } }).allScheduledGamesDownloaded, false);
  assert.equal(seasonDownloadCompleteness({ uniqueEligibleGames: 1, games: { a: { status: 'completed' } } }).allScheduledGamesDownloaded, true);
});

test('serial import controller contains no builder call and never includes limited numbered keys', async () => {
  const source = await fs.readFile(new URL('../continue-scout-data-import.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\brebuildScoutModelEvidence\s*\(/);
  assert.match(source, /rebuildStarted: false/);
  assert.match(source, /transient-429-retries', '0'/);
  assert.match(source, /delete process\.env\[name\]/);
});
