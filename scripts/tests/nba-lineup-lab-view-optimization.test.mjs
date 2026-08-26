import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../supabase-analytics/supabase/migrations/20260825063257_optimize_nba_lineup_lab_views.sql",
  import.meta.url,
);

test("Lineup Lab views keep their public-safe contract while avoiding full-history expansion", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  const lower = sql.toLowerCase();
  const teamsView = lower.split("create or replace view public.nba_lineup_available_teams")[1];

  assert.match(lower, /create index if not exists nba_player_team_season_stats_lineup_scope_idx/);
  assert.match(lower, /create or replace view public\.nba_lineup_player_pool\s+with \(security_invoker = true\)/);
  assert.match(lower, /join lateral \(\s*select\s+sum\(coalesce\(team_stats\.minutes_played/);
  assert.match(lower, /join lateral \(\s*select\s+36 \* sum\(coalesce\(league_stats\.points/);
  assert.doesNotMatch(lower, /with scoped_stats as/);

  assert.ok(teamsView, "optimized available-team view is required");
  assert.match(teamsView, /from public\.nba_player_team_season_stats as stats/);
  assert.doesNotMatch(teamsView, /from public\.nba_lineup_player_pool/);
  assert.match(teamsView, /revoke all on public\.nba_lineup_available_teams from public, anon, authenticated/);
  assert.match(teamsView, /grant select on public\.nba_lineup_player_pool, public\.nba_lineup_available_teams\s+to anon, authenticated/);
});
