import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../../supabase-analytics/supabase/migrations/20260905090355_scout_daily_game_catalog.sql', import.meta.url),
  'utf8',
);

test('Scout daily game catalog is private, validation-gated, and optimized for eligible reads', () => {
  assert.match(source, /source_season_end_years <@ array\[2021, 2022, 2023, 2024, 2025, 2026\]::smallint\[\]/);
  assert.match(source, /alter table public\.nba_scout_daily_game_scopes enable row level security/);
  assert.match(source, /alter table public\.nba_scout_daily_game_players enable row level security/);
  assert.match(source, /revoke all on table public\.nba_scout_daily_game_scopes from public, anon, authenticated, service_role/);
  assert.match(source, /revoke all on table public\.nba_scout_daily_game_players from public, anon, authenticated, service_role/);
  assert.match(source, /where display_eligible;/);
  assert.match(source, /source_validation_passed[\s\S]*calibration_status = 'validated'[\s\S]*calibration_all_components_improved/);
  assert.match(source, /create or replace function public\.get_nba_scout_daily_game_catalog\(\)[\s\S]*security definer set search_path = ''/);
  assert.match(source, /grant execute on function public\.get_nba_scout_daily_game_catalog\(\) to service_role/);
  assert.doesNotMatch(source, /grant\s+(?:select|all)\s+on\s+table\s+public\.nba_scout_daily_game_(?:scopes|players)\s+to\s+(?:public|anon|authenticated)/i);
});
