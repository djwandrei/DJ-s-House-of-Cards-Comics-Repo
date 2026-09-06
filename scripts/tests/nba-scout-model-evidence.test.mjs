import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { BOX_FIELDS, readOfficialBox, boxIdentityIssues, boxRates, buildGameModelEvidence, aggregatePlayerSeasons, BLUEPRINT_CAPABILITIES } from '../lib/nba-scout-model-evidence.mjs';
import { normalizeSummaryOverlay, summaryRefreshOptions, summaryQuotaHeaders } from '../refresh-scout-model-summaries.mjs';
import { rebuildOptions } from '../rebuild-scout-model-evidence.mjs';

function record() {
  const box = changes => ({ source: 'summary_endpoint', availableFields: [...BOX_FIELDS],
    fields: { ...Object.fromEntries(BOX_FIELDS.map(field => [field, 0])), ...changes } });
  const players = ['H', 'A'].flatMap(team => Array.from({ length: 5 }, (_, i) => ({
    id: `${team}${i}`, providerTeamId: team, fullName: `Test ${team}${i}`, minutesPlayed: 10,
    officialBoxScore: box(team === 'H' && i === 0 ? { points: 2, fieldGoalAttempts: 1, fieldGoalsMade: 1, twoPointAttempts: 1, twoPointMakes: 1 }
      : team === 'H' && i === 1 ? { assists: 1 } : {}),
  })));
  return {
    game: { providerGameId: 'g1', seasonStartYear: 2025, seasonEndYear: 2026, primaryPhase: 'regular',
      scheduledAt: '2025-11-01T00:00:00Z', homeProviderTeamId: 'H', awayProviderTeamId: 'A', status: 'closed' },
    teams: [{ id: 'H' }, { id: 'A' }], players,
    lineups: ['H', 'A'].map(team => ({ id: team, providerTeamId: team, playerIds: players.filter(row => row.providerTeamId === team).map(row => row.id) })),
    stints: [{ homeLineupId: 'H', awayLineupId: 'A', durationMs: 600000 }],
    possessions: [{ homeLineupId: 'H', awayLineupId: 'A', offenseProviderTeamId: 'H', defenseProviderTeamId: 'A', hasLineupChangeMidPossession: false }],
    analytics: { eligibleForPublication: true, methodVersion: 'test-only' },
    events: [{ id: 'event1', eventType: 'twopointmade', periodSequence: 1, eventSequence: 1,
      statistics: [
        { type: 'fieldgoal', made: true, points: 2, team: { id: 'H' }, player: { id: 'H0' }, shot_type: 'layup', shot_distance: 2 },
        { type: 'assist', team: { id: 'H' }, player: { id: 'H1' } },
      ] }],
  };
}
const build = input => buildGameModelEvidence(input, { replay: false });

test('refresh request budget is explicit and leaves the package input arguments unchanged', () => {
  const args = ['--manifest', 'a.json', '--seasons', '2022,2023,2024,2025'];
  assert.deepEqual(summaryRefreshOptions(args), { rebuildArgs: args, requestBudget: null });
  assert.deepEqual(summaryRefreshOptions([...args, '--request-budget', '999']), { rebuildArgs: args, requestBudget: 999 });
  for (const value of ['0', '-1', 'NaN', '2.5', '', '9007199254740992']) {
    assert.throws(() => summaryRefreshOptions(['--request-budget', value]), /positive integer/);
  }
  assert.throws(() => summaryRefreshOptions(['--request-budget', '1', '--request-budget', '1']), /positive integer/);
});

test('quota telemetry reports missing values as unknown and never copies arbitrary header data', () => {
  assert.deepEqual(summaryQuotaHeaders(new Headers()), { allotted: null, used: null, remaining: null });
  const headers = new Headers({ 'x-plan-quota-allotted': '1000', 'x-plan-quota-current': '3', 'x-plan-quota-remaining': 'not numeric', 'x-api-key': 'test-only-must-not-copy' });
  assert.deepEqual(summaryQuotaHeaders(headers), { allotted: 1000, used: 3, remaining: null });
});

test('data-first workflow cannot automatically rebuild or promote known missing Summary data', async () => {
  const refresh = await fs.readFile(new URL('../refresh-scout-model-summaries.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(refresh, /await\s+rebuildScoutModelEvidence\s*\(/);
  assert.match(refresh, /rebuildStarted: false/);
  const rebuild = await fs.readFile(new URL('../rebuild-scout-model-evidence.mjs', import.meta.url), 'utf8');
  const gate = rebuild.indexOf('assert.equal(refresh.length, 0,');
  assert.ok(gate > 0 && gate < rebuild.indexOf('const seasons = aggregatePlayerSeasons(allPlayers)'));
});

test('game-level rows independently reconcile official totals, PBP, and actual minutes', () => {
  const input = record(), before = structuredClone(input), result = build(input);
  assert.deepEqual(input, before, 'Input archive is immutable.');
  assert.equal(result.players.length, 10);
  assert.equal(result.players.every(row => row.trainingEligible), true);
  const scorer = result.players.find(row => row.playerId === 'H0');
  assert.equal(scorer.rates.per36.points, 7.2);
  assert.equal(scorer.rates.offensiveInvolvement, 1);
  assert.equal(scorer.rates.offensiveInvolvementPer36, 3.6);
  assert.equal(scorer.rates.per100OnCourtOffensivePossessions.points, null, 'No mismatched-scope per-100 estimate.');
  assert.deepEqual(result.assistedBasketConnections, [{ teamId: 'H', passerId: 'H1', shooterId: 'H0', assistedFieldGoals: 1 }]);
});

test('duplicate/rescinded events do not inflate production or assisted-basket connections', () => {
  const input = record(); input.events.push(structuredClone(input.events[0]), { ...structuredClone(input.events[0]), id: 'rescinded', isRescinded: true });
  const result = build(input);
  assert.equal(result.players.find(row => row.playerId === 'H0').pbpTotals.points, 2);
  assert.equal(result.assistedBasketConnections[0].assistedFieldGoals, 1);
});

test('offensive foul plus its separate turnover record counts only one turnover', () => {
  const input = record(), player = { id: 'H0' }, team = { id: 'H' };
  input.players[0].officialBoxScore.fields.turnovers = 1;
  input.players[0].officialBoxScore.fields.personalFouls = 1;
  input.events.push(
    { id: 'charge', eventType: 'offensivefoul', periodSequence: 1, clockRemainingMs: 120000,
      statistics: [{ type: 'offensivefoul', player, team }, { type: 'personalfoul', player, team }] },
    { id: 'lost-ball', eventType: 'turnover', periodSequence: 1, clockRemainingMs: 120000,
      statistics: [{ type: 'turnover', player, team }] },
  );
  const row = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(row.pbpTotals.turnovers, 1);
  assert.equal(row.pbpTotals.personalFouls, 1);
  assert.equal(row.fieldReconciliation.turnovers, 'matched');
  assert.equal(row.boxScoreReconciled, true);
  input.events.pop();
  const missing = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(missing.pbpTotals.turnovers, 0, 'Foul label alone is not an explicit turnover row.');
  assert.equal(missing.fieldReconciliation.turnovers, 'mismatch', 'An absent explicit row must remain visible to reconciliation.');
});

test('missing official fields remain unknown even when the PBP total exists', () => {
  const input = record(); delete input.players[0].officialBoxScore;
  const scorer = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(scorer.pbpTotals.points, 2);
  assert.equal(scorer.officialTotals.points, null);
  assert.equal(scorer.trainingEligible, false);
  assert.equal(scorer.fieldReconciliation.points, 'unavailable');
});

test('invalid provider fields remain traceable through game and all-team season evidence', () => {
  const input = record();
  const box = input.players[0].officialBoxScore;
  box.fields.steals = null;
  box.availableFields = box.availableFields.filter(field => field !== 'steals');
  box.invalidFields = ['steals'];
  const row = build(input).players.find(player => player.playerId === 'H0');
  assert.deepEqual(row.invalidOfficialFields, ['steals']);
  assert.equal(row.officialTotals.steals, null);
  assert.equal(row.boxScoreReconciled, false);
  const season = aggregatePlayerSeasons([row]).find(group => group.teamId === 'ALL_TEAMS');
  assert.equal(season.fieldEvidence.steals.invalidOfficialGames, 1);
  assert.equal(season.fieldEvidence.steals.officialTotal, null);
});

test('a contradictory official stat is reported, never overwritten to match PBP', () => {
  const input = record(); input.players[0].officialBoxScore.fields.points = 3;
  const scorer = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(scorer.officialTotals.points, 3);
  assert.equal(scorer.pbpTotals.points, 2);
  assert.ok(scorer.mismatchedFields.includes('points'));
  assert.ok(scorer.officialIdentityIssues.includes('points'));
  assert.equal(scorer.trainingEligible, false);
});

test('unknown shot result is not a miss; incomplete lineup scope cannot train workload', () => {
  const input = record(); input.events[0].eventType = 'shot'; delete input.events[0].statistics[0].made;
  const scorer = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(scorer.pbpTotals.points, null);
  assert.equal(scorer.pbpTotals.fieldGoalAttempts, 1);
  assert.equal(scorer.trainingEligible, false);
  const incomplete = record(); incomplete.analytics.eligibleForPublication = false;
  assert.equal(build(incomplete).players.some(row => row.trainingEligible), false);
});

test('minutes disagreement stays separate from box-score agreement', () => {
  const input = record(); input.players[0].minutesPlayed = 12;
  const scorer = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(scorer.boxScoreReconciled, true);
  assert.equal(scorer.minutesReconciled, false);
  assert.equal(scorer.trainingEligible, false);
  assert.equal(scorer.rates.per36.points, null, 'Incomplete reconstructed minutes cannot inflate full-game PBP production.');
  assert.equal(scorer.officialRates.per36.points, 6, 'Independent full-game counts keep their own full-game exposure.');
  assert.equal(scorer.rateExposure.pbpPer36Minutes, null);
});

test('reconciled per-36 uses independent full-game minutes, not the slightly shorter stint sum', () => {
  const input = record(); input.players[0].minutesPlayed = 10.05;
  const scorer = build(input).players.find(row => row.playerId === 'H0');
  assert.equal(scorer.minutes, 10, 'Observed stint exposure remains available as a diagnostic.');
  assert.equal(scorer.minutesReconciled, true);
  assert.equal(scorer.rates.per36.points, 72 / 10.05);
  assert.equal(scorer.rateExposure.pbpPer36Minutes, 10.05);
});

test('one missing or contradictory game exposure withholds complete all-team PBP per-36', () => {
  const first = build(record()).players.find(row => row.playerId === 'H0');
  const input = record(); input.game.providerGameId = 'g2'; input.players[0].minutesPlayed = 30;
  const second = build(input).players.find(row => row.playerId === 'H0');
  const total = aggregatePlayerSeasons([first, second]).find(row => row.teamId === 'ALL_TEAMS');
  assert.equal(total.minutes, 20);
  assert.equal(total.officialMinutes, 40);
  assert.equal(total.rates.per36.points, null);
  assert.equal(total.officialRates.per36.points, 3.6);
  assert.equal(total.rateExposure.pbpPer36Minutes, null);
  const missing = { ...structuredClone(second), officialMinutes: null, minutesReconciled: false };
  const partial = aggregatePlayerSeasons([first, missing]).find(row => row.teamId === 'ALL_TEAMS');
  assert.equal(partial.officialRates.per36.points, null);
  assert.equal(partial.rates.per36.points, null);
});

test('a fresh Summary overlay is separate evidence, never a rewrite of source rows', () => {
  const input = record(), overlay = { gameId: 'g1', homeTeamId: 'H', awayTeamId: 'A', players: structuredClone(input.players) };
  delete input.players[0].officialBoxScore;
  const result = buildGameModelEvidence(input, { replay: false, summaryOverlay: overlay });
  assert.equal(result.players.find(row => row.playerId === 'H0').trainingEligible, true);
  assert.equal(input.players[0].officialBoxScore, undefined);
  assert.throws(() => buildGameModelEvidence(input, { replay: false, summaryOverlay: { ...overlay, gameId: 'wrong' } }), /another game/);
});

test('season aggregation preserves trade gaps and keeps different phases/years apart', () => {
  const first = build(record()).players.find(row => row.playerId === 'H0');
  const second = { ...structuredClone(first), gameId: 'g2', teamId: 'A', scheduledAt: '2025-12-01T00:00:00Z' };
  second.officialTotals.points = null; second.fieldReconciliation.points = 'unavailable';
  second.boxScoreReconciled = false; second.trainingEligible = false;
  const playoff = { ...structuredClone(first), gameId: 'g3', phase: 'playoffs' };
  const otherSeason = { ...structuredClone(first), gameId: 'g4', seasonStartYear: 2024 };
  const groups = aggregatePlayerSeasons([first, second, playoff, otherSeason]);
  const allTeams = groups.find(row => row.teamId === 'ALL_TEAMS' && row.seasonStartYear === 2025 && row.phase === 'regular');
  assert.equal(allTeams.games, 2);
  assert.deepEqual(allTeams.teamIds, ['A', 'H']);
  assert.equal(allTeams.fieldEvidence.points.officialTotal, null);
  assert.equal(allTeams.fieldEvidence.points.officialPartialTotal, 2);
  assert.equal(allTeams.fieldEvidence.points.matchedGames, 1);
  assert.equal(allTeams.fieldEvidence.points.pbpTotal, 4);
  assert.equal(allTeams.officialRates.per36.points, null, 'A missing trade-team field cannot become a complete official rate.');
  assert.throws(() => aggregatePlayerSeasons([first, first]), /Duplicate player\/game/);
});

test('missing, invalid, and zero samples stay distinct', () => {
  const input = record().players[0];
  for (const invalid of [null, '', false, -1, 1.5]) {
    input.officialBoxScore.fields.fieldGoalAttempts = invalid;
    assert.equal(readOfficialBox(input).fieldGoalAttempts, null);
  }
  const zero = Object.fromEntries(BOX_FIELDS.map(field => [field, 0]));
  assert.equal(boxRates(zero, 10).threePointPercentage, null);
  assert.equal(boxRates(zero, 0).per36.points, null);
  assert.equal(boxRates(zero, 10).per36.points, 0);
  assert.ok(boxIdentityIssues({ ...zero, fieldGoalsMade: 2 }).includes('fieldGoalsMade'));
});

test('two independent assists on one event are not guessed into a relationship', () => {
  const input = record(); input.events[0].statistics.push({ type: 'assist', team: { id: 'H' }, player: { id: 'H2' } });
  assert.deepEqual(build(input).assistedBasketConnections, []);
});

test('excluded blueprint inputs are explicitly out of scope; existing features remain declared', () => {
  assert.ok(BLUEPRINT_CAPABILITIES.preserved.includes('O/D and net RAPM'));
  for (const field of ['defender assignments', 'screen coverage', 'wingspan', 'injuries', 'contracts', 'cognitive traits']) {
    assert.ok(BLUEPRINT_CAPABILITIES.excludedByRequest.includes(field));
  }
});

test('refresh checks independent game/team/score identity and strips only pseudo-player rows', () => {
  const gameId = '11111111-1111-4111-8111-111111111111', home = '22222222-2222-4222-8222-222222222222', away = '33333333-3333-4333-8333-333333333333';
  const payload = { id: gameId, status: 'closed', home: { id: home, points: 10, players: [{ full_name: 'Team' }] }, away: { id: away, points: 9, players: [] } };
  const expected = { providerGameId: gameId, homeProviderTeamId: home, awayProviderTeamId: away, homePoints: 10, awayPoints: 9 };
  const result = normalizeSummaryOverlay(payload, expected);
  assert.equal(result.skippedPseudoPlayers, 1);
  assert.deepEqual(result.players, []);
  assert.equal(payload.home.players.length, 1);
  assert.throws(() => normalizeSummaryOverlay(payload, { ...expected, homePoints: 11 }), /score changed/);
});

test('rebuild never targets a source directory or a location outside private outputs', () => {
  const core = ['--manifest', 'outputs/base/manifest.json', '--package-validation', 'outputs/base/validation.json',
    '--source-validation', 'outputs/source/validation.json', '--seasons', '2022,2023,2024,2025', '--archive-dir', 'outputs/source'];
  assert.throws(() => rebuildOptions([...core, '--output-dir', 'lineup-lab']), /escapes/);
  assert.throws(() => rebuildOptions([...core, '--output-dir', 'outputs/base']), /new output/);
  assert.throws(() => rebuildOptions([...core, '--output-dir', 'outputs/source']), /new output/);
});
