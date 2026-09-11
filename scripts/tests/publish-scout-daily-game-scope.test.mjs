import assert from 'node:assert/strict';
import test from 'node:test';
import {
  embeddedSeasonRow,
  createPositionIndex,
  lookupPositions,
  modelPayload,
  normalizePositions,
  parseArgs,
} from '../publish-scout-daily-game-scope.mjs';

const manifest = {
  scope: { seasonStartYears: [2017, 2018, 2019], seasonStartYear: 2017, latestSeasonStartYear: 2019, seasonEndYear: 2020 },
  rapm: { offenseDefense: { modelVersion: 'model-v4', inputSha256: 'a'.repeat(64), calibration: { allComponentsImproved: true } } },
};

test('publisher derives the source window and keeps the position flags explicit', () => {
  const args = parseArgs(['--manifest', 'manifest.json', '--source-validation', 'source.json', '--positions-file', 'positions.json']);
  assert.equal(args.scopeKey, 'scout-2017-26-v3');
  assert.equal(args.positionsFile.endsWith('positions.json'), true);
  assert.equal(args.fetchPositions, false);
  assert.throws(() => parseArgs(['--manifest', 'manifest.json', '--source-validation', 'source.json', '--positions-file', 'positions.json', '--fetch-positions']), /Choose/);
  const payload = modelPayload({ scopeKey: 'scout-test' }, manifest, 'b'.repeat(64), 42);
  assert.deepEqual(payload.sourceSeasonEndYears, [2018, 2019, 2020]);
  assert.match(payload.publicLabel, /2017–20/);
  assert.equal(payload.expectedPlayerCount, 42);
});

test('position crosswalk lookup is source-backed and fails closed on ambiguity', () => {
  assert.deepEqual(normalizePositions(['PG', 'SG', 'SF', 'PF', 'C']), ['G', 'F', 'C']);
  const index = createPositionIndex([
    { playerName: 'Alex Example', teamCode: 'MIN', seasonEndYear: 2020, listedPosition: 'PG' },
    { playerName: 'Alex Example', teamCode: 'BOS', seasonEndYear: 2020, listedPosition: 'C' },
    { playerName: 'Unique Example', teamCode: 'MIN', seasonEndYear: 2020, career_profile_positions: ['SF', 'PF'] },
  ]);
  assert.deepEqual(lookupPositions({ player: 'Unique Example' }, { code: 'MIN' }, 2020, index), ['SF', 'PF']);
  assert.equal(lookupPositions({ player: 'Alex Example' }, { code: 'LAL' }, 2020, index), null);
  assert.deepEqual(lookupPositions({ player: 'Alex Example' }, { code: 'MIN' }, 2020, index), ['PG']);
});

test('embedded direct season rows become bounded Daily Games input rows', () => {
  const profile = {
    playerId: 'provider-1', player: 'Example Player',
    seasonDirectStats: {
      '2017': { observed: true, boxScoreTotals: {
        points: 100, fieldGoalAttempts: 80, fieldGoalsMade: 40, threePointAttempts: 20,
        threePointersMade: 8, assists: 20, rebounds: 30, steals: 5, blocks: 2, turnovers: 4,
      }, shooting: { threePointPercentage: 0.4 }, scope: { verifiedGames: 10, matchingMinutes: 200 } },
    },
  };
  const row = embeddedSeasonRow(profile, { id: 'team-1', code: 'MIN' }, 2017,
    createPositionIndex([{ playerName: 'Example Player', teamCode: 'MIN', seasonEndYear: 2018, listedPosition: 'G' }]));
  assert.equal(row.playerId, 'provider-1');
  assert.equal(row.games, 10);
  assert.equal(row.perGame.points, 10);
  assert.equal(row.officialRates.threePointPercentage, 0.4);
  assert.deepEqual(row.listedPositions, ['G']);
  assert.equal(embeddedSeasonRow({ ...profile, seasonDirectStats: { '2017': { observed: false } } }, { id: 'team-1', code: 'MIN' }, 2017, createPositionIndex([])), null);
});
