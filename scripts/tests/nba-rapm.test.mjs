import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRapmObservations, fitWeightedRidgeRapm, RAPM_MODEL_VERSION } from '../lib/nba-rapm.mjs';

const home = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005'];
const away = ['00000000-0000-4000-8000-000000000006', '00000000-0000-4000-8000-000000000007', '00000000-0000-4000-8000-000000000008', '00000000-0000-4000-8000-000000000009', '00000000-0000-4000-8000-000000000010'];

function sampleStints() {
  return [
    { gameId: 'game-a', stintOrdinal: 2, homePlayerIds: home, awayPlayerIds: away, homePoints: 12, awayPoints: 4, homeOffensivePossessions: 8, awayOffensivePossessions: 8 },
    { gameId: 'game-a', stintOrdinal: 1, homePlayerIds: home, awayPlayerIds: away, homePoints: 8, awayPoints: 4, homeOffensivePossessions: 8, awayOffensivePossessions: 8 },
    { gameId: 'game-b', stintOrdinal: 1, homePlayerIds: away, awayPlayerIds: home, homePoints: 3, awayPoints: 9, homeOffensivePossessions: 6, awayOffensivePossessions: 6 },
  ];
}

test('RAPM observation build excludes invalid rows rather than inventing a lineup', () => {
  const built = buildRapmObservations([
    ...sampleStints(),
    { gameId: 'bad', homePlayerIds: home.slice(0, 4), awayPlayerIds: away, homePoints: 1, awayPoints: 1, homeOffensivePossessions: 1, awayOffensivePossessions: 1 },
  ]);
  assert.equal(built.observations.length, 3);
  assert.equal(built.excluded.length, 1);
  assert.match(built.excluded[0].reason, /exactly five/);
  assert.equal(built.observations[0].stintOrdinal, 1);
});

test('weighted ridge RAPM is deterministic and uses a non-regularized intercept', () => {
  const first = fitWeightedRidgeRapm(sampleStints(), { lambda: 5, seasonEndYear: 2025 });
  const second = fitWeightedRidgeRapm([...sampleStints()].reverse(), { lambda: 5, seasonEndYear: 2025 });
  assert.equal(first.modelVersion, RAPM_MODEL_VERSION);
  assert.equal(first.inputSha256, second.inputSha256);
  assert.deepEqual(first.players, second.players);
  assert.equal(first.observationCount, 3);
  assert.equal(first.gameCount, 2);
  assert.ok(first.players.find((row) => row.providerPlayerId === home[0]).rapmPer100 > 0);
  assert.ok(first.players.find((row) => row.providerPlayerId === away[0]).rapmPer100 < 0);
  assert.equal(first.players.find((row) => row.providerPlayerId === home[0]).observationCount, 3);
  assert.ok(Number.isFinite(first.players.find((row) => row.providerPlayerId === home[0]).teammateRapmContextPer100));
  assert.ok(Number.isFinite(first.players.find((row) => row.providerPlayerId === home[0]).opponentRapmContextPer100));
});

test('RAPM rejects a zero or negative ridge lambda', () => {
  assert.throws(() => fitWeightedRidgeRapm(sampleStints(), { lambda: 0 }), /greater than zero/);
  assert.throws(() => fitWeightedRidgeRapm([], { lambda: 1 }), /No valid paired/);
});
