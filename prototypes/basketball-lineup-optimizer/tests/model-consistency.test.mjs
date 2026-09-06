import test from 'node:test';
import assert from 'node:assert/strict';
import { projectionParametersFor } from '../projection-parameters.js';
import { pairedMetricEvidence } from '../projection-evidence.js';
import { buildLineupRoleModel, scoreLineupRoleFit } from '../lineup-role-model.js';
import { OBJECTIVE_FAMILY_DEFINITIONS } from '../optimizer-config.js';
import { explainOptimizationSelection } from '../fan-analytics.js';
import { loadOptimizerCore } from './load-optimizer-core.mjs';
const { optimizeLineups } = await loadOptimizerCore();

// Coherent synthetic observations, not invented evidence in a production
// adapter. Change minutes and counts together to distinguish exposure from MPG.
function player(id, { games = 60, mpg = 24, attempts = 240, makes = 90 } = {}) {
  const minutes = games * mpg;
  return { id, name: id, team: 'TST', positions: ['G', 'F', 'C'], games, starts: 0,
    minutes: mpg, points: 12, rebounds: 5, assists: 4, steals: 1, blocks: 1,
    turnovers: 2, fgPct: .5, efgPct: .55, threePct: attempts ? makes / attempts : 0, ftPct: .8,
    analytics: { totals: { minutes, points: 12 * games, totalRebounds: 5 * games,
      assists: 4 * games, steals: games, blocks: games, turnovers: 2 * games,
      threePointFieldGoalsAttempted: attempts, threePointFieldGoalsMade: makes },
      leaguePer36: { points: 18, rebounds: 7, assists: 5, steals: 1.3, blocks: 1,
        turnovers: 2.4, threePct: .36, efgPct: .54 } } };
}

function run(players, config = {}) {
  const result = optimizeLineups(players, { size: 5, alternatives: 1,
    minMinutes: 0, minGames: 0, weights: { threePct: 1 }, ...config });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  return result;
}

test('starting five applies the same shooting evidence safeguards as rotation', () => {
  const steady = player('steady', { attempts: 360, makes: 144 });
  const tiny = player('tiny', { games: 1, mpg: 6, attempts: 1, makes: 1 });
  const result = run([steady, tiny, ...Array.from({ length: 4 }, (_, i) => player(`lock${i}`))], {
    lockedIds: ['lock0', 'lock1', 'lock2', 'lock3'],
  });
  assert.ok(result.best.playerIds.includes('steady'), 'one made shot must not outrank a supported shooter');
  assert.equal(result.diagnostics.objectiveRateEvidence.applied, true);
});

test('risk preference does not change the underlying prior mean parameters in any era', () => {
  for (const scope of [null, { seasonEndYear: 2026, seasonPhase: 'regular' }]) {
    const [reliable, balanced, upside] = ['reliable', 'balanced', 'upside'].map(risk => projectionParametersFor(risk, scope));
    for (const key of ['priorMinutesByMetric', 'priorFieldGoalAttempts', 'priorThreePointAttempts', 'priorImpactMinutes']) {
      assert.deepEqual(reliable[key], balanced[key], key);
      assert.deepEqual(upside[key], balanced[key], key);
    }
    assert.ok(reliable.decisionUncertaintyWeight > balanced.decisionUncertaintyWeight);
    assert.ok(balanced.decisionUncertaintyWeight > upside.decisionUncertaintyWeight);
  }
});

test('the spacing family does not pay a second time for general finishing or scoring', () => {
  assert.deepEqual(OBJECTIVE_FAMILY_DEFINITIONS.spacing.metrics, { threePct: 1 });
});

test('role scoring uses supplied adjusted contributions, not raw small-sample ranks', () => {
  const players = [player('steady'), player('tiny', { games: 1, mpg: 6, attempts: 1, makes: 1 })];
  const adjusted = new Map(players.map(p => [p.id, { points: .5, rebounds: .5, assists: .5,
    steals: .5, blocks: .5, ballSecurity: .5, efgPct: .5, threePct: p.id === 'steady' ? .7 : .1 }]));
  const roles = buildLineupRoleModel(players, { normalizedMetrics: adjusted });
  assert.ok(roles.signalsById.get('steady').floorSpacer > roles.signalsById.get('tiny').floorSpacer);
});

test('offense-only role preferences cannot secretly reward defense', () => {
  const roles = ['primaryCreator', 'floorSpacer', 'connector', 'efficientFinisher', 'pointOfAttack', 'rimProtector', 'rebounder'];
  const make = defense => new Map([['p', Object.fromEntries(roles.map((role, i) => [role, i < 4 ? .6 : defense]))]]);
  const options = { objectiveWeights: { points: 1 }, balance: 'recommended' };
  const weak = scoreLineupRoleFit([{ id: 'p' }], { signalsById: make(0) }, options);
  const strong = scoreLineupRoleFit([{ id: 'p' }], { signalsById: make(1) }, options);
  assert.equal(weak.adjustmentPoints, strong.adjustmentPoints);
});

test('a rotation does not score an unoptimized roster-only role bonus', () => {
  const players = Array.from({ length: 8 }, (_, i) => player(`p${i}`));
  const result = run(players, { mode: 'rotation', size: 8,
    rotationOptions: { minMinutes: 0, maxMinutes: 48, roleBalance: 'recommended' } });
  assert.equal(result.best.modelAdjustments.roleFit.adjustmentPoints, 0);
  assert.match(result.best.modelAdjustments.roleFit.reason, /rotation|court time/i);
});

test('impact numerator and minutes always use the same team or season scope', () => {
  const players = Array.from({ length: 5 }, (_, i) => {
    const p = player(`p${i}`);
    p.analytics.advanced = { offensive_box_plus_minus: 10 };
    p.analytics.seasonAdvanced = { offensive_box_plus_minus: -2 };
    p.analytics.seasonTotals = { games: 60, minutes: 1440 };
    return p;
  });
  const result = run(players, { weights: { offensiveImpact: 1 } });
  assert.ok(result.best.score < 50, 'a negative season BPM must not inherit a positive team numerator');
  for (const p of players) delete p.analytics.advanced;
  const seasonOnly = run(players, { weights: { offensiveImpact: 1 } });
  assert.equal(seasonOnly.best.score, result.best.score);
});

test('impossible two-point makes are not accepted as complete shooting evidence', () => {
  const p = player('invalid');
  Object.assign(p.analytics.totals, { fieldGoalsAttempted: 10, fieldGoalsMade: 9,
    threePointFieldGoalsAttempted: 8, threePointFieldGoalsMade: 2 });
  // The implied 7 two-point makes cannot fit into 2 two-point attempts.
  assert.equal(pairedMetricEvidence(p, 'efgPct'), null);
  assert.equal(pairedMetricEvidence(p, 'threePct'), null);
});

test('changing only the scale of objective weights never changes a decision', () => {
  const players = Array.from({ length: 6 }, (_, i) => player(`p${i}`, { attempts: 120 + i * 30, makes: 48 + i * 10 }));
  const reference = run(players, { weights: { points: 2, threePct: 3 } });
  for (const scale of [.001, 10, 1e100]) {
    const result = run(players, { weights: { points: 2 * scale, threePct: 3 * scale } });
    assert.deepEqual(result.best.playerIds, reference.best.playerIds);
    assert.equal(result.best.score, reference.best.score);
  }
  const overflow = optimizeLineups(players, { size: 5, weights: { points: 1e308, threePct: 1e308 } });
  assert.equal(overflow.ok, false);
  assert.match(overflow.reasons.join(' '), /weights must be finite/);
});

test('starting-five explanations label adjusted contributions and the common rate basis', () => {
  const players = Array.from({ length: 5 }, (_, i) => player(`p${i}`));
  const result = run(players);
  const explanation = explainOptimizationSelection(result, { candidatePool: players });
  assert.equal(explanation.objectiveScoringBasis, 'per36');
  assert.match(explanation.selectedPlayers[0].whySelected.join(' '), /normalized contribution, not a percentile/);
});

test('raw comparison remains an explicit compatibility choice for starting five', () => {
  const players = Array.from({ length: 5 }, (_, i) => player(`p${i}`));
  const result = run(players, { rotationOptions: { rateStability: 'raw', scoringBasis: 'perGame' } });
  assert.equal(result.diagnostics.objectiveRateEvidence.applied, false);
  assert.equal(result.diagnostics.objectiveScoringBasis, 'perGame');
});

for (const metric of ['points', 'threePct', 'efgPct']) {
  test(`exact starting-five ${metric} objective matches exhaustive locked-subset evaluation`, () => {
    const players = Array.from({ length: 7 }, (_, i) => {
      const p = player(`p${i}`, { attempts: 80 + i * 35, makes: 25 + i * 14 });
      Object.assign(p.analytics.totals, { fieldGoalsAttempted: 500 + i * 40,
        fieldGoalsMade: 220 + i * 22 });
      return p;
    });
    const config = { weights: { [metric]: 1 }, roleBalance: 'recommended' };
    const exact = run(players, config);
    let maximum = -Infinity;
    for (let excluded1 = 0; excluded1 < 7; excluded1++) for (let excluded2 = excluded1 + 1; excluded2 < 7; excluded2++) {
      const selected = players.filter((_, i) => i !== excluded1 && i !== excluded2).map(p => p.id);
      maximum = Math.max(maximum, run(players, { ...config, lockedIds: selected }).best.score);
    }
    assert.equal(exact.best.score, maximum);
  });
}
