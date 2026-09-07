import test from 'node:test';
import assert from 'node:assert/strict';
import { compileScoutPlayerGameEvidence, pairedMetricEvidence, shootingOpportunity, posteriorRate } from '../projection-evidence.js';
import { loadOptimizerCore } from './load-optimizer-core.mjs';
import { readSeasonRoleMinutes, readPlayerUsage, projectPlayerResponsibility } from '../player-projection.js';
const { optimizeLineups } = await loadOptimizerCore();

const scope = { playerId: 'player', seasonStartYear: 2025, phase: 'regular', sourceRevision: 'interrupted-test-package' };
function game(id, teamId, minutes, fields = {}) {
  const box = { points: 10, rebounds: 4, assists: 3, steals: 1, blocks: 1, turnovers: 2,
    fieldGoalAttempts: 10, fieldGoalsMade: 4, threePointAttempts: 4, threePointersMade: 2, ...fields };
  return { playerId: 'player', gameId: id, teamId, seasonStartYear: 2025, phase: 'regular',
    officialMinutes: minutes, minutesReconciled: true, rateExposure: { officialPer36Minutes: minutes },
    officialTotals: { ...box }, pbpTotals: { ...box },
    fieldReconciliation: Object.fromEntries(Object.keys(box).map(key => [key, 'matched'])),
    officialIdentityIssues: [], pbpIdentityIssues: [] };
}

test('each component uses matching verified game counts and minutes across traded teams', () => {
  const rows = [game('a', 'OLD', 10), game('b', 'NEW', 30)];
  rows[1].officialTotals.steals = null; rows[1].fieldReconciliation.steals = 'unavailable';
  const result = compileScoutPlayerGameEvidence(rows, scope);
  assert.equal(result.metrics.points.minutes, 40);
  assert.equal(result.metrics.points.numerator, 20);
  assert.equal(result.metrics.steals.minutes, 10);
  assert.equal(result.metrics.steals.numerator, 1);
  assert.equal(result.metrics.threePct.sample, 8);
  assert.equal(result.metrics.threePct.participationPer36, 7.2);
  assert.deepEqual(result.coverage.steals.omittedGameIds, ['b']);
  assert.equal(result.coverage.points.completeWithinSuppliedGames, true);
  assert.equal(result.coverage.points.wholeSeasonCertified, false);
});

test('a shooting gap excludes that game from BOTH accuracy counts and frequency exposure', () => {
  const rows = [game('a', 'OLD', 6, { threePointAttempts: 1, threePointersMade: 1 }), game('b', 'NEW', 36)];
  rows[1].officialTotals.threePointersMade = null;
  const result = compileScoutPlayerGameEvidence(rows, scope);
  assert.equal(result.metrics.threePct.sample, 1);
  assert.equal(result.metrics.threePct.minutes, 6);
  assert.equal(result.metrics.threePct.numerator, 1);
  assert.equal(result.metrics.points.minutes, 42, 'unrelated verified points survive');
  assert.deepEqual(shootingOpportunity(result.metrics.threePct), shootingOpportunity({ sample: 1, minutes: 6 }));
});

test('lying matched flags, invalid counts, inconsistent shots and missing exposure cannot certify evidence', () => {
  for (const mutate of [
    row => { row.officialTotals.threePointersMade = 3; },
    row => { row.officialTotals.threePointersMade = -1; },
    row => { row.pbpTotals.threePointAttempts = row.officialTotals.threePointAttempts = 9; },
    row => { row.officialMinutes = 0; row.rateExposure.officialPer36Minutes = 0; },
    row => { row.minutesReconciled = false; },
    row => { delete row.rateExposure; },
    row => { delete row.officialIdentityIssues; },
  ]) {
    const row = game('a', 'T', 20); mutate(row);
    assert.equal(compileScoutPlayerGameEvidence([row], scope).metrics.threePct, null);
  }
});

test('duplicate player-games reject aggregation, while different seasons/phases/players do not leak', () => {
  const a = game('a', 'T', 20);
  assert.throws(() => compileScoutPlayerGameEvidence([a, { ...a, teamId: 'OTHER' }], scope), /Duplicate/);
  const result = compileScoutPlayerGameEvidence([a, { ...a, seasonStartYear: 2024 }, { ...a, phase: 'playoffs' }, { ...a, playerId: 'other' }], scope);
  assert.equal(result.metrics.points.verifiedGames, 1);
  assert.throws(() => compileScoutPlayerGameEvidence([a], { ...scope, sourceRevision: '' }), /explicit/);
});

test('zero attempts remain known zero opportunity rather than missing or reliable shooting skill', () => {
  const row = game('a', 'T', 30, { threePointAttempts: 0, threePointersMade: 0 });
  const evidence = compileScoutPlayerGameEvidence([row], scope).metrics.threePct;
  assert.equal(evidence.sample, 0);
  assert.equal(shootingOpportunity(evidence).decisionPer36, 0);
  assert.equal(posteriorRate(evidence.value, { ...evidence, metric: 'threePct', baseline: .36, prior: 180 }).mean, .36);
});

test('the solver reads the new paired evidence and never fills its gaps from the older dataset', () => {
  const row = game('a', 'T', 6, { threePointAttempts: 1, threePointersMade: 1 });
  row.officialTotals.steals = null;
  const compiled = compileScoutPlayerGameEvidence([row], scope);
  const player = { id: 'player', analytics: { scoutPlayerGameEvidence: compiled,
    seasonTotals: { minutes: 2000, steals: 100, threePointFieldGoalsMade: 100, threePointFieldGoalsAttempted: 300 } } };
  assert.equal(pairedMetricEvidence(player, 'threePct').sample, 1);
  assert.equal(pairedMetricEvidence(player, 'steals'), null);
  assert.equal(pairedMetricEvidence({ ...player, id: 'wrong-player' }, 'threePct'), null);
});

test('more actual attempt evidence strengthens the same rate; proposed minutes cannot enlarge the sample', () => {
  const small = compileScoutPlayerGameEvidence([game('a', 'T', 6, { threePointAttempts: 1, threePointersMade: 1 })], scope).metrics.threePct;
  const rows = Array.from({ length: 40 }, (_, i) => game(String(i), 'T', 30, { threePointAttempts: 5, threePointersMade: 5, fieldGoalsMade: 5 }));
  const large = compileScoutPlayerGameEvidence(rows, scope).metrics.threePct;
  assert.equal(small.participationPer36, large.participationPer36);
  assert.ok(shootingOpportunity(large).decisionPer36 > shootingOpportunity(small).decisionPer36);
  const player = { id: 'player', minutes: 36, games: 82, analytics: { scoutPlayerGameEvidence: compileScoutPlayerGameEvidence([game('a', 'T', 6, { threePointAttempts: 1, threePointersMade: 1 })], scope) } };
  assert.equal(pairedMetricEvidence(player, 'threePct').sample, 1);
  player.minutes = 48; player.games = 1;
  assert.equal(pairedMetricEvidence(player, 'threePct').sample, 1);
});

test('no observed sample produces the stated prior without borrowing a raw rate', () => {
  const result = posteriorRate(NaN, { sample: 0, prior: 100, baseline: 15, metric: 'points' });
  assert.equal(result.mean, 15);
  assert.ok(Number.isFinite(result.standardError));
});

test('exact selection uses interrupted-package evidence, not contradictory legacy display numbers', () => {
  const player = (id, points, legacyPoints) => {
    const row = { ...game(id, 'T', 24, { points }), playerId: id };
    return { id, name: id, team: 'TST', positions: ['G', 'F', 'C'], games: 1, starts: 1, minutes: 24,
      points: legacyPoints, rebounds: 4, assists: 3, steals: 1, blocks: 1, turnovers: 2, efgPct: .5, threePct: .5, fgPct: .4, ftPct: .8,
      analytics: { scoutPlayerGameEvidence: compileScoutPlayerGameEvidence([row], { ...scope, playerId: id }) } };
  };
  const result = optimizeLineups([player('supported', 20, 1), player('legacy-spike', 5, 100)],
    { size: 1, alternatives: 1, weights: { points: 1 }, roleBalance: 'off' });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(result.best.players[0].id, 'supported');
  const floor = optimizeLineups([player('supported', 20, 1)],
    { size: 1, alternatives: 1, weights: { points: 1 }, statMinimums: { points: 19 }, roleBalance: 'off' });
  assert.equal(floor.ok, true, JSON.stringify(floor.reasons));
  assert.equal(floor.best.totals.points, 20);
  const impossible = optimizeLineups([player('legacy-spike', 5, 100)],
    { size: 1, alternatives: 1, weights: { points: 1 }, statMinimums: { points: 10 }, roleBalance: 'off' });
  assert.equal(impossible.ok, false, 'A legacy spike cannot satisfy the new evidence constraint.');
  const unknown = player('missing', 10, 100);
  const missingRow = { ...game('missing', 'T', 24), playerId: 'missing' };
  missingRow.officialTotals.steals = null;
  unknown.analytics.scoutPlayerGameEvidence = compileScoutPlayerGameEvidence([missingRow], { ...scope, playerId: 'missing' });
  const gap = optimizeLineups([unknown], { size: 1, weights: { points: 1 }, statMinimums: { steals: .1 } });
  assert.equal(gap.ok, false);
  assert.ok(gap.diagnostics.dataEligibility.excludedPlayers[0].reasons.some(reason => reason.includes('verified Scout steals evidence')));
  const wrongYear = optimizeLineups([player('supported', 20, 1)],
    { size: 1, weights: { points: 1 }, sourceScope: { seasonEndYear: 2025 } });
  assert.equal(wrongYear.ok, false);
});

test('fixed 240-minute rotations use the same Scout rates for scoring, floors, and reported production', () => {
  const players = Array.from({ length: 8 }, (_, i) => {
    const id = `p${i}`, row = { ...game(`g${i}`, 'T', 24), playerId: id };
    return { id, name: id, team: 'TST', positions: ['G', 'F', 'C'], games: 1, starts: 1, minutes: 24,
      points: 1000, rebounds: 100, assists: 100, steals: 100, blocks: 100, turnovers: 0,
      fgPct: .4, efgPct: .5, threePct: .5, ftPct: .8,
      analytics: { scoutPlayerGameEvidence: compileScoutPlayerGameEvidence([row], { ...scope, playerId: id }) } };
  });
  const config = { mode: 'rotation', size: 8, alternatives: 1, weights: { points: 1 },
    roleBalance: 'off', rotationRateStability: 'raw', rotationMinutePlan: 'openWhatIf',
    rotationOptions: { minMinutes: 30, maxMinutes: 30 } };
  const feasible = optimizeLineups(players, { ...config, statMinimums: { points: 99 }, maxTurnovers: 21 });
  assert.equal(feasible.ok, true, JSON.stringify(feasible.reasons));
  assert.equal(feasible.best.totals.points, 100);
  assert.equal(feasible.best.totals.turnovers, 20);
  assert.equal(optimizeLineups(players, { ...config, statMinimums: { points: 101 } }).ok, false);
  assert.equal(optimizeLineups(players, { ...config, maxTurnovers: 19 }).ok, false);
});

test('tight lineup production boundaries use unrounded evidence in bounds, feasibility, and audit', () => {
  const rows = [0, 1, 2].map(index => game(`fraction-${index}`, 'T', 24, { points: index === 0 ? 1 : 0, turnovers: index === 0 ? 1 : 0 }));
  const player = { id: 'player', name: 'Fractional per-game evidence', positions: ['G', 'F', 'C'], games: 3, starts: 0, minutes: 24,
    points: 100, rebounds: 4, assists: 3, steals: 1, blocks: 1, turnovers: 0, efgPct: .5, threePct: .5, fgPct: .4, ftPct: .8,
    analytics: { scoutPlayerGameEvidence: compileScoutPlayerGameEvidence(rows, scope) } };
  const request = { size: 1, weights: { points: 1 }, alternatives: 1, roleBalance: 'off' };
  const feasible = optimizeLineups([player], { ...request, statMinimums: { points: 1 / 3 - 1e-8 }, maxTurnovers: 1 / 3 + 1e-8 });
  assert.equal(feasible.ok, true, JSON.stringify(feasible.reasons));
  assert.equal(feasible.best.totals.points, 1 / 3);
  assert.equal(feasible.best.totals.turnovers, 1 / 3);
  assert.equal(feasible.best.constraintAudit.statMinimums.passed, true);
  assert.equal(feasible.best.constraintAudit.maxTurnovers.passed, true);
  assert.equal(optimizeLineups([player], { ...request, statMinimums: { points: 1 / 3 + 1e-8 } }).ok, false);
  assert.equal(optimizeLineups([player], { ...request, maxTurnovers: 1 / 3 - 1e-8 }).ok, false);
});

test('a missing turnover count cannot pass a ceiling or be reported as known zero', () => {
  const row = game('turnover-gap', 'T', 24);
  row.officialTotals.turnovers = null;
  row.fieldReconciliation.turnovers = 'unavailable';
  const player = { id: 'player', name: 'Incomplete turnover evidence', positions: ['G', 'F', 'C'], games: 1, starts: 0, minutes: 24,
    points: 10, rebounds: 4, assists: 3, steals: 1, blocks: 1, turnovers: 0, efgPct: .5, threePct: .5, fgPct: .4, ftPct: .8,
    analytics: { scoutPlayerGameEvidence: compileScoutPlayerGameEvidence([row], scope) } };
  const request = { size: 1, weights: { points: 1 }, alternatives: 1, roleBalance: 'off' };
  const unconstrained = optimizeLineups([player], request);
  assert.equal(unconstrained.ok, true);
  assert.equal(unconstrained.best.totals.turnovers, null);
  assert.equal(optimizeLineups([player], { ...request, maxTurnovers: 1 }).ok, false);
});

test('workload exposure and metric-specific reference minutes come from the same Scout revision', () => {
  const rows = [game('a', 'OLD', 6), game('b', 'NEW', 36), game('c', 'NEW', 48)];
  rows[1].officialTotals.steals = null;
  rows[2].minutesReconciled = false;
  const evidence = compileScoutPlayerGameEvidence(rows, scope);
  const player = { id: 'player', minutes: 48, games: 82,
    analytics: { scoutPlayerGameEvidence: evidence, seasonTotals: { games: 82, minutes: 3600 },
      seasonAdvanced: { usage_percentage: .4 }, advanced: { usage_percentage: .05 } } };
  assert.equal(evidence.workload.minutes, 42);
  assert.equal(evidence.workload.verifiedGames, 2);
  assert.deepEqual(evidence.workload.omittedGameIds, ['c']);
  assert.equal(readSeasonRoleMinutes(player), 21);
  assert.equal(readSeasonRoleMinutes(player, 'steals'), 6);
  assert.equal(readSeasonRoleMinutes(player, 'points'), 21);
  assert.equal(readPlayerUsage(player), null, 'Old box-score usage is not new Scout evidence.');
  const scenario = projectPlayerResponsibility(player, 'points', 36,
    { offensiveResponsibilities: { player: .3 }, expansionStrengthByMetric: { points: 0 } });
  assert.equal(scenario.sourceMinutes, 21);
  assert.equal(scenario.sourceUsage, null);
  assert.equal(scenario.targetUsage, .3, 'Explicit usage remains a scenario, not a measured rate.');
  assert.equal(scenario.usageRatio, null);
  const unavailable = { ...player, analytics: { ...player.analytics, scoutPlayerGameEvidence: { ...evidence, scope: { ...evidence.scope, playerId: 'other' } } } };
  assert.equal(readSeasonRoleMinutes(unavailable), null);
});

test('new Scout rotation predictions are invariant to contradictory old team/season workload and usage', () => {
  const pool = Array.from({ length: 8 }, (_, i) => {
    const id = `p${i}`, row = { ...game(`g${i}`, 'T', 12 + i), playerId: id };
    return { id, name: id, team: 'TST', positions: ['G', 'F', 'C'], games: 60, starts: 20, minutes: 24,
      points: 14, rebounds: 5, assists: 3, steals: 1, blocks: 1, turnovers: 2, fgPct: .4, efgPct: .5, threePct: .5, ftPct: .8,
      analytics: { scoutPlayerGameEvidence: compileScoutPlayerGameEvidence([row], { ...scope, playerId: id }),
        leaguePer36: { points: 18, rebounds: 8, assists: 5, steals: 1.5, blocks: 1, turnovers: 2.5, efgPct: .53, threePct: .36 } } };
  });
  const input = { mode: 'rotation', size: 8, alternatives: 1, weights: { points: 1, efgPct: 1, threePct: 1 },
    offensiveResponsibilities: { p0: .4 }, sourceScope: { seasonEndYear: 2026, seasonPhase: 'regular' },
    rotationOptions: { minMinutes: 30, maxMinutes: 30, minutePlan: 'openWhatIf', scoringBasis: 'per36', rateStability: 'sampleAdjusted' } };
  const initial = optimizeLineups(pool, input);
  const poisoned = pool.map((p, i) => ({ ...p, games: 1, minutes: i % 2 ? 2 : 48,
    analytics: { ...p.analytics, seasonTotals: { minutes: 10000, games: 1000 },
      seasonAdvanced: { usage_percentage: .05 }, advanced: { usage_percentage: .9 } } }));
  const changed = optimizeLineups(poisoned, input);
  assert.equal(initial.ok, true, JSON.stringify(initial.reasons));
  assert.equal(changed.ok, true, JSON.stringify(changed.reasons));
  assert.equal(changed.best.score, initial.best.score);
  assert.deepEqual(changed.best.totals, initial.best.totals);
  assert.deepEqual(changed.best.rotation.byId, initial.best.rotation.byId);
  const wrongPhase = optimizeLineups(pool, { ...input, sourceScope: { seasonEndYear: 2026, seasonPhase: 'playoffs' } });
  assert.equal(wrongPhase.ok, false);
  assert.equal(wrongPhase.diagnostics.dataEligibility.excludedPlayers.length, 8);
});
