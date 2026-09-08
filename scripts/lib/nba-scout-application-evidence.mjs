import assert from 'node:assert/strict';
import { BOX_FIELDS } from './nba-summary-completeness.mjs';

export const APPLICATION_EVIDENCE_VERSION = 'nba_scout_application_evidence_v1';
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonnegative = value => numeric(value) !== null && value >= 0 ? value : null;
const divide = (a, b) => numeric(a) !== null && b > 0 ? a / b : null;
const completeSum = values => values.every(value => numeric(value) !== null) ? values.reduce((sum, value) => sum + value, 0) : null;
const token = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const scopeKey = row => `${row.seasonStartYear}~${row.phase}~${row.teamId}~${row.playerId}`;
const teamOf = stat => stat.team?.id ?? stat.team_id ?? stat.teamId;
const playerOf = stat => stat.player?.id ?? stat.player_id ?? stat.playerId;

function increment(histogram, key, amount = 1) { histogram[key] = (histogram[key] || 0) + amount; }
function addHistogram(target, source) { for (const [key, value] of Object.entries(source)) increment(target, key, value); }
function validFive(lineup, expectedTeam) {
  return lineup?.providerTeamId === expectedTeam && lineup.playerIds?.length === 5 && new Set(lineup.playerIds).size === 5;
}

/** Compact, ordered raw observations for application fitting. Retain rejected
 * cohorts with explicit gates; do not change the already validated base fit.
 * Exact point histograms and coupled offense/defense scores preserve rare tails
 * that a 4+ bucket loses. They do not justify independent-possession forecasts.
 */
export function buildApplicationGameEvidence(record, reconstruction, players, sortedEvents) {
  const game = record.game, teams = [game.homeProviderTeamId, game.awayProviderTeamId];
  const scope = { gameId: game.providerGameId, seasonStartYear: game.seasonStartYear,
    phase: game.primaryPhase, scheduledAt: game.scheduledAt };
  const lineups = new Map((reconstruction.lineupDefinitions || []).map(row => [row.id, row]));
  const simulationPossessions = (reconstruction.possessions || []).map((row, index) => {
    const home = lineups.get(row.homeLineupId), away = lineups.get(row.awayLineupId);
    const reasons = [];
    if (reconstruction.isEligible !== true) reasons.push('game-reconstruction-not-eligible');
    if (!validFive(home, teams[0]) || !validFive(away, teams[1])) reasons.push('missing-distinct-five-on-five');
    if (row.hasLineupChangeMidPossession !== false) reasons.push('unstable-or-unknown-lineup');
    if (!teams.includes(row.offenseProviderTeamId) || !teams.includes(row.defenseProviderTeamId)
      || row.offenseProviderTeamId === row.defenseProviderTeamId) reasons.push('invalid-possession-teams');
    if (![row.offensePoints, row.defensePoints].every(value => Number.isSafeInteger(value) && value >= 0)) reasons.push('invalid-point-outcome');
    return { ...scope, ...row, sourceRowOrdinal: index,
      homePlayerIds: home?.playerIds ?? null, awayPlayerIds: away?.playerIds ?? null,
      observationEligible: reasons.length === 0, unavailableReasons: reasons,
      interpretation: 'Observed ordered possession and lineup; no synthetic outcome or causal matchup attribution.' };
  });
  const rotationStints = (reconstruction.stints || []).map((row, index) => {
    const home = lineups.get(row.homeLineupId), away = lineups.get(row.awayLineupId);
    return { ...scope, ...row, sourceRowOrdinal: index,
      homePlayerIds: home?.playerIds ?? null, awayPlayerIds: away?.playerIds ?? null,
      observationEligible: reconstruction.isEligible === true && validFive(home, teams[0]) && validFive(away, teams[1])
        && nonnegative(row.durationMs) !== null,
      interpretation: 'Observed co-presence duration, not a recommended rotation or an interaction coefficient.' };
  });
  const seenEvents = new Set(), shotEvents = [];
  for (const event of sortedEvents) {
    if (event.isRescinded || (event.id && seenEvents.has(event.id))) continue;
    if (event.id) seenEvents.add(event.id);
    const stats = event.statistics || [];
    stats.forEach((stat, statisticOrdinal) => {
      const type = token(stat.type), teamId = teamOf(stat), playerId = playerOf(stat);
      if (!['fieldgoal', 'freethrow'].includes(type) || !teams.includes(teamId) || !playerId) return;
      const eventType = token(event.eventType);
      const made = typeof stat.made === 'boolean' ? stat.made
        : eventType.endsWith('made') ? true : eventType.endsWith('miss') || eventType.endsWith('missed') ? false : null;
      const three = stat.three_point_shot === true || stat.threePointShot === true || eventType.includes('threepoint') || stat.points === 3;
      const pointValue = type === 'freethrow' ? 1 : three ? 3 : eventType.includes('twopoint') || stat.points === 2 ? 2 : null;
      const assists = stats.filter(candidate => token(candidate.type) === 'assist' && teamOf(candidate) === teamId);
      // A label is preserved as a label, not inferred catch-and-shoot/movement
      // ability. Provider coordinates remain in their original units/orientation.
      shotEvents.push({ ...scope, eventId: event.id ?? null, statisticOrdinal, playerId, teamId,
        opponentTeamId: teams.find(id => id !== teamId), periodSequence: event.periodSequence ?? null,
        clockRemainingMs: nonnegative(event.clockRemainingMs), shotClockSeconds: null,
        type, made, pointValue, distanceFeet: nonnegative(stat.shot_distance ?? stat.shotDistance),
        providerShotType: stat.shot_type ?? stat.shotType ?? null,
        providerShotDescription: stat.shot_type_desc ?? stat.shotTypeDesc ?? null,
        providerLocation: event.location ?? null,
        assistingPlayerId: type === 'fieldgoal' && made === true && assists.length === 1 ? playerOf(assists[0]) ?? null : null,
        onCourt: event.onCourt ?? null,
        gameReconstructionEligible: reconstruction.isEligible === true,
        interpretation: 'Explicit PBP shot/FT observation. Unknown accuracy, shot clock, and tracking labels remain null.' });
    });
  }
  const teamGames = teams.map((teamId, side) => {
    const roster = players.filter(row => row.teamId === teamId);
    const selected = simulationPossessions.filter(row => row.observationEligible);
    const offense = selected.filter(row => row.offenseProviderTeamId === teamId);
    const defense = selected.filter(row => row.defenseProviderTeamId === teamId);
    const offensePointHistogram = {}, defensePointHistogram = {}, jointOffenseDefensePointHistogram = {};
    for (const row of offense) {
      increment(offensePointHistogram, row.offensePoints);
      increment(jointOffenseDefensePointHistogram, `${row.offensePoints}:${row.defensePoints}`);
    }
    for (const row of defense) increment(defensePointHistogram, row.offensePoints);
    const officialPlayerTotals = Object.fromEntries(BOX_FIELDS.map(field => [field, completeSum(roster.map(row => row.officialTotals[field]))]));
    const effectivePlayerTotals = Object.fromEntries(BOX_FIELDS.map(field => [field, completeSum(roster.map(row => row.effectiveTotals[field]))]));
    const sourceTeam = record.teams?.find(row => row.id === teamId);
    return { ...scope, teamId, opponentTeamId: teams[1 - side], isHome: side === 0,
      points: side === 0 ? game.homePoints : game.awayPoints,
      pointsAgainst: side === 0 ? game.awayPoints : game.homePoints,
      providerReportedPossessions: nonnegative(sourceTeam?.possessions),
      officialPlayerTotals, effectivePlayerTotals,
      userCorrectionIds: roster.flatMap(row => row.sourceCorrections.map(correction => correction.id)),
      officialPlayerPointsMatchFinal: officialPlayerTotals.points === (side === 0 ? game.homePoints : game.awayPoints),
      observedOffensivePossessions: offense.length, observedDefensivePossessions: defense.length,
      offensePointHistogram, defensePointHistogram, jointOffenseDefensePointHistogram,
      pointsOnObservedOffensivePossessions: offense.reduce((sum, row) => sum + row.offensePoints, 0),
      pointsAllowedOnObservedDefensivePossessions: defense.reduce((sum, row) => sum + row.offensePoints, 0),
      nonOffensePointsOnObservedDefensivePossessions: defense.reduce((sum, row) => sum + row.defensePoints, 0),
      pointsAllowedDuringObservedOffensivePossessions: offense.reduce((sum, row) => sum + row.defensePoints, 0),
      reconstructionEligible: reconstruction.isEligible === true,
      possessionCoverage: { allRecorded: simulationPossessions.length, eligibleStable: selected.length,
        fullGameOutcomeCoverage: selected.length === simulationPossessions.length && selected.length > 0 },
      interpretation: 'Exact histograms describe the stable-lineup cohort, not all-game totals or a fitted simulation. Player-summed box fields can omit team-only events.' };
  });
  return { applicationEvidenceVersion: APPLICATION_EVIDENCE_VERSION, simulationPossessions, rotationStints, shotEvents, teamGames };
}

function addCategories(target, categories) {
  for (const [label, row] of Object.entries(categories || {})) {
    const aggregate = target[label] ||= { attempts: 0, makes: 0, unknownMadeStatus: 0 };
    for (const field of Object.keys(aggregate)) aggregate[field] += row[field] || 0;
  }
}

/** Profiles keep the original metric families, plus season-keyed donor blocks.
 * Counts/exposure and known gaps travel with each component. Combining donors
 * does not produce a learned synthetic player, physical trait or RAPM estimate.
 */
export function buildPlayerSeasonSkillProfiles(playerGames, seasons) {
  const groups = new Map();
  for (const row of playerGames) for (const teamId of [row.teamId, 'ALL_TEAMS']) {
    const key = scopeKey({ ...row, teamId });
    if (!groups.has(key)) groups.set(key, { names: new Set(), positions: new Set(), providerShotTypes: {},
      providerShotDescriptions: {}, distanceZones: {}, distanceFeetTotal: 0, distanceObservedAttempts: 0,
      missingProviderShotType: 0, missingProviderShotDescription: 0 });
    const group = groups.get(key);
    if (row.playerName) group.names.add(row.playerName);
    if (row.listedPosition) group.positions.add(row.listedPosition);
    addCategories(group.providerShotTypes, row.shooting.providerShotTypes);
    addCategories(group.providerShotDescriptions, row.shooting.providerShotDescriptions);
    addCategories(group.distanceZones, row.shooting.distanceZones);
    group.distanceFeetTotal += row.shooting.distance.totalFeet;
    group.distanceObservedAttempts += row.shooting.distance.observedAttempts;
    group.missingProviderShotType += row.shooting.missingProviderShotType;
    group.missingProviderShotDescription += row.shooting.missingProviderShotDescription;
  }
  return seasons.map(row => {
    const group = groups.get(scopeKey(row)); assert.ok(group);
    const fields = row.fieldEvidence;
    const components = {
      fieldGoalAccuracy: ['fieldGoalsMade', 'fieldGoalAttempts'], twoPointAccuracy: ['twoPointMakes', 'twoPointAttempts'],
      threePointAccuracy: ['threePointersMade', 'threePointAttempts'], freeThrowAccuracy: ['freeThrowsMade', 'freeThrowAttempts'],
      threePointAttemptShare: ['threePointAttempts', 'fieldGoalAttempts'], freeThrowAttemptRate: ['freeThrowAttempts', 'fieldGoalAttempts'],
      assistsPerTurnover: ['assists', 'turnovers'],
    };
    const ratios = Object.fromEntries(Object.entries(components).map(([name, [n, d]]) => [name, {
      numeratorField: n, denominatorField: d, numerator: fields[n].officialTotal, denominator: fields[d].officialTotal,
      value: divide(fields[n].officialTotal, fields[d].officialTotal),
      independentlyMatchedGames: Math.min(fields[n].matchedGames, fields[d].matchedGames),
      // The minimum of two coverage counts is only an UPPER BOUND on joint
      // coverage. Exact joint-game fitting must use playerGames; do not certify it.
      coverageCountIsJointUpperBound: true,
    }]));
    return { version: APPLICATION_EVIDENCE_VERSION, seasonStartYear: row.seasonStartYear, phase: row.phase,
      teamId: row.teamId, playerId: row.playerId, teamIds: row.teamIds,
      names: [...group.names].sort(), listedPositions: [...group.positions].sort(),
      games: row.games, officialMinutes: row.officialMinutes, minutesPerGame: divide(row.officialMinutes, row.games),
      firstGameAt: row.firstGameAt, lastGameAt: row.lastGameAt,
      perGame: Object.fromEntries(BOX_FIELDS.map(field => [field, divide(fields[field].officialTotal, row.games)])),
      officialRates: row.officialRates, effectiveRates: row.effectiveRates, fieldEvidence: fields, ratios,
      shooting: { providerShotTypes: group.providerShotTypes, providerShotDescriptions: group.providerShotDescriptions,
        distanceZones: group.distanceZones, distanceObservedAttempts: group.distanceObservedAttempts,
        meanDistanceFeet: divide(group.distanceFeetTotal, group.distanceObservedAttempts),
        missingProviderShotType: group.missingProviderShotType, missingProviderShotDescription: group.missingProviderShotDescription },
      userCorrectionIds: row.userCorrectionIds,
      unavailableObservedTraits: ['speed', 'acceleration', 'lateralQuickness', 'vertical', 'strength', 'endurance', 'durability', 'height', 'weight', 'birthDate'],
      interpretation: 'Observed season/phase skill components with denominators; listed position is not researched multi-position eligibility. Missing traits remain planned enrichment, not invented attributes.' };
  });
}

export function buildPlayerIdentities(players) {
  const identities = new Map();
  for (const row of players) {
    if (!identities.has(row.playerId)) identities.set(row.playerId, { names: new Set(), nbaReferenceIds: new Set(), memberships: new Map() });
    const identity = identities.get(row.playerId);
    if (row.playerName) identity.names.add(row.playerName);
    if (row.nbaReferenceId) identity.nbaReferenceIds.add(row.nbaReferenceId);
    const key = `${row.seasonStartYear}~${row.phase}~${row.teamId}`;
    if (!identity.memberships.has(key)) identity.memberships.set(key, { seasonStartYear: row.seasonStartYear, phase: row.phase,
      teamId: row.teamId, firstObservedGameAt: row.scheduledAt, lastObservedGameAt: row.scheduledAt, listedPositions: new Set() });
    const membership = identity.memberships.get(key);
    membership.firstObservedGameAt = [membership.firstObservedGameAt, row.scheduledAt].sort()[0];
    membership.lastObservedGameAt = [membership.lastObservedGameAt, row.scheduledAt].sort().at(-1);
    if (row.listedPosition) membership.listedPositions.add(row.listedPosition);
  }
  return [...identities].sort(([a], [b]) => a.localeCompare(b)).map(([playerId, row]) => ({ playerId,
    names: [...row.names].sort(), nbaReferenceIds: [...row.nbaReferenceIds].sort(), identityConflict: row.nbaReferenceIds.size > 1,
    memberships: [...row.memberships.values()].map(value => ({ ...value, listedPositions: [...value.listedPositions].sort() })),
    media: { headshotUrl: null, resolution: 'Join existing authorized media by a verified identity; no fabricated URL or rights claim.' },
    interpretation: 'Observed team appearances, not exact contract/transaction dates. Names never replace stable IDs.' }));
}

export function buildTeamSeasonSimulationProfiles(teamGames) {
  const groups = new Map();
  for (const row of teamGames) {
    const key = `${row.seasonStartYear}~${row.phase}~${row.teamId}`;
    if (!groups.has(key)) groups.set(key, { seasonStartYear: row.seasonStartYear, phase: row.phase, teamId: row.teamId,
      games: 0, finalPoints: 0, finalPointsAgainst: 0, observedOffensivePossessions: 0, observedDefensivePossessions: 0,
      offensePointHistogram: {}, defensePointHistogram: {}, jointOffenseDefensePointHistogram: {},
      fullyCoveredGames: 0, observedGameIds: [], userCorrectionIds: new Set() });
    const group = groups.get(key); group.games++; group.finalPoints += row.points; group.finalPointsAgainst += row.pointsAgainst;
    group.observedOffensivePossessions += row.observedOffensivePossessions;
    group.observedDefensivePossessions += row.observedDefensivePossessions;
    for (const field of ['offensePointHistogram', 'defensePointHistogram', 'jointOffenseDefensePointHistogram']) addHistogram(group[field], row[field]);
    if (row.possessionCoverage.fullGameOutcomeCoverage) group.fullyCoveredGames++;
    group.observedGameIds.push(row.gameId);
    for (const id of row.userCorrectionIds) group.userCorrectionIds.add(id);
  }
  return [...groups.values()].map(row => {
    const moments = histogram => {
      const n = Object.values(histogram).reduce((sum, count) => sum + count, 0);
      const points = Object.entries(histogram).reduce((sum, [value, count]) => sum + Number(value) * count, 0);
      const squares = Object.entries(histogram).reduce((sum, [value, count]) => sum + Number(value) ** 2 * count, 0);
      return { possessions: n, points, mean: divide(points, n), secondMoment: divide(squares, n),
        variance: n > 0 ? Math.max(0, squares / n - (points / n) ** 2) : null };
    };
    const offense = moments(row.offensePointHistogram), defense = moments(row.defensePointHistogram);
    assert.equal(offense.possessions, row.observedOffensivePossessions);
    assert.equal(defense.possessions, row.observedDefensivePossessions);
    return { ...row, userCorrectionIds: [...row.userCorrectionIds], offenseOutcomeMoments: offense, defenseOutcomeMoments: defense,
      forecastValidated: false, interpretation: 'Season/phase exact observed outcome distributions; game IDs support chronological evaluation. Missing schedule games, selection bias, and possession dependence are not resolved by these summaries.' };
  });
}

export const APPLICATION_CAPABILITIES = Object.freeze({
  version: APPLICATION_EVIDENCE_VERSION,
  simulation: ['ordered possessions with exact coupled score outcomes', 'stable-lineup eligibility and omitted-cohort reasons',
    'rotation stints and shot/FT events', 'team/game outcomes and season/phase histograms', 'actual sample moments and chronological game IDs'],
  playerBuilder: ['season/team and all-team donor profiles', 'separate accuracy and attempt frequency', 'free throws and two-point shooting',
    'provider shot-type/distance-zone counts with unknown outcomes', 'names/IDs/observed membership for media joins', 'per-component missingness and correction provenance'],
  stillRequiresEvidenceOrFitting: ['physical traits and longitudinal biographical enrichment', 'complete schedule/standings/tiebreak rules',
    'joint usage/efficiency response', 'causal lineup interactions', 'calibrated future probabilities', 'synthetic-player feasibility and uncertainty'],
  userExcludedInputsRemainExcluded: ['defender assignments', 'screen coverage', 'wingspan', 'injuries', 'contracts', 'cognitive traits'],
});
