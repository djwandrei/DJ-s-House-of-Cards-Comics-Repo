import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(
  new URL('../../supabase-analytics/supabase/migrations/20260905090355_scout_daily_game_catalog.sql', import.meta.url),
  'utf8',
);
const expansion = fs.readFileSync(
  new URL('../../supabase-analytics/supabase/migrations/20260909004819_expand_scout_daily_game_window.sql', import.meta.url),
  'utf8',
);
const expanded2017 = fs.readFileSync(
  new URL('../../supabase-analytics/supabase/migrations/20260909120000_expand_scout_daily_game_window_2017_26.sql', import.meta.url),
  'utf8',
);

test('Scout daily game catalog is private, validation-gated, and optimized for eligible reads', () => {
  assert.match(source, /source_season_end_years <@ array\[2024, 2025, 2026\]::smallint\[\]/);
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

test('Scout daily game expansion carries the validated 2020-26 source window forward', () => {
  assert.match(expansion, /cardinality\(source_season_end_years\) between 1 and 6/);
  assert.match(expansion, /source_season_end_years <@ array\[2021, 2022, 2023, 2024, 2025, 2026\]::smallint\[\]/);
  assert.match(expansion, /source_season_end_year between 2021 and 2026/);
  assert.match(expansion, /create or replace function public\.register_nba_scout_daily_game_scope\(p_payload jsonb\)/);
  assert.match(expansion, /grant execute on function public\.register_nba_scout_daily_game_scope\(jsonb\) to service_role/);
});

test('Scout daily game catalog accepts the completed 2017-26 source window', () => {
  assert.match(expanded2017, /drop constraint if exists nba_scout_daily_game_scopes_source_season_end_years_2020_26_check/);
  assert.match(expanded2017, /cardinality\(source_season_end_years\) between 1 and 9/);
  assert.match(expanded2017, /source_season_end_years <@ array\[2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026\]::smallint\[\]/);
  assert.match(expanded2017, /source_season_end_year between 2018 and 2026/);
  assert.match(expanded2017, /if cardinality\(v_seasons\) not between 1 and 9/);
  assert.match(expanded2017, /create or replace function public\.register_nba_scout_daily_game_scope\(p_payload jsonb\)/);
});
