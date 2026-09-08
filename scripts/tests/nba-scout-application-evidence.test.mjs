import test from 'node:test';
import assert from 'node:assert/strict';
import { BOX_FIELDS, buildGameModelEvidence, aggregatePlayerSeasons } from '../lib/nba-scout-model-evidence.mjs';
import { buildPlayerSeasonSkillProfiles, buildPlayerIdentities, buildTeamSeasonSimulationProfiles } from '../lib/nba-scout-application-evidence.mjs';
import { validateSourceCorrections, correctionsForGame } from '../lib/nba-scout-source-corrections.mjs';

function fixture() {
  const players = ['H', 'A'].flatMap(team => Array.from({ length: 5 }, (_, i) => ({ id: `${team}${i}`,
    providerTeamId: team, fullName: `${team} player ${i}`, reference: String(100 + i), position: 'F', minutesPlayed: 10,
    officialBoxScore: { source: 'summary_endpoint', availableFields: [...BOX_FIELDS], fields: Object.fromEntries(BOX_FIELDS.map(field => [field, 0])) } })));
  return { game: { providerGameId: 'game', seasonStartYear: 2020, primaryPhase: 'regular', scheduledAt: '2021-01-01T00:00:00Z',
    homeProviderTeamId: 'H', awayProviderTeamId: 'A', homePoints: 0, awayPoints: 0 },
    teams: [{ id: 'H' }, { id: 'A' }], players, events: [],
    lineups: ['H', 'A'].map(team => ({ id: team, providerTeamId: team, playerIds: players.filter(row => row.providerTeamId === team).map(row => row.id) })),
    stints: [{ homeLineupId: 'H', awayLineupId: 'A', durationMs: 600000 }],
    possessions: [0, 1, 2, 3, 5, 7].map((points, i) => ({ id: `p${i}`, possessionOrdinal: i + 1, offenseProviderTeamId: 'H', defenseProviderTeamId: 'A',
      offensePoints: points, defensePoints: i === 0 ? 1 : 0, homeLineupId: 'H', awayLineupId: 'A', hasLineupChangeMidPossession: false })),
    analytics: { eligibleForPublication: true, methodVersion: 'test-only' } };
}
const build = (record, corrections = []) => buildGameModelEvidence(record, { replay: false, corrections });
const correction = () => ({ id: 'one', gameId: 'game', seasonStartYear: 2020, playerId: 'H0', teamId: 'H', field: 'steals',
  originalValue: -1, correctedValue: 0, authorization: 'explicit-user-request', reason: 'test-only authorized correction',
  sourceGzipSha256: 'a'.repeat(64), summaryOverlaySha256: 'b'.repeat(64) });

test('one authorized zero is effective data, not rewritten official evidence or training certification', () => {
  const input = fixture(), box = input.players[0].officialBoxScore;
  box.fields.steals = null; box.invalidFields = ['steals']; box.rejectedValues = { steals: -1 };
  const original = structuredClone(input);
  const built = build(input, [correction()]), row = built.players.find(row => row.playerId === 'H0');
  assert.deepEqual(input, original);
  assert.equal(row.officialTotals.steals, null); assert.equal(row.effectiveTotals.steals, 0);
  assert.equal(row.fieldReconciliation.steals, 'unavailable'); assert.equal(row.trainingEligible, false);
  assert.equal(row.sourceCorrections[0].independentlyVerified, false);
  assert.equal(built.summaryRefreshNeeded, false); assert.equal(built.originalSummaryIncomplete, true);
  const all = aggregatePlayerSeasons(built.players).find(row => row.playerId === 'H0' && row.teamId === 'ALL_TEAMS');
  assert.equal(all.fieldEvidence.steals.officialTotal, null); assert.equal(all.fieldEvidence.steals.effectiveTotal, 0);
  assert.equal(all.fieldEvidence.steals.userCorrectedGames, 1);
  assert.throws(() => build(fixture(), [correction()]), /no longer matches/);
});

test('corrections require exact source/revision binding and cannot apply twice', () => {
  const ledger = { version: 'nba_user_source_corrections_v1', entries: [correction()] };
  const rows = validateSourceCorrections(ledger);
  assert.equal(correctionsForGame(rows, fixture().game, 'a'.repeat(64), 'b'.repeat(64)).length, 1);
  assert.throws(() => correctionsForGame(rows, fixture().game, 'a'.repeat(64), 'c'.repeat(64)), /hash changed/);
  assert.throws(() => validateSourceCorrections({ ...ledger, entries: [correction(), correction()] }));
});

test('simulation exports preserve 5/7-point tails, coupled scores, order and cohort exclusions', () => {
  const input = fixture(); input.possessions.push({ ...input.possessions[0], id: 'unstable', hasLineupChangeMidPossession: true });
  const built = build(input), home = built.teamGames.find(row => row.teamId === 'H');
  assert.equal(built.simulationPossessions.length, 7);
  assert.equal(built.simulationPossessions.at(-1).observationEligible, false);
  assert.equal(home.observedOffensivePossessions, 6);
  assert.equal(home.offensePointHistogram['5'], 1); assert.equal(home.offensePointHistogram['7'], 1);
  assert.equal(home.jointOffenseDefensePointHistogram['0:1'], 1);
  const summary = buildTeamSeasonSimulationProfiles(built.teamGames).find(row => row.teamId === 'H');
  assert.equal(summary.offenseOutcomeMoments.points, 18);
  assert.equal(summary.offenseOutcomeMoments.mean, 3); assert.equal(summary.forecastValidated, false);
});

test('season-specific donor profiles retain zero counts, undefined zero-denominator accuracy, identities and planned unknown traits', () => {
  const built = build(fixture()), seasons = aggregatePlayerSeasons(built.players);
  const rows = buildPlayerSeasonSkillProfiles(built.players, seasons);
  const profile = rows.find(row => row.playerId === 'H0' && row.teamId === 'ALL_TEAMS');
  assert.equal(profile.perGame.points, 0);
  assert.equal(profile.ratios.freeThrowAccuracy.value, null);
  assert.equal(profile.officialRates.freeThrowPercentage, null);
  assert.ok(profile.unavailableObservedTraits.includes('height'));
  const identity = buildPlayerIdentities(built.players).find(row => row.playerId === 'H0');
  assert.deepEqual(identity.nbaReferenceIds, ['100']); assert.equal(identity.media.headshotUrl, null);
});

test('shot observations retain unknown fields and do not duplicate rescinded events', () => {
  const input = fixture();
  input.events = [{ id: 's', eventType: 'fieldgoal', statistics: [{ type: 'fieldgoal', team: { id: 'H' }, player: { id: 'H0' } }] }];
  input.events.push(structuredClone(input.events[0]), { ...input.events[0], id: 'removed', isRescinded: true });
  const built = build(input); assert.equal(built.shotEvents.length, 1);
  assert.equal(built.shotEvents[0].made, null); assert.equal(built.shotEvents[0].pointValue, null);
  assert.equal(built.shotEvents[0].shotClockSeconds, null);
});
