import test from 'node:test';
import assert from 'node:assert/strict';
import { loadOptimizerCore } from './load-optimizer-core.mjs';
import { buildScoutImpactModel, buildScoutMinuteObjective } from '../scout-impact.js';
import { workloadRate, workloadUtilityCurve } from '../workload-model.js';
import { projectionParametersFor } from '../projection-parameters.js';
import { encodeScenarioQuery, decodeScenarioQuery } from '../scenario-url.js';

const { optimizeLineups } = await loadOptimizerCore();
const players = Array.from({ length: 9 }, (_, i) => ({
  id: `p${i}`, name: `Test ${i}`, team: 'TST', age: 25, positions: ['G', 'F', 'C'],
  games: 60, starts: 30, minutes: 25, points: 14, rebounds: 5, assists: 3, steals: 1, blocks: .5,
  turnovers: 2, fgPct: .5, threePct: .35, efgPct: .55, ftPct: .8,
}));
const offense = [5, 2.1, 2, 1, 0, -1, -2, -3, -4], defense = [-3, 0, 1, 2, 3, 4, 6, 7, 8];
const evidence = {
  model: { calibration: { status: 'validated', allComponentsImproved: true } },
  players: Object.fromEntries(players.map((p, i) => [p.id, { offensiveRapmPer100: offense[i], defensiveRapmPer100: defense[i], reliability: .2, alreadyRegularized: true, displayEligible: true }])),
};
const config = { mode: 'rotation', size: 8, alternatives: 1, minGames: 0, minMinutes: 0, modelMode: 'scout', scoutEvidence: evidence,
  rotationOptions: { minMinutes: 29, maxMinutes: 31, scoringBasis: 'per36', minutePlan: 'openWhatIf', positionMinuteRequirements: { G: 96, F: 96, C: 48 } } };

function bruteForce(side) {
  const values = players.map((_, i) => side === 'offense' ? offense[i] : side === 'defense' ? defense[i] : offense[i] + defense[i]);
  let best = -Infinity;
  // Nine ways to leave one player out; enumerate ALL feasible integer minute
  // plans independently of the production solver, bounds, and pruning code.
  for (let omit = 0; omit < 9; omit++) {
    const ids = players.map((_, i) => i).filter(i => i !== omit);
    function visit(k, minutes, value) {
      if (k === ids.length) { if (minutes === 240) best = Math.max(best, value); return; }
      for (let m = 29; m <= 31; m++) visit(k + 1, minutes + m, value + m * values[ids[k]] / 48);
    }
    visit(0, 0, 0);
  }
  return best;
}

for (const side of ['offense', 'defense', 'balanced']) test(`Scout ${side}: exact roster AND minute optimum equals exhaustive enumeration`, () => {
  const result = optimizeLineups(players, { ...config, scoutObjective: side });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  const impact = result.best.modelAdjustments.scoutImpact.additiveImpactPer100;
  const achieved = side === 'balanced' ? impact.net : impact[side];
  assert.ok(Math.abs(achieved - bruteForce(side)) < 1e-8);
  assert.equal(result.best.rotation.totalMinutes, 240);
  assert.equal(impact.validatedLineupForecast, false);
  assert.equal(result.best.modelAdjustments.roleFit.adjustmentPoints, 0);
});

test('Scout preserves effect gaps and does not shrink ridge twice', () => {
  const model = buildScoutImpactModel(players, evidence, { mode: 'scout' });
  assert.equal(model.impactsById.get('p0').offense, 5);
  const scores = buildScoutMinuteObjective(players, model, new Map(players.map(p => [p.id, .5])), { offenseWeight: 1, defenseWeight: 0 }).scoresById;
  assert.ok((scores.get('p0') - scores.get('p1')) / (scores.get('p1') - scores.get('p2')) > 28);
});

test('missing historical priority metrics do not block complete primary Scout evidence', () => {
  const result = optimizeLineups(players, { ...config, scoutObjective: 'offense', weights: { offensiveImpact: 1 } });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.ok(Math.abs(result.best.modelAdjustments.scoutImpact.additiveImpactPer100.offense - bruteForce('offense')) < 1e-8);
});

test('missing model, unknown player, or stale scope cannot qualify as Scout', () => {
  assert.equal(buildScoutImpactModel(players, { players: evidence.players }, { mode: 'scout' }).available, false);
  const missing = structuredClone(evidence); delete missing.players.p0;
  assert.equal(buildScoutImpactModel(players, missing, { mode: 'scout' }).available, false);
  assert.equal(buildScoutImpactModel(players, evidence, { mode: 'scout', expectedScope: { seasonEndYear: 2026, team: 'TST' } }).available, false);
});

test('locks, exclusions, and infeasible minute bounds remain hard requirements', () => {
  const result = optimizeLineups(players, { ...config, lockedIds: ['p6'], excludedIds: ['p0'], scoutObjective: 'offense' });
  assert.equal(result.ok, true);
  assert.ok(result.best.playerIds.includes('p6'));
  assert.ok(!result.best.playerIds.includes('p0'));
  assert.equal(optimizeLineups(players, { ...config, rotationOptions: { ...config.rotationOptions, maxMinutes: 29 } }).ok, false);
});

test('a flex forward can fill center; removing that ability can make a request impossible', () => {
  const pool = players.slice(0, 8).map((p, i) => ({ ...p, positions: i < 2 ? ['G'] : i < 4 ? ['F'] : ['F', 'C'] }));
  // Two guards cannot cover 96 when each is capped at 42: a genuine hard
  // infeasibility, even though aggregate minutes alone would look possible.
  assert.equal(optimizeLineups(pool, config).ok, false);
  const feasible = { ...config, rotationOptions: { ...config.rotationOptions, minMinutes: 0, maxMinutes: 48 } };
  assert.equal(optimizeLineups(pool, feasible).ok, true);
  assert.equal(optimizeLineups(pool.map(p => ({ ...p, positions: p.positions.filter(x => x !== 'C') })), feasible).ok, false);
});

test('calibration is season/phase gated and does not impose a target minute range', () => {
  const p = projectionParametersFor('balanced', { seasonEndYear: 2026, seasonPhase: 'regular' });
  assert.equal(p.expansionStrengthByMetric.points, 0);
  assert.equal(projectionParametersFor('balanced', { seasonEndYear: 1986, seasonPhase: 'regular' }).calibration, null);
  assert.equal(projectionParametersFor('balanced', { seasonEndYear: 2026, seasonPhase: 'playoffs' }).calibration, null);
  const common = { value: .7, baseline: .5, sample: 10, prior: 180, sourceMinutes: 8, strength: 0 };
  assert.ok(workloadRate({ ...common, targetMinutes: 36 }) < .52);
  assert.equal(workloadRate({ ...common, targetMinutes: 18 }), workloadRate({ ...common, targetMinutes: 40 }));
});

test('workload utility is concave and independent of roster size and team-stint length', () => {
  for (const sourceMinutes of [4, 8, 20, 34]) {
    const curve = workloadUtilityCurve(.8, .4, sourceMinutes, .25);
    for (let m = 2; m <= 48; m++) assert.ok(curve.totals[m] - curve.totals[m - 1] <= curve.totals[m - 1] - curve.totals[m - 2] + 1e-10);
  }
  const short = optimizeLineups(players.map(p => ({ ...p, games: 3 })), config);
  const long = optimizeLineups(players.map(p => ({ ...p, games: 80 })), config);
  assert.deepEqual(short.best.rotation.byId, long.best.rotation.byId);
});

test('shared links preserve model choice, never private evidence', () => {
  const query = encodeScenarioQuery({ modelMode: 'scout', scoutObjective: 'defense', scoutEvidence: evidence });
  assert.equal(decodeScenarioQuery(query).scenario.scoutObjective, 'defense');
  assert.equal(decodeScenarioQuery(query).scenario.modelMode, 'scout');
  assert.ok(!query.includes('reliability') && !query.includes('Rapm'));
});

test('extreme extrapolation stays nonnegative, concave, and below conditional utility', () => {
  for (const sourceMinutes of [1, 2, 4, 20]) {
    const curve = workloadUtilityCurve(1, 0, sourceMinutes, .25);
    for (let m = 1; m <= 48; m++) {
      const prediction = m * workloadRate({ value: 1, baseline: 0, sample: 1, sourceMinutes, targetMinutes: m, strength: .25 });
      assert.ok(curve.totals[m] >= -1e-12);
      assert.ok(curve.totals[m] <= prediction + 1e-10);
      assert.ok(curve.totals[m] >= curve.totals[m - 1] - 1e-12);
      if (m > 1) assert.ok(curve.totals[m] - curve.totals[m - 1] <= curve.totals[m - 1] - curve.totals[m - 2] + 1e-10);
    }
  }
});

test('hard production floors cannot pass using optimistic observed-workload rates', () => {
  const pool = players.slice(0, 8).map(p => ({ ...p, minutes: 24, rebounds: 12,
    analytics: { totals: { minutes: 1440 }, leaguePer36: { rebounds: 8 } },
  }));
  const request = { mode: 'rotation', size: 8, alternatives: 1, minGames: 0, minMinutes: 0,
    weights: { rebounds: 1 }, sourceScope: { seasonEndYear: 2026, seasonPhase: 'regular', team: 'TST' },
    rotationOptions: { minMinutes: 30, maxMinutes: 30, minutePlan: 'openWhatIf', scoringBasis: 'per36', rateStability: 'sampleAdjusted',
      positionMinuteRequirements: { G: 96, F: 96, C: 48 } },
  };
  const mean = optimizeLineups(pool, request);
  assert.equal(mean.ok, true);
  assert.ok(mean.best.totals.rebounds < 118, 'workload-conditioned mean is below the raw 120 rebounds');
  assert.equal(optimizeLineups(pool, { ...request, statMinimums: { rebounds: 118 } }).ok, false);
  const bounded = optimizeLineups(pool, { ...request, statMinimums: { rebounds: 100 } });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.diagnostics.productionConstraintProjection.expectedProduction, false);
  assert.ok(bounded.best.totals.rebounds <= mean.best.totals.rebounds);
  assert.equal(bounded.best.score, mean.best.score, 'adding a satisfied floor must not alter the objective');
});
