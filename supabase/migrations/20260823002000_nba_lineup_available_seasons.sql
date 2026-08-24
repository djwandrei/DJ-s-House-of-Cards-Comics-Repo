-- Only expose historical seasons that actually have imported non-aggregate
-- player statistics. `nba_seasons` intentionally includes future placeholders
-- for schema consistency, but the Lineup Lab must not offer an empty season.

create or replace view public.nba_lineup_available_seasons
with (security_invoker = true)
as
select
  seasons.season_end_year,
  seasons.season_label
from public.nba_seasons as seasons
where exists (
  select 1
  from public.nba_player_team_season_stats as stats
  where stats.season_end_year = seasons.season_end_year
    and not stats.is_multi_team_aggregate
)
order by seasons.season_end_year desc;

grant select on public.nba_lineup_available_seasons to anon, authenticated;

comment on view public.nba_lineup_available_seasons is
  'Read-only historical seasons with at least one imported non-aggregate NBA player statistic.';
