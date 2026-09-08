import { createHash } from 'node:crypto';
import { describeScoutPlayer, describeScoutSeasonProfile, describeScoutSample, describeScoutContexts, describeScoutOnOff, describeScoutTeamContexts } from '../../lib/scout-studio.mjs';

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

export function rawContextMap(offset = 0) {
  return {
    all: rawSample(6 + offset),
    'season:2022': rawSample(5 + offset), 'season:2023': rawSample(6 + offset),
    'season:2024': rawSample(7 + offset), 'season:2025': rawSample(8 + offset),
    'phase:regular': rawSample(6 + offset), 'phase:playoffs': rawSample(8 + offset),
    'venue:home': rawSample(7 + offset), 'venue:away': rawSample(5 + offset),
    'window:last_5': rawSample(9 + offset), 'clutch_v1': rawSample(4 + offset),
  };
}

export function rawOnOffRow(id = 'private-player-a', offset = 0) {
  return { teamId: 'private-team-a', team: 'Test Franchise 00', playerId: id, player: `Test Player ${offset + 1}`,
    onMinutes: 900, offMinutes: 500, on: rawContextMap(offset), off: rawContextMap(offset - 1) };
}

export function rawGameSample(offset = 0) {
  const offense = { empty: 450 + offset * 20, one: 100, two: 300 - offset * 20, three: 140, fourPlus: 10 };
  const defense = { empty: 480 - offset * 20, one: 100, two: 270 + offset * 20, three: 140, fourPlus: 10 };
  const points = counts => counts.one + 2 * counts.two + 3 * counts.three + 43;
  const offensiveRating = points(offense) / 10, defensiveRating = points(defense) / 10;
  return { ...rawSample(offensiveRating - defensiveRating), games: 30, offensivePossessions: 1000, defensivePossessions: 1000,
    offensivePointsFor: points(offense), defensivePointsAllowed: points(defense), offensiveRating, defensiveRating,
    possessionOutcomes: { offense: { ...offense, totalPossessions: 1000 }, defense: { ...defense, totalPossessions: 1000 } } };
}

export function rawTeamRow(offset = 0) {
  return { teamId: `private-team-${offset ? 'b' : 'a'}`, team: `Test Franchise 0${offset}`,
    contexts: Object.fromEntries(['all', 'season:2023', 'season:2024', 'season:2025'].map(key => [key, rawGameSample(offset)])) };
}

export function rawSeasonProfile(player = 'Test Player 1', year = 2022, team = 'Test Franchise 00', scope = 'team', offset = 0) {
  const fields = ['points', 'fieldGoalAttempts', 'fieldGoalsMade', 'assists', 'rebounds', 'turnovers', 'steals', 'blocks'];
  const fieldEvidence = Object.fromEntries(fields.map(key => [key, { effectiveKnownGames: 20, matchedGames: 20, effectiveTotal: key === 'points' ? 240 + offset : 20 + offset }]));
  const row = describeScoutSeasonProfile({ seasonStartYear: year, phase: 'regular', team, teamId: scope === 'all-teams' ? 'ALL_TEAMS' : 'private-team-a', listedPositions: ['G'], games: 20, officialMinutes: 400,
    perGame: { points: 12 + offset, assists: 3, rebounds: 5, fieldGoalAttempts: 10, turnovers: 1, steals: 1, blocks: 1 },
    officialRates: { fieldGoalPercentage: .5, threePointPercentage: .4, freeThrowPercentage: .8, threePointAttemptShare: .4, offensiveInvolvementPer36: 16 },
    ratios: { fieldGoalAccuracy: { numerator: 100, denominator: 200 }, threePointAccuracy: { numerator: 40, denominator: 100 }, threePointAttemptShare: { numerator: 80, denominator: 200 }, freeThrowAccuracy: { numerator: 80, denominator: 100 } }, fieldEvidence });
  return { ...row, player, key: `${player}|${year}|regular|${team}|${scope}` };
}

export function readyStatus() {
  return { phase: 'ready', snapshot, warnings: [], issues: [], missing: [],
    source: { aggregation: 'Team-specific pooled totals across 2022–23 through 2025–26.', phases: ['REG', 'PST'],
      seasonStartYears: [2022, 2023, 2024, 2025], seasons: ['2022–23', '2023–24', '2024–25', '2025–26'] },
    teams: [{ id: 't0', name: 'Test Franchise 00' }, { id: 't1', name: 'Test Franchise 01' }] };
}

export function fixtureSource() {
  const seasonProfiles = player => [rawSeasonProfile(player, 2022, 'Test Franchise 00', 'team'), rawSeasonProfile(player, 2023, 'All teams', 'all-teams', 1), rawSeasonProfile(player, 2024, 'Test Franchise 00', 'team', 2)];
  return {
    status: async () => readyStatus(),
    teamContexts: async (team, token) => ({ snapshot: token, team, contexts: describeScoutTeamContexts(rawTeamRow(Number(team.slice(1)))) }),
    roster: async team => ({ snapshot, team, players: Array.from({ length: 6 }, (_, i) => describeScoutPlayer(rawPlayer(`private-${i}`, i), `p${i}`)) }),
    playerContexts: async (team, token, id) => ({ snapshot: token, team, player: id, ...describeScoutOnOff(rawOnOffRow(`private-${id.slice(1) || 0}`, Number(id.slice(1) || 0))) }),
    playerSeasons: async (team, token, id) => ({ snapshot: token, team, player: id, profiles: seasonProfiles(`Test Player ${Number(id.slice(1) || 0) + 1}`), note: 'Synthetic season profiles for browser tests.' }),
    seasonDonors: async (team, token) => ({ snapshot: token, team, profiles: Array.from({ length: 6 }, (_, index) => seasonProfiles(`Test Player ${index + 1}`)).flat(), note: 'Synthetic season donors for browser tests.' }),
    chemistry: async (team, token, selection) => ({ snapshot: token, team, selection,
      combination: selection.length === 5 ? null : { minutes: 200, kind: 'shared_floor',
        sample: describeScoutSample(rawSample()),
        contexts: describeScoutContexts(rawContextMap()),
        note: 'Shared floor, not an isolated unit.' },
      wowy: selection.length === 2 ? ['a_on_b_on', 'a_on_b_off', 'a_off_b_on', 'a_off_b_off'].map((key, index) => ({ key,
        label: ['Together', 'Test Player 1 only', 'Test Player 2 only', 'Neither player'][index], ...describeScoutSample(rawSample(6 - index)) })) : [],
      pairs: selection.length > 2 ? selection.flatMap((id, a) => selection.slice(a + 1).map(other => ({ selection: [id, other],
        combination: { kind: 'shared_floor', sample: describeScoutSample(rawSample()) } }))) : [],
      note: 'Synthetic browser test only. Not a fitted NBA result.' }),
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
