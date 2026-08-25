-- Sportradar NBA v8 play-by-play domain.
--
-- This is intentionally separate from the Basketball-Reference player-season
-- domain. It holds provider IDs, auditable game facts, exact five-player
-- on-court snapshots, and derived possessions/stints. Browser clients never
-- receive raw PBP or provider documents directly.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'nba-sportradar-raw',
  'nba-sportradar-raw',
  false,
  104857600,
  array['application/json', 'application/gzip']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- The dedicated analytics base deliberately has no general-purpose update
-- trigger because its initial historical copy preserves source timestamps.
-- PBP entities are independently mutable provider facts, so this migration
-- owns the narrowly scoped trigger helper it uses below.
create or replace function public.set_nba_records_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.nba_pbp_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null default 'sportradar_nba'
    check (source_name = 'sportradar_nba'),
  source_access_level text not null
    check (source_access_level in ('trial', 'production')),
  source_api_version text not null default 'v8',
  source_license_reference text not null
    check (length(trim(source_license_reference)) > 0),
  rights_confirmed boolean not null default false,
  requested_season_start smallint references public.nba_seasons(season_end_year),
  requested_season_end smallint references public.nba_seasons(season_end_year),
  requested_phase text not null default 'regular'
    check (requested_phase in ('preseason', 'regular', 'in_season_tournament', 'play_in', 'playoffs', 'mixed')),
  status text not null default 'planned'
    check (status in ('planned', 'running', 'completed', 'failed', 'cancelled')),
  games_discovered integer not null default 0 check (games_discovered >= 0),
  games_eligible integer not null default 0 check (games_eligible >= 0),
  games_ready integer not null default 0 check (games_ready >= 0),
  events_upserted integer not null default 0 check (events_upserted >= 0),
  stints_upserted integer not null default 0 check (stints_upserted >= 0),
  possessions_upserted integer not null default 0 check (possessions_upserted >= 0),
  error_summary text not null default '',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_pbp_import_runs_season_order check (
    requested_season_end is null
    or requested_season_start is null
    or requested_season_end >= requested_season_start
  ),
  constraint nba_pbp_import_runs_completed_requires_rights check (
    status <> 'completed' or rights_confirmed
  )
);

create table if not exists public.nba_provider_teams (
  id uuid primary key,
  source_name text not null default 'sportradar_nba'
    check (source_name = 'sportradar_nba'),
  sr_id text not null default '',
  reference text not null default '',
  alias text not null default '',
  market text not null default '',
  name text not null default '',
  country text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nba_provider_team_seasons (
  provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  season_end_year smallint not null references public.nba_seasons(season_end_year) on delete restrict,
  season_phase text not null
    check (season_phase in ('preseason', 'regular', 'in_season_tournament', 'play_in', 'playoffs')),
  provider_alias text not null default '',
  nba_team_season_id uuid references public.nba_team_seasons(id) on delete restrict,
  team_code text not null default ''
    check (team_code = '' or team_code ~ '^[A-Z0-9]{2,8}$'),
  resolution_state text not null default 'unresolved'
    check (resolution_state in ('unresolved', 'auto_exact', 'human_verified', 'rejected')),
  source_import_run_id uuid references public.nba_pbp_import_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (provider_team_id, season_end_year, season_phase),
  constraint nba_provider_team_seasons_verified_target check (
    resolution_state <> 'human_verified' or nba_team_season_id is not null
  )
);

create table if not exists public.nba_provider_players (
  id uuid primary key,
  source_name text not null default 'sportradar_nba'
    check (source_name = 'sportradar_nba'),
  sr_id text not null default '',
  reference text not null default '',
  full_name text not null default '',
  first_name text not null default '',
  last_name text not null default '',
  position text not null default '',
  jersey_number text not null default '',
  nba_player_id uuid references public.nba_players(id) on delete restrict,
  identity_resolution_state text not null default 'unresolved'
    check (identity_resolution_state in ('unresolved', 'external_id_verified', 'human_verified', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_provider_players_verified_target check (
    identity_resolution_state not in ('external_id_verified', 'human_verified')
    or nba_player_id is not null
  )
);

create table if not exists public.nba_games (
  id uuid primary key,
  source_name text not null default 'sportradar_nba'
    check (source_name = 'sportradar_nba'),
  reference text not null default '',
  sr_id text not null default '',
  season_end_year smallint not null references public.nba_seasons(season_end_year) on delete restrict,
  season_start_year smallint not null,
  season_phase text not null
    check (season_phase in ('preseason', 'regular', 'in_season_tournament', 'play_in', 'playoffs')),
  scheduled_at timestamptz,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'created', 'inprogress', 'halftime', 'complete', 'closed', 'cancelled', 'postponed')),
  coverage text not null default '',
  track_on_court boolean not null default false,
  home_provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  away_provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  home_team_season_id uuid references public.nba_team_seasons(id) on delete restrict,
  away_team_season_id uuid references public.nba_team_seasons(id) on delete restrict,
  home_points integer check (home_points is null or home_points >= 0),
  away_points integer check (away_points is null or away_points >= 0),
  provider_updated_at timestamptz,
  source_etag text not null default '',
  source_last_modified text not null default '',
  analytics_status text not null default 'not_requested'
    check (analytics_status in ('not_requested', 'pending', 'ready', 'partial', 'ineligible', 'failed')),
  analytics_error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_games_season_years_match check (season_start_year = season_end_year - 1),
  constraint nba_games_distinct_teams check (home_provider_team_id <> away_provider_team_id)
);

create table if not exists public.nba_pbp_source_documents (
  id uuid primary key default gen_random_uuid(),
  import_run_id uuid not null references public.nba_pbp_import_runs(id) on delete cascade,
  game_id uuid references public.nba_games(id) on delete cascade,
  source_resource text not null
    check (source_resource in ('schedule', 'summary', 'play_by_play', 'daily_changes')),
  source_resource_key text not null,
  source_url text not null check (length(trim(source_url)) > 0),
  storage_bucket text not null default 'nba-sportradar-raw'
    check (storage_bucket = 'nba-sportradar-raw'),
  storage_object_path text not null check (length(trim(storage_object_path)) > 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  content_bytes bigint not null check (content_bytes > 0),
  content_encoding text not null default 'gzip'
    check (content_encoding in ('identity', 'gzip')),
  source_etag text not null default '',
  source_last_modified text not null default '',
  source_generated_at timestamptz,
  received_at timestamptz not null default now(),
  unique (import_run_id, source_resource, source_resource_key, content_sha256)
);

create table if not exists public.nba_game_team_stats (
  game_id uuid not null references public.nba_games(id) on delete cascade,
  provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  possessions numeric(12, 3) check (possessions is null or possessions >= 0),
  opponent_possessions numeric(12, 3) check (opponent_possessions is null or opponent_possessions >= 0),
  offensive_rating numeric(12, 4),
  defensive_rating numeric(12, 4),
  points integer check (points is null or points >= 0),
  points_against integer check (points_against is null or points_against >= 0),
  fast_break_points integer check (fast_break_points is null or fast_break_points >= 0),
  source_document_id uuid references public.nba_pbp_source_documents(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (game_id, provider_team_id)
);

create table if not exists public.nba_game_player_stats (
  game_id uuid not null references public.nba_games(id) on delete cascade,
  provider_player_id uuid not null references public.nba_provider_players(id) on delete restrict,
  provider_team_id uuid references public.nba_provider_teams(id) on delete restrict,
  minutes_played numeric(12, 3) check (minutes_played is null or minutes_played >= 0),
  plus_minus integer,
  offensive_rating numeric(12, 4),
  defensive_rating numeric(12, 4),
  is_starter boolean,
  is_active boolean,
  is_on_court boolean,
  source_document_id uuid references public.nba_pbp_source_documents(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key (game_id, provider_player_id)
);

create table if not exists public.nba_pbp_events (
  id uuid primary key,
  game_id uuid not null references public.nba_games(id) on delete cascade,
  source_document_id uuid references public.nba_pbp_source_documents(id) on delete set null,
  period_sequence smallint not null check (period_sequence > 0),
  period_number smallint not null check (period_number > 0),
  period_type text not null default '',
  event_number integer,
  event_sequence bigint,
  clock_remaining_ms integer check (clock_remaining_ms is null or clock_remaining_ms >= 0),
  home_points_after integer check (home_points_after is null or home_points_after >= 0),
  away_points_after integer check (away_points_after is null or away_points_after >= 0),
  event_type text not null default '',
  attribution_team_id uuid references public.nba_provider_teams(id) on delete restrict,
  possession_team_id uuid references public.nba_provider_teams(id) on delete restrict,
  qualifiers jsonb not null default '[]'::jsonb
    check (jsonb_typeof(qualifiers) = 'array'),
  statistics jsonb not null default '[]'::jsonb
    check (jsonb_typeof(statistics) = 'array'),
  location jsonb not null default '{}'::jsonb
    check (jsonb_typeof(location) = 'object'),
  created_by_provider_at timestamptz,
  updated_by_provider_at timestamptz,
  wall_clock_at timestamptz,
  is_rescinded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (game_id, event_sequence, id)
);

create table if not exists public.nba_pbp_event_on_court (
  event_id uuid primary key references public.nba_pbp_events(id) on delete cascade,
  home_player_ids uuid[] not null default array[]::uuid[],
  away_player_ids uuid[] not null default array[]::uuid[],
  home_player_count smallint generated always as (cardinality(home_player_ids)) stored,
  away_player_count smallint generated always as (cardinality(away_player_ids)) stored,
  snapshot_status text not null default 'missing'
    check (snapshot_status in ('valid_five_on_five', 'missing', 'invalid_count', 'duplicate_player', 'cross_team_duplicate', 'unresolved_player')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_pbp_event_on_court_counts_match_status check (
    snapshot_status <> 'valid_five_on_five'
    or (cardinality(home_player_ids) = 5 and cardinality(away_player_ids) = 5)
  )
);

create table if not exists public.nba_lineup_definitions (
  id uuid primary key,
  provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  lineup_key text not null check (length(trim(lineup_key)) > 0),
  player_ids uuid[] not null,
  player_count smallint generated always as (cardinality(player_ids)) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_team_id, lineup_key),
  constraint nba_lineup_definitions_exact_five check (cardinality(player_ids) = 5)
);

create table if not exists public.nba_lineup_members (
  lineup_id uuid not null references public.nba_lineup_definitions(id) on delete cascade,
  provider_player_id uuid not null references public.nba_provider_players(id) on delete restrict,
  member_order smallint not null check (member_order between 1 and 5),
  primary key (lineup_id, provider_player_id),
  unique (lineup_id, member_order)
);

create table if not exists public.nba_lineup_analytics_builds (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.nba_games(id) on delete cascade,
  import_run_id uuid not null references public.nba_pbp_import_runs(id) on delete restrict,
  source_document_id uuid references public.nba_pbp_source_documents(id) on delete set null,
  method_version text not null check (length(trim(method_version)) > 0),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'running'
    check (status in ('running', 'completed', 'partial', 'failed', 'superseded')),
  coverage_status text not null default 'unknown'
    check (coverage_status in ('unknown', 'eligible', 'ineligible', 'partial')),
  event_count integer not null default 0 check (event_count >= 0),
  valid_snapshot_count integer not null default 0 check (valid_snapshot_count >= 0),
  invalid_snapshot_count integer not null default 0 check (invalid_snapshot_count >= 0),
  error_summary text not null default '',
  final_score_verified boolean not null default false,
  possession_totals_verified boolean not null default false,
  player_minutes_verified boolean not null default false,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (game_id, input_sha256, method_version)
);

create table if not exists public.nba_game_lineup_stints (
  id bigint generated always as identity primary key,
  build_id uuid not null references public.nba_lineup_analytics_builds(id) on delete cascade,
  game_id uuid not null references public.nba_games(id) on delete cascade,
  stint_ordinal integer not null check (stint_ordinal > 0),
  home_lineup_id uuid references public.nba_lineup_definitions(id) on delete restrict,
  away_lineup_id uuid references public.nba_lineup_definitions(id) on delete restrict,
  start_event_id uuid references public.nba_pbp_events(id) on delete set null,
  end_event_id uuid references public.nba_pbp_events(id) on delete set null,
  start_elapsed_ms integer not null check (start_elapsed_ms >= 0),
  end_elapsed_ms integer not null check (end_elapsed_ms >= start_elapsed_ms),
  duration_ms integer not null check (duration_ms >= 0),
  home_points integer not null default 0 check (home_points >= 0),
  away_points integer not null default 0 check (away_points >= 0),
  home_offensive_possessions numeric(12, 3) not null default 0 check (home_offensive_possessions >= 0),
  away_offensive_possessions numeric(12, 3) not null default 0 check (away_offensive_possessions >= 0),
  quality_flags text[] not null default array[]::text[],
  unique (build_id, stint_ordinal)
);

create table if not exists public.nba_game_possessions (
  id uuid primary key,
  build_id uuid not null references public.nba_lineup_analytics_builds(id) on delete cascade,
  game_id uuid not null references public.nba_games(id) on delete cascade,
  source_possession_id text not null check (length(trim(source_possession_id)) > 0),
  possession_ordinal integer not null check (possession_ordinal > 0),
  offense_provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  defense_provider_team_id uuid not null references public.nba_provider_teams(id) on delete restrict,
  home_lineup_id uuid references public.nba_lineup_definitions(id) on delete restrict,
  away_lineup_id uuid references public.nba_lineup_definitions(id) on delete restrict,
  start_event_id uuid references public.nba_pbp_events(id) on delete set null,
  terminal_event_id uuid references public.nba_pbp_events(id) on delete set null,
  period_sequence smallint not null check (period_sequence > 0),
  clock_remaining_ms integer check (clock_remaining_ms is null or clock_remaining_ms >= 0),
  home_points_before integer not null check (home_points_before >= 0),
  away_points_before integer not null check (away_points_before >= 0),
  offense_points integer not null default 0 check (offense_points >= 0),
  defense_points integer not null default 0 check (defense_points >= 0),
  is_clutch_v1 boolean not null default false,
  home_score_state_v1 text not null default 'tied'
    check (home_score_state_v1 in (
      'tied',
      'ahead_1_5',
      'ahead_6_10',
      'ahead_11_15',
      'ahead_16_plus',
      'trailing_1_5',
      'trailing_6_10',
      'trailing_11_15',
      'trailing_16_plus'
    )),
  transition_context text not null default 'unclassified'
    check (transition_context in ('provider_fastbreak_v1', 'non_provider_fastbreak', 'unclassified', 'half_court_heuristic_v1')),
  transition_source text not null default 'unavailable'
    check (transition_source in ('provider_qualifier', 'heuristic', 'unavailable')),
  has_lineup_change_mid_possession boolean not null default false,
  possession_source text not null default 'provider_post_event_state'
    check (possession_source in ('provider_post_event_state', 'inferred_staging_only')),
  quality_flags text[] not null default array[]::text[],
  unique (build_id, source_possession_id),
  constraint nba_game_possessions_distinct_teams check (offense_provider_team_id <> defense_provider_team_id)
);

create table if not exists public.nba_adjusted_model_runs (
  id uuid primary key default gen_random_uuid(),
  model_type text not null default 'ridge_rapm'
    check (model_type = 'ridge_rapm'),
  method_version text not null check (length(trim(method_version)) > 0),
  season_end_year smallint not null references public.nba_seasons(season_end_year) on delete restrict,
  season_phase text not null
    check (season_phase in ('regular', 'playoffs')),
  ridge_lambda numeric(18, 8) not null check (ridge_lambda > 0),
  observation_count integer not null default 0 check (observation_count >= 0),
  game_count integer not null default 0 check (game_count >= 0),
  excluded_observation_count integer not null default 0 check (excluded_observation_count >= 0),
  input_sha256 text not null check (input_sha256 ~ '^[a-f0-9]{64}$'),
  code_version text not null check (length(trim(code_version)) > 0),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'superseded')),
  error_summary text not null default '',
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (model_type, method_version, season_end_year, season_phase, input_sha256)
);

create table if not exists public.nba_player_adjusted_impacts (
  model_run_id uuid not null references public.nba_adjusted_model_runs(id) on delete cascade,
  provider_player_id uuid not null references public.nba_provider_players(id) on delete restrict,
  rapm_per_100 numeric(18, 8) not null,
  exposure_possessions numeric(18, 3) not null default 0 check (exposure_possessions >= 0),
  observation_count integer not null default 0 check (observation_count >= 0),
  teammate_rapm_context_per_100 numeric(18, 8),
  opponent_rapm_context_per_100 numeric(18, 8),
  display_eligible boolean not null default false,
  primary key (model_run_id, provider_player_id)
);

create index if not exists nba_provider_team_seasons_lookup_idx
  on public.nba_provider_team_seasons (season_end_year, season_phase, team_code);
create index if not exists nba_provider_players_nba_player_idx
  on public.nba_provider_players (nba_player_id)
  where nba_player_id is not null;
create index if not exists nba_games_schedule_idx
  on public.nba_games (season_end_year, season_phase, status, scheduled_at);
create index if not exists nba_games_analytics_idx
  on public.nba_games (analytics_status, season_end_year, season_phase);
create index if not exists nba_pbp_source_documents_game_idx
  on public.nba_pbp_source_documents (game_id, source_resource, received_at desc);
create index if not exists nba_pbp_events_game_order_idx
  on public.nba_pbp_events (game_id, period_sequence, event_sequence, event_number);
create index if not exists nba_pbp_events_game_updated_idx
  on public.nba_pbp_events (game_id, updated_by_provider_at desc);
create index if not exists nba_lineup_definitions_team_members_idx
  on public.nba_lineup_definitions using gin (player_ids);
create index if not exists nba_game_lineup_stints_game_build_idx
  on public.nba_game_lineup_stints (game_id, build_id, stint_ordinal);
create index if not exists nba_game_possessions_game_build_idx
  on public.nba_game_possessions (game_id, build_id, possession_ordinal);
create index if not exists nba_game_possessions_context_idx
  on public.nba_game_possessions (game_id, is_clutch_v1, transition_context, home_score_state_v1);
create index if not exists nba_adjusted_model_runs_scope_idx
  on public.nba_adjusted_model_runs (season_end_year, season_phase, status, completed_at desc);

drop trigger if exists nba_pbp_import_runs_set_updated_at on public.nba_pbp_import_runs;
create trigger nba_pbp_import_runs_set_updated_at
before update on public.nba_pbp_import_runs
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_provider_teams_set_updated_at on public.nba_provider_teams;
create trigger nba_provider_teams_set_updated_at
before update on public.nba_provider_teams
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_provider_team_seasons_set_updated_at on public.nba_provider_team_seasons;
create trigger nba_provider_team_seasons_set_updated_at
before update on public.nba_provider_team_seasons
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_provider_players_set_updated_at on public.nba_provider_players;
create trigger nba_provider_players_set_updated_at
before update on public.nba_provider_players
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_games_set_updated_at on public.nba_games;
create trigger nba_games_set_updated_at
before update on public.nba_games
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_pbp_events_set_updated_at on public.nba_pbp_events;
create trigger nba_pbp_events_set_updated_at
before update on public.nba_pbp_events
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_pbp_event_on_court_set_updated_at on public.nba_pbp_event_on_court;
create trigger nba_pbp_event_on_court_set_updated_at
before update on public.nba_pbp_event_on_court
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_lineup_definitions_set_updated_at on public.nba_lineup_definitions;
create trigger nba_lineup_definitions_set_updated_at
before update on public.nba_lineup_definitions
for each row execute function public.set_nba_records_updated_at();

alter table public.nba_pbp_import_runs enable row level security;
alter table public.nba_provider_teams enable row level security;
alter table public.nba_provider_team_seasons enable row level security;
alter table public.nba_provider_players enable row level security;
alter table public.nba_games enable row level security;
alter table public.nba_pbp_source_documents enable row level security;
alter table public.nba_game_team_stats enable row level security;
alter table public.nba_game_player_stats enable row level security;
alter table public.nba_pbp_events enable row level security;
alter table public.nba_pbp_event_on_court enable row level security;
alter table public.nba_lineup_definitions enable row level security;
alter table public.nba_lineup_members enable row level security;
alter table public.nba_lineup_analytics_builds enable row level security;
alter table public.nba_game_lineup_stints enable row level security;
alter table public.nba_game_possessions enable row level security;
alter table public.nba_adjusted_model_runs enable row level security;
alter table public.nba_player_adjusted_impacts enable row level security;

revoke all on table public.nba_pbp_import_runs from anon, authenticated;
revoke all on table public.nba_provider_teams from anon, authenticated;
revoke all on table public.nba_provider_team_seasons from anon, authenticated;
revoke all on table public.nba_provider_players from anon, authenticated;
revoke all on table public.nba_games from anon, authenticated;
revoke all on table public.nba_pbp_source_documents from anon, authenticated;
revoke all on table public.nba_game_team_stats from anon, authenticated;
revoke all on table public.nba_game_player_stats from anon, authenticated;
revoke all on table public.nba_pbp_events from anon, authenticated;
revoke all on table public.nba_pbp_event_on_court from anon, authenticated;
revoke all on table public.nba_lineup_definitions from anon, authenticated;
revoke all on table public.nba_lineup_members from anon, authenticated;
revoke all on table public.nba_lineup_analytics_builds from anon, authenticated;
revoke all on table public.nba_game_lineup_stints from anon, authenticated;
revoke all on table public.nba_game_possessions from anon, authenticated;
revoke all on table public.nba_adjusted_model_runs from anon, authenticated;
revoke all on table public.nba_player_adjusted_impacts from anon, authenticated;

comment on table public.nba_pbp_source_documents is
  'Private provenance for compressed Sportradar source documents in the private nba-sportradar-raw bucket.';
comment on table public.nba_pbp_events is
  'Private normalized Sportradar PBP events. Event sequence, not updated timestamp, determines game order.';
comment on table public.nba_pbp_event_on_court is
  'Private exact on-court snapshots. Invalid or incomplete snapshots remain auditable but cannot enter standard five-man analytics.';
comment on table public.nba_lineup_definitions is
  'Canonical exact five-player units. Two-to-four-player shared-floor combinations are derived at query time and are not stored as exact lineups.';
comment on table public.nba_game_possessions is
  'Private possession facts using post-event provider possession state. Non-fastbreak is not a provider-verified half-court label.';
comment on table public.nba_adjusted_model_runs is
  'Versioned, reproducible ridge RAPM runs fitted outside Postgres from eligible paired five-on-five stints.';
