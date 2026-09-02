import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COMPACT_QUERY_KEYS } from '../import-local-scout-analytics.mjs';

const migrationUrl = new URL(
  '../../supabase-analytics/supabase/migrations/20260902090058_nba_scout_archive_query_index.sql',
  import.meta.url,
);

test('Scout query index is private, immutable, and service-role RPC-only', async () => {
  const rawSql = await readFile(migrationUrl, 'utf8');
  const sql = rawSql.toLowerCase();
  const tables = [
    'nba_scout_archive_imports',
    'nba_scout_archive_shards',
    'nba_scout_team_context_metrics',
    'nba_scout_lineup_summaries',
    'nba_scout_player_on_off_summaries',
    'nba_scout_player_on_off_context_metrics',
    'nba_scout_player_profiles',
    'nba_scout_wowy_summaries',
    'nba_scout_rapm_models',
    'nba_scout_rapm_players',
  ];
  const functions = [
    'begin_nba_scout_archive_import(jsonb)',
    'ingest_nba_scout_archive_shard(uuid, jsonb)',
    'ingest_nba_scout_rapm(uuid, jsonb)',
    'finalize_nba_scout_archive_import(uuid)',
    'nba_scout_archive_descriptor(uuid)',
    'get_nba_scout_archive_overview(smallint)',
    'get_nba_scout_team_context_analytics(smallint, uuid, text)',
    'get_nba_scout_lineup_analytics(smallint, uuid, uuid[])',
    'get_nba_scout_player_analytics(smallint, uuid, uuid, text)',
    'get_nba_scout_wowy(smallint, uuid, uuid, uuid)',
    'get_nba_scout_rapm(smallint, text, uuid, integer)',
  ];
  for (const table of tables) {
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security;`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated;`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${table} from service_role;`));
  }
  for (const signature of functions) {
    const escaped = signature.replace(/[()[\],]/g, '\\$&');
    assert.match(sql, new RegExp(`revoke all on function public\\.${escaped}\\s+from public, anon, authenticated;`));
    assert.match(sql, new RegExp(`grant execute on function public\\.${escaped}\\s+to service_role;`));
  }
  assert.match(sql, /constraint nba_scout_archive_imports_bucket_prefix_key unique \(archive_bucket, archive_prefix\)/);
  assert.match(sql, /payload_sha256 text not null check \(payload_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(sql, /if p_limit is null or p_limit < 1 or p_limit > 1000 then/);
  assert.match(sql, /nba_scout_compact_jsonb_is_safe/);
  assert.doesNotMatch(sql, /grant execute on function public\.get_nba_scout_[^(]+\([^;]+\) to anon, authenticated;/);

  const allowlist = /key <> all \(array\[(.*?)\]::text\[\]\)/s.exec(rawSql);
  assert.ok(allowlist, 'database compact-object allowlist must be present');
  const databaseKeys = new Set([...allowlist[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  assert.deepEqual(databaseKeys, COMPACT_QUERY_KEYS, 'importer and database compact-object allowlists must stay identical');
});
