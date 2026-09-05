import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  checkCombinationContinuity,
  checkChronologicalRapmCalibration,
  checkLineupAttributionSensitivity,
  checkOffenseDefenseRapmCalibration,
  checkProjection,
  checkRecencyWeightedRapm,
  checkShardScope,
  streamTeamShardJson,
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

test('lineup-attribution sensitivity reconciles its exposure counters', () => {
  const coverage = {
    exactLineupPossessions: 200,
    possessionStartLineupAttributedMidChange: 27,
  };
  const value = {
    method: 'possession_start_lineup_with_mid_possession_change_count_v1',
    exactLineupPossessions: 200,
    possessionStartLineupAttributedMidChange: 27,
    possessionStartLineupAttributedMidChangeShare: 0.135,
    caveat: 'A documented sensitivity diagnostic.',
  };
  const validErrors = [];
  checkLineupAttributionSensitivity(value, coverage, validErrors);
  assert.deepEqual(validErrors, []);

  const invalidErrors = [];
  checkLineupAttributionSensitivity(
    { ...value, possessionStartLineupAttributedMidChange: 28, possessionStartLineupAttributedMidChangeShare: 0.135 },
    coverage,
    invalidErrors,
  );
  assert.match(invalidErrors.join('\n'), /mid-change possessions/);
  assert.match(invalidErrors.join('\n'), /share does not reconcile/);
});

function calibrationMetrics(weightedMse, heldOutPossessions = 80) {
  return {
    weightedMse,
    weightedRmsePer100: 100 * Math.sqrt(weightedMse),
    weightedMaePer100: 50,
    weightedBiasPredictedMinusObservedPer100: 0,
    heldOutPossessions,
    directionalObservationCount: 8,
  };
}

function chronologicalCalibration({ fullMse = 0.8, baselineMse = 1, priorSeasonWeight = 1, lambda = 10, model = 'net' } = {}) {
  const improvement = (baselineMse - fullMse) / baselineMse;
  const improves = improvement > 1e-9;
  return {
    version: 'chronological_latest_season_tune_test_v1',
    model,
    latestSeasonStartYear: 2025,
    method: 'prior_seasons_plus_chronological_latest_season_train_tune_test_v1',
    selectedPriorSeasonWeight: priorSeasonWeight,
    selectedLambda: lambda,
    tuningGameFraction: 0.2,
    testGameFraction: 0.2,
    tuningSelection: { fitStatus: 'scored', priorSeasonWeight, lambda },
    candidates: [{ fitStatus: 'scored', priorSeasonWeight, lambda }],
    test: {
      fullModel: calibrationMetrics(fullMse),
      fixedEffectsBaseline: calibrationMetrics(baselineMse),
      fullModelMseImprovementVsFixedEffectsBaseline: improvement,
      fullModelImprovesBaseline: improves,
      status: improves ? 'validated' : 'not_validated',
    },
  };
}

test('multiseason chronological RAPM calibration is required and must beat its untouched baseline', () => {
  const rapm = { priorSeasonWeight: 1, lambda: 10 };
  const missingErrors = [];
  checkChronologicalRapmCalibration(null, rapm, 'net', 2025, missingErrors, { required: true });
  assert.match(missingErrors.join('\n'), /is required/);

  const validErrors = [];
  checkChronologicalRapmCalibration(chronologicalCalibration(), rapm, 'net', 2025, validErrors, { required: true });
  assert.deepEqual(validErrors, []);

  const noGainErrors = [];
  checkChronologicalRapmCalibration(
    chronologicalCalibration({ fullMse: 1, baselineMse: 1 }),
    rapm,
    'net',
    2025,
    noGainErrors,
    { required: true },
  );
  assert.match(noGainErrors.join('\n'), /did not beat/);
});

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

  const recencyWeightedCalibration = {
    ...calibration,
    heldOutPossessions: 60,
    fullModel: calibrationMetrics(0.8, 60),
    venueBaseline: calibrationMetrics(1, 60),
    withoutOffensePlayerEffects: calibrationMetrics(0.9, 60),
    withoutDefensePlayerEffects: calibrationMetrics(0.95, 60),
  };
  const recencyWeightedErrors = [];
  checkOffenseDefenseRapmCalibration(
    recencyWeightedCalibration,
    { ...odRapm, totalEffectiveOffensivePossessions: 60 },
    recencyWeightedErrors,
    [],
  );
  assert.deepEqual(recencyWeightedErrors, []);

  const malformedErrors = [];
  checkOffenseDefenseRapmCalibration(
    { ...calibration, status: 'validated', allComponentsImproved: false },
    odRapm,
    malformedErrors,
    [],
  );
  assert.match(malformedErrors.join('\n'), /status does not match/);
});

test('exact lineup projection permits an intentional unavailable result outside the net RAPM scope', () => {
  const netRapm = {
    modelVersion: 'weighted_ridge_rapm_v1',
    homeCourtSignConvention: 'positive_increases_home_net_rating_relative_to_away',
    homeCourtNetRatingEffectPer100: 1.25,
  };
  const row = {
    size: 5,
    playerIds: ['player-a', 'player-b', 'player-c', 'player-d', 'player-missing'],
    projection: {
      status: 'unavailable',
      reason: 'exactly_five_players_with_finite_rapm_required',
      model: 'rapm_sum_plus_possession_shrunk_observed_synergy_v1',
      homeCourtAdjustmentSource: {
        modelVersion: netRapm.modelVersion,
        signConvention: netRapm.homeCourtSignConvention,
        homeCourtNetRatingEffectPer100: netRapm.homeCourtNetRatingEffectPer100,
        signedExposureBalance: 0,
      },
    },
  };
  const scopedErrors = [];
  checkProjection(row, {
    'player-a': 1,
    'player-b': 2,
    'player-c': 3,
    'player-d': 4,
  }, netRapm, '0.0', scopedErrors);
  assert.deepEqual(scopedErrors, []);

  const completeCoverageErrors = [];
  checkProjection(row, {
    'player-a': 1,
    'player-b': 2,
    'player-c': 3,
    'player-d': 4,
    'player-missing': 5,
  }, netRapm, '0.1', completeCoverageErrors);
  assert.match(completeCoverageErrors.join('\n'), /unavailable despite complete net RAPM coverage/);
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
    lambda: 10,
  };

  const netErrors = [];
  checkRecencyWeightedRapm(
    {
      ...zeroWeightScope,
      observationCount: 20,
      chronologicalCalibration: chronologicalCalibration({ priorSeasonWeight: 0 }),
    },
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
      chronologicalCalibration: chronologicalCalibration({ priorSeasonWeight: 0, model: 'offenseDefense' }),
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
      chronologicalCalibration: chronologicalCalibration({ priorSeasonWeight: 0 }),
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

test('team-shard scanner streams array rows across read boundaries without retaining arrays', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-team-shard-scanner-'));
  const filePath = path.join(directory, 'team.json');
  const escaped = 'quote " and slash \\ and braces {[]}';
  const largeValue = 'x'.repeat((1024 * 1024) + 8192);
  const fixture = {
    schemaVersion: 'nba_local_scout_analytics_v4',
    metricsVersion: 'test_metrics_v1',
    seasonStartYears: [2024, 2025],
    team: { teamId: 'team-1' },
    lineupsAndCombinations: [{ kind: 'combination', escaped, largeValue }],
    playerOnOff: [{ kind: 'on-off', playerId: 'player-1' }],
    playerProfiles: [{ kind: 'profile', playerId: 'player-1' }],
    wowy: [{ kind: 'wowy', playerAId: 'player-1', playerBId: 'player-2' }],
  };
  await fs.writeFile(filePath, JSON.stringify(fixture));

  try {
    const headers = {};
    const rows = [];
    const result = await streamTeamShardJson(filePath, {
      onHeader(field, value) {
        headers[field] = value;
      },
      onArrayItem(field, index, row) {
        rows.push({ field, index, row });
      },
    });

    assert.equal(headers.schemaVersion, fixture.schemaVersion);
    assert.deepEqual(headers.seasonStartYears, fixture.seasonStartYears);
    assert.deepEqual(headers.team, fixture.team);
    assert.deepEqual(rows.map(({ field, index }) => ({ field, index })), [
      { field: 'lineupsAndCombinations', index: 0 },
      { field: 'playerOnOff', index: 0 },
      { field: 'playerProfiles', index: 0 },
      { field: 'wowy', index: 0 },
    ]);
    assert.equal(rows[0].row.escaped, escaped);
    assert.equal(rows[0].row.largeValue.length, largeValue.length);
    assert.deepEqual(result.seenFields, Object.keys(fixture));
    assert.equal(Object.hasOwn(result, 'lineupsAndCombinations'), false);

    await assert.rejects(
      streamTeamShardJson(filePath, { maxBufferedValueBytes: 256 }),
      /bounded parser limit/,
    );

    const malformedPath = path.join(directory, 'malformed.json');
    await fs.writeFile(malformedPath, '{"schemaVersion":"test","lineupsAndCombinations":[],}');
    await assert.rejects(streamTeamShardJson(malformedPath), /invalid property name/);

    const unsupportedArrayPath = path.join(directory, 'unsupported-array.json');
    await fs.writeFile(unsupportedArrayPath, '{"schemaVersion":"test","unrecognizedRows":[]}');
    await assert.rejects(streamTeamShardJson(unsupportedArrayPath), /unsupported array field/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
