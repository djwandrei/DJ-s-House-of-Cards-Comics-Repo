-- Browser-safe, read-only views for DJ's Lineup Lab.
--
-- These views run in the analytics project. They deliberately expose no raw
-- provider payloads, import-run details, athlete-review evidence, catalog
-- mappings, or customer information.

create or replace view public.nba_lineup_player_pool
with (security_invoker = true)
as
with scoped_stats as (
  select stats.*
  from public.nba_player_team_season_stats as stats
  where not stats.is_multi_team_aggregate
), team_context as (
  select
    stats.season_end_year,
    stats.season_phase,
    stats.team_code,
    sum(coalesce(stats.minutes_played, 0))::numeric as team_total_minutes,
    (
      sum(coalesce(stats.field_goals_attempted, 0))::numeric
      + 0.44 * sum(coalesce(stats.free_throws_attempted, 0))::numeric
      - sum(coalesce(stats.offensive_rebounds, 0))::numeric
      + sum(coalesce(stats.turnovers, 0))::numeric
    ) as estimated_team_possessions
  from scoped_stats as stats
  group by stats.season_end_year, stats.season_phase, stats.team_code
), league_context as (
  select
    stats.season_end_year,
    stats.season_phase,
    36 * sum(coalesce(stats.points, 0))::numeric / nullif(sum(coalesce(stats.minutes_played, 0)), 0) as league_points_per_36,
    36 * sum(coalesce(stats.total_rebounds, 0))::numeric / nullif(sum(coalesce(stats.minutes_played, 0)), 0) as league_rebounds_per_36,
    36 * sum(coalesce(stats.assists, 0))::numeric / nullif(sum(coalesce(stats.minutes_played, 0)), 0) as league_assists_per_36,
    36 * sum(coalesce(stats.steals, 0))::numeric / nullif(sum(coalesce(stats.minutes_played, 0)), 0) as league_steals_per_36,
    36 * sum(coalesce(stats.blocks, 0))::numeric / nullif(sum(coalesce(stats.minutes_played, 0)), 0) as league_blocks_per_36,
    36 * sum(coalesce(stats.turnovers, 0))::numeric / nullif(sum(coalesce(stats.minutes_played, 0)), 0) as league_turnovers_per_36,
    (sum(coalesce(stats.field_goals_made, 0))::numeric + 0.5 * sum(coalesce(stats.three_point_field_goals_made, 0))::numeric)
      / nullif(sum(coalesce(stats.field_goals_attempted, 0)), 0) as league_efg_pct,
    sum(coalesce(stats.three_point_field_goals_made, 0))::numeric
      / nullif(sum(coalesce(stats.three_point_field_goals_attempted, 0)), 0) as league_three_pct
  from scoped_stats as stats
  group by stats.season_end_year, stats.season_phase
)
select
  stats.player_id,
  players.full_name as player_name,
  players.primary_position as player_primary_position,
  player_headshot.asset_url as player_headshot_url,
  team_logo.asset_url as team_logo_url,
  stats.season_end_year,
  seasons.season_label,
  stats.season_phase,
  stats.team_code,
  team_seasons.team_name,
  stats.listed_position,
  stats.player_age,
  stats.games_played,
  stats.games_started,
  stats.minutes_played,
  stats.field_goals_made,
  stats.field_goals_attempted,
  stats.three_point_field_goals_made,
  stats.three_point_field_goals_attempted,
  stats.free_throws_made,
  stats.free_throws_attempted,
  stats.offensive_rebounds,
  stats.defensive_rebounds,
  stats.total_rebounds,
  stats.assists,
  stats.steals,
  stats.blocks,
  stats.turnovers,
  stats.personal_fouls,
  stats.points,
  stats.source_name,
  stats.source_url,
  team_context.team_total_minutes,
  team_context.estimated_team_possessions,
  league_context.league_points_per_36,
  league_context.league_rebounds_per_36,
  league_context.league_assists_per_36,
  league_context.league_steals_per_36,
  league_context.league_blocks_per_36,
  league_context.league_turnovers_per_36,
  league_context.league_efg_pct,
  league_context.league_three_pct,
  coalesce(advanced_metrics.values, '{}'::jsonb) as advanced_metrics,
  exists (
    select 1
    from public.nba_player_team_season_stats as playoff_stats
    where playoff_stats.player_id = stats.player_id
      and playoff_stats.season_end_year = stats.season_end_year
      and playoff_stats.team_code = stats.team_code
      and playoff_stats.season_phase = 'playoffs'
      and not playoff_stats.is_multi_team_aggregate
  ) as postseason_available
from scoped_stats as stats
join public.nba_players as players on players.id = stats.player_id
join public.nba_seasons as seasons on seasons.season_end_year = stats.season_end_year
join public.nba_team_seasons as team_seasons on team_seasons.id = stats.team_season_id
join team_context
  on team_context.season_end_year = stats.season_end_year
  and team_context.season_phase = stats.season_phase
  and team_context.team_code = stats.team_code
join league_context
  on league_context.season_end_year = stats.season_end_year
  and league_context.season_phase = stats.season_phase
left join lateral (
  select jsonb_object_agg(metrics.metric_code, metrics.metric_value) as values
  from public.nba_player_team_season_metric_values as metrics
  where metrics.stat_id = stats.id
) as advanced_metrics on true
left join lateral (
  select media.asset_url
  from public.nba_media_assets as media
  where media.player_id = players.id
    and media.asset_kind = 'headshot'
    and media.is_primary
    and media.rights_confirmed
  order by media.updated_at desc
  limit 1
) as player_headshot on true
left join lateral (
  select media.asset_url
  from public.nba_media_assets as media
  where media.team_season_id = team_seasons.id
    and media.asset_kind = 'team_logo'
    and media.is_primary
    and media.rights_confirmed
  order by media.updated_at desc
  limit 1
) as team_logo on true;

create or replace view public.nba_lineup_available_seasons
with (security_invoker = true)
as
select seasons.season_end_year, seasons.season_label
from public.nba_seasons as seasons
where exists (
  select 1
  from public.nba_player_team_season_stats as stats
  where stats.season_end_year = seasons.season_end_year
    and not stats.is_multi_team_aggregate
)
order by seasons.season_end_year desc;

create or replace view public.nba_lineup_available_teams
with (security_invoker = true)
as
select distinct team_code, team_name, season_end_year, season_phase
from public.nba_lineup_player_pool
order by season_end_year desc, season_phase, team_name;

revoke all on public.nba_lineup_player_pool from public, anon, authenticated;
revoke all on public.nba_lineup_available_seasons from public, anon, authenticated;
revoke all on public.nba_lineup_available_teams from public, anon, authenticated;
grant select on public.nba_lineup_player_pool, public.nba_lineup_available_seasons,
  public.nba_lineup_available_teams to anon, authenticated;

comment on view public.nba_lineup_player_pool is
  'Read-only team-stint pool for Lineup Lab. Per-100 context remains estimated until verified play-by-play possession data is available.';
