-- Private, compact query index for validated local NBA Scout archives.
--
-- The immutable Storage archive remains the complete derived-output record.
-- This schema deliberately materializes a bounded query index instead of
-- copying multi-gigabyte team JSON payloads into Postgres.  Raw PBP, provider
-- documents, archive object paths, and full nested lineup/WOWY contexts are
-- never exposed through browser roles or the query RPCs below.

-- The importer emits only an allowlisted compact scalar/object vocabulary.
-- This adds a database-side backstop against accidentally persisting raw PBP,
-- source contexts, archive locations, or opaque payload blobs through the
-- service-role-only ingestion RPCs.
create or replace function public.nba_scout_compact_jsonb_is_safe(p_value jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with recursive walk(value, key, depth) as (
    select p_value, null::text, 0
    union all
    select child.value, child.key, walk.depth + 1
    from walk
    cross join lateral (
      select member.value, member.key
      from pg_catalog.jsonb_each(
        case when pg_catalog.jsonb_typeof(walk.value) = 'object'
          then walk.value else '{}'::jsonb end
      ) as member(key, value)
      union all
      select member.value, null::text
      from pg_catalog.jsonb_array_elements(
        case when pg_catalog.jsonb_typeof(walk.value) = 'array'
          then walk.value else '[]'::jsonb end
      ) as member(value)
    ) as child
    where walk.depth < 6
  )
  select p_value is not null
    and pg_catalog.jsonb_typeof(p_value) = 'object'
    and not exists (
      select 1
      from walk
      where pg_catalog.jsonb_typeof(value) = 'array'
         or depth > 5
         or (key is not null and key <> all (array[
           'games', 'gameResults', 'pointsFor', 'pointsAgainst', 'offensivePointsFor', 'defensivePointsAllowed',
           'offensivePossessions', 'defensivePossessions', 'totalPossessions', 'offensiveRating', 'defensiveRating',
           'netRating', 'plusMinusPer100', 'wins', 'losses', 'ties', 'unclassified', 'decisions', 'winPercentage',
           'reliability', 'possessions', 'grade', 'publishable', 'reliabilityScore', 'method', 'confidence95',
           'estimate', 'standardError', 'lower', 'upper', 'fourFactors', 'offense', 'defense',
           'effectiveFieldGoalPercentage', 'turnoverRate', 'offensiveReboundPercentage', 'freeThrowAttemptRate',
           'coverage', 'status', 'relevantEventCount', 'resolvedEventCount', 'unresolvedEventCount',
           'resolvedRelevantEventShare', 'shootingProfile', 'fieldGoalAttempts', 'fieldGoalsMade', 'twoPointAttempts',
           'twoPointMakes', 'threePointAttempts', 'threePointersMade', 'freeThrowAttempts', 'freeThrowsMade',
           'twoPointPercentage', 'threePointPercentage', 'freeThrowPercentage', 'threePointAttemptRate',
           'trueShootingPercentage', 'averageFieldGoalDistance', 'fieldGoalDistanceObserved', 'offensivePlaymaking',
           'assists', 'foulsDrawn', 'assistsPer100Possessions', 'foulsDrawnPer100Possessions',
           'assistedFieldGoalRate', 'assistToTurnoverRatio', 'possessionExtensions', 'secondChancePossessions',
           'secondChancePoints', 'secondChancePossessionRate', 'secondChancePointsPer100Possessions',
           'pointsPerSecondChancePossession', 'pointsOffTurnoverPossessions', 'pointsOffTurnovers',
           'pointsOffTurnoverPossessionRate', 'pointsOffTurnoverPer100Possessions', 'pointsPerPossessionAfterTurnover',
           'defensiveDisruption', 'steals', 'blocks', 'personalFouls', 'stealsPer100DefensivePossessions',
           'blocksPer100DefensivePossessions', 'personalFoulsPer100DefensivePossessions', 'blockRate',
           'stealForcedTurnoverRate', 'possessionOutcomes', 'empty', 'one', 'two', 'three', 'fourPlus',
           'accountedPossessions', 'scoringPossessions', 'scoringPossessionRate', 'pointsPerPossession', 'definition',
           'semantics', 'teamPossessions', 'minutes', 'possessionsPerGame', 'teamPossessionsPerGame',
           'minutesPerGame', 'pacePer48Minutes', 'on', 'off', 'gamesUsed', 'teamPossessionShare',
           'teamMinuteShare', 'exactLineupStartingGames', 'exactLineupClosingGames', 'exactLineupStartRate',
           'exactLineupCloseRate', 'offensiveRatingDifference', 'defensiveRatingDifference',
           'netRatingDifference', 'onOffNetRating', 'plusMinusPer100Difference', 'convention', 'starterGames',
           'closerGames', 'starterGameRate', 'closerGameRate', 'teamPossessionsWhileOnCourt',
           'structuredStatisticRows', 'recognizedStatisticRows', 'unknownFieldGoalMadeStatus',
           'unclassifiedFieldGoalAttempts', 'unclassifiedFieldGoalMakes', 'unknownFreeThrowMadeStatus',
           'unclassifiedRebounds', 'fieldGoalMadeStatusShare', 'fieldGoalValueClassifiedShare',
           'freeThrowMadeStatusShare', 'missingProviderShotType', 'missingProviderShotDescription',
           'providerShotTypeShare', 'providerShotDescriptionShare', 'scoringComplete', 'reboundsComplete',
           'boxScore', 'shooting', 'per36', 'per100Possessions', 'points', 'rebounds', 'shotAttemptsBlocked',
           'turnovers', 'technicalFouls', 'nonUnsportsmanlikeTechnicalFouls', 'totalTechnicalFouls', 'flagrantFouls', 'ejections',
           'offensiveRebounds', 'defensiveRebounds', 'fieldGoalPercentage', 'blockedAttemptRate', 'possessionEndingInvolvementProxy',
           'expectedMinutes', 'expectedNetRating', 'aOffBOn', 'aOffBOff', 'aOnBOff', 'aOnBOn', 'modelVersion',
           'seasonEndYear', 'seasonPhase', 'lambda', 'observationCount', 'directionalObservationCount',
           'pairedStintObservationCount', 'gameCount', 'totalPairedPossessions', 'totalOffensivePossessions',
           'excludedStintCount', 'skippedDirectionalObservationCount', 'inputSha256', 'interceptPer100',
           'baselineOffensiveRatingPer100', 'homeCourtEffectPer100', 'homeCourtSignConvention',
           'homeCourtNetRatingEffectPer100', 'formulation', 'defensiveSignConvention', 'contextSemantics',
           'sourceMode', 'sourceExactLineupPossessions', 'converged', 'iterationCount', 'residualNorm',
           'targetResidualNorm', 'solver', 'averageTeammateNetRapmPer100', 'averageOpponentNetRapmPer100',
           'teammateRapmContextPer100', 'opponentRapmContextPer100', 'displayMinimumPairedPossessions',
           'sampleSizeTier', 'ridgeReliabilityProxy', 'exposureShareOfAvailablePossessions',
           'offensiveObservationCount', 'defensiveObservationCount', 'offensiveRidgeReliabilityProxy',
           'defensiveRidgeReliabilityProxy'
         ]::text[]))
         or (pg_catalog.jsonb_typeof(value) = 'string' and pg_catalog.length(value #>> '{}') > 500)
         or pg_catalog.jsonb_typeof(value) not in ('object', 'number', 'boolean', 'string', 'null')
    );
$$;

create table if not exists public.nba_scout_archive_imports (
  id uuid primary key default gen_random_uuid(),
  manifest_sha256 text not null unique
    check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  archive_bucket text not null default 'nba-scout-analytics-archive'
    check (archive_bucket = 'nba-scout-analytics-archive'),
  archive_prefix text not null
    check (archive_prefix ~ '^[A-Za-z0-9._/-]+$' and archive_prefix !~ '(^|/)\.\.(/|$)'),
  schema_version smallint not null check (schema_version >= 1),
  metrics_version text not null check (length(trim(metrics_version)) > 0),
  provider text not null check (length(trim(provider)) > 0),
  season_start_year smallint not null,
  season_end_year smallint not null,
  source_validation_passed boolean not null default false,
  source_validation_report_sha256 text
    check (source_validation_report_sha256 is null or source_validation_report_sha256 ~ '^[a-f0-9]{64}$'),
  archive_artifact_count integer not null check (archive_artifact_count > 0),
  archive_total_bytes bigint not null check (archive_total_bytes > 0),
  expected_row_counts jsonb not null default '{}'::jsonb
    check (jsonb_typeof(expected_row_counts) = 'object'),
  status text not null default 'staging'
    check (status in ('staging', 'ready')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint nba_scout_archive_imports_season_order check (season_end_year = season_start_year + 1),
  constraint nba_scout_archive_imports_bucket_prefix_key unique (archive_bucket, archive_prefix),
  constraint nba_scout_archive_imports_ready_requires_validation check (
    status <> 'ready' or (source_validation_passed and completed_at is not null)
  )
);

create table if not exists public.nba_scout_archive_shards (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  team_name text not null check (length(trim(team_name)) > 0),
  gzip_relative_path text not null
    check (gzip_relative_path ~ '^teams/[A-Za-z0-9._-]+\.json\.gz$'),
  gzip_sha256 text not null check (gzip_sha256 ~ '^[a-f0-9]{64}$'),
  gzip_bytes bigint not null check (gzip_bytes > 0),
  json_sha256 text not null check (json_sha256 ~ '^[a-f0-9]{64}$'),
  json_bytes bigint not null check (json_bytes > 0),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  team_row_count integer not null check (team_row_count = 1),
  lineup_row_count integer not null check (lineup_row_count >= 0),
  player_on_off_row_count integer not null check (player_on_off_row_count >= 0),
  player_profile_row_count integer not null check (player_profile_row_count >= 0),
  wowy_row_count integer not null check (wowy_row_count >= 0),
  primary key (archive_import_id, team_id),
  unique (archive_import_id, gzip_relative_path),
  unique (archive_import_id, gzip_sha256)
);

create table if not exists public.nba_scout_team_context_metrics (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  context_key text not null check (length(trim(context_key)) > 0),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object' and public.nba_scout_compact_jsonb_is_safe(metrics)),
  total_possessions numeric(14, 3),
  net_rating numeric(14, 4),
  offensive_rating numeric(14, 4),
  defensive_rating numeric(14, 4),
  primary key (archive_import_id, team_id, context_key),
  foreign key (archive_import_id, team_id)
    references public.nba_scout_archive_shards(archive_import_id, team_id)
    on delete restrict
);

create table if not exists public.nba_scout_lineup_summaries (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  team_name text not null check (length(trim(team_name)) > 0),
  player_ids uuid[] not null,
  player_names text[] not null,
  player_count smallint not null check (player_count between 1 and 5),
  semantics text not null check (length(trim(semantics)) > 0),
  minutes numeric(14, 3),
  exposure jsonb not null default '{}'::jsonb check (jsonb_typeof(exposure) = 'object' and public.nba_scout_compact_jsonb_is_safe(exposure)),
  continuity jsonb not null default '{}'::jsonb check (jsonb_typeof(continuity) = 'object' and public.nba_scout_compact_jsonb_is_safe(continuity)),
  projection jsonb not null default '{}'::jsonb check (jsonb_typeof(projection) = 'object' and public.nba_scout_compact_jsonb_is_safe(projection)),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object' and public.nba_scout_compact_jsonb_is_safe(metrics)),
  total_possessions numeric(14, 3),
  net_rating numeric(14, 4),
  offensive_rating numeric(14, 4),
  defensive_rating numeric(14, 4),
  primary key (archive_import_id, team_id, player_ids),
  constraint nba_scout_lineup_summaries_member_count check (
    cardinality(player_ids) = player_count and cardinality(player_names) = player_count
  ),
  foreign key (archive_import_id, team_id)
    references public.nba_scout_archive_shards(archive_import_id, team_id)
    on delete restrict
);

create table if not exists public.nba_scout_player_on_off_summaries (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  team_name text not null check (length(trim(team_name)) > 0),
  player_id uuid not null,
  player_name text not null check (length(trim(player_name)) > 0),
  on_minutes numeric(14, 3),
  off_minutes numeric(14, 3),
  on_off_net_rating numeric(14, 4),
  exposure jsonb not null default '{}'::jsonb check (jsonb_typeof(exposure) = 'object' and public.nba_scout_compact_jsonb_is_safe(exposure)),
  scope jsonb not null default '{}'::jsonb check (jsonb_typeof(scope) = 'object' and public.nba_scout_compact_jsonb_is_safe(scope)),
  differences jsonb not null default '{}'::jsonb check (jsonb_typeof(differences) = 'object' and public.nba_scout_compact_jsonb_is_safe(differences)),
  primary key (archive_import_id, team_id, player_id),
  foreign key (archive_import_id, team_id)
    references public.nba_scout_archive_shards(archive_import_id, team_id)
    on delete restrict
);

create table if not exists public.nba_scout_player_on_off_context_metrics (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  player_id uuid not null,
  partition text not null check (partition in ('on', 'off')),
  context_key text not null check (length(trim(context_key)) > 0),
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object' and public.nba_scout_compact_jsonb_is_safe(metrics)),
  total_possessions numeric(14, 3),
  net_rating numeric(14, 4),
  offensive_rating numeric(14, 4),
  defensive_rating numeric(14, 4),
  primary key (archive_import_id, team_id, player_id, partition, context_key),
  foreign key (archive_import_id, team_id, player_id)
    references public.nba_scout_player_on_off_summaries(archive_import_id, team_id, player_id)
    on delete restrict
);

create table if not exists public.nba_scout_player_profiles (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  team_name text not null check (length(trim(team_name)) > 0),
  player_id uuid not null,
  player_name text not null check (length(trim(player_name)) > 0),
  games_appeared integer,
  minutes numeric(14, 3),
  profile jsonb not null check (jsonb_typeof(profile) = 'object' and public.nba_scout_compact_jsonb_is_safe(profile)),
  primary key (archive_import_id, team_id, player_id),
  foreign key (archive_import_id, team_id, player_id)
    references public.nba_scout_player_on_off_summaries(archive_import_id, team_id, player_id)
    on delete restrict
);

create table if not exists public.nba_scout_wowy_summaries (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  team_id uuid not null,
  team_name text not null check (length(trim(team_name)) > 0),
  player_a_id uuid not null,
  player_a_name text not null check (length(trim(player_a_name)) > 0),
  player_b_id uuid not null,
  player_b_name text not null check (length(trim(player_b_name)) > 0),
  semantics text not null check (length(trim(semantics)) > 0),
  cell_metrics jsonb not null check (jsonb_typeof(cell_metrics) = 'object' and public.nba_scout_compact_jsonb_is_safe(cell_metrics)),
  primary key (archive_import_id, team_id, player_a_id, player_b_id),
  constraint nba_scout_wowy_summaries_distinct_players check (player_a_id <> player_b_id),
  constraint nba_scout_wowy_summaries_canonical_pair check (player_a_id < player_b_id),
  foreign key (archive_import_id, team_id)
    references public.nba_scout_archive_shards(archive_import_id, team_id)
    on delete restrict
);

create table if not exists public.nba_scout_rapm_models (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  model_kind text not null check (model_kind in ('net', 'offense_defense')),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  model_metadata jsonb not null check (jsonb_typeof(model_metadata) = 'object' and public.nba_scout_compact_jsonb_is_safe(model_metadata)),
  primary key (archive_import_id, model_kind)
);

create table if not exists public.nba_scout_rapm_players (
  archive_import_id uuid not null references public.nba_scout_archive_imports(id) on delete restrict,
  model_kind text not null check (model_kind in ('net', 'offense_defense')),
  player_id uuid not null,
  player_name text not null check (length(trim(player_name)) > 0),
  rapm_per_100 numeric(14, 4),
  offensive_rapm_per_100 numeric(14, 4),
  defensive_rapm_per_100 numeric(14, 4),
  paired_possessions numeric(14, 3),
  display_eligible boolean not null default false,
  metrics jsonb not null check (jsonb_typeof(metrics) = 'object' and public.nba_scout_compact_jsonb_is_safe(metrics)),
  primary key (archive_import_id, model_kind, player_id),
  foreign key (archive_import_id, model_kind)
    references public.nba_scout_rapm_models(archive_import_id, model_kind)
    on delete restrict
);

create index if not exists nba_scout_archive_imports_ready_season_idx
  on public.nba_scout_archive_imports (season_end_year, status, completed_at desc nulls last);
create index if not exists nba_scout_lineup_summaries_leaders_idx
  on public.nba_scout_lineup_summaries (archive_import_id, team_id, player_count, net_rating desc nulls last);
create index if not exists nba_scout_player_on_off_context_lookup_idx
  on public.nba_scout_player_on_off_context_metrics (archive_import_id, team_id, player_id, context_key, partition);
create index if not exists nba_scout_player_profiles_player_idx
  on public.nba_scout_player_profiles (archive_import_id, player_id);
create index if not exists nba_scout_rapm_players_leaders_idx
  on public.nba_scout_rapm_players (archive_import_id, model_kind, rapm_per_100 desc nulls last);

alter table public.nba_scout_archive_imports enable row level security;
alter table public.nba_scout_archive_shards enable row level security;
alter table public.nba_scout_team_context_metrics enable row level security;
alter table public.nba_scout_lineup_summaries enable row level security;
alter table public.nba_scout_player_on_off_summaries enable row level security;
alter table public.nba_scout_player_on_off_context_metrics enable row level security;
alter table public.nba_scout_player_profiles enable row level security;
alter table public.nba_scout_wowy_summaries enable row level security;
alter table public.nba_scout_rapm_models enable row level security;
alter table public.nba_scout_rapm_players enable row level security;

revoke all on table public.nba_scout_archive_imports from public, anon, authenticated;
revoke all on table public.nba_scout_archive_imports from service_role;
revoke all on table public.nba_scout_archive_shards from public, anon, authenticated;
revoke all on table public.nba_scout_archive_shards from service_role;
revoke all on table public.nba_scout_team_context_metrics from public, anon, authenticated;
revoke all on table public.nba_scout_team_context_metrics from service_role;
revoke all on table public.nba_scout_lineup_summaries from public, anon, authenticated;
revoke all on table public.nba_scout_lineup_summaries from service_role;
revoke all on table public.nba_scout_player_on_off_summaries from public, anon, authenticated;
revoke all on table public.nba_scout_player_on_off_summaries from service_role;
revoke all on table public.nba_scout_player_on_off_context_metrics from public, anon, authenticated;
revoke all on table public.nba_scout_player_on_off_context_metrics from service_role;
revoke all on table public.nba_scout_player_profiles from public, anon, authenticated;
revoke all on table public.nba_scout_player_profiles from service_role;
revoke all on table public.nba_scout_wowy_summaries from public, anon, authenticated;
revoke all on table public.nba_scout_wowy_summaries from service_role;
revoke all on table public.nba_scout_rapm_models from public, anon, authenticated;
revoke all on table public.nba_scout_rapm_models from service_role;
revoke all on table public.nba_scout_rapm_players from public, anon, authenticated;
revoke all on table public.nba_scout_rapm_players from service_role;

create or replace function public.begin_nba_scout_archive_import(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_manifest_sha256 text;
  v_archive_bucket text;
  v_archive_prefix text;
  v_schema_version smallint;
  v_metrics_version text;
  v_provider text;
  v_season_start_year smallint;
  v_season_end_year smallint;
  v_source_validation_passed boolean;
  v_validation_sha256 text;
  v_artifact_count integer;
  v_total_bytes bigint;
  v_expected jsonb;
  v_key text;
begin
  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Scout archive import payload must be a JSON object.';
  end if;

  v_manifest_sha256 := lower(trim(coalesce(p_payload ->> 'manifestSha256', '')));
  v_archive_bucket := trim(coalesce(p_payload ->> 'archiveBucket', ''));
  v_archive_prefix := trim(coalesce(p_payload ->> 'archivePrefix', ''));
  v_metrics_version := trim(coalesce(p_payload ->> 'metricsVersion', ''));
  v_provider := trim(coalesce(p_payload ->> 'provider', ''));
  v_validation_sha256 := lower(nullif(trim(coalesce(p_payload ->> 'sourceValidationReportSha256', '')), ''));
  v_expected := p_payload -> 'expectedRows';

  if v_manifest_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Scout archive import requires a SHA-256 manifest hash.';
  end if;
  if v_archive_bucket <> 'nba-scout-analytics-archive' then
    raise exception 'Scout archive import may use only the private nba-scout-analytics-archive bucket.';
  end if;
  if v_archive_prefix !~ '^[A-Za-z0-9._/-]+$' or v_archive_prefix ~ '(^|/)\.\.(/|$)' then
    raise exception 'Scout archive import requires a safe immutable archive prefix.';
  end if;
  if v_metrics_version = '' or v_provider = '' then
    raise exception 'Scout archive import requires metricsVersion and provider.';
  end if;
  if v_validation_sha256 is not null and v_validation_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Scout validation report hash must be a SHA-256 value.';
  end if;
  if jsonb_typeof(v_expected) <> 'object' then
    raise exception 'Scout archive import requires expectedRows.';
  end if;
  foreach v_key in array array['teams', 'lineups', 'playerOnOff', 'playerProfiles', 'wowy', 'rapmModels', 'rapmPlayers', 'teamContexts', 'playerOnOffContexts']
  loop
    if coalesce(v_expected ->> v_key, '') !~ '^\d+$' then
      raise exception 'Scout expectedRows.% must be a non-negative integer.', v_key;
    end if;
  end loop;

  begin
    v_schema_version := nullif(p_payload ->> 'schemaVersion', '')::smallint;
    v_season_start_year := nullif(p_payload ->> 'seasonStartYear', '')::smallint;
    v_season_end_year := nullif(p_payload ->> 'seasonEndYear', '')::smallint;
    v_source_validation_passed := nullif(p_payload ->> 'sourceValidationPassed', '')::boolean;
    v_artifact_count := nullif(p_payload ->> 'archiveArtifactCount', '')::integer;
    v_total_bytes := nullif(p_payload ->> 'archiveTotalBytes', '')::bigint;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Scout archive import contains an invalid numeric or boolean metadata value.';
  end;

  if v_schema_version is distinct from 4
     or v_metrics_version <> 'nba-scout-metrics-v4'
     or v_season_start_year is null or v_season_end_year <> v_season_start_year + 1
     or v_source_validation_passed is not true
     or v_validation_sha256 is null
     or v_artifact_count is null or v_artifact_count < 1
     or v_total_bytes is null or v_total_bytes < 1
  then
    raise exception 'Scout archive import requires a validated, single-season immutable package.';
  end if;

  insert into public.nba_scout_archive_imports (
    manifest_sha256,
    archive_bucket,
    archive_prefix,
    schema_version,
    metrics_version,
    provider,
    season_start_year,
    season_end_year,
    source_validation_passed,
    source_validation_report_sha256,
    archive_artifact_count,
    archive_total_bytes,
    expected_row_counts
  )
  values (
    v_manifest_sha256,
    v_archive_bucket,
    v_archive_prefix,
    v_schema_version,
    v_metrics_version,
    v_provider,
    v_season_start_year,
    v_season_end_year,
    v_source_validation_passed,
    v_validation_sha256,
    v_artifact_count,
    v_total_bytes,
    v_expected
  )
  on conflict (manifest_sha256) do nothing
  returning * into v_import;

  if found then
    return jsonb_build_object('archiveImportId', v_import.id, 'mode', 'created-staging', 'status', v_import.status);
  end if;

  -- A concurrent importer may have created the same immutable manifest after
  -- this call was validated. Lock and compare every immutable field instead
  -- of treating a uniqueness conflict as an implicitly safe resume.
  select * into v_import
  from public.nba_scout_archive_imports
  where manifest_sha256 = v_manifest_sha256
  for update;
  if not found then
    raise exception 'Scout archive import could not resolve its immutable manifest after a conflict.';
  end if;
  if v_import.archive_bucket <> v_archive_bucket
     or v_import.archive_prefix <> v_archive_prefix
     or v_import.schema_version <> v_schema_version
     or v_import.metrics_version <> v_metrics_version
     or v_import.provider <> v_provider
     or v_import.season_start_year <> v_season_start_year
     or v_import.season_end_year <> v_season_end_year
     or v_import.source_validation_passed <> v_source_validation_passed
     or v_import.source_validation_report_sha256 is distinct from v_validation_sha256
     or v_import.archive_artifact_count <> v_artifact_count
     or v_import.archive_total_bytes <> v_total_bytes
     or v_import.expected_row_counts <> v_expected
  then
    raise exception 'Existing Scout archive manifest has conflicting immutable metadata.';
  end if;
  return jsonb_build_object(
    'archiveImportId', v_import.id,
    'mode', case when v_import.status = 'ready' then 'already-ready' else 'resume-staging' end,
    'status', v_import.status
  );
end;
$$;

create or replace function public.ingest_nba_scout_archive_shard(
  p_archive_import_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_existing public.nba_scout_archive_shards%rowtype;
  v_shard jsonb;
  v_team_id uuid;
  v_team_name text;
  v_gzip_relative_path text;
  v_gzip_sha256 text;
  v_gzip_bytes bigint;
  v_json_sha256 text;
  v_json_bytes bigint;
  v_team_rows integer;
  v_lineup_rows integer;
  v_on_off_rows integer;
  v_profile_rows integer;
  v_wowy_rows integer;
  v_team_context_rows integer;
  v_on_off_context_rows integer;
  v_invalid integer;
  v_key text;
  v_payload_sha256 text;
begin
  if p_archive_import_id is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Scout shard ingest requires an import ID and a JSON object payload.';
  end if;
  foreach v_key in array array['team_contexts', 'lineups', 'player_on_off', 'player_on_off_contexts', 'player_profiles', 'wowy']
  loop
    if jsonb_typeof(p_payload -> v_key) <> 'array' then
      raise exception 'Scout shard ingest requires an array payload field: %.', v_key;
    end if;
  end loop;
  v_shard := p_payload -> 'shard';
  if jsonb_typeof(v_shard) <> 'object' then
    raise exception 'Scout shard ingest requires shard metadata.';
  end if;

  begin
    v_team_id := nullif(v_shard ->> 'team_id', '')::uuid;
    v_team_name := trim(coalesce(v_shard ->> 'team_name', ''));
    v_gzip_relative_path := trim(coalesce(v_shard ->> 'gzip_relative_path', ''));
    v_gzip_sha256 := lower(trim(coalesce(v_shard ->> 'gzip_sha256', '')));
    v_gzip_bytes := nullif(v_shard ->> 'gzip_bytes', '')::bigint;
    v_json_sha256 := lower(trim(coalesce(v_shard ->> 'json_sha256', '')));
    v_json_bytes := nullif(v_shard ->> 'json_bytes', '')::bigint;
    v_team_rows := nullif(v_shard ->> 'team_row_count', '')::integer;
    v_lineup_rows := nullif(v_shard ->> 'lineup_row_count', '')::integer;
    v_on_off_rows := nullif(v_shard ->> 'player_on_off_row_count', '')::integer;
    v_profile_rows := nullif(v_shard ->> 'player_profile_row_count', '')::integer;
    v_wowy_rows := nullif(v_shard ->> 'wowy_row_count', '')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Scout shard metadata contains an invalid UUID or numeric value.';
  end;

  if v_team_id is null
     or v_team_name = ''
     or v_gzip_relative_path !~ '^teams/[A-Za-z0-9._-]+\.json\.gz$'
     or v_gzip_sha256 !~ '^[a-f0-9]{64}$'
     or v_json_sha256 !~ '^[a-f0-9]{64}$'
     or v_gzip_bytes is null or v_gzip_bytes < 1
     or v_json_bytes is null or v_json_bytes < 1
     or v_team_rows <> 1
     or v_lineup_rows is null or v_lineup_rows < 0
     or v_on_off_rows is null or v_on_off_rows < 0
     or v_profile_rows is null or v_profile_rows < 0
     or v_wowy_rows is null or v_wowy_rows < 0
  then
    raise exception 'Scout shard metadata is incomplete or unsafe.';
  end if;

  v_team_context_rows := jsonb_array_length(p_payload -> 'team_contexts');
  v_on_off_context_rows := jsonb_array_length(p_payload -> 'player_on_off_contexts');
  if v_lineup_rows <> jsonb_array_length(p_payload -> 'lineups')
     or v_on_off_rows <> jsonb_array_length(p_payload -> 'player_on_off')
     or v_profile_rows <> jsonb_array_length(p_payload -> 'player_profiles')
     or v_wowy_rows <> jsonb_array_length(p_payload -> 'wowy')
  then
    raise exception 'Scout shard metadata row counts do not match its compact query payload.';
  end if;
  v_payload_sha256 := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');

  select * into v_import
  from public.nba_scout_archive_imports
  where id = p_archive_import_id
  for update;
  if not found then
    raise exception 'Unknown Scout archive import.';
  end if;
  if v_import.status <> 'staging' then
    raise exception 'Scout archive shard ingest is allowed only while the immutable import is staging.';
  end if;

  select * into v_existing
  from public.nba_scout_archive_shards
  where archive_import_id = p_archive_import_id and team_id = v_team_id
  for update;
  if found then
    if v_existing.team_name <> v_team_name
       or v_existing.gzip_relative_path <> v_gzip_relative_path
       or v_existing.gzip_sha256 <> v_gzip_sha256
       or v_existing.gzip_bytes <> v_gzip_bytes
       or v_existing.json_sha256 <> v_json_sha256
       or v_existing.json_bytes <> v_json_bytes
       or v_existing.payload_sha256 <> v_payload_sha256
       or v_existing.team_row_count <> v_team_rows
       or v_existing.lineup_row_count <> v_lineup_rows
       or v_existing.player_on_off_row_count <> v_on_off_rows
       or v_existing.player_profile_row_count <> v_profile_rows
       or v_existing.wowy_row_count <> v_wowy_rows
    then
      raise exception 'Existing Scout shard has conflicting immutable metadata.';
    end if;
    return jsonb_build_object(
      'archiveImportId', p_archive_import_id,
      'teamId', v_team_id,
      'mode', 'already-ingested',
      'counts', jsonb_build_object(
        'teamContexts', v_team_context_rows,
        'lineups', v_lineup_rows,
        'playerOnOff', v_on_off_rows,
        'playerOnOffContexts', v_on_off_context_rows,
        'playerProfiles', v_profile_rows,
        'wowy', v_wowy_rows
      )
    );
  end if;

  select count(*) into v_invalid
  from jsonb_to_recordset(p_payload -> 'team_contexts') as rows(
    context_key text,
    metrics jsonb,
    total_possessions numeric,
    net_rating numeric,
    offensive_rating numeric,
    defensive_rating numeric
  )
  where trim(coalesce(rows.context_key, '')) = ''
     or rows.context_key <> lower(trim(rows.context_key))
     or coalesce(jsonb_typeof(rows.metrics), '') <> 'object';
  if v_invalid > 0 then
    raise exception 'Scout shard contains an invalid team-context row.';
  end if;

  select count(*) into v_invalid
  from jsonb_to_recordset(p_payload -> 'lineups') as rows(
    player_ids uuid[],
    player_names text[],
    player_count smallint,
    semantics text,
    minutes numeric,
    exposure jsonb,
    continuity jsonb,
    projection jsonb,
    metrics jsonb,
    total_possessions numeric,
    net_rating numeric,
    offensive_rating numeric,
    defensive_rating numeric
  )
  where rows.player_ids is null
     or rows.player_names is null
     or rows.player_count not between 1 and 5
     or cardinality(rows.player_ids) <> rows.player_count
     or cardinality(rows.player_names) <> rows.player_count
     or cardinality(rows.player_ids) <> (
       select count(distinct player_id) from unnest(rows.player_ids) as members(player_id)
     )
     or rows.player_ids <> (
       select array_agg(player_id order by player_id) from unnest(rows.player_ids) as members(player_id)
     )
     or exists (
       select 1 from unnest(rows.player_names) as names(player_name)
       where trim(coalesce(names.player_name, '')) = ''
     )
     or trim(coalesce(rows.semantics, '')) = ''
     or coalesce(jsonb_typeof(rows.exposure), '') <> 'object'
     or coalesce(jsonb_typeof(rows.continuity), '') <> 'object'
     or coalesce(jsonb_typeof(rows.projection), '') <> 'object'
     or coalesce(jsonb_typeof(rows.metrics), '') <> 'object';
  if v_invalid > 0 then
    raise exception 'Scout shard contains an invalid lineup/co-presence row.';
  end if;

  with rows as (
    select * from jsonb_to_recordset(p_payload -> 'player_on_off') as values(
      player_id uuid,
      player_name text,
      on_minutes numeric,
      off_minutes numeric,
      on_off_net_rating numeric,
      exposure jsonb,
      scope jsonb,
      differences jsonb
    )
  )
  select count(*) into v_invalid
  from rows
  where player_id is null
     or trim(coalesce(player_name, '')) = ''
     or coalesce(jsonb_typeof(exposure), '') <> 'object'
     or coalesce(jsonb_typeof(scope), '') <> 'object'
     or coalesce(jsonb_typeof(differences), '') <> 'object';
  if v_invalid > 0 then
    raise exception 'Scout shard contains an invalid player on/off summary.';
  end if;
  with rows as (
    select player_id from jsonb_to_recordset(p_payload -> 'player_on_off') as values(player_id uuid)
  )
  select count(*) - count(distinct player_id) into v_invalid from rows;
  if v_invalid > 0 then
    raise exception 'Scout shard repeats a player on/off identity.';
  end if;

  with on_off as (
    select player_id from jsonb_to_recordset(p_payload -> 'player_on_off') as values(player_id uuid)
  ), contexts as (
    select * from jsonb_to_recordset(p_payload -> 'player_on_off_contexts') as values(
      player_id uuid,
      partition text,
      context_key text,
      metrics jsonb,
      total_possessions numeric,
      net_rating numeric,
      offensive_rating numeric,
      defensive_rating numeric
    )
  )
  select count(*) into v_invalid
  from contexts
  where player_id is null
     or partition not in ('on', 'off')
     or trim(coalesce(context_key, '')) = ''
     or context_key <> lower(trim(context_key))
     or coalesce(jsonb_typeof(metrics), '') <> 'object'
     or not exists (select 1 from on_off where on_off.player_id = contexts.player_id);
  if v_invalid > 0 then
    raise exception 'Scout shard contains an invalid player on/off context.';
  end if;

  with on_off as (
    select player_id from jsonb_to_recordset(p_payload -> 'player_on_off') as values(player_id uuid)
  ), profiles as (
    select * from jsonb_to_recordset(p_payload -> 'player_profiles') as values(
      player_id uuid,
      player_name text,
      games_appeared integer,
      minutes numeric,
      profile jsonb
    )
  )
  select count(*) into v_invalid
  from profiles
  where player_id is null
     or trim(coalesce(player_name, '')) = ''
     or coalesce(jsonb_typeof(profile), '') <> 'object'
     or not exists (select 1 from on_off where on_off.player_id = profiles.player_id);
  if v_invalid > 0 then
    raise exception 'Scout shard contains an invalid player profile.';
  end if;

  select count(*) into v_invalid
  from jsonb_to_recordset(p_payload -> 'wowy') as rows(
    player_a_id uuid,
    player_a_name text,
    player_b_id uuid,
    player_b_name text,
    semantics text,
    cell_metrics jsonb
  )
  where player_a_id is null
     or player_b_id is null
     or player_a_id >= player_b_id
     or trim(coalesce(player_a_name, '')) = ''
     or trim(coalesce(player_b_name, '')) = ''
     or trim(coalesce(semantics, '')) = ''
     or coalesce(jsonb_typeof(cell_metrics), '') <> 'object';
  if v_invalid > 0 then
    raise exception 'Scout shard contains an invalid canonical WOWY row.';
  end if;

  insert into public.nba_scout_archive_shards (
    archive_import_id, team_id, team_name, gzip_relative_path, gzip_sha256,
    gzip_bytes, json_sha256, json_bytes, payload_sha256, team_row_count, lineup_row_count,
    player_on_off_row_count, player_profile_row_count, wowy_row_count
  ) values (
    p_archive_import_id, v_team_id, v_team_name, v_gzip_relative_path, v_gzip_sha256,
    v_gzip_bytes, v_json_sha256, v_json_bytes, v_payload_sha256, v_team_rows, v_lineup_rows,
    v_on_off_rows, v_profile_rows, v_wowy_rows
  );

  insert into public.nba_scout_team_context_metrics (
    archive_import_id, team_id, context_key, metrics, total_possessions,
    net_rating, offensive_rating, defensive_rating
  )
  select p_archive_import_id, v_team_id, rows.context_key, rows.metrics,
    rows.total_possessions, rows.net_rating, rows.offensive_rating, rows.defensive_rating
  from jsonb_to_recordset(p_payload -> 'team_contexts') as rows(
    context_key text,
    metrics jsonb,
    total_possessions numeric,
    net_rating numeric,
    offensive_rating numeric,
    defensive_rating numeric
  );

  insert into public.nba_scout_lineup_summaries (
    archive_import_id, team_id, team_name, player_ids, player_names, player_count,
    semantics, minutes, exposure, continuity, projection, metrics, total_possessions,
    net_rating, offensive_rating, defensive_rating
  )
  select p_archive_import_id, v_team_id, v_team_name, rows.player_ids, rows.player_names,
    rows.player_count, rows.semantics, rows.minutes, rows.exposure, rows.continuity,
    rows.projection, rows.metrics, rows.total_possessions, rows.net_rating,
    rows.offensive_rating, rows.defensive_rating
  from jsonb_to_recordset(p_payload -> 'lineups') as rows(
    player_ids uuid[],
    player_names text[],
    player_count smallint,
    semantics text,
    minutes numeric,
    exposure jsonb,
    continuity jsonb,
    projection jsonb,
    metrics jsonb,
    total_possessions numeric,
    net_rating numeric,
    offensive_rating numeric,
    defensive_rating numeric
  );

  insert into public.nba_scout_player_on_off_summaries (
    archive_import_id, team_id, team_name, player_id, player_name, on_minutes,
    off_minutes, on_off_net_rating, exposure, scope, differences
  )
  select p_archive_import_id, v_team_id, v_team_name, rows.player_id, rows.player_name,
    rows.on_minutes, rows.off_minutes, rows.on_off_net_rating, rows.exposure,
    rows.scope, rows.differences
  from jsonb_to_recordset(p_payload -> 'player_on_off') as rows(
    player_id uuid,
    player_name text,
    on_minutes numeric,
    off_minutes numeric,
    on_off_net_rating numeric,
    exposure jsonb,
    scope jsonb,
    differences jsonb
  );

  insert into public.nba_scout_player_on_off_context_metrics (
    archive_import_id, team_id, player_id, partition, context_key, metrics,
    total_possessions, net_rating, offensive_rating, defensive_rating
  )
  select p_archive_import_id, v_team_id, rows.player_id, rows.partition,
    rows.context_key, rows.metrics, rows.total_possessions, rows.net_rating,
    rows.offensive_rating, rows.defensive_rating
  from jsonb_to_recordset(p_payload -> 'player_on_off_contexts') as rows(
    player_id uuid,
    partition text,
    context_key text,
    metrics jsonb,
    total_possessions numeric,
    net_rating numeric,
    offensive_rating numeric,
    defensive_rating numeric
  );

  insert into public.nba_scout_player_profiles (
    archive_import_id, team_id, team_name, player_id, player_name, games_appeared,
    minutes, profile
  )
  select p_archive_import_id, v_team_id, v_team_name, rows.player_id, rows.player_name,
    rows.games_appeared, rows.minutes, rows.profile
  from jsonb_to_recordset(p_payload -> 'player_profiles') as rows(
    player_id uuid,
    player_name text,
    games_appeared integer,
    minutes numeric,
    profile jsonb
  );

  insert into public.nba_scout_wowy_summaries (
    archive_import_id, team_id, team_name, player_a_id, player_a_name, player_b_id,
    player_b_name, semantics, cell_metrics
  )
  select p_archive_import_id, v_team_id, v_team_name, rows.player_a_id,
    rows.player_a_name, rows.player_b_id, rows.player_b_name, rows.semantics,
    rows.cell_metrics
  from jsonb_to_recordset(p_payload -> 'wowy') as rows(
    player_a_id uuid,
    player_a_name text,
    player_b_id uuid,
    player_b_name text,
    semantics text,
    cell_metrics jsonb
  );

  return jsonb_build_object(
    'archiveImportId', p_archive_import_id,
    'teamId', v_team_id,
    'mode', 'ingested',
    'counts', jsonb_build_object(
      'teamContexts', v_team_context_rows,
      'lineups', v_lineup_rows,
      'playerOnOff', v_on_off_rows,
      'playerOnOffContexts', v_on_off_context_rows,
      'playerProfiles', v_profile_rows,
      'wowy', v_wowy_rows
    )
  );
end;
$$;

create or replace function public.ingest_nba_scout_rapm(
  p_archive_import_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_model_count integer;
  v_player_count integer;
  v_existing_model_count integer;
  v_existing_player_count integer;
  v_invalid integer;
  v_payload_sha256 text;
begin
  if p_archive_import_id is null or jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(p_payload -> 'models') <> 'array'
     or jsonb_typeof(p_payload -> 'players') <> 'array'
  then
    raise exception 'Scout RAPM ingest requires an import ID plus models and players arrays.';
  end if;
  v_model_count := jsonb_array_length(p_payload -> 'models');
  v_player_count := jsonb_array_length(p_payload -> 'players');
  if v_model_count <> 2 or v_player_count < 1 then
    raise exception 'Scout RAPM ingest requires exactly two models and at least one player row.';
  end if;
  v_payload_sha256 := encode(extensions.digest(p_payload::text, 'sha256'), 'hex');

  select * into v_import
  from public.nba_scout_archive_imports
  where id = p_archive_import_id
  for update;
  if not found then
    raise exception 'Unknown Scout archive import.';
  end if;
  if v_import.status <> 'staging' then
    raise exception 'Scout RAPM ingest is allowed only while the immutable import is staging.';
  end if;

  select count(*) into v_existing_model_count
  from public.nba_scout_rapm_models
  where archive_import_id = p_archive_import_id;
  select count(*) into v_existing_player_count
  from public.nba_scout_rapm_players
  where archive_import_id = p_archive_import_id;
  if v_existing_model_count > 0 or v_existing_player_count > 0 then
    if v_existing_model_count = v_model_count and v_existing_player_count = v_player_count then
      select count(*) into v_invalid
      from public.nba_scout_rapm_models
      where archive_import_id = p_archive_import_id and payload_sha256 <> v_payload_sha256;
      if v_invalid = 0 then
        return jsonb_build_object('archiveImportId', p_archive_import_id, 'mode', 'already-ingested', 'playerCount', v_player_count);
      end if;
    end if;
    raise exception 'Existing Scout RAPM rows are incomplete or conflict with this immutable import.';
  end if;

  select count(*) into v_invalid
  from jsonb_to_recordset(p_payload -> 'models') as rows(
    model_kind text,
    model_metadata jsonb
  )
  where model_kind not in ('net', 'offense_defense')
     or coalesce(jsonb_typeof(model_metadata), '') <> 'object';
  if v_invalid > 0 then
    raise exception 'Scout RAPM models are invalid.';
  end if;
  select count(*) - count(distinct model_kind) into v_invalid
  from jsonb_to_recordset(p_payload -> 'models') as rows(model_kind text);
  if v_invalid > 0 then
    raise exception 'Scout RAPM model kinds must be unique.';
  end if;

  select count(*) into v_invalid
  from jsonb_to_recordset(p_payload -> 'players') as rows(
    model_kind text,
    player_id uuid,
    player_name text,
    rapm_per_100 numeric,
    offensive_rapm_per_100 numeric,
    defensive_rapm_per_100 numeric,
    paired_possessions numeric,
    display_eligible boolean,
    metrics jsonb
  )
  where model_kind not in ('net', 'offense_defense')
     or player_id is null
     or trim(coalesce(player_name, '')) = ''
     or coalesce(jsonb_typeof(metrics), '') <> 'object';
  if v_invalid > 0 then
    raise exception 'Scout RAPM player rows are invalid.';
  end if;
  select count(*) - count(distinct (model_kind, player_id)) into v_invalid
  from jsonb_to_recordset(p_payload -> 'players') as rows(model_kind text, player_id uuid);
  if v_invalid > 0 then
    raise exception 'Scout RAPM player identities must be unique within each model.';
  end if;

  insert into public.nba_scout_rapm_models (archive_import_id, model_kind, payload_sha256, model_metadata)
  select p_archive_import_id, rows.model_kind, v_payload_sha256, rows.model_metadata
  from jsonb_to_recordset(p_payload -> 'models') as rows(model_kind text, model_metadata jsonb);

  insert into public.nba_scout_rapm_players (
    archive_import_id, model_kind, player_id, player_name, rapm_per_100,
    offensive_rapm_per_100, defensive_rapm_per_100, paired_possessions,
    display_eligible, metrics
  )
  select p_archive_import_id, rows.model_kind, rows.player_id, rows.player_name,
    rows.rapm_per_100, rows.offensive_rapm_per_100, rows.defensive_rapm_per_100,
    rows.paired_possessions, coalesce(rows.display_eligible, false), rows.metrics
  from jsonb_to_recordset(p_payload -> 'players') as rows(
    model_kind text,
    player_id uuid,
    player_name text,
    rapm_per_100 numeric,
    offensive_rapm_per_100 numeric,
    defensive_rapm_per_100 numeric,
    paired_possessions numeric,
    display_eligible boolean,
    metrics jsonb
  );

  return jsonb_build_object('archiveImportId', p_archive_import_id, 'mode', 'ingested', 'modelCount', v_model_count, 'playerCount', v_player_count);
end;
$$;

create or replace function public.finalize_nba_scout_archive_import(p_archive_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_expected jsonb;
  v_actual integer;
  v_counts jsonb := '{}'::jsonb;
begin
  select * into v_import
  from public.nba_scout_archive_imports
  where id = p_archive_import_id
  for update;
  if not found then
    raise exception 'Unknown Scout archive import.';
  end if;
  if v_import.status = 'ready' then
    return jsonb_build_object('archiveImportId', v_import.id, 'status', 'ready', 'mode', 'already-ready');
  end if;

  v_expected := v_import.expected_row_counts;

  select count(*) into v_actual from public.nba_scout_archive_shards where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('teams', v_actual);
  if v_actual <> (v_expected ->> 'teams')::integer then
    raise exception 'Scout archive cannot finalize: expected % team shards, found %.', v_expected ->> 'teams', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_lineup_summaries where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('lineups', v_actual);
  if v_actual <> (v_expected ->> 'lineups')::integer then
    raise exception 'Scout archive cannot finalize: expected % lineup summaries, found %.', v_expected ->> 'lineups', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_player_on_off_summaries where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('playerOnOff', v_actual);
  if v_actual <> (v_expected ->> 'playerOnOff')::integer then
    raise exception 'Scout archive cannot finalize: expected % player on/off summaries, found %.', v_expected ->> 'playerOnOff', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_player_profiles where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('playerProfiles', v_actual);
  if v_actual <> (v_expected ->> 'playerProfiles')::integer then
    raise exception 'Scout archive cannot finalize: expected % player profiles, found %.', v_expected ->> 'playerProfiles', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_wowy_summaries where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('wowy', v_actual);
  if v_actual <> (v_expected ->> 'wowy')::integer then
    raise exception 'Scout archive cannot finalize: expected % WOWY summaries, found %.', v_expected ->> 'wowy', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_rapm_models where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('rapmModels', v_actual);
  if v_actual <> (v_expected ->> 'rapmModels')::integer then
    raise exception 'Scout archive cannot finalize: expected % RAPM models, found %.', v_expected ->> 'rapmModels', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_rapm_players where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('rapmPlayers', v_actual);
  if v_actual <> (v_expected ->> 'rapmPlayers')::integer then
    raise exception 'Scout archive cannot finalize: expected % RAPM players, found %.', v_expected ->> 'rapmPlayers', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_team_context_metrics where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('teamContexts', v_actual);
  if v_actual <> (v_expected ->> 'teamContexts')::integer then
    raise exception 'Scout archive cannot finalize: expected % team contexts, found %.', v_expected ->> 'teamContexts', v_actual;
  end if;

  select count(*) into v_actual from public.nba_scout_player_on_off_context_metrics where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('playerOnOffContexts', v_actual);
  if v_actual <> (v_expected ->> 'playerOnOffContexts')::integer then
    raise exception 'Scout archive cannot finalize: expected % player on/off contexts, found %.', v_expected ->> 'playerOnOffContexts', v_actual;
  end if;

  update public.nba_scout_archive_imports
  set status = 'ready', completed_at = now()
  where id = v_import.id;

  return jsonb_build_object('archiveImportId', v_import.id, 'status', 'ready', 'counts', v_counts);
end;
$$;

create or replace function public.nba_scout_archive_descriptor(p_archive_import_id uuid)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'manifestSha256', imports.manifest_sha256,
    'schemaVersion', imports.schema_version,
    'metricsVersion', imports.metrics_version,
    'provider', imports.provider,
    'seasonStartYear', imports.season_start_year,
    'seasonEndYear', imports.season_end_year,
    'sourceValidationPassed', imports.source_validation_passed,
    'expectedRows', imports.expected_row_counts,
    'completedAt', imports.completed_at
  )
  from public.nba_scout_archive_imports as imports
  where imports.id = p_archive_import_id;
$$;

create or replace function public.get_nba_scout_archive_overview(p_season_end_year smallint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
begin
  select id into v_archive_id
  from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;
  if v_archive_id is null then
    raise exception 'No ready private Scout archive is available for season ending %.', p_season_end_year;
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive_id),
    'lineupContextAvailability', 'all only',
    'wowyContextAvailability', 'all only',
    'teamAndPlayerContextAvailability', 'all imported source contexts'
  );
end;
$$;

create or replace function public.get_nba_scout_team_context_analytics(
  p_season_end_year smallint,
  p_team_id uuid,
  p_context_key text default 'all'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
  v_metrics jsonb;
  v_context_key text := lower(trim(coalesce(p_context_key, 'all')));
begin
  select id into v_archive_id
  from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;
  if v_archive_id is null then
    raise exception 'No ready private Scout archive is available for season ending %.', p_season_end_year;
  end if;
  select metrics into v_metrics
  from public.nba_scout_team_context_metrics
  where archive_import_id = v_archive_id and team_id = p_team_id and context_key = v_context_key;
  if v_metrics is null then
    raise exception 'Scout team context is unavailable for the requested team/context.';
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive_id),
    'teamId', p_team_id,
    'context', v_context_key,
    'metrics', v_metrics
  );
end;
$$;

create or replace function public.get_nba_scout_lineup_analytics(
  p_season_end_year smallint,
  p_team_id uuid,
  p_player_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
  v_player_ids uuid[];
  v_distinct_count integer;
  v_row public.nba_scout_lineup_summaries%rowtype;
begin
  if cardinality(p_player_ids) is null or cardinality(p_player_ids) not between 1 and 5 then
    raise exception 'Choose from one through five provider player IDs.';
  end if;
  select count(distinct player_id), array_agg(player_id order by player_id)
  into v_distinct_count, v_player_ids
  from unnest(p_player_ids) as input(player_id);
  if v_distinct_count <> cardinality(p_player_ids) then
    raise exception 'Provider player IDs must be distinct.';
  end if;

  select id into v_archive_id
  from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;
  if v_archive_id is null then
    raise exception 'No ready private Scout archive is available for season ending %.', p_season_end_year;
  end if;
  select * into v_row
  from public.nba_scout_lineup_summaries
  where archive_import_id = v_archive_id and team_id = p_team_id and player_ids = v_player_ids;
  if not found then
    raise exception 'Scout lineup/co-presence summary is unavailable for the requested player set.';
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive_id),
    'context', 'all',
    'semantics', v_row.semantics,
    'teamId', v_row.team_id,
    'playerIds', v_row.player_ids,
    'playerNames', v_row.player_names,
    'minutes', v_row.minutes,
    'exposure', v_row.exposure,
    'continuity', v_row.continuity,
    'projection', v_row.projection,
    'metrics', v_row.metrics
  );
end;
$$;

create or replace function public.get_nba_scout_player_analytics(
  p_season_end_year smallint,
  p_team_id uuid,
  p_player_id uuid,
  p_context_key text default 'all'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
  v_context_key text := lower(trim(coalesce(p_context_key, 'all')));
  v_summary public.nba_scout_player_on_off_summaries%rowtype;
  v_profile jsonb;
  v_on_metrics jsonb;
  v_off_metrics jsonb;
begin
  select id into v_archive_id
  from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;
  if v_archive_id is null then
    raise exception 'No ready private Scout archive is available for season ending %.', p_season_end_year;
  end if;
  select * into v_summary
  from public.nba_scout_player_on_off_summaries
  where archive_import_id = v_archive_id and team_id = p_team_id and player_id = p_player_id;
  if not found then
    raise exception 'Scout player summary is unavailable for the requested player/team.';
  end if;
  select profile into v_profile
  from public.nba_scout_player_profiles
  where archive_import_id = v_archive_id and team_id = p_team_id and player_id = p_player_id;
  select metrics into v_on_metrics
  from public.nba_scout_player_on_off_context_metrics
  where archive_import_id = v_archive_id and team_id = p_team_id and player_id = p_player_id
    and partition = 'on' and context_key = v_context_key;
  select metrics into v_off_metrics
  from public.nba_scout_player_on_off_context_metrics
  where archive_import_id = v_archive_id and team_id = p_team_id and player_id = p_player_id
    and partition = 'off' and context_key = v_context_key;
  if v_on_metrics is null or v_off_metrics is null then
    raise exception 'Scout player context is unavailable for the requested context.';
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive_id),
    'teamId', p_team_id,
    'playerId', p_player_id,
    'playerName', v_summary.player_name,
    'context', v_context_key,
    'profile', coalesce(v_profile, '{}'::jsonb),
    'on', v_on_metrics,
    'off', v_off_metrics,
    'differences', v_summary.differences,
    'exposure', v_summary.exposure,
    'scope', v_summary.scope
  );
end;
$$;

create or replace function public.get_nba_scout_wowy(
  p_season_end_year smallint,
  p_team_id uuid,
  p_player_a_id uuid,
  p_player_b_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
  v_pair uuid[];
  v_row public.nba_scout_wowy_summaries%rowtype;
begin
  if p_player_a_id = p_player_b_id then
    raise exception 'WOWY requires two distinct provider player IDs.';
  end if;
  select array_agg(player_id order by player_id) into v_pair
  from unnest(array[p_player_a_id, p_player_b_id]) as input(player_id);
  select id into v_archive_id
  from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;
  if v_archive_id is null then
    raise exception 'No ready private Scout archive is available for season ending %.', p_season_end_year;
  end if;
  select * into v_row
  from public.nba_scout_wowy_summaries
  where archive_import_id = v_archive_id and team_id = p_team_id
    and player_a_id = v_pair[1] and player_b_id = v_pair[2];
  if not found then
    raise exception 'Scout WOWY summary is unavailable for the requested pair/team.';
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive_id),
    'context', 'all',
    'semantics', v_row.semantics,
    'teamId', v_row.team_id,
    'playerAId', v_row.player_a_id,
    'playerAName', v_row.player_a_name,
    'playerBId', v_row.player_b_id,
    'playerBName', v_row.player_b_name,
    'cells', v_row.cell_metrics
  );
end;
$$;

create or replace function public.get_nba_scout_rapm(
  p_season_end_year smallint,
  p_model_kind text default 'net',
  p_player_id uuid default null,
  p_limit integer default 250
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_archive_id uuid;
  v_model_kind text := lower(trim(coalesce(p_model_kind, 'net')));
begin
  if v_model_kind not in ('net', 'offense_defense') then
    raise exception 'Scout RAPM model kind must be net or offense_defense.';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'Scout RAPM limit must be from 1 through 1000.';
  end if;
  select id into v_archive_id
  from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
  order by completed_at desc nulls last, created_at desc, id desc
  limit 1;
  if v_archive_id is null then
    raise exception 'No ready private Scout archive is available for season ending %.', p_season_end_year;
  end if;
  return jsonb_build_object(
    'schemaVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive_id),
    'modelKind', v_model_kind,
    'model', coalesce((
      select model_metadata
      from public.nba_scout_rapm_models
      where archive_import_id = v_archive_id and model_kind = v_model_kind
    ), '{}'::jsonb),
    'players', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'providerPlayerId', players.player_id,
          'playerName', players.player_name,
          'rapmPer100', players.rapm_per_100,
          'offensiveRapmPer100', players.offensive_rapm_per_100,
          'defensiveRapmPer100', players.defensive_rapm_per_100,
          'pairedPossessions', players.paired_possessions,
          'displayEligible', players.display_eligible,
          'metrics', players.metrics
        )
        order by players.rapm_per_100 desc nulls last, players.player_name, players.player_id
      )
      from (
        select *
        from public.nba_scout_rapm_players
        where archive_import_id = v_archive_id and model_kind = v_model_kind
          and (p_player_id is null or player_id = p_player_id)
        order by rapm_per_100 desc nulls last, player_name, player_id
        limit p_limit
      ) as players
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.begin_nba_scout_archive_import(jsonb) from public, anon, authenticated;
revoke all on function public.nba_scout_compact_jsonb_is_safe(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.ingest_nba_scout_archive_shard(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_nba_scout_rapm(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.finalize_nba_scout_archive_import(uuid) from public, anon, authenticated;
revoke all on function public.nba_scout_archive_descriptor(uuid) from public, anon, authenticated;
revoke all on function public.get_nba_scout_archive_overview(smallint) from public, anon, authenticated;
revoke all on function public.get_nba_scout_team_context_analytics(smallint, uuid, text) from public, anon, authenticated;
revoke all on function public.get_nba_scout_lineup_analytics(smallint, uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.get_nba_scout_player_analytics(smallint, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.get_nba_scout_wowy(smallint, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_nba_scout_rapm(smallint, text, uuid, integer) from public, anon, authenticated;

grant execute on function public.begin_nba_scout_archive_import(jsonb) to service_role;
grant execute on function public.ingest_nba_scout_archive_shard(uuid, jsonb) to service_role;
grant execute on function public.ingest_nba_scout_rapm(uuid, jsonb) to service_role;
grant execute on function public.finalize_nba_scout_archive_import(uuid) to service_role;
grant execute on function public.nba_scout_archive_descriptor(uuid) to service_role;
grant execute on function public.get_nba_scout_archive_overview(smallint) to service_role;
grant execute on function public.get_nba_scout_team_context_analytics(smallint, uuid, text) to service_role;
grant execute on function public.get_nba_scout_lineup_analytics(smallint, uuid, uuid[]) to service_role;
grant execute on function public.get_nba_scout_player_analytics(smallint, uuid, uuid, text) to service_role;
grant execute on function public.get_nba_scout_wowy(smallint, uuid, uuid, uuid) to service_role;
grant execute on function public.get_nba_scout_rapm(smallint, text, uuid, integer) to service_role;

comment on table public.nba_scout_archive_imports is
  'Private immutable manifest/provenance registry for compact Scout query indexes; archive object locations stay private.';
comment on table public.nba_scout_lineup_summaries is
  'Private all-context Scout lineup/co-presence summaries. Five-player rows are exact possession-start lineups; two-to-four are shared-floor co-presence.';
comment on table public.nba_scout_wowy_summaries is
  'Private all-context WOWY summaries. Full source contexts remain only in the immutable private archive.';
comment on function public.ingest_nba_scout_archive_shard(uuid, jsonb) is
  'Private atomic one-team ingestion of compact derived Scout summaries. It rejects raw PBP, archive conflicts, and browser callers.';
comment on function public.ingest_nba_scout_rapm(uuid, jsonb) is
  'Private atomic ingestion of the two compact derived Scout RAPM models and their player rows.';
comment on function public.get_nba_scout_lineup_analytics(smallint, uuid, uuid[]) is
  'Private service-role Scout lineup/co-presence query. It never returns raw PBP, archive paths, or full nested source contexts.';
