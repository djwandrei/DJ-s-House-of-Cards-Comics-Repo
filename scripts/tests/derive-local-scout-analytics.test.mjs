import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  addDirectPlayerStatistic,
  createDirectPlayerEventLine,
  homeCourtExposureAdjustmentPer100,
  officialSummaryReconciliationFromState,
  optionsFromArgs,
  playerProfileFromEvents,
  requireSourceSummaryTeamReconciliation,
  requireSourceValidationFileHashes,
  requireSourceValidationManifestHashes,
  requireTrialSourceAccessLevels,
  selectPossessionObservedBoundaryLineups,
  sourceArchiveValidationStatus,
  sourceArchiveValidationStatuses,
  verifiedSourceFileDescriptor,
} from '../derive-local-scout-analytics.mjs';

test('calibration-only derivation writes a bounded report instead of a full package', () => {
  const options = optionsFromArgs([
    '--archive-dir', 'outputs/fixture-source',
    '--calibration-only',
    '--calibration-report', 'outputs/fixture-calibration.json',
  ]);
  assert.equal(options.calibrationOnly, true);
  assert.match(options.calibrationReport, /fixture-calibration\.json$/);
  assert.throws(
    () => optionsFromArgs(['--archive-dir', 'outputs/fixture-source', '--calibration-only=yes']),
    /does not accept a value/,
  );
});

test('calibration provenance uses the checkpoint report verdict instead of a nonexistent season verdict', () => {
  const validated = sourceArchiveValidationStatus({
    passed: true,
    seasons: [{ seasonStartYear: 2025, manifest: { completedEntries: 1400 } }],
  }, 2025);
  assert.equal(validated.sourceArchiveValidationReportPassed, true);
  assert.equal(validated.sourceArchiveValidationSeasonPresent, true);
  assert.equal(validated.sourceArchiveValidationPassed, true);

  const wrongSeason = sourceArchiveValidationStatus({
    passed: true,
    seasons: [{ seasonStartYear: 2024 }],
  }, 2025);
  assert.equal(wrongSeason.sourceArchiveValidationPassed, false);

  const failedReport = sourceArchiveValidationStatus({
    passed: false,
    seasons: [{ seasonStartYear: 2025 }],
  }, 2025);
  assert.equal(failedReport.sourceArchiveValidationPassed, false);
});

test('multiseason options preserve single-season defaults and reject ambiguous scope', () => {
  const defaultOptions = optionsFromArgs(['--archive-dir', 'outputs/fixture-source']);
  assert.deepEqual(defaultOptions.seasonStartYears, [2025]);
  assert.equal(defaultOptions.seasonStartYear, 2025);
  assert.equal(defaultOptions.latestSeasonStartYear, 2025);

  const multiseason = optionsFromArgs([
    '--archive-dir', 'outputs/fixture-source',
    '--seasons', '2025,2024,2025',
    '--rapm-prior-season-weight', 'auto',
    '--offense-defense-rapm-prior-season-weight', '0.5',
    '--chronological-tuning-game-fraction', '0.2',
    '--chronological-test-game-fraction', '0.2',
  ]);
  assert.deepEqual(multiseason.seasonStartYears, [2024, 2025]);
  assert.equal(multiseason.seasonStartYear, 2024);
  assert.equal(multiseason.latestSeasonStartYear, 2025);
  assert.equal(multiseason.rapmPriorSeasonWeight, 'auto');
  assert.equal(multiseason.offenseDefenseRapmPriorSeasonWeight, 0.5);
  assert.match(multiseason.outputDir, /scout-analytics[\\/]2024-26$/);

  assert.throws(
    () => optionsFromArgs(['--archive-dir', 'outputs/fixture-source', '--season', '2025', '--seasons', '2024,2025']),
    /mutually exclusive/,
  );
  assert.throws(
    () => optionsFromArgs(['--archive-dir', 'outputs/fixture-source', '--season', '2025', '--rapm-prior-season-weight', 'auto']),
    /require at least two seasons/,
  );
});

test('multiseason checkpoint provenance fails closed unless every selected season is present', () => {
  const report = {
    passed: true,
    seasons: [{ seasonStartYear: 2024 }, { seasonStartYear: 2025 }],
  };
  const valid = sourceArchiveValidationStatuses(report, [2024, 2025]);
  assert.equal(valid.sourceArchiveValidationReportPassed, true);
  assert.equal(valid.sourceArchiveValidationAllSeasonsPresent, true);
  assert.equal(valid.sourceArchiveValidationPassed, true);
  assert.deepEqual(valid.selectedSeasons.map((season) => season.seasonStartYear), [2024, 2025]);

  const missing = sourceArchiveValidationStatuses(report, [2024, 2025, 2026]);
  assert.equal(missing.sourceArchiveValidationAllSeasonsPresent, false);
  assert.equal(missing.sourceArchiveValidationPassed, false);

  const duplicate = sourceArchiveValidationStatuses({
    passed: true,
    seasons: [{ seasonStartYear: 2024 }, { seasonStartYear: 2025 }, { seasonStartYear: 2025 }],
  }, [2024, 2025]);
  assert.equal(duplicate.sourceArchiveValidationAllSeasonsExactlyOnce, false);
  assert.equal(duplicate.sourceArchiveValidationPassed, false);
});

test('source manifests must be trial, internally scoped, and exact for every requested season', () => {
  const raw = (seasonStartYear, accessLevel = 'trial') => JSON.stringify({ seasonStartYear, accessLevel });
  const entries = [
    { seasonStartYear: 2024, raw: raw(2024) },
    { seasonStartYear: 2025, raw: raw(2025) },
  ];
  assert.deepEqual(requireTrialSourceAccessLevels(entries, [2024, 2025]), {
    2024: 'trial',
    2025: 'trial',
  });
  assert.throws(
    () => requireTrialSourceAccessLevels([{ seasonStartYear: 2024, raw: raw(2024, 'production') }], [2024]),
    /must declare accessLevel "trial"/,
  );
  assert.throws(
    () => requireTrialSourceAccessLevels([{ seasonStartYear: 2024, raw: raw(2025) }], [2024]),
    /does not match its requested season/,
  );
  assert.throws(
    () => requireTrialSourceAccessLevels([...entries, entries[1]], [2024, 2025]),
    /duplicate season/,
  );
  assert.throws(
    () => requireTrialSourceAccessLevels(entries, [2024, 2025, 2026]),
    /do not cover every requested season exactly once/,
  );
});

test('source validation binds the selected manifest hashes before records are loaded', () => {
  const entries = [
    { seasonStartYear: 2024, raw: JSON.stringify({ seasonStartYear: 2024, accessLevel: 'trial' }) },
    { seasonStartYear: 2025, raw: JSON.stringify({ seasonStartYear: 2025, accessLevel: 'trial' }) },
  ];
  const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
  const report = {
    passed: true,
    seasons: entries.map((entry) => ({ seasonStartYear: entry.seasonStartYear, manifestSha256: hash(entry.raw) })),
  };
  const result = requireSourceValidationManifestHashes(report, entries, [2024, 2025]);
  assert.equal(result.sourceValidation.sourceArchiveValidationPassed, true);
  assert.equal(result.manifestSha256BySeason[2024], hash(entries[0].raw));

  assert.throws(
    () => requireSourceValidationManifestHashes({
      ...report,
      seasons: [{ seasonStartYear: 2024, manifestSha256: hash(entries[0].raw) }, { seasonStartYear: 2025, manifestSha256: 'f'.repeat(64) }],
    }, entries, [2024, 2025]),
    /does not match the validated checkpoint/,
  );
});

test('source validation binds every game-file digest and its v4 summary-team counters', () => {
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const compressed = Buffer.from('compressed game fixture');
  const uncompressed = Buffer.from('{"game":"fixture"}');
  const sourceRecord = {
    relativePath: 'games/game-1.json.gz',
    gameId: 'game-1',
    byteLength: compressed.byteLength,
    gzipSha256: hash(compressed),
    uncompressedByteLength: uncompressed.byteLength,
    uncompressedSha256: hash(uncompressed),
    normalizedJsonSha256: 'a'.repeat(64),
  };
  const quality = {
    gamesWithSummaryTeamScoreNonReconciliation: 0,
    gamesWithSummaryTeamOffensiveRatingAlgebraDiagnostics: 0,
    summaryTeamOffensiveRatingAlgebraDiagnostics: 0,
    gamesWithSummaryTeamDefensiveRatingAlgebraDiagnostics: 0,
    summaryTeamDefensiveRatingAlgebraDiagnostics: 0,
    gamesWithSummaryTeamPossessionSymmetryDiagnostics: 0,
    summaryTeamPossessionSymmetryDiagnostics: 0,
  };
  const report = {
    passed: true,
    validatorVersion: 'sportradar-nba-local-archive-validator-v4',
    seasons: [{
      seasonStartYear: 2025,
      files: {
        expectedCompletedFiles: 1,
        discoveredGameFiles: 1,
        aggregateFileHash: 'b'.repeat(64),
        records: [sourceRecord],
      },
      dataQuality: quality,
    }],
  };
  const inventory = requireSourceValidationFileHashes(report, [2025]);
  const expected = inventory[2025].expectedFiles.get('game-1.json.gz');
  assert.equal(inventory[2025].expectedFileCount, 1);
  assert.equal(expected.gameId, 'game-1');
  assert.deepEqual(verifiedSourceFileDescriptor({
    expected,
    filename: 'game-1.json.gz',
    compressed,
    uncompressed,
    gameId: 'game-1',
  }), {
    relativePath: 'games/game-1.json.gz',
    byteLength: compressed.byteLength,
    gzipSha256: hash(compressed),
    uncompressedByteLength: uncompressed.byteLength,
    uncompressedSha256: hash(uncompressed),
  });
  assert.throws(
    () => verifiedSourceFileDescriptor({
      expected,
      filename: 'game-1.json.gz',
      compressed: Buffer.from('changed compressed fixture'),
      uncompressed,
      gameId: 'game-1',
    }),
    /validated gzip digest/,
  );
  assert.throws(
    () => verifiedSourceFileDescriptor({
      expected,
      filename: 'orphan.json.gz',
      compressed,
      uncompressed,
      gameId: 'game-1',
    }),
    /absent from the validated file inventory/,
  );
  assert.deepEqual(requireSourceSummaryTeamReconciliation(report, [2025]), { 2025: quality });
  assert.throws(
    () => requireSourceSummaryTeamReconciliation({ ...report, validatorVersion: 'sportradar-nba-local-archive-validator-v3' }, [2025]),
    /requires source validator/,
  );
  assert.throws(
    () => requireSourceSummaryTeamReconciliation({
      ...report,
      seasons: [{ ...report.seasons[0], dataQuality: {} }],
    }, [2025]),
    /no valid gamesWithSummaryTeamScoreNonReconciliation counter/,
  );
});

test('lineup home-court context scales the net RAPM venue effect by observed exposure', () => {
  assert.equal(homeCourtExposureAdjustmentPer100({
    homeCourtNetRatingEffectPer100: 10,
    homeCourtExposureBalance: 200,
    totalProjectionPossessions: 200,
  }), 10);
  assert.equal(homeCourtExposureAdjustmentPer100({
    homeCourtNetRatingEffectPer100: 10,
    homeCourtExposureBalance: -200,
    totalProjectionPossessions: 200,
  }), -10);
  assert.equal(homeCourtExposureAdjustmentPer100({
    homeCourtNetRatingEffectPer100: 10,
    homeCourtExposureBalance: 0,
    totalProjectionPossessions: 200,
  }), 0);
});

test('direct player profiles fail closed when provider shot or rebound fields are unresolved', () => {
  const events = createDirectPlayerEventLine();
  addDirectPlayerStatistic(events, { type: 'fieldgoal' }, 'fieldgoal');
  addDirectPlayerStatistic(events, { type: 'freethrow' }, 'freethrow');
  addDirectPlayerStatistic(events, { type: 'rebound' }, 'rebound');
  addDirectPlayerStatistic(events, { type: 'assist' }, 'assist');
  const profile = playerProfileFromEvents({
    teamId: 'team-a',
    team: 'Team A',
    playerId: 'player-a',
    player: 'Player A',
    events,
    onOff: { onMinutes: 20, on: { all: { totalPossessions: 80, games: 2 } } },
    starterGames: 1,
    closerGames: 1,
  });

  assert.equal(events.unknownFieldGoalMadeStatus, 1);
  assert.equal(events.unclassifiedFieldGoalAttempts, 1);
  assert.equal(events.unknownFreeThrowMadeStatus, 1);
  assert.equal(events.unclassifiedRebounds, 1);
  assert.equal(profile.coverage.status, 'partial');
  assert.equal(profile.boxScoreTotals.coverageStatus, 'partial');
  assert.deepEqual(profile.boxScoreTotals.totals, profile.boxScore);
  assert.equal(profile.coverage.scoringComplete, false);
  assert.equal(profile.shooting.fieldGoalPercentage, null);
  assert.equal(profile.shooting.trueShootingPercentage, null);
  assert.equal(profile.per36.points, null);
  assert.equal(profile.per36.rebounds, null);
  assert.equal(profile.per36.assists, 1.8);
});

test('direct player profiles retain complete percentages when structured outcomes are known', () => {
  const events = createDirectPlayerEventLine();
  addDirectPlayerStatistic(events, {
    type: 'fieldgoal', made: true, points: 2, shot_distance: 3,
    shot_type: 'layup', shot_type_desc: 'driving',
  }, 'twopointmade');
  addDirectPlayerStatistic(events, { type: 'freethrow', made: true, points: 1 }, 'freethrowmade');
  addDirectPlayerStatistic(events, { type: 'rebound', rebound_type: 'offensive' }, 'rebound');
  addDirectPlayerStatistic(events, { type: 'attemptblocked' }, 'twopointmiss');
  addDirectPlayerStatistic(events, { type: 'technicalfoul' }, 'technicalfoul');
  addDirectPlayerStatistic(events, { type: 'technicalfoulnonunsportsmanlike' }, 'technicalfoul');
  addDirectPlayerStatistic(events, { type: 'flagrantfoul' }, 'flagrantfoul');
  addDirectPlayerStatistic(events, { type: 'ejection' }, 'ejection');
  const officialTotals = {
    points: 3,
    fieldGoalAttempts: 1,
    fieldGoalsMade: 1,
    twoPointAttempts: 1,
    twoPointMakes: 1,
    threePointAttempts: 0,
    threePointersMade: 0,
    freeThrowAttempts: 1,
    freeThrowsMade: 1,
    offensiveRebounds: 1,
    defensiveRebounds: 0,
    rebounds: 1,
    assists: 0,
    steals: 0,
    blocks: 0,
    turnovers: 0,
    personalFouls: 0,
  };
  const profile = playerProfileFromEvents({
    teamId: 'team-a',
    team: 'Team A',
    playerId: 'player-a',
    player: 'Player A',
    events,
    onOff: { onMinutes: 10, on: { all: { totalPossessions: 40, games: 1 } } },
    starterGames: 1,
    closerGames: 0,
    officialSummaryReconciliationState: {
      gamesExpected: 1,
      gamesWithAnySummaryTotals: 1,
      gamesWithCompleteSummaryTotals: 1,
      gamesReconciledWithStructuredPbp: 1,
      reconciledTotals: officialTotals,
    },
  });

  assert.equal(profile.coverage.status, 'complete');
  assert.equal(profile.boxScore.points, 3);
  assert.equal(profile.boxScoreTotals.source, 'sportradar_play_by_play_structured_statistics');
  assert.equal(profile.boxScoreTotals.aggregation, 'scope_sum_of_non_rescinded_structured_statistics');
  assert.equal(profile.boxScoreTotals.gameScope, 'scout_eligible_games');
  assert.equal(profile.boxScoreTotals.coverageStatus, 'complete');
  assert.deepEqual(profile.boxScoreTotals.totals, profile.boxScore);
  assert.equal(profile.boxScoreTotals.officialSummaryReconciliation.status, 'complete_and_reconciled');
  assert.deepEqual(profile.boxScoreTotals.officialSummaryReconciliation.totals, officialTotals);
  assert.equal(profile.shooting.fieldGoalPercentage, 1);
  assert.equal(profile.shooting.twoPointPercentage, 1);
  assert.equal(profile.shooting.freeThrowPercentage, 1);
  assert.equal(profile.shooting.shotZones.atRim.percentage, 1);
  assert.equal(profile.shooting.providerShotTypeProfile.layup.attempts, 1);
  assert.equal(profile.shooting.providerShotDescriptionProfile.driving.percentage, 1);
  assert.equal(profile.coverage.providerShotTypeShare, 1);
  assert.equal(profile.coverage.providerShotDescriptionShare, 1);
  assert.equal(profile.shooting.blockedAttemptRate, 1);
  assert.equal(profile.boxScore.totalTechnicalFouls, 2);
  assert.equal(profile.boxScore.flagrantFouls, 1);
  assert.equal(profile.boxScore.ejections, 1);
  assert.equal(events.structuredStatisticRows, events.recognizedStatisticRows);
  assert.equal(profile.per100Possessions.points, 15);
});

test('official Summary reconciliation emits a total only for fully matched player appearances', () => {
  const reconciledTotals = {
    points: 14,
    fieldGoalAttempts: 9,
    fieldGoalsMade: 5,
    twoPointAttempts: 6,
    twoPointMakes: 3,
    threePointAttempts: 3,
    threePointersMade: 2,
    freeThrowAttempts: 2,
    freeThrowsMade: 2,
    offensiveRebounds: 2,
    defensiveRebounds: 4,
    rebounds: 6,
    assists: 5,
    steals: 1,
    blocks: 2,
    turnovers: 3,
    personalFouls: 2,
  };
  const complete = officialSummaryReconciliationFromState({
    gamesExpected: 2,
    gamesWithAnySummaryTotals: 2,
    gamesWithCompleteSummaryTotals: 2,
    gamesReconciledWithStructuredPbp: 2,
    reconciledTotals,
  });
  assert.equal(complete.status, 'complete_and_reconciled');
  assert.deepEqual(complete.totals, reconciledTotals);

  const partial = officialSummaryReconciliationFromState({
    gamesExpected: 2,
    gamesWithAnySummaryTotals: 2,
    gamesWithCompleteSummaryTotals: 1,
    gamesReconciledWithStructuredPbp: 1,
    reconciledTotals,
  });
  assert.equal(partial.status, 'partial_or_unreconciled');
  assert.equal(partial.totals, null);
});

test('lineup home-court context fails closed for missing or invalid inputs', () => {
  for (const input of [
    {},
    { homeCourtNetRatingEffectPer100: 10, homeCourtExposureBalance: 1, totalProjectionPossessions: 0 },
    { homeCourtNetRatingEffectPer100: 'unknown', homeCourtExposureBalance: 1, totalProjectionPossessions: 100 },
  ]) {
    assert.equal(homeCourtExposureAdjustmentPer100(input), null);
  }
});

test('boundary lineup roles exclude an unobserved dead-ball final lineup', () => {
  const teamId = 'team-a';
  const opening = ['a1', 'a2', 'a3', 'a4', 'a5'];
  const closing = ['a1', 'a2', 'a3', 'a4', 'a6'];
  const unobservedDeadBallLineup = ['a1', 'a2', 'a3', 'a4', 'a7'];
  const key = (ids) => `${teamId}~5~${ids.join('|')}`;
  const result = selectPossessionObservedBoundaryLineups({
    teamId,
    exactLineups: [opening, closing, unobservedDeadBallLineup],
    observedLineupKeys: new Set([key(opening), key(closing)]),
  });

  assert.deepEqual(result.starterIds, opening);
  assert.deepEqual(result.closerIds, closing);
});
