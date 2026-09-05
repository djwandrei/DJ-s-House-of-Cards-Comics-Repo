import test from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark, fitProfiles, gameRows, evaluate } from '../benchmark-lineup-workload.mjs';
import { chronologicalSplit, validateGames, pairedGameBootstrap } from '../lib/lineup-workload-validation.mjs';

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

test('direct evaluation cannot reuse training identities or training calendar dates', () => {
  const fit = fitProfiles(games.slice(0, 10));
  assert.throws(() => evaluate([games[0]], fit, 'points', {}), /strictly after/);
  const reused = { ...structuredClone(games[15]), id: games[0].id };
  assert.throws(() => evaluate([reused], fit, 'points', {}), /strictly after/);
  const sameDay = { ...structuredClone(games[15]), date: games[9].date.replace('00:00', '12:00') };
  assert.throws(() => evaluate([sameDay], fit, 'points', {}), /strictly after/);
});

test('source adapter retains free throw evidence and honors explicit three point fields', () => {
  const archive = {
    players: [{ id: 'p', minutesPlayed: 20, providerTeamId: 'home' }],
    events: [
      { id: 'shot', eventType: 'fieldgoal', statistics: [{ type: 'fieldgoal', player: { id: 'p' }, made: true, three_point_shot: true }] },
      { id: 'ft-1', statistics: [{ type: 'freethrow', player: { id: 'p' }, made: true }] },
      { id: 'ft-2', statistics: [{ type: 'freethrow', player: { id: 'p' }, made: false }] },
      { id: 'team', statistics: [{ type: 'rebound' }, { type: 'turnover' }] },
    ],
    game: { providerGameId: 'a', scheduledAt: games[0].date, homeProviderTeamId: 'home', awayProviderTeamId: 'away', homePoints: 4, awayPoints: 0 },
  };
  const [row] = gameRows(archive);
  assert.equal(row.fta, 2); assert.equal(row.ftm, 1); assert.equal(row.tpa, 1); assert.equal(row.threePct, 1);
  assert.equal(row.rebounds, 0); assert.equal(row.ballSecurity, 0);
  archive.players.push(archive.players[0]);
  assert.deepEqual(gameRows(archive), []);
});
test('incomplete source scoring cannot become benchmark ground truth', () => {
  const archive = { players: [{ id: 'p', minutesPlayed: 20, providerTeamId: 'home' }], events: [], game: { homeProviderTeamId: 'home', awayProviderTeamId: 'away', homePoints: 100, awayPoints: 90 } };
  assert.deepEqual(gameRows(archive), []);
});

test('calendar-day blocks never straddle train, tuning, and test sets', () => {
  const sameDays = structuredClone(games);
  sameDays.forEach((g, i) => { g.date = new Date(Date.UTC(2025, 0, 1 + Math.floor(i / 7), i % 7)).toISOString(); });
  const { train, tune, test: heldout } = chronologicalSplit(sameDays);
  assert.notEqual(train.at(-1).date.slice(0, 10), tune[0].date.slice(0, 10));
  assert.notEqual(tune.at(-1).date.slice(0, 10), heldout[0].date.slice(0, 10));
  assert.equal(train.length + tune.length + heldout.length, games.length);
  assert.throws(() => chronologicalSplit(sameDays.map(g => ({ ...g, date: sameDays[0].date }))), /three distinct UTC/);
});

test('duplicates, mixed row grain, and invalid or inconsistent dates fail closed', () => {
  assert.throws(() => runBenchmark([...games, games[0]]), { message: /duplicate game/ });
  const duplicateRow = structuredClone(games); duplicateRow[0].rows.push(duplicateRow[0].rows[0]);
  assert.throws(() => fitProfiles(duplicateRow), /duplicate player/);
  const mismatch = structuredClone(games); mismatch[0].rows[0].gameId = 'not-this-game';
  assert.throws(() => validateGames(mismatch), /identity mismatch/);
  const dates = structuredClone(games); dates[0].rows[0].date = games[1].date;
  assert.throws(() => validateGames(dates), /row date mismatch/);
  for (const date of ['2025-02-30T00:00:00Z', '2025-01-01', 'yesterday', null]) {
    assert.throws(() => validateGames([{ ...games[0], date }]), /timestamp|calendar date/);
  }
  assert.throws(() => validateGames([{ ...games[0], rows: [{ ...games[0].rows[0], games: 2 }] }]), /one appearance/);
});

test('equivalent timezone timestamps sort by time, and row timestamp equivalence is allowed', () => {
  const changed = structuredClone(games);
  changed[0].date = '2024-12-31T18:00:00-06:00';
  changed[0].rows[0].date = '2025-01-01T00:00:00Z';
  assert.doesNotThrow(() => validateGames(changed));
  assert.equal(chronologicalSplit(changed).train[0].id, games[0].id);
});

test('metric samples pair real numerators and denominators instead of coercing missing stats', () => {
  const source = structuredClone(games.slice(0, 10));
  source[0].rows[0].points = null;
  source[1].rows[0].points = undefined;
  source[2].rows[0].efgPct = null;
  source[3].rows[0].fga = null;
  const fit = fitProfiles(source), sample = fit.metricEvidence.players.get('p');
  assert.equal(sample.points.games, 8);
  assert.equal(sample.points.exposure, source.slice(2).reduce((sum, g) => sum + g.rows[0].minutes, 0));
  assert.equal(sample.efgPct.games, 8);
  assert.equal(sample.efgPct.exposure, 96);
  assert.equal(fit.players.get('p').games, 10);
});

test('no eligible rows yield null errors and explicit exclusion accounting', () => {
  const fit = fitProfiles(games.slice(0, 10));
  const target = structuredClone(games.slice(10, 14));
  target[0].rows[0].fga = null;
  target[1].rows[0].fga = 0;
  target[2].rows[0].efgPct = null;
  target[3].rows[0].id = 'new-player';
  const result = evaluate(target, fit, 'efgPct', { prior: 0, strength: 0 }, { includeGameLosses: true });
  assert.equal(result.mse, null);
  assert.equal(result.mae, null);
  assert.equal(result.eligibility.exclusions.missingTargetDenominator, 2);
  assert.equal(result.eligibility.exclusions.missingTargetNumerator, 1);
  assert.equal(result.eligibility.exclusions.unknownPlayer, 1);
  assert.equal(Object.values(result.eligibility.exclusions).reduce((a, b) => a + b, 0), result.eligibility.consideredPlayerGames);
  assert.equal(pairedGameBootstrap(result, result).status, 'no-eligible-exposure');
  assert.equal(evaluate([], fit, 'points', { prior: 0, strength: 0 }).mse, null);
  const emptyFitResult = evaluate(target, fitProfiles([]), 'points', {});
  assert.equal(emptyFitResult.mse, null);
  assert.equal(emptyFitResult.eligibility.exclusions.missingLeagueBaseline, 4);
});

test('a wholly missing tuning metric is unavailable, never a zero-error fitted model', () => {
  const changed = structuredClone(games);
  changed.forEach(g => { g.rows[0].threePct = null; });
  const report = runBenchmark(changed, { bootstrapIterations: 0 });
  assert.equal(report.metrics.threePct.parameters, null);
  assert.equal(report.metrics.threePct.status, 'unavailable-no-eligible-tuning-rows');
  assert.equal(report.metrics.threePct.improvementVsRaw, null);
  assert.equal(report.metrics.points.status, 'evaluated');
});

test('subgroups use training role and metric evidence, not held-out minutes or target performance', () => {
  const source = structuredClone(games.slice(0, 10));
  source.forEach(g => { g.rows[0].minutes = 10; });
  const fit = fitProfiles(source);
  const target = structuredClone(games.slice(10, 12));
  target.forEach(g => { g.rows[0].minutes = 40; g.rows[0].points = 90; });
  const low = evaluate(target, fit, 'points', { prior: 0, strength: 0 }, { subgroup: 'lowMinutes' });
  const high = evaluate(target, fit, 'points', { prior: 0, strength: 0 }, { subgroup: 'highMinutes' });
  assert.equal(low.playerGames, 2);
  assert.equal(high.playerGames, 0);
  assert.equal(high.eligibility.exclusions.outsideSubgroup, 2);
  assert.equal(evaluate(target, fit, 'points', {}, { subgroup: 'lowSample' }).playerGames, 2);
});

test('paired bootstrap is deterministic, game-clustered, and leaves zero reference error undefined', () => {
  const row = (gameId, squared, exposure) => ({ gameId, squared, exposure, playerGames: 2 });
  const projected = { mse: 1, exposure: 60, gameLosses: [row('a', 10, 10), row('b', 20, 20), row('c', 30, 30)] };
  const raw = { mse: 2, exposure: 60, gameLosses: [row('a', 20, 10), row('b', 40, 20), row('c', 60, 30)] };
  const first = pairedGameBootstrap(projected, raw, { iterations: 200, seed: 77 });
  assert.deepEqual(first, pairedGameBootstrap(projected, raw, { iterations: 200, seed: 77 }));
  assert.equal(first.eligibleGames, 3);
  assert.equal(first.validReplicates, 200);
  assert.equal(first.lower, .5);
  assert.equal(first.upper, .5);
  assert.equal(first.estimate, .5);
  const imperfect = structuredClone(raw); imperfect.gameLosses[0].squared = 50;
  const varying = pairedGameBootstrap(projected, imperfect, { iterations: 200, seed: 77 });
  assert.ok(varying.upper > varying.lower);
  const zero = { mse: 0, exposure: 60, gameLosses: raw.gameLosses.map(g => ({ ...g, squared: 0 })) };
  assert.equal(pairedGameBootstrap(zero, zero).estimate, null);
  const mismatched = structuredClone(raw); mismatched.gameLosses[0].exposure++;
  assert.throws(() => pairedGameBootstrap(projected, mismatched), /population mismatch/);
});

test('benchmark persists only aggregate bootstrap output, not per-game losses', () => {
  const report = runBenchmark(games, { bootstrapIterations: 50 });
  assert.equal(report.metrics.points.uncertainty.vsRaw.iterations, 50);
  assert.equal(report.metrics.points.uncertainty.vsShrinkOnly.method, 'paired-game-cluster-percentile');
  assert.equal(JSON.stringify(report).includes('gameLosses'), false);
  assert.equal(report.split.timezone, 'UTC');
});
