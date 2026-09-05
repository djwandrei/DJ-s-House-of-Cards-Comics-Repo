-- Private, validation-gated input catalog for the public Scout Daily Games.
--
-- A daily-game scope is either one validated season or one validated combined
-- model.  It must never be assembled by ranking players from independently
-- trained single-season models together.  The tables have no Data API access;
-- only the service-role RPC below may read the private Scout components.

create or replace function public.nba_scout_daily_game_public_stats_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    pg_catalog.jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from pg_catalog.jsonb_each(p_value) as entry(key, value)
      where entry.key <> all (array[
        'games', 'minutes', 'points', 'rebounds', 'assists', 'steals',
        'blocks', 'turnovers', 'efgPct', 'threePct'
      ]::text[])
        or pg_catalog.jsonb_typeof(entry.value) not in ('number', 'null')
        or (
          pg_catalog.jsonb_typeof(entry.value) = 'number'
          and entry.value #>> '{}' in ('NaN', 'Infinity', '-Infinity')
        )
    ),
    false
  );
$$;

create table if not exists public.nba_scout_daily_game_scopes (
  id uuid primary key default gen_random_uuid(),
  scope_key text not null unique
    check (scope_key ~ '^[a-z0-9][a-z0-9-]{2,95}$'),
  public_label text not null
    check (length(trim(public_label)) between 3 and 160),
  model_version text not null
    check (length(trim(model_version)) between 3 and 160),
  model_artifact_sha256 text not null
    check (model_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  model_scope_kind text not null
    check (model_scope_kind in ('single-season', 'combined-window')),
  source_season_end_years smallint[] not null
    check (
      cardinality(source_season_end_years) between 1 and 3
      and source_season_end_years <@ array[2024, 2025, 2026]::smallint[]
      and array_position(source_season_end_years, null) is null
    ),
  source_validation_passed boolean not null default false,
  source_validation_report_sha256 text
    check (source_validation_report_sha256 is null or source_validation_report_sha256 ~ '^[a-f0-9]{64}$'),
  calibration_status text not null default 'pending'
    check (calibration_status in ('pending', 'validated')),
  calibration_all_components_improved boolean not null default false,
  season_phase text not null,
  expected_player_count integer not null
    check (expected_player_count between 1 and 10000),
  status text not null default 'staging'
    check (status in ('staging', 'ready', 'disabled')),
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_scout_daily_game_scope_model_shape check (
    (cardinality(source_season_end_years) = 1 and model_scope_kind = 'single-season')
    or (cardinality(source_season_end_years) > 1 and model_scope_kind = 'combined-window')
  ),
  constraint nba_scout_daily_game_scope_ready_gate check (
    status <> 'ready' or (
      source_validation_passed
      and source_validation_report_sha256 is not null
      and calibration_status = 'validated'
      and calibration_all_components_improved
      and published_at is not null
    )
  )
);

create table if not exists public.nba_scout_daily_game_players (
  id uuid primary key default gen_random_uuid(),
  scope_id uuid not null references public.nba_scout_daily_game_scopes(id) on delete restrict,
  source_season_end_year smallint not null
    check (source_season_end_year between 2024 and 2026),
  team_code text not null
    check (team_code ~ '^[A-Z0-9]{2,8}$'),
  team_name text not null
    check (length(trim(team_name)) between 2 and 160),
  franchise_key text not null
    check (franchise_key ~ '^[a-z0-9][a-z0-9_-]{1,63}$'),
  player_name text not null
    check (length(trim(player_name)) between 2 and 160),
  positions text[] not null
    check (
      cardinality(positions) between 1 and 3
      and positions <@ array['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
      and array_position(positions, null) is null
    ),
  public_stats jsonb not null default '{}'::jsonb
    check (public.nba_scout_daily_game_public_stats_is_safe(public_stats)),
  offensive_rapm_per_100 numeric(14, 4) not null
    check (offensive_rapm_per_100 between -100 and 100),
  defensive_rapm_per_100 numeric(14, 4) not null
    check (defensive_rapm_per_100 between -100 and 100),
  paired_possessions numeric(14, 3)
    check (paired_possessions is null or paired_possessions >= 0),
  display_eligible boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists nba_scout_daily_game_players_identity_idx
  on public.nba_scout_daily_game_players (
    scope_id, source_season_end_year, team_code, lower(player_name)
  );

-- The catalog RPC only reads display-eligible rows. Keep that hot, narrow
-- service-only path indexed without paying to index staged/ineligible rows.
create index if not exists nba_scout_daily_game_players_scope_eligible_idx
  on public.nba_scout_daily_game_players (scope_id, source_season_end_year, team_code, player_name)
  where display_eligible;

alter table public.nba_scout_daily_game_scopes enable row level security;
alter table public.nba_scout_daily_game_players enable row level security;
revoke all on table public.nba_scout_daily_game_scopes from public, anon, authenticated, service_role;
revoke all on table public.nba_scout_daily_game_players from public, anon, authenticated, service_role;

-- Start or replace a staging scope.  A published/disabled scope is immutable;
-- publish a new key when the validated model changes so daily outcomes remain
-- reproducible against their model revision.
create or replace function public.register_nba_scout_daily_game_scope(p_payload jsonb)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  v_scope public.nba_scout_daily_game_scopes%rowtype;
  v_scope_key text := lower(trim(coalesce(p_payload ->> 'scopeKey', '')));
  v_public_label text := trim(coalesce(p_payload ->> 'publicLabel', ''));
  v_model_version text := trim(coalesce(p_payload ->> 'modelVersion', ''));
  v_model_artifact_sha256 text := lower(trim(coalesce(p_payload ->> 'modelArtifactSha256', '')));
  v_model_scope_kind text := trim(coalesce(p_payload ->> 'modelScopeKind', ''));
  v_source_report_sha256 text := lower(trim(coalesce(p_payload ->> 'sourceValidationReportSha256', '')));
  v_calibration_status text := trim(coalesce(p_payload ->> 'calibrationStatus', 'pending'));
  v_season_phase text := trim(coalesce(p_payload ->> 'seasonPhase', ''));
  v_source_validation_passed boolean := coalesce((p_payload ->> 'sourceValidationPassed')::boolean, false);
  v_components_improved boolean := coalesce((p_payload ->> 'calibrationAllComponentsImproved')::boolean, false);
  v_expected_player_count integer;
  v_seasons smallint[];
begin
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Scout daily-game scope payload must be an object.';
  end if;
  if pg_catalog.jsonb_typeof(p_payload -> 'sourceSeasonEndYears') <> 'array' then
    raise exception 'Scout daily-game scope must declare sourceSeasonEndYears.';
  end if;
  select coalesce(array_agg(distinct trim(value)::smallint order by trim(value)::smallint), array[]::smallint[])
    into v_seasons
  from pg_catalog.jsonb_array_elements_text(p_payload -> 'sourceSeasonEndYears') as entry(value);
  if cardinality(v_seasons) not between 1 and 3
    or not (v_seasons <@ array[2024, 2025, 2026]::smallint[]) then
    raise exception 'Scout daily-game scope has an unsupported season window.';
  end if;
  if (cardinality(v_seasons) = 1 and v_model_scope_kind <> 'single-season')
    or (cardinality(v_seasons) > 1 and v_model_scope_kind <> 'combined-window') then
    raise exception 'Scout daily-game model scope must match its season window.';
  end if;
  if v_scope_key !~ '^[a-z0-9][a-z0-9-]{2,95}$'
    or length(v_public_label) not between 3 and 160
    or length(v_model_version) not between 3 and 160
    or v_model_artifact_sha256 !~ '^[a-f0-9]{64}$'
    or v_source_report_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Scout daily-game scope identity is invalid.';
  end if;
  if v_calibration_status not in ('pending', 'validated') then
    raise exception 'Scout daily-game calibration status is invalid.';
  end if;
  if v_season_phase <> 'regular_in_season_tournament_play_in_playoffs_official_franchise_sportradar-nba-lineup-reconstruction-v3_possession_start_lineups' then
    raise exception 'Scout daily-game scope has an unsupported phase or reconstruction scope.';
  end if;
  if coalesce(p_payload ->> 'expectedPlayerCount', '') !~ '^[0-9]+$' then
    raise exception 'Scout daily-game expectedPlayerCount is invalid.';
  end if;
  v_expected_player_count := (p_payload ->> 'expectedPlayerCount')::integer;
  if v_expected_player_count not between 1 and 10000 then
    raise exception 'Scout daily-game expectedPlayerCount is out of range.';
  end if;

  select * into v_scope
  from public.nba_scout_daily_game_scopes
  where scope_key = v_scope_key
  for update;
  if found then
    if v_scope.status <> 'staging' then
      raise exception 'Scout daily-game scope % is immutable once published or disabled.', v_scope_key;
    end if;
    delete from public.nba_scout_daily_game_players where scope_id = v_scope.id;
    update public.nba_scout_daily_game_scopes
    set public_label = v_public_label,
        model_version = v_model_version,
        model_artifact_sha256 = v_model_artifact_sha256,
        model_scope_kind = v_model_scope_kind,
        source_season_end_years = v_seasons,
        source_validation_passed = v_source_validation_passed,
        source_validation_report_sha256 = v_source_report_sha256,
        calibration_status = v_calibration_status,
        calibration_all_components_improved = v_components_improved,
        season_phase = v_season_phase,
        expected_player_count = v_expected_player_count,
        published_at = null,
        updated_at = now()
    where id = v_scope.id
    returning * into v_scope;
  else
    insert into public.nba_scout_daily_game_scopes (
      scope_key, public_label, model_version, model_artifact_sha256,
      model_scope_kind, source_season_end_years, source_validation_passed,
      source_validation_report_sha256, calibration_status,
      calibration_all_components_improved, season_phase, expected_player_count
    ) values (
      v_scope_key, v_public_label, v_model_version, v_model_artifact_sha256,
      v_model_scope_kind, v_seasons, v_source_validation_passed,
      v_source_report_sha256, v_calibration_status,
      v_components_improved, v_season_phase, v_expected_player_count
    ) returning * into v_scope;
  end if;
  return v_scope.id;
end;
$$;

-- Bounded, retry-safe ingestion.  The opaque row UUID is generated by the
-- database and is the only player identifier that can later reach a browser.
create or replace function public.ingest_nba_scout_daily_game_players(
  p_scope_id uuid, p_rows jsonb
)
returns integer
language plpgsql security definer set search_path = ''
as $$
declare
  v_scope public.nba_scout_daily_game_scopes%rowtype;
  v_row record;
  v_positions text[];
  v_count integer := 0;
begin
  select * into v_scope
  from public.nba_scout_daily_game_scopes
  where id = p_scope_id
  for update;
  if not found or v_scope.status <> 'staging' then
    raise exception 'Scout daily-game scope is not accepting staged players.';
  end if;
  if p_rows is null or pg_catalog.jsonb_typeof(p_rows) <> 'array'
    or pg_catalog.jsonb_array_length(p_rows) not between 1 and 1000 then
    raise exception 'Scout daily-game player ingestion requires 1 to 1000 rows.';
  end if;

  for v_row in
    select * from pg_catalog.jsonb_to_recordset(p_rows) as row(
      source_season_end_year smallint,
      team_code text,
      team_name text,
      franchise_key text,
      player_name text,
      positions jsonb,
      public_stats jsonb,
      offensive_rapm_per_100 numeric,
      defensive_rapm_per_100 numeric,
      paired_possessions numeric,
      display_eligible boolean
    )
  loop
    if v_row.source_season_end_year is null
      or not (v_row.source_season_end_year = any(v_scope.source_season_end_years))
      or upper(trim(coalesce(v_row.team_code, ''))) !~ '^[A-Z0-9]{2,8}$'
      or length(trim(coalesce(v_row.team_name, ''))) not between 2 and 160
      or lower(trim(coalesce(v_row.franchise_key, ''))) !~ '^[a-z0-9][a-z0-9_-]{1,63}$'
      or length(trim(coalesce(v_row.player_name, ''))) not between 2 and 160
      or v_row.offensive_rapm_per_100 is null
      or v_row.defensive_rapm_per_100 is null
      or v_row.offensive_rapm_per_100 not between -100 and 100
      or v_row.defensive_rapm_per_100 not between -100 and 100
      or (v_row.paired_possessions is not null and v_row.paired_possessions < 0)
      or v_row.display_eligible is null
      or not public.nba_scout_daily_game_public_stats_is_safe(v_row.public_stats) then
      raise exception 'Scout daily-game player row is invalid.';
    end if;
    if pg_catalog.jsonb_typeof(v_row.positions) <> 'array' then
      raise exception 'Scout daily-game player positions are invalid.';
    end if;
    select coalesce(array_agg(upper(trim(value))), array[]::text[])
      into v_positions
    from pg_catalog.jsonb_array_elements_text(v_row.positions) as position(value);
    if cardinality(v_positions) not between 1 and 3
      or not (v_positions <@ array['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[])
      or array_position(v_positions, null) is not null then
      raise exception 'Scout daily-game player positions are invalid.';
    end if;

    insert into public.nba_scout_daily_game_players (
      scope_id, source_season_end_year, team_code, team_name, franchise_key,
      player_name, positions, public_stats, offensive_rapm_per_100,
      defensive_rapm_per_100, paired_possessions, display_eligible, updated_at
    ) values (
      p_scope_id, v_row.source_season_end_year, upper(trim(v_row.team_code)),
      trim(v_row.team_name), lower(trim(v_row.franchise_key)), trim(v_row.player_name),
      v_positions, v_row.public_stats, v_row.offensive_rapm_per_100,
      v_row.defensive_rapm_per_100, v_row.paired_possessions,
      v_row.display_eligible, now()
    ) on conflict (scope_id, source_season_end_year, team_code, lower(player_name))
    do update set
      team_name = excluded.team_name,
      franchise_key = excluded.franchise_key,
      positions = excluded.positions,
      public_stats = excluded.public_stats,
      offensive_rapm_per_100 = excluded.offensive_rapm_per_100,
      defensive_rapm_per_100 = excluded.defensive_rapm_per_100,
      paired_possessions = excluded.paired_possessions,
      display_eligible = excluded.display_eligible,
      updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Publish only after every expected player row is present and the exact model
-- carries a successful source-validation and O/D calibration gate.
create or replace function public.finalize_nba_scout_daily_game_scope(p_scope_id uuid)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_scope public.nba_scout_daily_game_scopes%rowtype;
  v_player_count integer;
  v_eligible_count integer;
begin
  select * into v_scope
  from public.nba_scout_daily_game_scopes
  where id = p_scope_id
  for update;
  if not found or v_scope.status <> 'staging' then
    raise exception 'Scout daily-game scope is not ready to finalize.';
  end if;
  if not v_scope.source_validation_passed
    or v_scope.source_validation_report_sha256 is null
    or v_scope.calibration_status <> 'validated'
    or not v_scope.calibration_all_components_improved then
    raise exception 'Scout daily-game validation/calibration gate has not passed.';
  end if;
  select count(*), count(*) filter (where display_eligible)
    into v_player_count, v_eligible_count
  from public.nba_scout_daily_game_players
  where scope_id = p_scope_id;
  if v_player_count <> v_scope.expected_player_count then
    raise exception 'Scout daily-game scope has % player rows; expected %.', v_player_count, v_scope.expected_player_count;
  end if;
  if v_eligible_count < 15 then
    raise exception 'Scout daily-game scope has too few display-eligible players.';
  end if;
  if exists (
    select 1 from public.nba_scout_daily_game_players
    where scope_id = p_scope_id
      and not (source_season_end_year = any(v_scope.source_season_end_years))
  ) then
    raise exception 'Scout daily-game scope contains a player outside its model window.';
  end if;
  update public.nba_scout_daily_game_scopes
  set status = 'ready', published_at = now(), updated_at = now()
  where id = p_scope_id;
  return pg_catalog.jsonb_build_object(
    'scopeKey', v_scope.scope_key,
    'status', 'ready',
    'eligiblePlayerCount', v_eligible_count
  );
end;
$$;

-- Service-only bridge for the commerce Edge Function.  This is deliberately
-- the only result containing private Scout components; it must never be
-- granted to a browser role or proxied directly to a browser.
create or replace function public.get_nba_scout_daily_game_catalog()
returns jsonb
language sql security definer set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'contractVersion', 1,
    'scopes', coalesce(pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', scope.scope_key,
        'status', 'ready',
        'model', pg_catalog.jsonb_build_object(
          'publicLabel', scope.public_label,
          'seasonEndYears', pg_catalog.to_jsonb(scope.source_season_end_years),
          'calibration', pg_catalog.jsonb_build_object(
            'status', 'validated',
            'allComponentsImproved', true
          )
        ),
        'players', (
          select coalesce(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
              'playerId', player.id::text,
              'name', player.player_name,
              'positions', pg_catalog.to_jsonb(player.positions),
              'teamCode', player.team_code,
              'teamName', player.team_name,
              'franchiseId', player.franchise_key,
              'sourceSeasonEndYear', player.source_season_end_year,
              'publicStats', player.public_stats,
              'scout', pg_catalog.jsonb_build_object(
                'offense', player.offensive_rapm_per_100,
                'defense', player.defensive_rapm_per_100
              )
            ) order by player.source_season_end_year, player.team_code, player.player_name
          ), '[]'::jsonb)
          from public.nba_scout_daily_game_players player
          where player.scope_id = scope.id and player.display_eligible
        )
      ) order by scope.scope_key
    ), '[]'::jsonb)
  )
  from public.nba_scout_daily_game_scopes scope
  where scope.status = 'ready';
$$;

revoke all on function public.nba_scout_daily_game_public_stats_is_safe(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.register_nba_scout_daily_game_scope(jsonb) from public, anon, authenticated;
revoke all on function public.ingest_nba_scout_daily_game_players(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_nba_scout_daily_game_scope(uuid) from public, anon, authenticated;
revoke all on function public.get_nba_scout_daily_game_catalog() from public, anon, authenticated;
grant execute on function public.register_nba_scout_daily_game_scope(jsonb) to service_role;
grant execute on function public.ingest_nba_scout_daily_game_players(uuid, jsonb) to service_role;
grant execute on function public.finalize_nba_scout_daily_game_scope(uuid) to service_role;
grant execute on function public.get_nba_scout_daily_game_catalog() to service_role;
