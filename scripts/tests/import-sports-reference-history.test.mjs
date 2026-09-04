import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SOURCE_CONFIGS,
  SourceAccessBlockedError,
  assertWriteTarget,
  buildImportSql,
  createPageFetcher,
  optionsFromArgs,
  preflightSource,
} from '../import-sports-reference-history.mjs';

test('history options default to a resumable 1980-through-current run', () => {
  assert.deepEqual(optionsFromArgs([], new Date('2026-08-31T12:00:00Z')), {
    help: false,
    sports: ['mlb', 'nfl'],
    statGroups: {
      mlb: ['batting', 'pitching'],
      nfl: ['passing', 'rushing', 'receiving', 'defense', 'kicking', 'returns', 'scoring'],
    },
    seasonStart: 1980,
    seasonEnd: 2026,
    apply: false,
    analytics: false,
    requestDelayMs: 4000,
    refreshCache: false,
    cacheOnly: false,
  });
  assert.throws(() => optionsFromArgs(['--request-delay-ms', '2999']), /3000/);
  assert.deepEqual(optionsFromArgs(['--sport', 'nfl', '--stat-group', 'passing'], new Date('2026-08-31T12:00:00Z')).statGroups, {
    nfl: ['passing'],
  });
  assert.throws(() => optionsFromArgs(['--sport', 'both', '--stat-group', 'passing']), /exactly one --sport/);
});

test('cache-only mode requires an explicit source-permission acknowledgement', async () => {
  const options = optionsFromArgs(['--sport', 'nfl', '--cache-only']);
  assert.equal(options.cacheOnly, true);
  const fetchPage = createPageFetcher({
    source: SOURCE_CONFIGS.nfl, robots: null, requestDelayMs: 0,
    refreshCache: false, eventFile: `${process.cwd()}\\outputs\\sports-reference-import-work\\test-events.jsonl`,
    cacheOnly: true,
  });
  await assert.rejects(() => fetchPage({
    url: SOURCE_CONFIGS.nfl.pageUrl(1980, 'passing'),
    cacheFile: `${process.cwd()}\\outputs\\sports-reference-import-work\\missing-pfr-cache.html`,
  }), (error) => error instanceof SourceAccessBlockedError && error.details.reason === 'cache_missing');
});

test('apply requires the selected league target, one sport, and the write gate', () => {
  const options = optionsFromArgs(['--sport', 'mlb', '--apply', '--analytics']);
  assert.throws(() => assertWriteTarget(options, {}), /SPORTS_ANALYTICS_ALLOW_WRITE/);
  assert.throws(() => assertWriteTarget(options, {
    SPORTS_ANALYTICS_ALLOW_WRITE: 'confirmed',
    SPORTS_ANALYTICS_SUPABASE_URL: 'https://gkqdymnmczabcggvigce.supabase.co',
  }), /must exactly match/);
  const baseballTarget = assertWriteTarget(options, {
    SPORTS_ANALYTICS_ALLOW_WRITE: 'confirmed',
    SPORTS_ANALYTICS_SUPABASE_URL: 'https://sptahazcjnorayjkltdx.supabase.co',
  });
  assert.equal(baseballTarget.projectRef, 'sptahazcjnorayjkltdx');
  assert.equal(baseballTarget.projectUrl, 'https://sptahazcjnorayjkltdx.supabase.co');
  assert.equal(baseballTarget.workdir, `${process.cwd()}\\supabase-sports-analytics`);

  const footballTarget = assertWriteTarget(optionsFromArgs(['--sport', 'nfl', '--apply', '--analytics']), {
    SPORTS_ANALYTICS_ALLOW_WRITE: 'confirmed',
    SPORTS_ANALYTICS_SUPABASE_URL: 'https://iuhjjwqfkohrrjqgpahh.supabase.co',
  });
  assert.equal(footballTarget.projectRef, 'iuhjjwqfkohrrjqgpahh');
  assert.throws(() => assertWriteTarget(optionsFromArgs(['--sport', 'both', '--apply', '--analytics']), {
    SPORTS_ANALYTICS_ALLOW_WRITE: 'confirmed',
    SPORTS_ANALYTICS_SUPABASE_URL: 'https://sptahazcjnorayjkltdx.supabase.co',
  }), /exactly one --sport/);
});

test('source preflight fails closed on inaccessible robots or a security challenge', async () => {
  await assert.rejects(() => preflightSource(SOURCE_CONFIGS.nfl, {
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }),
  }), (error) => error instanceof SourceAccessBlockedError && error.details.reason === 'robots_http_error');
  await assert.rejects(() => preflightSource(SOURCE_CONFIGS.nfl, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'Performing security verification' }),
  }), (error) => error instanceof SourceAccessBlockedError && error.details.reason === 'security_challenge');
});

test('generated SQL is transactional, idempotent, private-targeted, and retains provenance', () => {
  const source = SOURCE_CONFIGS.mlb;
  const sql = buildImportSql({
    sport: 'mlb', source, seasonYear: 1980, statGroup: 'batting',
    sourceUrl: source.pageUrl(1980, 'batting'),
    runId: '00000000-0000-4000-8000-000000000001',
    rows: [{
      externalId: 'schmimi01', fullName: 'Mike Schmidt', normalizedName: 'mike schmidt',
      teamCode: 'PHI', teamName: 'Philadelphia Phillies', seasonPhase: 'regular',
      isMultiTeamAggregate: false, listedPosition: '3B', playerAge: 30, gamesPlayed: 150,
      metrics: { b_hr: 48 }, sourceRecordId: '1980:regular:batting:schmimi01:PHI',
      rawPayload: { b_hr: '48' },
    }],
  });
  assert.match(sql, /^\s*begin;/i);
  assert.match(sql, /on conflict \(player_id, season_year, team_code, season_phase, stat_group\) do update/i);
  assert.match(sql, /insert into public\.mlb_stat_source_records/i);
  assert.match(sql, /record_hash/i);
  assert.doesNotMatch(sql, /public\.products|orders|payments|customers/i);
  assert.match(sql, /commit;\s*$/i);
});
