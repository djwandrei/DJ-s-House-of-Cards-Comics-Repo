import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationPath = path.join(root, 'supabase', 'migrations', '20260825051422_commerce_nba_analytics_decommission.sql');
const workerPath = path.join(root, 'supabase', 'functions', 'sync-nba-product-slab-stats-cache', 'index.ts');

function normalized(source) {
  return source.replace(/\r\n/g, '\n');
}

test('commerce analytics decommission truncates only the copied NBA fact tables', () => {
  const migration = normalized(fs.readFileSync(migrationPath, 'utf8'));
  const truncate = migration.match(/truncate table\s+([\s\S]*?)\s+continue identity;/i)?.[1] || '';
  const expected = [
    'nba_player_team_season_metric_values',
    'nba_stat_source_records',
    'nba_player_team_season_stats',
    'nba_media_assets',
    'nba_player_external_ids',
    'nba_players',
    'nba_team_seasons',
    'nba_franchises',
    'nba_stat_metric_definitions',
    'nba_stat_import_runs',
    'nba_seasons',
  ];
  for (const table of expected) assert.match(truncate, new RegExp(`public\\.${table}`));
  for (const retained of ['products', 'product_athlete_mappings', 'athletes', 'athlete_league_memberships', 'athlete_aliases', 'athlete_external_ids']) {
    assert.doesNotMatch(truncate, new RegExp(`public\\.${retained}(?:,|\\s|$)`));
  }
  assert.doesNotMatch(truncate, /cascade/i);
});

test('commerce analytics decommission has a cache-only public stats contract', () => {
  const migration = normalized(fs.readFileSync(migrationPath, 'utf8'));
  assert.match(migration, /select public\.get_nba_product_slab_stats_cached\(p_product_id\)/);
  assert.match(migration, /drop function if exists public\.get_nba_product_slab_stats_legacy\(bigint\)/);
  assert.match(migration, /raise exception 'NBA analytics decommission aborted: % visible verified products lack a current cache entry\.'/);
  assert.match(migration, /fbbmuqbdpgsmvnezowwn/);
});

test('cache worker validates persisted rows from dedicated analytics without the legacy source RPC', () => {
  const worker = normalized(fs.readFileSync(workerPath, 'utf8'));
  assert.match(worker, /async function verifyStoredCache\(expectedRows: CacheWriteRow\[\]\)/);
  assert.match(worker, /analytics\.rpc\('get_nba_athlete_slab_stats_batch'/);
  assert.match(worker, /async function pruneObsoleteCache\(eligibleProductIds: number\[\]\)/);
  assert.match(worker, /cacheChecked: verification\.checked/);
  assert.doesNotMatch(worker, /verify_nba_product_slab_stats_cache/);
});
