-- Expand the validated Scout Daily Games catalog from the 2020-26
-- release window to the completed 2017-26 source package. This is a forward
-- migration: the original migration remains an immutable record of its
-- initial contract.

alter table public.nba_scout_daily_game_scopes
  drop constraint if exists nba_scout_daily_game_scopes_source_season_end_years_check,
  drop constraint if exists nba_scout_daily_game_scopes_source_season_end_years_2020_26_check;

alter table public.nba_scout_daily_game_scopes
  add constraint nba_scout_daily_game_scopes_source_season_end_years_2017_26_check
  check (
    cardinality(source_season_end_years) between 1 and 9
    and source_season_end_years <@ array[2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]::smallint[]
    and array_position(source_season_end_years, null) is null
  );

alter table public.nba_scout_daily_game_players
  drop constraint if exists nba_scout_daily_game_players_source_season_end_year_check,
  drop constraint if exists nba_scout_daily_game_players_source_season_end_year_2020_26_check;

alter table public.nba_scout_daily_game_players
  add constraint nba_scout_daily_game_players_source_season_end_year_2017_26_check
  check (source_season_end_year between 2018 and 2026);

-- Keep the service-only registration gate aligned with the table contract.
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
  if cardinality(v_seasons) not between 1 and 9
    or not (v_seasons <@ array[2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]::smallint[]) then
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

revoke all on function public.register_nba_scout_daily_game_scope(jsonb) from public, anon, authenticated;
grant execute on function public.register_nba_scout_daily_game_scope(jsonb) to service_role;
