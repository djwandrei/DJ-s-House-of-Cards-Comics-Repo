import test from 'node:test';
import assert from 'node:assert/strict';
import { pairedMetricEvidence, posteriorRate, cardinalMetricScore, demonstratedShootingValue,
  decisionRateAtWorkload, concaveDecisionCurve } from '../projection-evidence.js';
import { loadOptimizerCore } from './load-optimizer-core.mjs';
const { optimizeLineups, allocateRotationMinutes } = await loadOptimizerCore();

test('a season gap falls back only to a complete team pair, never a mixed denominator', () => {
  const player = { minutes: 24, games: 80, analytics: {
    seasonTotals: { minutes: 2400, points: null }, totals: { minutes: 120, points: 50 },
  } };
  assert.deepEqual(pairedMetricEvidence(player, 'points'), {
    minutes: 120, numerator: 50, sample: 120, sampleScope: 'selected-team-observed', value: 15,
  });
  for (const missing of [null, undefined, '', false, true, -1]) {
    player.analytics.totals.points = missing;
    assert.equal(pairedMetricEvidence(player, 'points'), null);
  }
});

test('zero attempts and missing shooting evidence never earn demonstrated spacing', () => {
  const player = { analytics: { seasonTotals: { minutes: 300,
    threePointFieldGoalsAttempted: 0, threePointFieldGoalsMade: 0 } } };
  const evidence = pairedMetricEvidence(player, 'threePct');
  assert.equal(evidence.sample, 0);
  const posterior = posteriorRate(0, { ...evidence, prior: 180, baseline: .36, metric: 'threePct' });
  assert.equal(posterior.mean, .36, 'accuracy prior is not a measured shooting skill');
  assert.equal(demonstratedShootingValue(posterior.mean, evidence.participationPer36, 'threePct'), 0);
  assert.equal(demonstratedShootingValue(.36, null, 'threePct'), 0);
  const one = demonstratedShootingValue(.36, .01, 'threePct');
  const regular = demonstratedShootingValue(.36, 6, 'threePct');
  assert.ok(one > 0 && one < regular / 100, 'no jump from zero to an average shooter at one attempt');
});

test('eFG variance uses weighted makes; invalid make totals cannot masquerade as evidence', () => {
  const player = { analytics: { totals: { minutes: 100, fieldGoalsAttempted: 30, fieldGoalsMade: 20, threePointFieldGoalsMade: 10 } } };
  const evidence = pairedMetricEvidence(player, 'efgPct');
  assert.equal(evidence.numerator, 25);
  assert.equal(evidence.secondMomentTotal, 32.5);
  assert.ok(posteriorRate(evidence.value, { ...evidence, prior: 20, baseline: .55, metric: 'efgPct' }).standardError > 0);
  player.analytics.totals.threePointFieldGoalsMade = 21;
  assert.equal(pairedMetricEvidence(player, 'efgPct'), null);
});

test('cardinal differences remain small, preserve negative impact and reverse turnover direction', () => {
  const gap = cardinalMetricScore(.2, 0, 'offensiveImpact') - cardinalMetricScore(0, 0, 'offensiveImpact');
  assert.ok(gap > 0 && gap < .02, 'a .2 BPM gap cannot manufacture a huge rank gap');
  assert.ok(cardinalMetricScore(-4, 0, 'offensiveImpact') < cardinalMetricScore(-1, 0, 'offensiveImpact'));
  assert.ok(cardinalMetricScore(1, 2, 'ballSecurity') > cardinalMetricScore(3, 2, 'ballSecurity'));
});

test('uncertainty widens independently with minutes or requested usage, never changes the mean', () => {
  const input = { mean: 20, standardError: 2, sourceMinutes: 10, targetMinutes: 10, sourceUsage: .12, targetUsage: .12, risk: .5 };
  const observed = decisionRateAtWorkload(input);
  const minutes = decisionRateAtWorkload({ ...input, targetMinutes: 30 });
  const responsibility = decisionRateAtWorkload({ ...input, targetUsage: .36 });
  assert.equal(minutes.reserve, 3 * observed.reserve);
  assert.equal(responsibility.reserve, 3 * observed.reserve);
  assert.equal(minutes.mean, observed.mean);
  assert.equal(responsibility.mean, observed.mean);
  assert.equal(decisionRateAtWorkload({ ...input, risk: 0 }).decision, input.mean);
  assert.ok(decisionRateAtWorkload({ ...input, lowerIsBetter: true }).decision > input.mean);
});

test('every concave objective curve stays below its conditional utility and nonnegative', () => {
  for (const sourceMinutes of [1, 8, 24, 40]) for (const risk of [0, .5, 1]) {
    const predictions = Array.from({ length: 49 }, (_, minute) => minute * cardinalMetricScore(
      decisionRateAtWorkload({ mean: 22, standardError: 3, sourceMinutes, targetMinutes: minute, risk }).decision, 20, 'points'));
    const { totals } = concaveDecisionCurve(predictions);
    let last = Infinity;
    for (let minute = 1; minute <= 48; minute++) {
      assert.ok(totals[minute] >= 0 && totals[minute] <= predictions[minute] + 1e-9);
      const marginal = totals[minute] - totals[minute - 1];
      assert.ok(marginal <= last + 1e-9);
      last = marginal;
    }
  }
});

function roster() {
  return Array.from({ length: 8 }, (_, index) => ({ id: `p${index}`, name: `Case ${index}`, team: 'TST',
    positions: ['G', 'F', 'C'], games: 60, starts: 30, minutes: 30, points: 15, rebounds: 5, assists: 4,
    steals: 1, blocks: 1, turnovers: 2, fgPct: .5, efgPct: .55, threePct: .36, ftPct: .8,
    analytics: { totals: { minutes: 1800, points: 900, totalRebounds: 300, turnovers: 120 },
      leaguePer36: { points: 18, rebounds: 6, turnovers: 2.4 }, advanced: { usage_percentage: .2 } },
  }));
}

test('adding an irrelevant candidate cannot move a locked evidence-adjusted objective', () => {
  const players = roster();
  const config = { mode: 'rotation', size: 8, alternatives: 1, lockedIds: players.map(p => p.id),
    minGames: 0, minMinutes: 0, weights: { points: 1 }, rotationOptions: {
      minMinutes: 30, maxMinutes: 30, rateStability: 'sampleAdjusted', roleBalance: 'off',
      positionMinuteRequirements: { G: 96, F: 96, C: 48 } } };
  const base = optimizeLineups(players, config);
  const expanded = optimizeLineups([...players, { ...players[0], id: 'other', points: 40 }], config);
  assert.equal(base.ok, true, JSON.stringify(base.reasons)); assert.equal(expanded.ok, true, JSON.stringify(expanded.reasons));
  assert.equal(base.best.score, expanded.best.score);
  assert.equal(base.best.planFitIndex, expanded.best.planFitIndex);
});

for (const fixedRoles of [false, true]) for (const rule of ['rebounds', 'turnovers', 'both']) {
  test(`nonlinear ${rule} constraint equals an exhaustive minute oracle (${fixedRoles ? 'fixed roles' : 'flex'})`, () => {
    const players = roster().map((p, index) => ({ ...p,
      positions: fixedRoles ? [index < 2 ? 'G' : index < 6 ? 'F' : 'C'] : p.positions }));
    // Only the first two players can exchange time: 96 guard minutes in the
    // fixed-role case and 240 total minutes in the flexible case.
    const playerBounds = Object.fromEntries(players.map((p, index) => [p.id,
      index < 2 ? { min: 46, max: 48 } : { min: 24, max: 24 }]));
    playerBounds.p0.min = 44; playerBounds.p1.min = 44;
    // Leave two flexible guard minutes by changing two fixed players to 25.
    playerBounds.p2 = { min: 25, max: 25 }; playerBounds.p3 = { min: 25, max: 25 };
    const requirements = { G: 94, F: 98, C: 48 };
    const curves = Object.fromEntries(players.map((p, index) => [p.id, {
      rebounds: Array.from({ length: 49 }, (_, m) => index === 1 ? m * Math.exp(-m / 70) : 0),
      turnovers: Array.from({ length: 49 }, (_, m) => index === 0 ? m * m / 100 : 0),
    }]));
    const scores = Object.fromEntries(players.map((p, i) => [p.id, i === 0 ? 2 : 1]));
    const options = { minMinutes: 0, maxMinutes: 48, playerBounds, scores, strategy: 'objective',
      positionMinuteRequirements: requirements, projectedProductionCurves: curves,
      ...(rule !== 'turnovers' ? { projectedStatMinimums: { rebounds: curves.p1.rebounds[47] } } : {}),
      ...(rule !== 'rebounds' ? { projectedMaxTurnovers: curves.p0.turnovers[47] } : {}) };
    let best = -Infinity;
    for (let m = 44; m <= 48; m++) {
      const n = 94 - m;
      if (n < 44 || n > 48) continue;
      if (rule !== 'turnovers' && curves.p1.rebounds[n] + 1e-9 < options.projectedStatMinimums.rebounds) continue;
      if (rule !== 'rebounds' && curves.p0.turnovers[m] - 1e-9 > options.projectedMaxTurnovers) continue;
      best = Math.max(best, 2 * m + n + 146);
    }
    const result = allocateRotationMinutes(players, options);
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.equal(2 * result.byId.p0 + result.byId.p1 + 146, best);
    assert.equal(result.totalMinutes, 240);
  });
}

test('nonlinear curve input rejects missing, negative and coerced values before solving', () => {
  for (const invalid of [null, false, -1, NaN]) {
    const curves = { p0: { rebounds: Array(49).fill(0) } }; curves.p0.rebounds[12] = invalid;
    const result = allocateRotationMinutes(roster(), { projectedProductionCurves: curves });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /49 nonnegative totals/);
  }
});
