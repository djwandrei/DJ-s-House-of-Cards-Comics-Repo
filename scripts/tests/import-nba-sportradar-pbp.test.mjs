import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAnalyticsProjectTarget } from '../lib/nba-analytics-project-target.mjs';
import {
  analyticsForReconstruction,
  invokeIngest,
  optionsFromArgs,
  rawSourceDocument,
  runMetadata,
  uploadPrivateSourceDocument,
} from '../import-nba-sportradar-pbp.mjs';

test('Sportradar importer requires an explicit, bounded season scope', () => {
  assert.throws(() => optionsFromArgs([]), /season-start is required/);
  assert.deepEqual(optionsFromArgs([
    '--season-start', '2024', '--season-end=2025', '--phase=regular,playoffs',
    '--max-games=3', '--request-delay-ms=1200', '--apply'
  ]), {
    help: false,
    apply: true,
    seasonStart: 2024,
    seasonEnd: 2025,
    phases: ['regular', 'playoffs'],
    gameId: '',
    maxGames: 3,
    requestDelayMs: 1200,
    reportPath: '',
  });
  assert.throws(() => optionsFromArgs(['--season-start', '2024', '--max-games', '0']), /max-games/);
  assert.throws(() => optionsFromArgs(['--season-start', '2024', '--unknown']), /Unknown option/);
});

test('import-run provenance uses canonical NBA season ending years', () => {
  const run = runMetadata({
    seasonStart: 2024,
    seasonEnd: 2025,
    phases: ['regular'],
  }, {
    accessLevel: 'production',
    licenseReference: 'internal-license',
  });
  assert.equal(run.requestedSeasonStart, 2025);
  assert.equal(run.requestedSeasonEnd, 2026);
  assert.equal(run.requestedPhase, 'regular');
});

test('analytics writes require an explicitly matched analytics project origin', () => {
  assert.equal(assertAnalyticsProjectTarget({
    projectUrl: 'https://analytics-project.supabase.co/',
    expectedProjectUrl: 'https://analytics-project.supabase.co',
  }), 'https://analytics-project.supabase.co');
  assert.throws(() => assertAnalyticsProjectTarget({
    projectUrl: 'https://commerce-project.supabase.co',
    expectedProjectUrl: 'https://analytics-project.supabase.co',
  }), /exactly match/);
  assert.throws(() => assertAnalyticsProjectTarget({
    projectUrl: 'https://analytics-project.supabase.co/rest/v1',
    expectedProjectUrl: 'https://analytics-project.supabase.co',
  }), /without a path/);
});

test('raw-source descriptors hash exactly the private gzip object, never a credential-bearing URL', () => {
  const raw = rawSourceDocument({
    id: '00000000-0000-4000-8000-000000000001',
    resource: 'play_by_play',
    resourceKey: 'game-id',
    response: {
      sourceUrl: 'https://api.sportradar.com/nba/production/v8/en/games/game-id/pbp.json',
      etag: '"source-version"',
      lastModified: 'Wed, 01 Jan 2025 00:00:00 GMT',
      receivedAt: '2025-01-01T00:00:00.000Z',
    },
    payload: { id: 'game-id', periods: [] },
    gameId: '00000000-0000-4000-8000-000000000002',
    seasonStart: 2024,
    phase: 'regular',
  });
  assert.equal(raw.bytes.subarray(0, 2).toString('hex'), '1f8b');
  assert.match(raw.document.contentSha256, /^[a-f0-9]{64}$/);
  assert.equal(raw.document.contentBytes, raw.bytes.length);
  assert.equal(raw.document.sourceUrl.includes('x-api-key'), false);
  assert.match(raw.document.storageObjectPath, /^v8\/2024\/regular\//);
});

test('private source documents use the Supabase Storage create-object POST route', async () => {
  const raw = rawSourceDocument({
    id: '00000000-0000-4000-8000-000000000011',
    resource: 'summary', resourceKey: 'fixture-game',
    response: {
      sourceUrl: 'https://api.sportradar.com/nba/production/v8/en/games/fixture-game/summary.json',
      etag: '', lastModified: '', receivedAt: '2025-01-01T00:00:00.000Z',
    },
    payload: { id: 'fixture-game' },
    gameId: '00000000-0000-4000-8000-000000000012',
    seasonStart: 2024, phase: 'regular',
  });
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, text: async () => '' };
  };
  try {
    await uploadPrivateSourceDocument({
      projectUrl: 'https://example-project.supabase.co', serviceRoleKey: 'test-service-role', raw,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(request.url, /^https:\/\/example-project\.supabase\.co\/storage\/v1\/object\/nba-sportradar-raw\//);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['x-upsert'], 'true');
  assert.equal(request.options.body, raw.bytes);
});

test('private game ingest passes its JSONB argument by the RPC parameter name', async () => {
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, text: async () => '{"ok":true}' };
  };
  const payload = { run: { id: 'fixture-run' }, game: { id: 'fixture-game' } };
  try {
    await invokeIngest({
      projectUrl: 'https://example-project.supabase.co', serviceRoleKey: 'test-service-role', payload,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(request.url, 'https://example-project.supabase.co/rest/v1/rpc/ingest_nba_sportradar_game');
  assert.deepEqual(JSON.parse(request.options.body), { p_payload: payload });
});

test('analytics payload preserves a completed but ineligible validation result privately', () => {
  const analytics = analyticsForReconstruction({
    methodVersion: 'fixture-v1',
    coverageStatus: 'ineligible',
    counts: { eventCount: 3, validSnapshotCount: 2, invalidSnapshotCount: 1 },
    validation: { errors: ['score_event_missing_valid_snapshot'], warnings: [] },
    lineupDefinitions: [], stints: [], possessions: [],
  }, {
    sourcePayload: { id: 'fixture-game', periods: [] },
    summary: { home: { points: 1, possessions: 1 }, away: { points: 0, possessions: 1 } },
  });
  assert.equal(analytics.build.status, 'completed');
  assert.equal(analytics.build.coverageStatus, 'ineligible');
  assert.equal(analytics.build.finalScoreVerified, false);
  assert.match(analytics.build.inputSha256, /^[a-f0-9]{64}$/);
});
