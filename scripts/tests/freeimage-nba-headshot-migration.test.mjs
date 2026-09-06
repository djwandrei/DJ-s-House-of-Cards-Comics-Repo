import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { buildMediaSql } from '../import-nba-basketball-reference.mjs';

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
const FORWARD_REGISTRY_MIGRATION_PATH = path.join(
  process.cwd(),
  'supabase-analytics',
  'supabase',
  'migrations',
  '20260906033224_establish_nba_headshot_override_registry.sql',
);

function readMappings(sql) {
  return [...sql.matchAll(/\('([0-9a-f-]{36})'::uuid, '(https:\/\/iili\.io\/[^']+)'\)/g)]
    .map((match) => ({ playerId: match[1], assetUrl: match[2] }));
}

test('NBA FreeImage headshot migration seeds a private 2,325-row override registry', () => {
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
  assert.match(sql, /create table if not exists public\.nba_headshot_url_overrides/);
  assert.match(sql, /alter table public\.nba_headshot_url_overrides enable row level security/);
  assert.match(sql, /revoke all on table public\.nba_headshot_url_overrides from public, anon, authenticated, service_role/);
  assert.match(sql, /insert into public\.nba_headshot_url_overrides \(player_id, asset_url\)/);
  assert.match(sql, /on conflict \(player_id\) do update set/);
  assert.match(sql, /Expected % NBA headshot URL overrides; found %/);
  assert.match(sql, /from public\.nba_headshot_url_overrides as overrides/);
  assert.doesNotMatch(sql, /Expected 2325 NBA FreeImage headshot updates/);
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
  assert.match(sql, /for correction in/);
  assert.match(sql, /update public\.nba_headshot_url_overrides as overrides/);
  assert.match(sql, /if not found then/);
  assert.match(sql, /and media\.is_primary/);
  assert.match(sql, /and media\.rights_confirmed/);
  assert.match(sql, /and media\.asset_url = 'https:\/\/iili\.io\/nHzfRl2\.jpg'/);
  assert.doesNotMatch(sql, /Expected % NBA placeholder-headshot repairs; changed %/);
});

test('forward registry migration derives only a complete verified legacy catalog', () => {
  const sql = fs.readFileSync(FORWARD_REGISTRY_MIGRATION_PATH, 'utf8');

  assert.match(sql, /create table if not exists public\.nba_headshot_url_overrides/);
  assert.match(sql, /alter table public\.nba_headshot_url_overrides enable row level security/);
  assert.match(sql, /revoke all on table public\.nba_headshot_url_overrides from public, anon, authenticated, service_role/);
  assert.match(sql, /grant select on table public\.nba_headshot_url_overrides to service_role/);
  assert.match(sql, /expected_rows constant integer := 2325;/);
  assert.match(sql, /if override_rows = 0 then/);
  assert.match(sql, /and is_primary/);
  assert.match(sql, /and rights_confirmed/);
  assert.match(sql, /Cannot establish NBA headshot override registry/);
  assert.match(sql, /NBA headshot override registry must contain % unique reviewed rows/);
});

test('NBA media import preserves a registered player override without changing source provenance', () => {
  const sql = buildMediaSql({
    mediaRows: [{
      subject_type: 'player',
      external_id: 'examplepl01',
      season_end_year: null,
      team_code: null,
      asset_kind: 'headshot',
      asset_url: 'https://www.basketball-reference.com/req/example/images/headshots/examplepl01.jpg',
      alt_text: 'Example Player headshot',
      source_url: 'https://www.basketball-reference.com/players/e/examplepl01.html',
    }],
  });

  assert.match(sql, /to_regclass\('public\.nba_headshot_url_overrides'\)/);
  assert.match(sql, /apply the corresponding analytics migration before importing media/);
  assert.equal(
    (sql.match(/left join public\.nba_headshot_url_overrides as headshot_overrides/g) ?? []).length,
    2,
    'both update and insert paths must consult the registry',
  );
  assert.equal(
    (sql.match(/coalesce\(headshot_overrides\.asset_url, stage\.asset_url\)/g) ?? []).length,
    2,
    'both update and insert paths must retain the registered URL',
  );
});
