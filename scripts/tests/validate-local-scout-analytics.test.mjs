import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCombinationContinuity,
  checkOffenseDefenseRapmCalibration,
} from '../validate-local-scout-analytics.mjs';

function exactLineup({ games = 3, starters = 1, closers = 2 } = {}) {
  return {
    size: 5,
    contexts: { all: { games } },
    continuity: {
      exactLineupStartingGames: starters,
      exactLineupClosingGames: closers,
      exactLineupStartRate: games > 0 ? Math.round((starters / games) * 10_000) / 10_000 : null,
      exactLineupCloseRate: games > 0 ? Math.round((closers / games) * 10_000) / 10_000 : null,
    },
  };
}

test('exact-lineup continuity validates role counts and rates against games used', () => {
  const validErrors = [];
  checkCombinationContinuity(exactLineup(), '0.0', validErrors);
  assert.deepEqual(validErrors, []);

  const invalid = exactLineup({ games: 2, starters: 3, closers: 1 });
  invalid.continuity.exactLineupCloseRate = 0.9;
  const errors = [];
  checkCombinationContinuity(invalid, '0.1', errors);
  assert.match(errors.join('\n'), /StartingGames exceeds games used/);
  assert.match(errors.join('\n'), /CloseRate does not reconcile/);
});

test('co-presence continuity rejects exact-lineup role fields', () => {
  const row = {
    size: 4,
    contexts: { all: { games: 2 } },
    continuity: {
      exactLineupStartingGames: 1,
      exactLineupClosingGames: null,
      exactLineupStartRate: 0.5,
      exactLineupCloseRate: null,
    },
  };
  const errors = [];
  checkCombinationContinuity(row, '0.2', errors);
  assert.match(errors.join('\n'), /must be null/);
});

function calibrationMetrics(weightedMse) {
  return {
    weightedMse,
    weightedRmsePer100: 100 * Math.sqrt(weightedMse),
    weightedMaePer100: 50,
    weightedBiasPredictedMinusObservedPer100: 0,
    heldOutPossessions: 80,
    directionalObservationCount: 8,
  };
}

test('O/D RAPM calibration verifies held-out baseline and component-ablation reconciliation', () => {
  const odRapm = {
    lambda: 25,
    gameCount: 4,
    directionalObservationCount: 8,
    totalOffensivePossessions: 80,
  };
  const fullModel = calibrationMetrics(0.8);
  const venueBaseline = calibrationMetrics(1);
  const withoutOffensePlayerEffects = calibrationMetrics(0.9);
  const withoutDefensePlayerEffects = calibrationMetrics(0.95);
  const calibration = {
    version: 'game_fold_directional_ablation_v1',
    status: 'validated',
    method: 'deterministic_sorted_game_round_robin_fixed_lambda_weighted_out_of_fold_v1',
    fixedLambda: 25,
    requestedFoldCount: 2,
    foldCount: 2,
    gameCount: 4,
    directionalObservationCount: 8,
    heldOutPossessions: 80,
    fullModel,
    venueBaseline,
    withoutOffensePlayerEffects,
    withoutDefensePlayerEffects,
    fullModelMseImprovementVsVenueBaseline: 0.2,
    offenseComponentMseImprovementVsWithoutOffense: (0.9 - 0.8) / 0.9,
    defenseComponentMseImprovementVsWithoutDefense: (0.95 - 0.8) / 0.95,
    fullModelImprovesBaseline: true,
    offenseComponentDoesNotDegrade: true,
    defenseComponentDoesNotDegrade: true,
    allComponentsImproved: true,
    unseenPlayerDirectionPossessions: 0,
    unseenPlayerDirectionCount: 0,
    unseenPlayerPossessionShare: 0,
  };
  const errors = [];
  const warnings = [];
  checkOffenseDefenseRapmCalibration(calibration, odRapm, errors, warnings);
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);

  const malformedErrors = [];
  checkOffenseDefenseRapmCalibration(
    { ...calibration, status: 'validated', allComponentsImproved: false },
    odRapm,
    malformedErrors,
    [],
  );
  assert.match(malformedErrors.join('\n'), /status does not match/);
});
