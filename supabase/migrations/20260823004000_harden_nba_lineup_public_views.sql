-- Make the fan-facing NBA views explicitly read-only. Database default grants
-- can differ between projects; a bare GRANT SELECT does not remove any
-- inherited privileges, so revoke first and then restore only browser reads.

revoke all on public.nba_lineup_player_pool from public, anon, authenticated;
revoke all on public.nba_lineup_available_seasons from public, anon, authenticated;
revoke all on public.nba_lineup_available_teams from public, anon, authenticated;

grant select on public.nba_lineup_player_pool to anon, authenticated;
grant select on public.nba_lineup_available_seasons to anon, authenticated;
grant select on public.nba_lineup_available_teams to anon, authenticated;
