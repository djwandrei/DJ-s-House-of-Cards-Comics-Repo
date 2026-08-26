-- Narrow public read adapters for verified Sportradar-derived lineup analytics.
--
-- Raw PBP, provider documents, unresolved identities, and import/audit data
-- remain private. These functions only aggregate completed, eligible builds.

create or replace function public.nba_lineup_metric_payload(
  p_seconds numeric,
  p_games integer,
  p_points_for numeric,
  p_points_against numeric,
  p_offensive_possessions numeric,
  p_defensive_possessions numeric
)
returns jsonb
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'games', coalesce(p_games, 0),
    'seconds', p_seconds,
    'minutes', case when p_seconds is not null then round(p_seconds / 60.0, 3) end,
    'pointsFor', coalesce(p_points_for, 0),
    'pointsAgainst', coalesce(p_points_against, 0),
    'offensivePossessions', coalesce(p_offensive_possessions, 0),
    'defensivePossessions', coalesce(p_defensive_possessions, 0),
    'offensiveRating',
      case when coalesce(p_offensive_possessions, 0) > 0
        then round(100 * p_points_for / p_offensive_possessions, 3)
      end,
    'defensiveRating',
      case when coalesce(p_defensive_possessions, 0) > 0
        then round(100 * p_points_against / p_defensive_possessions, 3)
      end,
    'netRating',
      case when coalesce(p_offensive_possessions, 0) > 0
             and coalesce(p_defensive_possessions, 0) > 0
        then round(
          100 * p_points_for / p_offensive_possessions
          - 100 * p_points_against / p_defensive_possessions,
          3
        )
      end,
    'plusMinusPer100',
      case when coalesce(p_offensive_possessions, 0) + coalesce(p_defensive_possessions, 0) > 0
        then round(
          200 * (p_points_for - p_points_against)
          / (p_offensive_possessions + p_defensive_possessions),
          3
        )
      end
  );
$$;

create or replace function public.nba_invert_home_score_state_v1(p_state text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case p_state
    when 'ahead_1_5' then 'trailing_1_5'
    when 'ahead_6_10' then 'trailing_6_10'
    when 'ahead_11_15' then 'trailing_11_15'
    when 'ahead_16_plus' then 'trailing_16_plus'
    when 'trailing_1_5' then 'ahead_1_5'
    when 'trailing_6_10' then 'ahead_6_10'
    when 'trailing_11_15' then 'ahead_11_15'
    when 'trailing_16_plus' then 'ahead_16_plus'
    else 'tied'
  end;
$$;

create or replace function public.get_nba_lineup_analytics(
  p_season_end_year smallint,
  p_season_phase text,
  p_team_code text,
  p_player_ids uuid[],
  p_context text default 'all'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid;
  v_player_count integer;
  v_distinct_count integer;
  v_context text := lower(trim(coalesce(p_context, 'all')));
  v_semantics text;
  v_with_selection jsonb;
  v_player_on jsonb;
  v_player_off jsonb;
  v_wowy jsonb;
begin
  v_player_count := cardinality(p_player_ids);
  if v_player_count is null or v_player_count < 1 or v_player_count > 5 then
    raise exception 'Choose from one through five distinct provider player IDs.';
  end if;

  select count(distinct player_id)
  into v_distinct_count
  from unnest(p_player_ids) as selection(player_id);
  if v_distinct_count <> v_player_count then
    raise exception 'Provider player IDs must be distinct.';
  end if;

  if v_context <> 'all'
     and v_context <> 'clutch_v1'
     and v_context <> 'provider_fastbreak_v1'
     and v_context <> 'non_provider_fastbreak'
     and v_context <> 'unclassified'
     and v_context !~ '^score_state:(tied|ahead_1_5|ahead_6_10|ahead_11_15|ahead_16_plus|trailing_1_5|trailing_6_10|trailing_11_15|trailing_16_plus)$'
  then
    raise exception 'Unsupported lineup analytics context.';
  end if;

  select provider_team_id
  into v_team_id
  from public.nba_provider_team_seasons
  where season_end_year = p_season_end_year
    and season_phase = lower(trim(p_season_phase))
    and team_code = upper(trim(p_team_code))
    and resolution_state in ('auto_exact', 'human_verified')
  order by
    case resolution_state when 'human_verified' then 0 else 1 end,
    provider_team_id
  limit 1;

  if v_team_id is null then
    return jsonb_build_object(
      'schemaVersion', 1,
      'provider', 'Sportradar NBA v8',
      'selection', jsonb_build_object(
        'seasonEndYear', p_season_end_year,
        'phase', lower(trim(p_season_phase)),
        'teamCode', upper(trim(p_team_code)),
        'playerIds', to_jsonb(p_player_ids),
        'context', v_context
      ),
      'coverage', jsonb_build_object('eligibleGames', 0, 'message', 'No verified provider team mapping is available.'),
      'metrics', public.nba_lineup_metric_payload(0, 0, 0, 0, 0, 0)
    );
  end if;

  with eligible_builds as (
    select distinct on (builds.game_id) builds.id, builds.game_id
    from public.nba_lineup_analytics_builds as builds
    join public.nba_games as games on games.id = builds.game_id
    join public.nba_pbp_import_runs as runs on runs.id = builds.import_run_id
    where games.season_end_year = p_season_end_year
      and games.season_phase = lower(trim(p_season_phase))
      and games.analytics_status = 'ready'
      and builds.status = 'completed'
      and builds.coverage_status = 'eligible'
      and runs.rights_confirmed
    order by builds.game_id, builds.completed_at desc nulls last, builds.created_at desc, builds.id desc
  ),
  team_stints as (
    select
      stints.game_id,
      stints.home_lineup_id as lineup_id,
      stints.duration_ms::numeric / 1000 as seconds,
      stints.home_points::numeric as points_for,
      stints.away_points::numeric as points_against,
      stints.home_offensive_possessions as offensive_possessions,
      stints.away_offensive_possessions as defensive_possessions
    from public.nba_game_lineup_stints as stints
    join eligible_builds on eligible_builds.id = stints.build_id
    join public.nba_lineup_definitions as lineups on lineups.id = stints.home_lineup_id
    where lineups.provider_team_id = v_team_id
    union all
    select
      stints.game_id,
      stints.away_lineup_id as lineup_id,
      stints.duration_ms::numeric / 1000 as seconds,
      stints.away_points::numeric as points_for,
      stints.home_points::numeric as points_against,
      stints.away_offensive_possessions as offensive_possessions,
      stints.home_offensive_possessions as defensive_possessions
    from public.nba_game_lineup_stints as stints
    join eligible_builds on eligible_builds.id = stints.build_id
    join public.nba_lineup_definitions as lineups on lineups.id = stints.away_lineup_id
    where lineups.provider_team_id = v_team_id
  ),
  context_possessions as (
    select
      possessions.game_id,
      possessions.home_lineup_id as lineup_id,
      case when possessions.offense_provider_team_id = v_team_id
        then possessions.offense_points::numeric else possessions.defense_points::numeric end as points_for,
      case when possessions.offense_provider_team_id = v_team_id
        then possessions.defense_points::numeric else possessions.offense_points::numeric end as points_against,
      case when possessions.offense_provider_team_id = v_team_id then 1::numeric else 0::numeric end as offensive_possessions,
      case when possessions.defense_provider_team_id = v_team_id then 1::numeric else 0::numeric end as defensive_possessions,
      possessions.is_clutch_v1,
      possessions.transition_context,
      possessions.home_score_state_v1 as team_score_state_v1
    from public.nba_game_possessions as possessions
    join eligible_builds on eligible_builds.id = possessions.build_id
    join public.nba_lineup_definitions as lineups on lineups.id = possessions.home_lineup_id
    where lineups.provider_team_id = v_team_id
    union all
    select
      possessions.game_id,
      possessions.away_lineup_id as lineup_id,
      case when possessions.offense_provider_team_id = v_team_id
        then possessions.offense_points::numeric else possessions.defense_points::numeric end as points_for,
      case when possessions.offense_provider_team_id = v_team_id
        then possessions.defense_points::numeric else possessions.offense_points::numeric end as points_against,
      case when possessions.offense_provider_team_id = v_team_id then 1::numeric else 0::numeric end as offensive_possessions,
      case when possessions.defense_provider_team_id = v_team_id then 1::numeric else 0::numeric end as defensive_possessions,
      possessions.is_clutch_v1,
      possessions.transition_context,
      public.nba_invert_home_score_state_v1(possessions.home_score_state_v1) as team_score_state_v1
    from public.nba_game_possessions as possessions
    join eligible_builds on eligible_builds.id = possessions.build_id
    join public.nba_lineup_definitions as lineups on lineups.id = possessions.away_lineup_id
    where lineups.provider_team_id = v_team_id
  ),
  context_partition_rows as (
    select context_possessions.*
    from context_possessions
    where (
      v_context = 'all'
      or (v_context = 'clutch_v1' and context_possessions.is_clutch_v1)
      or (v_context in ('provider_fastbreak_v1', 'non_provider_fastbreak', 'unclassified')
          and context_possessions.transition_context = v_context)
      or (v_context like 'score_state:%'
          and context_possessions.team_score_state_v1 = substring(v_context from 13))
    )
  ),
  partition_rows as (
    select
      team_stints.game_id,
      team_stints.lineup_id,
      team_stints.seconds,
      team_stints.points_for,
      team_stints.points_against,
      team_stints.offensive_possessions,
      team_stints.defensive_possessions
    from team_stints
    where v_context = 'all'
    union all
    select
      context_partition_rows.game_id,
      context_partition_rows.lineup_id,
      null::numeric as seconds,
      context_partition_rows.points_for,
      context_partition_rows.points_against,
      context_partition_rows.offensive_possessions,
      context_partition_rows.defensive_possessions
    from context_partition_rows
    where v_context <> 'all'
  ),
  selected_stints as (
    select team_stints.*
    from team_stints
    join public.nba_lineup_definitions as lineups on lineups.id = team_stints.lineup_id
    where lineups.player_ids @> p_player_ids
  ),
  selected_context as (
    select context_partition_rows.*
    from context_partition_rows
    join public.nba_lineup_definitions as lineups on lineups.id = context_partition_rows.lineup_id
    where lineups.player_ids @> p_player_ids
  ),
  all_metrics as (
    select
      coalesce(sum(seconds), 0) as seconds,
      count(distinct game_id)::integer as games,
      coalesce(sum(points_for), 0) as points_for,
      coalesce(sum(points_against), 0) as points_against,
      coalesce(sum(offensive_possessions), 0) as offensive_possessions,
      coalesce(sum(defensive_possessions), 0) as defensive_possessions
    from selected_stints
  ),
  context_metrics as (
    select
      null::numeric as seconds,
      count(distinct game_id)::integer as games,
      coalesce(sum(points_for), 0) as points_for,
      coalesce(sum(points_against), 0) as points_against,
      coalesce(sum(offensive_possessions), 0) as offensive_possessions,
      coalesce(sum(defensive_possessions), 0) as defensive_possessions
    from selected_context
  ),
  player_on as (
    select
      case when v_context = 'all' then coalesce(sum(seconds), 0) end as seconds,
      count(distinct game_id)::integer as games,
      coalesce(sum(points_for), 0) as points_for,
      coalesce(sum(points_against), 0) as points_against,
      coalesce(sum(offensive_possessions), 0) as offensive_possessions,
      coalesce(sum(defensive_possessions), 0) as defensive_possessions
    from partition_rows
    join public.nba_lineup_definitions as lineups on lineups.id = partition_rows.lineup_id
    where v_player_count = 1 and lineups.player_ids @> p_player_ids
  ),
  player_off as (
    select
      case when v_context = 'all' then coalesce(sum(seconds), 0) end as seconds,
      count(distinct game_id)::integer as games,
      coalesce(sum(points_for), 0) as points_for,
      coalesce(sum(points_against), 0) as points_against,
      coalesce(sum(offensive_possessions), 0) as offensive_possessions,
      coalesce(sum(defensive_possessions), 0) as defensive_possessions
    from partition_rows
    join public.nba_lineup_definitions as lineups on lineups.id = partition_rows.lineup_id
    where v_player_count = 1 and not (lineups.player_ids @> p_player_ids)
  ),
  wowy_cells as (
    select
      case
        when lineups.player_ids @> array[p_player_ids[1]]::uuid[]
         and lineups.player_ids @> array[p_player_ids[2]]::uuid[] then 'a_on_b_on'
        when lineups.player_ids @> array[p_player_ids[1]]::uuid[] then 'a_on_b_off'
        when lineups.player_ids @> array[p_player_ids[2]]::uuid[] then 'a_off_b_on'
        else 'a_off_b_off'
      end as cell,
      partition_rows.*
    from partition_rows
    join public.nba_lineup_definitions as lineups on lineups.id = partition_rows.lineup_id
    where v_player_count = 2
  ),
  wowy_totals as (
    select
      cell,
      case when v_context = 'all' then coalesce(sum(seconds), 0) end as seconds,
      count(distinct game_id)::integer as games,
      coalesce(sum(points_for), 0) as points_for,
      coalesce(sum(points_against), 0) as points_against,
      coalesce(sum(offensive_possessions), 0) as offensive_possessions,
      coalesce(sum(defensive_possessions), 0) as defensive_possessions
    from wowy_cells
    group by cell
  )
  select
    case when v_context = 'all'
      then public.nba_lineup_metric_payload(
        all_metrics.seconds,
        all_metrics.games,
        all_metrics.points_for,
        all_metrics.points_against,
        all_metrics.offensive_possessions,
        all_metrics.defensive_possessions
      )
      else public.nba_lineup_metric_payload(
        context_metrics.seconds,
        context_metrics.games,
        context_metrics.points_for,
        context_metrics.points_against,
        context_metrics.offensive_possessions,
        context_metrics.defensive_possessions
      )
    end,
    case when v_player_count = 1 then public.nba_lineup_metric_payload(
      player_on.seconds, player_on.games, player_on.points_for, player_on.points_against,
      player_on.offensive_possessions, player_on.defensive_possessions
    ) end,
    case when v_player_count = 1 then public.nba_lineup_metric_payload(
      player_off.seconds, player_off.games, player_off.points_for, player_off.points_against,
      player_off.offensive_possessions, player_off.defensive_possessions
    ) end,
    case when v_player_count = 2 then jsonb_build_object(
      'aOnBOn', coalesce((
        select public.nba_lineup_metric_payload(seconds, games, points_for, points_against, offensive_possessions, defensive_possessions)
        from wowy_totals where cell = 'a_on_b_on'
      ), public.nba_lineup_metric_payload(0, 0, 0, 0, 0, 0)),
      'aOnBOff', coalesce((
        select public.nba_lineup_metric_payload(seconds, games, points_for, points_against, offensive_possessions, defensive_possessions)
        from wowy_totals where cell = 'a_on_b_off'
      ), public.nba_lineup_metric_payload(0, 0, 0, 0, 0, 0)),
      'aOffBOn', coalesce((
        select public.nba_lineup_metric_payload(seconds, games, points_for, points_against, offensive_possessions, defensive_possessions)
        from wowy_totals where cell = 'a_off_b_on'
      ), public.nba_lineup_metric_payload(0, 0, 0, 0, 0, 0)),
      'aOffBOff', coalesce((
        select public.nba_lineup_metric_payload(seconds, games, points_for, points_against, offensive_possessions, defensive_possessions)
        from wowy_totals where cell = 'a_off_b_off'
      ), public.nba_lineup_metric_payload(0, 0, 0, 0, 0, 0))
    ) end
  into v_with_selection, v_player_on, v_player_off, v_wowy
  from all_metrics, context_metrics, player_on, player_off;

  v_semantics := case
    when v_player_count = 5 then 'exact_five_player_lineup'
    when v_player_count = 1 then 'single_player_on_off_partition'
    else 'co_presence_combination'
  end;

  return jsonb_build_object(
    'schemaVersion', 1,
    'provider', 'Sportradar NBA v8',
    'selection', jsonb_build_object(
      'seasonEndYear', p_season_end_year,
      'phase', lower(trim(p_season_phase)),
      'teamCode', upper(trim(p_team_code)),
      'playerIds', to_jsonb(p_player_ids),
      'context', v_context,
      'semantics', v_semantics
    ),
    'metrics', coalesce(v_with_selection, public.nba_lineup_metric_payload(0, 0, 0, 0, 0, 0)),
    'onOff', case when v_player_count = 1 then jsonb_build_object('on', v_player_on, 'off', v_player_off) end,
    'wowy', case when v_player_count = 2 then v_wowy end,
    'caveat', case
      when v_player_count between 2 and 4
        then 'Two-to-four-player results are shared-floor co-presence combinations, not exact lineups or causal teammate adjustments.'
      when v_context = 'non_provider_fastbreak'
        then 'Non-provider-fastbreak is not a provider-verified half-court classification.'
      else null
    end
  );
end;
$$;

create or replace function public.get_nba_lineup_analytics_players(
  p_season_end_year smallint,
  p_season_phase text,
  p_team_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_team_id uuid;
begin
  select provider_team_id
  into v_team_id
  from public.nba_provider_team_seasons
  where season_end_year = p_season_end_year
    and season_phase = lower(trim(p_season_phase))
    and team_code = upper(trim(p_team_code))
    and resolution_state in ('auto_exact', 'human_verified')
  order by
    case resolution_state when 'human_verified' then 0 else 1 end,
    provider_team_id
  limit 1;

  if v_team_id is null then
    return jsonb_build_object('schemaVersion', 1, 'players', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'schemaVersion', 1,
    'players', coalesce((
      with eligible_builds as (
        select distinct on (builds.game_id) builds.id
        from public.nba_lineup_analytics_builds as builds
        join public.nba_games as games on games.id = builds.game_id
        join public.nba_pbp_import_runs as runs on runs.id = builds.import_run_id
        where games.season_end_year = p_season_end_year
          and games.season_phase = lower(trim(p_season_phase))
          and games.analytics_status = 'ready'
          and builds.status = 'completed'
          and builds.coverage_status = 'eligible'
          and runs.rights_confirmed
        order by builds.game_id, builds.completed_at desc nulls last, builds.created_at desc, builds.id desc
      ),
      eligible_lineups as (
        select distinct lineups.id
        from public.nba_lineup_definitions as lineups
        join public.nba_game_lineup_stints as stints
          on stints.home_lineup_id = lineups.id or stints.away_lineup_id = lineups.id
        join eligible_builds on eligible_builds.id = stints.build_id
        where lineups.provider_team_id = v_team_id
      )
      select jsonb_agg(
        jsonb_build_object(
          'id', players.id,
          'name', players.full_name,
          'position', players.position,
          'jerseyNumber', players.jersey_number,
          'nbaPlayerId', players.nba_player_id
        )
        order by players.full_name, players.id
      )
      from (
        select distinct members.provider_player_id
        from public.nba_lineup_members as members
        join eligible_lineups on eligible_lineups.id = members.lineup_id
      ) as eligible_players
      join public.nba_provider_players as players on players.id = eligible_players.provider_player_id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.nba_lineup_metric_payload(numeric, integer, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.nba_invert_home_score_state_v1(text)
  from public, anon, authenticated;
revoke all on function public.get_nba_lineup_analytics(smallint, text, text, uuid[], text)
  from public, anon, authenticated;
revoke all on function public.get_nba_lineup_analytics_players(smallint, text, text)
  from public, anon, authenticated;

grant execute on function public.get_nba_lineup_analytics(smallint, text, text, uuid[], text) to anon, authenticated;
grant execute on function public.get_nba_lineup_analytics_players(smallint, text, text) to anon, authenticated;

comment on function public.get_nba_lineup_analytics(smallint, text, text, uuid[], text) is
  'Returns read-only observed lineup, on/off, WOWY, and context metrics for completed eligible Sportradar PBP builds. 2-4 player requests are shared-floor co-presence combinations.';
comment on function public.get_nba_lineup_analytics_players(smallint, text, text) is
  'Returns provider player identities eligible for a verified team-season lineup analytics query.';
