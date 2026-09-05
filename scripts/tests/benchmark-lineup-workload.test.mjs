import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, fitProfiles, gameRows } from '../benchmark-lineup-workload.mjs';

const games = Array.from({ length: 120 }, (_, i) => ({ id: `game-${i}`, date: new Date(Date.UTC(2025, 0, i + 1)).toISOString(), rows: [
  { id: 'p', games: 1, minutes: 20 + i % 8, fga: 12, tpa: 5, points: 13 + i % 9, assists: 4, rebounds: 5, steals: 1, blocks: .5, ballSecurity: 2, efgPct: 6.5, threePct: 2 },
] }));
test('held-out target mutations cannot change trained or tuned parameters', () => {
  const before = runBenchmark(games);
  const changed = structuredClone(games); for (const g of changed.slice(96)) g.rows[0].points *= 3;
  const after = runBenchmark(changed);
  for (const k of Object.keys(before.metrics)) assert.deepEqual(before.metrics[k].parameters, after.metrics[k].parameters);
  assert.notEqual(before.metrics.points.test.mse, after.metrics.points.test.mse);
  assert.equal(before.split.trainGames + before.split.tuningGames + before.split.testGames, games.length);
});
test('profiles aggregate by player across trades, never by selected team stint', () => {
  const changed = structuredClone(games);
  changed.forEach((g, i) => { g.rows[0].team = i < 15 ? 'OLD' : 'NEW'; });
  assert.deepEqual(fitProfiles(games), fitProfiles(changed));
});
test('incomplete source scoring cannot become benchmark ground truth', () => {
  const archive = { players: [{ id: 'p', minutesPlayed: 20, providerTeamId: 'home' }], events: [], game: { homeProviderTeamId: 'home', awayProviderTeamId: 'away', homePoints: 100, awayPoints: 90 } };
  assert.deepEqual(gameRows(archive), []);
});
