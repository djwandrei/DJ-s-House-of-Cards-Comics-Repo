-- Atomic server-side write boundary for one fully fetched Sportradar game.
--
-- The caller uploads raw source documents to the private bucket first, then
-- passes only their immutable metadata here. This RPC is deliberately revoked
-- from browser roles; the local importer invokes it with a service-role key.

create or replace function public.ingest_nba_sportradar_game(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_id uuid;
  v_game_id uuid;
  v_build_id uuid;
  v_game jsonb;
  v_analytics jsonb;
  v_build jsonb;
  v_phase text;
  v_status text;
  v_coverage_status text;
  v_season_end_year smallint;
  v_pbp_document_id uuid;
  v_event_count integer := 0;
  v_stint_count integer := 0;
  v_possession_count integer := 0;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Sportradar ingest payload must be a JSON object.';
  end if;

  v_run_id := nullif(p_payload #>> '{run,id}', '')::uuid;
  v_game := p_payload -> 'game';
  v_game_id := nullif(v_game ->> 'id', '')::uuid;
  v_season_end_year := nullif(v_game ->> 'seasonEndYear', '')::smallint;
  v_phase := lower(trim(coalesce(v_game ->> 'seasonPhase', '')));
  v_analytics := coalesce(p_payload -> 'analytics', '{}'::jsonb);
  v_build := coalesce(v_analytics -> 'build', '{}'::jsonb);

  if v_run_id is null or v_game_id is null or v_season_end_year is null then
    raise exception 'Sportradar ingest requires run.id, game.id, and game.seasonEndYear.';
  end if;
  if v_phase not in ('preseason', 'regular', 'in_season_tournament', 'play_in', 'playoffs') then
    raise exception 'Unsupported Sportradar season phase: %.', v_phase;
  end if;
  if not coalesce((p_payload #>> '{run,rightsConfirmed}')::boolean, false) then
    raise exception 'Sportradar ingest requires a rights-confirmed import run.';
  end if;

  insert into public.nba_pbp_import_runs (
    id,
    source_access_level,
    source_api_version,
    source_license_reference,
    rights_confirmed,
    requested_season_start,
    requested_season_end,
    requested_phase,
    status,
    started_at
  )
  values (
    v_run_id,
    lower(trim(p_payload #>> '{run,accessLevel}')),
    coalesce(nullif(p_payload #>> '{run,apiVersion}', ''), 'v8'),
    p_payload #>> '{run,licenseReference}',
    true,
    nullif(p_payload #>> '{run,requestedSeasonStart}', '')::smallint,
    nullif(p_payload #>> '{run,requestedSeasonEnd}', '')::smallint,
    coalesce(nullif(lower(trim(p_payload #>> '{run,requestedPhase}')), ''), v_phase),
    'running',
    coalesce(nullif(p_payload #>> '{run,startedAt}', '')::timestamptz, now())
  )
  on conflict (id) do update set
    source_access_level = excluded.source_access_level,
    source_api_version = excluded.source_api_version,
    source_license_reference = excluded.source_license_reference,
    rights_confirmed = excluded.rights_confirmed,
    requested_season_start = excluded.requested_season_start,
    requested_season_end = excluded.requested_season_end,
    requested_phase = excluded.requested_phase,
    status = case when public.nba_pbp_import_runs.status = 'completed' then 'running' else public.nba_pbp_import_runs.status end,
    started_at = coalesce(public.nba_pbp_import_runs.started_at, excluded.started_at);

  insert into public.nba_provider_teams (
    id, sr_id, reference, alias, market, name, country
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    coalesce(source.value ->> 'srId', ''),
    coalesce(source.value ->> 'reference', ''),
    coalesce(source.value ->> 'alias', ''),
    coalesce(source.value ->> 'market', ''),
    coalesce(source.value ->> 'name', ''),
    coalesce(source.value ->> 'country', '')
  from jsonb_array_elements(coalesce(p_payload -> 'providerTeams', '[]'::jsonb)) as source(value)
  on conflict (id) do update set
    sr_id = excluded.sr_id,
    reference = excluded.reference,
    alias = excluded.alias,
    market = excluded.market,
    name = excluded.name,
    country = excluded.country;

  insert into public.nba_provider_team_seasons (
    provider_team_id,
    season_end_year,
    season_phase,
    provider_alias,
    nba_team_season_id,
    team_code,
    resolution_state,
    source_import_run_id
  )
  with source_teams as (
    select
      nullif(source.value ->> 'id', '')::uuid as provider_team_id,
      coalesce(source.value ->> 'alias', '') as provider_alias,
      case
        when upper(coalesce(source.value ->> 'alias', '')) ~ '^[A-Z0-9]{2,8}$'
          then upper(source.value ->> 'alias')
        else ''
      end as team_code
    from jsonb_array_elements(coalesce(p_payload -> 'providerTeams', '[]'::jsonb)) as source(value)
  )
  select
    source_teams.provider_team_id,
    v_season_end_year,
    v_phase,
    source_teams.provider_alias,
    team_seasons.id,
    source_teams.team_code,
    case when team_seasons.id is null then 'unresolved' else 'auto_exact' end,
    v_run_id
  from source_teams
  left join public.nba_team_seasons as team_seasons
    on team_seasons.season_end_year = v_season_end_year
   and team_seasons.team_code = source_teams.team_code
  on conflict (provider_team_id, season_end_year, season_phase) do update set
    provider_alias = excluded.provider_alias,
    nba_team_season_id = case
      when public.nba_provider_team_seasons.resolution_state = 'human_verified'
        then public.nba_provider_team_seasons.nba_team_season_id
      else excluded.nba_team_season_id
    end,
    team_code = excluded.team_code,
    resolution_state = case
      when public.nba_provider_team_seasons.resolution_state = 'human_verified'
        then 'human_verified'
      else excluded.resolution_state
    end,
    source_import_run_id = excluded.source_import_run_id;

  insert into public.nba_provider_players (
    id,
    sr_id,
    reference,
    full_name,
    first_name,
    last_name,
    position,
    jersey_number,
    nba_player_id,
    identity_resolution_state
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    coalesce(source.value ->> 'srId', ''),
    coalesce(source.value ->> 'reference', ''),
    coalesce(source.value ->> 'fullName', ''),
    coalesce(source.value ->> 'firstName', ''),
    coalesce(source.value ->> 'lastName', ''),
    coalesce(source.value ->> 'position', ''),
    coalesce(source.value ->> 'jerseyNumber', ''),
    external_ids.player_id,
    case when external_ids.player_id is null then 'unresolved' else 'external_id_verified' end
  from jsonb_array_elements(coalesce(p_payload -> 'providerPlayers', '[]'::jsonb)) as source(value)
  left join public.nba_player_external_ids as external_ids
    on external_ids.source_name = 'sportradar_nba'
   and external_ids.external_id = source.value ->> 'id'
  on conflict (id) do update set
    sr_id = excluded.sr_id,
    reference = excluded.reference,
    full_name = case when excluded.full_name <> '' then excluded.full_name else public.nba_provider_players.full_name end,
    first_name = case when excluded.first_name <> '' then excluded.first_name else public.nba_provider_players.first_name end,
    last_name = case when excluded.last_name <> '' then excluded.last_name else public.nba_provider_players.last_name end,
    position = case when excluded.position <> '' then excluded.position else public.nba_provider_players.position end,
    jersey_number = case when excluded.jersey_number <> '' then excluded.jersey_number else public.nba_provider_players.jersey_number end,
    nba_player_id = case
      when public.nba_provider_players.identity_resolution_state = 'human_verified'
        then public.nba_provider_players.nba_player_id
      else coalesce(excluded.nba_player_id, public.nba_provider_players.nba_player_id)
    end,
    identity_resolution_state = case
      when public.nba_provider_players.identity_resolution_state = 'human_verified'
        then 'human_verified'
      when excluded.nba_player_id is not null then 'external_id_verified'
      else public.nba_provider_players.identity_resolution_state
    end;

  insert into public.nba_games (
    id,
    reference,
    sr_id,
    season_end_year,
    season_start_year,
    season_phase,
    scheduled_at,
    status,
    coverage,
    track_on_court,
    home_provider_team_id,
    away_provider_team_id,
    home_team_season_id,
    away_team_season_id,
    home_points,
    away_points,
    provider_updated_at,
    source_etag,
    source_last_modified,
    analytics_status,
    analytics_error
  )
  values (
    v_game_id,
    coalesce(v_game ->> 'reference', ''),
    coalesce(v_game ->> 'srId', ''),
    v_season_end_year,
    nullif(v_game ->> 'seasonStartYear', '')::smallint,
    v_phase,
    nullif(v_game ->> 'scheduledAt', '')::timestamptz,
    lower(trim(v_game ->> 'status')),
    lower(trim(coalesce(v_game ->> 'coverage', ''))),
    coalesce((v_game ->> 'trackOnCourt')::boolean, false),
    nullif(v_game ->> 'homeProviderTeamId', '')::uuid,
    nullif(v_game ->> 'awayProviderTeamId', '')::uuid,
    nullif(v_game ->> 'homeTeamSeasonId', '')::uuid,
    nullif(v_game ->> 'awayTeamSeasonId', '')::uuid,
    nullif(v_game ->> 'homePoints', '')::integer,
    nullif(v_game ->> 'awayPoints', '')::integer,
    nullif(v_game ->> 'providerUpdatedAt', '')::timestamptz,
    coalesce(v_game ->> 'sourceEtag', ''),
    coalesce(v_game ->> 'sourceLastModified', ''),
    'pending',
    ''
  )
  on conflict (id) do update set
    reference = excluded.reference,
    sr_id = excluded.sr_id,
    season_end_year = excluded.season_end_year,
    season_start_year = excluded.season_start_year,
    season_phase = excluded.season_phase,
    scheduled_at = excluded.scheduled_at,
    status = excluded.status,
    coverage = excluded.coverage,
    track_on_court = excluded.track_on_court,
    home_provider_team_id = excluded.home_provider_team_id,
    away_provider_team_id = excluded.away_provider_team_id,
    home_team_season_id = coalesce(excluded.home_team_season_id, public.nba_games.home_team_season_id),
    away_team_season_id = coalesce(excluded.away_team_season_id, public.nba_games.away_team_season_id),
    home_points = excluded.home_points,
    away_points = excluded.away_points,
    provider_updated_at = excluded.provider_updated_at,
    source_etag = excluded.source_etag,
    source_last_modified = excluded.source_last_modified,
    analytics_status = 'pending',
    analytics_error = '';

  insert into public.nba_pbp_source_documents (
    id,
    import_run_id,
    game_id,
    source_resource,
    source_resource_key,
    source_url,
    storage_bucket,
    storage_object_path,
    content_sha256,
    content_bytes,
    content_encoding,
    source_etag,
    source_last_modified,
    source_generated_at,
    received_at
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    v_run_id,
    v_game_id,
    source.value ->> 'resource',
    source.value ->> 'resourceKey',
    source.value ->> 'sourceUrl',
    coalesce(nullif(source.value ->> 'storageBucket', ''), 'nba-sportradar-raw'),
    source.value ->> 'storageObjectPath',
    source.value ->> 'contentSha256',
    (source.value ->> 'contentBytes')::bigint,
    coalesce(nullif(source.value ->> 'contentEncoding', ''), 'gzip'),
    coalesce(source.value ->> 'sourceEtag', ''),
    coalesce(source.value ->> 'sourceLastModified', ''),
    nullif(source.value ->> 'sourceGeneratedAt', '')::timestamptz,
    coalesce(nullif(source.value ->> 'receivedAt', '')::timestamptz, now())
  from jsonb_array_elements(coalesce(p_payload -> 'documents', '[]'::jsonb)) as source(value)
  on conflict (id) do update set
    import_run_id = excluded.import_run_id,
    game_id = excluded.game_id,
    source_resource = excluded.source_resource,
    source_resource_key = excluded.source_resource_key,
    source_url = excluded.source_url,
    storage_bucket = excluded.storage_bucket,
    storage_object_path = excluded.storage_object_path,
    content_sha256 = excluded.content_sha256,
    content_bytes = excluded.content_bytes,
    content_encoding = excluded.content_encoding,
    source_etag = excluded.source_etag,
    source_last_modified = excluded.source_last_modified,
    source_generated_at = excluded.source_generated_at,
    received_at = excluded.received_at;

  v_pbp_document_id := nullif(p_payload ->> 'playByPlayDocumentId', '')::uuid;

  insert into public.nba_game_team_stats (
    game_id,
    provider_team_id,
    possessions,
    opponent_possessions,
    offensive_rating,
    defensive_rating,
    points,
    points_against,
    fast_break_points,
    source_document_id
  )
  select
    v_game_id,
    nullif(source.value ->> 'providerTeamId', '')::uuid,
    nullif(source.value ->> 'possessions', '')::numeric,
    nullif(source.value ->> 'opponentPossessions', '')::numeric,
    nullif(source.value ->> 'offensiveRating', '')::numeric,
    nullif(source.value ->> 'defensiveRating', '')::numeric,
    nullif(source.value ->> 'points', '')::integer,
    nullif(source.value ->> 'pointsAgainst', '')::integer,
    nullif(source.value ->> 'fastBreakPoints', '')::integer,
    nullif(source.value ->> 'sourceDocumentId', '')::uuid
  from jsonb_array_elements(coalesce(p_payload -> 'gameTeamStats', '[]'::jsonb)) as source(value)
  on conflict (game_id, provider_team_id) do update set
    possessions = excluded.possessions,
    opponent_possessions = excluded.opponent_possessions,
    offensive_rating = excluded.offensive_rating,
    defensive_rating = excluded.defensive_rating,
    points = excluded.points,
    points_against = excluded.points_against,
    fast_break_points = excluded.fast_break_points,
    source_document_id = excluded.source_document_id,
    updated_at = now();

  insert into public.nba_game_player_stats (
    game_id,
    provider_player_id,
    provider_team_id,
    minutes_played,
    plus_minus,
    offensive_rating,
    defensive_rating,
    is_starter,
    is_active,
    is_on_court,
    source_document_id
  )
  select
    v_game_id,
    nullif(source.value ->> 'providerPlayerId', '')::uuid,
    nullif(source.value ->> 'providerTeamId', '')::uuid,
    nullif(source.value ->> 'minutesPlayed', '')::numeric,
    nullif(source.value ->> 'plusMinus', '')::integer,
    nullif(source.value ->> 'offensiveRating', '')::numeric,
    nullif(source.value ->> 'defensiveRating', '')::numeric,
    nullif(source.value ->> 'isStarter', '')::boolean,
    nullif(source.value ->> 'isActive', '')::boolean,
    nullif(source.value ->> 'isOnCourt', '')::boolean,
    nullif(source.value ->> 'sourceDocumentId', '')::uuid
  from jsonb_array_elements(coalesce(p_payload -> 'gamePlayerStats', '[]'::jsonb)) as source(value)
  on conflict (game_id, provider_player_id) do update set
    provider_team_id = excluded.provider_team_id,
    minutes_played = excluded.minutes_played,
    plus_minus = excluded.plus_minus,
    offensive_rating = excluded.offensive_rating,
    defensive_rating = excluded.defensive_rating,
    is_starter = excluded.is_starter,
    is_active = excluded.is_active,
    is_on_court = excluded.is_on_court,
    source_document_id = excluded.source_document_id,
    updated_at = now();

  insert into public.nba_pbp_events (
    id,
    game_id,
    source_document_id,
    period_sequence,
    period_number,
    period_type,
    event_number,
    event_sequence,
    clock_remaining_ms,
    home_points_after,
    away_points_after,
    event_type,
    attribution_team_id,
    possession_team_id,
    qualifiers,
    statistics,
    location,
    created_by_provider_at,
    updated_by_provider_at,
    wall_clock_at,
    is_rescinded
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    v_game_id,
    coalesce(nullif(source.value ->> 'sourceDocumentId', '')::uuid, v_pbp_document_id),
    (source.value ->> 'periodSequence')::smallint,
    (source.value ->> 'periodNumber')::smallint,
    coalesce(source.value ->> 'periodType', ''),
    nullif(source.value ->> 'eventNumber', '')::integer,
    nullif(source.value ->> 'eventSequence', '')::bigint,
    nullif(source.value ->> 'clockRemainingMs', '')::integer,
    nullif(source.value ->> 'homePointsAfter', '')::integer,
    nullif(source.value ->> 'awayPointsAfter', '')::integer,
    coalesce(source.value ->> 'eventType', ''),
    nullif(source.value ->> 'attributionTeamId', '')::uuid,
    nullif(source.value ->> 'possessionTeamId', '')::uuid,
    coalesce(source.value -> 'qualifiers', '[]'::jsonb),
    coalesce(source.value -> 'statistics', '[]'::jsonb),
    coalesce(source.value -> 'location', '{}'::jsonb),
    nullif(source.value ->> 'createdAt', '')::timestamptz,
    nullif(source.value ->> 'updatedAt', '')::timestamptz,
    nullif(source.value ->> 'wallClockAt', '')::timestamptz,
    coalesce((source.value ->> 'isRescinded')::boolean, false)
  from jsonb_array_elements(coalesce(p_payload -> 'events', '[]'::jsonb)) as source(value)
  on conflict (id) do update set
    game_id = excluded.game_id,
    source_document_id = excluded.source_document_id,
    period_sequence = excluded.period_sequence,
    period_number = excluded.period_number,
    period_type = excluded.period_type,
    event_number = excluded.event_number,
    event_sequence = excluded.event_sequence,
    clock_remaining_ms = excluded.clock_remaining_ms,
    home_points_after = excluded.home_points_after,
    away_points_after = excluded.away_points_after,
    event_type = excluded.event_type,
    attribution_team_id = excluded.attribution_team_id,
    possession_team_id = excluded.possession_team_id,
    qualifiers = excluded.qualifiers,
    statistics = excluded.statistics,
    location = excluded.location,
    created_by_provider_at = excluded.created_by_provider_at,
    updated_by_provider_at = excluded.updated_by_provider_at,
    wall_clock_at = excluded.wall_clock_at,
    is_rescinded = excluded.is_rescinded;
  get diagnostics v_event_count = row_count;

  update public.nba_pbp_events
  set is_rescinded = true
  where game_id = v_game_id
    and id in (
      select jsonb_array_elements_text(coalesce(p_payload -> 'deletedEventIds', '[]'::jsonb))::uuid
    );

  insert into public.nba_pbp_event_on_court (
    event_id,
    home_player_ids,
    away_player_ids,
    snapshot_status
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    array(
      select jsonb_array_elements_text(coalesce(source.value #> '{snapshot,homePlayerIds}', '[]'::jsonb))::uuid
    ),
    array(
      select jsonb_array_elements_text(coalesce(source.value #> '{snapshot,awayPlayerIds}', '[]'::jsonb))::uuid
    ),
    coalesce(source.value #>> '{snapshot,status}', 'missing')
  from jsonb_array_elements(coalesce(p_payload -> 'events', '[]'::jsonb)) as source(value)
  on conflict (event_id) do update set
    home_player_ids = excluded.home_player_ids,
    away_player_ids = excluded.away_player_ids,
    snapshot_status = excluded.snapshot_status;

  insert into public.nba_lineup_definitions (
    id,
    provider_team_id,
    lineup_key,
    player_ids
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    nullif(source.value ->> 'providerTeamId', '')::uuid,
    source.value ->> 'lineupKey',
    array(
      select jsonb_array_elements_text(coalesce(source.value -> 'playerIds', '[]'::jsonb))::uuid
    )
  from jsonb_array_elements(coalesce(v_analytics -> 'lineups', '[]'::jsonb)) as source(value)
  on conflict (id) do update set
    provider_team_id = excluded.provider_team_id,
    lineup_key = excluded.lineup_key,
    player_ids = excluded.player_ids;

  insert into public.nba_lineup_members (lineup_id, provider_player_id, member_order)
  select
    nullif(source.value ->> 'id', '')::uuid,
    member.player_id::uuid,
    member.member_order::smallint
  from jsonb_array_elements(coalesce(v_analytics -> 'lineups', '[]'::jsonb)) as source(value)
  cross join lateral unnest(array(
    select jsonb_array_elements_text(coalesce(source.value -> 'playerIds', '[]'::jsonb))
  )) with ordinality as member(player_id, member_order)
  on conflict (lineup_id, provider_player_id) do update set
    member_order = excluded.member_order;

  if coalesce(v_build ->> 'methodVersion', '') = '' or coalesce(v_build ->> 'inputSha256', '') !~ '^[a-f0-9]{64}$' then
    raise exception 'Sportradar analytics build requires a method version and SHA-256 input hash.';
  end if;
  v_status := lower(trim(coalesce(v_build ->> 'status', 'failed')));
  v_coverage_status := lower(trim(coalesce(v_build ->> 'coverageStatus', 'unknown')));
  if v_status not in ('completed', 'partial', 'failed') or v_coverage_status not in ('eligible', 'ineligible', 'partial', 'unknown') then
    raise exception 'Unsupported Sportradar analytics build status.';
  end if;

  insert into public.nba_lineup_analytics_builds (
    game_id,
    import_run_id,
    source_document_id,
    method_version,
    input_sha256,
    status,
    coverage_status,
    event_count,
    valid_snapshot_count,
    invalid_snapshot_count,
    error_summary,
    final_score_verified,
    possession_totals_verified,
    player_minutes_verified,
    completed_at
  )
  values (
    v_game_id,
    v_run_id,
    v_pbp_document_id,
    v_build ->> 'methodVersion',
    v_build ->> 'inputSha256',
    v_status,
    v_coverage_status,
    coalesce(nullif(v_build ->> 'eventCount', '')::integer, 0),
    coalesce(nullif(v_build ->> 'validSnapshotCount', '')::integer, 0),
    coalesce(nullif(v_build ->> 'invalidSnapshotCount', '')::integer, 0),
    coalesce(v_build ->> 'errorSummary', ''),
    coalesce((v_build ->> 'finalScoreVerified')::boolean, false),
    coalesce((v_build ->> 'possessionTotalsVerified')::boolean, false),
    coalesce((v_build ->> 'playerMinutesVerified')::boolean, false),
    case when v_status in ('completed', 'partial') then now() else null end
  )
  on conflict (game_id, input_sha256, method_version) do update set
    import_run_id = excluded.import_run_id,
    source_document_id = excluded.source_document_id,
    status = excluded.status,
    coverage_status = excluded.coverage_status,
    event_count = excluded.event_count,
    valid_snapshot_count = excluded.valid_snapshot_count,
    invalid_snapshot_count = excluded.invalid_snapshot_count,
    error_summary = excluded.error_summary,
    final_score_verified = excluded.final_score_verified,
    possession_totals_verified = excluded.possession_totals_verified,
    player_minutes_verified = excluded.player_minutes_verified,
    completed_at = excluded.completed_at
  returning id into v_build_id;

  update public.nba_lineup_analytics_builds
  set status = 'superseded'
  where game_id = v_game_id
    and id <> v_build_id
    and status in ('running', 'completed', 'partial');

  delete from public.nba_game_lineup_stints where build_id = v_build_id;
  insert into public.nba_game_lineup_stints (
    build_id,
    game_id,
    stint_ordinal,
    home_lineup_id,
    away_lineup_id,
    start_event_id,
    end_event_id,
    start_elapsed_ms,
    end_elapsed_ms,
    duration_ms,
    home_points,
    away_points,
    home_offensive_possessions,
    away_offensive_possessions,
    quality_flags
  )
  select
    v_build_id,
    v_game_id,
    (source.value ->> 'stintOrdinal')::integer,
    nullif(source.value ->> 'homeLineupId', '')::uuid,
    nullif(source.value ->> 'awayLineupId', '')::uuid,
    nullif(source.value ->> 'startEventId', '')::uuid,
    nullif(source.value ->> 'endEventId', '')::uuid,
    coalesce(nullif(source.value ->> 'startElapsedMs', '')::integer, 0),
    coalesce(nullif(source.value ->> 'endElapsedMs', '')::integer, 0),
    coalesce(nullif(source.value ->> 'durationMs', '')::integer, 0),
    coalesce(nullif(source.value ->> 'homePoints', '')::integer, 0),
    coalesce(nullif(source.value ->> 'awayPoints', '')::integer, 0),
    coalesce(nullif(source.value ->> 'homeOffensivePossessions', '')::numeric, 0),
    coalesce(nullif(source.value ->> 'awayOffensivePossessions', '')::numeric, 0),
    array(select jsonb_array_elements_text(coalesce(source.value -> 'qualityFlags', '[]'::jsonb)))
  from jsonb_array_elements(coalesce(v_analytics -> 'stints', '[]'::jsonb)) as source(value);
  get diagnostics v_stint_count = row_count;

  delete from public.nba_game_possessions where build_id = v_build_id;
  insert into public.nba_game_possessions (
    id,
    build_id,
    game_id,
    source_possession_id,
    possession_ordinal,
    offense_provider_team_id,
    defense_provider_team_id,
    home_lineup_id,
    away_lineup_id,
    start_event_id,
    terminal_event_id,
    period_sequence,
    clock_remaining_ms,
    home_points_before,
    away_points_before,
    offense_points,
    defense_points,
    is_clutch_v1,
    home_score_state_v1,
    transition_context,
    transition_source,
    has_lineup_change_mid_possession,
    possession_source,
    quality_flags
  )
  select
    nullif(source.value ->> 'id', '')::uuid,
    v_build_id,
    v_game_id,
    source.value ->> 'sourcePossessionId',
    (source.value ->> 'possessionOrdinal')::integer,
    nullif(source.value ->> 'offenseProviderTeamId', '')::uuid,
    nullif(source.value ->> 'defenseProviderTeamId', '')::uuid,
    nullif(source.value ->> 'homeLineupId', '')::uuid,
    nullif(source.value ->> 'awayLineupId', '')::uuid,
    nullif(source.value ->> 'startEventId', '')::uuid,
    nullif(source.value ->> 'terminalEventId', '')::uuid,
    (source.value ->> 'periodSequence')::smallint,
    nullif(source.value ->> 'clockRemainingMs', '')::integer,
    coalesce(nullif(source.value ->> 'homePointsBefore', '')::integer, 0),
    coalesce(nullif(source.value ->> 'awayPointsBefore', '')::integer, 0),
    coalesce(nullif(source.value ->> 'offensePoints', '')::integer, 0),
    coalesce(nullif(source.value ->> 'defensePoints', '')::integer, 0),
    coalesce((source.value ->> 'isClutchV1')::boolean, false),
    coalesce(nullif(source.value ->> 'homeScoreStateV1', ''), 'tied'),
    coalesce(nullif(source.value ->> 'transitionContext', ''), 'unclassified'),
    coalesce(nullif(source.value ->> 'transitionSource', ''), 'unavailable'),
    coalesce((source.value ->> 'hasLineupChangeMidPossession')::boolean, false),
    coalesce(nullif(source.value ->> 'possessionSource', ''), 'provider_post_event_state'),
    array(select jsonb_array_elements_text(coalesce(source.value -> 'qualityFlags', '[]'::jsonb)))
  from jsonb_array_elements(coalesce(v_analytics -> 'possessions', '[]'::jsonb)) as source(value);
  get diagnostics v_possession_count = row_count;

  update public.nba_games
  set analytics_status = case
        when v_status = 'completed' and v_coverage_status = 'eligible' then 'ready'
        when v_coverage_status = 'ineligible' then 'ineligible'
        when v_status = 'failed' then 'failed'
        else 'partial'
      end,
      analytics_error = coalesce(v_build ->> 'errorSummary', '')
  where id = v_game_id;

  update public.nba_pbp_import_runs
  set games_discovered = games_discovered + 1,
      games_eligible = games_eligible + case when v_coverage_status = 'eligible' then 1 else 0 end,
      games_ready = games_ready + case when v_status = 'completed' and v_coverage_status = 'eligible' then 1 else 0 end,
      events_upserted = events_upserted + v_event_count,
      stints_upserted = stints_upserted + v_stint_count,
      possessions_upserted = possessions_upserted + v_possession_count
  where id = v_run_id;

  return jsonb_build_object(
    'gameId', v_game_id,
    'buildId', v_build_id,
    'eventCount', v_event_count,
    'stintCount', v_stint_count,
    'possessionCount', v_possession_count,
    'analyticsStatus', case
      when v_status = 'completed' and v_coverage_status = 'eligible' then 'ready'
      when v_coverage_status = 'ineligible' then 'ineligible'
      when v_status = 'failed' then 'failed'
      else 'partial'
    end
  );
end;
$$;

revoke all on function public.ingest_nba_sportradar_game(jsonb) from public;
grant execute on function public.ingest_nba_sportradar_game(jsonb) to service_role;

comment on function public.ingest_nba_sportradar_game(jsonb) is
  'Private atomic write boundary for a licensed Sportradar NBA v8 source revision. Browser roles cannot execute it.';
