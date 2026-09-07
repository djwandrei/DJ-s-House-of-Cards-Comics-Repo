import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptimizerCore } from './load-optimizer-core.mjs';

const { optimizeLineups } = await loadOptimizerCore();
const makePool = (size = 8) => Array.from({ length: size }, (_, i) => ({
  id: `p${i}`, name: `Evidence ${i}`, team: 'TST', age: 25, positions: ['G', 'F', 'C'],
  games: 4, starts: 0, minutes: 24, points: 20, rebounds: 12, assists: 4,
  steals: 1, blocks: 1, turnovers: 1, fgPct: .5, efgPct: .6, threePct: .4, ftPct: .8,
  analytics: {
    totals: { minutes: 96, points: 80, totalRebounds: 48, fieldGoalsMade: 20, fieldGoalsAttempted: 40, threePointFieldGoalsMade: 8, threePointFieldGoalsAttempted: 20 },
    leaguePer36: { points: 20, rebounds: 8, efgPct: .5, threePct: .35 },
  },
}));
const config = {
  mode: 'rotation', size: 8, alternatives: 1, minGames: 0, minMinutes: 0,
  weights: { rebounds: 1 }, sourceScope: { seasonEndYear: 2026, seasonPhase: 'regular', team: 'TST' },
  rotationOptions: { minMinutes: 30, maxMinutes: 30, minutePlan: 'openWhatIf',
    scoringBasis: 'per36', rateStability: 'sampleAdjusted',
    positionMinuteRequirements: { G: 96, F: 96, C: 48 } },
};

test('per-player minute aliases and Map defaults use the same production envelope as the allocator', () => {
  const pool = makePool();
  const mins = new Map(pool.map(p => [p.id, 29]));
  const maxs = new Map(pool.map(p => [p.id, 31]));
  const request = { ...config, statMinimums: { rebounds: 100 }, rotationOptions: {
    ...config.rotationOptions, minMinutes: mins, maxMinutes: maxs,
    playerBounds: { p0: { minimum: 28, maximum: 28 }, p1: { min: 32, max: 32 } },
  } };
  const result = optimizeLineups(pool, request);
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  const envelope = result.diagnostics.productionConstraintProjection;
  assert.equal(envelope.boundScope, 'per-player-user-allowed-minutes');
  assert.deepEqual(envelope.minuteBoundsById.p0, { min: 28, max: 28 });
  assert.deepEqual(envelope.minuteBoundsById.p1, { min: 32, max: 32 });
  assert.deepEqual(envelope.minuteBoundsById.p2, { min: 29, max: 31 });
  for (const [id, minutes] of Object.entries(result.best.rotation.byId)) {
    const bounds = envelope.minuteBoundsById[id];
    assert.ok(minutes >= bounds.min && minutes <= bounds.max);
  }
});

test('zero-minute selected players contribute zero without NaN or an invented minimum', () => {
  const result = optimizeLineups(makePool(9), { ...config, size: 9,
    statMinimums: { rebounds: 100 }, maxTurnovers: 20,
    rotationOptions: { ...config.rotationOptions, playerBounds: { p0: { min: 0, max: 0 } } },
  });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(result.best.rotation.byId.p0, 0);
  assert.equal(result.best.rotation.totalMinutes, 240);
  assert.ok(Number.isFinite(result.best.totals.rebounds));
  assert.ok(Number.isFinite(result.best.totals.turnovers));
  assert.deepEqual(result.diagnostics.productionConstraintProjection.minuteBoundsById.p0, { min: 0, max: 0 });
});

test('invalid individual bounds fail validation before constructing an unsafe envelope', () => {
  for (const overrides of [{ min: 32, max: 31 }, { max: 49 }, { min: -1 }, { min: 2.5 }]) {
    const result = optimizeLineups(makePool(), { ...config, statMinimums: { rebounds: 10 },
      rotationOptions: { ...config.rotationOptions, playerBounds: { p0: overrides } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.category, 'validation');
    assert.equal(result.diagnostics.subcategory, 'minute-bounds');
  }
});

for (const metric of ['points', 'efgPct', 'threePct']) {
  test(`${metric}: a season denominator without the matching numerator cannot inflate sample confidence`, () => {
    const pool = makePool();
    const partial = pool.map(p => ({ ...p, analytics: { ...p.analytics,
      // The season contains plenty of exposure but no numerator for the
      // selected metric. Matching MPG isolates sample scope from role size.
      seasonTotals: { games: 82, minutes: 1968, fieldGoalsAttempted: 1000, threePointFieldGoalsAttempted: 500 },
    } }));
    const request = { ...config, weights: { [metric]: 1 } };
    const fallback = optimizeLineups(pool, request);
    const result = optimizeLineups(partial, request);
    assert.equal(result.ok, true, JSON.stringify(result.reasons));
    assert.equal(result.diagnostics.rotationRateStabilityEvidence.seasonWideEvidencePlayers, 0);
    assert.deepEqual(result.diagnostics.rotationRateStabilityEvidence.evidenceByMetric[metric], {
      eligiblePlayers: 8,
      evidenceBackedPlayers: 8,
      evidenceComplete: true,
      baselineOnlyRowsUsed: 0,
      matchingSeasonSamples: 0,
      observedTeamSamples: 8,
      verifiedScoutSamples: 0,
      approximateSamples: 0,
      missingSamples: 0,
      metricAvailable: true,
    });
    assert.equal(result.best.score, fallback.best.score);
    assert.deepEqual(result.best.rotation.byId, fallback.best.rotation.byId);
  });
}

test('complete real season counts retain their actual exposure and do not inherit team-stint length', () => {
  const pool = makePool().map(p => ({ ...p, analytics: { ...p.analytics,
    seasonTotals: { games: 82, minutes: 1968, points: 1000 },
  } }));
  const request = { ...config, weights: { points: 1 } };
  const result = optimizeLineups(pool, request);
  const changedStint = optimizeLineups(pool.map(p => ({ ...p, games: 1 })), request);
  assert.equal(result.ok, true);
  assert.equal(result.diagnostics.rotationRateStabilityEvidence.seasonWideEvidencePlayers, 8);
  assert.equal(result.diagnostics.rotationRateStabilityEvidence.evidenceByMetric.points.matchingSeasonSamples, 8);
  assert.equal(result.diagnostics.rotationRateStabilityEvidence.uncertainty.calibratedPlayerIntervalsAvailable, false);
  assert.deepEqual(result.best.rotation.byId, changedStint.best.rotation.byId);
  assert.equal(result.best.score, changedStint.best.score);
});

test('actual season exposure changes rate confidence without imposing observed MPG as a limit', () => {
  const withExposure = games => makePool().map(p => ({ ...p, analytics: { ...p.analytics,
    seasonTotals: { games, minutes: games * 24, points: games * 20 },
  } }));
  const request = { ...config, weights: { points: 1 } };
  const limited = optimizeLineups(withExposure(1), request);
  const established = optimizeLineups(withExposure(82), request);
  assert.equal(limited.ok, true);
  assert.equal(established.ok, true);
  assert.ok(limited.best.totals.points < established.best.totals.points,
    'identical rates backed by fewer true observations should shrink more');
  // Both plans obey the same 30-minute user requirement, above the observed
  // 24 MPG. Sample size changes estimated production, never that hard limit.
  assert.deepEqual(limited.best.rotation.byId, established.best.rotation.byId);
  assert.ok(Object.values(limited.best.rotation.byId).every(minutes => minutes === 30));
});

for (const missing of [null, '', false, true]) {
  test(`missing impact value ${JSON.stringify(missing)} cannot masquerade as measured zero`, () => {
    const pool = makePool().map(p => ({ ...p, analytics: { ...p.analytics,
      advanced: { offensive_box_plus_minus: missing },
    } }));
    const result = optimizeLineups(pool, { ...config, weights: { offensiveImpact: 1 } });
    assert.equal(result.ok, false);
    const measuredZero = optimizeLineups(pool.map(p => ({ ...p, analytics: { ...p.analytics,
      advanced: { offensive_box_plus_minus: 0 },
    } })), { ...config, weights: { offensiveImpact: 1 } });
    assert.equal(measuredZero.ok, true, JSON.stringify(measuredZero.reasons));
  });
}
