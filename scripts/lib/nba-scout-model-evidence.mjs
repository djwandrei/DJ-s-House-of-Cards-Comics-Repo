import { createDirectPlayerEventLine, addDirectPlayerStatistic } from '../derive-local-scout-analytics.mjs';
import { reconstructNbaGameLineups, sortPbpEvents } from './nba-lineup-reconstruction.mjs';
import { BOX_FIELDS, readOfficialBox } from './nba-summary-completeness.mjs';
import { correctedBox } from './nba-scout-source-corrections.mjs';
import { buildApplicationGameEvidence } from './nba-scout-application-evidence.mjs';
export { BOX_FIELDS, readOfficialBox } from './nba-summary-completeness.mjs';

/** Additive modeling data; none of these helpers changes the existing RAPM fit. */
export const MODEL_EVIDENCE_VERSION = 'nba_scout_model_evidence_v1';
const token = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const key = (teamId, playerId) => `${teamId}~${playerId}`;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const ratio = (a, b) => a !== null && b > 0 ? a / b : null;
const sumIfComplete = values => values.every(value => value !== null) ? values.reduce((a, b) => a + b, 0) : null;

function pbpBox(line) {
  const fields = Object.fromEntries(BOX_FIELDS.map(field => [field,
    field === 'rebounds' ? line.offensiveRebounds + line.defensiveRebounds : count(line[field]),
  ]));
  // Unknown outcomes are not misses. Preserve uncertainty at field level so
  // missing rebounds do not erase verified shooting, or certify it by accident.
  const invalidate = names => names.forEach(field => { fields[field] = null; });
  if (line.unknownFieldGoalMadeStatus) invalidate(['points', 'fieldGoalsMade', 'twoPointMakes', 'threePointersMade']);
  if (line.unclassifiedFieldGoalAttempts) invalidate(['twoPointAttempts', 'threePointAttempts']);
  if (line.unclassifiedFieldGoalMakes) invalidate(['points', 'twoPointMakes', 'threePointersMade']);
  if (line.unknownFreeThrowMadeStatus) invalidate(['points', 'freeThrowsMade']);
  if (line.unclassifiedRebounds) invalidate(['rebounds', 'offensiveRebounds', 'defensiveRebounds']);
  return fields;
}

export function boxIdentityIssues(box) {
  const issues = [];
  for (const [total, parts] of [
    ['fieldGoalAttempts', ['twoPointAttempts', 'threePointAttempts']],
    ['fieldGoalsMade', ['twoPointMakes', 'threePointersMade']],
    ['rebounds', ['offensiveRebounds', 'defensiveRebounds']],
  ]) {
    const sum = sumIfComplete(parts.map(field => box[field]));
    if (box[total] !== null && sum !== null && box[total] !== sum) issues.push(total);
  }
  for (const [made, attempted] of [['fieldGoalsMade', 'fieldGoalAttempts'], ['twoPointMakes', 'twoPointAttempts'], ['threePointersMade', 'threePointAttempts'], ['freeThrowsMade', 'freeThrowAttempts']]) {
    if (box[made] !== null && box[attempted] !== null && box[made] > box[attempted]) issues.push(made);
  }
  if ([box.points, box.twoPointMakes, box.threePointersMade, box.freeThrowsMade].every(value => value !== null)
    && box.points !== 2 * box.twoPointMakes + 3 * box.threePointersMade + box.freeThrowsMade) issues.push('points');
  return issues;
}

export function boxRates(box, minutes, offensivePossessions = null) {
  const involvement = sumIfComplete([box.fieldGoalAttempts, box.freeThrowAttempts === null ? null : .44 * box.freeThrowAttempts, box.turnovers]);
  return {
    per36: Object.fromEntries(BOX_FIELDS.map(field => [field, ratio(box[field] === null ? null : 36 * box[field], minutes)])),
    per100OnCourtOffensivePossessions: Object.fromEntries(BOX_FIELDS.map(field => [field, ratio(box[field] === null ? null : 100 * box[field], offensivePossessions)])),
    effectiveFieldGoalPercentage: ratio(box.fieldGoalsMade === null || box.threePointersMade === null ? null : box.fieldGoalsMade + .5 * box.threePointersMade, box.fieldGoalAttempts),
    threePointPercentage: ratio(box.threePointersMade, box.threePointAttempts),
    fieldGoalPercentage: ratio(box.fieldGoalsMade, box.fieldGoalAttempts),
    twoPointPercentage: ratio(box.twoPointMakes, box.twoPointAttempts),
    freeThrowPercentage: ratio(box.freeThrowsMade, box.freeThrowAttempts),
    threePointAttemptShare: ratio(box.threePointAttempts, box.fieldGoalAttempts),
    freeThrowAttemptRate: ratio(box.freeThrowAttempts, box.fieldGoalAttempts),
    trueShootingPercentage: ratio(box.points, box.fieldGoalAttempts === null || box.freeThrowAttempts === null ? null : 2 * (box.fieldGoalAttempts + .44 * box.freeThrowAttempts)),
    offensiveInvolvement: involvement,
    offensiveInvolvementPer36: ratio(involvement === null ? null : 36 * involvement, minutes),
    offensiveInvolvementPerOnCourtPossession: ratio(involvement, offensivePossessions),
    involvementDefinition: 'FGA + 0.44*FTA + TOV; descriptive possession-ending proxy, not measured touches, playmaking share, or a fitted usage-response curve.',
  };
}

/**
 * One game at a time bounds memory and makes the rebuild resumable. Independent
 * Summary rows may be provided as a separate, provenance-bound overlay. We
 * never rewrite the archive/PBP to force agreement with the official result.
 */
export function buildGameModelEvidence(record, { summaryOverlay = null, replay = true, corrections = [] } = {}) {
  const game = record.game;
  const teamIds = [game.homeProviderTeamId, game.awayProviderTeamId];
  if (new Set(teamIds).size !== 2 || teamIds.some(id => !id)) throw new Error('Game needs two distinct team IDs.');
  if (summaryOverlay && (summaryOverlay.gameId !== game.providerGameId
    || summaryOverlay.homeTeamId !== teamIds[0] || summaryOverlay.awayTeamId !== teamIds[1])) throw new Error('Summary overlay belongs to another game/team.');
  const summaryRows = summaryOverlay?.players ?? record.players ?? [];
  const summaries = new Map();
  for (const player of summaryRows) {
    if (!teamIds.includes(player.providerTeamId) || !player.id) continue;
    const id = key(player.providerTeamId, player.id);
    if (summaries.has(id)) throw new Error(`Duplicate Summary player ${id}.`);
    summaries.set(id, player);
  }
  const events = sortPbpEvents(record.events ?? []);
  const teams = new Map((record.teams ?? []).map(team => [team.id, team]));
  const reconstruction = replay ? reconstructNbaGameLineups({
    gameId: game.providerGameId, homeTeamId: teamIds[0], awayTeamId: teamIds[1],
    status: game.status, coverage: game.coverage, trackOnCourt: game.trackOnCourt,
    expectedFinalScore: { homePoints: game.homePoints, awayPoints: game.awayPoints },
    providerTeamPossessions: { home: teams.get(teamIds[0])?.possessions, away: teams.get(teamIds[1])?.possessions },
    providerPlayerMinutes: record.players, events,
  }) : { lineupDefinitions: record.lineups, stints: record.stints, possessions: record.possessions,
    isEligible: record.analytics?.eligibleForPublication === true, methodVersion: record.analytics?.methodVersion };
  const lineups = new Map((reconstruction.lineupDefinitions ?? []).map(row => [row.id, row]));
  const direct = new Map(), exposure = new Map(), seenEvents = new Set(), edges = new Map();
  const ensure = (teamId, playerId) => {
    const id = key(teamId, playerId);
    if (!direct.has(id)) direct.set(id, createDirectPlayerEventLine());
    if (!exposure.has(id)) exposure.set(id, { teamId, playerId, minutes: 0, offensivePossessions: 0, defensivePossessions: 0 });
    return id;
  };
  for (const event of events) {
    if (event.isRescinded === true || (event.id && seenEvents.has(event.id))) continue;
    if (event.id) seenEvents.add(event.id);
    const statistics = (event.statistics ?? []).filter(stat => teamIds.includes(stat.team?.id ?? stat.team_id ?? stat.teamId)
      && (stat.player?.id ?? stat.player_id ?? stat.playerId));
    for (const stat of statistics) {
      const id = ensure(stat.team?.id ?? stat.team_id ?? stat.teamId, stat.player?.id ?? stat.player_id ?? stat.playerId);
      addDirectPlayerStatistic(direct.get(id), stat, token(event.eventType));
    }
    const shots = statistics.filter(stat => token(stat.type) === 'fieldgoal' && stat.made === true);
    const assists = statistics.filter(stat => token(stat.type) === 'assist');
    if (shots.length === 1 && assists.length === 1) {
      const [shot, assist] = [shots[0], assists[0]];
      const teamId = shot.team?.id, shooterId = shot.player?.id, passerId = assist.player?.id;
      if (teamIds.includes(teamId) && teamId === assist.team?.id && shooterId && passerId && shooterId !== passerId) {
        const id = `${teamId}~${passerId}~${shooterId}`;
        if (!edges.has(id)) edges.set(id, { teamId, passerId, shooterId, assistedFieldGoals: 0 });
        edges.get(id).assistedFieldGoals++;
      }
    }
  }
  for (const row of summaries.values()) if (number(row.minutesPlayed) > 0) ensure(row.providerTeamId, row.id);
  for (const stint of reconstruction.stints ?? []) {
    for (const lineupId of [stint.homeLineupId, stint.awayLineupId]) {
      const lineup = lineups.get(lineupId);
      if (!teamIds.includes(lineup?.providerTeamId) || lineup.playerIds?.length !== 5 || new Set(lineup.playerIds).size !== 5) continue;
      for (const id of lineup.playerIds) exposure.get(ensure(lineup.providerTeamId, id)).minutes += Math.max(0, stint.durationMs ?? 0) / 60000;
    }
  }
  for (const possession of reconstruction.possessions ?? []) {
    // Only complete, stable five-on-five possessions support the exposure
    // denominator here; raw event counts remain explicitly full-game counts.
    if (possession.hasLineupChangeMidPossession) continue;
    const onCourt = [lineups.get(possession.homeLineupId), lineups.get(possession.awayLineupId)];
    if (onCourt.some(row => row?.playerIds?.length !== 5 || new Set(row.playerIds).size !== 5)) continue;
    for (const lineup of onCourt) {
      const side = lineup.providerTeamId === possession.offenseProviderTeamId ? 'offensivePossessions'
        : lineup.providerTeamId === possession.defenseProviderTeamId ? 'defensivePossessions' : null;
      if (side) for (const id of lineup.playerIds) exposure.get(ensure(lineup.providerTeamId, id))[side]++;
    }
  }
  const players = [];
  for (const [id, observed] of exposure) {
    const summary = summaries.get(id), line = direct.get(id), pbp = pbpBox(line), official = readOfficialBox(summary);
    const corrected = correctedBox(official, summary, corrections, observed);
    const officialIssues = boxIdentityIssues(official), pbpIssues = boxIdentityIssues(pbp);
    const missingOfficialFields = BOX_FIELDS.filter(field => official[field] === null);
    const mismatchedFields = BOX_FIELDS.filter(field => official[field] !== null && pbp[field] !== null && official[field] !== pbp[field]);
    const unverifiedFields = BOX_FIELDS.filter(field => official[field] === null || pbp[field] === null);
    const boxScoreReconciled = !unverifiedFields.length && !mismatchedFields.length && !officialIssues.length && !pbpIssues.length;
    const officialMinutes = number(summary?.minutesPlayed);
    // Provider rounding and reconstruction granularity are not exact seconds.
    // Five seconds is an explicit reconciliation tolerance, not extra playing
    // time, a role prior, or a minute restriction in the optimizer.
    const minutesReconciled = officialMinutes !== null && Math.abs(officialMinutes - observed.minutes) <= 5 / 60;
    // PBP totals span the entire game, but reconstruction can miss part of a
    // player's court time. Dividing those totals by an incomplete stint sum
    // would manufacture inflated per-36 production. Use the independent
    // full-game minute exposure only after the two sources reconcile. Keep
    // official-source rates separate: they can remain descriptive even when
    // the PBP reconstruction is unusable for workload training.
    const pbpRateMinutes = minutesReconciled ? officialMinutes : null;
    const fieldReconciliation = Object.fromEntries(BOX_FIELDS.map(field => [field,
      official[field] === null || pbp[field] === null ? 'unavailable' : official[field] === pbp[field] ? 'matched' : 'mismatch',
    ]));
    players.push({
      gameId: game.providerGameId, seasonStartYear: game.seasonStartYear, seasonEndYear: game.seasonEndYear,
      phase: game.primaryPhase, scheduledAt: game.scheduledAt, ...observed,
      playerName: summary?.fullName ?? null, listedPosition: summary?.position ?? null,
      nbaReferenceId: /^\d+$/.test(summary?.reference ?? '') ? String(summary.reference) : null,
      providerPlayerSrId: summary?.srId ?? null,
      opponentTeamId: teamIds.find(teamId => teamId !== observed.teamId), isHome: observed.teamId === teamIds[0],
      officialMinutes, pbpTotals: pbp, officialTotals: official,
      // Keep official totals/reconciliation unchanged. Effective values are a
      // separately labelled descriptive layer; user corrections are NOT newly
      // independent observations and do not qualify a row for model training.
      effectiveTotals: corrected.effective,
      sourceCorrections: corrected.applied,
      missingEffectiveFields: BOX_FIELDS.filter(field => corrected.effective[field] === null),
      effectiveRates: boxRates(corrected.effective, officialMinutes),
      fieldReconciliation, boxScoreReconciled, minutesReconciled,
      invalidOfficialFields: BOX_FIELDS.filter(field => summary?.officialBoxScore?.invalidFields?.includes(field)),
      missingOfficialFields, mismatchedFields, unverifiedFields, officialIdentityIssues: officialIssues, pbpIdentityIssues: pbpIssues,
      trainingEligible: boxScoreReconciled && minutesReconciled && officialMinutes > 0 && reconstruction.isEligible === true,
      rates: boxRates(pbp, pbpRateMinutes),
      officialRates: boxRates(official, officialMinutes),
      rateExposure: {
        pbpPer36Minutes: pbpRateMinutes, officialPer36Minutes: officialMinutes,
        definition: 'Full-game independent Summary minutes; PBP per-36 withheld when reconstructed minutes do not reconcile.',
      },
      // Full-game player counts must NOT be divided by filtered possession
      // exposure: leave that rate unknown until numerators share its scope.
      possessionRateUnavailableReason: 'Full-game box numerator and verified-lineup-only possession denominator have different inclusion scopes.',
      shooting: {
        distanceZones: Object.fromEntries(['atRim', 'shortMidRange', 'longMidRange'].map(zone => [zone, {
          attempts: line[`${zone}Attempts`], makes: line[`${zone}Makes`], unknownMadeStatus: line[`${zone}UnknownMadeStatus`],
        }])),
        providerShotTypes: line.providerShotTypes, providerShotDescriptions: line.providerShotDescriptions,
        missingProviderShotType: line.missingProviderShotType, missingProviderShotDescription: line.missingProviderShotDescription,
        distance: { observedAttempts: line.fieldGoalDistanceObserved, totalFeet: line.fieldGoalDistanceTotal,
          meanFeet: ratio(line.fieldGoalDistanceTotal, line.fieldGoalDistanceObserved) },
      },
    });
  }
  return {
    version: MODEL_EVIDENCE_VERSION,
    game: { ...game, reconstructionEligible: reconstruction.isEligible === true, reconstructionMethodVersion: reconstruction.methodVersion },
    players,
    assistedBasketConnections: [...edges.values()],
    ...buildApplicationGameEvidence(record, reconstruction, players, events),
    summaryRefreshNeeded: players.some(row => row.missingEffectiveFields.length > 0),
    originalSummaryIncomplete: players.some(row => row.missingOfficialFields.length > 0),
    mismatchReviewNeeded: players.some(row => row.mismatchedFields.length > 0),
  };
}

/** Gaps propagate across both team and all-team season aggregates. */
export function aggregatePlayerSeasons(gameRows) {
  const groups = new Map();
  for (const row of gameRows) {
    for (const teamId of [row.teamId, 'ALL_TEAMS']) {
      const id = `${row.seasonStartYear}~${row.phase}~${teamId}~${row.playerId}`;
      if (!groups.has(id)) groups.set(id, { seasonStartYear: row.seasonStartYear, phase: row.phase, teamId, playerId: row.playerId, rows: [], games: new Set() });
      const group = groups.get(id);
      if (group.games.has(row.gameId)) throw new Error(`Duplicate player/game in ${id}.`);
      group.games.add(row.gameId); group.rows.push(row);
    }
  }
  return [...groups.values()].map(({ rows, games, ...scope }) => {
    const fieldEvidence = Object.fromEntries(BOX_FIELDS.map(field => {
      const observed = rows.filter(row => row.pbpTotals[field] !== null);
      const official = rows.filter(row => row.officialTotals[field] !== null);
      const effective = rows.filter(row => (row.effectiveTotals ?? row.officialTotals)[field] !== null);
      return [field, { expectedGames: rows.length, pbpKnownGames: observed.length, officialKnownGames: official.length,
        invalidOfficialGames: rows.filter(row => row.invalidOfficialFields?.includes(field)).length,
        matchedGames: rows.filter(row => row.fieldReconciliation[field] === 'matched').length,
        userCorrectedGames: rows.filter(row => row.sourceCorrections?.some(correction => correction.field === field)).length,
        effectiveKnownGames: effective.length,
        effectivePartialTotal: effective.reduce((sum, row) => sum + (row.effectiveTotals ?? row.officialTotals)[field], 0),
        effectiveTotal: effective.length === rows.length ? effective.reduce((sum, row) => sum + (row.effectiveTotals ?? row.officialTotals)[field], 0) : null,
        pbpPartialTotal: observed.reduce((sum, row) => sum + row.pbpTotals[field], 0),
        officialPartialTotal: official.reduce((sum, row) => sum + row.officialTotals[field], 0),
        pbpTotal: observed.length === rows.length ? observed.reduce((sum, row) => sum + row.pbpTotals[field], 0) : null,
        officialTotal: official.length === rows.length ? official.reduce((sum, row) => sum + row.officialTotals[field], 0) : null }];
    }));
    const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
    const officialMinutes = sumIfComplete(rows.map(row => row.officialMinutes));
    // A trade or one incomplete game must not quietly shrink the denominator
    // while keeping every game's numerator. Preserve the observed stint sum
    // above for diagnostics, and withhold complete PBP per-36 season rates if
    // any game's exposure was unverified. Official rates use their own complete
    // totals/minutes, never the PBP totals as a substitute for a missing field.
    const pbpRateMinutes = rows.every(row => row.minutesReconciled) ? officialMinutes : null;
    return { ...scope, games: games.size, teamIds: [...new Set(rows.map(row => row.teamId))].sort(), minutes,
      firstGameAt: rows.map(row => row.scheduledAt).sort()[0], lastGameAt: rows.map(row => row.scheduledAt).sort().at(-1),
      officialMinutes,
      reconciledGames: rows.filter(row => row.boxScoreReconciled).length,
      trainingEligibleGames: rows.filter(row => row.trainingEligible).length,
      fieldEvidence, rates: boxRates(Object.fromEntries(BOX_FIELDS.map(field => [field, fieldEvidence[field].pbpTotal])), pbpRateMinutes),
      officialRates: boxRates(Object.fromEntries(BOX_FIELDS.map(field => [field, fieldEvidence[field].officialTotal])), officialMinutes),
      effectiveRates: boxRates(Object.fromEntries(BOX_FIELDS.map(field => [field, fieldEvidence[field].effectiveTotal])), officialMinutes),
      userCorrectionIds: [...new Set(rows.flatMap(row => (row.sourceCorrections ?? []).map(correction => correction.id)))],
      rateExposure: { pbpPer36Minutes: pbpRateMinutes, officialPer36Minutes: officialMinutes },
      aggregation: 'season_and_phase_separate; ALL_TEAMS counts each player-game once; no four-season totals labeled as one season',
    };
  });
}

export const BLUEPRINT_CAPABILITIES = Object.freeze({
  preserved: ['O/D and net RAPM', 'on/off and WOWY', 'duo/trio/exact-five co-presence', 'four factors', 'shot profiles', 'clutch/score-state/phase/rolling contexts', 'observed residual synergy', 'existing approximate intervals'],
  added: {
    lineupAndRotations: ['separate game minutes and possession-ending involvement', 'field-level complete/missing evidence', 'season/team/all-team production'],
    gameSeriesSeasonSimulation: ['ordered game context and outcomes', 'scheduled-game spacing', 'real game-level production samples'],
    compositePlayersAndSkillProfiles: ['observed shooting frequency and accuracy', 'provider-labeled shot types and distances', 'separate production/impact/role evidence'],
    chemistryAndTendencies: ['assisted-basket passer-shooter links (not all passes)', 'game-level shots/assists/turnovers', 'existing together/apart and context measures'],
    careerArcsAndArchetypes: ['season-by-season, phase-separated player profiles', 'all-team aggregation across trades', 'sample sizes and field availability'],
    matchups: ['opponent-team IDs', 'home/away game context', 'existing lineup-v-lineup observations'],
  },
  notEstablished: ['causal chemistry for unseen combinations', 'fitted usage-response curves', 'calibrated future lineup win probabilities', 'physical/mental skill estimates inferred from box scores'],
  excludedByRequest: ['defender assignments', 'screen coverage', 'wingspan', 'injuries', 'contracts', 'cognitive traits'],
});
