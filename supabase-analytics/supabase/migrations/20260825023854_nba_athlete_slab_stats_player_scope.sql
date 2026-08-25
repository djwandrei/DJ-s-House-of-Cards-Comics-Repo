-- The analytics adapter is private, but it can still receive a small athlete
-- batch.  Aggregate only those requested players instead of expanding the
-- all-player season-totals view first.
create or replace function public.get_nba_athlete_slab_stats_batch(p_athlete_ids uuid[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with player_scope as (
  select
    athletes.id as athlete_id,
    players.id as nba_player_id,
    players.full_name,
    players.primary_position,
    players.birth_date,
    players.height_inches,
    players.weight_pounds,
    players.college,
    players.country,
    players.debut_season_end_year,
    players.final_season_end_year,
    player_headshot.asset_url as headshot_url
  from public.athletes as athletes
  join public.nba_players as players on players.athlete_id = athletes.id
  left join lateral (
    select media.asset_url
    from public.nba_media_assets as media
    where media.player_id = players.id
      and media.asset_kind = 'headshot'
      and media.is_primary
      and media.rights_confirmed
    order by media.updated_at desc, media.id
    limit 1
  ) as player_headshot on true
  where athletes.id = any(coalesce(p_athlete_ids, '{}'::uuid[]))
    and athletes.identity_status = 'active'
), scoped_player_ids as materialized (
  select distinct nba_player_id
  from player_scope
), metric_candidates as (
  select
    stats.player_id,
    stats.season_end_year,
    stats.season_phase,
    metrics.metric_code,
    metrics.metric_value,
    stats.minutes_played,
    stats.is_multi_team_aggregate,
    bool_or(stats.is_multi_team_aggregate) over (
      partition by stats.player_id, stats.season_end_year, stats.season_phase, metrics.metric_code
    ) as has_provider_aggregate
  from public.nba_player_team_season_metric_values as metrics
  join public.nba_player_team_season_stats as stats on stats.id = metrics.stat_id
  join scoped_player_ids on scoped_player_ids.nba_player_id = stats.player_id
  where stats.season_phase in ('regular', 'playoffs')
    and metrics.metric_code in (
      'player_efficiency_rating',
      'true_shooting_percentage',
      'win_shares',
      'win_shares_per_48',
      'box_plus_minus',
      'value_over_replacement_player'
    )
), metric_scope as (
  select *
  from metric_candidates
  where (has_provider_aggregate and is_multi_team_aggregate)
     or (not has_provider_aggregate and not is_multi_team_aggregate)
), metric_rollups as (
  select
    player_id,
    season_end_year,
    season_phase,
    metric_code,
    case
      when bool_or(has_provider_aggregate) then max(metric_value)
      when metric_code in ('win_shares', 'value_over_replacement_player') then sum(metric_value)
      else coalesce(
        sum(metric_value * nullif(minutes_played, 0)) / nullif(sum(nullif(minutes_played, 0)), 0),
        avg(metric_value)
      )
    end as metric_value
  from metric_scope
  group by player_id, season_end_year, season_phase, metric_code
), season_metrics as (
  select
    player_id,
    season_end_year,
    season_phase,
    max(metric_value) filter (where metric_code = 'player_efficiency_rating') as player_efficiency_rating,
    max(metric_value) filter (where metric_code = 'true_shooting_percentage') as true_shooting_percentage,
    max(metric_value) filter (where metric_code = 'win_shares') as win_shares,
    max(metric_value) filter (where metric_code = 'win_shares_per_48') as win_shares_per_48,
    max(metric_value) filter (where metric_code = 'box_plus_minus') as box_plus_minus,
    max(metric_value) filter (where metric_code = 'value_over_replacement_player') as value_over_replacement_player
  from metric_rollups
  group by player_id, season_end_year, season_phase
), season_stat_candidates as (
  select
    stats.*,
    exists (
      select 1
      from public.nba_player_team_season_stats as team_stat
      where team_stat.player_id = stats.player_id
        and team_stat.season_end_year = stats.season_end_year
        and team_stat.season_phase = stats.season_phase
        and not team_stat.is_multi_team_aggregate
    ) as has_team_stints
  from public.nba_player_team_season_stats as stats
  join scoped_player_ids on scoped_player_ids.nba_player_id = stats.player_id
  where stats.season_phase in ('regular', 'playoffs')
), season_usable_stats as (
  select *
  from season_stat_candidates
  where not is_multi_team_aggregate or not has_team_stints
), season_totals as (
  select
    player_id,
    season_end_year,
    season_phase,
    sum(games_played) as games_played,
    sum(games_started) as games_started,
    sum(minutes_played) as minutes_played,
    sum(field_goals_made) as field_goals_made,
    sum(field_goals_attempted) as field_goals_attempted,
    case when sum(field_goals_attempted) > 0 then round(sum(field_goals_made)::numeric / sum(field_goals_attempted), 6) end as field_goal_percentage,
    sum(three_point_field_goals_made) as three_point_field_goals_made,
    sum(three_point_field_goals_attempted) as three_point_field_goals_attempted,
    case when sum(three_point_field_goals_attempted) > 0 then round(sum(three_point_field_goals_made)::numeric / sum(three_point_field_goals_attempted), 6) end as three_point_percentage,
    sum(free_throws_made) as free_throws_made,
    sum(free_throws_attempted) as free_throws_attempted,
    case when sum(free_throws_attempted) > 0 then round(sum(free_throws_made)::numeric / sum(free_throws_attempted), 6) end as free_throw_percentage,
    sum(total_rebounds) as total_rebounds,
    sum(assists) as assists,
    sum(steals) as steals,
    sum(blocks) as blocks,
    sum(turnovers) as turnovers,
    sum(points) as points
  from season_usable_stats
  group by player_id, season_end_year, season_phase
), season_rows as (
  select
    player_scope.athlete_id,
    totals.player_id,
    totals.season_end_year,
    seasons.season_label,
    totals.season_phase,
    totals.games_played,
    totals.games_started,
    totals.minutes_played,
    totals.field_goals_made,
    totals.field_goals_attempted,
    totals.field_goal_percentage,
    totals.three_point_field_goals_made,
    totals.three_point_field_goals_attempted,
    totals.three_point_percentage,
    totals.free_throws_made,
    totals.free_throws_attempted,
    totals.free_throw_percentage,
    totals.total_rebounds,
    totals.assists,
    totals.steals,
    totals.blocks,
    totals.turnovers,
    totals.points,
    season_metrics.player_efficiency_rating,
    season_metrics.true_shooting_percentage,
    season_metrics.win_shares,
    season_metrics.win_shares_per_48,
    season_metrics.box_plus_minus,
    season_metrics.value_over_replacement_player
  from season_totals as totals
  join public.nba_seasons as seasons on seasons.season_end_year = totals.season_end_year
  join player_scope on player_scope.nba_player_id = totals.player_id
  left join season_metrics
    on season_metrics.player_id = totals.player_id
   and season_metrics.season_end_year = totals.season_end_year
   and season_metrics.season_phase = totals.season_phase
), season_payloads as (
  select
    athlete_id,
    jsonb_agg(
      jsonb_build_object(
        'seasonEndYear', season_end_year,
        'seasonLabel', season_label,
        'phase', season_phase,
        'gamesPlayed', games_played,
        'gamesStarted', games_started,
        'minutesPlayed', minutes_played,
        'fieldGoalsMade', field_goals_made,
        'fieldGoalsAttempted', field_goals_attempted,
        'fieldGoalPercentage', field_goal_percentage,
        'threePointFieldGoalsMade', three_point_field_goals_made,
        'threePointFieldGoalsAttempted', three_point_field_goals_attempted,
        'threePointPercentage', three_point_percentage,
        'freeThrowsMade', free_throws_made,
        'freeThrowsAttempted', free_throws_attempted,
        'freeThrowPercentage', free_throw_percentage,
        'totalRebounds', total_rebounds,
        'assists', assists,
        'steals', steals,
        'blocks', blocks,
        'turnovers', turnovers,
        'points', points,
        'playerEfficiencyRating', player_efficiency_rating,
        'trueShootingPercentage', true_shooting_percentage,
        'winShares', win_shares,
        'winSharesPer48', win_shares_per_48,
        'boxPlusMinus', box_plus_minus,
        'valueOverReplacementPlayer', value_over_replacement_player
      )
      order by season_end_year desc, case season_phase when 'regular' then 0 else 1 end
    ) as seasons
  from season_rows
  group by athlete_id
), payloads as (
  select
    player_scope.athlete_id,
    jsonb_build_object(
      'athleteId', player_scope.athlete_id,
      'player', jsonb_build_object(
        'athleteId', player_scope.athlete_id,
        'nbaPlayerId', player_scope.nba_player_id,
        'name', player_scope.full_name,
        'primaryPosition', player_scope.primary_position,
        'birthDate', player_scope.birth_date,
        'heightInches', player_scope.height_inches,
        'weightPounds', player_scope.weight_pounds,
        'college', player_scope.college,
        'country', player_scope.country,
        'debutSeasonEndYear', player_scope.debut_season_end_year,
        'finalSeasonEndYear', player_scope.final_season_end_year,
        'headshotUrl', player_scope.headshot_url
      ),
      'seasons', coalesce(season_payloads.seasons, '[]'::jsonb)
    ) as payload
  from player_scope
  left join season_payloads on season_payloads.athlete_id = player_scope.athlete_id
)
select coalesce(jsonb_agg(payload order by athlete_id), '[]'::jsonb)
from payloads;
$$;

revoke all on function public.get_nba_athlete_slab_stats_batch(uuid[]) from public;
grant execute on function public.get_nba_athlete_slab_stats_batch(uuid[]) to service_role;

comment on function public.get_nba_athlete_slab_stats_batch(uuid[]) is
  'Private batch adapter for the commerce cache. Returns no product or customer data and scopes season aggregation to requested NBA athletes.';
