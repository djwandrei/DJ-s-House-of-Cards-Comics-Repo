-- Offer only team-season-phase combinations that have an actual public player
-- pool. This keeps the playoff selector from presenting regular-season teams
-- that never recorded a postseason appearance.

create or replace view public.nba_lineup_available_teams
with (security_invoker = true)
as
select distinct
  team_code,
  team_name,
  season_end_year,
  season_phase
from public.nba_lineup_player_pool
order by season_end_year desc, season_phase, team_name;

grant select on public.nba_lineup_available_teams to anon, authenticated;

comment on view public.nba_lineup_available_teams is
  'Read-only historical team choices with an imported Lineup Lab player pool for the selected season and phase.';
