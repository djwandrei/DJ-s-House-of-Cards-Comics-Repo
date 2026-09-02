import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FOUR_FACTOR_FORMULAS,
  addScoutAggregate,
  calculateAggregateMetrics,
  calculateFourFactors,
  calculateOnOff,
  calculateSampleReliability,
  classifyGarbageTimeProxy,
  classifyScoutPossessionContext,
  createScoutAggregate,
  deriveFourFactorCounts,
  deriveFourFactorsFromEvents,
  eventStatsForPossession,
  lineupProjection,
  metricFromAggregate,
  normalizeSeasonPhase,
  possessionContexts,
  projectLineupFromRapm,
  scoreStateForTeam,
  suppliedRollingWindowContexts,
} from '../lib/nba-scout-metrics.mjs';

const HOME = 'home-team';
const AWAY = 'away-team';

function statistic(type, teamId, extra = {}) {
  return { type, team: { id: teamId }, ...extra };
}

function event(id, eventType, statistics = [], extra = {}) {
  return { id, eventType, statistics, ...extra };
}

test('normalizes official phases, mirrors score state, and accepts supplied rolling memberships', () => {
  assert.equal(normalizeSeasonPhase('Play-In'), 'play_in');
  assert.equal(normalizeSeasonPhase('all-star'), 'unclassified');
  assert.equal(scoreStateForTeam('ahead_6_10', 'home'), 'ahead_6_10');
  assert.equal(scoreStateForTeam('ahead_6_10', 'away'), 'trailing_6_10');
  assert.equal(scoreStateForTeam('unknown', 'away'), 'unclassified');
  assert.deepEqual(suppliedRollingWindowContexts({ last5: true, last_10: true, last20: false }), ['last_5', 'last_10']);
  assert.deepEqual(suppliedRollingWindowContexts(new Set(['last20'])), ['last_20']);
});

test('classifies phase, clutch, transition, score state, garbage proxy, leverage, and rolling windows', () => {
  const possession = {
    periodSequence: 4,
    clockRemainingMs: 120_000,
    homePointsBefore: 100,
    awayPointsBefore: 80,
    homeScoreStateV1: 'ahead_16_plus',
    transitionContext: 'non_provider_fastbreak',
    isClutchV1: false,
  };
  const classified = classifyScoutPossessionContext({
    possession,
    side: 'away',
    phase: 'playoffs',
    rollingWindowMemberships: ['last5', 'last10'],
  });
  assert.equal(classified.phase, 'playoffs');
  assert.equal(classified.venue, 'away');
  assert.equal(classified.clutch, false);
  assert.equal(classified.transition, 'non_provider_fastbreak');
  assert.match(classified.transitionCaveat, /not a verified half-court/i);
  assert.equal(classified.scoreState, 'trailing_16_plus');
  assert.equal(classified.competitive.context, 'garbage_time_proxy_v1');
  assert.equal(classified.competitive.isGarbageTimeProxy, true);
  assert.equal(classified.leverage.bucket, 'low');
  assert.ok(classified.contexts.includes('window:last_5'));
  assert.ok(classified.contexts.includes('competition:garbage_time_proxy_v1'));
  assert.ok(classified.contexts.includes('venue:away'));
  assert.ok(classified.contexts.includes('period:q4'));
  assert.ok(classified.contexts.includes('half:second_half'));
  assert.deepEqual(
    possessionContexts(possession, 'away', { phase: 'playoffs', rollingWindowMemberships: { last20: true } }),
    classifyScoutPossessionContext({ possession, side: 'away', phase: 'playoffs', rollingWindowMemberships: { last20: true } }).contexts,
  );
});

test('derives clutch and leverage when flags are absent and leaves missing score/time unclassified', () => {
  const close = {
    periodNumber: 5,
    clockRemainingMs: 240_000,
    homePointsBefore: 111,
    awayPointsBefore: 108,
    homeScoreStateV1: 'ahead_1_5',
    transitionContext: 'provider_fastbreak_v1',
  };
  const classified = classifyScoutPossessionContext({ possession: close, side: 'home', phase: 'regular' });
  assert.equal(classified.clutch, true);
  assert.equal(classified.leverage.bucket, 'high');
  assert.equal(classified.competitive.context, 'competitive_proxy_v1');
  assert.equal(classifyGarbageTimeProxy({}).context, 'unclassified');

  const incomplete = classifyScoutPossessionContext({
    possession: { periodNumber: 4, homePointsBefore: 99, awayPointsBefore: 98 },
    side: 'home',
    phase: 'regular',
  });
  assert.equal(incomplete.clutch, null);
  assert.ok(incomplete.contexts.includes('clutch:unclassified'));
});

test('aggregate formulas separate scoreboard totals from possession-side ratings and retain defense points', () => {
  const aggregate = createScoutAggregate();
  addScoutAggregate(aggregate, {
    gameId: 'game-1',
    isOffense: true,
    pointsFor: 2,
    pointsAgainst: 1,
    fourFactorCounts: { fieldGoalAttempts: 1, fieldGoalsMade: 1 },
    offensiveEventExtras: { assists: 1, fieldGoalDistanceTotal: 6, fieldGoalDistanceObserved: 1 },
    gameResult: 'win',
  });
  addScoutAggregate(aggregate, {
    gameId: 'game-1',
    isOffense: true,
    pointsFor: 0,
    pointsAgainst: 0,
    fourFactorCounts: { turnovers: 1 },
    gameResult: 'win',
  });
  addScoutAggregate(aggregate, {
    gameId: 'game-1',
    isOffense: false,
    pointsFor: 1,
    pointsAgainst: 3,
    opponentFourFactorCounts: { fieldGoalAttempts: 1, fieldGoalsMade: 1, threePointAttempts: 1, threePointersMade: 1 },
    defensiveEventExtras: { steals: 1, blocks: 1, fieldGoalDistanceTotal: 24, fieldGoalDistanceObserved: 1 },
    gameResult: 'win',
  });
  addScoutAggregate(aggregate, {
    gameId: 'game-1',
    isOffense: false,
    pointsFor: 0,
    pointsAgainst: 1,
    opponentFourFactorCounts: { freeThrowAttempts: 1 },
    defensiveEventExtras: { freeThrowsMade: 1, personalFouls: 1 },
    gameResult: 'win',
  });

  const metrics = metricFromAggregate(aggregate);
  assert.equal(metrics.games, 1);
  assert.equal(metrics.pointsFor, 3);
  assert.equal(metrics.pointsAgainst, 5);
  assert.equal(metrics.offensivePointsFor, 2);
  assert.equal(metrics.defensivePointsAllowed, 4);
  assert.equal(metrics.offensiveRating, 100);
  assert.equal(metrics.defensiveRating, 200);
  assert.equal(metrics.netRating, -100);
  assert.equal(metrics.plusMinusPer100, -100);
  assert.equal(metrics.gameResults.wins, 1);
  assert.equal(metrics.gameResults.winPercentage, 1);
  assert.equal(metrics.pointDifferentialSquared, 6);
  assert.equal(metrics.fourFactors.offense.effectiveFieldGoalPercentage, 1);
  assert.equal(metrics.fourFactors.offense.turnoverRate, 0.5);
  assert.equal(metrics.fourFactors.defense.effectiveFieldGoalPercentage, 1.5);
  assert.equal(metrics.fourFactors.defense.freeThrowAttemptRate, 1);
  assert.equal(metrics.shootingProfile.offense.averageFieldGoalDistance, 6);
  assert.equal(metrics.shootingProfile.defense.freeThrowPercentage, 1);
  assert.equal(metrics.offensivePlaymaking.assists, 1);
  assert.equal(metrics.defensiveDisruption.steals, 1);
  assert.equal(metrics.possessionOutcomes.offense.accountedPossessions, 2);
  assert.equal(metrics.possessionOutcomes.defense.accountedPossessions, 2);
  assert.ok(metrics.confidence95.offensiveRating);
  assert.ok(metrics.confidence95.defensiveRating);
  assert.ok(metrics.confidence95.plusMinusPer100);
});

test('rating confidence intervals require stored point squares and at least two samples', () => {
  const complete = calculateAggregateMetrics({
    games: 2,
    offensivePossessions: 4,
    defensivePossessions: 4,
    offensivePointsFor: 6,
    defensivePointsAllowed: 5,
    pointsFor: 6,
    pointsAgainst: 5,
    offensivePointsForSquared: 14,
    defensivePointsAllowedSquared: 9,
    pointDifferentialSquared: 15,
  });
  assert.equal(complete.offensiveRating, 150);
  assert.equal(complete.defensiveRating, 125);
  assert.equal(complete.netRating, 25);
  assert.equal(complete.plusMinusPer100, 25);
  assert.ok(complete.confidence95.netRating.lower < complete.netRating);
  assert.ok(complete.confidence95.netRating.upper > complete.netRating);

  const incomplete = calculateAggregateMetrics({
    offensivePossessions: 1,
    defensivePossessions: 1,
    offensivePointsFor: 2,
    defensivePointsAllowed: 0,
    pointsFor: 2,
    pointsAgainst: 0,
  });
  assert.equal(incomplete.confidence95.offensiveRating, null);
  assert.equal(incomplete.confidence95.netRating, null);
});

test('aggregate game totals are deterministic even when input rows are interleaved by game', () => {
  const aggregate = createScoutAggregate();
  for (const gameId of ['game-1', 'game-2', 'game-1']) {
    addScoutAggregate(aggregate, { gameId, gameResult: 'win', isOffense: true, pointsFor: 0, pointsAgainst: 0 });
  }
  const metrics = metricFromAggregate(aggregate);
  assert.equal(metrics.games, 2);
  assert.equal(metrics.gameResults.wins, 2);
});

test('contiguous game-block tracking preserves game totals without retaining every game id', () => {
  const aggregate = createScoutAggregate({ gameCountTracking: 'contiguous_game_blocks' });
  for (const gameId of ['game-1', 'game-1', 'game-2', 'game-2']) {
    addScoutAggregate(aggregate, { gameId, gameResult: 'win', isOffense: true, pointsFor: 0, pointsAgainst: 0 });
  }
  const metrics = metricFromAggregate(aggregate);
  assert.equal(aggregate.seenGameIds, null);
  assert.equal(aggregate.lastGameId, 'game-2');
  assert.equal(metrics.games, 2);
  assert.equal(metrics.gameResults.wins, 2);
  assert.throws(
    () => createScoutAggregate({ gameCountTracking: 'unsupported' }),
    /gameCountTracking/,
  );
});

test('sample reliability is possession-based and on/off never converts missing values to zero', () => {
  assert.equal(calculateSampleReliability(0).grade, 'no_sample');
  assert.equal(calculateSampleReliability(49).grade, 'insufficient');
  assert.equal(calculateSampleReliability(50).grade, 'low');
  assert.equal(calculateSampleReliability(200).grade, 'medium');
  assert.equal(calculateSampleReliability(500).grade, 'high');
  assert.equal(calculateSampleReliability(200).reliabilityScore, 0.5);

  const available = calculateOnOff(
    { offensiveRating: 115, defensiveRating: 108, netRating: 7, plusMinusPer100: 6 },
    { offensiveRating: 110, defensiveRating: 111, netRating: -1, plusMinusPer100: -2 },
  );
  assert.equal(available.onOffNetRating, 8);
  assert.equal(available.defensiveRatingDifference, -3);
  assert.equal(available.status, 'available');

  const missing = calculateOnOff({ netRating: 5 }, { netRating: null });
  assert.equal(missing.onOffNetRating, null);
  assert.equal(missing.status, 'insufficient_on_or_off_sample');
});

test('derives explicit four-factor counts and formulas from structured normalized events', () => {
  const events = [
    event('fg2-made', 'twopointmade', [statistic('fieldgoal', HOME, { made: true, points: 2, shot_distance: 5 }), statistic('assist', HOME)]),
    event('fg3-made', 'threepointmade', [statistic('fieldgoal', HOME, { made: true, points: 3, shot_distance: 25 }), statistic('assist', HOME)]),
    event('fg3-miss', 'threepointmiss', [statistic('fieldgoal', HOME, { made: false })]),
    event('ft-made', 'freethrowmade', [statistic('freethrow', HOME, { made: true })]),
    event('ft-miss', 'freethrowmiss', [statistic('freethrow', HOME, { made: false })]),
    event('turnover', 'turnover', [statistic('turnover', HOME), statistic('steal', AWAY)]),
    event('offensive-foul', 'offensivefoul', [statistic('offensivefoul', HOME)]),
    event('orb', 'rebound', [statistic('rebound', HOME, { rebound_type: 'offensive' })]),
    event('drb', 'rebound', [statistic('rebound', AWAY, { rebound_type: 'defensive' })]),
    event('blocked-shot', 'twopointmiss', [statistic('fieldgoal', HOME, { made: false, points: 2 }), statistic('block', AWAY)]),
    event('foul', 'shootingfoul', [statistic('personalfoul', AWAY), statistic('fouldrawn', HOME)]),
  ];
  const derived = deriveFourFactorCounts(events, { offenseTeamId: HOME, defenseTeamId: AWAY });
  assert.deepEqual(derived.counts, {
    fieldGoalAttempts: 4,
    fieldGoalsMade: 2,
    threePointAttempts: 2,
    threePointersMade: 1,
    freeThrowAttempts: 2,
    turnovers: 2,
    offensiveRebounds: 1,
    opponentDefensiveRebounds: 1,
  });
  assert.equal(derived.coverage.status, 'complete');
  assert.equal(derived.coverage.resolvedRelevantEventShare, 1);
  assert.deepEqual(derived.offensiveEventExtras, {
    freeThrowsMade: 1,
    assists: 2,
    foulsDrawn: 1,
    fieldGoalDistanceTotal: 30,
    fieldGoalDistanceObserved: 2,
    atRimAttempts: 0,
    atRimMakes: 0,
    shortMidRangeAttempts: 1,
    shortMidRangeMakes: 1,
    longMidRangeAttempts: 0,
    longMidRangeMakes: 0,
    secondChancePossessions: 0,
    secondChancePoints: 0,
    pointsOffTurnoverPossessions: 0,
    pointsOffTurnovers: 0,
  });
  assert.deepEqual(derived.defensiveEventExtras, {
    freeThrowsMade: 1,
    assists: 2,
    steals: 1,
    blocks: 1,
    personalFouls: 1,
    fieldGoalDistanceTotal: 30,
    fieldGoalDistanceObserved: 2,
    atRimAttempts: 0,
    atRimMakes: 0,
    shortMidRangeAttempts: 1,
    shortMidRangeMakes: 1,
    longMidRangeAttempts: 0,
    longMidRangeMakes: 0,
    secondChancePossessions: 0,
    secondChancePoints: 0,
    pointsOffTurnoverPossessions: 0,
    pointsOffTurnovers: 0,
  });

  const factors = calculateFourFactors(derived);
  assert.equal(factors.effectiveFieldGoalPercentage, 0.625);
  assert.equal(factors.turnoverRate, 0.2907);
  assert.equal(factors.offensiveReboundPercentage, 0.5);
  assert.equal(factors.freeThrowAttemptRate, 0.5);
  assert.deepEqual(factors.formulas, FOUR_FACTOR_FORMULAS);
  assert.deepEqual(deriveFourFactorsFromEvents(events, { offenseTeamId: HOME, defenseTeamId: AWAY }), factors);
});

test('four-factor coverage exposes missing structure, attribution, shot value, duplicates, and rescinded events', () => {
  const events = [
    event('missing-stat', 'twopointmade'),
    event('missing-team', 'turnover', [{ type: 'turnover' }]),
    event('unknown-shot', 'shot', [statistic('fieldgoal', HOME, { made: true })]),
    event('unknown-rebound', 'rebound', [statistic('rebound', HOME)]),
    event('duplicate', 'turnover', [statistic('turnover', HOME)]),
    event('duplicate', 'turnover', [statistic('turnover', HOME)]),
    event('rescinded', 'turnover', [statistic('turnover', HOME)], { isRescinded: true }),
  ];
  const result = deriveFourFactorCounts(events, { offenseTeamId: HOME, defenseTeamId: AWAY });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.missingStructuredStatisticEvents, 1);
  assert.equal(result.coverage.missingTeamAttributionEvents, 1);
  assert.equal(result.coverage.missingShotValueEvents, 1);
  assert.equal(result.coverage.unclassifiedReboundEvents, 1);
  assert.equal(result.coverage.duplicateEventIds, 1);
  assert.equal(result.coverage.skippedRescindedEvents, 1);
  assert.equal(result.counts.turnovers, 1);
});

test('four-factor coverage fails closed for foreign attribution and unknown free-throw result', () => {
  const result = deriveFourFactorCounts([
    event('foreign-fg', 'twopointmade', [statistic('fieldgoal', 'third-team', { made: true, points: 2 })]),
    event('unknown-ft', 'freethrow', [statistic('freethrow', HOME)]),
  ], { offenseTeamId: HOME, defenseTeamId: AWAY });
  assert.equal(result.coverage.status, 'partial');
  assert.equal(result.coverage.foreignTeamAttributionEvents, 1);
  assert.equal(result.coverage.missingMadeStatusEvents, 1);
  assert.equal(result.coverage.unresolvedEventCount, 2);
  assert.equal(result.counts.fieldGoalAttempts, 0);
  assert.equal(result.counts.freeThrowAttempts, 1);
});

test('extracts the correct post-state possession event slice and includes inferred period-opening shots', () => {
  const record = {
    events: [
      event('start-marker', 'turnover', [statistic('turnover', AWAY)]),
      event('shot', 'twopointmiss', [statistic('fieldgoal', HOME, { made: false, points: 2 })]),
      event('terminal', 'rebound', [statistic('rebound', AWAY, { rebound_type: 'defensive' })]),
    ],
  };
  const provider = eventStatsForPossession(record, {
    startEventId: 'start-marker',
    terminalEventId: 'terminal',
    possessionSource: 'provider_post_event_state',
    offenseProviderTeamId: HOME,
    defenseProviderTeamId: AWAY,
  });
  assert.equal(provider.eventSlice.eventCount, 2);
  assert.equal(provider.counts.fieldGoalAttempts, 1);
  assert.equal(provider.counts.turnovers, 0);
  assert.equal(provider.counts.opponentDefensiveRebounds, 1);

  const inferred = eventStatsForPossession({
    events: [event('opening-make', 'threepointmade', [statistic('fieldgoal', HOME, { made: true, points: 3 })])],
  }, {
    startEventId: 'opening-make',
    terminalEventId: 'opening-make',
    possessionSource: 'inferred_period_opening_made_field_goal',
    offenseProviderTeamId: HOME,
    defenseProviderTeamId: AWAY,
  });
  assert.equal(inferred.eventSlice.eventCount, 1);
  assert.equal(inferred.counts.threePointersMade, 1);
});

test('labels second-chance and turnover-response evidence without inferring it from missing events', () => {
  const record = {
    events: [
      event('turnover', 'turnover', [statistic('turnover', AWAY)]),
      event('miss', 'twopointmiss', [statistic('fieldgoal', HOME, { made: false, points: 2 })]),
      event('orb', 'rebound', [statistic('rebound', HOME, { rebound_type: 'offensive' })]),
      event('make', 'twopointmade', [statistic('fieldgoal', HOME, { made: true, points: 2 })]),
    ],
  };
  const result = eventStatsForPossession(record, {
    startEventId: 'turnover',
    terminalEventId: 'make',
    possessionSource: 'provider_post_event_state',
    offenseProviderTeamId: HOME,
    defenseProviderTeamId: AWAY,
  });
  assert.equal(result.tactics.hasStructuredOffensiveRebound, true);
  assert.equal(result.tactics.startsAfterStructuredOpponentTurnover, true);
});

test('lineup projection adjusts observed context before shrinking synergy and preserves a neutral unseen baseline', () => {
  const projected = lineupProjection({
    players: [1, 1, 1, 1, 1],
    observedNetRating: 13,
    observedPossessions: 400,
    averageOpponentLineupRapmPer100: 2,
    homeCourtExposureAdjustmentPer100: 1,
    synergyPriorPossessions: 400,
  });
  assert.equal(projected.rapmSumPer100, 5);
  assert.equal(projected.expectedObservedNetRatingPer100, 4);
  assert.equal(projected.rawObservedSynergyPer100, 9);
  assert.equal(projected.synergyWeight, 0.5);
  assert.equal(projected.shrunkSynergyPer100, 4.5);
  assert.equal(projected.projectedNetRatingPer100, 9.5);
  assert.equal(projected.projectedObservedContextNetRatingPer100, 8.5);
  assert.equal(projected.contextAdjustmentStatus, 'supplied_context_adjustments');

  const unseen = projectLineupFromRapm({ players: [1, 2, 3, 4, 5] });
  assert.equal(unseen.projectedNetRatingPer100, 15);
  assert.equal(unseen.rawObservedSynergyPer100, null);
  assert.equal(unseen.synergyWeight, 0);
  assert.equal(unseen.contextAdjustmentStatus, 'defaults_used_for_missing_context_adjustments');

  const offenseDefenseRows = projectLineupFromRapm({
    players: Array.from({ length: 5 }, () => ({ combinedRapmPer100: 1.5 })),
  });
  assert.equal(offenseDefenseRows.rapmSumPer100, 7.5);

  assert.equal(projectLineupFromRapm({ players: [1, 2] }).status, 'unavailable');
  assert.throws(
    () => projectLineupFromRapm({ players: [1, 1, 1, 1, 1], synergyPriorPossessions: 0 }),
    /greater than zero/,
  );
});
