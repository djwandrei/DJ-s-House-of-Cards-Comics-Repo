import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalLineupKey,
  deterministicUuidV5,
  expandLineupCombinations,
  hasProviderFastbreakQualifier,
  homeScoreStateV1,
  isClutchV1,
  isKnownScoreStateV1,
  reconstructNbaGameLineups,
  sortPbpEvents,
  validateOnCourtSnapshot
} from '../lib/nba-lineup-reconstruction.mjs';

const ids = Object.freeze({
  game: '0c281faf-1d2b-4a18-a1d0-000000000001',
  home: '0c281faf-1d2b-4a18-a1d0-000000000002',
  away: '0c281faf-1d2b-4a18-a1d0-000000000003',
  h1: '10000000-0000-4000-8000-000000000001',
  h2: '10000000-0000-4000-8000-000000000002',
  h3: '10000000-0000-4000-8000-000000000003',
  h4: '10000000-0000-4000-8000-000000000004',
  h5: '10000000-0000-4000-8000-000000000005',
  h6: '10000000-0000-4000-8000-000000000006',
  h7: '10000000-0000-4000-8000-000000000007',
  a1: '20000000-0000-4000-8000-000000000001',
  a2: '20000000-0000-4000-8000-000000000002',
  a3: '20000000-0000-4000-8000-000000000003',
  a4: '20000000-0000-4000-8000-000000000004',
  a5: '20000000-0000-4000-8000-000000000005'
});

const firstHome = [ids.h5, ids.h4, ids.h3, ids.h2, ids.h1];
const secondHome = [ids.h1, ids.h2, ids.h3, ids.h4, ids.h6];
const thirdHome = [ids.h1, ids.h2, ids.h3, ids.h4, ids.h7];
const away = [ids.a1, ids.a2, ids.a3, ids.a4, ids.a5];

function onCourt(homePlayerIds = firstHome, awayPlayerIds = away) {
  return { homePlayerIds, awayPlayerIds, snapshotStatus: 'valid_five_on_five' };
}

function event({
  id,
  sequence,
  clockRemainingMs,
  homePointsAfter,
  awayPointsAfter,
  possessionTeamId,
  attributionTeamId,
  attempt,
  onCourt: eventOnCourt = onCourt(),
  qualifiers = [],
  statistics = [],
  eventType = 'event',
  periodNumber = 4
}) {
  return {
    id,
    eventSequence: sequence,
    eventNumber: sequence,
    periodSequence: periodNumber,
    periodNumber,
    periodType: periodNumber > 4 ? 'overtime' : 'quarter',
    clockRemainingMs,
    homePointsAfter,
    awayPointsAfter,
    possessionTeamId,
    attributionTeamId,
    attempt,
    onCourt: eventOnCourt,
    qualifiers,
    statistics,
    eventType
  };
}

function fullGameInput(events, extra = {}) {
  return {
    gameId: ids.game,
    homeTeamId: ids.home,
    awayTeamId: ids.away,
    status: 'closed',
    coverage: 'full',
    trackOnCourt: true,
    expectedFinalScore: { homePoints: 2, awayPoints: 2 },
    events,
    ...extra
  };
}

test('canonical snapshots reject duplicates and sort event sequence before event number', () => {
  assert.equal(canonicalLineupKey(firstHome), [ids.h1, ids.h2, ids.h3, ids.h4, ids.h5].join('|'));
  assert.equal(validateOnCourtSnapshot(onCourt([...firstHome.slice(0, 4), firstHome[0]])).snapshotStatus, 'duplicate_player');
  assert.equal(validateOnCourtSnapshot(onCourt(firstHome, [...away.slice(0, 4), ids.h1])).snapshotStatus, 'cross_team_duplicate');

  const ordered = sortPbpEvents([
    { id: 'late', eventSequence: 9, eventNumber: 1 },
    { id: 'early', eventSequence: 2, eventNumber: 99 },
    { id: 'same-sequence-b', eventSequence: 9, eventNumber: 3 },
    { id: 'same-sequence-a', eventSequence: 9, eventNumber: 2 }
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ['early', 'late', 'same-sequence-a', 'same-sequence-b']);
});

test('reconstructs exact five-player stints, preserves a zero-duration same-clock lineup, and only uses provider possession transitions', () => {
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'e1', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'e2', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, qualifiers: [{ type: 'fastbreak' }], eventType: 'twopointmade'
    }),
    event({ id: 'e3', sequence: 3, clockRemainingMs: 700000, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: onCourt(secondHome) }),
    event({ id: 'e4', sequence: 4, clockRemainingMs: 700000, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: onCourt(thirdHome) }),
    event({ id: 'e5', sequence: 5, clockRemainingMs: 690000, homePointsAfter: 2, awayPointsAfter: 2, possessionTeamId: ids.home, onCourt: onCourt(thirdHome), eventType: 'twopointmade' }),
    event({ id: 'e6', sequence: 6, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 2, possessionTeamId: ids.home, onCourt: onCourt(thirdHome), eventType: 'endperiod' })
  ]));

  assert.equal(result.coverageStatus, 'eligible');
  assert.equal(result.validation.finalScore.verified, true);
  assert.equal(result.lineupDefinitions.length, 4); // three home units plus one away unit
  assert.equal(result.lineupCombinations.length, 124); // 31 combinations for each exact five
  assert.equal(result.stints.length, 3);
  assert.ok(result.stints.some((stint) => stint.durationMs === 0));
  assert.ok(result.stints.some((stint) => stint.qualityFlags.includes('same_clock_snapshot_change')));

  const homeScoringPossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home && row.offensePoints === 2);
  assert.ok(homeScoringPossession);
  assert.equal(homeScoringPossession.transitionContext, 'provider_fastbreak_v1');
  assert.equal(homeScoringPossession.transitionSource, 'provider_qualifier');
  assert.equal(homeScoringPossession.possessionSource, 'provider_post_event_state');

  const awayScoringPossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.away && row.offensePoints === 2);
  assert.ok(awayScoringPossession);
  assert.equal(awayScoringPossession.hasLineupChangeMidPossession, true);
  assert.ok(awayScoringPossession.qualityFlags.includes('lineup_changed_mid_possession'));
  assert.ok(result.combinationAnalytics.some((row) => row.playerCount === 2 && row.semantics === 'shared_floor'));
  assert.ok(result.combinationAnalytics.some((row) => row.playerCount === 5 && row.semantics === 'exact_five'));
});

test('requires a confirmed end of game before publishing reconstruction analytics', () => {
  const endedEarly = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'q1-start', sequence: 1, periodNumber: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'q1-make', sequence: 2, periodNumber: 1, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'twopointmade' }),
    event({ id: 'q1-end', sequence: 3, periodNumber: 1, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(endedEarly.coverageStatus, 'ineligible');
  assert.equal(endedEarly.isEligible, false);
  assert.ok(endedEarly.validation.errors.includes('document_ended_before_confirmed_game_end'));

  const sparseFinal = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'q4-start', sequence: 1, periodNumber: 4, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'q4-make', sequence: 2, periodNumber: 4, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'twopointmade' }),
    event({ id: 'q4-end', sequence: 3, periodNumber: 4, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(sparseFinal.coverageStatus, 'eligible');
  assert.ok(!sparseFinal.validation.errors.includes('document_ended_before_confirmed_game_end'));
});

test('rebases an untouched possession to a verified dead-ball substitution lineup', () => {
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, eventType: 'start_period' }),
    event({
      id: 'dead-ball-sub', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 0,
      possessionTeamId: ids.home, onCourt: onCourt(secondHome), eventType: 'Lineup Change'
    }),
    event({
      id: 'home-make', sequence: 3, clockRemainingMs: 700000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, onCourt: onCourt(secondHome), eventType: 'Two Point Made'
    }),
    event({ id: 'end', sequence: 4, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'end_period' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'eligible');
  const homePossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  const secondHomeLineup = result.lineupDefinitions.find((row) => row.providerTeamId === ids.home
    && row.playerIds.includes(ids.h6));
  assert.ok(secondHomeLineup);
  assert.equal(homePossession.homeLineupId, secondHomeLineup.id);
  assert.equal(homePossession.hasLineupChangeMidPossession, false);
  assert.ok(homePossession.qualityFlags.includes('dead_ball_substitution_rebased_possession_start'));

  const actionBeforeSubstitution = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, eventType: 'start_period' }),
    event({ id: 'miss', sequence: 2, clockRemainingMs: 715000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, eventType: 'Two Point Missed' }),
    event({
      id: 'sub-after-action', sequence: 3, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 0,
      possessionTeamId: ids.home, onCourt: onCourt(secondHome), eventType: 'Lineup Change'
    }),
    event({
      id: 'make-after-action', sequence: 4, clockRemainingMs: 700000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, onCourt: onCourt(secondHome), eventType: 'Two Point Made'
    }),
    event({ id: 'end-after-action', sequence: 5, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'end_period' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));
  const changedPossession = actionBeforeSubstitution.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  assert.equal(changedPossession.hasLineupChangeMidPossession, true);
  assert.ok(changedPossession.qualityFlags.includes('lineup_changed_mid_possession'));
  assert.ok(!changedPossession.qualityFlags.includes('dead_ball_substitution_rebased_possession_start'));
});

test('fails closed when a score-changing event is missing a valid five-on-five snapshot', () => {
  const invalid = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'e1', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'e2', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, onCourt: onCourt(firstHome, away.slice(0, 4)), eventType: 'twopointmade'
    }),
    event({ id: 'e3', sequence: 3, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(invalid.coverageStatus, 'ineligible');
  assert.equal(invalid.isEligible, false);
  assert.ok(invalid.validation.errors.some((error) => error.startsWith('score_event_missing_valid_snapshot:e2')));
});

test('fails closed when a provider possession starts or ends without a valid lineup snapshot', () => {
  const invalidTerminal = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'invalid-turnover', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 0,
      possessionTeamId: ids.away, onCourt: onCourt(firstHome, away.slice(0, 4)), eventType: 'turnover'
    }),
    event({ id: 'end', sequence: 3, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 0, awayPoints: 0 } }));

  assert.equal(invalidTerminal.coverageStatus, 'ineligible');
  assert.ok(invalidTerminal.validation.errors.includes('possession_terminal_event_missing_valid_snapshot:invalid-turnover'));
  assert.ok(invalidTerminal.validation.errors.includes('possession_start_event_missing_valid_snapshot:invalid-turnover'));

  const invalidStart = reconstructNbaGameLineups(fullGameInput([
    event({
      id: 'invalid-start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0,
      possessionTeamId: ids.home, onCourt: onCourt(firstHome, away.slice(0, 4)), eventType: 'turnover'
    }),
    event({ id: 'end', sequence: 2, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 0, awayPoints: 0 } }));

  assert.equal(invalidStart.coverageStatus, 'ineligible');
  assert.ok(invalidStart.validation.errors.includes('possession_start_event_missing_valid_snapshot:invalid-start'));
});

test('retains a verified possession across sparse made free throws and accepts a sparse period-end marker', () => {
  const firstFreeThrowStatistic = { type: 'freethrow', made: true, points: 1, free_throw_type: 'regular', team: { id: ids.home }, player: { id: ids.h1 } };
  const secondFreeThrowStatistic = { type: 'freethrow', made: true, points: 1, free_throw_type: 'regular', team: { id: ids.home }, player: { id: ids.h1 } };
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'foul', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, eventType: 'shootingfoul' }),
    event({
      id: 'ft-1', sequence: 3, clockRemainingMs: 710000, homePointsAfter: 1, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 2', statistics: [firstFreeThrowStatistic], eventType: 'freethrowmade'
    }),
    event({
      id: 'ft-2', sequence: 4, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '2 of 2', statistics: [secondFreeThrowStatistic], eventType: 'freethrowmade'
    }),
    event({ id: 'away-ball', sequence: 5, clockRemainingMs: 700000, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'rebound' }),
    event({ id: 'end', sequence: 6, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'eligible');
  assert.equal(result.possessions.length, 2);
  const homePossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  const awayPossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.away);
  assert.equal(homePossession.offensePoints, 2);
  assert.ok(homePossession.qualityFlags.includes('provider_regular_free_throw_state_inferred'));
  assert.equal(awayPossession.hasLineupChangeMidPossession, false);
  assert.ok(!result.validation.errors.some((error) => error.includes('missing_provider_possession_state')));
  assert.ok(!result.validation.errors.some((error) => error.includes('terminal_event_missing_valid_snapshot:end')));
});

test('does not invent a possession for a sparse made free throw or retain one for the wrong scoring team', () => {
  const noActivePossession = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'ft-without-state', sequence: 1, clockRemainingMs: 710000, homePointsAfter: 1, awayPointsAfter: 0, eventType: 'freethrowmade' }),
    event({ id: 'end', sequence: 2, clockRemainingMs: 0, homePointsAfter: 1, awayPointsAfter: 0, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 1, awayPoints: 0 } }));

  assert.equal(noActivePossession.coverageStatus, 'ineligible');
  assert.ok(noActivePossession.validation.errors.includes('score_event_without_active_provider_possession:ft-without-state'));
  assert.ok(noActivePossession.validation.errors.includes('score_event_missing_provider_possession_state:ft-without-state'));

  const wrongScoringTeam = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'home-ball', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'away-ft', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 1, eventType: 'freethrowmade' }),
    event({ id: 'end', sequence: 3, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 1, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 0, awayPoints: 1 } }));

  assert.equal(wrongScoringTeam.coverageStatus, 'ineligible');
  assert.ok(wrongScoringTeam.validation.errors.includes('score_event_missing_provider_possession_state:away-ft'));
});

test('resets lineup and possession state at a period boundary', () => {
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'q1-start', sequence: 1, periodNumber: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'q1-end', sequence: 2, periodNumber: 1, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 0, onCourt: null, eventType: 'endperiod' }),
    event({ id: 'q2-score', sequence: 3, periodNumber: 2, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'twopointmade' }),
    event({ id: 'q2-end', sequence: 4, periodNumber: 2, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'ineligible');
  assert.equal(result.stints.length, 1);
  assert.ok(result.validation.errors.includes('score_event_missing_valid_snapshot:q2-score'));
  assert.ok(result.validation.errors.includes('score_event_without_active_provider_possession:q2-score'));
  assert.ok(result.validation.errors.includes('possession_start_event_missing_valid_snapshot:q2-score'));
});

test('retains a fully verified technical free throw in the active offense without inventing a transition', () => {
  const technicalFreeThrow = { type: 'freethrow', made: true, points: 1, free_throw_type: 'technical', team: { id: ids.home }, player: { id: ids.h1 } };
  const fieldGoal = { type: 'fieldgoal', made: true, points: 2, team: { id: ids.home }, player: { id: ids.h1 } };
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'technical-foul', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, attributionTeamId: ids.away, eventType: 'technicalfoul' }),
    event({
      id: 'technical-ft', sequence: 3, clockRemainingMs: 710000, homePointsAfter: 1, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 1', statistics: [technicalFreeThrow], eventType: 'freethrowmade'
    }),
    event({
      id: 'home-make', sequence: 4, clockRemainingMs: 700000, homePointsAfter: 3, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, statistics: [fieldGoal], eventType: 'twopointmade'
    }),
    event({ id: 'end', sequence: 5, clockRemainingMs: 0, homePointsAfter: 3, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 3, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'eligible');
  const homePossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  assert.equal(homePossession.offensePoints, 3);
  assert.ok(homePossession.qualityFlags.includes('provider_technical_free_throw_state_retained'));
  assert.ok(!result.validation.errors.some((error) => error.includes('technical-ft')));

  const unproven = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'ordinary-foul', sequence: 2, clockRemainingMs: 710000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, attributionTeamId: ids.away, eventType: 'shootingfoul' }),
    event({
      id: 'unproven-technical-ft', sequence: 3, clockRemainingMs: 710000, homePointsAfter: 1, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 1', statistics: [technicalFreeThrow], eventType: 'freethrowmade'
    }),
    event({ id: 'end', sequence: 4, clockRemainingMs: 0, homePointsAfter: 1, awayPointsAfter: 0, possessionTeamId: ids.home, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 1, awayPoints: 0 } }));

  assert.equal(unproven.coverageStatus, 'ineligible');
  assert.ok(unproven.validation.errors.includes('score_event_missing_provider_possession_state:unproven-technical-ft'));
});

test('seeds only a verified first made field goal after a period boundary with no preceding provider state', () => {
  const fieldGoal = { type: 'fieldgoal', made: true, points: 2, team: { id: ids.home }, player: { id: ids.h1 } };
  const input = fullGameInput([
    event({ id: 'q1-start', sequence: 1, periodNumber: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'q1-end', sequence: 2, periodNumber: 1, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, onCourt: null, eventType: 'endperiod' }),
    event({ id: 'q2-lineup', sequence: 3, periodNumber: 2, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, onCourt: onCourt(secondHome), eventType: 'lineupchange' }),
    event({ id: 'q2-start', sequence: 4, periodNumber: 2, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, onCourt: onCourt(secondHome), eventType: 'startperiod' }),
    event({
      id: 'q2-make', sequence: 5, periodNumber: 2, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, onCourt: onCourt(secondHome), statistics: [fieldGoal], eventType: 'twopointmade'
    }),
    event({ id: 'q2-end', sequence: 6, periodNumber: 2, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'endgame' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } });
  const result = reconstructNbaGameLineups(input);

  assert.equal(result.coverageStatus, 'eligible');
  const inferred = result.possessions.find((row) => row.possessionSource === 'inferred_period_opening_made_field_goal');
  assert.ok(inferred);
  assert.equal(inferred.offenseProviderTeamId, ids.home);
  assert.equal(inferred.homePointsBefore, 0);
  assert.equal(inferred.awayPointsBefore, 0);
  assert.equal(inferred.offensePoints, 2);
  assert.ok(inferred.qualityFlags.includes('inferred_period_opening_offense_from_first_made_field_goal'));

  const blocked = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'q1-start', sequence: 1, periodNumber: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'q1-end', sequence: 2, periodNumber: 1, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home, onCourt: null, eventType: 'endperiod' }),
    event({ id: 'q2-miss', sequence: 3, periodNumber: 2, clockRemainingMs: 718000, homePointsAfter: 0, awayPointsAfter: 0, attributionTeamId: ids.home, eventType: 'twopointmissed' }),
    event({
      id: 'q2-make-after-live-action', sequence: 4, periodNumber: 2, clockRemainingMs: 710000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, statistics: [fieldGoal], eventType: 'twopointmade'
    }),
    event({ id: 'q2-end', sequence: 5, periodNumber: 2, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(blocked.coverageStatus, 'ineligible');
  assert.ok(blocked.validation.errors.includes('score_event_without_active_provider_possession:q2-make-after-live-action'));
});

test('merges a fully verified and-one state reversal into one scoring possession', () => {
  const fieldGoalStatistic = { type: 'fieldgoal', made: true, points: 2, team: { id: ids.home }, player: { id: ids.h1 } };
  const foulDrawnStatistic = { type: 'fouldrawn', team: { id: ids.home }, player: { id: ids.h1 } };
  const personalFoulStatistic = { type: 'personalfoul', team: { id: ids.away }, player: { id: ids.a1 } };
  const freeThrowStatistic = { type: 'freethrow', made: true, points: 1, free_throw_type: 'regular', team: { id: ids.home }, player: { id: ids.h1 } };
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'and-one-fg', sequence: 2, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, statistics: [fieldGoalStatistic], eventType: 'twopointmade'
    }),
    event({
      id: 'and-one-foul', sequence: 3, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.home, attributionTeamId: ids.away,
      statistics: [foulDrawnStatistic, personalFoulStatistic], eventType: 'shootingfoul'
    }),
    event({ id: 'timeout', sequence: 4, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0, onCourt: null, eventType: 'timeout' }),
    event({
      id: 'and-one-ft', sequence: 5, clockRemainingMs: 686000, homePointsAfter: 3, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 1', statistics: [freeThrowStatistic], eventType: 'freethrowmade'
    }),
    event({
      id: 'away-ball', sequence: 6, clockRemainingMs: 680000, homePointsAfter: 3, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.away,
      statistics: [{ type: 'fieldgoal', made: false, team: { id: ids.away }, player: { id: ids.a1 } }],
      eventType: 'threepointmissed'
    }),
    event({ id: 'end', sequence: 7, clockRemainingMs: 0, homePointsAfter: 3, awayPointsAfter: 0, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 3, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'eligible');
  assert.equal(result.possessions.length, 2);
  const homePossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  assert.equal(homePossession.offensePoints, 3);
  assert.equal(homePossession.hasLineupChangeMidPossession, false);
  assert.ok(homePossession.qualityFlags.includes('provider_and_one_state_reversal_merged'));
  assert.equal(result.stints.reduce((sum, stint) => sum + stint.homePoints, 0), 3);
  assert.ok(!result.validation.errors.some((error) => error.includes('and_one')));
});

test('uses an opponent regular free-throw trip as verified made-and-one transition evidence', () => {
  const homeFieldGoal = { type: 'fieldgoal', made: true, points: 2, team: { id: ids.home }, player: { id: ids.h1 } };
  const homeFoulDrawn = { type: 'fouldrawn', team: { id: ids.home }, player: { id: ids.h1 } };
  const awayPersonalFoul = { type: 'personalfoul', team: { id: ids.away }, player: { id: ids.a1 } };
  const homeFreeThrow = { type: 'freethrow', made: true, points: 1, free_throw_type: 'regular', team: { id: ids.home }, player: { id: ids.h1 } };
  const awayFoulDrawn = { type: 'fouldrawn', team: { id: ids.away }, player: { id: ids.a1 } };
  const homePersonalFoul = { type: 'personalfoul', team: { id: ids.home }, player: { id: ids.h2 } };
  const awayFirstFreeThrow = { type: 'freethrow', made: true, points: 1, free_throw_type: 'regular', team: { id: ids.away }, player: { id: ids.a1 } };
  const awaySecondFreeThrow = { type: 'freethrow', made: true, points: 1, free_throw_type: 'regular', team: { id: ids.away }, player: { id: ids.a1 } };
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'and-one-fg', sequence: 2, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, statistics: [homeFieldGoal], eventType: 'twopointmade'
    }),
    event({
      id: 'and-one-foul', sequence: 3, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.home, attributionTeamId: ids.away, statistics: [homeFoulDrawn, awayPersonalFoul], eventType: 'shootingfoul'
    }),
    event({
      id: 'and-one-ft', sequence: 4, clockRemainingMs: 686000, homePointsAfter: 3, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 1', statistics: [homeFreeThrow], eventType: 'freethrowmade'
    }),
    event({
      id: 'away-shooting-foul', sequence: 5, clockRemainingMs: 680000, homePointsAfter: 3, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, statistics: [awayFoulDrawn, homePersonalFoul], eventType: 'shootingfoul'
    }),
    event({
      id: 'away-ft-1', sequence: 6, clockRemainingMs: 680000, homePointsAfter: 3, awayPointsAfter: 1,
      possessionTeamId: ids.away, attributionTeamId: ids.away, attempt: '1 of 2', statistics: [awayFirstFreeThrow], eventType: 'freethrowmade'
    }),
    event({
      id: 'away-ft-2', sequence: 7, clockRemainingMs: 680000, homePointsAfter: 3, awayPointsAfter: 2,
      possessionTeamId: ids.home, attributionTeamId: ids.away, attempt: '2 of 2', statistics: [awaySecondFreeThrow], eventType: 'freethrowmade'
    }),
    event({ id: 'end', sequence: 8, clockRemainingMs: 0, homePointsAfter: 3, awayPointsAfter: 2, possessionTeamId: ids.home, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 3, awayPoints: 2 } }));

  assert.equal(result.coverageStatus, 'eligible');
  const homePossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  assert.equal(homePossession.offensePoints, 3);
  assert.ok(homePossession.qualityFlags.includes('provider_and_one_state_reversal_merged'));
  assert.ok(!result.validation.errors.some((error) => error.includes('and_one')));
});

test('uses a structured immediate rebound to verify a missed and-one', () => {
  const fieldGoalStatistic = { type: 'fieldgoal', made: true, points: 2, team: { id: ids.home }, player: { id: ids.h1 } };
  const foulDrawnStatistic = { type: 'fouldrawn', team: { id: ids.home }, player: { id: ids.h1 } };
  const personalFoulStatistic = { type: 'personalfoul', team: { id: ids.away }, player: { id: ids.a1 } };
  const missedFreeThrowStatistic = { type: 'freethrow', made: false, points: 0, free_throw_type: 'regular', team: { id: ids.home }, player: { id: ids.h1 } };
  const reboundStatistic = { type: 'rebound', team: { id: ids.away }, player: { id: ids.a1 } };
  const awayFieldGoalStatistic = { type: 'fieldgoal', made: true, points: 2, team: { id: ids.away }, player: { id: ids.a1 } };
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'and-one-fg', sequence: 2, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home, statistics: [fieldGoalStatistic], eventType: 'twopointmade'
    }),
    event({
      id: 'and-one-foul', sequence: 3, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.home, attributionTeamId: ids.away, statistics: [foulDrawnStatistic, personalFoulStatistic], eventType: 'shootingfoul'
    }),
    event({
      id: 'and-one-ft-miss', sequence: 4, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 1', statistics: [missedFreeThrowStatistic], eventType: 'freethrowmiss'
    }),
    event({
      id: 'defensive-rebound', sequence: 5, clockRemainingMs: 685000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.away, statistics: [reboundStatistic], eventType: 'rebound'
    }),
    event({
      id: 'away-make', sequence: 6, clockRemainingMs: 670000, homePointsAfter: 2, awayPointsAfter: 2,
      possessionTeamId: ids.home, attributionTeamId: ids.away, statistics: [awayFieldGoalStatistic], eventType: 'twopointmade'
    }),
    event({ id: 'end', sequence: 7, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 2, possessionTeamId: ids.home, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 2 } }));

  assert.equal(result.coverageStatus, 'eligible');
  const homePossession = result.possessions.find((row) => row.offenseProviderTeamId === ids.home);
  assert.equal(homePossession.offensePoints, 2);
  assert.ok(homePossession.qualityFlags.includes('provider_and_one_state_reversal_merged'));
  assert.ok(!result.validation.errors.some((error) => error.includes('and_one')));
});

test('fails closed on an ambiguous and-one-like state reversal', () => {
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'ambiguous-fg', sequence: 2, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, attributionTeamId: ids.home,
      statistics: [{ type: 'fieldgoal', made: true, team: { id: ids.home }, player: { id: ids.h1 } }], eventType: 'twopointmade'
    }),
    event({
      id: 'ambiguous-foul', sequence: 3, clockRemainingMs: 686000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.home, attributionTeamId: ids.away,
      statistics: [
        { type: 'fouldrawn', team: { id: ids.home }, player: { id: ids.h1 } },
        { type: 'personalfoul', team: { id: ids.away }, player: { id: ids.a1 } }
      ], eventType: 'shootingfoul'
    }),
    event({
      id: 'not-one-of-one', sequence: 4, clockRemainingMs: 686000, homePointsAfter: 3, awayPointsAfter: 0,
      attributionTeamId: ids.home, attempt: '1 of 2',
      statistics: [{ type: 'freethrow', made: true, free_throw_type: 'regular', team: { id: ids.home }, player: { id: ids.h1 } }],
      eventType: 'freethrowmade'
    }),
    event({ id: 'away-ball', sequence: 5, clockRemainingMs: 680000, homePointsAfter: 3, awayPointsAfter: 0, possessionTeamId: ids.away }),
    event({ id: 'end', sequence: 6, clockRemainingMs: 0, homePointsAfter: 3, awayPointsAfter: 0, onCourt: null, eventType: 'endperiod' })
  ], { expectedFinalScore: { homePoints: 3, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'ineligible');
  assert.ok(result.validation.errors.includes('ambiguous_and_one_state_reversal:ambiguous-fg'));
  assert.ok(!result.possessions.some((row) => row.qualityFlags.includes('provider_and_one_state_reversal_merged')));
});

test('marks provider-fastbreak clutch possessions and never renames non-fastbreak as half-court', () => {
  const clutch = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'q4-start', sequence: 1, periodNumber: 4, clockRemainingMs: 300000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'q4-home-score', sequence: 2, periodNumber: 4, clockRemainingMs: 295000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, qualifiers: [{ type: 'fast_break' }], eventType: 'twopointmade'
    }),
    event({ id: 'q4-away-score', sequence: 3, periodNumber: 4, clockRemainingMs: 1000, homePointsAfter: 2, awayPointsAfter: 2, possessionTeamId: ids.home, eventType: 'twopointmade' }),
    event({ id: 'q4-end', sequence: 4, periodNumber: 4, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 2, possessionTeamId: ids.home, eventType: 'endperiod' })
  ]));

  const scoringHomePossession = clutch.possessions.find((row) => row.offenseProviderTeamId === ids.home && row.offensePoints === 2);
  assert.ok(scoringHomePossession);
  assert.equal(scoringHomePossession.isClutchV1, true);
  assert.equal(scoringHomePossession.homeScoreStateV1, 'tied');
  assert.equal(scoringHomePossession.transitionContext, 'provider_fastbreak_v1');
  assert.notEqual(scoringHomePossession.transitionContext, 'half_court_heuristic_v1');
  assert.equal(isClutchV1({ periodNumber: 4, clockRemainingMs: 300000, homePointsBefore: 8, awayPointsBefore: 3 }), true);
  assert.equal(hasProviderFastbreakQualifier([{ fastbreak: false }]), false);
  assert.equal(hasProviderFastbreakQualifier([{ qualifier: 'fast break' }]), true);
  assert.equal(hasProviderFastbreakQualifier([{ type: 'FAST_BREAK', value: ' FALSE ' }]), false);
  assert.equal(hasProviderFastbreakQualifier([{ type: 'FAST_BREAK', enabled: 'YES' }]), true);
  assert.equal(hasProviderFastbreakQualifier([{ is_fast_break: 'No' }]), false);
});

test('emits an unclassified clutch context when period, clock, or score is unavailable', () => {
  assert.equal(isClutchV1({ clockRemainingMs: 300000, homePointsBefore: 8, awayPointsBefore: 3 }), null);
  assert.equal(isClutchV1({ periodNumber: 4, homePointsBefore: 8, awayPointsBefore: 3 }), null);
  assert.equal(isClutchV1({ periodNumber: 4, clockRemainingMs: 300000, homePointsBefore: 8 }), null);

  const missingPeriodStart = event({
    id: 'missing-period-start', sequence: 1, clockRemainingMs: 300000,
    homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home
  });
  const missingPeriodEnd = event({
    id: 'missing-period-end', sequence: 2, clockRemainingMs: 0,
    homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home,
    onCourt: null, eventType: 'endgame'
  });
  delete missingPeriodStart.periodNumber;
  delete missingPeriodStart.periodSequence;
  delete missingPeriodEnd.periodNumber;
  delete missingPeriodEnd.periodSequence;

  const result = reconstructNbaGameLineups(fullGameInput([
    missingPeriodStart,
    missingPeriodEnd
  ], { expectedFinalScore: { homePoints: 0, awayPoints: 0 } }));

  assert.equal(result.coverageStatus, 'eligible');
  assert.equal(result.possessions[0].isClutchV1, null);
});

test('classifies unknown score state explicitly and gates consequential missing scores only', () => {
  assert.equal(homeScoreStateV1(undefined, 0), 'unclassified');
  assert.equal(homeScoreStateV1(0, null), 'unclassified');
  assert.equal(isKnownScoreStateV1('unclassified'), true);

  const sparseAdministrative = reconstructNbaGameLineups(fullGameInput([
    event({
      id: 'sparse-start', sequence: 1, clockRemainingMs: 720000,
      homePointsAfter: undefined, awayPointsAfter: undefined,
      possessionTeamId: ids.home, eventType: 'Start Period'
    }),
    event({
      id: 'sparse-timeout', sequence: 2, clockRemainingMs: 710000,
      homePointsAfter: undefined, awayPointsAfter: undefined,
      possessionTeamId: ids.home, eventType: 'TIMEOUT'
    }),
    event({
      id: 'make', sequence: 3, clockRemainingMs: 700000, homePointsAfter: 2, awayPointsAfter: 0,
      possessionTeamId: ids.away, eventType: 'Two Point Made'
    }),
    event({ id: 'end', sequence: 4, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'End Period' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));

  assert.equal(sparseAdministrative.coverageStatus, 'eligible');
  assert.equal(sparseAdministrative.possessions[0].homeScoreStateV1, 'unclassified');
  assert.equal(sparseAdministrative.possessions[0].isClutchV1, null);
  assert.ok(sparseAdministrative.validation.warnings.includes('missing_score_after:sparse-start'));
  assert.ok(!sparseAdministrative.validation.errors.some((error) => error.includes('missing_score')));

  const missingScoringScore = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'unknown-make-score', sequence: 2, clockRemainingMs: 710000,
      homePointsAfter: undefined, awayPointsAfter: undefined,
      possessionTeamId: ids.away, eventType: 'Two Point Made'
    }),
    event({ id: 'end', sequence: 3, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'end_period' })
  ], { expectedFinalScore: { homePoints: 2, awayPoints: 0 } }));
  assert.equal(missingScoringScore.coverageStatus, 'ineligible');
  assert.ok(missingScoringScore.validation.errors.includes('missing_score_for_scoring_event:unknown-make-score'));

  const missingTransitionScore = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({
      id: 'unknown-transition-score', sequence: 2, clockRemainingMs: 710000,
      homePointsAfter: undefined, awayPointsAfter: undefined,
      possessionTeamId: ids.away, eventType: 'event'
    }),
    event({ id: 'end', sequence: 3, clockRemainingMs: 0, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'end_period' })
  ], { expectedFinalScore: { homePoints: 0, awayPoints: 0 } }));
  assert.equal(missingTransitionScore.coverageStatus, 'ineligible');
  assert.ok(missingTransitionScore.validation.errors.includes('missing_score_at_possession_transition:unknown-transition-score'));
});

test('validates reconstructed player minutes and possession counts when provider summary inputs are supplied', () => {
  const expectedMinutes = Object.fromEntries([...firstHome, ...away].map((playerId) => [playerId, 12]));
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'make', sequence: 2, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'twopointmade' }),
    event({ id: 'end', sequence: 3, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'endperiod' })
  ], {
    expectedFinalScore: { homePoints: 2, awayPoints: 0 },
    providerTeamPossessions: { home: 1, away: 0 },
    providerPlayerMinutes: expectedMinutes
  }));

  assert.equal(result.coverageStatus, 'eligible');
  assert.equal(result.validation.possessionTotals.verified, true);
  assert.equal(result.validation.playerMinutes.verified, true);
});

test('treats decimal summary possessions as a non-gating estimate', () => {
  const result = reconstructNbaGameLineups(fullGameInput([
    event({ id: 'start', sequence: 1, clockRemainingMs: 720000, homePointsAfter: 0, awayPointsAfter: 0, possessionTeamId: ids.home }),
    event({ id: 'make', sequence: 2, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'twopointmade' }),
    event({ id: 'end', sequence: 3, clockRemainingMs: 0, homePointsAfter: 2, awayPointsAfter: 0, possessionTeamId: ids.away, eventType: 'endperiod' })
  ], {
    expectedFinalScore: { homePoints: 2, awayPoints: 0 },
    providerTeamPossessions: { home: 1.44, away: 0.64 }
  }));

  assert.equal(result.coverageStatus, 'eligible');
  assert.equal(result.validation.possessionTotals.verified, true);
  assert.equal(result.validation.possessionTotals.summaryEstimateComparison.publicationGate, false);
  assert.equal(result.validation.possessionTotals.summaryEstimateComparison.withinAlertThreshold, true);
  assert.ok(!result.validation.warnings.includes('provider_possession_total_mismatch'));
});

test('combination expansion and UUIDs are deterministic', () => {
  const first = expandLineupCombinations({ providerTeamId: ids.home, lineupId: 'lineup-id', playerIds: firstHome });
  const second = expandLineupCombinations({ providerTeamId: ids.home, lineupId: 'lineup-id', playerIds: [...firstHome].reverse() });
  assert.equal(first.length, 31);
  assert.deepEqual(first, second);
  assert.equal(
    deterministicUuidV5('7db4cb88-c7d5-5a2d-b01d-902d9b0bfc9b', 'repeatable'),
    deterministicUuidV5('7db4cb88-c7d5-5a2d-b01d-902d9b0bfc9b', 'repeatable')
  );
});
