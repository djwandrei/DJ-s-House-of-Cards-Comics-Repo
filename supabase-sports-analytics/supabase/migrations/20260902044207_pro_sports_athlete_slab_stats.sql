-- Private MLB/NFL athlete-stat adapter for the commerce cache.
--
-- Product IDs, mapping decisions, and shopper-facing publication stay in the
-- commerce project. This warehouse adapter accepts only already-verified
-- athlete IDs and returns a compact, normalized historical payload. It never
-- returns source provenance, external IDs, raw metrics, or commerce data.
--
-- The source tables retain team stints as well as provider aggregate rows.
-- Prefer an aggregate row where the provider supplies one; otherwise add the
-- individual stints. Derived rates use the resulting totals, avoiding a
-- misleading sum or unweighted average of per-team rates.

create or replace function public.get_pro_sports_athlete_slab_stats_batch(
  p_league_code text,
  p_athlete_ids uuid[]
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with input as (
  select
    upper(trim(coalesce(p_league_code, ''))) as league_code,
    coalesce(p_athlete_ids, '{}'::uuid[]) as athlete_ids
), mlb_player_scope as (
  select
    athletes.id as athlete_id,
    players.id as player_id,
    players.full_name,
    players.primary_position,
    headshot.asset_url as headshot_url
  from input
  join public.athletes as athletes
    on athletes.id = any(input.athlete_ids)
   and athletes.identity_status = 'active'
  join public.athlete_league_memberships as memberships
    on memberships.athlete_id = athletes.id
   and memberships.league_code = 'MLB'
   and memberships.membership_status = 'verified'
  join public.mlb_players as players on players.athlete_id = athletes.id
  left join lateral (
    select media.asset_url
    from public.mlb_media_assets as media
    where media.player_id = players.id
      and media.asset_kind = 'headshot'
      and media.rights_confirmed
    order by media.updated_at desc, media.id
    limit 1
  ) as headshot on true
  where input.league_code = 'MLB'
), nfl_player_scope as (
  select
    athletes.id as athlete_id,
    players.id as player_id,
    players.full_name,
    players.primary_position,
    headshot.asset_url as headshot_url
  from input
  join public.athletes as athletes
    on athletes.id = any(input.athlete_ids)
   and athletes.identity_status = 'active'
  join public.athlete_league_memberships as memberships
    on memberships.athlete_id = athletes.id
   and memberships.league_code = 'NFL'
   and memberships.membership_status = 'verified'
  join public.nfl_players as players on players.athlete_id = athletes.id
  left join lateral (
    select media.asset_url
    from public.nfl_media_assets as media
    where media.player_id = players.id
      and media.asset_kind = 'headshot'
      and media.rights_confirmed
    order by media.updated_at desc, media.id
    limit 1
  ) as headshot on true
  where input.league_code = 'NFL'
), player_scope as (
  select athlete_id, 'MLB'::text as league_code, player_id, full_name, primary_position, headshot_url
  from mlb_player_scope
  union all
  select athlete_id, 'NFL'::text as league_code, player_id, full_name, primary_position, headshot_url
  from nfl_player_scope
), mlb_scoped_player_ids as materialized (
  select player_id from player_scope where league_code = 'MLB'
), nfl_scoped_player_ids as materialized (
  select player_id from player_scope where league_code = 'NFL'
), mlb_stat_candidates as (
  select
    stats.player_id,
    stats.season_year,
    stats.season_phase,
    stats.stat_group,
    stats.games_played,
    stats.metric_values,
    stats.is_multi_team_aggregate,
    bool_or(stats.is_multi_team_aggregate) over (
      partition by stats.player_id, stats.season_year, stats.season_phase, stats.stat_group
    ) as has_provider_aggregate
  from public.mlb_player_team_season_stats as stats
  join mlb_scoped_player_ids as scoped on scoped.player_id = stats.player_id
  where stats.season_phase in ('regular', 'postseason')
), mlb_usable_stats as (
  select *
  from mlb_stat_candidates
  where (has_provider_aggregate and is_multi_team_aggregate)
     or (not has_provider_aggregate and not is_multi_team_aggregate)
), mlb_totals as (
  select
    player_id,
    season_year,
    season_phase,
    stat_group,
    sum(games_played) as games_played,
    sum(nullif(metric_values ->> 'b_pa', '')::numeric) as plate_appearances,
    sum(nullif(metric_values ->> 'b_ab', '')::numeric) as at_bats,
    sum(nullif(metric_values ->> 'b_h', '')::numeric) as hits,
    sum(nullif(metric_values ->> 'b_hr', '')::numeric) as home_runs,
    sum(nullif(metric_values ->> 'b_rbi', '')::numeric) as runs_batted_in,
    sum(nullif(metric_values ->> 'b_r', '')::numeric) as runs,
    sum(nullif(metric_values ->> 'b_sb', '')::numeric) as stolen_bases,
    sum(nullif(metric_values ->> 'b_bb', '')::numeric) as walks,
    sum(nullif(metric_values ->> 'b_so', '')::numeric) as strikeouts,
    sum(nullif(metric_values ->> 'b_doubles', '')::numeric) as doubles,
    sum(nullif(metric_values ->> 'b_triples', '')::numeric) as triples,
    sum(nullif(metric_values ->> 'b_hbp', '')::numeric) as hit_by_pitch,
    sum(nullif(metric_values ->> 'b_sf', '')::numeric) as sacrifice_flies,
    sum(nullif(metric_values ->> 'b_tb', '')::numeric) as total_bases,
    sum(nullif(metric_values ->> 'b_war', '')::numeric) as batting_war,
    sum(nullif(metric_values ->> 'innings_pitched_outs', '')::numeric) as innings_pitched_outs,
    sum(nullif(metric_values ->> 'p_w', '')::numeric) as wins,
    sum(nullif(metric_values ->> 'p_l', '')::numeric) as losses,
    sum(nullif(metric_values ->> 'p_sv', '')::numeric) as saves,
    sum(nullif(metric_values ->> 'p_so', '')::numeric) as pitching_strikeouts,
    sum(nullif(metric_values ->> 'p_bb', '')::numeric) as pitching_walks,
    sum(nullif(metric_values ->> 'p_er', '')::numeric) as earned_runs,
    sum(nullif(metric_values ->> 'p_h', '')::numeric) as hits_allowed,
    sum(nullif(metric_values ->> 'p_hr', '')::numeric) as home_runs_allowed,
    sum(nullif(metric_values ->> 'p_war', '')::numeric) as pitching_war
  from mlb_usable_stats
  group by player_id, season_year, season_phase, stat_group
), mlb_season_payloads as (
  select
    scoped.athlete_id,
    totals.season_year,
    totals.season_phase,
    totals.stat_group,
    jsonb_strip_nulls(jsonb_build_object(
      'seasonEndYear', totals.season_year,
      'seasonLabel', totals.season_year::text,
      'phase', totals.season_phase,
      'statGroup', totals.stat_group,
      'gamesPlayed', totals.games_played,
      'metrics', case totals.stat_group
        when 'batting' then jsonb_strip_nulls(jsonb_build_object(
          'plateAppearances', totals.plate_appearances,
          'atBats', totals.at_bats,
          'hits', totals.hits,
          'homeRuns', totals.home_runs,
          'runsBattedIn', totals.runs_batted_in,
          'runs', totals.runs,
          'stolenBases', totals.stolen_bases,
          'walks', totals.walks,
          'strikeouts', totals.strikeouts,
          'doubles', totals.doubles,
          'triples', totals.triples,
          'battingAverage', round(totals.hits / nullif(totals.at_bats, 0), 3),
          'onBasePercentage', round(
            (totals.hits + totals.walks + totals.hit_by_pitch)
              / nullif(totals.at_bats + totals.walks + totals.hit_by_pitch + totals.sacrifice_flies, 0),
            3
          ),
          'sluggingPercentage', round(totals.total_bases / nullif(totals.at_bats, 0), 3),
          'onBasePlusSlugging', round(
            ((totals.hits + totals.walks + totals.hit_by_pitch)
              / nullif(totals.at_bats + totals.walks + totals.hit_by_pitch + totals.sacrifice_flies, 0))
            + (totals.total_bases / nullif(totals.at_bats, 0)),
            3
          ),
          'war', totals.batting_war
        ))
        when 'pitching' then jsonb_strip_nulls(jsonb_build_object(
          'inningsPitchedOuts', totals.innings_pitched_outs,
          'wins', totals.wins,
          'losses', totals.losses,
          'saves', totals.saves,
          'strikeouts', totals.pitching_strikeouts,
          'walks', totals.pitching_walks,
          'earnedRuns', totals.earned_runs,
          'hitsAllowed', totals.hits_allowed,
          'homeRunsAllowed', totals.home_runs_allowed,
          'earnedRunAverage', round(totals.earned_runs * 27 / nullif(totals.innings_pitched_outs, 0), 2),
          'whip', round((totals.pitching_walks + totals.hits_allowed) * 3 / nullif(totals.innings_pitched_outs, 0), 2),
          'strikeoutsPerNine', round(totals.pitching_strikeouts * 27 / nullif(totals.innings_pitched_outs, 0), 2),
          'war', totals.pitching_war
        ))
      end
    )) as season_payload
  from mlb_totals as totals
  join player_scope as scoped
    on scoped.league_code = 'MLB'
   and scoped.player_id = totals.player_id
), nfl_stat_candidates as (
  select
    stats.player_id,
    stats.season_year,
    stats.season_phase,
    stats.stat_group,
    stats.games_played,
    stats.games_started,
    stats.metric_values,
    stats.is_multi_team_aggregate,
    bool_or(stats.is_multi_team_aggregate) over (
      partition by stats.player_id, stats.season_year, stats.season_phase, stats.stat_group
    ) as has_provider_aggregate
  from public.nfl_player_team_season_stats as stats
  join nfl_scoped_player_ids as scoped on scoped.player_id = stats.player_id
  where stats.season_phase in ('regular', 'postseason')
), nfl_usable_stats as (
  select *
  from nfl_stat_candidates
  where (has_provider_aggregate and is_multi_team_aggregate)
     or (not has_provider_aggregate and not is_multi_team_aggregate)
), nfl_totals as (
  select
    player_id,
    season_year,
    season_phase,
    stat_group,
    sum(games_played) as games_played,
    sum(games_started) as games_started,
    sum(nullif(metric_values ->> 'pass_cmp', '')::numeric) as completions,
    sum(nullif(metric_values ->> 'pass_att', '')::numeric) as passing_attempts,
    sum(nullif(metric_values ->> 'pass_yds', '')::numeric) as passing_yards,
    sum(nullif(metric_values ->> 'pass_td', '')::numeric) as passing_touchdowns,
    sum(nullif(metric_values ->> 'pass_int', '')::numeric) as interceptions_thrown,
    sum(nullif(metric_values ->> 'pass_sacked', '')::numeric) as sacks_taken,
    sum(nullif(metric_values ->> 'pass_first_down', '')::numeric) as passing_first_downs,
    sum(nullif(metric_values ->> 'rush_att', '')::numeric) as rushing_attempts,
    sum(nullif(metric_values ->> 'rush_yds', '')::numeric) as rushing_yards,
    sum(nullif(metric_values ->> 'rush_td', '')::numeric) as rushing_touchdowns,
    sum(nullif(metric_values ->> 'rush_first_down', '')::numeric) as rushing_first_downs,
    sum(nullif(metric_values ->> 'rec', '')::numeric) as receptions,
    sum(nullif(metric_values ->> 'targets', '')::numeric) as targets,
    sum(nullif(metric_values ->> 'rec_yds', '')::numeric) as receiving_yards,
    sum(nullif(metric_values ->> 'rec_td', '')::numeric) as receiving_touchdowns,
    sum(nullif(metric_values ->> 'rec_first_down', '')::numeric) as receiving_first_downs,
    sum(nullif(metric_values ->> 'tackles_combined', '')::numeric) as tackles_combined,
    sum(nullif(metric_values ->> 'tackles_solo', '')::numeric) as tackles_solo,
    sum(nullif(metric_values ->> 'tackles_loss', '')::numeric) as tackles_for_loss,
    sum(nullif(metric_values ->> 'sacks', '')::numeric) as defensive_sacks,
    sum(nullif(metric_values ->> 'def_int', '')::numeric) as defensive_interceptions,
    sum(nullif(metric_values ->> 'pass_defended', '')::numeric) as passes_defended,
    sum(nullif(metric_values ->> 'fumbles_forced', '')::numeric) as forced_fumbles,
    sum(nullif(metric_values ->> 'qb_hits', '')::numeric) as quarterback_hits,
    sum(nullif(metric_values ->> 'fgm', '')::numeric) as field_goals_made,
    sum(nullif(metric_values ->> 'fga', '')::numeric) as field_goals_attempted,
    sum(nullif(metric_values ->> 'xpm', '')::numeric) as extra_points_made,
    sum(nullif(metric_values ->> 'xpa', '')::numeric) as extra_points_attempted,
    sum(nullif(metric_values ->> 'kickoff_tb', '')::numeric) as touchbacks,
    sum(nullif(metric_values ->> 'kick_ret', '')::numeric) as kick_returns,
    sum(nullif(metric_values ->> 'kick_ret_yds', '')::numeric) as kick_return_yards,
    sum(nullif(metric_values ->> 'kick_ret_td', '')::numeric) as kick_return_touchdowns,
    sum(nullif(metric_values ->> 'punt_ret', '')::numeric) as punt_returns,
    sum(nullif(metric_values ->> 'punt_ret_yds', '')::numeric) as punt_return_yards,
    sum(nullif(metric_values ->> 'punt_ret_td', '')::numeric) as punt_return_touchdowns,
    sum(nullif(metric_values ->> 'total_td', '')::numeric) as total_touchdowns,
    sum(nullif(metric_values ->> 'scoring', '')::numeric) as scoring_points
  from nfl_usable_stats
  group by player_id, season_year, season_phase, stat_group
), nfl_season_payloads as (
  select
    scoped.athlete_id,
    totals.season_year,
    totals.season_phase,
    totals.stat_group,
    jsonb_strip_nulls(jsonb_build_object(
      'seasonEndYear', totals.season_year,
      'seasonLabel', totals.season_year::text,
      'phase', totals.season_phase,
      'statGroup', totals.stat_group,
      'gamesPlayed', totals.games_played,
      'gamesStarted', totals.games_started,
      'metrics', case totals.stat_group
        when 'passing' then jsonb_strip_nulls(jsonb_build_object(
          'completions', totals.completions,
          'attempts', totals.passing_attempts,
          'completionPercentage', round(totals.completions * 100 / nullif(totals.passing_attempts, 0), 1),
          'passingYards', totals.passing_yards,
          'passingTouchdowns', totals.passing_touchdowns,
          'interceptions', totals.interceptions_thrown,
          'yardsPerAttempt', round(totals.passing_yards / nullif(totals.passing_attempts, 0), 1),
          'passerRating', round(
            100 * (
              least(greatest(((totals.completions / nullif(totals.passing_attempts, 0)) - .3) * 5, 0), 2.375)
              + least(greatest(((totals.passing_yards / nullif(totals.passing_attempts, 0)) - 3) * .25, 0), 2.375)
              + least(greatest((totals.passing_touchdowns / nullif(totals.passing_attempts, 0)) * 20, 0), 2.375)
              + least(greatest(2.375 - ((totals.interceptions_thrown / nullif(totals.passing_attempts, 0)) * 25), 0), 2.375)
            ) / 6,
            1
          ),
          'sacks', totals.sacks_taken,
          'firstDowns', totals.passing_first_downs
        ))
        when 'rushing' then jsonb_strip_nulls(jsonb_build_object(
          'attempts', totals.rushing_attempts,
          'rushingYards', totals.rushing_yards,
          'yardsPerAttempt', round(totals.rushing_yards / nullif(totals.rushing_attempts, 0), 1),
          'rushingTouchdowns', totals.rushing_touchdowns,
          'firstDowns', totals.rushing_first_downs
        ))
        when 'receiving' then jsonb_strip_nulls(jsonb_build_object(
          'receptions', totals.receptions,
          'targets', totals.targets,
          'receivingYards', totals.receiving_yards,
          'yardsPerReception', round(totals.receiving_yards / nullif(totals.receptions, 0), 1),
          'receivingTouchdowns', totals.receiving_touchdowns,
          'catchPercentage', round(totals.receptions * 100 / nullif(totals.targets, 0), 1),
          'firstDowns', totals.receiving_first_downs
        ))
        when 'defense' then jsonb_strip_nulls(jsonb_build_object(
          'tacklesCombined', totals.tackles_combined,
          'tacklesSolo', totals.tackles_solo,
          'tacklesForLoss', totals.tackles_for_loss,
          'sacks', totals.defensive_sacks,
          'interceptions', totals.defensive_interceptions,
          'passesDefended', totals.passes_defended,
          'forcedFumbles', totals.forced_fumbles,
          'quarterbackHits', totals.quarterback_hits
        ))
        when 'kicking' then jsonb_strip_nulls(jsonb_build_object(
          'fieldGoalsMade', totals.field_goals_made,
          'fieldGoalsAttempted', totals.field_goals_attempted,
          'fieldGoalPercentage', round(totals.field_goals_made * 100 / nullif(totals.field_goals_attempted, 0), 1),
          'extraPointsMade', totals.extra_points_made,
          'extraPointsAttempted', totals.extra_points_attempted,
          'touchbacks', totals.touchbacks
        ))
        when 'returns' then jsonb_strip_nulls(jsonb_build_object(
          'kickReturns', totals.kick_returns,
          'kickReturnYards', totals.kick_return_yards,
          'kickReturnTouchdowns', totals.kick_return_touchdowns,
          'puntReturns', totals.punt_returns,
          'puntReturnYards', totals.punt_return_yards,
          'puntReturnTouchdowns', totals.punt_return_touchdowns
        ))
        when 'scoring' then jsonb_strip_nulls(jsonb_build_object(
          'totalTouchdowns', totals.total_touchdowns,
          'points', totals.scoring_points,
          'pointsPerGame', round(totals.scoring_points / nullif(totals.games_played, 0), 1),
          'fieldGoalsMade', totals.field_goals_made,
          'extraPointsMade', totals.extra_points_made
        ))
      end
    )) as season_payload
  from nfl_totals as totals
  join player_scope as scoped
    on scoped.league_code = 'NFL'
   and scoped.player_id = totals.player_id
), season_payloads as (
  select * from mlb_season_payloads
  union all
  select * from nfl_season_payloads
), player_seasons as (
  select
    athlete_id,
    jsonb_agg(
      season_payload
      order by season_year desc,
        case season_phase when 'regular' then 0 else 1 end,
        case stat_group
          when 'batting' then 0 when 'pitching' then 1
          when 'passing' then 0 when 'rushing' then 1 when 'receiving' then 2
          when 'defense' then 3 when 'kicking' then 4 when 'returns' then 5
          when 'scoring' then 6 else 99
        end
    ) as seasons
  from season_payloads
  group by athlete_id
), payloads as (
  select
    scoped.athlete_id,
    jsonb_build_object(
      'athleteId', scoped.athlete_id,
      'leagueCode', scoped.league_code,
      'player', jsonb_strip_nulls(jsonb_build_object(
        'athleteId', scoped.athlete_id,
        'leagueCode', scoped.league_code,
        'playerId', scoped.player_id,
        'name', scoped.full_name,
        'primaryPosition', scoped.primary_position,
        'headshotUrl', scoped.headshot_url
      )),
      'seasons', coalesce(player_seasons.seasons, '[]'::jsonb)
    ) as payload
  from player_scope as scoped
  left join player_seasons on player_seasons.athlete_id = scoped.athlete_id
)
select coalesce(jsonb_agg(payload order by athlete_id), '[]'::jsonb)
from payloads;
$$;

revoke all on function public.get_pro_sports_athlete_slab_stats_batch(text, uuid[])
  from public, anon, authenticated;
grant execute on function public.get_pro_sports_athlete_slab_stats_batch(text, uuid[])
  to service_role;

comment on function public.get_pro_sports_athlete_slab_stats_batch(text, uuid[]) is
  'Private MLB/NFL batch adapter for the commerce cache. It aggregates only requested active, verified athletes and returns no product, customer, external-ID, or source-provenance data.';
