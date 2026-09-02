const VALID_PHASES = new Set([
  'preseason',
  'regular',
  'in_season_tournament',
  'play_in',
  'playoffs',
]);

const SCORE_STATES = new Set([
  'tied',
  'ahead_1_5',
  'ahead_6_10',
  'ahead_11_15',
  'ahead_16_plus',
  'trailing_1_5',
  'trailing_6_10',
  'trailing_11_15',
  'trailing_16_plus',
]);

export const SCOUT_METRICS_VERSION = 'nba-scout-metrics-v4';

export const DEFAULT_SAMPLE_RELIABILITY = Object.freeze({
  publishablePossessions: 50,
  mediumPossessions: 200,
  highPossessions: 500,
  priorPossessions: 200,
});

export const FOUR_FACTOR_FORMULAS = Object.freeze({
  effectiveFieldGoalPercentage: '(FGM + 0.5 * 3PM) / FGA',
  turnoverRate: 'TOV / (FGA + 0.44 * FTA + TOV)',
  offensiveReboundPercentage: 'ORB / (ORB + opponent DRB)',
  freeThrowAttemptRate: 'FTA / FGA',
});

export const EXTENDED_SCOUT_METRIC_FORMULAS = Object.freeze({
  trueShootingPercentage: 'points / (2 * (FGA + 0.44 * FTA))',
  threePointAttemptRate: '3PA / FGA',
  assistedFieldGoalRate: 'assists / FGM',
  assistToTurnoverRatio: 'assists / turnovers',
  stealsPer100DefensivePossessions: '100 * steals / defensive possessions',
  blocksPer100DefensivePossessions: '100 * blocks / defensive possessions',
  blockRate: 'blocks / opponent FGA',
  stealForcedTurnoverRate: 'steals / opponent turnovers',
  pacePer48Minutes: '48 * team possessions / team minutes, where team possessions = (offensive + defensive possessions) / 2',
  secondChancePossessionRate: 'offensive possessions containing a structured offensive rebound / offensive possessions',
  secondChancePointsPer100Possessions: '100 * points on offensive possessions containing a structured offensive rebound / offensive possessions',
  pointsOffTurnoverPer100Possessions: '100 * points on possessions whose opening event is a structured opponent turnover / offensive possessions',
});

export const GARBAGE_TIME_PROXY_DEFINITION = Object.freeze({
  version: 'score_time_garbage_proxy_v1',
  caveat: 'A conservative score-and-clock proxy; it is not a provider or win-probability garbage-time label.',
  rules: Object.freeze([
    'fourth quarter, six minutes or less, absolute margin at least 20',
    'fourth quarter, three minutes or less, absolute margin at least 15',
    'overtime, two minutes or less, absolute margin at least 10',
  ]),
});

export const LEVERAGE_PROXY_DEFINITION = Object.freeze({
  version: 'score_time_leverage_proxy_v1',
  caveat: 'A score-and-clock bucket, not an empirical win-probability leverage index.',
});

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : null;
}

function integerOrNull(value) {
  const number = finiteNumber(value);
  return number !== null && Number.isInteger(number) ? number : null;
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function normalizedToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizedId(value) {
  return String(value ?? '').trim();
}

function periodFor(possession) {
  return integerOrNull(possession?.periodNumber ?? possession?.periodSequence);
}

function clockFor(possession) {
  return nonNegativeNumber(possession?.clockRemainingMs ?? possession?.clock_remaining_ms);
}

function marginFor(possession) {
  const home = finiteNumber(possession?.homePointsBefore ?? possession?.home_points_before);
  const away = finiteNumber(possession?.awayPointsBefore ?? possession?.away_points_before);
  return home === null || away === null ? null : home - away;
}

export function normalizeSeasonPhase(value) {
  const normalized = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return VALID_PHASES.has(normalized) ? normalized : 'unclassified';
}

export function scoreStateForTeam(homeState, side = 'home') {
  const state = String(homeState ?? '').trim().toLowerCase();
  if (!SCORE_STATES.has(state)) return 'unclassified';
  if (side === 'home') return state;
  if (side !== 'away') return 'unclassified';
  if (state === 'tied') return state;
  if (state.startsWith('ahead_')) return state.replace('ahead_', 'trailing_');
  return state.replace('trailing_', 'ahead_');
}

function clutchFromPossession(possession) {
  if (typeof possession?.isClutchV1 === 'boolean') return possession.isClutchV1;
  const period = periodFor(possession);
  const clockRemainingMs = clockFor(possession);
  const margin = marginFor(possession);
  if (period === null || clockRemainingMs === null || margin === null) return null;
  return period >= 4
    && clockRemainingMs <= 300_000
    && Math.abs(margin) <= 5;
}

function rollingMembershipValue(memberships, window) {
  if (memberships instanceof Set) {
    return memberships.has(window) || memberships.has(`last${window}`) || memberships.has(`last_${window}`);
  }
  if (Array.isArray(memberships)) {
    const values = new Set(memberships.map((value) => normalizedToken(value)));
    return values.has(`last${window}`) || values.has(String(window));
  }
  if (!memberships || typeof memberships !== 'object') return false;
  return memberships[`last${window}`] === true
    || memberships[`last_${window}`] === true
    || memberships[window] === true;
}

export function suppliedRollingWindowContexts(memberships) {
  return [5, 10, 20]
    .filter((window) => rollingMembershipValue(memberships, window))
    .map((window) => `last_${window}`);
}

export function classifyGarbageTimeProxy(possession = {}) {
  const period = periodFor(possession);
  const clockRemainingMs = clockFor(possession);
  const margin = marginFor(possession);
  if (period === null || clockRemainingMs === null || margin === null) {
    return {
      context: 'unclassified',
      isGarbageTimeProxy: null,
      reason: 'missing_period_clock_or_score',
      ...GARBAGE_TIME_PROXY_DEFINITION,
    };
  }

  const absoluteMargin = Math.abs(margin);
  let reason = null;
  if (period === 4 && clockRemainingMs <= 180_000 && absoluteMargin >= 15) {
    reason = 'fourth_quarter_final_3_minutes_margin_15_plus';
  } else if (period === 4 && clockRemainingMs <= 360_000 && absoluteMargin >= 20) {
    reason = 'fourth_quarter_final_6_minutes_margin_20_plus';
  } else if (period >= 5 && clockRemainingMs <= 120_000 && absoluteMargin >= 10) {
    reason = 'overtime_final_2_minutes_margin_10_plus';
  }
  return {
    context: reason ? 'garbage_time_proxy_v1' : 'competitive_proxy_v1',
    isGarbageTimeProxy: Boolean(reason),
    reason: reason ?? 'outside_conservative_garbage_time_proxy_rules',
    ...GARBAGE_TIME_PROXY_DEFINITION,
  };
}

export function classifyLeverageProxy(possession = {}, garbageTime = classifyGarbageTimeProxy(possession)) {
  const period = periodFor(possession);
  const clockRemainingMs = clockFor(possession);
  const margin = marginFor(possession);
  if (period === null || clockRemainingMs === null || margin === null) {
    return { bucket: 'unclassified', reason: 'missing_period_clock_or_score', ...LEVERAGE_PROXY_DEFINITION };
  }
  if (garbageTime?.isGarbageTimeProxy === true) {
    return { bucket: 'low', reason: 'garbage_time_proxy_v1', ...LEVERAGE_PROXY_DEFINITION };
  }
  if (clutchFromPossession(possession)) {
    return { bucket: 'high', reason: 'clutch_v1', ...LEVERAGE_PROXY_DEFINITION };
  }
  if (period >= 4 && clockRemainingMs <= 480_000 && Math.abs(margin) <= 10) {
    return { bucket: 'medium', reason: 'fourth_quarter_or_overtime_final_8_minutes_margin_10_or_less', ...LEVERAGE_PROXY_DEFINITION };
  }
  return { bucket: 'standard', reason: 'outside_late_close_or_garbage_proxy_rules', ...LEVERAGE_PROXY_DEFINITION };
}

function transitionContext(possession) {
  const value = String(possession?.transitionContext ?? '').trim().toLowerCase();
  if (value === 'provider_fastbreak_v1' || value === 'non_provider_fastbreak') return value;
  return 'unclassified';
}

function periodSplitContext(possession) {
  const period = periodFor(possession);
  if (period === 1) return 'q1';
  if (period === 2) return 'q2';
  if (period === 3) return 'q3';
  if (period === 4) return 'q4';
  if (period !== null && period >= 5) return 'overtime';
  return 'unclassified';
}

function halfSplitContext(periodContext) {
  if (periodContext === 'q1' || periodContext === 'q2') return 'first_half';
  if (periodContext === 'q3' || periodContext === 'q4') return 'second_half';
  if (periodContext === 'overtime') return 'overtime';
  return 'unclassified';
}

export function classifyScoutPossessionContext({
  possession = {},
  side = 'home',
  phase,
  rollingWindowMemberships,
} = {}) {
  const normalizedPhase = normalizeSeasonPhase(phase);
  const venue = side === 'home' || side === 'away' ? side : 'unclassified';
  const rollingWindows = suppliedRollingWindowContexts(rollingWindowMemberships);
  const period = periodSplitContext(possession);
  const half = halfSplitContext(period);
  const clutch = clutchFromPossession(possession);
  const transition = transitionContext(possession);
  const scoreState = scoreStateForTeam(possession.homeScoreStateV1, side);
  const competitive = classifyGarbageTimeProxy(possession);
  const leverage = classifyLeverageProxy(possession, competitive);
  const contexts = [
    'all',
    `phase:${normalizedPhase}`,
    `venue:${venue}`,
    `period:${period}`,
    `half:${half}`,
    ...rollingWindows.map((window) => `window:${window}`),
    clutch === true ? 'clutch_v1' : clutch === false ? 'non_clutch_v1' : 'clutch:unclassified',
    `transition:${transition}`,
    `score_state:${scoreState}`,
    `competition:${competitive.context}`,
    `leverage:${leverage.bucket}`,
  ];
  return {
    phase: normalizedPhase,
    venue,
    period,
    half,
    rollingWindows,
    clutch,
    transition,
    transitionCaveat: transition === 'non_provider_fastbreak'
      ? 'No provider fast-break qualifier was present; this is not a verified half-court label.'
      : null,
    scoreState,
    competitive,
    leverage,
    contexts,
  };
}

export function calculateSampleReliability(possessions, options = {}) {
  const configuration = { ...DEFAULT_SAMPLE_RELIABILITY, ...options };
  const sampleSize = nonNegativeNumber(possessions) ?? 0;
  const publishable = nonNegativeNumber(configuration.publishablePossessions) ?? DEFAULT_SAMPLE_RELIABILITY.publishablePossessions;
  const medium = nonNegativeNumber(configuration.mediumPossessions) ?? DEFAULT_SAMPLE_RELIABILITY.mediumPossessions;
  const high = nonNegativeNumber(configuration.highPossessions) ?? DEFAULT_SAMPLE_RELIABILITY.highPossessions;
  const prior = nonNegativeNumber(configuration.priorPossessions) ?? DEFAULT_SAMPLE_RELIABILITY.priorPossessions;
  let grade = 'no_sample';
  if (sampleSize >= high) grade = 'high';
  else if (sampleSize >= medium) grade = 'medium';
  else if (sampleSize >= publishable) grade = 'low';
  else if (sampleSize > 0) grade = 'insufficient';
  return {
    possessions: sampleSize,
    grade,
    publishable: sampleSize >= publishable,
    reliabilityScore: round(sampleSize + prior > 0 ? sampleSize / (sampleSize + prior) : 0, 4),
    thresholds: { publishablePossessions: publishable, mediumPossessions: medium, highPossessions: high },
    method: 'possession_count_shrinkage_readiness_v1',
  };
}

function sampleVariance(sum, sumSquares, count) {
  if (count < 2 || !Number.isFinite(sum) || !Number.isFinite(sumSquares)) return null;
  return Math.max(0, (sumSquares - ((sum * sum) / count)) / (count - 1));
}

function interval(estimate, standardError, digits) {
  if (!Number.isFinite(estimate) || !Number.isFinite(standardError)) return null;
  const margin = 1.96 * standardError;
  return {
    estimate: round(estimate, digits),
    standardError: round(standardError, digits),
    lower: round(estimate - margin, digits),
    upper: round(estimate + margin, digits),
  };
}

function emptyOffensiveEventExtras() {
  return {
    freeThrowsMade: 0,
    assists: 0,
    foulsDrawn: 0,
    fieldGoalDistanceTotal: 0,
    fieldGoalDistanceObserved: 0,
    atRimAttempts: 0,
    atRimMakes: 0,
    shortMidRangeAttempts: 0,
    shortMidRangeMakes: 0,
    longMidRangeAttempts: 0,
    longMidRangeMakes: 0,
    secondChancePossessions: 0,
    secondChancePoints: 0,
    pointsOffTurnoverPossessions: 0,
    pointsOffTurnovers: 0,
  };
}

function emptyDefensiveEventExtras() {
  return {
    freeThrowsMade: 0,
    assists: 0,
    steals: 0,
    blocks: 0,
    personalFouls: 0,
    fieldGoalDistanceTotal: 0,
    fieldGoalDistanceObserved: 0,
    atRimAttempts: 0,
    atRimMakes: 0,
    shortMidRangeAttempts: 0,
    shortMidRangeMakes: 0,
    longMidRangeAttempts: 0,
    longMidRangeMakes: 0,
    secondChancePossessions: 0,
    secondChancePoints: 0,
    pointsOffTurnoverPossessions: 0,
    pointsOffTurnovers: 0,
  };
}

function shotZoneProfile(extras) {
  const makeZone = (attemptKey, makeKey) => {
    const attempts = nonNegativeNumber(extras?.[attemptKey]) ?? 0;
    const makes = nonNegativeNumber(extras?.[makeKey]) ?? 0;
    return { attempts, makes, percentage: ratio(makes, attempts, 4) };
  };
  return {
    definition: 'Distance bands for two-point attempts only: at rim 0-4 feet, short mid-range 5-14 feet, long mid-range 15+ feet. Three-point attempts are reported separately.',
    atRim: makeZone('atRimAttempts', 'atRimMakes'),
    shortMidRange: makeZone('shortMidRangeAttempts', 'shortMidRangeMakes'),
    longMidRange: makeZone('longMidRangeAttempts', 'longMidRangeMakes'),
  };
}

function emptyPossessionOutcomes() {
  return { empty: 0, one: 0, two: 0, three: 0, fourPlus: 0 };
}

function addCountFields(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(target)) {
    target[key] = (nonNegativeNumber(target[key]) ?? 0) + (nonNegativeNumber(source[key]) ?? 0);
  }
}

function addPossessionOutcome(target, points) {
  const value = nonNegativeNumber(points) ?? 0;
  if (value === 0) target.empty += 1;
  else if (value === 1) target.one += 1;
  else if (value === 2) target.two += 1;
  else if (value === 3) target.three += 1;
  else target.fourPlus += 1;
}

function outcomeProfile(outcomes, possessions, points, digits) {
  const total = nonNegativeNumber(possessions) ?? 0;
  const counts = Object.fromEntries(Object.entries(emptyPossessionOutcomes()).map(([key]) => [key, nonNegativeNumber(outcomes?.[key]) ?? 0]));
  const accountedPossessions = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const scoringPossessions = total - counts.empty;
  return {
    ...counts,
    totalPossessions: total,
    accountedPossessions,
    scoringPossessions,
    scoringPossessionRate: ratio(scoringPossessions, total, digits),
    pointsPerPossession: ratio(nonNegativeNumber(points) ?? 0, total, digits),
  };
}

function shootingProfile(counts, extras, points, digits) {
  const fieldGoalAttempts = nonNegativeNumber(counts?.fieldGoalAttempts) ?? 0;
  const fieldGoalsMade = nonNegativeNumber(counts?.fieldGoalsMade) ?? 0;
  const threePointAttempts = nonNegativeNumber(counts?.threePointAttempts) ?? 0;
  const threePointersMade = nonNegativeNumber(counts?.threePointersMade) ?? 0;
  const freeThrowAttempts = nonNegativeNumber(counts?.freeThrowAttempts) ?? 0;
  const freeThrowsMade = nonNegativeNumber(extras?.freeThrowsMade) ?? 0;
  const twoPointAttempts = Math.max(0, fieldGoalAttempts - threePointAttempts);
  const twoPointMakes = Math.max(0, fieldGoalsMade - threePointersMade);
  const trueShootingDenominator = 2 * (fieldGoalAttempts + (0.44 * freeThrowAttempts));
  const distanceObserved = nonNegativeNumber(extras?.fieldGoalDistanceObserved) ?? 0;
  return {
    fieldGoalAttempts,
    fieldGoalsMade,
    twoPointAttempts,
    twoPointMakes,
    threePointAttempts,
    threePointersMade,
    freeThrowAttempts,
    freeThrowsMade,
    twoPointPercentage: ratio(twoPointMakes, twoPointAttempts, 4),
    threePointPercentage: ratio(threePointersMade, threePointAttempts, 4),
    freeThrowPercentage: ratio(freeThrowsMade, freeThrowAttempts, 4),
    threePointAttemptRate: ratio(threePointAttempts, fieldGoalAttempts, 4),
    trueShootingPercentage: ratio(nonNegativeNumber(points) ?? 0, trueShootingDenominator, 4),
    averageFieldGoalDistance: distanceObserved > 0
      ? round((nonNegativeNumber(extras?.fieldGoalDistanceTotal) ?? 0) / distanceObserved, digits)
      : null,
    fieldGoalDistanceObserved: distanceObserved,
    shotZones: shotZoneProfile(extras),
  };
}

function offensivePlaymakingProfile(extras, counts, possessions, digits) {
  const assists = nonNegativeNumber(extras?.assists) ?? 0;
  const foulsDrawn = nonNegativeNumber(extras?.foulsDrawn) ?? 0;
  const turnovers = nonNegativeNumber(counts?.turnovers) ?? 0;
  const fieldGoalsMade = nonNegativeNumber(counts?.fieldGoalsMade) ?? 0;
  const totalPossessions = nonNegativeNumber(possessions) ?? 0;
  const secondChancePossessions = nonNegativeNumber(extras?.secondChancePossessions) ?? 0;
  const secondChancePoints = nonNegativeNumber(extras?.secondChancePoints) ?? 0;
  const pointsOffTurnoverPossessions = nonNegativeNumber(extras?.pointsOffTurnoverPossessions) ?? 0;
  const pointsOffTurnovers = nonNegativeNumber(extras?.pointsOffTurnovers) ?? 0;
  return {
    assists,
    foulsDrawn,
    assistsPer100Possessions: totalPossessions > 0 ? round(100 * assists / totalPossessions, digits) : null,
    foulsDrawnPer100Possessions: totalPossessions > 0 ? round(100 * foulsDrawn / totalPossessions, digits) : null,
    assistedFieldGoalRate: ratio(assists, fieldGoalsMade, 4),
    assistToTurnoverRatio: ratio(assists, turnovers, 4),
    possessionExtensions: {
      secondChancePossessions,
      secondChancePoints,
      secondChancePossessionRate: ratio(secondChancePossessions, totalPossessions, 4),
      secondChancePointsPer100Possessions: totalPossessions > 0 ? round(100 * secondChancePoints / totalPossessions, digits) : null,
      pointsPerSecondChancePossession: ratio(secondChancePoints, secondChancePossessions, digits),
      pointsOffTurnoverPossessions,
      pointsOffTurnovers,
      pointsOffTurnoverPossessionRate: ratio(pointsOffTurnoverPossessions, totalPossessions, 4),
      pointsOffTurnoverPer100Possessions: totalPossessions > 0 ? round(100 * pointsOffTurnovers / totalPossessions, digits) : null,
      pointsPerPossessionAfterTurnover: ratio(pointsOffTurnovers, pointsOffTurnoverPossessions, digits),
      caveat: 'Second-chance status comes from a structured offensive rebound in the possession event slice. Turnover response is only assigned when the possession opening event contains a structured opponent turnover.',
    },
  };
}

function defensiveDisruptionProfile(extras, counts, possessions, digits) {
  const steals = nonNegativeNumber(extras?.steals) ?? 0;
  const blocks = nonNegativeNumber(extras?.blocks) ?? 0;
  const personalFouls = nonNegativeNumber(extras?.personalFouls) ?? 0;
  const totalPossessions = nonNegativeNumber(possessions) ?? 0;
  const opponentFieldGoalAttempts = nonNegativeNumber(counts?.fieldGoalAttempts) ?? 0;
  return {
    steals,
    blocks,
    personalFouls,
    stealsPer100DefensivePossessions: totalPossessions > 0 ? round(100 * steals / totalPossessions, digits) : null,
    blocksPer100DefensivePossessions: totalPossessions > 0 ? round(100 * blocks / totalPossessions, digits) : null,
    personalFoulsPer100DefensivePossessions: totalPossessions > 0 ? round(100 * personalFouls / totalPossessions, digits) : null,
    blockRate: ratio(blocks, opponentFieldGoalAttempts, 4),
    stealForcedTurnoverRate: ratio(steals, nonNegativeNumber(counts?.turnovers) ?? 0, 4),
  };
}

export function calculateAggregateMetrics(aggregate = {}, { digits = 3, reliability = {} } = {}) {
  const offensivePossessions = nonNegativeNumber(aggregate.offensivePossessions) ?? 0;
  const defensivePossessions = nonNegativeNumber(aggregate.defensivePossessions) ?? 0;
  const pointsFor = finiteNumber(aggregate.pointsFor) ?? 0;
  const pointsAgainst = finiteNumber(aggregate.pointsAgainst) ?? 0;
  const offensivePointsFor = finiteNumber(aggregate.offensivePointsFor) ?? 0;
  const defensivePointsAllowed = finiteNumber(aggregate.defensivePointsAllowed) ?? 0;
  const offensivePointsForSquared = finiteNumber(aggregate.offensivePointsForSquared);
  const defensivePointsAllowedSquared = finiteNumber(aggregate.defensivePointsAllowedSquared);
  const pointDifferentialSquared = finiteNumber(aggregate.pointDifferentialSquared);
  const wins = nonNegativeNumber(aggregate.wins) ?? 0;
  const losses = nonNegativeNumber(aggregate.losses) ?? 0;
  const ties = nonNegativeNumber(aggregate.ties) ?? 0;
  const unclassifiedGameResults = nonNegativeNumber(aggregate.unclassifiedGameResults) ?? 0;
  const totalPossessions = offensivePossessions + defensivePossessions;
  const offensiveRating = offensivePossessions > 0 ? 100 * offensivePointsFor / offensivePossessions : null;
  const defensiveRating = defensivePossessions > 0 ? 100 * defensivePointsAllowed / defensivePossessions : null;
  const netRating = offensiveRating !== null && defensiveRating !== null
    ? offensiveRating - defensiveRating
    : null;
  const plusMinusPer100 = totalPossessions > 0
    ? 200 * (pointsFor - pointsAgainst) / totalPossessions
    : null;

  const offenseVariance = sampleVariance(offensivePointsFor, offensivePointsForSquared, offensivePossessions);
  const defenseVariance = sampleVariance(defensivePointsAllowed, defensivePointsAllowedSquared, defensivePossessions);
  const pointDifferentialVariance = sampleVariance(pointsFor - pointsAgainst, pointDifferentialSquared, totalPossessions);
  const offenseStandardError = offenseVariance === null ? null : 100 * Math.sqrt(offenseVariance / offensivePossessions);
  const defenseStandardError = defenseVariance === null ? null : 100 * Math.sqrt(defenseVariance / defensivePossessions);
  const netStandardError = offenseVariance === null || defenseVariance === null
    ? null
    : 100 * Math.sqrt((offenseVariance / offensivePossessions) + (defenseVariance / defensivePossessions));
  const plusMinusStandardError = pointDifferentialVariance === null || totalPossessions === 0
    ? null
    : 200 * Math.sqrt(pointDifferentialVariance / totalPossessions);

  return {
    games: nonNegativeNumber(aggregate.games) ?? null,
    gameResults: {
      wins,
      losses,
      ties,
      unclassified: unclassifiedGameResults,
      decisions: wins + losses,
      winPercentage: ratio(wins, wins + losses, 4),
      semantics: 'team result in games contributing to this descriptive sample; it is not a causal lineup win-loss record',
    },
    pointsFor,
    pointsAgainst,
    offensivePointsFor,
    defensivePointsAllowed,
    offensivePossessions,
    defensivePossessions,
    totalPossessions,
    offensivePointsForSquared,
    defensivePointsAllowedSquared,
    pointDifferentialSquared,
    offensiveRating: round(offensiveRating, digits),
    defensiveRating: round(defensiveRating, digits),
    netRating: round(netRating, digits),
    plusMinusPer100: round(plusMinusPer100, digits),
    reliability: calculateSampleReliability(totalPossessions, reliability),
    confidence95: {
      method: 'normal_approximation_from_per_possession_point_sample_variance',
      caveat: 'Approximate descriptive intervals; possessions are not assumed to be fully independent for causal inference.',
      offensiveRating: interval(offensiveRating, offenseStandardError, digits),
      defensiveRating: interval(defensiveRating, defenseStandardError, digits),
      netRating: interval(netRating, netStandardError, digits),
      plusMinusPer100: interval(plusMinusPer100, plusMinusStandardError, digits),
    },
    fourFactors: {
      offense: calculateFourFactors({
        counts: aggregate.offensiveFourFactorCounts ?? emptyFourFactorCounts(),
        coverage: aggregate.offensiveFourFactorCoverage ?? null,
      }),
      defense: calculateFourFactors({
        counts: aggregate.defensiveFourFactorCounts ?? emptyFourFactorCounts(),
        coverage: aggregate.defensiveFourFactorCoverage ?? null,
      }),
      defenseConvention: 'Defense values are the opponent offense four factors while this unit defended.',
    },
    shootingProfile: {
      offense: shootingProfile(
        aggregate.offensiveFourFactorCounts,
        aggregate.offensiveEventExtras,
        offensivePointsFor,
        digits
      ),
      defense: shootingProfile(
        aggregate.defensiveFourFactorCounts,
        aggregate.defensiveEventExtras,
        defensivePointsAllowed,
        digits
      ),
      defenseConvention: 'Defense values describe opponent shooting while this unit defended.',
    },
    offensivePlaymaking: offensivePlaymakingProfile(
      aggregate.offensiveEventExtras,
      aggregate.offensiveFourFactorCounts,
      offensivePossessions,
      digits
    ),
    defensiveDisruption: defensiveDisruptionProfile(
      aggregate.defensiveEventExtras,
      aggregate.defensiveFourFactorCounts,
      defensivePossessions,
      digits
    ),
    possessionOutcomes: {
      offense: outcomeProfile(aggregate.offensivePossessionOutcomes, offensivePossessions, offensivePointsFor, digits),
      defense: outcomeProfile(aggregate.defensivePossessionOutcomes, defensivePossessions, defensivePointsAllowed, digits),
      defenseConvention: 'Defense outcome values describe opponent points per possession while this unit defended.',
    },
    extendedMetricFormulas: EXTENDED_SCOUT_METRIC_FORMULAS,
  };
}

/**
 * Creates a possession accumulator.
 *
 * `all_game_ids` is the conservative default: it counts each game once even
 * when rows arrive interleaved.  Large archive replays can instead opt into
 * `contiguous_game_blocks` when they process one complete game at a time.
 * That mode intentionally keeps only the last game id, avoiding a Set for
 * every combination/context accumulator while preserving the same game-count
 * semantics for a contiguous source stream.
 */
export function createScoutAggregate({ gameCountTracking = 'all_game_ids' } = {}) {
  if (!['all_game_ids', 'contiguous_game_blocks'].includes(gameCountTracking)) {
    throw new RangeError('gameCountTracking must be "all_game_ids" or "contiguous_game_blocks".');
  }
  return {
    gameCountTracking,
    games: 0,
    seenGameIds: gameCountTracking === 'all_game_ids' ? new Set() : null,
    lastGameId: null,
    wins: 0,
    losses: 0,
    ties: 0,
    unclassifiedGameResults: 0,
    offensivePossessions: 0,
    defensivePossessions: 0,
    pointsFor: 0,
    pointsAgainst: 0,
    pointsForSquared: 0,
    pointsAgainstSquared: 0,
    pointDifferentialSquared: 0,
    offensivePointsFor: 0,
    defensivePointsAllowed: 0,
    offensivePointsForSquared: 0,
    defensivePointsAllowedSquared: 0,
    offensiveFourFactorCounts: emptyFourFactorCounts(),
    defensiveFourFactorCounts: emptyFourFactorCounts(),
    offensiveFourFactorCoverage: null,
    defensiveFourFactorCoverage: null,
    offensiveEventExtras: emptyOffensiveEventExtras(),
    defensiveEventExtras: emptyDefensiveEventExtras(),
    offensivePossessionOutcomes: emptyPossessionOutcomes(),
    defensivePossessionOutcomes: emptyPossessionOutcomes(),
  };
}

function addFourFactorCounts(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const key of Object.keys(emptyFourFactorCounts())) {
    target[key] = (nonNegativeNumber(target[key]) ?? 0) + (nonNegativeNumber(source[key]) ?? 0);
  }
}

function addCoverage(target, source) {
  if (!source || typeof source !== 'object') return target;
  const result = target && typeof target === 'object' ? target : {
    status: 'unavailable',
    method: source.method ?? 'structured_normalized_event_statistics_v1',
  };
  const countKeys = [
    'inputEventCount',
    'uniqueEventCount',
    'relevantEventCount',
    'countedEventCount',
    'resolvedEventCount',
    'unresolvedEventCount',
    'skippedRescindedEvents',
    'duplicateEventIds',
    'missingStructuredStatisticEvents',
    'missingTeamAttributionEvents',
    'foreignTeamAttributionEvents',
    'unexpectedTeamAttributionEvents',
    'missingMadeStatusEvents',
    'missingShotValueEvents',
    'unclassifiedReboundEvents',
  ];
  for (const key of countKeys) result[key] = (nonNegativeNumber(result[key]) ?? 0) + (nonNegativeNumber(source[key]) ?? 0);
  const relevant = nonNegativeNumber(result.relevantEventCount) ?? 0;
  const resolved = nonNegativeNumber(result.resolvedEventCount) ?? 0;
  const unresolved = nonNegativeNumber(result.unresolvedEventCount) ?? 0;
  result.status = relevant === 0 ? 'unavailable' : unresolved > 0 ? 'partial' : 'complete';
  result.resolvedRelevantEventShare = relevant > 0 ? round(resolved / relevant, 4) : null;
  return result;
}

/**
 * Add one team-perspective possession to a hot-loop accumulator. The explicit
 * accumulator mutation avoids allocating millions of short-lived objects in a
 * full lineup-combination derivation; all classifications and formulas remain
 * deterministic and free of external state.
 */
export function addScoutAggregate(aggregate, row = {}) {
  if (!aggregate || typeof aggregate !== 'object') throw new TypeError('aggregate must be an object.');
  const gameId = normalizedId(row.gameId);
  const useContiguousGameBlocks = aggregate.gameCountTracking === 'contiguous_game_blocks';
  const seenGameIds = useContiguousGameBlocks
    ? null
    : aggregate.seenGameIds instanceof Set
      ? aggregate.seenGameIds
      : new Set(Array.isArray(aggregate.seenGameIds) ? aggregate.seenGameIds.map(normalizedId).filter(Boolean) : []);
  if (!useContiguousGameBlocks) aggregate.seenGameIds = seenGameIds;
  const isFirstRowForGame = gameId && (useContiguousGameBlocks
    ? aggregate.lastGameId !== gameId
    : !seenGameIds.has(gameId));
  if (isFirstRowForGame) {
    if (useContiguousGameBlocks) aggregate.lastGameId = gameId;
    else seenGameIds.add(gameId);
    aggregate.games = (nonNegativeNumber(aggregate.games) ?? 0) + 1;
    const gameResult = String(row.gameResult ?? '').trim().toLowerCase();
    if (gameResult === 'win') aggregate.wins = (nonNegativeNumber(aggregate.wins) ?? 0) + 1;
    else if (gameResult === 'loss') aggregate.losses = (nonNegativeNumber(aggregate.losses) ?? 0) + 1;
    else if (gameResult === 'tie') aggregate.ties = (nonNegativeNumber(aggregate.ties) ?? 0) + 1;
    else aggregate.unclassifiedGameResults = (nonNegativeNumber(aggregate.unclassifiedGameResults) ?? 0) + 1;
  }
  const pointsFor = finiteNumber(row.pointsFor) ?? 0;
  const pointsAgainst = finiteNumber(row.pointsAgainst) ?? 0;
  aggregate.pointsFor = (finiteNumber(aggregate.pointsFor) ?? 0) + pointsFor;
  aggregate.pointsAgainst = (finiteNumber(aggregate.pointsAgainst) ?? 0) + pointsAgainst;
  aggregate.pointsForSquared = (finiteNumber(aggregate.pointsForSquared) ?? 0) + (pointsFor * pointsFor);
  aggregate.pointsAgainstSquared = (finiteNumber(aggregate.pointsAgainstSquared) ?? 0) + (pointsAgainst * pointsAgainst);
  aggregate.pointDifferentialSquared = (finiteNumber(aggregate.pointDifferentialSquared) ?? 0)
    + ((pointsFor - pointsAgainst) ** 2);
  if (row.isOffense === true) {
    aggregate.offensivePossessions = (nonNegativeNumber(aggregate.offensivePossessions) ?? 0) + 1;
    aggregate.offensivePointsFor = (finiteNumber(aggregate.offensivePointsFor) ?? 0) + pointsFor;
    aggregate.offensivePointsForSquared = (finiteNumber(aggregate.offensivePointsForSquared) ?? 0) + (pointsFor * pointsFor);
    addFourFactorCounts(aggregate.offensiveFourFactorCounts, row.fourFactorCounts);
    aggregate.offensiveFourFactorCoverage = addCoverage(aggregate.offensiveFourFactorCoverage, row.fourFactorCoverage);
    addCountFields(aggregate.offensiveEventExtras, row.offensiveEventExtras);
    addPossessionOutcome(aggregate.offensivePossessionOutcomes, pointsFor);
  } else {
    aggregate.defensivePossessions = (nonNegativeNumber(aggregate.defensivePossessions) ?? 0) + 1;
    aggregate.defensivePointsAllowed = (finiteNumber(aggregate.defensivePointsAllowed) ?? 0) + pointsAgainst;
    aggregate.defensivePointsAllowedSquared = (finiteNumber(aggregate.defensivePointsAllowedSquared) ?? 0) + (pointsAgainst * pointsAgainst);
    addFourFactorCounts(aggregate.defensiveFourFactorCounts, row.opponentFourFactorCounts);
    aggregate.defensiveFourFactorCoverage = addCoverage(aggregate.defensiveFourFactorCoverage, row.opponentFourFactorCoverage);
    addCountFields(aggregate.defensiveEventExtras, row.defensiveEventExtras);
    addPossessionOutcome(aggregate.defensivePossessionOutcomes, pointsAgainst);
  }
  return aggregate;
}

export const metricFromAggregate = calculateAggregateMetrics;

function nullSafeDifference(onValue, offValue, digits) {
  const on = finiteNumber(onValue);
  const off = finiteNumber(offValue);
  return on === null || off === null ? null : round(on - off, digits);
}

export function calculateOnOff(onMetrics = {}, offMetrics = {}, { digits = 3 } = {}) {
  const offensiveRatingDifference = nullSafeDifference(onMetrics.offensiveRating, offMetrics.offensiveRating, digits);
  const defensiveRatingDifference = nullSafeDifference(onMetrics.defensiveRating, offMetrics.defensiveRating, digits);
  const netRatingDifference = nullSafeDifference(onMetrics.netRating, offMetrics.netRating, digits);
  const plusMinusPer100Difference = nullSafeDifference(onMetrics.plusMinusPer100, offMetrics.plusMinusPer100, digits);
  return {
    offensiveRatingDifference,
    defensiveRatingDifference,
    netRatingDifference,
    onOffNetRating: netRatingDifference,
    plusMinusPer100Difference,
    status: netRatingDifference === null ? 'insufficient_on_or_off_sample' : 'available',
    convention: 'on_minus_off; a negative defensive-rating difference is better defense',
  };
}

function statisticType(statistic) {
  return normalizedToken(statistic?.type ?? statistic?.stat_type ?? statistic?.statType);
}

function statisticTeamId(statistic) {
  return normalizedId(statistic?.team?.id ?? statistic?.team_id ?? statistic?.teamId);
}

function statisticMade(statistic, eventType) {
  if (typeof statistic?.made === 'boolean') return statistic.made;
  const type = normalizedToken(eventType);
  if (type.includes('made')) return true;
  if (type.includes('miss')) return false;
  return null;
}

function eventTypes(event) {
  const types = new Set((Array.isArray(event?.statistics) ? event.statistics : []).map(statisticType).filter(Boolean));
  const eventType = normalizedToken(event?.eventType ?? event?.event_type ?? event?.type);
  if (eventType.includes('twopoint') || eventType.includes('threepoint')) types.add('fieldgoal_event');
  if (eventType.includes('freethrow')) types.add('freethrow_event');
  if (eventType.includes('turnover') || eventType.includes('offensivefoul')) types.add('turnover_event');
  if (eventType.includes('rebound')) types.add('rebound_event');
  return types;
}

function firstStatistic(event, type) {
  return (Array.isArray(event?.statistics) ? event.statistics : []).find((statistic) => statisticType(statistic) === type) ?? null;
}

function firstStatisticOfTypes(event, types) {
  const accepted = new Set(types);
  return (Array.isArray(event?.statistics) ? event.statistics : [])
    .find((statistic) => accepted.has(statisticType(statistic))) ?? null;
}

function emptyFourFactorCounts() {
  return {
    fieldGoalAttempts: 0,
    fieldGoalsMade: 0,
    threePointAttempts: 0,
    threePointersMade: 0,
    freeThrowAttempts: 0,
    turnovers: 0,
    offensiveRebounds: 0,
    opponentDefensiveRebounds: 0,
  };
}

export function deriveFourFactorCounts(events, { offenseTeamId, defenseTeamId } = {}) {
  const offense = normalizedId(offenseTeamId);
  const defense = normalizedId(defenseTeamId);
  if (!offense || !defense || offense === defense) {
    throw new TypeError('Distinct offenseTeamId and defenseTeamId values are required.');
  }
  const rows = Array.isArray(events) ? events : [];
  const counts = emptyFourFactorCounts();
  const offensiveEventExtras = emptyOffensiveEventExtras();
  const defensiveEventExtras = emptyDefensiveEventExtras();
  const relevantIds = new Set();
  const countedIds = new Set();
  const unresolvedIds = new Set();
  const seenIds = new Set();
  let skippedRescindedEvents = 0;
  let duplicateEventIds = 0;
  let missingStructuredStatisticEvents = 0;
  let missingTeamAttributionEvents = 0;
  let foreignTeamAttributionEvents = 0;
  let unexpectedTeamAttributionEvents = 0;
  let missingMadeStatusEvents = 0;
  let missingShotValueEvents = 0;
  let unclassifiedReboundEvents = 0;

  rows.forEach((event, index) => {
    if (event?.isRescinded === true) {
      skippedRescindedEvents += 1;
      return;
    }
    const eventId = normalizedId(event?.id) || `index:${index}`;
    if (seenIds.has(eventId)) {
      duplicateEventIds += 1;
      return;
    }
    seenIds.add(eventId);
    for (const statistic of Array.isArray(event?.statistics) ? event.statistics : []) {
      const type = statisticType(statistic);
      const teamId = statisticTeamId(statistic);
      if (type === 'assist' && teamId === offense) {
        offensiveEventExtras.assists += 1;
        defensiveEventExtras.assists += 1;
      } else if (type === 'fouldrawn' && teamId === offense) {
        offensiveEventExtras.foulsDrawn += 1;
      } else if (type === 'personalfoul' && teamId === defense) {
        defensiveEventExtras.personalFouls += 1;
      } else if (type === 'steal' && teamId === defense) {
        defensiveEventExtras.steals += 1;
      } else if (type === 'block' && teamId === defense) {
        defensiveEventExtras.blocks += 1;
      }
    }
    const types = eventTypes(event);
    const isRelevant = [...types].some((type) => ['fieldgoal', 'fieldgoal_event', 'freethrow', 'freethrow_event', 'turnover', 'turnover_event', 'rebound', 'rebound_event'].includes(type));
    if (!isRelevant) return;
    relevantIds.add(eventId);

    const eventType = normalizedToken(event?.eventType ?? event?.event_type ?? event?.type);
    const fieldGoal = firstStatistic(event, 'fieldgoal');
    if (types.has('fieldgoal_event') || fieldGoal) {
      if (!fieldGoal) {
        missingStructuredStatisticEvents += 1;
        unresolvedIds.add(eventId);
      } else if (!statisticTeamId(fieldGoal)) {
        missingTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else if (statisticTeamId(fieldGoal) !== offense) {
        if (statisticTeamId(fieldGoal) === defense) unexpectedTeamAttributionEvents += 1;
        else foreignTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else {
        counts.fieldGoalAttempts += 1;
        countedIds.add(eventId);
        const made = statisticMade(fieldGoal, eventType);
        if (made === true) counts.fieldGoalsMade += 1;
        else if (made === null) {
          missingMadeStatusEvents += 1;
          unresolvedIds.add(eventId);
        }
        const statisticPoints = finiteNumber(fieldGoal.points);
        const isThree = eventType.includes('threepoint') || statisticPoints === 3;
        const isTwo = eventType.includes('twopoint') || statisticPoints === 2;
        if (isThree) {
          counts.threePointAttempts += 1;
          if (made === true) counts.threePointersMade += 1;
        } else if (!isTwo) {
          missingShotValueEvents += 1;
          unresolvedIds.add(eventId);
        }
        const shotDistance = nonNegativeNumber(fieldGoal.shot_distance ?? fieldGoal.shotDistance);
        if (shotDistance !== null) {
          offensiveEventExtras.fieldGoalDistanceTotal += shotDistance;
          offensiveEventExtras.fieldGoalDistanceObserved += 1;
          defensiveEventExtras.fieldGoalDistanceTotal += shotDistance;
          defensiveEventExtras.fieldGoalDistanceObserved += 1;
          if (!isThree && isTwo) {
            let attemptsKey;
            let makesKey;
            if (shotDistance <= 4) {
              attemptsKey = 'atRimAttempts';
              makesKey = 'atRimMakes';
            } else if (shotDistance <= 14) {
              attemptsKey = 'shortMidRangeAttempts';
              makesKey = 'shortMidRangeMakes';
            } else {
              attemptsKey = 'longMidRangeAttempts';
              makesKey = 'longMidRangeMakes';
            }
            offensiveEventExtras[attemptsKey] += 1;
            defensiveEventExtras[attemptsKey] += 1;
            if (made === true) {
              offensiveEventExtras[makesKey] += 1;
              defensiveEventExtras[makesKey] += 1;
            }
          }
        }
      }
    }

    const freeThrow = firstStatistic(event, 'freethrow');
    if (types.has('freethrow_event') || freeThrow) {
      if (!freeThrow) {
        missingStructuredStatisticEvents += 1;
        unresolvedIds.add(eventId);
      } else if (!statisticTeamId(freeThrow)) {
        missingTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else if (statisticTeamId(freeThrow) !== offense) {
        if (statisticTeamId(freeThrow) === defense) unexpectedTeamAttributionEvents += 1;
        else foreignTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else {
        counts.freeThrowAttempts += 1;
        countedIds.add(eventId);
        const made = statisticMade(freeThrow, eventType);
        if (made === null) {
          missingMadeStatusEvents += 1;
          unresolvedIds.add(eventId);
        } else if (made === true) {
          offensiveEventExtras.freeThrowsMade += 1;
          defensiveEventExtras.freeThrowsMade += 1;
        }
      }
    }

    const turnover = firstStatisticOfTypes(event, ['turnover', 'offensivefoul']);
    if (types.has('turnover_event') || turnover) {
      if (!turnover) {
        missingStructuredStatisticEvents += 1;
        unresolvedIds.add(eventId);
      } else if (!statisticTeamId(turnover)) {
        missingTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else if (statisticTeamId(turnover) !== offense) {
        if (statisticTeamId(turnover) === defense) unexpectedTeamAttributionEvents += 1;
        else foreignTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else {
        counts.turnovers += 1;
        countedIds.add(eventId);
      }
    }

    const rebound = firstStatistic(event, 'rebound');
    if (types.has('rebound_event') || rebound) {
      if (!rebound) {
        missingStructuredStatisticEvents += 1;
        unresolvedIds.add(eventId);
      } else if (!statisticTeamId(rebound)) {
        missingTeamAttributionEvents += 1;
        unresolvedIds.add(eventId);
      } else {
        const reboundType = normalizedToken(rebound.rebound_type ?? rebound.reboundType);
        const reboundTeamId = statisticTeamId(rebound);
        if (reboundTeamId !== offense && reboundTeamId !== defense) {
          foreignTeamAttributionEvents += 1;
          unresolvedIds.add(eventId);
        } else if (reboundType === 'offensive') {
          if (reboundTeamId === offense) {
            counts.offensiveRebounds += 1;
            countedIds.add(eventId);
          } else {
            unexpectedTeamAttributionEvents += 1;
            unresolvedIds.add(eventId);
          }
        } else if (reboundType === 'defensive') {
          if (reboundTeamId === defense) {
            counts.opponentDefensiveRebounds += 1;
            countedIds.add(eventId);
          } else {
            unexpectedTeamAttributionEvents += 1;
            unresolvedIds.add(eventId);
          }
        } else {
          unclassifiedReboundEvents += 1;
          unresolvedIds.add(eventId);
        }
      }
    }
  });

  const relevantEventCount = relevantIds.size;
  const resolvedEventCount = Math.max(0, relevantEventCount - unresolvedIds.size);
  return {
    counts,
    offensiveEventExtras,
    defensiveEventExtras,
    coverage: {
      status: relevantEventCount === 0 ? 'unavailable' : unresolvedIds.size === 0 ? 'complete' : 'partial',
      inputEventCount: rows.length,
      uniqueEventCount: seenIds.size,
      relevantEventCount,
      countedEventCount: countedIds.size,
      resolvedEventCount,
      unresolvedEventCount: unresolvedIds.size,
      resolvedRelevantEventShare: relevantEventCount > 0 ? round(resolvedEventCount / relevantEventCount, 4) : null,
      skippedRescindedEvents,
      duplicateEventIds,
      missingStructuredStatisticEvents,
      missingTeamAttributionEvents,
      foreignTeamAttributionEvents,
      unexpectedTeamAttributionEvents,
      missingMadeStatusEvents,
      missingShotValueEvents,
      unclassifiedReboundEvents,
      method: 'structured_normalized_event_statistics_v1',
    },
  };
}

function possessionEventSlice(record, possession) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const startEventId = normalizedId(possession?.startEventId);
  const terminalEventId = normalizedId(possession?.terminalEventId);
  const startIndex = events.findIndex((event) => normalizedId(event?.id) === startEventId);
  const terminalIndex = events.findIndex((event) => normalizedId(event?.id) === terminalEventId);
  if (startIndex < 0 || terminalIndex < 0 || terminalIndex < startIndex) {
    return {
      events: [],
      status: 'unavailable',
      reason: 'possession_event_boundaries_not_found',
      startEventId,
      terminalEventId,
    };
  }
  const includeStart = possession?.possessionSource === 'inferred_period_opening_made_field_goal';
  return {
    events: events.slice(startIndex + (includeStart ? 0 : 1), terminalIndex + 1),
    status: 'available',
    reason: includeStart ? 'inferred_period_opening_includes_start_event' : 'provider_post_event_start_excluded',
    startEventId,
    terminalEventId,
  };
}

function possessionTactics(record, possession, counts) {
  const events = Array.isArray(record?.events) ? record.events : [];
  const startEventId = normalizedId(possession?.startEventId);
  const startEvent = events.find((event) => normalizedId(event?.id) === startEventId) ?? null;
  const defenseTeamId = normalizedId(possession?.defenseProviderTeamId);
  const openingTurnover = startEvent
    ? firstStatisticOfTypes(startEvent, ['turnover', 'offensivefoul'])
    : null;
  return {
    hasStructuredOffensiveRebound: (nonNegativeNumber(counts?.offensiveRebounds) ?? 0) > 0,
    startsAfterStructuredOpponentTurnover: Boolean(
      openingTurnover
      && statisticTeamId(openingTurnover) === defenseTeamId
    ),
  };
}

export function eventStatsForPossession(record, possession) {
  const slice = possessionEventSlice(record, possession);
  const offenseTeamId = normalizedId(possession?.offenseProviderTeamId);
  const defenseTeamId = normalizedId(possession?.defenseProviderTeamId);
  if (slice.status !== 'available' || !offenseTeamId || !defenseTeamId || offenseTeamId === defenseTeamId) {
    return {
      counts: emptyFourFactorCounts(),
      offensiveEventExtras: emptyOffensiveEventExtras(),
      defensiveEventExtras: emptyDefensiveEventExtras(),
      coverage: {
        status: 'unavailable',
        method: 'structured_normalized_event_statistics_v1',
        reason: slice.status !== 'available' ? slice.reason : 'invalid_possession_team_ids',
        inputEventCount: slice.events.length,
      },
      tactics: {
        hasStructuredOffensiveRebound: false,
        startsAfterStructuredOpponentTurnover: false,
      },
      eventSlice: { ...slice, events: undefined, eventCount: slice.events.length },
    };
  }
  const derived = deriveFourFactorCounts(slice.events, { offenseTeamId, defenseTeamId });
  return {
    ...derived,
    tactics: possessionTactics(record, possession, derived.counts),
    eventSlice: { ...slice, events: undefined, eventCount: slice.events.length },
  };
}

function ratio(numerator, denominator, digits) {
  return denominator > 0 ? round(numerator / denominator, digits) : null;
}

export function calculateFourFactors(input = {}, { digits = 4 } = {}) {
  const counts = input.counts ?? input;
  const fieldGoalAttempts = nonNegativeNumber(counts.fieldGoalAttempts) ?? 0;
  const fieldGoalsMade = nonNegativeNumber(counts.fieldGoalsMade) ?? 0;
  const threePointAttempts = nonNegativeNumber(counts.threePointAttempts) ?? 0;
  const threePointersMade = nonNegativeNumber(counts.threePointersMade) ?? 0;
  const freeThrowAttempts = nonNegativeNumber(counts.freeThrowAttempts) ?? 0;
  const turnovers = nonNegativeNumber(counts.turnovers) ?? 0;
  const offensiveRebounds = nonNegativeNumber(counts.offensiveRebounds) ?? 0;
  const opponentDefensiveRebounds = nonNegativeNumber(counts.opponentDefensiveRebounds) ?? 0;
  const turnoverDenominator = fieldGoalAttempts + (0.44 * freeThrowAttempts) + turnovers;
  const reboundOpportunityDenominator = offensiveRebounds + opponentDefensiveRebounds;
  return {
    counts: {
      fieldGoalAttempts,
      fieldGoalsMade,
      threePointAttempts,
      threePointersMade,
      freeThrowAttempts,
      turnovers,
      offensiveRebounds,
      opponentDefensiveRebounds,
    },
    effectiveFieldGoalPercentage: ratio(fieldGoalsMade + (0.5 * threePointersMade), fieldGoalAttempts, digits),
    turnoverRate: ratio(turnovers, turnoverDenominator, digits),
    offensiveReboundPercentage: ratio(offensiveRebounds, reboundOpportunityDenominator, digits),
    freeThrowAttemptRate: ratio(freeThrowAttempts, fieldGoalAttempts, digits),
    formulas: FOUR_FACTOR_FORMULAS,
    coverage: input.coverage ?? null,
  };
}

export const fourFactorsFromCounts = calculateFourFactors;

export function deriveFourFactorsFromEvents(events, options = {}) {
  return calculateFourFactors(deriveFourFactorCounts(events, options), options);
}

function playerRapmValue(player) {
  if (typeof player === 'number') return finiteNumber(player);
  return finiteNumber(player?.rapmPer100 ?? player?.combinedRapmPer100 ?? player?.rapm ?? player?.value);
}

export function projectLineupFromRapm({
  players = [],
  observedNetRating = null,
  observedPossessions = 0,
  averageOpponentLineupRapmPer100 = null,
  homeCourtExposureAdjustmentPer100 = null,
  synergyPriorPossessions = 400,
  digits = 3,
} = {}) {
  const rapmValues = Array.isArray(players) ? players.map(playerRapmValue) : [];
  if (rapmValues.length !== 5 || rapmValues.some((value) => value === null)) {
    return {
      status: 'unavailable',
      reason: 'exactly_five_players_with_finite_rapm_required',
      model: 'rapm_sum_plus_possession_shrunk_observed_synergy_v1',
    };
  }
  const rapmSumPer100 = rapmValues.reduce((total, value) => total + value, 0);
  const sample = nonNegativeNumber(observedPossessions) ?? 0;
  const prior = nonNegativeNumber(synergyPriorPossessions);
  if (prior === null || prior <= 0) throw new TypeError('synergyPriorPossessions must be greater than zero.');
  const observed = finiteNumber(observedNetRating);
  const suppliedOpponentRapm = finiteNumber(averageOpponentLineupRapmPer100);
  const suppliedHomeCourtAdjustment = finiteNumber(homeCourtExposureAdjustmentPer100);
  const opponentRapm = suppliedOpponentRapm ?? 0;
  const homeCourtAdjustment = suppliedHomeCourtAdjustment ?? 0;
  const expectedObservedNetRatingPer100 = rapmSumPer100 - opponentRapm + homeCourtAdjustment;
  const rawObservedSynergyPer100 = observed === null ? null : observed - expectedObservedNetRatingPer100;
  const synergyWeight = rawObservedSynergyPer100 === null ? 0 : sample / (sample + prior);
  const shrunkSynergyPer100 = rawObservedSynergyPer100 === null ? 0 : rawObservedSynergyPer100 * synergyWeight;
  return {
    status: 'available',
    model: 'rapm_sum_plus_possession_shrunk_observed_synergy_v1',
    playerCount: 5,
    rapmSumPer100: round(rapmSumPer100, digits),
    averageOpponentLineupRapmPer100: round(opponentRapm, digits),
    homeCourtExposureAdjustmentPer100: round(homeCourtAdjustment, digits),
    expectedObservedNetRatingPer100: round(expectedObservedNetRatingPer100, digits),
    contextAdjustmentStatus: suppliedOpponentRapm === null || suppliedHomeCourtAdjustment === null
      ? 'defaults_used_for_missing_context_adjustments'
      : 'supplied_context_adjustments',
    contextAdjustmentDefaults: {
      averageOpponentLineupRapmPer100: suppliedOpponentRapm === null ? 0 : null,
      homeCourtExposureAdjustmentPer100: suppliedHomeCourtAdjustment === null ? 0 : null,
    },
    observedNetRating: round(observed, digits),
    observedPossessions: sample,
    rawObservedSynergyPer100: round(rawObservedSynergyPer100, digits),
    synergyPriorPossessions: prior,
    synergyWeight: round(synergyWeight, 4),
    shrunkSynergyPer100: round(shrunkSynergyPer100, digits),
    projectedNetRatingPer100: round(rapmSumPer100 + shrunkSynergyPer100, digits),
    projectedObservedContextNetRatingPer100: round(expectedObservedNetRatingPer100 + shrunkSynergyPer100, digits),
    reliability: calculateSampleReliability(sample),
    caveat: 'The neutral projection is own five-player RAPM plus shrunk residual synergy. Missing opponent/home context defaults to zero; RAPM uncertainty and correlated lineup selection are not represented.',
  };
}

export const lineupProjection = projectLineupFromRapm;

export function possessionContexts(possession, side = 'home', { phase, rollingWindowMemberships } = {}) {
  return classifyScoutPossessionContext({ possession, side, phase, rollingWindowMemberships }).contexts;
}
