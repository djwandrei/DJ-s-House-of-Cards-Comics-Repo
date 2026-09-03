-- Shared private historical analytics schema for the separate MLB and NFL projects.
-- Raw source records and ingest provenance remain private. No commerce,
-- customer, order, payment, or storefront tables belong in this project.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.sports (
  sport_code text primary key check (sport_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name text not null check (length(trim(display_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sports_leagues (
  league_code text primary key check (league_code ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$'),
  sport_code text not null references public.sports(sport_code) on delete restrict,
  display_name text not null check (length(trim(display_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.athletes (
  id uuid primary key default gen_random_uuid(),
  canonical_name text not null check (length(trim(canonical_name)) > 0),
  normalized_name text not null check (length(trim(normalized_name)) > 0),
  birth_date date,
  identity_status text not null default 'active'
    check (identity_status in ('active', 'disputed', 'merged')),
  merged_into_athlete_id uuid references public.athletes(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint athletes_merge_target_state check (
    (identity_status = 'merged' and merged_into_athlete_id is not null)
    or (identity_status <> 'merged' and merged_into_athlete_id is null)
  ),
  constraint athletes_cannot_merge_into_self check (
    merged_into_athlete_id is null or merged_into_athlete_id <> id
  )
);

create table if not exists public.athlete_league_memberships (
  athlete_id uuid not null references public.athletes(id) on delete restrict,
  league_code text not null references public.sports_leagues(league_code) on delete restrict,
  membership_status text not null default 'verified'
    check (membership_status in ('verified', 'provisional', 'inactive', 'rejected')),
  source_name text not null default '',
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, league_code)
);

create table if not exists public.athlete_aliases (
  athlete_id uuid not null,
  league_code text not null,
  alias text not null check (length(trim(alias)) > 0),
  normalized_alias text not null check (length(trim(normalized_alias)) > 0),
  alias_type text not null default 'known_name'
    check (alias_type in ('canonical', 'known_name', 'transliteration', 'catalog_override')),
  review_state text not null default 'needs_review'
    check (review_state in ('verified', 'needs_review', 'rejected')),
  source_name text not null default '',
  evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(evidence) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (athlete_id, league_code, normalized_alias),
  foreign key (athlete_id, league_code)
    references public.athlete_league_memberships(athlete_id, league_code)
    on delete restrict
);

create table if not exists public.athlete_external_ids (
  athlete_id uuid not null,
  league_code text not null,
  source_name text not null check (length(trim(source_name)) > 0),
  external_id text not null check (length(trim(external_id)) > 0),
  is_primary_for_source boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (league_code, source_name, external_id),
  foreign key (athlete_id, league_code)
    references public.athlete_league_memberships(athlete_id, league_code)
    on delete restrict
);

insert into public.sports (sport_code, display_name)
values ('baseball', 'Baseball'), ('football', 'Football')
on conflict (sport_code) do update set display_name = excluded.display_name, updated_at = now();

insert into public.sports_leagues (league_code, sport_code, display_name)
values ('MLB', 'baseball', 'Major League Baseball'), ('NFL', 'football', 'National Football League')
on conflict (league_code) do update set
  sport_code = excluded.sport_code,
  display_name = excluded.display_name,
  updated_at = now();

create table if not exists public.mlb_seasons (
  season_year smallint primary key check (season_year between 1876 and 2200),
  created_at timestamptz not null default now()
);

create table if not exists public.mlb_team_seasons (
  id bigint generated always as identity primary key,
  season_year smallint not null references public.mlb_seasons(season_year) on delete restrict,
  team_code text not null check (team_code ~ '^[A-Z0-9]{2,8}$'),
  team_name text not null check (length(trim(team_name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (season_year, team_code)
);

create table if not exists public.mlb_players (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null unique references public.athletes(id) on delete restrict,
  full_name text not null check (length(trim(full_name)) > 0),
  normalized_name text not null check (length(trim(normalized_name)) > 0),
  primary_position text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_player_external_ids (
  source_name text not null check (length(trim(source_name)) > 0),
  external_id text not null check (length(trim(external_id)) > 0),
  player_id uuid not null references public.mlb_players(id) on delete restrict,
  is_primary_for_source boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_name, external_id),
  unique (source_name, player_id)
);

create table if not exists public.mlb_stat_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text not null check (length(trim(source_url)) > 0),
  source_license_note text not null default '',
  season_year smallint not null references public.mlb_seasons(season_year) on delete restrict,
  stat_group text not null check (stat_group in ('batting', 'pitching')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  records_read integer not null default 0 check (records_read >= 0),
  players_created integer not null default 0 check (players_created >= 0),
  stat_rows_upserted integer not null default 0 check (stat_rows_upserted >= 0),
  error_summary text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.mlb_player_team_season_stats (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.mlb_players(id) on delete restrict,
  season_year smallint not null references public.mlb_seasons(season_year) on delete restrict,
  team_season_id bigint references public.mlb_team_seasons(id) on delete restrict,
  team_code text not null check (team_code ~ '^(?:[A-Z0-9]{2,8}|TOT|[2-9]TM)$'),
  season_phase text not null check (season_phase in ('regular', 'postseason')),
  stat_group text not null check (stat_group in ('batting', 'pitching')),
  is_multi_team_aggregate boolean not null default false,
  listed_position text not null default '',
  player_age smallint check (player_age is null or player_age between 15 and 65),
  games_played integer check (games_played is null or games_played >= 0),
  metric_values jsonb not null default '{}'::jsonb check (jsonb_typeof(metric_values) = 'object'),
  source_name text not null check (length(trim(source_name)) > 0),
  source_record_id text not null check (length(trim(source_record_id)) > 0),
  source_url text not null check (length(trim(source_url)) > 0),
  source_import_run_id uuid references public.mlb_stat_import_runs(id) on delete set null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mlb_stats_team_scope check (
    (is_multi_team_aggregate and team_season_id is null)
    or (not is_multi_team_aggregate and team_season_id is not null)
  ),
  unique (player_id, season_year, team_code, season_phase, stat_group)
);

create table if not exists public.mlb_stat_source_records (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references public.mlb_stat_import_runs(id) on delete cascade,
  source_record_id text not null check (length(trim(source_record_id)) > 0),
  team_code text not null,
  season_phase text not null check (season_phase in ('regular', 'postseason')),
  record_hash text not null check (record_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  unique (import_run_id, source_record_id)
);

create table if not exists public.nfl_seasons (
  season_year smallint primary key check (season_year between 1920 and 2200),
  created_at timestamptz not null default now()
);

create table if not exists public.nfl_team_seasons (
  id bigint generated always as identity primary key,
  season_year smallint not null references public.nfl_seasons(season_year) on delete restrict,
  team_code text not null check (team_code ~ '^[A-Z0-9]{2,8}$'),
  team_name text not null check (length(trim(team_name)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (season_year, team_code)
);

create table if not exists public.nfl_players (
  id uuid primary key default gen_random_uuid(),
  athlete_id uuid not null unique references public.athletes(id) on delete restrict,
  full_name text not null check (length(trim(full_name)) > 0),
  normalized_name text not null check (length(trim(normalized_name)) > 0),
  primary_position text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfl_player_external_ids (
  source_name text not null check (length(trim(source_name)) > 0),
  external_id text not null check (length(trim(external_id)) > 0),
  player_id uuid not null references public.nfl_players(id) on delete restrict,
  is_primary_for_source boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_name, external_id),
  unique (source_name, player_id)
);

create table if not exists public.nfl_stat_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text not null check (length(trim(source_url)) > 0),
  source_license_note text not null default '',
  season_year smallint not null references public.nfl_seasons(season_year) on delete restrict,
  stat_group text not null check (stat_group in ('passing', 'rushing', 'receiving', 'defense', 'kicking', 'returns', 'scoring')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  records_read integer not null default 0 check (records_read >= 0),
  players_created integer not null default 0 check (players_created >= 0),
  stat_rows_upserted integer not null default 0 check (stat_rows_upserted >= 0),
  error_summary text not null default '',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nfl_player_team_season_stats (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.nfl_players(id) on delete restrict,
  season_year smallint not null references public.nfl_seasons(season_year) on delete restrict,
  team_season_id bigint references public.nfl_team_seasons(id) on delete restrict,
  team_code text not null check (team_code ~ '^(?:[A-Z0-9]{2,8}|TOT|[2-9]TM)$'),
  season_phase text not null default 'regular' check (season_phase in ('regular', 'postseason')),
  stat_group text not null check (stat_group in ('passing', 'rushing', 'receiving', 'defense', 'kicking', 'returns', 'scoring')),
  is_multi_team_aggregate boolean not null default false,
  listed_position text not null default '',
  player_age smallint check (player_age is null or player_age between 17 and 65),
  games_played integer check (games_played is null or games_played >= 0),
  games_started integer check (games_started is null or games_started >= 0),
  metric_values jsonb not null default '{}'::jsonb check (jsonb_typeof(metric_values) = 'object'),
  source_name text not null check (length(trim(source_name)) > 0),
  source_record_id text not null check (length(trim(source_record_id)) > 0),
  source_url text not null check (length(trim(source_url)) > 0),
  source_import_run_id uuid references public.nfl_stat_import_runs(id) on delete set null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nfl_stats_team_scope check (
    (is_multi_team_aggregate and team_season_id is null)
    or (not is_multi_team_aggregate and team_season_id is not null)
  ),
  unique (player_id, season_year, team_code, season_phase, stat_group)
);

create table if not exists public.nfl_stat_source_records (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references public.nfl_stat_import_runs(id) on delete cascade,
  source_record_id text not null check (length(trim(source_record_id)) > 0),
  team_code text not null,
  season_phase text not null check (season_phase in ('regular', 'postseason')),
  record_hash text not null check (record_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  received_at timestamptz not null default now(),
  unique (import_run_id, source_record_id)
);

create index if not exists athletes_normalized_name_idx on public.athletes (normalized_name);
create index if not exists athletes_merged_into_idx
  on public.athletes (merged_into_athlete_id) where merged_into_athlete_id is not null;
create index if not exists sports_leagues_sport_code_idx on public.sports_leagues (sport_code);
create index if not exists athlete_memberships_league_idx
  on public.athlete_league_memberships (league_code, athlete_id);
create index if not exists athlete_aliases_verified_lookup_idx
  on public.athlete_aliases (league_code, normalized_alias) where review_state = 'verified';
create index if not exists athlete_external_ids_athlete_idx on public.athlete_external_ids (athlete_id, league_code);
create index if not exists mlb_players_normalized_name_idx on public.mlb_players (normalized_name);
create index if not exists mlb_player_external_ids_player_idx on public.mlb_player_external_ids (player_id);
create index if not exists mlb_stats_season_group_team_idx
  on public.mlb_player_team_season_stats (season_year, stat_group, team_code) where not is_multi_team_aggregate;
create index if not exists mlb_stats_player_history_idx
  on public.mlb_player_team_season_stats (player_id, season_year desc, season_phase, stat_group);
create index if not exists mlb_stats_team_season_id_idx
  on public.mlb_player_team_season_stats (team_season_id) where team_season_id is not null;
create index if not exists mlb_stats_import_run_idx
  on public.mlb_player_team_season_stats (source_import_run_id) where source_import_run_id is not null;
create index if not exists mlb_stats_metrics_gin_idx
  on public.mlb_player_team_season_stats using gin (metric_values jsonb_path_ops);
create index if not exists mlb_source_records_run_idx on public.mlb_stat_source_records (import_run_id);
create index if not exists nfl_players_normalized_name_idx on public.nfl_players (normalized_name);
create index if not exists nfl_player_external_ids_player_idx on public.nfl_player_external_ids (player_id);
create index if not exists nfl_stats_season_group_team_idx
  on public.nfl_player_team_season_stats (season_year, stat_group, team_code) where not is_multi_team_aggregate;
create index if not exists nfl_stats_player_history_idx
  on public.nfl_player_team_season_stats (player_id, season_year desc, season_phase, stat_group);
create index if not exists nfl_stats_team_season_id_idx
  on public.nfl_player_team_season_stats (team_season_id) where team_season_id is not null;
create index if not exists nfl_stats_import_run_idx
  on public.nfl_player_team_season_stats (source_import_run_id) where source_import_run_id is not null;
create index if not exists nfl_stats_metrics_gin_idx
  on public.nfl_player_team_season_stats using gin (metric_values jsonb_path_ops);
create index if not exists nfl_source_records_run_idx on public.nfl_stat_source_records (import_run_id);

alter table public.sports enable row level security;
alter table public.sports_leagues enable row level security;
alter table public.athletes enable row level security;
alter table public.athlete_league_memberships enable row level security;
alter table public.athlete_aliases enable row level security;
alter table public.athlete_external_ids enable row level security;
alter table public.mlb_seasons enable row level security;
alter table public.mlb_team_seasons enable row level security;
alter table public.mlb_players enable row level security;
alter table public.mlb_player_external_ids enable row level security;
alter table public.mlb_stat_import_runs enable row level security;
alter table public.mlb_player_team_season_stats enable row level security;
alter table public.mlb_stat_source_records enable row level security;
alter table public.nfl_seasons enable row level security;
alter table public.nfl_team_seasons enable row level security;
alter table public.nfl_players enable row level security;
alter table public.nfl_player_external_ids enable row level security;
alter table public.nfl_stat_import_runs enable row level security;
alter table public.nfl_player_team_season_stats enable row level security;
alter table public.nfl_stat_source_records enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update on public.sports, public.sports_leagues, public.athletes,
  public.athlete_league_memberships, public.athlete_aliases, public.athlete_external_ids,
  public.mlb_seasons, public.mlb_team_seasons, public.mlb_players,
  public.mlb_player_external_ids, public.mlb_stat_import_runs,
  public.mlb_player_team_season_stats, public.mlb_stat_source_records,
  public.nfl_seasons, public.nfl_team_seasons, public.nfl_players,
  public.nfl_player_external_ids, public.nfl_stat_import_runs,
  public.nfl_player_team_season_stats, public.nfl_stat_source_records
  to service_role;
grant usage, select on all sequences in schema public to service_role;

comment on table public.mlb_stat_source_records is
  'Private Baseball Reference source provenance; never exposed through browser policies.';
comment on table public.nfl_stat_source_records is
  'Private Pro Football Reference source provenance; never exposed through browser policies.';
comment on column public.mlb_player_team_season_stats.metric_values is
  'Source data-stat values normalized to lowercase keys; pitching innings also include innings_pitched_outs.';
comment on column public.nfl_player_team_season_stats.metric_values is
  'Source data-stat values normalized to lowercase keys so historical column changes remain auditable.';
