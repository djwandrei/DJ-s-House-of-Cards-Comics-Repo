import assert from 'node:assert/strict';
import test from 'node:test';
import { fitScoringComponents, projectScoringComponents, evaluateScoringComponents, scoringObservation } from '../lib/lineup-scoring-components.mjs';

const scope = { sourceRevision: 'fixture-only-not-a-production-package', seasonStartYear: 2025, phase: 'regular', trainingBeforeUtcDay: '2026-02-01' };
function row(gameId, playerId, { minutes = 24, date = '2026-01-01T01:00:00Z', teamId = 'A', shots = [6, 3, 4, 1, 2, 2], seasonStartYear = 2025, phase = 'regular' } = {}) {
  const [twoPointAttempts, twoPointMakes, threePointAttempts, threePointersMade, freeThrowAttempts, freeThrowsMade] = shots;
  const totals = { twoPointAttempts, twoPointMakes, threePointAttempts, threePointersMade, freeThrowAttempts, freeThrowsMade,
    fieldGoalAttempts: twoPointAttempts + threePointAttempts, fieldGoalsMade: twoPointMakes + threePointersMade,
    points: 2 * twoPointMakes + 3 * threePointersMade + freeThrowsMade };
  return { gameId, playerId, teamId, scheduledAt: date, seasonStartYear, phase, minutes, officialMinutes: minutes,
    minutesReconciled: true, rateExposure: { officialPer36Minutes: minutes, pbpPer36Minutes: minutes },
    officialTotals: { ...totals }, pbpTotals: { ...totals }, fieldReconciliation: Object.fromEntries(Object.keys(totals).map(key => [key, 'matched'])),
    officialIdentityIssues: [], pbpIdentityIssues: [], sourceCorrections: [] };
}
const reference = () => [row('ref-a', 'reference', { shots: [20, 10, 20, 7, 10, 8] }), row('ref-b', 'reference', { date: '2026-01-02T01:00:00Z', shots: [20, 10, 20, 7, 10, 8] })];

test('scoring identities hold at every minute, including zero; no implicit minutes target', () => {
  const fit = fitScoringComponents([...reference(), row('p1', 'player')], scope);
  for (let minutes = 0; minutes <= 48; minutes++) {
    const result = projectScoringComponents(fit, 'player', { minutes, riskWeight: .5 });
    assert.equal(result.available, true);
    for (const totals of [result.mean, result.decision]) {
      assert.equal(totals.fieldGoalAttempts, totals.twoPointAttempts + totals.threePointAttempts);
      assert.equal(totals.fieldGoalsMade, totals.twoPointMakes + totals.threePointersMade);
      assert.equal(totals.points, 2 * totals.twoPointMakes + 3 * totals.threePointersMade + totals.freeThrowsMade);
      assert.ok(totals.fieldGoalsMade <= totals.fieldGoalAttempts);
      assert.ok(totals.freeThrowsMade <= totals.freeThrowAttempts);
    }
    assert.ok(result.decision.points <= result.mean.points);
    assert.equal(result.components.threePoint.observedAttempts, 4, 'assigned minutes never become evidence');
  }
  const short = projectScoringComponents(fit, 'player', { minutes: 12 });
  const long = projectScoringComponents(fit, 'player', { minutes: 36 });
  assert.ok(Math.abs(long.mean.points - short.mean.points * 3) < 1e-10);
  assert.equal(long.components.threePoint.accuracy.mean, short.components.threePoint.accuracy.mean);
});

test('one perfect shot does not establish certain skill; more actual shots reduce prior influence', () => {
  const sparse = row('small', 'small', { minutes: 2, shots: [0, 0, 1, 1, 0, 0] });
  const established = row('large', 'large', { minutes: 40, shots: [0, 0, 20, 20, 0, 0] });
  const smallFit = fitScoringComponents([...reference(), sparse], scope);
  const largeFit = fitScoringComponents([...reference(), established], scope);
  const small = projectScoringComponents(smallFit, 'small', { minutes: 36, riskWeight: 1 }).components.threePoint;
  const large = projectScoringComponents(largeFit, 'large', { minutes: 36, riskWeight: 1 }).components.threePoint;
  assert.ok(small.accuracy.mean < .5 && small.accuracy.mean > .35);
  assert.ok(large.accuracy.mean > small.accuracy.mean);
  assert.ok(small.decisionAttempts / small.meanAttempts < large.decisionAttempts / large.meanAttempts);
  const lone = projectScoringComponents(fitScoringComponents([sparse], scope, { accuracyPriorAttempts: { twoPoint: 0, threePoint: 0, freeThrow: 0 } }), 'small', { minutes: 36 });
  assert.ok(lone.components.threePoint.accuracy.mean < 1);
  assert.ok(lone.components.threePoint.accuracy.standardError > 0);
  assert.equal(small.accuracy.empiricalPriorAttempts, 40, 'comparison sample limits the configured 180-attempt prior');
  assert.equal(small.accuracy.requestedPriorAttempts, 180);
});

test('tiny-exposure per-36 spikes are tempered without adding imaginary attempts or choosing minutes', () => {
  const brief = row('seconds', 'player', { minutes: .1, shots: [0, 0, 1, 1, 0, 0] });
  const fit = fitScoringComponents([...reference(), brief], scope, { frequencyPriorMinutes: 60 });
  const projection = projectScoringComponents(fit, 'player', { minutes: 36 });
  const three = projection.components.threePoint;
  assert.equal(three.observedAttemptsPer36, 360);
  assert.equal(three.observedMinutes, .1);
  assert.equal(three.observedAttempts, 1);
  assert.ok(three.estimatedAttemptsPer36 < .6);
  assert.equal(projection.minutes, 36);
  const raw = projectScoringComponents(fitScoringComponents([...reference(), brief], scope, { frequencyPriorMinutes: 0 }), 'player', { minutes: 36 });
  assert.equal(raw.components.threePoint.estimatedAttemptsPer36, 360, 'unregularized ablation is explicit, not hidden');
  assert.deepEqual(raw.components.threePoint.accuracy, three.accuracy, 'frequency strength does not alter accuracy evidence');
});

test('a non-shooter does not inherit league-average shot volume or certain zero accuracy', () => {
  const fit = fitScoringComponents([...reference(), row('non-shooter', 'center', { shots: [8, 6, 0, 0, 2, 1] })], scope);
  const ordinary = projectScoringComponents(fit, 'center', { minutes: 40 });
  assert.equal(ordinary.mean.threePointAttempts, 0);
  assert.equal(ordinary.mean.threePointersMade, 0);
  assert.equal(ordinary.components.threePoint.priorOnlyAccuracy, true);
  const hypothetical = projectScoringComponents(fit, 'center', { minutes: 40, attemptsPer36: { threePoint: 6 } });
  assert.equal(hypothetical.mean.threePointAttempts, 6 * 40 / 36);
  assert.equal(hypothetical.components.threePoint.observedAttempts, 0);
  assert.ok(hypothetical.warnings.some(warning => warning.includes('prior-only')));
  assert.equal(hypothetical.causalUsageResponse, false);
  assert.equal(hypothetical.measuredUsageShare, null);
});

test('incomplete or corrected scoring never borrows partial denominators or becomes training evidence', () => {
  const mutations = [
    value => { value.officialTotals.freeThrowAttempts = null; },
    value => { value.officialTotals.points++; },
    value => { value.officialTotals.threePointersMade = value.pbpTotals.threePointersMade = 9; },
    value => { value.rateExposure.pbpPer36Minutes = null; },
    value => { value.minutes = 12; },
    value => { value.sourceCorrections = [{ field: 'freeThrowAttempts', originalValue: -1, correctedValue: 2 }]; },
  ];
  for (const mutate of mutations) {
    const broken = row('broken', 'player'); mutate(broken);
    assert.equal(scoringObservation(broken).available, false);
    const fit = fitScoringComponents([...reference(), broken], scope);
    assert.equal(fit.coverage.omittedPlayerGames, 1);
    assert.equal(projectScoringComponents(fit, 'player', { minutes: 30 }).available, false);
  }
  const unrelated = row('steal-correction', 'player');
  unrelated.sourceCorrections = [{ field: 'steals', correctedValue: 0 }];
  assert.equal(scoringObservation(unrelated).available, true, 'unrelated stat gap must not erase valid shooting');
});

test('trades preserve one all-team profile; duplicate appearances are rejected', () => {
  const before = row('trade-a', 'player', { teamId: 'OLD', minutes: 12 });
  const after = row('trade-b', 'player', { teamId: 'NEW', minutes: 36 });
  const fit = fitScoringComponents([...reference(), before, after], scope);
  const oneTeam = fitScoringComponents([...reference(), before, { ...after, teamId: 'OLD' }], scope);
  const traded = projectScoringComponents(fit, 'player', { minutes: 30 });
  const sameTeam = projectScoringComponents(oneTeam, 'player', { minutes: 30 });
  assert.deepEqual(traded.mean, sameTeam.mean);
  assert.deepEqual(traded.components, sameTeam.components);
  assert.equal(Object.keys(traded.evidence.teams).length, 2, 'membership metadata changes, not scoring or allocated minutes');
  assert.throws(() => fitScoringComponents([before, { ...before, teamId: 'NEW' }], scope), /Duplicate player-game/);
});

test('all-team totals preserve excluded appearances and identify which team has missing evidence', () => {
  const valid = row('new-team', 'player', { teamId: 'NEW' });
  const missing = row('old-team', 'player', { teamId: 'OLD' });
  missing.officialTotals.freeThrowAttempts = null;
  const afterCutoff = row('future', 'player', { teamId: 'NEW', date: '2026-02-02T01:00:00Z' });
  const fit = fitScoringComponents([...reference(), valid, missing, afterCutoff], scope);
  const projection = projectScoringComponents(fit, 'player', { minutes: 30 });
  assert.equal(projection.evidence.consideredPlayerGames, 2, 'future appearances are not holes in the past sample');
  assert.equal(projection.evidence.allSuppliedScoringLinesAccepted, false);
  assert.equal(projection.evidence.teams.OLD.omittedPlayerGames, 1);
  assert.equal(projection.evidence.teams.OLD.missingFields.freeThrowAttempts, 1);
  assert.equal(projection.evidence.teams.NEW.acceptedMinutes, 24);
  assert.ok(projection.warnings.some(warning => warning.includes('accepted subset')));
  projection.evidence.teams.OLD.missingFields.freeThrowAttempts = 100;
  assert.equal(projectScoringComponents(fit, 'player', { minutes: 30 }).evidence.teams.OLD.missingFields.freeThrowAttempts, 1);
});

test('risk changes downside only; shot-rate assumptions do not change the evidence or accuracy mean', () => {
  const fit = fitScoringComponents([...reference(), row('p', 'player')], scope);
  const mean = projectScoringComponents(fit, 'player', { minutes: 32 });
  const cautious = projectScoringComponents(fit, 'player', { minutes: 32, riskWeight: 2 });
  assert.deepEqual(cautious.mean, mean.mean);
  assert.ok(cautious.decision.points < mean.mean.points);
  const scenario = projectScoringComponents(fit, 'player', { minutes: 32, attemptsPer36: { threePoint: 10 } });
  assert.deepEqual(scenario.components.threePoint.accuracy, mean.components.threePoint.accuracy);
  assert.ok(scenario.warnings.some(warning => warning.includes('exceeds observed')));
  assert.equal(scenario.calibrated, false);
});

test('training and evaluation keep whole UTC dates, season/phase scope, and source games separate', () => {
  const p = row('p', 'player');
  const future = row('future', 'player', { date: '2026-02-01T00:00:00Z' });
  const wrongSeason = { ...p, gameId: 'older', seasonStartYear: 2024 };
  const wrongPhase = { ...p, gameId: 'playoffs', phase: 'playoffs' };
  const fit = fitScoringComponents([...reference(), p, future, wrongSeason, wrongPhase], scope);
  assert.equal(fit.coverage.atOrAfterCutoff, 1);
  assert.equal(fit.coverage.outsideScope, 2);
  assert.throws(() => evaluateScoringComponents(fit, [p]), /unseen games/);
  assert.throws(() => evaluateScoringComponents(fit, [{ ...future, gameId: 'p' }]), /unseen games/);
  assert.equal(evaluateScoringComponents(fit, [future]).accepted, 1);
  assert.equal(evaluateScoringComponents(fit, [future], { conditionOnObservedAttempts: true }).mode, 'conversion-conditional-on-realized-attempts');
  assert.throws(() => fitScoringComponents([p], { ...scope, trainingBeforeUtcDay: '2026-02-30' }), /calendar/);
});

test('overtime evidence keeps actual minutes; malformed scenario inputs do not become zero', () => {
  const fit = fitScoringComponents([...reference(), row('p', 'player')], scope);
  const overtime = row('ot', 'player', { date: '2026-02-05T00:00:00Z', minutes: 55 });
  assert.equal(evaluateScoringComponents(fit, [overtime]).accepted, 1);
  const brief = row('brief', 'player', { date: '2026-02-05T00:00:00Z', minutes: .1, shots: [0, 0, 1, 1, 0, 0] });
  assert.equal(evaluateScoringComponents(fit, [brief], { conditionOnObservedAttempts: true }).accepted, 1, 'brief appearances are not discarded by scenario-control rate limits');
  for (const minutes of [null, '30', -1, Infinity, 49]) assert.throws(() => projectScoringComponents(fit, 'player', { minutes }));
  for (const attemptsPer36 of [{ threePoint: null }, { threePoint: -1 }, { threePoint: Infinity }, { threePoint: '8' }, { usage: .2 }]) {
    assert.throws(() => projectScoringComponents(fit, 'player', { minutes: 30, attemptsPer36 }));
  }
});

test('evaluation exposes unavailable accuracy without discarding the known shot-type targets', () => {
  const fit = fitScoringComponents([row('past', 'player', { shots: [4, 2, 0, 0, 0, 0] })], scope);
  const future = row('next', 'player', { date: '2026-02-02T01:00:00Z', shots: [4, 2, 3, 1, 0, 0] });
  const newcomer = row('rookie', 'unknown', { date: '2026-02-02T01:00:00Z', shots: [6, 3, 2, 1, 1, 1] });
  const evaluation = evaluateScoringComponents(fit, [future, newcomer], { conditionOnObservedAttempts: true });
  assert.equal(evaluation.reconciledTargets, 2);
  assert.equal(evaluation.accepted, 0, 'neither target has a complete conditional-points forecast');
  assert.equal(evaluation.components.twoPoint.attempts, 4);
  assert.equal(evaluation.components.twoPoint.unavailableAccuracyAttempts, 6);
  assert.equal(evaluation.components.threePoint.unavailableAccuracyAttempts, 5);
  assert.equal(evaluation.components.freeThrow.unavailableAccuracyAttempts, 1);
  assert.equal(evaluation.components.threePoint.conversionBrier, null, 'missing accuracy is not perfect accuracy');
});
