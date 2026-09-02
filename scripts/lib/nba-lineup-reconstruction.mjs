/**
 * Deterministic reconstruction of NBA five-player lineup stints from normalized
 * Sportradar play-by-play events.
 *
 * This module deliberately does not infer a lineup or a possession from box
 * score rules.  A score-changing event without an observed, valid five-on-five
 * snapshot makes the result ineligible for standard lineup analytics.  A
 * possession exists only when the provider's post-event possession state lets
 * us observe it.
 *
 * Expected normalized event contract (all field names are camelCase):
 * {
 *   id, periodSequence, periodNumber, periodType, eventNumber, eventSequence,
 *   clockRemainingMs, homePointsAfter, awayPointsAfter, eventType,
 *   possessionTeamId, qualifiers,
 *   onCourt: { homePlayerIds, awayPlayerIds, snapshotStatus? },
 *   isRescinded?
 * }
 *
 * `possessionTeamId` is the provider's *post-event* possession team.  This is
 * important: a scoring event that changes possession belongs to the prior
 * active possession, then starts the next possession after its score is
 * recorded.
 */

import { createHash } from 'node:crypto';

export const NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION = 'sportradar-nba-lineup-reconstruction-v3';

// Fixed namespaces make keys reproducible across dry-runs and imports. They
// are application namespaces, not provider identifiers.
export const NBA_LINEUP_UUID_NAMESPACE = '7db4cb88-c7d5-5a2d-b01d-902d9b0bfc9b';
export const NBA_COMBINATION_UUID_NAMESPACE = '8e9bf659-992b-57e2-b0ed-2b8fb6bf5bbe';
export const NBA_POSSESSION_UUID_NAMESPACE = 'd2e7c7d7-f263-5f1e-a1c9-8ce4eb729d06';

const VALID_SNAPSHOT_STATUS = 'valid_five_on_five';
const SCORE_STATE_LABELS = new Set([
  'unclassified',
  'tied',
  'ahead_1_5',
  'ahead_6_10',
  'ahead_11_15',
  'ahead_16_plus',
  'trailing_1_5',
  'trailing_6_10',
  'trailing_11_15',
  'trailing_16_plus'
]);

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

function asFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asNonNegativeInteger(value) {
  const number = asFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number >= 0 ? number : null;
}

function asPositiveInteger(value) {
  const number = asFiniteNumber(value);
  return number !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableFlags(flags) {
  return [...new Set(Array.from(flags ?? []).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function addFlag(target, flag) {
  if (target && flag) target.add(flag);
}

function normalizeStatus(value) {
  return asTrimmedString(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function normalizedEventType(event) {
  return normalizeStatus(event?.eventType ?? event?.type ?? '').replace(/[^a-z0-9]+/g, '');
}

function eventId(event, index) {
  const id = asTrimmedString(event?.id ?? event?.eventId);
  return id || `missing-event-id-${index + 1}`;
}

function eventOrderNumber(event, names) {
  for (const name of names) {
    const value = asFiniteNumber(event?.[name]);
    if (value !== null) return value;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Compare raw PBP events with the provider's sequence as the primary order,
 * then event number and stable event ID. This never uses update timestamps.
 */
export function comparePbpEvents(left, right) {
  const sequenceDelta = eventOrderNumber(left, ['eventSequence', 'sequence'])
    - eventOrderNumber(right, ['eventSequence', 'sequence']);
  if (sequenceDelta !== 0 && !Number.isNaN(sequenceDelta)) return sequenceDelta;

  const numberDelta = eventOrderNumber(left, ['eventNumber', 'number'])
    - eventOrderNumber(right, ['eventNumber', 'number']);
  if (numberDelta !== 0 && !Number.isNaN(numberDelta)) return numberDelta;

  return eventId(left, 0).localeCompare(eventId(right, 0));
}

/** Return rescinded events only when explicitly requested by the caller. */
export function sortPbpEvents(events = [], { includeRescinded = false } = {}) {
  return (Array.isArray(events) ? events : [])
    .map((event, originalIndex) => ({ event: event ?? {}, originalIndex }))
    .filter(({ event }) => includeRescinded || event.isRescinded !== true)
    .sort((left, right) => {
      const compared = comparePbpEvents(left.event, right.event);
      return compared || left.originalIndex - right.originalIndex;
    })
    .map(({ event }) => event);
}

/**
 * Produce a canonical five-player key. Player identifiers are treated as
 * opaque provider IDs, so this helper does not impose a UUID syntax check.
 */
export function canonicalLineupKey(playerIds) {
  const normalized = (Array.isArray(playerIds) ? playerIds : [])
    .map(asTrimmedString)
    .filter(Boolean);
  return sortedUnique(normalized).join('|');
}

export function canonicalPlayerIds(playerIds) {
  const key = canonicalLineupKey(playerIds);
  return key ? key.split('|') : [];
}

/** A small dependency-free RFC 4122 UUID v5 implementation. */
export function deterministicUuidV5(namespace, name) {
  const namespaceHex = asTrimmedString(namespace).replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(namespaceHex)) {
    throw new TypeError('deterministicUuidV5 requires a UUID namespace.');
  }
  const namespaceBytes = Buffer.from(namespaceHex, 'hex');
  const digest = createHash('sha1')
    .update(namespaceBytes)
    .update(Buffer.from(asTrimmedString(name), 'utf8'))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rawSnapshotFromEvent(event = {}) {
  const onCourt = event.onCourt ?? event.on_court ?? {};
  const home = onCourt.homePlayerIds
    ?? onCourt.home_player_ids
    ?? onCourt.home?.playerIds
    ?? onCourt.home?.player_ids
    ?? onCourt.home?.players
    ?? event.homePlayerIds
    ?? event.home_player_ids
    ?? [];
  const away = onCourt.awayPlayerIds
    ?? onCourt.away_player_ids
    ?? onCourt.away?.playerIds
    ?? onCourt.away?.player_ids
    ?? onCourt.away?.players
    ?? event.awayPlayerIds
    ?? event.away_player_ids
    ?? [];
  const toIds = (players) => (Array.isArray(players) ? players : [])
    .map((player) => asTrimmedString(
      typeof player === 'object' && player !== null ? player.id ?? player.playerId ?? player.player_id : player
    ))
    .filter(Boolean);
  return {
    homePlayerIds: toIds(home),
    awayPlayerIds: toIds(away),
    suppliedStatus: normalizeStatus(onCourt.snapshotStatus ?? onCourt.snapshot_status ?? event.snapshotStatus)
  };
}

/**
 * Validate a provider on-court snapshot without filling gaps from a prior
 * event. `snapshotStatus` is retained for auditability and never upgraded.
 */
export function validateOnCourtSnapshot(event = {}) {
  const raw = rawSnapshotFromEvent(event);
  const suppliedInvalid = raw.suppliedStatus && raw.suppliedStatus !== VALID_SNAPSHOT_STATUS;
  if (suppliedInvalid) {
    return {
      snapshotStatus: raw.suppliedStatus,
      homePlayerIds: canonicalPlayerIds(raw.homePlayerIds),
      awayPlayerIds: canonicalPlayerIds(raw.awayPlayerIds),
      isValid: false
    };
  }

  if (!raw.homePlayerIds.length && !raw.awayPlayerIds.length) {
    return { snapshotStatus: 'missing', homePlayerIds: [], awayPlayerIds: [], isValid: false };
  }
  if (raw.homePlayerIds.length !== 5 || raw.awayPlayerIds.length !== 5) {
    return {
      snapshotStatus: 'invalid_count',
      homePlayerIds: canonicalPlayerIds(raw.homePlayerIds),
      awayPlayerIds: canonicalPlayerIds(raw.awayPlayerIds),
      isValid: false
    };
  }
  const homePlayerIds = canonicalPlayerIds(raw.homePlayerIds);
  const awayPlayerIds = canonicalPlayerIds(raw.awayPlayerIds);
  if (homePlayerIds.length !== 5 || awayPlayerIds.length !== 5) {
    return { snapshotStatus: 'duplicate_player', homePlayerIds, awayPlayerIds, isValid: false };
  }
  if (homePlayerIds.some((playerId) => awayPlayerIds.includes(playerId))) {
    return { snapshotStatus: 'cross_team_duplicate', homePlayerIds, awayPlayerIds, isValid: false };
  }
  return { snapshotStatus: VALID_SNAPSHOT_STATUS, homePlayerIds, awayPlayerIds, isValid: true };
}

function inferredPeriodDurationMs(event) {
  const direct = asPositiveInteger(event?.periodDurationMs ?? event?.period_duration_ms);
  if (direct !== null) return direct;
  const periodNumber = asPositiveInteger(event?.periodNumber ?? event?.period_number);
  const periodType = normalizeStatus(event?.periodType ?? event?.period_type);
  return periodNumber !== null && (periodNumber > 4 || periodType.includes('overtime') || periodType === 'ot')
    ? 300000
    : 720000;
}

function periodSequence(event) {
  return asPositiveInteger(event?.periodSequence ?? event?.period_sequence)
    ?? asPositiveInteger(event?.periodNumber ?? event?.period_number)
    ?? 1;
}

function periodNumber(event) {
  return asPositiveInteger(event?.periodNumber ?? event?.period_number) ?? periodSequence(event);
}

function observedPeriodNumber(event) {
  return asPositiveInteger(event?.periodNumber ?? event?.period_number)
    ?? asPositiveInteger(event?.periodSequence ?? event?.period_sequence);
}

function periodStartElapsedMs(event) {
  const sequence = periodSequence(event);
  let elapsed = 0;
  for (let prior = 1; prior < sequence; prior += 1) {
    elapsed += prior > 4 ? 300000 : 720000;
  }
  return elapsed;
}

/** Convert a provider clock remaining value into basketball elapsed game time. */
export function gameElapsedMs(event = {}) {
  const clockRemainingMs = asNonNegativeInteger(event.clockRemainingMs ?? event.clock_remaining_ms);
  if (clockRemainingMs === null) return null;
  const duration = inferredPeriodDurationMs(event);
  const boundedClock = Math.min(clockRemainingMs, duration);
  return periodStartElapsedMs(event) + duration - boundedClock;
}

export function homeScoreStateV1(homePoints, awayPoints) {
  const home = asFiniteNumber(homePoints);
  const away = asFiniteNumber(awayPoints);
  if (home === null || away === null) return 'unclassified';
  const margin = home - away;
  if (margin === 0) return 'tied';
  const direction = margin > 0 ? 'ahead' : 'trailing';
  const magnitude = Math.abs(margin);
  if (magnitude <= 5) return `${direction}_1_5`;
  if (magnitude <= 10) return `${direction}_6_10`;
  if (magnitude <= 15) return `${direction}_11_15`;
  return `${direction}_16_plus`;
}

export function isClutchV1({ periodNumber: rawPeriodNumber, clockRemainingMs, homePointsBefore, awayPointsBefore } = {}) {
  const currentPeriod = asPositiveInteger(rawPeriodNumber);
  const clock = asNonNegativeInteger(clockRemainingMs);
  const home = asFiniteNumber(homePointsBefore);
  const away = asFiniteNumber(awayPointsBefore);
  if (currentPeriod === null || clock === null || home === null || away === null) return null;
  return currentPeriod >= 4 && clock <= 300000 && Math.abs(home - away) <= 5;
}

function fastbreakText(value) {
  return asTrimmedString(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function truthyFastbreakValue(value) {
  if (value === false || value === 0) return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return false;
  }
  return value !== null && value !== undefined && value !== '';
}

function qualifierHasFastbreak(value, depth = 0) {
  if (depth > 7 || value === null || value === undefined) return false;
  if (typeof value === 'string') {
    const compact = fastbreakText(value);
    return compact === 'fastbreak' || compact === 'fastbreakplay' || compact === 'fastbreakpoints';
  }
  if (Array.isArray(value)) return value.some((item) => qualifierHasFastbreak(item, depth + 1));
  if (typeof value !== 'object') return false;
  const descriptor = value.type ?? value.name ?? value.qualifier ?? value.code;
  const compactDescriptor = fastbreakText(descriptor);
  if (compactDescriptor === 'fastbreak' || compactDescriptor === 'fastbreakplay' || compactDescriptor === 'fastbreakpoints') {
    const explicitValue = value.value ?? value.enabled ?? value.active ?? value.isFastbreak ?? value.is_fastbreak;
    return explicitValue === undefined ? true : truthyFastbreakValue(explicitValue);
  }
  return Object.entries(value).some(([key, child]) => {
    const compactKey = fastbreakText(key);
    if (compactKey === 'fastbreak' || compactKey === 'isfastbreak' || compactKey === 'fastbreakplay') {
      return truthyFastbreakValue(child);
    }
    return qualifierHasFastbreak(child, depth + 1);
  });
}

/** True only when a provider qualifier explicitly describes fast break. */
export function hasProviderFastbreakQualifier(qualifiers) {
  return qualifierHasFastbreak(qualifiers);
}

function hasQualifierEvidence(event) {
  return Object.prototype.hasOwnProperty.call(event ?? {}, 'qualifiers')
    || Object.prototype.hasOwnProperty.call(event ?? {}, 'qualifier');
}

function isLineupChangeEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('lineupchange') || type.includes('substitution') || type.includes('ejection');
}

function isPossessionAdministrativeEvent(event) {
  const type = normalizedEventType(event);
  return isLineupChangeEvent(event)
    || isPeriodEndEvent(event)
    || type.includes('startperiod')
    || type.includes('periodstart')
    || type.includes('startquarter')
    || type.includes('quarterstart')
    || type.includes('timeout')
    || type.includes('review')
    || type.includes('instantreplay');
}

function isMadeFreeThrowEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('freethrowmade') || type.includes('madefreethrow');
}

function isMissedFreeThrowEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('freethrowmiss') || type.includes('missedfreethrow');
}

function isMadeFieldGoalEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('twopointmade') || type.includes('threepointmade');
}

function eventMayChangeScore(event) {
  const type = normalizedEventType(event);
  if (isMadeFieldGoalEvent(event)
    || isMadeFreeThrowEvent(event)
    || type.includes('fieldgoalmade')
    || type.includes('madefieldgoal')
    || type.includes('basketmade')
    || type.includes('scorechange')) return true;
  if (asFiniteNumber(event?.points) > 0) return true;
  return (Array.isArray(event?.statistics) ? event.statistics : []).some((statistic) => (
    statistic?.made === true
    && asFiniteNumber(statistic?.points) > 0
    && ['fieldgoal', 'freethrow'].includes(normalizedStatisticType(statistic))
  ));
}

function isObservedPossessionAction(event) {
  const type = normalizedEventType(event);
  if (isPossessionAdministrativeEvent(event)) return false;
  if (type.includes('twopoint')
    || type.includes('threepoint')
    || type.includes('fieldgoal')
    || type.includes('freethrow')
    || type.includes('turnover')
    || type.includes('rebound')
    || type.includes('foul')
    || type.includes('violation')
    || type.includes('jumpball')) return true;
  return (Array.isArray(event?.statistics) ? event.statistics : []).some((statistic) => (
    ['fieldgoal', 'freethrow', 'turnover', 'rebound', 'personalfoul', 'fouldrawn']
      .includes(normalizedStatisticType(statistic))
  ));
}

function isShootingFoulEvent(event) {
  return normalizedEventType(event).includes('shootingfoul');
}

function isTechnicalFoulEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('technicalfoul') || (type.includes('technical') && type.includes('foul'));
}

function isReboundEvent(event) {
  return normalizedEventType(event).includes('rebound') || Boolean(statisticForType(event, 'rebound'));
}

function isAndOneAdministrativeEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('timeout')
    || type.includes('review')
    || type.includes('instantreplay')
    || type.includes('lineupchange')
    || type.includes('substitution');
}

function isPeriodOpeningAdministrativeEvent(event) {
  const type = normalizedEventType(event);
  return isLineupChangeEvent(event)
    || isPeriodEndEvent(event)
    || type.includes('startperiod')
    || type.includes('periodstart')
    || type.includes('startquarter')
    || type.includes('quarterstart')
    || type.includes('timeout')
    || type.includes('review')
    || type.includes('instantreplay');
}

function isPeriodEndEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('endperiod')
    || type.includes('periodend')
    || type.includes('endquarter')
    || type.includes('quarterend')
    || type.includes('endgame')
    || type.includes('gameend')
    || type.includes('gameover');
}

function isGameEndEvent(event) {
  const type = normalizedEventType(event);
  return type.includes('endgame') || type.includes('gameend') || type.includes('gameover');
}

function normalizeTeamId(value) {
  return asTrimmedString(value);
}

function providerPossessionId(event) {
  const nested = event?.possession ?? event?.possessionState ?? event?.possession_state;
  return asTrimmedString(
    event?.providerPossessionId
    ?? event?.provider_possession_id
    ?? nested?.id
    ?? nested?.possessionId
    ?? nested?.possession_id
  );
}

function postEventPossessionTeamId(event) {
  const nested = event?.possession ?? event?.possessionState ?? event?.possession_state;
  return normalizeTeamId(
    event?.possessionTeamId
    ?? event?.possession_team_id
    ?? nested?.teamId
    ?? nested?.team_id
    ?? nested?.team?.id
  );
}

function eventAttributionTeamId(event) {
  const nested = event?.attribution ?? event?.attributionTeam ?? event?.attribution_team;
  return normalizeTeamId(
    event?.attributionTeamId
    ?? event?.attribution_team_id
    ?? nested?.teamId
    ?? nested?.team_id
    ?? nested?.id
    ?? nested?.team?.id
  );
}

function normalizedStatisticType(statistic) {
  return normalizeStatus(statistic?.type ?? statistic?.statisticType ?? statistic?.statistic_type).replace(/_/g, '');
}

function statisticForType(event, type) {
  const expected = normalizeStatus(type).replace(/_/g, '');
  return (Array.isArray(event?.statistics) ? event.statistics : [])
    .find((statistic) => normalizedStatisticType(statistic) === expected) ?? null;
}

function statisticTeamId(statistic) {
  return normalizeTeamId(statistic?.team?.id ?? statistic?.teamId ?? statistic?.team_id);
}

function statisticPlayerId(statistic) {
  return asTrimmedString(statistic?.player?.id ?? statistic?.playerId ?? statistic?.player_id);
}

function offensiveActionTeamId(event) {
  const fieldGoal = statisticForType(event, 'fieldgoal');
  if (fieldGoal && statisticTeamId(fieldGoal)) return statisticTeamId(fieldGoal);
  const turnover = statisticForType(event, 'turnover');
  if (turnover && statisticTeamId(turnover)) return statisticTeamId(turnover);
  const type = normalizedEventType(event);
  const isNarrowOffensiveEvent = type.includes('twopoint')
    || type.includes('threepoint')
    || type.includes('heave')
    || type.includes('turnover');
  return isNarrowOffensiveEvent ? eventAttributionTeamId(event) : '';
}

function regularFreeThrowOffenseTeamId(event, precedingEvent, precedingScore) {
  const freeThrowMade = isMadeFreeThrowEvent(event);
  if ((!freeThrowMade && !isMissedFreeThrowEvent(event))
    || !precedingEvent
    || !isShootingFoulEvent(precedingEvent)
    || !samePeriodAndClock(precedingEvent, event)
    || !isZeroScoreDelta(precedingScore)) return '';
  const statistic = statisticForType(event, 'freethrow');
  const teamId = statisticTeamId(statistic);
  const freeThrowType = normalizeStatus(statistic?.free_throw_type ?? statistic?.freeThrowType);
  if (!statistic
    || freeThrowType !== 'regular'
    || statistic.made !== freeThrowMade
    || !teamId
    || eventAttributionTeamId(event) !== teamId
    || postEventPossessionTeamId(precedingEvent) !== teamId) return '';
  return teamId;
}

function addNumeric(target, key, value) {
  target[key] += Number.isFinite(value) ? value : 0;
}

function lineupCombinations(playerIds, minimum = 1, maximum = playerIds.length) {
  const result = [];
  const canonical = canonicalPlayerIds(playerIds);
  const upper = Math.min(maximum, canonical.length);
  const walk = (start, needed, selected) => {
    if (needed === 0) {
      result.push([...selected]);
      return;
    }
    for (let index = start; index <= canonical.length - needed; index += 1) {
      selected.push(canonical[index]);
      walk(index + 1, needed - 1, selected);
      selected.pop();
    }
  };
  for (let count = Math.max(1, minimum); count <= upper; count += 1) walk(0, count, []);
  return result;
}

/**
 * Expand a canonical five-player unit into all shared-floor combinations.
 * One-player rows support on/off; two through four are co-presence units;
 * five is an exact lineup.
 */
export function expandLineupCombinations({ providerTeamId, lineupId, playerIds }) {
  const teamId = normalizeTeamId(providerTeamId);
  const canonical = canonicalPlayerIds(playerIds);
  if (!teamId || canonical.length !== 5) return [];
  return lineupCombinations(canonical).map((combination) => {
    const combinationKey = canonicalLineupKey(combination);
    return {
      id: deterministicUuidV5(NBA_COMBINATION_UUID_NAMESPACE, `${teamId}:${combinationKey}`),
      providerTeamId: teamId,
      exactLineupId: lineupId ?? null,
      playerIds: combination,
      playerCount: combination.length,
      combinationKey,
      semantics: combination.length === 5 ? 'exact_five' : combination.length === 1 ? 'player_on_court' : 'shared_floor'
    };
  });
}

function rating(points, possessions) {
  return possessions > 0 ? (100 * points) / possessions : null;
}

function metricsForTotals(totals) {
  const offensiveRating = rating(totals.pointsFor, totals.offensivePossessions);
  const defensiveRating = rating(totals.pointsAgainst, totals.defensivePossessions);
  return {
    durationMs: totals.durationMs,
    seconds: totals.durationMs / 1000,
    minutes: totals.durationMs / 60000,
    stintCount: totals.stintCount,
    gameCount: totals.gameCount,
    pointsFor: totals.pointsFor,
    pointsAgainst: totals.pointsAgainst,
    plusMinus: totals.pointsFor - totals.pointsAgainst,
    offensivePossessions: totals.offensivePossessions,
    defensivePossessions: totals.defensivePossessions,
    offensiveRating,
    defensiveRating,
    netRating: offensiveRating === null || defensiveRating === null ? null : offensiveRating - defensiveRating
  };
}

function extractExpectedFinalScore(input) {
  const game = input?.game ?? {};
  const final = input?.expectedFinalScore ?? input?.finalScore ?? input?.summary?.finalScore ?? {};
  return {
    homePoints: asNonNegativeInteger(
      input?.expectedFinalHomePoints
      ?? input?.finalHomePoints
      ?? final.homePoints
      ?? final.home_points
      ?? game.homePoints
      ?? game.home_points
    ),
    awayPoints: asNonNegativeInteger(
      input?.expectedFinalAwayPoints
      ?? input?.finalAwayPoints
      ?? final.awayPoints
      ?? final.away_points
      ?? game.awayPoints
      ?? game.away_points
    )
  };
}

function extractExpectedPossessions(input) {
  const raw = input?.providerTeamPossessions ?? input?.expectedPossessions ?? input?.summary?.teamPossessions ?? {};
  return {
    home: asFiniteNumber(raw.home ?? raw.homePossessions ?? raw.home_possessions),
    away: asFiniteNumber(raw.away ?? raw.awayPossessions ?? raw.away_possessions)
  };
}

function parseMinutes(value) {
  const numeric = asFiniteNumber(value);
  if (numeric !== null) return numeric;
  const match = asTrimmedString(value).match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
  if (!match) return null;
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  const fraction = match[3] ? Number(`0.${match[3]}`) : 0;
  return seconds < 60 ? minutes + (seconds + fraction) / 60 : null;
}

function minuteExpectationMap(input) {
  const source = input?.providerPlayerMinutes ?? input?.expectedPlayerMinutes ?? input?.summary?.playerMinutes;
  const result = new Map();
  if (source instanceof Map) {
    for (const [playerId, minutes] of source.entries()) {
      const parsed = parseMinutes(minutes);
      if (asTrimmedString(playerId) && parsed !== null) result.set(asTrimmedString(playerId), parsed);
    }
    return result;
  }
  if (Array.isArray(source)) {
    for (const row of source) {
      const playerId = asTrimmedString(row?.playerId ?? row?.providerPlayerId ?? row?.id);
      const minutes = parseMinutes(row?.minutesPlayed ?? row?.minutes ?? row?.minutes_played);
      if (playerId && minutes !== null) result.set(playerId, minutes);
    }
    return result;
  }
  if (source && typeof source === 'object') {
    for (const [playerId, minutes] of Object.entries(source)) {
      const parsed = parseMinutes(minutes);
      if (asTrimmedString(playerId) && parsed !== null) result.set(asTrimmedString(playerId), parsed);
    }
  }
  return result;
}

function resolveGameMetadata(input) {
  const game = input?.game ?? {};
  return {
    gameId: asTrimmedString(input?.gameId ?? game.id ?? game.gameId),
    homeTeamId: normalizeTeamId(input?.homeTeamId ?? game.homeTeamId ?? game.home_team_id ?? game.home?.id),
    awayTeamId: normalizeTeamId(input?.awayTeamId ?? game.awayTeamId ?? game.away_team_id ?? game.away?.id),
    status: normalizeStatus(input?.status ?? game.status),
    coverage: normalizeStatus(input?.coverage ?? game.coverage),
    trackOnCourt: input?.trackOnCourt ?? game.trackOnCourt ?? game.track_on_court
  };
}

function expectedGameEndMs(events) {
  const last = events.at(-1);
  if (!last) return null;
  return periodStartElapsedMs(last) + inferredPeriodDurationMs(last);
}

function isPotentialGameEnd(lastEvent, events) {
  if (!lastEvent) return false;
  if (isGameEndEvent(lastEvent)) return true;
  const lastClock = asNonNegativeInteger(lastEvent.clockRemainingMs ?? lastEvent.clock_remaining_ms);
  if (lastClock !== 0) return false;
  const currentPeriod = periodSequence(lastEvent);
  // A sparse provider document may omit a distinct game-end event. Its final
  // zero-clock event is sufficient only after regulation (or in overtime), so
  // a document truncated at the end of Q1-Q3 cannot become publishable.
  return currentPeriod >= 4 && !events.some((event) => periodSequence(event) > currentPeriod);
}

function createLineupRegistry() {
  const byTeamAndKey = new Map();
  const byId = new Map();
  const ensure = (providerTeamId, playerIds) => {
    const teamId = normalizeTeamId(providerTeamId);
    const canonical = canonicalPlayerIds(playerIds);
    if (!teamId || canonical.length !== 5) return null;
    const lineupKey = canonicalLineupKey(canonical);
    const mapKey = `${teamId}:${lineupKey}`;
    if (byTeamAndKey.has(mapKey)) return byTeamAndKey.get(mapKey);
    const lineup = {
      id: deterministicUuidV5(NBA_LINEUP_UUID_NAMESPACE, mapKey),
      providerTeamId: teamId,
      lineupKey,
      playerIds: canonical,
      members: canonical.map((providerPlayerId, index) => ({ providerPlayerId, memberOrder: index + 1 }))
    };
    byTeamAndKey.set(mapKey, lineup);
    byId.set(lineup.id, lineup);
    return lineup;
  };
  return {
    ensure,
    byId,
    values: () => [...byTeamAndKey.values()].sort((left, right) => (
      left.providerTeamId.localeCompare(right.providerTeamId) || left.lineupKey.localeCompare(right.lineupKey)
    ))
  };
}

function makeStint({ ordinal, homeLineup, awayLineup, startEventId, startElapsedMs }) {
  return {
    stintOrdinal: ordinal,
    homeLineupId: homeLineup?.id ?? null,
    awayLineupId: awayLineup?.id ?? null,
    startEventId: startEventId ?? null,
    endEventId: null,
    startElapsedMs,
    endElapsedMs: startElapsedMs,
    durationMs: 0,
    homePoints: 0,
    awayPoints: 0,
    homeOffensivePossessions: 0,
    awayOffensivePossessions: 0,
    qualityFlagSet: new Set()
  };
}

function closeStint(stint, endElapsedMs, endEventId, flags = []) {
  if (!stint) return;
  const safeEnd = Number.isFinite(endElapsedMs) ? Math.max(stint.startElapsedMs, endElapsedMs) : stint.startElapsedMs;
  stint.endElapsedMs = safeEnd;
  stint.durationMs = safeEnd - stint.startElapsedMs;
  stint.endEventId = endEventId ?? stint.endEventId;
  for (const flag of flags) addFlag(stint.qualityFlagSet, flag);
}

function publicStint(stint) {
  const { qualityFlagSet, ...row } = stint;
  return { ...row, qualityFlags: stableFlags(qualityFlagSet) };
}

function scoreDelta(previous, event) {
  const homeAfter = asNonNegativeInteger(event.homePointsAfter ?? event.home_points_after);
  const awayAfter = asNonNegativeInteger(event.awayPointsAfter ?? event.away_points_after);
  if (homeAfter === null || awayAfter === null) {
    return {
      homeBefore: previous.home,
      awayBefore: previous.away,
      homeAfter: previous.home,
      awayAfter: previous.away,
      homeDelta: 0,
      awayDelta: 0,
      known: false,
      invalid: false
    };
  }
  const homeDelta = homeAfter - previous.home;
  const awayDelta = awayAfter - previous.away;
  return {
    homeBefore: previous.home,
    awayBefore: previous.away,
    homeAfter,
    awayAfter,
    homeDelta,
    awayDelta,
    known: true,
    invalid: homeDelta < 0 || awayDelta < 0
  };
}

function samePeriodAndClock(left, right) {
  const leftClock = asNonNegativeInteger(left?.clockRemainingMs ?? left?.clock_remaining_ms);
  const rightClock = asNonNegativeInteger(right?.clockRemainingMs ?? right?.clock_remaining_ms);
  return periodSequence(left) === periodSequence(right)
    && leftClock !== null
    && leftClock === rightClock;
}

function scoringTeamForMadeFieldGoal(event, score, homeTeamId, awayTeamId) {
  const type = normalizedEventType(event);
  const expectedPoints = type.includes('threepointmade') ? 3 : type.includes('twopointmade') ? 2 : null;
  if (expectedPoints === null || !score.known || score.invalid) return '';
  if (score.homeDelta === expectedPoints && score.awayDelta === 0) return homeTeamId;
  if (score.awayDelta === expectedPoints && score.homeDelta === 0) return awayTeamId;
  return '';
}

function hasVerifiedMadeFieldGoalForTeam(event, scoringTeamId) {
  const statistic = statisticForType(event, 'fieldgoal');
  return Boolean(
    scoringTeamId
    && statistic
    && statistic.made === true
    && statisticTeamId(statistic) === scoringTeamId
    && statisticPlayerId(statistic)
    && eventAttributionTeamId(event) === scoringTeamId
  );
}

function isZeroScoreDelta(score) {
  return score.known && !score.invalid && score.homeDelta === 0 && score.awayDelta === 0;
}

function identifyAndOneContinuations(events, homeTeamId, awayTeamId) {
  const contexts = new Map();
  const ambiguousEventIds = new Set();
  let previousScore = { home: 0, away: 0 };
  const scores = events.map((event) => {
    const score = scoreDelta(previousScore, event);
    if (score.known && !score.invalid) previousScore = { home: score.homeAfter, away: score.awayAfter };
    return score;
  });

  for (let fieldGoalIndex = 0; fieldGoalIndex < events.length - 2; fieldGoalIndex += 1) {
    const fieldGoal = events[fieldGoalIndex];
    if (!isMadeFieldGoalEvent(fieldGoal)) continue;
    const scoringTeamId = scoringTeamForMadeFieldGoal(fieldGoal, scores[fieldGoalIndex], homeTeamId, awayTeamId);
    if (!scoringTeamId) continue;
    const defendingTeamId = scoringTeamId === homeTeamId ? awayTeamId : homeTeamId;
    if (postEventPossessionTeamId(fieldGoal) !== defendingTeamId) continue;

    const foulIndex = fieldGoalIndex + 1;
    const foul = events[foulIndex];
    if (!isShootingFoulEvent(foul)
      || !samePeriodAndClock(fieldGoal, foul)
      || !isZeroScoreDelta(scores[foulIndex])
      || eventAttributionTeamId(foul) !== defendingTeamId
      || postEventPossessionTeamId(foul) !== scoringTeamId) continue;
    const candidateEventId = eventId(fieldGoal, fieldGoalIndex);
    ambiguousEventIds.add(candidateEventId);

    const fieldGoalStatistic = statisticForType(fieldGoal, 'fieldgoal');
    if (!fieldGoalStatistic
      || fieldGoalStatistic.made !== true
      || statisticTeamId(fieldGoalStatistic) !== scoringTeamId
      || !statisticPlayerId(fieldGoalStatistic)) continue;

    const foulDrawnStatistic = statisticForType(foul, 'fouldrawn');
    const personalFoulStatistic = statisticForType(foul, 'personalfoul');
    const fieldGoalPlayerId = statisticPlayerId(fieldGoalStatistic);
    if (!foulDrawnStatistic
      || !personalFoulStatistic
      || statisticTeamId(foulDrawnStatistic) !== scoringTeamId
      || statisticPlayerId(foulDrawnStatistic) !== fieldGoalPlayerId
      || statisticTeamId(personalFoulStatistic) !== defendingTeamId) continue;

    let freeThrowIndex = foulIndex + 1;
    while (freeThrowIndex < events.length
      && isAndOneAdministrativeEvent(events[freeThrowIndex])
      && samePeriodAndClock(fieldGoal, events[freeThrowIndex])
      && isZeroScoreDelta(scores[freeThrowIndex])) {
      freeThrowIndex += 1;
    }
    const freeThrow = events[freeThrowIndex];
    const freeThrowMade = isMadeFreeThrowEvent(freeThrow);
    if ((!freeThrowMade && !isMissedFreeThrowEvent(freeThrow))
      || !samePeriodAndClock(fieldGoal, freeThrow)
      || asTrimmedString(freeThrow?.attempt).toLowerCase().replace(/\s+/g, ' ') !== '1 of 1'
      || eventAttributionTeamId(freeThrow) !== scoringTeamId) continue;

    const freeThrowStatistic = statisticForType(freeThrow, 'freethrow');
    const freeThrowType = normalizeStatus(freeThrowStatistic?.free_throw_type ?? freeThrowStatistic?.freeThrowType);
    const expectedFreeThrowScore = freeThrowMade
      ? scoringTeamId === homeTeamId
        ? scores[freeThrowIndex].homeDelta === 1 && scores[freeThrowIndex].awayDelta === 0
        : scores[freeThrowIndex].awayDelta === 1 && scores[freeThrowIndex].homeDelta === 0
      : isZeroScoreDelta(scores[freeThrowIndex]);
    if (!freeThrowStatistic
      || freeThrowType !== 'regular'
      || freeThrowStatistic.made !== freeThrowMade
      || statisticTeamId(freeThrowStatistic) !== scoringTeamId
      || statisticPlayerId(freeThrowStatistic) !== fieldGoalPlayerId
      || !expectedFreeThrowScore) continue;

    if (freeThrowMade) {
      let nextOffensiveTeamId = '';
      for (let index = freeThrowIndex + 1; index < Math.min(events.length, freeThrowIndex + 13); index += 1) {
        if (periodSequence(events[index]) !== periodSequence(fieldGoal) || isPeriodEndEvent(events[index])) break;
        nextOffensiveTeamId = offensiveActionTeamId(events[index])
          || regularFreeThrowOffenseTeamId(events[index], events[index - 1], scores[index - 1]);
        if (nextOffensiveTeamId) break;
      }
      if (nextOffensiveTeamId !== defendingTeamId) continue;
    } else {
      // A missed and-one does not necessarily have a later shot or turnover
      // before the possession changes hands. The immediate, structured rebound
      // is the direct ownership evidence, so require it rather than guessing
      // from an arbitrary later offensive action.
      const rebound = events[freeThrowIndex + 1];
      const reboundScore = scores[freeThrowIndex + 1];
      const reboundStatistic = statisticForType(rebound, 'rebound');
      const reboundTeamId = statisticTeamId(reboundStatistic);
      const reboundPossessionTeamId = postEventPossessionTeamId(rebound);
      if (!rebound
        || periodSequence(freeThrow) !== periodSequence(rebound)
        || !isReboundEvent(rebound)
        || !isZeroScoreDelta(reboundScore)
        || !reboundStatistic
        || (reboundTeamId !== scoringTeamId && reboundTeamId !== defendingTeamId)
        || eventAttributionTeamId(rebound) !== reboundTeamId
        || reboundPossessionTeamId !== reboundTeamId) continue;
    }

    const context = { scoringTeamId, defendingTeamId, fieldGoalIndex, freeThrowIndex };
    for (let index = fieldGoalIndex; index <= freeThrowIndex; index += 1) {
      contexts.set(index, {
        ...context,
        isStart: index === fieldGoalIndex,
        effectivePossessionTeamId: index === freeThrowIndex && freeThrowMade ? defendingTeamId : scoringTeamId
      });
    }
    ambiguousEventIds.delete(candidateEventId);
  }
  return { contexts, ambiguousEventIds: stableFlags(ambiguousEventIds) };
}

function makePossession({ ordinal, gameId, providerId, sourcePossessionId: explicitSourcePossessionId, possessionSource = 'provider_post_event_state', offenseTeamId, defenseTeamId, event, score, snapshot, homeLineup, awayLineup, currentStint, includeStartEventContext, qualityFlags = [] }) {
  const sourcePossessionId = explicitSourcePossessionId || providerId || `provider-post-event-state:${ordinal}:${event.id}`;
  const scoreKnown = score.known && !score.invalid;
  return {
    id: deterministicUuidV5(NBA_POSSESSION_UUID_NAMESPACE, `${gameId}:${sourcePossessionId}:${ordinal}`),
    sourcePossessionId,
    possessionOrdinal: ordinal,
    offenseProviderTeamId: offenseTeamId,
    defenseProviderTeamId: defenseTeamId,
    homeLineupId: homeLineup?.id ?? null,
    awayLineupId: awayLineup?.id ?? null,
    startEventId: event.id,
    terminalEventId: null,
    periodSequence: periodSequence(event.raw),
    clockRemainingMs: asNonNegativeInteger(event.raw.clockRemainingMs ?? event.raw.clock_remaining_ms),
    homePointsBefore: score.homeAfter,
    awayPointsBefore: score.awayAfter,
    offensePoints: 0,
    defensePoints: 0,
    isClutchV1: isClutchV1({
      periodNumber: observedPeriodNumber(event.raw),
      clockRemainingMs: asNonNegativeInteger(event.raw.clockRemainingMs ?? event.raw.clock_remaining_ms),
      homePointsBefore: scoreKnown ? score.homeAfter : null,
      awayPointsBefore: scoreKnown ? score.awayAfter : null
    }),
    homeScoreStateV1: homeScoreStateV1(
      scoreKnown ? score.homeAfter : null,
      scoreKnown ? score.awayAfter : null
    ),
    transitionContext: 'unclassified',
    transitionSource: 'unavailable',
    hasLineupChangeMidPossession: !snapshot.isValid,
    possessionSource,
    qualityFlagSet: new Set([
      ...(snapshot.isValid ? [] : ['missing_valid_start_lineup']),
      ...qualityFlags
    ]),
    // A transition event belongs to the possession that just ended. Its
    // fast-break qualifier must not leak into the possession that begins after
    // that event. The opening event of a document/period has no prior active
    // possession, so its context is retained.
    qualifierEvidence: includeStartEventContext && hasQualifierEvidence(event.raw),
    providerFastbreak: includeStartEventContext && hasProviderFastbreakQualifier(event.raw.qualifiers ?? event.raw.qualifier),
    hasObservedPossessionAction: includeStartEventContext && isObservedPossessionAction(event.raw),
    startStintOrdinal: currentStint?.stintOrdinal ?? null,
    lastEventId: event.id
  };
}

function addEventScoreToPossession(possession, score, homeTeamId) {
  if (!possession || !score.known || score.invalid) return;
  const offenseIsHome = possession.offenseProviderTeamId === homeTeamId;
  const offenseDelta = offenseIsHome ? score.homeDelta : score.awayDelta;
  const defenseDelta = offenseIsHome ? score.awayDelta : score.homeDelta;
  addNumeric(possession, 'offensePoints', offenseDelta);
  addNumeric(possession, 'defensePoints', defenseDelta);
}

function sparseRegularFreeThrowPostState({ possession, event, score, snapshot, homeTeamId, awayTeamId }) {
  const freeThrowMade = isMadeFreeThrowEvent(event);
  if (!possession
    || (!freeThrowMade && !isMissedFreeThrowEvent(event))
    || possession.periodSequence !== periodSequence(event)
    || postEventPossessionTeamId(event)) return null;
  const scoringTeamId = possession.offenseProviderTeamId;
  if (scoringTeamId !== homeTeamId && scoringTeamId !== awayTeamId) return null;
  if (eventAttributionTeamId(event) !== scoringTeamId) return null;

  const statistic = statisticForType(event, 'freethrow');
  const freeThrowType = normalizeStatus(statistic?.free_throw_type ?? statistic?.freeThrowType);
  const attemptMatch = asTrimmedString(event?.attempt).match(/^(\d+)\s+of\s+(\d+)$/i);
  if (!statistic
    || freeThrowType !== 'regular'
    || statistic.made !== freeThrowMade
    || statisticTeamId(statistic) !== scoringTeamId
    || !attemptMatch) return null;
  const attemptNumber = Number(attemptMatch[1]);
  const attemptTotal = Number(attemptMatch[2]);
  if (!Number.isInteger(attemptNumber)
    || !Number.isInteger(attemptTotal)
    || attemptNumber < 1
    || attemptTotal < 1
    || attemptNumber > attemptTotal) return null;

  if (freeThrowMade) {
    if (!score.known || score.invalid || !snapshot.isValid) return null;
    const offenseIsHome = scoringTeamId === homeTeamId;
    const offenseDelta = offenseIsHome ? score.homeDelta : score.awayDelta;
    const defenseDelta = offenseIsHome ? score.awayDelta : score.homeDelta;
    if (offenseDelta !== 1 || defenseDelta !== 0) return null;
  } else if (!isZeroScoreDelta(score)) {
    return null;
  }

  const isFinalAttempt = attemptNumber === attemptTotal;
  const defendingTeamId = scoringTeamId === homeTeamId ? awayTeamId : homeTeamId;
  return {
    effectivePossessionTeamId: freeThrowMade && isFinalAttempt ? defendingTeamId : isFinalAttempt ? '' : scoringTeamId,
    freeThrowMade,
    isFinalAttempt
  };
}

function retainedTechnicalFreeThrowState({ possession, event, score, snapshot, previousEvent, homeTeamId, awayTeamId }) {
  const freeThrowMade = isMadeFreeThrowEvent(event);
  if (!possession
    || (!freeThrowMade && !isMissedFreeThrowEvent(event))
    || possession.periodSequence !== periodSequence(event)
    || postEventPossessionTeamId(event)
    || !previousEvent?.raw
    || !samePeriodAndClock(previousEvent.raw, event)
    || !isTechnicalFoulEvent(previousEvent.raw)
    || !isZeroScoreDelta(previousEvent.score)) return null;

  const scoringTeamId = possession.offenseProviderTeamId;
  if (scoringTeamId !== homeTeamId && scoringTeamId !== awayTeamId) return null;
  const defendingTeamId = scoringTeamId === homeTeamId ? awayTeamId : homeTeamId;
  if (eventAttributionTeamId(previousEvent.raw) !== defendingTeamId
    || postEventPossessionTeamId(previousEvent.raw) !== scoringTeamId
    || eventAttributionTeamId(event) !== scoringTeamId) return null;

  const statistic = statisticForType(event, 'freethrow');
  const freeThrowType = normalizeStatus(statistic?.free_throw_type ?? statistic?.freeThrowType);
  if (!statistic
    || freeThrowType !== 'technical'
    || statistic.made !== freeThrowMade
    || statisticTeamId(statistic) !== scoringTeamId
    || !statisticPlayerId(statistic)
    || asTrimmedString(event?.attempt).toLowerCase().replace(/\s+/g, ' ') !== '1 of 1'
    || !snapshot.isValid
    || !score.known
    || score.invalid) return null;

  const offenseIsHome = scoringTeamId === homeTeamId;
  const offenseDelta = offenseIsHome ? score.homeDelta : score.awayDelta;
  const defenseDelta = offenseIsHome ? score.awayDelta : score.homeDelta;
  if (freeThrowMade ? offenseDelta !== 1 || defenseDelta !== 0 : !isZeroScoreDelta(score)) return null;

  return { retained: true, freeThrowMade };
}

function updatePossessionContext(possession, event, snapshot, homeLineup, awayLineup, currentStint) {
  if (!possession) return;
  possession.lastEventId = event.id;
  possession.qualifierEvidence ||= hasQualifierEvidence(event.raw);
  possession.providerFastbreak ||= hasProviderFastbreakQualifier(event.raw.qualifiers ?? event.raw.qualifier);
  if (!snapshot.isValid) {
    if (snapshot.snapshotStatus === 'missing') {
      possession.hasObservedPossessionAction ||= isObservedPossessionAction(event.raw);
      return;
    }
    possession.hasLineupChangeMidPossession = true;
    addFlag(possession.qualityFlagSet, 'missing_valid_lineup_during_possession');
    possession.hasObservedPossessionAction ||= isObservedPossessionAction(event.raw);
    return;
  }
  const lineupChanged = possession.homeLineupId !== homeLineup?.id || possession.awayLineupId !== awayLineup?.id;
  const scoreUnchanged = event.score.known
    && !event.score.invalid
    && event.score.homeDelta === 0
    && event.score.awayDelta === 0;
  const canRebaseDeadBallSubstitution = Boolean(lineupChanged
    && isLineupChangeEvent(event.raw)
    && !possession.hasObservedPossessionAction
    && possession.offensePoints === 0
    && possession.defensePoints === 0
    && scoreUnchanged
    && postEventPossessionTeamId(event.raw) === possession.offenseProviderTeamId
    && currentStint);
  if (canRebaseDeadBallSubstitution) {
    possession.homeLineupId = homeLineup.id;
    possession.awayLineupId = awayLineup.id;
    possession.startStintOrdinal = currentStint.stintOrdinal;
    possession.startEventId = event.id;
    possession.clockRemainingMs = asNonNegativeInteger(event.raw.clockRemainingMs ?? event.raw.clock_remaining_ms);
    possession.homePointsBefore = event.score.homeAfter;
    possession.awayPointsBefore = event.score.awayAfter;
    possession.isClutchV1 = isClutchV1({
      periodNumber: observedPeriodNumber(event.raw),
      clockRemainingMs: possession.clockRemainingMs,
      homePointsBefore: event.score.homeAfter,
      awayPointsBefore: event.score.awayAfter
    });
    possession.homeScoreStateV1 = homeScoreStateV1(event.score.homeAfter, event.score.awayAfter);
    addFlag(possession.qualityFlagSet, 'dead_ball_substitution_rebased_possession_start');
  } else if (lineupChanged) {
    possession.hasLineupChangeMidPossession = true;
    addFlag(possession.qualityFlagSet, 'lineup_changed_mid_possession');
  }
  possession.hasObservedPossessionAction ||= isObservedPossessionAction(event.raw);
}

function finalizePossession(possession, terminalEventId, reason, stintByOrdinal, homeTeamId) {
  if (!possession) return null;
  possession.terminalEventId = terminalEventId ?? possession.lastEventId;
  if (reason) addFlag(possession.qualityFlagSet, reason);
  if (possession.providerFastbreak) {
    possession.transitionContext = 'provider_fastbreak_v1';
    possession.transitionSource = 'provider_qualifier';
  } else if (possession.qualifierEvidence) {
    // This only says that no provider fast-break qualifier was present. It is
    // intentionally not called a half-court possession.
    possession.transitionContext = 'non_provider_fastbreak';
    possession.transitionSource = 'provider_qualifier';
  }

  const startStint = possession.startStintOrdinal === null ? null : stintByOrdinal.get(possession.startStintOrdinal);
  const canAttributeToStint = startStint
    && possession.homeLineupId
    && possession.awayLineupId
    && !possession.hasLineupChangeMidPossession;
  if (canAttributeToStint) {
    if (possession.offenseProviderTeamId === homeTeamId) {
      startStint.homeOffensivePossessions += 1;
      startStint.homePoints += possession.offensePoints;
      startStint.awayPoints += possession.defensePoints;
    } else {
      startStint.awayOffensivePossessions += 1;
      startStint.awayPoints += possession.offensePoints;
      startStint.homePoints += possession.defensePoints;
    }
  } else if (startStint) {
    addFlag(startStint.qualityFlagSet, 'possession_excluded_for_mid_or_missing_lineup');
  }

  const {
    qualityFlagSet,
    qualifierEvidence,
    providerFastbreak,
    hasObservedPossessionAction,
    startStintOrdinal,
    lastEventId,
    ...row
  } = possession;
  return { ...row, qualityFlags: stableFlags(qualityFlagSet) };
}

function combineAnalytics(stints, lineupRegistry, homeTeamId, awayTeamId, gameId) {
  const totalsByKey = new Map();
  const addPerspective = (stint, lineupId, teamId, pointsFor, pointsAgainst, offensivePossessions, defensivePossessions) => {
    const lineup = lineupRegistry.byId.get(lineupId);
    if (!lineup || !teamId) return;
    for (const combination of expandLineupCombinations({ providerTeamId: teamId, lineupId, playerIds: lineup.playerIds })) {
      const key = `${teamId}:${combination.combinationKey}`;
      if (!totalsByKey.has(key)) {
        totalsByKey.set(key, {
          ...combination,
          // A two-to-four-player unit can occur inside several exact fives.
          // Do not retain the first arbitrary exact lineup as its identity.
          exactLineupId: combination.playerCount === 5 ? combination.exactLineupId : null,
          sourceExactLineupIds: new Set([lineupId]),
          durationMs: 0,
          stintCount: 0,
          gameIds: new Set(),
          pointsFor: 0,
          pointsAgainst: 0,
          offensivePossessions: 0,
          defensivePossessions: 0
        });
      }
      const total = totalsByKey.get(key);
      total.sourceExactLineupIds.add(lineupId);
      total.durationMs += stint.durationMs;
      total.stintCount += 1;
      total.gameIds.add(gameId);
      total.pointsFor += pointsFor;
      total.pointsAgainst += pointsAgainst;
      total.offensivePossessions += offensivePossessions;
      total.defensivePossessions += defensivePossessions;
    }
  };
  for (const stint of stints) {
    addPerspective(
      stint,
      stint.homeLineupId,
      homeTeamId,
      stint.homePoints,
      stint.awayPoints,
      stint.homeOffensivePossessions,
      stint.awayOffensivePossessions
    );
    addPerspective(
      stint,
      stint.awayLineupId,
      awayTeamId,
      stint.awayPoints,
      stint.homePoints,
      stint.awayOffensivePossessions,
      stint.homeOffensivePossessions
    );
  }
  return [...totalsByKey.values()]
    .map(({ gameIds, sourceExactLineupIds, ...total }) => ({
      ...total,
      ...metricsForTotals({ ...total, gameCount: gameIds.size }),
      gameCount: gameIds.size,
      sourceExactLineupIds: [...sourceExactLineupIds].sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => (
      left.providerTeamId.localeCompare(right.providerTeamId)
      || left.playerCount - right.playerCount
      || left.combinationKey.localeCompare(right.combinationKey)
    ));
}

function validateMinutes(stints, lineupRegistry, input) {
  const expected = minuteExpectationMap(input);
  if (!expected.size) return { provided: false, verified: null, toleranceMinutes: null, mismatches: [] };
  const reconstructedMs = new Map();
  for (const stint of stints) {
    for (const lineupId of [stint.homeLineupId, stint.awayLineupId]) {
      const lineup = lineupRegistry.byId.get(lineupId);
      if (!lineup) continue;
      for (const playerId of lineup.playerIds) {
        reconstructedMs.set(playerId, (reconstructedMs.get(playerId) ?? 0) + stint.durationMs);
      }
    }
  }
  const toleranceMinutes = asFiniteNumber(input?.playerMinutesToleranceMinutes) ?? 0.02;
  const mismatches = [];
  for (const [playerId, expectedMinutes] of expected.entries()) {
    const reconstructedMinutes = (reconstructedMs.get(playerId) ?? 0) / 60000;
    if (Math.abs(reconstructedMinutes - expectedMinutes) > toleranceMinutes) {
      mismatches.push({ playerId, expectedMinutes, reconstructedMinutes });
    }
  }
  return { provided: true, verified: mismatches.length === 0, toleranceMinutes, mismatches };
}

function validationFor({ input, stints, possessions, lineupRegistry, lastScore, errors, warnings }) {
  const metadata = resolveGameMetadata(input);
  const expectedFinal = extractExpectedFinalScore(input);
  const finalProvided = expectedFinal.homePoints !== null && expectedFinal.awayPoints !== null;
  const finalVerified = finalProvided
    ? lastScore.home === expectedFinal.homePoints && lastScore.away === expectedFinal.awayPoints
    : null;
  if (finalVerified === false) errors.push('final_score_mismatch');

  const expectedPossessions = extractExpectedPossessions(input);
  const homePossessions = possessions.filter((row) => row.offenseProviderTeamId === metadata.homeTeamId).length;
  const awayPossessions = possessions.filter((row) => row.offenseProviderTeamId === metadata.awayTeamId).length;
  const possessionProvided = expectedPossessions.home !== null && expectedPossessions.away !== null;
  const playedPeriodCount = new Set(sortPbpEvents(input?.events).map((event) => periodSequence(event))).size;
  const validTeamAttribution = possessions.every((row) => (
    (row.offenseProviderTeamId === metadata.homeTeamId && row.defenseProviderTeamId === metadata.awayTeamId)
    || (row.offenseProviderTeamId === metadata.awayTeamId && row.defenseProviderTeamId === metadata.homeTeamId)
  ));
  const contiguousOrdinals = possessions.every((row, index) => row.possessionOrdinal === index + 1);
  const integerCounts = Number.isInteger(homePossessions) && Number.isInteger(awayPossessions)
    && homePossessions >= 0 && awayPossessions >= 0 && homePossessions + awayPossessions > 0;
  const periodImbalanceVerified = playedPeriodCount > 0
    && Math.abs(homePossessions - awayPossessions) <= playedPeriodCount;
  let assignedHomePoints = 0;
  let assignedAwayPoints = 0;
  for (const possession of possessions) {
    if (possession.offenseProviderTeamId === metadata.homeTeamId) {
      assignedHomePoints += possession.offensePoints;
      assignedAwayPoints += possession.defensePoints;
    } else if (possession.offenseProviderTeamId === metadata.awayTeamId) {
      assignedAwayPoints += possession.offensePoints;
      assignedHomePoints += possession.defensePoints;
    }
  }
  const scoreAssignmentVerified = assignedHomePoints === lastScore.home && assignedAwayPoints === lastScore.away;
  const possessionVerified = validTeamAttribution
    && contiguousOrdinals
    && integerCounts
    && periodImbalanceVerified
    && scoreAssignmentVerified;
  if (!validTeamAttribution) errors.push('invalid_reconstructed_possession_team_attribution');
  if (!contiguousOrdinals) errors.push('non_contiguous_reconstructed_possession_ordinals');
  if (!integerCounts) errors.push('invalid_reconstructed_possession_counts');
  if (!periodImbalanceVerified) errors.push('reconstructed_possession_period_imbalance');
  if (!scoreAssignmentVerified) errors.push('reconstructed_possession_score_assignment_mismatch');

  const estimateDelta = (estimated, observed) => {
    if (estimated === null) return { absolute: null, relative: null };
    const absolute = Math.abs(observed - estimated);
    return { absolute, relative: estimated > 0 ? absolute / estimated : null };
  };
  const homeEstimateDelta = estimateDelta(expectedPossessions.home, homePossessions);
  const awayEstimateDelta = estimateDelta(expectedPossessions.away, awayPossessions);
  const estimateAlertAbsolute = asFiniteNumber(input?.possessionEstimateAlertAbsolute) ?? 10;
  const estimateAlertRelative = asFiniteNumber(input?.possessionEstimateAlertRelative) ?? 0.1;
  const estimateDiverges = (delta) => delta.absolute !== null
    && delta.relative !== null
    && delta.absolute > estimateAlertAbsolute
    && delta.relative > estimateAlertRelative;
  const estimateWithinAlertThreshold = possessionProvided
    ? !estimateDiverges(homeEstimateDelta) && !estimateDiverges(awayEstimateDelta)
    : null;
  if (estimateWithinAlertThreshold === false) warnings.push('provider_possession_estimate_divergence');

  const playerMinutes = validateMinutes(stints, lineupRegistry, input);
  if (playerMinutes.verified === false) warnings.push('provider_player_minutes_mismatch');

  const durationMs = stints.reduce((sum, stint) => sum + stint.durationMs, 0);
  return {
    finalScore: {
      expectedHomePoints: expectedFinal.homePoints,
      expectedAwayPoints: expectedFinal.awayPoints,
      observedHomePoints: lastScore.home,
      observedAwayPoints: lastScore.away,
      provided: finalProvided,
      verified: finalVerified
    },
    possessionTotals: {
      summaryEstimatedHomePossessions: expectedPossessions.home,
      summaryEstimatedAwayPossessions: expectedPossessions.away,
      observedHomePossessions: homePossessions,
      observedAwayPossessions: awayPossessions,
      provided: possessionProvided,
      verified: possessionVerified,
      structuralChecks: {
        validTeamAttribution,
        contiguousOrdinals,
        integerCounts,
        playedPeriodCount,
        periodImbalanceVerified,
        assignedHomePoints,
        assignedAwayPoints,
        scoreAssignmentVerified
      },
      summaryEstimateComparison: {
        homeAbsoluteDelta: homeEstimateDelta.absolute,
        homeRelativeDelta: homeEstimateDelta.relative,
        awayAbsoluteDelta: awayEstimateDelta.absolute,
        awayRelativeDelta: awayEstimateDelta.relative,
        alertAbsoluteThreshold: estimateAlertAbsolute,
        alertRelativeThreshold: estimateAlertRelative,
        withinAlertThreshold: estimateWithinAlertThreshold,
        publicationGate: false
      }
    },
    playerMinutes,
    stints: {
      stintCount: stints.length,
      durationMs,
      allDurationsNonNegative: stints.every((stint) => stint.durationMs >= 0)
    },
    errors: stableFlags(errors),
    warnings: stableFlags(warnings)
  };
}

/**
 * Reconstruct one closed, full-coverage game. This function is deterministic:
 * input ordering, duplicate representations of a canonical lineup, and source
 * timestamps cannot change its output.
 */
export function reconstructNbaGameLineups(input = {}) {
  const metadata = resolveGameMetadata(input);
  const errors = [];
  const warnings = [];
  if (!metadata.gameId) errors.push('missing_game_id');
  if (!metadata.homeTeamId || !metadata.awayTeamId || metadata.homeTeamId === metadata.awayTeamId) errors.push('invalid_game_teams');
  if (metadata.status !== 'closed') errors.push('game_not_closed');
  if (metadata.coverage !== 'full') errors.push('coverage_not_full');
  if (metadata.trackOnCourt !== true) errors.push('track_on_court_not_confirmed');

  const events = sortPbpEvents(input.events);
  if (!events.length) errors.push('no_play_by_play_events');
  const andOneIdentification = identifyAndOneContinuations(events, metadata.homeTeamId, metadata.awayTeamId);
  const andOneContexts = andOneIdentification.contexts;
  for (const id of andOneIdentification.ambiguousEventIds) errors.push(`ambiguous_and_one_state_reversal:${id}`);

  const registry = createLineupRegistry();
  const stints = [];
  const stintByOrdinal = new Map();
  const possessions = [];
  const enrichedEvents = [];
  let currentStint = null;
  let currentHomeLineup = null;
  let currentAwayLineup = null;
  let activePossession = null;
  let possessionOrdinal = 0;
  let lastScore = { home: 0, away: 0 };
  let lastEvent = null;
  let invalidSnapshotCount = 0;
  let validSnapshotCount = 0;
  let scoringEvents = 0;
  const periodOpeningCandidates = new Map();

  const finalizeActivePossession = (terminalEvent, reason) => {
    if (!activePossession) return;
    const terminalEventId = terminalEvent?.id ?? terminalEvent ?? null;
    const terminalIsPeriodEnd = terminalEvent?.raw && isPeriodEndEvent(terminalEvent.raw);
    if (terminalEvent?.snapshot && !terminalEvent.snapshot.isValid && !terminalIsPeriodEnd) {
      errors.push(`possession_terminal_event_missing_valid_snapshot:${terminalEventId}`);
    }
    const finalized = finalizePossession(activePossession, terminalEventId, reason, stintByOrdinal, metadata.homeTeamId);
    if (finalized) possessions.push(finalized);
    activePossession = null;
  };

  const closeAndResetLineupState = (endElapsedMs, endEventId, flags = []) => {
    if (currentStint) closeStint(currentStint, endElapsedMs, endEventId, flags);
    currentStint = null;
    currentHomeLineup = null;
    currentAwayLineup = null;
  };

  const startStintForSnapshot = (snapshot, event, elapsedMs) => {
    const homeLineup = registry.ensure(metadata.homeTeamId, snapshot.homePlayerIds);
    const awayLineup = registry.ensure(metadata.awayTeamId, snapshot.awayPlayerIds);
    if (!homeLineup || !awayLineup) {
      errors.push('unable_to_register_valid_lineup');
      return;
    }
    const sameLineups = currentStint
      && currentHomeLineup?.id === homeLineup.id
      && currentAwayLineup?.id === awayLineup.id;
    if (sameLineups) return;
    const safeElapsed = elapsedMs ?? currentStint?.endElapsedMs ?? 0;
    if (currentStint) {
      const flags = safeElapsed === currentStint.startElapsedMs ? ['same_clock_snapshot_change'] : [];
      closeStint(currentStint, safeElapsed, event.id, flags);
    }
    currentHomeLineup = homeLineup;
    currentAwayLineup = awayLineup;
    currentStint = makeStint({
      ordinal: stints.length + 1,
      homeLineup,
      awayLineup,
      startEventId: event.id,
      startElapsedMs: safeElapsed
    });
    if (elapsedMs === null) addFlag(currentStint.qualityFlagSet, 'missing_event_clock');
    stints.push(currentStint);
    stintByOrdinal.set(currentStint.stintOrdinal, currentStint);
  };

  for (let index = 0; index < events.length; index += 1) {
    const raw = events[index];
    const id = eventId(raw, index);
    const elapsedMs = gameElapsedMs(raw);
    const snapshot = validateOnCourtSnapshot(raw);
    const score = scoreDelta(lastScore, raw);
    const providerPossessionTeamId = postEventPossessionTeamId(raw);
    const isScoring = score.known && (score.homeDelta > 0 || score.awayDelta > 0);
    if (isScoring) scoringEvents += 1;
    if (score.invalid) errors.push(`non_monotonic_score:${id}`);
    if (!score.known) {
      warnings.push(`missing_score_after:${id}`);
      if (eventMayChangeScore(raw)) {
        errors.push(`missing_score_for_scoring_event:${id}`);
      } else if (activePossession
        && (providerPossessionTeamId === metadata.homeTeamId || providerPossessionTeamId === metadata.awayTeamId)
        && providerPossessionTeamId !== activePossession.offenseProviderTeamId) {
        errors.push(`missing_score_at_possession_transition:${id}`);
      }
    }

    const event = { id, raw, elapsedMs, snapshot, score };
    const priorPeriod = lastEvent ? periodSequence(lastEvent.raw) : null;
    const crossedPeriodBoundary = priorPeriod !== null && periodSequence(raw) !== priorPeriod;
    if (crossedPeriodBoundary) {
      if (activePossession) finalizeActivePossession(lastEvent, 'period_boundary_closed');
      if (currentStint) {
        closeAndResetLineupState(
          elapsedMs ?? lastEvent?.elapsedMs ?? currentStint.startElapsedMs,
          lastEvent?.id ?? id,
          ['period_boundary_lineup_reset']
        );
      }
      periodOpeningCandidates.set(periodSequence(raw), { canInfer: true });
    }

    if (snapshot.isValid) {
      validSnapshotCount += 1;
      startStintForSnapshot(snapshot, event, elapsedMs);
    } else {
      invalidSnapshotCount += 1;
      if (isScoring) errors.push(`score_event_missing_valid_snapshot:${id}`);
      if (isLineupChangeEvent(raw)) errors.push(`lineup_change_missing_valid_snapshot:${id}`);
      if (currentStint && snapshot.snapshotStatus !== 'missing' && !isPeriodEndEvent(raw)) {
        addFlag(currentStint.qualityFlagSet, 'carried_across_invalid_snapshot_event');
      }
    }

    const periodOpeningCandidate = periodOpeningCandidates.get(periodSequence(raw)) ?? null;
    const openingScoringTeamId = scoringTeamForMadeFieldGoal(
      raw,
      score,
      metadata.homeTeamId,
      metadata.awayTeamId
    );
    const openingDefendingTeamId = openingScoringTeamId === metadata.homeTeamId
      ? metadata.awayTeamId
      : openingScoringTeamId === metadata.awayTeamId
        ? metadata.homeTeamId
        : '';
    const canInferPeriodOpeningPossession = Boolean(
      !activePossession
      && periodOpeningCandidate?.canInfer
      && snapshot.isValid
      && currentStint
      && currentHomeLineup
      && currentAwayLineup
      && isMadeFieldGoalEvent(raw)
      && openingScoringTeamId
      && hasVerifiedMadeFieldGoalForTeam(raw, openingScoringTeamId)
      && providerPossessionTeamId === openingDefendingTeamId
    );
    if (canInferPeriodOpeningPossession) {
      possessionOrdinal += 1;
      activePossession = makePossession({
        ordinal: possessionOrdinal,
        gameId: metadata.gameId || 'missing-game-id',
        sourcePossessionId: `inferred-period-opening-offense:${periodSequence(raw)}:${id}`,
        possessionSource: 'inferred_period_opening_made_field_goal',
        offenseTeamId: openingScoringTeamId,
        defenseTeamId: openingDefendingTeamId,
        event,
        score: {
          ...score,
          homeAfter: score.homeBefore,
          awayAfter: score.awayBefore
        },
        snapshot,
        homeLineup: currentHomeLineup,
        awayLineup: currentAwayLineup,
        currentStint,
        includeStartEventContext: true,
        qualityFlags: ['inferred_period_opening_offense_from_first_made_field_goal']
      });
    }
    const andOneContext = andOneContexts.get(index) ?? null;
    const applyAndOneContext = andOneContext
      && activePossession?.offenseProviderTeamId === andOneContext.scoringTeamId;
    if (andOneContext?.isStart && !applyAndOneContext) {
      errors.push(`and_one_continuation_without_active_scoring_possession:${id}`);
    }
    if (applyAndOneContext) {
      addFlag(activePossession.qualityFlagSet, 'provider_and_one_state_reversal_merged');
    }
    const sparseFreeThrowState = !applyAndOneContext && !providerPossessionTeamId
      ? sparseRegularFreeThrowPostState({
        possession: activePossession,
        event: raw,
        score,
        snapshot,
        homeTeamId: metadata.homeTeamId,
        awayTeamId: metadata.awayTeamId
      })
      : null;
    const technicalFreeThrowState = !applyAndOneContext && !providerPossessionTeamId
      ? retainedTechnicalFreeThrowState({
        possession: activePossession,
        event: raw,
        score,
        snapshot,
        previousEvent: lastEvent,
        homeTeamId: metadata.homeTeamId,
        awayTeamId: metadata.awayTeamId
      })
      : null;
    const possessionTeamId = applyAndOneContext
      ? andOneContext.effectivePossessionTeamId
      : providerPossessionTeamId || sparseFreeThrowState?.effectivePossessionTeamId || '';
    const knownPossessionTeam = possessionTeamId === metadata.homeTeamId || possessionTeamId === metadata.awayTeamId;
    if (possessionTeamId && !knownPossessionTeam) errors.push(`unknown_provider_possession_team:${id}`);
    const retainedSparseFreeThrowPossession = Boolean(sparseFreeThrowState)
      && !knownPossessionTeam;
    const retainedTechnicalFreeThrowPossession = Boolean(technicalFreeThrowState)
      && !knownPossessionTeam;

    if (activePossession) {
      addEventScoreToPossession(activePossession, score, metadata.homeTeamId);
      if (!(isPeriodEndEvent(raw) && !snapshot.isValid)) {
        updatePossessionContext(activePossession, event, snapshot, currentHomeLineup, currentAwayLineup, currentStint);
      }
      if (sparseFreeThrowState) {
        addFlag(activePossession.qualityFlagSet, 'provider_regular_free_throw_state_inferred');
      }
      if (technicalFreeThrowState) {
        addFlag(activePossession.qualityFlagSet, 'provider_technical_free_throw_state_retained');
      }
    } else if (isScoring) {
      // We cannot credit a score to a possession that began before the first
      // known provider possession state in the observed period.
      errors.push(`score_event_without_active_provider_possession:${id}`);
    }

    if (isScoring
      && !knownPossessionTeam
      && !retainedSparseFreeThrowPossession
      && !retainedTechnicalFreeThrowPossession) {
      errors.push(`score_event_missing_provider_possession_state:${id}`);
    }

    if (knownPossessionTeam) {
      let startedAfterTransition = false;
      if (activePossession && activePossession.offenseProviderTeamId !== possessionTeamId) {
        finalizeActivePossession(event, 'provider_possession_transition');
        startedAfterTransition = true;
      }
      const eventEndsPeriod = asNonNegativeInteger(raw.clockRemainingMs ?? raw.clock_remaining_ms) === 0;
      if (!activePossession && !isGameEndEvent(raw) && !eventEndsPeriod) {
        if (!snapshot.isValid) errors.push(`possession_start_event_missing_valid_snapshot:${id}`);
        possessionOrdinal += 1;
        const defenseTeamId = possessionTeamId === metadata.homeTeamId ? metadata.awayTeamId : metadata.homeTeamId;
        activePossession = makePossession({
          ordinal: possessionOrdinal,
          gameId: metadata.gameId || 'missing-game-id',
          providerId: providerPossessionId(raw),
          offenseTeamId: possessionTeamId,
          defenseTeamId,
          event,
          score,
          snapshot,
          homeLineup: currentHomeLineup,
          awayLineup: currentAwayLineup,
          currentStint,
          includeStartEventContext: !startedAfterTransition
        });
      }
    }

    if (isPeriodEndEvent(raw)) {
      finalizeActivePossession(event, 'provider_period_end');
      closeAndResetLineupState(elapsedMs ?? currentStint?.endElapsedMs ?? 0, id);
    }

    if (periodOpeningCandidate
      && (providerPossessionTeamId || !isPeriodOpeningAdministrativeEvent(raw))) {
      periodOpeningCandidate.canInfer = false;
    }

    if (score.known && !score.invalid) lastScore = { home: score.homeAfter, away: score.awayAfter };
    enrichedEvents.push({
      id,
      periodSequence: periodSequence(raw),
      elapsedMs,
      homePointsBefore: score.homeBefore,
      awayPointsBefore: score.awayBefore,
      homePointsAfter: score.homeAfter,
      awayPointsAfter: score.awayAfter,
      homePointDelta: score.homeDelta,
      awayPointDelta: score.awayDelta,
      snapshotStatus: snapshot.snapshotStatus,
      providerPossessionTeamId: providerPossessionTeamId || null,
      possessionTeamId: knownPossessionTeam ? possessionTeamId : null
    });
    lastEvent = event;
  }

  if (activePossession) finalizeActivePossession(lastEvent, 'document_end_closed');

  const confirmedGameEnd = isPotentialGameEnd(lastEvent?.raw, events);
  if (events.length && !confirmedGameEnd) errors.push('document_ended_before_confirmed_game_end');

  if (currentStint) {
    const lastElapsed = lastEvent?.elapsedMs;
    const expectedEnd = confirmedGameEnd ? expectedGameEndMs(events) : null;
    const endElapsed = expectedEnd ?? lastElapsed ?? currentStint.startElapsedMs;
    if (expectedEnd === null) addFlag(currentStint.qualityFlagSet, 'document_ended_before_confirmed_game_end');
    closeStint(currentStint, endElapsed, lastEvent?.id ?? null);
  }

  const publicStints = stints.map(publicStint);
  const validation = validationFor({
    input,
    stints: publicStints,
    possessions,
    lineupRegistry: registry,
    lastScore,
    errors,
    warnings
  });

  let coverageStatus = 'eligible';
  if (validation.errors.length || !publicStints.length || !possessions.length) coverageStatus = 'ineligible';
  else if (validation.possessionTotals.verified === false || validation.playerMinutes.verified === false) coverageStatus = 'partial';

  const combinationAnalytics = combineAnalytics(
    publicStints,
    registry,
    metadata.homeTeamId,
    metadata.awayTeamId,
    metadata.gameId || 'missing-game-id'
  );
  const lineupDefinitions = registry.values();
  const lineupMembers = lineupDefinitions.flatMap((lineup) => lineup.members.map((member) => ({ lineupId: lineup.id, ...member })));
  const lineupCombinations = lineupDefinitions.flatMap((lineup) => expandLineupCombinations({
    providerTeamId: lineup.providerTeamId,
    lineupId: lineup.id,
    playerIds: lineup.playerIds
  }));

  return {
    methodVersion: NBA_LINEUP_RECONSTRUCTION_METHOD_VERSION,
    gameId: metadata.gameId || null,
    coverageStatus,
    isEligible: coverageStatus === 'eligible',
    counts: {
      eventCount: events.length,
      validSnapshotCount,
      invalidSnapshotCount,
      scoringEventCount: scoringEvents,
      stintCount: publicStints.length,
      possessionCount: possessions.length
    },
    events: enrichedEvents,
    lineupDefinitions,
    lineupMembers,
    lineupCombinations,
    stints: publicStints,
    possessions,
    combinationAnalytics,
    validation
  };
}

// A short alias keeps importer call sites readable while preserving the more
// explicit name for users of this library.
export const reconstructNbaLineups = reconstructNbaGameLineups;

export function isKnownScoreStateV1(value) {
  return SCORE_STATE_LABELS.has(asTrimmedString(value));
}
