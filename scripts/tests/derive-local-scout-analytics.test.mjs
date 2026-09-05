import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addDirectPlayerStatistic,
  createDirectPlayerEventLine,
  homeCourtExposureAdjustmentPer100,
  optionsFromArgs,
  playerProfileFromEvents,
  selectPossessionObservedBoundaryLineups,
  sourceArchiveValidationStatus,
  sourceArchiveValidationStatuses,
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
  const profile = playerProfileFromEvents({
    teamId: 'team-a',
    team: 'Team A',
    playerId: 'player-a',
    player: 'Player A',
    events,
    onOff: { onMinutes: 10, on: { all: { totalPossessions: 40, games: 1 } } },
    starterGames: 1,
    closerGames: 0,
  });

  assert.equal(profile.coverage.status, 'complete');
  assert.equal(profile.boxScore.points, 3);
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
