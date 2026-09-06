import { createHash } from 'node:crypto';
import { describeScoutPlayer, describeScoutSample } from '../../lib/scout-studio.mjs';

// Synthetic contract fixtures only. Never served by the real preview runner.
export const snapshot = `s${'a'.repeat(24)}`;
export const digest = value => createHash('sha256').update(value).digest('hex');
export function rawPlayer(id = 'private-player-a', offset = 0) {
  return {
    playerId: id, player: `Test Player ${offset + 1}`, teamId: 'private-team-a', team: 'Test Franchise 00',
    gamesAppeared: 30, minutes: 900, teamPossessionsWhileOnCourt: 1800,
    coverage: { status: 'complete', recognizedStatisticRows: 2500, scoringComplete: true, reboundsComplete: true,
      unknownFieldGoalMadeStatus: 0, unclassifiedFieldGoalAttempts: 0, unclassifiedFieldGoalMakes: 0,
      unknownFreeThrowMadeStatus: 0, unclassifiedRebounds: 0, missingProviderShotDescription: 220 },
    boxScore: { points: 500, fieldGoalAttempts: 400, fieldGoalsMade: 180, twoPointAttempts: 250,
      twoPointMakes: 120, threePointAttempts: 150, threePointersMade: 60 - offset,
      freeThrowAttempts: 100, freeThrowsMade: 80, rebounds: 200, assists: 150, turnovers: 50,
      steals: 30, blocks: 20, foulsDrawn: 70 },
    boxScoreTotals: { officialSummaryReconciliation: { status: 'complete_and_reconciled' } },
    shooting: { shotZones: { atRim: { attempts: 100, makes: 65, unknownMadeStatus: 0 },
      shortMidRange: { attempts: 50, makes: 20, unknownMadeStatus: 0 },
      longMidRange: { attempts: 40, makes: 15, unknownMadeStatus: 0 } },
    providerShotDescriptionProfile: { pull_up: { attempts: 150, makes: 65, unknownMadeStatus: 0 },
      driving_layup: { attempts: 30, makes: 20, unknownMadeStatus: 0 } } },
    coefficient: 'DO-NOT-EXPOSE', archivePath: 'DO-NOT-EXPOSE', rapm: 1000,
  };
}

export function rawSample(net = 6, publishable = true) {
  return { games: 12, offensivePossessions: 210, defensivePossessions: 200,
    offensiveRating: 115, defensiveRating: 115 - net, netRating: net,
    reliability: { publishable, thresholds: { publishablePossessions: 100 } },
    confidence95: { netRating: { lower: net - 8, upper: net + 8 } },
    rapm: 'DO-NOT-EXPOSE', archivePath: 'DO-NOT-EXPOSE' };
}

export function readyStatus() {
  return { phase: 'ready', snapshot, warnings: [], issues: [], missing: [],
    source: { aggregation: 'Team-specific pooled totals across 2022–23 through 2025–26.', phases: ['REG', 'PST'] },
    teams: [{ id: 't0', name: 'Test Franchise 00' }, { id: 't1', name: 'Test Franchise 01' }] };
}

export function fixtureSource() {
  return {
    status: async () => readyStatus(),
    roster: async team => ({ snapshot, team, players: Array.from({ length: 6 }, (_, i) => describeScoutPlayer(rawPlayer(`private-${i}`, i), `p${i}`)) }),
    chemistry: async (team, token, selection) => ({ snapshot: token, selection,
      combination: selection.length === 5 ? null : { minutes: 200, kind: 'shared_floor',
        sample: describeScoutSample(rawSample()),
        note: 'Shared floor, not an isolated unit.' },
      wowy: [], note: 'Synthetic browser test only. Not a fitted NBA result.' }),
  };
}

export function readinessFixture() {
  const metrics = mse => ({ weightedMse: mse, weightedRmsePer100: 100 * Math.sqrt(mse), weightedMaePer100: 50,
    weightedBiasPredictedMinusObservedPer100: 0, heldOutPossessions: 80, directionalObservationCount: 8 });
  const interval = (gameCount, firstScheduledAt, lastScheduledAt) => ({ gameCount, firstScheduledAt, lastScheduledAt });
  const model = name => ({ seasonEndYear: 2026, solver: { converged: true }, lambda: 10, priorSeasonWeight: 0.5,
    gameCount: 30, directionalObservationCount: 8, totalOffensivePossessions: 100, totalEffectiveOffensivePossessions: 80,
    chronologicalCalibration: {
      version: 'chronological_latest_season_tune_test_v1', model: name, latestSeasonStartYear: 2025,
      method: 'prior_seasons_plus_chronological_latest_season_train_tune_test_v1',
      selectedPriorSeasonWeight: 0.5, selectedLambda: 10, tuningGameFraction: 0.2, testGameFraction: 0.2,
      tuningSelection: { fitStatus: 'scored', priorSeasonWeight: 0.5, lambda: 10 },
      candidates: [{ fitStatus: 'scored', priorSeasonWeight: 0.5, lambda: 10 }],
      split: {
        priorSeasonsTraining: interval(20, '2022-10-18T23:00:00Z', '2025-06-22T23:00:00Z'),
        latestSeasonTraining: interval(6, '2025-10-21T23:00:00Z', '2026-01-20T23:00:00Z'),
        latestSeasonTuning: interval(2, '2026-02-02T23:00:00Z', '2026-03-03T23:00:00Z'),
        latestSeasonTest: interval(2, '2026-03-20T23:00:00Z', '2026-06-11T23:00:00Z'),
      }, test: { status: 'validated', fullModel: metrics(0.8), fixedEffectsBaseline: metrics(1),
        fullModelMseImprovementVsFixedEffectsBaseline: 0.2, fullModelImprovesBaseline: true },
    },
  });
  const od = model('offenseDefense');
  od.calibration = { version: 'game_fold_directional_ablation_v1', status: 'validated',
    method: 'deterministic_sorted_game_round_robin_fixed_lambda_weighted_out_of_fold_v1',
    fixedLambda: 10, requestedFoldCount: 5, foldCount: 5, gameCount: 30, directionalObservationCount: 8, heldOutPossessions: 80,
    fullModel: metrics(0.8), venueBaseline: metrics(1), withoutOffensePlayerEffects: metrics(0.9), withoutDefensePlayerEffects: metrics(0.95),
    fullModelMseImprovementVsVenueBaseline: 0.2, offenseComponentMseImprovementVsWithoutOffense: (0.9 - 0.8) / 0.9,
    defenseComponentMseImprovementVsWithoutDefense: (0.95 - 0.8) / 0.95, fullModelImprovesBaseline: true,
    offenseComponentDoesNotDegrade: true, defenseComponentDoesNotDegrade: true, allComponentsImproved: true,
    unseenPlayerDirectionPossessions: 0, unseenPlayerDirectionCount: 0, unseenPlayerPossessionShare: 0 };
  const source = { validatorVersion: 'sportradar-nba-local-archive-validator-v4', passed: true,
    errors: [], warnings: [], archiveScope: { seasons: [2022, 2023, 2024, 2025] } };
  const manifest = { schemaVersion: 4, metricsVersion: 'nba-scout-metrics-v4',
    scope: { seasonStartYear: 2022, seasonStartYears: [2022, 2023, 2024, 2025], latestSeasonStartYear: 2025,
      seasonEndYear: 2026, includedPhases: ['REG', 'PST'] },
    storage: { writeMode: 'bounded_memory_atomic_team_stream_v1' },
    provenance: { sourceArchiveValidationPassed: true, sourceValidatorVersion: source.validatorVersion,
      sourceValidationReportSha256: digest(JSON.stringify(source)) }, rapm: { net: model('net'), offenseDefense: od },
    dataShards: [],
  };
  return { source, manifest };
}
