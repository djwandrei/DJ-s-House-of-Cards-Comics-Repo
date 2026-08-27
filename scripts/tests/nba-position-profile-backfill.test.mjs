import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPositionProfileCandidateQuery,
  buildPositionProfileUpsertSql,
  normalizePositionProfileCandidateRows,
  positionProfileFailureRecord,
  positionProfileRecordFromParsed,
} from '../lib/nba-position-profile-backfill.mjs';

const playerId = '1a111111-1111-4111-8111-111111111111';

test('position-profile candidates are sourced only from imported Basketball Reference IDs and pending status rows', () => {
  const sql = buildPositionProfileCandidateQuery({ limit: 75 });
  assert.match(sql, /public\.nba_player_external_ids/i);
  assert.match(sql, /public\.nba_player_team_season_stats/i);
  assert.match(sql, /external_ids\.source_name = 'basketball_reference'/i);
  assert.match(sql, /profile\.fetch_status = 'retry'/i);
  assert.match(sql, /limit 75/i);
  assert.doesNotMatch(sql, /insert\s+into|update\s+public|delete\s+from/i);
});

test('candidate normalization fails closed before a row can determine a source URL', () => {
  const candidates = normalizePositionProfileCandidateRows([
    { player_id: playerId, external_id: 'JamesLe01', latest_season_end_year: '2025' },
    { player_id: playerId, external_id: 'jamesle01', latest_season_end_year: 2024 },
    { player_id: 'not-a-uuid', external_id: 'unsafe-id!' },
  ]);
  assert.deepEqual(candidates, [{
    playerId,
    externalId: 'jamesle01',
    latestSeasonEndYear: 2025,
    priorStatus: '',
  }]);
});

test('profile records preserve source-backed multi-position eligibility without an inferred role', () => {
  const record = positionProfileRecordFromParsed({
    candidate: { playerId, externalId: 'jamesle01' },
    profile: {
      positionText: 'Small Forward, Power Forward, Point Guard, Center, and Shooting Guard',
      positions: ['SF', 'PF', 'PG', 'C', 'SG', 'wingspan'],
    },
  });
  assert.equal(record.fetchStatus, 'found');
  assert.deepEqual(record.eligiblePositions, ['SF', 'PF', 'PG', 'C', 'SG']);
  assert.equal(record.sourceUrl, 'https://www.basketball-reference.com/players/j/jamesle01.html');
  assert.equal(record.lastError, '');
});

test('only a definite missing profile is terminal; other fetch failures remain resumable', () => {
  assert.equal(positionProfileFailureRecord({
    candidate: { playerId, externalId: 'jamesle01' },
    error: { status: 404, message: 'not found' },
  }).fetchStatus, 'not_found');
  assert.equal(positionProfileFailureRecord({
    candidate: { playerId, externalId: 'jamesle01' },
    error: { status: 429, message: 'rate limited' },
  }).fetchStatus, 'retry');
});

test('the upsert keeps the database checkpoint idempotent and rejects unverified positions', () => {
  const sql = buildPositionProfileUpsertSql([positionProfileRecordFromParsed({
    candidate: { playerId, externalId: 'jamesle01' },
    profile: { positionText: 'Power Forward and Center', positions: ['PF', 'C'] },
  })]);
  assert.match(sql, /on conflict \(player_id, source_name, source_scope\) do update/i);
  assert.match(sql, /array\['PF', 'C'\]::text\[\]/i);
  assert.doesNotMatch(sql, /delete\s+from/i);
  assert.throws(() => buildPositionProfileUpsertSql([{
    playerId,
    externalId: 'jamesle01',
    fetchStatus: 'found',
    eligiblePositions: [],
  }]), /Found position profiles require positions/i);
});
