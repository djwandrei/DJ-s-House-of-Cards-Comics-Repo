import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase-analytics',
  'supabase',
  'migrations',
  '20260902215725_freeimage_nba_headshot_urls.sql',
);
const REPAIR_MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase-analytics',
  'supabase',
  'migrations',
  '20260903075911_repair_nba_placeholder_headshots.sql',
);

function readMappings(sql) {
  return [...sql.matchAll(/\('([0-9a-f-]{36})'::uuid, '(https:\/\/iili\.io\/[^']+)'\)/g)]
    .map((match) => ({ playerId: match[1], assetUrl: match[2] }));
}

test('NBA FreeImage headshot migration keeps its applied 2,325-row contract', () => {
  const sql = fs.readFileSync(MIGRATION_PATH, 'utf8');
  const mappings = readMappings(sql);
  const playerIds = new Set(mappings.map((mapping) => mapping.playerId));
  const assetUrls = new Set(mappings.map((mapping) => mapping.assetUrl));

  assert.equal(mappings.length, 2325);
  assert.equal(playerIds.size, mappings.length, 'player IDs must be unique');
  assert.equal(
    mappings.filter((mapping) => mapping.assetUrl === 'https://iili.io/nHzfRl2.jpg').length,
    12,
    'the applied migration includes the twelve provider placeholder rows repaired later',
  );
  assert.equal(assetUrls.size, 2314, 'the placeholder is the only repeated asset URL');
  assert.match(sql, /if changed_rows <> 2325 then/);
  assert.match(sql, /Expected 2325 NBA FreeImage headshot updates/);
});

test('NBA FreeImage placeholder repair is scoped to the twelve verified primary headshots', () => {
  const sql = fs.readFileSync(REPAIR_MIGRATION_PATH, 'utf8');
  const corrections = [...sql.matchAll(
    /\('([0-9a-f-]{36})'::uuid, '(https:\/\/www\.basketball-reference\.com\/[^']+)'\)/g,
  )].map((match) => ({ playerId: match[1], assetUrl: match[2] }));
  const playerIds = new Set(corrections.map((correction) => correction.playerId));
  const assetUrls = new Set(corrections.map((correction) => correction.assetUrl));

  assert.equal(corrections.length, 12);
  assert.equal(playerIds.size, 12, 'each correction must target one player');
  assert.equal(assetUrls.size, 12, 'each correction must restore one verified source image');
  assert.match(sql, /expected_rows constant integer := 12;/);
  assert.match(sql, /and media\.is_primary/);
  assert.match(sql, /and media\.rights_confirmed/);
  assert.match(sql, /and media\.asset_url = 'https:\/\/iili\.io\/nHzfRl2\.jpg'/);
  assert.match(sql, /source_validation\.unique_players = expected_rows/);
  assert.match(sql, /source_validation\.unique_urls = expected_rows/);
});
