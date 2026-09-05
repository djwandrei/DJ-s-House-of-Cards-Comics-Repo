import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkCombinationContinuity,
  checkOffenseDefenseRapmCalibration,
  checkRecencyWeightedRapm,
  checkShardScope,
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

test('multiseason RAPM coverage reconciles only positive-weight seasons', () => {
  const options = {
    seasonStartYears: [2024, 2025],
    seasonStartYear: 2024,
    latestSeasonStartYear: 2025,
  };
  const rapmCoverage = {
    gameCount: 7,
    observationCount: 30,
    gamesBySeason: { 2024: 3, 2025: 4 },
    observationsBySeason: { 2024: 10, 2025: 20 },
    pairedPossessionsBySeason: { 2024: 50, 2025: 100 },
    offensivePossessionsBySeason: { 2024: 100, 2025: 200 },
  };
  const zeroWeightScope = {
    priorSeasonWeight: 0,
    seasonWeights: { 2024: 0, 2025: 1 },
    includedSeasonStartYears: [2025],
    gameCount: 4,
    totalPairedPossessions: 100,
    totalEffectivePairedPossessions: 100,
    chronologicalCalibration: null,
  };

  const netErrors = [];
  checkRecencyWeightedRapm(
    { ...zeroWeightScope, observationCount: 20 },
    'Net RAPM',
    'net',
    rapmCoverage,
    options,
    netErrors,
  );
  assert.deepEqual(netErrors, []);

  const offenseDefenseErrors = [];
  checkRecencyWeightedRapm(
    {
      ...zeroWeightScope,
      pairedStintObservationCount: 20,
      totalOffensivePossessions: 200,
      totalEffectiveOffensivePossessions: 200,
    },
    'Offense/defense RAPM',
    'offenseDefense',
    rapmCoverage,
    options,
    offenseDefenseErrors,
  );
  assert.deepEqual(offenseDefenseErrors, []);

  const malformedErrors = [];
  checkRecencyWeightedRapm(
    {
      ...zeroWeightScope,
      observationCount: 20,
      includedSeasonStartYears: [2024, 2025],
      totalEffectivePairedPossessions: 125,
    },
    'Net RAPM',
    'net',
    rapmCoverage,
    options,
    malformedErrors,
  );
  assert.match(malformedErrors.join('\n'), /included seasons do not match/);
  assert.match(malformedErrors.join('\n'), /effective paired possessions/);
});

test('single-season RAPM keeps its aggregate-counter compatibility path', () => {
  const errors = [];
  checkRecencyWeightedRapm(
    {
      observationCount: 8,
      gameCount: 2,
      totalPairedPossessions: 40,
      totalEffectivePairedPossessions: 40,
    },
    'Net RAPM',
    'net',
    { observationCount: 8, gameCount: 2 },
    { seasonStartYears: [2025], seasonStartYear: 2025, latestSeasonStartYear: 2025 },
    errors,
  );
  assert.deepEqual(errors, []);
});

test('multiseason shard headers must carry the exact package scope', () => {
  const options = {
    seasonStartYears: [2024, 2025],
    seasonStartYear: 2024,
    latestSeasonStartYear: 2025,
  };
  const validErrors = [];
  checkShardScope({
    seasonStartYear: 2024,
    seasonEndYear: 2026,
    seasonStartYears: [2024, 2025],
    latestSeasonStartYear: 2025,
  }, 0, options, validErrors);
  assert.deepEqual(validErrors, []);

  const malformedErrors = [];
  checkShardScope({
    seasonStartYear: 2024,
    seasonEndYear: 2025,
    seasonStartYears: [2025],
    latestSeasonStartYear: 2024,
  }, 1, options, malformedErrors);
  assert.match(malformedErrors.join('\n'), /season end/);
  assert.match(malformedErrors.join('\n'), /season list/);
  assert.match(malformedErrors.join('\n'), /latest season/);
});
