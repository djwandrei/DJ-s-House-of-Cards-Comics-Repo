-- Private extraction and atomic persistence for reproducible league-wide
-- ridge RAPM. The solver runs locally, but its source rows and results remain
-- in Supabase with a complete provenance record.

create or replace function public.get_nba_rapm_stints(
  p_season_end_year smallint,
  p_season_phase text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  with latest_builds as (
    select distinct on (builds.game_id)
      builds.id,
      builds.game_id
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
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'gameId', stints.game_id,
      'stintOrdinal', stints.stint_ordinal,
      'homePlayerIds', home_lineups.player_ids,
      'awayPlayerIds', away_lineups.player_ids,
      'homePoints', stints.home_points,
      'awayPoints', stints.away_points,
      'homeOffensivePossessions', stints.home_offensive_possessions,
      'awayOffensivePossessions', stints.away_offensive_possessions
    )
    order by stints.game_id, stints.stint_ordinal
  ), '[]'::jsonb)
  from public.nba_game_lineup_stints as stints
  join latest_builds on latest_builds.id = stints.build_id
  join public.nba_lineup_definitions as home_lineups on home_lineups.id = stints.home_lineup_id
  join public.nba_lineup_definitions as away_lineups on away_lineups.id = stints.away_lineup_id
  where cardinality(home_lineups.player_ids) = 5
    and cardinality(away_lineups.player_ids) = 5
    and stints.home_offensive_possessions > 0
    and stints.away_offensive_possessions > 0;
$$;

create or replace function public.ingest_nba_rapm_model(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_model jsonb;
  v_model_run_id uuid;
  v_player_count integer := 0;
  v_season_end_year smallint;
  v_phase text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'RAPM ingest payload must be a JSON object.';
  end if;
  v_model := p_payload -> 'model';
  if jsonb_typeof(v_model) <> 'object' or jsonb_typeof(p_payload -> 'players') <> 'array' then
    raise exception 'RAPM ingest payload requires model and players fields.';
  end if;
  v_season_end_year := nullif(v_model ->> 'seasonEndYear', '')::smallint;
  v_phase := lower(trim(coalesce(v_model ->> 'seasonPhase', '')));
  if v_season_end_year is null or v_phase not in ('regular', 'playoffs') then
    raise exception 'RAPM model requires a regular or playoffs season scope.';
  end if;
  if coalesce(v_model ->> 'methodVersion', '') = ''
     or coalesce(v_model ->> 'codeVersion', '') = ''
     or coalesce(v_model ->> 'inputSha256', '') !~ '^[a-f0-9]{64}$'
  then
    raise exception 'RAPM model requires methodVersion, codeVersion, and SHA-256 input hash.';
  end if;

  insert into public.nba_adjusted_model_runs (
    model_type,
    method_version,
    season_end_year,
    season_phase,
    ridge_lambda,
    observation_count,
    game_count,
    excluded_observation_count,
    input_sha256,
    code_version,
    status,
    error_summary,
    completed_at
  )
  values (
    'ridge_rapm',
    v_model ->> 'methodVersion',
    v_season_end_year,
    v_phase,
    (v_model ->> 'lambda')::numeric,
    coalesce(nullif(v_model ->> 'observationCount', '')::integer, 0),
    coalesce(nullif(v_model ->> 'gameCount', '')::integer, 0),
    coalesce(nullif(v_model ->> 'excludedStintCount', '')::integer, 0),
    v_model ->> 'inputSha256',
    v_model ->> 'codeVersion',
    'completed',
    coalesce(v_model ->> 'errorSummary', ''),
    now()
  )
  on conflict (model_type, method_version, season_end_year, season_phase, input_sha256) do update set
    ridge_lambda = excluded.ridge_lambda,
    observation_count = excluded.observation_count,
    game_count = excluded.game_count,
    excluded_observation_count = excluded.excluded_observation_count,
    code_version = excluded.code_version,
    status = 'completed',
    error_summary = excluded.error_summary,
    completed_at = now()
  returning id into v_model_run_id;

  update public.nba_adjusted_model_runs
  set status = 'superseded'
  where model_type = 'ridge_rapm'
    and season_end_year = v_season_end_year
    and season_phase = v_phase
    and id <> v_model_run_id
    and status = 'completed';

  delete from public.nba_player_adjusted_impacts where model_run_id = v_model_run_id;
  insert into public.nba_player_adjusted_impacts (
    model_run_id,
    provider_player_id,
    rapm_per_100,
    exposure_possessions,
    observation_count,
    teammate_rapm_context_per_100,
    opponent_rapm_context_per_100,
    display_eligible
  )
  select
    v_model_run_id,
    nullif(source.value ->> 'providerPlayerId', '')::uuid,
    (source.value ->> 'rapmPer100')::numeric,
    coalesce(nullif(source.value ->> 'pairedPossessions', '')::numeric, 0),
    coalesce(nullif(source.value ->> 'observationCount', '')::integer, 0),
    nullif(source.value ->> 'teammateRapmContextPer100', '')::numeric,
    nullif(source.value ->> 'opponentRapmContextPer100', '')::numeric,
    coalesce((source.value ->> 'displayEligible')::boolean, false)
  from jsonb_array_elements(p_payload -> 'players') as source(value);
  get diagnostics v_player_count = row_count;

  return jsonb_build_object('modelRunId', v_model_run_id, 'playerCount', v_player_count);
end;
$$;

create or replace function public.get_nba_adjusted_impacts(
  p_season_end_year smallint,
  p_season_phase text,
  p_team_code text default ''
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  with latest_model as (
    select *
    from public.nba_adjusted_model_runs
    where model_type = 'ridge_rapm'
      and season_end_year = p_season_end_year
      and season_phase = lower(trim(p_season_phase))
      and status = 'completed'
    order by completed_at desc nulls last, created_at desc, id desc
    limit 1
  ), team_players as (
    select distinct members.provider_player_id
    from public.nba_provider_team_seasons as team_seasons
    join public.nba_lineup_definitions as lineups
      on lineups.provider_team_id = team_seasons.provider_team_id
    join public.nba_lineup_members as members on members.lineup_id = lineups.id
    join public.nba_game_lineup_stints as stints
      on stints.home_lineup_id = lineups.id or stints.away_lineup_id = lineups.id
    join public.nba_lineup_analytics_builds as builds on builds.id = stints.build_id
    join public.nba_games as games on games.id = builds.game_id
    where upper(trim(coalesce(p_team_code, ''))) <> ''
      and team_seasons.season_end_year = p_season_end_year
      and team_seasons.season_phase = lower(trim(p_season_phase))
      and team_seasons.team_code = upper(trim(p_team_code))
      and team_seasons.resolution_state in ('auto_exact', 'human_verified')
      and games.analytics_status = 'ready'
      and builds.status = 'completed'
      and builds.coverage_status = 'eligible'
  )
  select jsonb_build_object(
    'schemaVersion', 1,
    'model', coalesce((
      select jsonb_build_object(
        'methodVersion', method_version,
        'lambda', ridge_lambda,
        'observations', observation_count,
        'games', game_count,
        'excludedObservations', excluded_observation_count,
        'completedAt', completed_at
      ) from latest_model
    ), '{}'::jsonb),
    'players', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'providerPlayerId', impacts.provider_player_id,
          'name', players.full_name,
          'position', players.position,
          'rapmPer100', impacts.rapm_per_100,
          'exposurePossessions', impacts.exposure_possessions,
          'observationCount', impacts.observation_count,
          'teammateRapmContextPer100', impacts.teammate_rapm_context_per_100,
          'opponentRapmContextPer100', impacts.opponent_rapm_context_per_100,
          'displayEligible', impacts.display_eligible
        ) order by impacts.rapm_per_100 desc, players.full_name, impacts.provider_player_id
      )
      from public.nba_player_adjusted_impacts as impacts
      join latest_model on latest_model.id = impacts.model_run_id
      join public.nba_provider_players as players on players.id = impacts.provider_player_id
      where upper(trim(coalesce(p_team_code, ''))) = ''
         or impacts.provider_player_id in (select provider_player_id from team_players)
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.get_nba_rapm_stints(smallint, text)
  from public, anon, authenticated;
revoke all on function public.ingest_nba_rapm_model(jsonb)
  from public, anon, authenticated;
revoke all on function public.get_nba_adjusted_impacts(smallint, text, text)
  from public, anon, authenticated;
grant execute on function public.get_nba_rapm_stints(smallint, text) to service_role;
grant execute on function public.ingest_nba_rapm_model(jsonb) to service_role;
grant execute on function public.get_nba_adjusted_impacts(smallint, text, text) to anon, authenticated;

comment on function public.get_nba_rapm_stints(smallint, text) is
  'Private source rows for deterministic, season-scoped league-wide weighted ridge RAPM.';
comment on function public.ingest_nba_rapm_model(jsonb) is
  'Private atomic persistence of a reproducible ridge RAPM model and player impacts.';
comment on function public.get_nba_adjusted_impacts(smallint, text, text) is
  'Read-only latest completed league-wide ridge RAPM, optionally scoped to a verified provider team-season.';
