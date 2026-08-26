-- Keep Lineup Lab's browser contract unchanged while making its bounded
-- team-season reads scale with the selected roster instead of materializing
-- every historical stat row first.

create index if not exists nba_player_team_season_stats_lineup_scope_idx
  on public.nba_player_team_season_stats (
    season_end_year,
    season_phase,
    team_code,
    team_season_id
  )
  where not is_multi_team_aggregate;

create or replace view public.nba_lineup_player_pool
with (security_invoker = true)
as
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
from public.nba_player_team_season_stats as stats
join public.nba_players as players on players.id = stats.player_id
join public.nba_seasons as seasons on seasons.season_end_year = stats.season_end_year
join public.nba_team_seasons as team_seasons on team_seasons.id = stats.team_season_id
join lateral (
  select
    sum(coalesce(team_stats.minutes_played, 0))::numeric as team_total_minutes,
    (
      sum(coalesce(team_stats.field_goals_attempted, 0))::numeric
      + 0.44 * sum(coalesce(team_stats.free_throws_attempted, 0))::numeric
      - sum(coalesce(team_stats.offensive_rebounds, 0))::numeric
      + sum(coalesce(team_stats.turnovers, 0))::numeric
    ) as estimated_team_possessions
  from public.nba_player_team_season_stats as team_stats
  where not team_stats.is_multi_team_aggregate
    and team_stats.season_end_year = stats.season_end_year
    and team_stats.season_phase = stats.season_phase
    and team_stats.team_code = stats.team_code
) as team_context on true
join lateral (
  select
    36 * sum(coalesce(league_stats.points, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_points_per_36,
    36 * sum(coalesce(league_stats.total_rebounds, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_rebounds_per_36,
    36 * sum(coalesce(league_stats.assists, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_assists_per_36,
    36 * sum(coalesce(league_stats.steals, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_steals_per_36,
    36 * sum(coalesce(league_stats.blocks, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_blocks_per_36,
    36 * sum(coalesce(league_stats.turnovers, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_turnovers_per_36,
    (
      sum(coalesce(league_stats.field_goals_made, 0))::numeric
      + 0.5 * sum(coalesce(league_stats.three_point_field_goals_made, 0))::numeric
    ) / nullif(sum(coalesce(league_stats.field_goals_attempted, 0)), 0) as league_efg_pct,
    sum(coalesce(league_stats.three_point_field_goals_made, 0))::numeric
      / nullif(sum(coalesce(league_stats.three_point_field_goals_attempted, 0)), 0) as league_three_pct
  from public.nba_player_team_season_stats as league_stats
  where not league_stats.is_multi_team_aggregate
    and league_stats.season_end_year = stats.season_end_year
    and league_stats.season_phase = stats.season_phase
) as league_context on true
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
) as team_logo on true
where not stats.is_multi_team_aggregate;

create or replace view public.nba_lineup_available_teams
with (security_invoker = true)
as
select distinct
  stats.team_code,
  team_seasons.team_name,
  stats.season_end_year,
  stats.season_phase
from public.nba_player_team_season_stats as stats
join public.nba_team_seasons as team_seasons on team_seasons.id = stats.team_season_id
where not stats.is_multi_team_aggregate
order by stats.season_end_year desc, stats.season_phase, team_seasons.team_name;

revoke all on public.nba_lineup_player_pool from public, anon, authenticated;
revoke all on public.nba_lineup_available_teams from public, anon, authenticated;
grant select on public.nba_lineup_player_pool, public.nba_lineup_available_teams
  to anon, authenticated;

comment on view public.nba_lineup_player_pool is
  'Read-only team-stint pool for Lineup Lab, optimized for one bounded team-season request. Per-100 context remains estimated until verified play-by-play possession data is available.';
comment on view public.nba_lineup_available_teams is
  'Read-only historical Lineup Lab team choices derived without expanding the full player analytics view.';
