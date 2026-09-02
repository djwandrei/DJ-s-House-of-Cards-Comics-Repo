import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

const analyticsMigration = read(
  'supabase-sports-analytics', 'supabase', 'migrations',
  '20260902044207_pro_sports_athlete_slab_stats.sql'
);
const commerceMigration = read(
  'supabase', 'migrations', '20260902044216_pro_sports_product_slab_stats_cache.sql'
);
const worker = read(
  'supabase', 'functions', 'sync-pro-sports-product-slab-stats-cache', 'index.ts'
);
const client = read('supabase-client.js');
const catalog = read('catalog.js');

test('analytics adapter is private, scoped, and emits only rights-confirmed headshots', () => {
  assert.match(analyticsMigration, /get_pro_sports_athlete_slab_stats_batch\(.*uuid\[\]/s);
  assert.match(analyticsMigration, /security definer/i);
  assert.match(analyticsMigration, /athletes\.identity_status = 'active'/);
  assert.match(analyticsMigration, /memberships\.membership_status = 'verified'/);
  assert.match(analyticsMigration, /media\.rights_confirmed/);
  assert.match(analyticsMigration, /revoke all on function[\s\S]*from public, anon, authenticated;/i);
  assert.match(analyticsMigration, /grant execute on function[\s\S]*to service_role;/i);
  assert.doesNotMatch(analyticsMigration, /grant execute on function[\s\S]*to anon/i);
});

test('commerce cache uses a fail-closed visible-product RPC instead of direct browser access', () => {
  assert.match(commerceMigration, /enable row level security/i);
  assert.match(commerceMigration, /revoke all on public\.pro_sports_product_slab_stats_cache from public, anon, authenticated;/i);
  assert.match(commerceMigration, /sale_status not in \('hidden', 'archived', 'sold'\)/);
  assert.match(commerceMigration, /mappings\.review_state in \('auto_verified', 'human_verified'\)/);
  assert.match(commerceMigration, /cache\.athlete_ids = current_mapping_state\.athlete_ids/);
  assert.match(commerceMigration, /cache\.synced_at >= current_mapping_state\.latest_mapping_update/);
  assert.match(commerceMigration, /grant execute on function public\.get_pro_sports_product_slab_stats\(bigint\)[\s\S]*to anon, authenticated;/i);
  assert.doesNotMatch(commerceMigration, /grant select on public\.pro_sports_product_slab_stats_cache to anon/i);
});

test('the worker preserves current verified mappings and source-project isolation', () => {
  assert.match(worker, /PRO_SPORTS_ANALYTICS_PROJECT_REF/);
  assert.match(worker, /get_pro_sports_athlete_slab_stats_batch/);
  assert.match(worker, /from\('pro_sports_product_slab_stats_cache'\)/);
  assert.match(worker, /review_state', \['auto_verified', 'human_verified'\]/);
  assert.match(worker, /analyticsUrlMatchesProjectRef/);
  assert.match(worker, /countStaleCacheRows/);
  assert.doesNotMatch(worker, /\.delete\(\)/);
  assert.doesNotMatch(worker, /\.update\(\{[^}]*sale_status/s);
});

test('the browser calls only the public RPC after a matching product modal opens', () => {
  assert.match(client, /get_pro_sports_product_slab_stats/);
  assert.match(client, /pro-sports-product-slab-stats:/);
  assert.match(catalog, /isProSportsSlabStatsCandidate/);
  assert.match(catalog, /pro-sports-slab-stats\.mjs/);
  assert.match(catalog, /hydrateProSportsSlabStatsPanel/);
  assert.doesNotMatch(catalog, /product_athlete_mappings/);
});
