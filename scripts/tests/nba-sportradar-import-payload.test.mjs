import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildSportradarIngestPayload } from '../lib/nba-sportradar-import-payload.mjs';

const ids = Object.freeze({
  run: '00000000-0000-4000-8000-000000000001',
  game: '00000000-0000-4000-8000-000000000002',
  home: '00000000-0000-4000-8000-000000000003',
  away: '00000000-0000-4000-8000-000000000004',
  homePlayer: '00000000-0000-4000-8000-000000000005',
  awayPlayer: '00000000-0000-4000-8000-000000000006',
  event: '00000000-0000-4000-8000-000000000007',
  summaryDocument: '00000000-0000-4000-8000-000000000008',
  pbpDocument: '00000000-0000-4000-8000-000000000009',
});
const hash = crypto.createHash('sha256').update('fixture').digest('hex');

function document(id, resource) {
  return {
    id,
    resource,
    resourceKey: `${resource}:${ids.game}`,
    sourceUrl: `https://api.sportradar.com/nba/production/v8/en/games/${ids.game}/${resource}.json`,
    storageObjectPath: `${ids.game}/${resource}.json.gz`,
    contentSha256: hash,
    contentBytes: 42,
  };
}

function fixture() {
  const home = { id: ids.home, alias: 'HOM', market: 'Home', name: 'Team', players: [] };
  const away = { id: ids.away, alias: 'AWY', market: 'Away', name: 'Team', players: [] };
  return {
    run: { id: ids.run, accessLevel: 'production', licenseReference: 'internal-license', rightsConfirmed: true, requestedSeasonStart: 2025, requestedSeasonEnd: 2025, requestedPhase: 'regular' },
    scheduleGame: { id: ids.game, seasonStartYear: 2024, seasonEndYear: 2025, seasonPhase: 'regular', status: 'closed', coverage: 'full', trackOnCourt: true, home, away },
    summary: {
      gameId: ids.game, status: 'closed', coverage: 'full', trackOnCourt: true, home: { ...home, points: 100, possessions: 95 }, away: { ...away, points: 99, possessions: 95 },
      teams: [{ ...home, points: 100, possessions: 95 }, { ...away, points: 99, possessions: 95 }],
      players: [{ id: ids.homePlayer, providerTeamId: ids.home, fullName: 'Home Player' }],
    },
    playByPlay: {
      gameId: ids.game, validSnapshotCount: 1, invalidSnapshotCount: 0, deletedEvents: [],
      events: [{ id: ids.event, periodSequence: 1, periodNumber: 1, eventSequence: 1, eventType: 'twopointmade', homePointsAfter: 2, awayPointsAfter: 0, onCourt: { homePlayerIds: [ids.homePlayer], awayPlayerIds: [ids.awayPlayer], snapshotStatus: 'invalid_count' } }],
    },
    documents: [document(ids.summaryDocument, 'summary'), document(ids.pbpDocument, 'play_by_play')],
    analytics: { build: { status: 'partial', coverageStatus: 'partial' }, lineups: [], stints: [], possessions: [] },
  };
}

test('builds a private RPC payload with provider UUIDs and no name matching', () => {
  const payload = buildSportradarIngestPayload(fixture());
  assert.equal(payload.game.id, ids.game);
  assert.equal(payload.playByPlayDocumentId, ids.pbpDocument);
  assert.equal(payload.providerPlayers.length, 2);
  assert.equal(payload.providerPlayers.find((player) => player.id === ids.awayPlayer).fullName, '');
  assert.equal(payload.events[0].snapshot.status, 'invalid_count');
  assert.match(payload.analytics.build.inputSha256, /^[a-f0-9]{64}$/);
  assert.equal(payload.gameTeamStats[0].sourceDocumentId, ids.summaryDocument);
});

test('preserves the strict period-opening possession provenance accepted by the schema', () => {
  const input = fixture();
  input.analytics.possessions = [{
    id: ids.event,
    sourcePossessionId: 'period-opening-made-field-goal',
    possessionOrdinal: 1,
    possessionSource: 'inferred_period_opening_made_field_goal',
  }];
  const payload = buildSportradarIngestPayload(input);
  assert.equal(payload.analytics.possessions[0].possessionSource, 'inferred_period_opening_made_field_goal');

  input.analytics.possessions[0].possessionSource = 'unreviewed_inference';
  assert.throws(() => buildSportradarIngestPayload(input), /possessionSource is unsupported/);
});

test('rejects mismatched game identity and incomplete raw-document metadata', () => {
  const mismatched = fixture();
  mismatched.summary.gameId = ids.run;
  assert.throws(() => buildSportradarIngestPayload(mismatched), /same game ID/);
  const missing = fixture();
  missing.documents[0].contentSha256 = 'not-a-hash';
  assert.throws(() => buildSportradarIngestPayload(missing), /SHA-256/);
});
