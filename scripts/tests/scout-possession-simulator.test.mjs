import assert from 'node:assert/strict';
import test from 'node:test';
import { dailyMatchup, possessionDistribution, teamGameEvidence, simulateMatchup } from '../../tools/scout-studio/possession-simulator.js';
import { describeScoutTeamContexts } from '../lib/scout-studio.mjs';
import { rawTeamRow, fixtureSource, snapshot } from './fixtures/scout-studio-fixture.mjs';

const source = fixtureSource();
const a = await source.teamContexts('t0', snapshot), b = await source.teamContexts('t1', snapshot);
const input = { a, b, season: 2024, seed: 'review-20260907', trials: 1000, possessions: 100, attackWeight: 0.5 };

function certain(team, attack, allowed) {
  const evidence = structuredClone(a); evidence.team = team;
  const names = ['empty', 'one', 'two', 'three'];
  evidence.contexts.forEach(row => {
    Object.assign(row, { offensiveRating: attack * 100, defensiveRating: allowed * 100, netRating: (attack - allowed) * 100, interval: null });
    for (const [side, points] of [['offense', attack], ['defense', allowed]]) {
      row.outcomes[side].points = points * 1000;
      row.outcomes[side].counts = { empty: 0, one: 0, two: 0, three: 0, fourPlus: 0, [names[points]]: 1000 };
    }
  });
  return evidence;
}

test('possession samples reconcile all counts and preserve the 4+ bucket mean', () => {
  const raw = a.contexts.find(row => row.key === 'season:2024').outcomes.offense;
  const report = possessionDistribution(raw, 1000);
  assert.equal(report.status, 'ready'); assert.equal(report.tailMean, 4.3);
  assert.ok(Math.abs(report.outcomes.reduce((sum, row) => sum + row.probability, 0) - 1) < 1e-12);
  assert.ok(Math.abs(report.outcomes.reduce((sum, row) => sum + row.probability * row.points, 0) - raw.points / 1000) < 1e-12);
  assert.deepEqual(report.outcomes.filter(row => row.points >= 4).map(row => row.points), [4, 5]);
});

test('missing, mismatched, negative, excessive-tail and low-count evidence stays unavailable', () => {
  const raw = a.contexts[0].outcomes.offense;
  for (const broken of [null, { ...raw, possessions: 199 }, { ...raw, points: null }, { ...raw, points: 1 },
    { ...raw, points: 100000 }, { ...raw, counts: { ...raw.counts, empty: null } },
    { ...raw, counts: { ...raw.counts, one: -1 } }, { ...raw, counts: { ...raw.counts, two: 301 } }]) {
    assert.equal(possessionDistribution(broken, 1000).status, 'unavailable');
  }
  assert.equal(possessionDistribution(raw, 999).status, 'unavailable');
});

test('team evidence is season-specific and rejects contradictory ratings and duplicate partitions', () => {
  assert.equal(teamGameEvidence(a, 2024).status, 'ready');
  assert.throws(() => teamGameEvidence(a, 2016), /supported/);
  const sparse = structuredClone(a); sparse.contexts = []; assert.equal(teamGameEvidence(sparse, 2024).status, 'unavailable');
  const wrong = structuredClone(a); wrong.contexts.find(row => row.key === 'season:2024').outcomes.offense.points++;
  assert.equal(teamGameEvidence(wrong, 2024).status, 'unavailable');
  assert.throws(() => teamGameEvidence({ ...a, contexts: [a.contexts[0], a.contexts[0]] }, 2024), /duplicated/);
  assert.throws(() => teamGameEvidence({ ...a, contexts: [{ key: 'private:effect' }] }, 2024), /unsupported/);
});

test('simulation is deterministic, bounded, input-preserving and conserves experiment counts', async () => {
  const before = structuredClone(input), first = await simulateMatchup(input), again = await simulateMatchup(input);
  assert.deepEqual(first, again); assert.deepEqual(input, before);
  assert.equal(first.modelVersion, 'scout-possession-scenario-v1');
  assert.equal(Object.values(first.wins).reduce((sum, n) => sum + n, 0), input.trials);
  assert.equal(first.firstGame.histogram.reduce((sum, bin) => sum + bin.count, 0), input.trials);
  assert.equal(first.example.games[0].timeline.length >= 4, true);
  assert.ok(first.firstGame.scoreA[10] <= first.firstGame.scoreA[50] && first.firstGame.scoreA[50] <= first.firstGame.scoreA[90]);
  assert.notDeepEqual(first.example, (await simulateMatchup({ ...input, seed: 'another-seed' })).example);
});

test('offense weight endpoints and pace changes match their analytic expectations', async () => {
  const offense = await simulateMatchup({ ...input, trials: 100, attackWeight: 1 });
  const defense = await simulateMatchup({ ...input, trials: 100, attackWeight: 0 });
  const faster = await simulateMatchup({ ...input, trials: 100, attackWeight: 1, possessions: 120 });
  assert.equal(offense.expectedRegulationScore.a, 116.3);
  assert.equal(defense.expectedRegulationScore.a, 114.3);
  assert.ok(Math.abs(faster.expectedRegulationScore.a - offense.expectedRegulationScore.a * 1.2) < 1e-10);
});

test('degenerate samples preserve real zeroes and a certain winner ends every series in four', async () => {
  const report = await simulateMatchup({ ...input, a: certain('t0', 0, 2), b: certain('t1', 2, 0), trials: 100, format: 'best_of_7' });
  assert.deepEqual(report.wins, { a: 0, b: 100, unresolved: 0 });
  assert.equal(report.seriesLengths[4], 100); assert.equal(report.gamesPlayed, 400);
  assert.deepEqual(report.example.seriesWins, { a: 0, b: 4 });
  assert.equal(report.example.games[0].a, 0); assert.equal(report.example.games[0].b, 200);
});

test('tied games stay unresolved after the overtime cap, without a coin-flip winner', async () => {
  const report = await simulateMatchup({ ...input, a: certain('t0', 0, 0), b: certain('t1', 0, 0), trials: 100, format: 'best_of_7' });
  assert.deepEqual(report.wins, { a: 0, b: 0, unresolved: 100 });
  assert.equal(Object.values(report.seriesLengths).reduce((sum, n) => sum + n, 0), 0);
  assert.equal(report.example.games[0].overtimes, 6); assert.equal(report.gamesPlayed, 100);
});

test('series totals, wins and length bins reconcile across random experiments', async () => {
  const report = await simulateMatchup({ ...input, trials: 500, format: 'best_of_7' });
  assert.equal(report.wins.a + report.wins.b + report.wins.unresolved, 500);
  assert.equal(Object.values(report.seriesLengths).reduce((sum, n) => sum + n, 0), 500 - report.wins.unresolved);
  assert.ok(report.example.games.length >= 4 && report.example.games.length <= 7);
  assert.ok(Math.abs(report.example.seriesWins.a - report.example.seriesWins.b) >= 1);
});

test('same-team, mixed-snapshot, unsupported, non-finite and excessive runs are rejected', async () => {
  for (const change of [{ b: a }, { b: { ...b, snapshot: `s${'b'.repeat(24)}` } }, { trials: 5001 }, { possessions: 59 },
    { trials: 100.5 }, { attackWeight: NaN }, { attackWeight: 2 }, { seed: '<script>' }, { seed: '' }, { season: 2020 }, { format: 'season' }]) {
    await assert.rejects(simulateMatchup({ ...input, ...change }));
  }
});

test('runs yield in bounded batches and honor cancellation before producing a result', async () => {
  const controller = new AbortController(); let batches = 0;
  await assert.rejects(simulateMatchup(input, { signal: controller.signal, yieldEveryBatch: async () => { batches++; controller.abort(); } }), { name: 'AbortError' });
  assert.equal(batches, 1);
});

test('daily setups are reproducible across roster ordering, diverse, and confined to the requested game seasons', () => {
  const teams = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}` }));
  const challenge = dailyMatchup(teams, snapshot, '2026-09-07');
  assert.equal(challenge.modelVersion, 'scout-possession-scenario-v1');
  assert.deepEqual(challenge, dailyMatchup([...teams].reverse(), snapshot, '2026-09-07'));
  const days = Array.from({ length: 28 }, (_, index) => dailyMatchup(teams, snapshot, `2026-09-${String(index + 1).padStart(2, '0')}`));
  assert.ok(days.every(day => day.a !== day.b && [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025].includes(day.season)));
  assert.ok(new Set(days.flatMap(day => [day.a, day.b])).size > 15);
  assert.throws(() => dailyMatchup(teams, snapshot, '2026-02-30'), /valid challenge date/);
});

test('team projection strips private IDs, raw model fields, and arbitrary source notes', () => {
  const row = rawTeamRow(); row.contexts.all.possessionOutcomes.offense.coefficient = 'DO-NOT-EXPOSE';
  const projected = describeScoutTeamContexts(row);
  assert.doesNotMatch(JSON.stringify(projected), /private-team|coefficient|rapm|archivePath|DO-NOT-EXPOSE/);
  assert.equal(projected[0].outcomes.offense.points, 1163);
});
