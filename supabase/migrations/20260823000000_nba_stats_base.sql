-- NBA historical player-stat data domain.
--
-- This migration intentionally uses public.nba_* names instead of a custom
-- Postgres schema so future site tools can use the existing Supabase browser
-- configuration without exposing a second schema. Import runs and raw source
-- records remain private behind RLS; browser clients receive read-only access
-- only to normalized player, team, season, and stat data.

create table if not exists public.nba_seasons (
  season_end_year smallint primary key check (season_end_year between 1947 and 2200),
  season_start_year smallint not null,
  season_label text not null,
  created_at timestamptz not null default now(),
  constraint nba_seasons_years_match check (season_start_year = season_end_year - 1),
  constraint nba_seasons_label_not_blank check (length(trim(season_label)) > 0),
  unique (season_label)
);

insert into public.nba_seasons (season_end_year, season_start_year, season_label)
select
  ending_year,
  ending_year - 1,
  (ending_year - 1)::text || '-' || lpad((ending_year % 100)::text, 2, '0')
from generate_series(1947, extract(year from current_date)::integer + 1) as ending_year
on conflict (season_end_year) do nothing;

create table if not exists public.nba_franchises (
  id uuid primary key default gen_random_uuid(),
  franchise_code text not null unique check (franchise_code ~ '^[A-Z0-9]{2,8}$'),
  display_name text not null check (length(trim(display_name)) > 0),
  founded_season_end_year smallint references public.nba_seasons(season_end_year),
  dissolved_season_end_year smallint references public.nba_seasons(season_end_year),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_franchises_year_order check (
    dissolved_season_end_year is null
    or founded_season_end_year is null
    or dissolved_season_end_year >= founded_season_end_year
  )
);

create table if not exists public.nba_team_seasons (
  id uuid primary key default gen_random_uuid(),
  franchise_id uuid references public.nba_franchises(id) on delete restrict,
  season_end_year smallint not null references public.nba_seasons(season_end_year) on delete restrict,
  team_code text not null check (team_code ~ '^[A-Z0-9]{2,8}$'),
  team_name text not null check (length(trim(team_name)) > 0),
  city text not null default '',
  conference text not null default '',
  division text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (season_end_year, team_code)
);

create table if not exists public.nba_players (
  id uuid primary key default gen_random_uuid(),
  full_name text not null check (length(trim(full_name)) > 0),
  normalized_name text not null check (length(trim(normalized_name)) > 0),
  birth_date date,
  height_inches smallint check (height_inches is null or height_inches between 48 and 100),
  weight_pounds smallint check (weight_pounds is null or weight_pounds between 80 and 450),
  primary_position text not null default '',
  college text not null default '',
  country text not null default '',
  debut_season_end_year smallint references public.nba_seasons(season_end_year),
  final_season_end_year smallint references public.nba_seasons(season_end_year),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_players_career_year_order check (
    final_season_end_year is null
    or debut_season_end_year is null
    or final_season_end_year >= debut_season_end_year
  )
);

create table if not exists public.nba_player_external_ids (
  source_name text not null check (length(trim(source_name)) > 0),
  external_id text not null check (length(trim(external_id)) > 0),
  player_id uuid not null references public.nba_players(id) on delete restrict,
  is_primary_for_source boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (source_name, external_id),
  unique (source_name, player_id)
);

-- Image locations are deliberately modeled separately from player and team
-- facts. A historic franchise can therefore carry its correct era-specific
-- logo, while a player can receive a headshot from a separately licensed
-- source without overwriting any statistical record.
create table if not exists public.nba_media_assets (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.nba_players(id) on delete cascade,
  team_season_id uuid references public.nba_team_seasons(id) on delete cascade,
  asset_kind text not null check (asset_kind in ('headshot', 'team_logo', 'alternate')),
  asset_url text not null check (length(trim(asset_url)) > 0),
  alt_text text not null default '',
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text not null default '',
  source_license_note text not null default '',
  rights_confirmed boolean not null default false,
  width_pixels integer check (width_pixels is null or width_pixels > 0),
  height_pixels integer check (height_pixels is null or height_pixels > 0),
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_media_assets_single_subject check (
    (player_id is not null and team_season_id is null)
    or (player_id is null and team_season_id is not null)
  ),
  constraint nba_media_assets_kind_matches_subject check (
    (player_id is not null and asset_kind in ('headshot', 'alternate'))
    or (team_season_id is not null and asset_kind in ('team_logo', 'alternate'))
  )
);

create table if not exists public.nba_stat_import_runs (
  id uuid primary key default gen_random_uuid(),
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text not null default '',
  source_license_note text not null default '',
  rights_confirmed boolean not null default false,
  requested_season_start smallint references public.nba_seasons(season_end_year),
  requested_season_end smallint references public.nba_seasons(season_end_year),
  status text not null default 'planned' check (status in ('planned', 'running', 'completed', 'failed', 'cancelled')),
  records_read integer not null default 0 check (records_read >= 0),
  players_created integer not null default 0 check (players_created >= 0),
  stat_rows_upserted integer not null default 0 check (stat_rows_upserted >= 0),
  metric_rows_upserted integer not null default 0 check (metric_rows_upserted >= 0),
  error_summary text not null default '',
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_stat_import_runs_year_order check (
    requested_season_end is null
    or requested_season_start is null
    or requested_season_end >= requested_season_start
  )
);

create table if not exists public.nba_player_team_season_stats (
  id bigint generated always as identity primary key,
  player_id uuid not null references public.nba_players(id) on delete restrict,
  season_end_year smallint not null references public.nba_seasons(season_end_year) on delete restrict,
  team_season_id uuid references public.nba_team_seasons(id) on delete restrict,
  team_code text not null check (team_code ~ '^[A-Z0-9]{2,8}$'),
  season_phase text not null default 'regular' check (season_phase in ('regular', 'playoffs', 'all_star')),
  is_multi_team_aggregate boolean not null default false,
  listed_position text not null default '',
  player_age smallint check (player_age is null or player_age between 16 and 60),
  games_played integer check (games_played is null or games_played >= 0),
  games_started integer check (games_started is null or games_started >= 0),
  minutes_played integer check (minutes_played is null or minutes_played >= 0),
  field_goals_made integer check (field_goals_made is null or field_goals_made >= 0),
  field_goals_attempted integer check (field_goals_attempted is null or field_goals_attempted >= 0),
  three_point_field_goals_made integer check (three_point_field_goals_made is null or three_point_field_goals_made >= 0),
  three_point_field_goals_attempted integer check (three_point_field_goals_attempted is null or three_point_field_goals_attempted >= 0),
  free_throws_made integer check (free_throws_made is null or free_throws_made >= 0),
  free_throws_attempted integer check (free_throws_attempted is null or free_throws_attempted >= 0),
  offensive_rebounds integer check (offensive_rebounds is null or offensive_rebounds >= 0),
  defensive_rebounds integer check (defensive_rebounds is null or defensive_rebounds >= 0),
  total_rebounds integer check (total_rebounds is null or total_rebounds >= 0),
  assists integer check (assists is null or assists >= 0),
  steals integer check (steals is null or steals >= 0),
  blocks integer check (blocks is null or blocks >= 0),
  turnovers integer check (turnovers is null or turnovers >= 0),
  personal_fouls integer check (personal_fouls is null or personal_fouls >= 0),
  points integer check (points is null or points >= 0),
  plus_minus integer,
  source_name text not null check (length(trim(source_name)) > 0),
  source_record_id text not null default '',
  source_url text not null default '',
  source_import_run_id uuid references public.nba_stat_import_runs(id) on delete set null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nba_player_team_season_stats_starts_not_over_games check (
    games_started is null
    or games_played is null
    or games_started <= games_played
  ),
  constraint nba_player_team_season_stats_makes_not_over_attempts check (
    (field_goals_made is null or field_goals_attempted is null or field_goals_made <= field_goals_attempted)
    and (three_point_field_goals_made is null or three_point_field_goals_attempted is null or three_point_field_goals_made <= three_point_field_goals_attempted)
    and (free_throws_made is null or free_throws_attempted is null or free_throws_made <= free_throws_attempted)
  ),
  constraint nba_player_team_season_stats_rebound_total check (
    total_rebounds is null
    or offensive_rebounds is null
    or defensive_rebounds is null
    or total_rebounds = offensive_rebounds + defensive_rebounds
  ),
  constraint nba_player_team_season_stats_team_scope check (
    (is_multi_team_aggregate and team_season_id is null)
    or (not is_multi_team_aggregate and team_season_id is not null)
  ),
  unique (player_id, season_end_year, team_code, season_phase)
);

create table if not exists public.nba_stat_metric_definitions (
  metric_code text primary key check (metric_code ~ '^[a-z0-9_]+$'),
  display_name text not null check (length(trim(display_name)) > 0),
  category text not null check (category in ('advanced', 'rate', 'tracking', 'other')),
  value_unit text not null check (value_unit in ('number', 'percentage', 'per_48', 'per_100', 'rating')),
  description text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.nba_stat_metric_definitions (metric_code, display_name, category, value_unit, description)
values
  ('player_efficiency_rating', 'Player Efficiency Rating', 'advanced', 'number', 'PER.'),
  ('true_shooting_percentage', 'True Shooting Percentage', 'advanced', 'percentage', 'TS%.'),
  ('three_point_attempt_rate', 'Three-Point Attempt Rate', 'rate', 'percentage', 'Three-point attempts per field-goal attempt.'),
  ('free_throw_attempt_rate', 'Free Throw Attempt Rate', 'rate', 'percentage', 'Free-throw attempts per field-goal attempt.'),
  ('offensive_rebound_percentage', 'Offensive Rebound Percentage', 'advanced', 'percentage', 'Estimated available offensive rebounds collected.'),
  ('defensive_rebound_percentage', 'Defensive Rebound Percentage', 'advanced', 'percentage', 'Estimated available defensive rebounds collected.'),
  ('total_rebound_percentage', 'Total Rebound Percentage', 'advanced', 'percentage', 'Estimated available rebounds collected.'),
  ('assist_percentage', 'Assist Percentage', 'advanced', 'percentage', 'Estimated teammate field goals assisted.'),
  ('steal_percentage', 'Steal Percentage', 'advanced', 'percentage', 'Estimated opponent possessions ending in a steal.'),
  ('block_percentage', 'Block Percentage', 'advanced', 'percentage', 'Estimated two-point attempts blocked.'),
  ('turnover_percentage', 'Turnover Percentage', 'advanced', 'percentage', 'Estimated possessions ending in a turnover.'),
  ('usage_percentage', 'Usage Percentage', 'advanced', 'percentage', 'Estimated team plays used while on court.'),
  ('offensive_win_shares', 'Offensive Win Shares', 'advanced', 'number', 'Estimated offensive wins contributed.'),
  ('defensive_win_shares', 'Defensive Win Shares', 'advanced', 'number', 'Estimated defensive wins contributed.'),
  ('win_shares', 'Win Shares', 'advanced', 'number', 'Estimated wins contributed.'),
  ('win_shares_per_48', 'Win Shares per 48 Minutes', 'advanced', 'per_48', 'Win shares normalized per 48 minutes.'),
  ('offensive_box_plus_minus', 'Offensive Box Plus/Minus', 'advanced', 'rating', 'Estimated offensive points per 100 possessions versus average.'),
  ('defensive_box_plus_minus', 'Defensive Box Plus/Minus', 'advanced', 'rating', 'Estimated defensive points per 100 possessions versus average.'),
  ('box_plus_minus', 'Box Plus/Minus', 'advanced', 'rating', 'Estimated overall points per 100 possessions versus average.'),
  ('value_over_replacement_player', 'Value Over Replacement Player', 'advanced', 'number', 'Estimated value above replacement player.')
on conflict (metric_code) do update set
  display_name = excluded.display_name,
  category = excluded.category,
  value_unit = excluded.value_unit,
  description = excluded.description,
  updated_at = now();

create table if not exists public.nba_player_team_season_metric_values (
  stat_id bigint not null references public.nba_player_team_season_stats(id) on delete cascade,
  metric_code text not null references public.nba_stat_metric_definitions(metric_code) on delete restrict,
  metric_value numeric(18, 6) not null,
  source_name text not null check (length(trim(source_name)) > 0),
  source_import_run_id uuid references public.nba_stat_import_runs(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (stat_id, metric_code)
);

create table if not exists public.nba_stat_source_records (
  id bigint generated always as identity primary key,
  import_run_id uuid not null references public.nba_stat_import_runs(id) on delete cascade,
  source_name text not null check (length(trim(source_name)) > 0),
  source_resource text not null check (length(trim(source_resource)) > 0),
  source_record_id text not null check (length(trim(source_record_id)) > 0),
  season_end_year smallint references public.nba_seasons(season_end_year),
  team_code text not null default '',
  record_hash text not null default '',
  payload jsonb not null default '{}'::jsonb,
  received_at timestamptz not null default now(),
  constraint nba_stat_source_records_payload_object check (jsonb_typeof(payload) = 'object'),
  unique (import_run_id, source_resource, source_record_id)
);

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

drop trigger if exists nba_franchises_set_updated_at on public.nba_franchises;
create trigger nba_franchises_set_updated_at
before update on public.nba_franchises
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_team_seasons_set_updated_at on public.nba_team_seasons;
create trigger nba_team_seasons_set_updated_at
before update on public.nba_team_seasons
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_players_set_updated_at on public.nba_players;
create trigger nba_players_set_updated_at
before update on public.nba_players
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_player_external_ids_set_updated_at on public.nba_player_external_ids;
create trigger nba_player_external_ids_set_updated_at
before update on public.nba_player_external_ids
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_media_assets_set_updated_at on public.nba_media_assets;
create trigger nba_media_assets_set_updated_at
before update on public.nba_media_assets
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_stat_import_runs_set_updated_at on public.nba_stat_import_runs;
create trigger nba_stat_import_runs_set_updated_at
before update on public.nba_stat_import_runs
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_player_team_season_stats_set_updated_at on public.nba_player_team_season_stats;
create trigger nba_player_team_season_stats_set_updated_at
before update on public.nba_player_team_season_stats
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_stat_metric_definitions_set_updated_at on public.nba_stat_metric_definitions;
create trigger nba_stat_metric_definitions_set_updated_at
before update on public.nba_stat_metric_definitions
for each row execute function public.set_nba_records_updated_at();

drop trigger if exists nba_player_team_season_metric_values_set_updated_at on public.nba_player_team_season_metric_values;
create trigger nba_player_team_season_metric_values_set_updated_at
before update on public.nba_player_team_season_metric_values
for each row execute function public.set_nba_records_updated_at();

create index if not exists nba_team_seasons_season_franchise_idx
  on public.nba_team_seasons (season_end_year, franchise_id);
create index if not exists nba_players_normalized_name_idx
  on public.nba_players (lower(normalized_name));
create index if not exists nba_player_external_ids_player_idx
  on public.nba_player_external_ids (player_id);
create unique index if not exists nba_media_assets_primary_player_kind_idx
  on public.nba_media_assets (player_id, asset_kind)
  where player_id is not null and is_primary;
create unique index if not exists nba_media_assets_primary_team_kind_idx
  on public.nba_media_assets (team_season_id, asset_kind)
  where team_season_id is not null and is_primary;
create index if not exists nba_media_assets_subject_idx
  on public.nba_media_assets (player_id, team_season_id, asset_kind);
create index if not exists nba_stat_import_runs_status_created_idx
  on public.nba_stat_import_runs (status, created_at desc);
create index if not exists nba_player_team_season_stats_team_leaders_idx
  on public.nba_player_team_season_stats (season_end_year, team_code, season_phase, points desc nulls last)
  where not is_multi_team_aggregate;
create index if not exists nba_player_team_season_stats_player_idx
  on public.nba_player_team_season_stats (player_id, season_end_year desc, season_phase);
create index if not exists nba_player_team_season_metrics_leader_idx
  on public.nba_player_team_season_metric_values (metric_code, metric_value desc);
create index if not exists nba_stat_source_records_run_idx
  on public.nba_stat_source_records (import_run_id, source_resource);

-- A player moved between teams can have both a provider aggregate (such as
-- "2TM") and individual team stints. Prefer individual stints when present;
-- retain aggregate-only rows when no individual stint is available.
create or replace view public.nba_player_season_totals
with (security_invoker = true)
as
with scoped_stats as (
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
), usable_stats as (
  select *
  from scoped_stats
  where not is_multi_team_aggregate or not has_team_stints
)
select
  player_id,
  season_end_year,
  season_phase,
  count(*) filter (where not is_multi_team_aggregate) as team_stint_count,
  sum(games_played) as games_played,
  sum(games_started) as games_started,
  sum(minutes_played) as minutes_played,
  sum(field_goals_made) as field_goals_made,
  sum(field_goals_attempted) as field_goals_attempted,
  case when sum(field_goals_attempted) > 0
    then round(sum(field_goals_made)::numeric / sum(field_goals_attempted), 6)
  end as field_goal_percentage,
  sum(three_point_field_goals_made) as three_point_field_goals_made,
  sum(three_point_field_goals_attempted) as three_point_field_goals_attempted,
  case when sum(three_point_field_goals_attempted) > 0
    then round(sum(three_point_field_goals_made)::numeric / sum(three_point_field_goals_attempted), 6)
  end as three_point_percentage,
  sum(free_throws_made) as free_throws_made,
  sum(free_throws_attempted) as free_throws_attempted,
  case when sum(free_throws_attempted) > 0
    then round(sum(free_throws_made)::numeric / sum(free_throws_attempted), 6)
  end as free_throw_percentage,
  sum(offensive_rebounds) as offensive_rebounds,
  sum(defensive_rebounds) as defensive_rebounds,
  sum(total_rebounds) as total_rebounds,
  sum(assists) as assists,
  sum(steals) as steals,
  sum(blocks) as blocks,
  sum(turnovers) as turnovers,
  sum(personal_fouls) as personal_fouls,
  sum(points) as points
from usable_stats
group by player_id, season_end_year, season_phase;

-- This view is the direct answer to "who played for which team and when?"
-- It intentionally retains one row for every player/team/season/phase stint
-- and excludes provider aggregate rows such as "2TM", which are not teams.
create or replace view public.nba_player_team_history
with (security_invoker = true)
as
select
  stats.player_id,
  players.full_name as player_name,
  players.primary_position as player_primary_position,
  player_headshot.asset_url as player_headshot_url,
  seasons.season_start_year,
  seasons.season_end_year,
  seasons.season_label,
  stats.season_phase,
  franchises.id as franchise_id,
  franchises.franchise_code,
  franchises.display_name as franchise_name,
  team_seasons.team_code,
  team_seasons.team_name,
  team_seasons.city as team_city,
  team_logo.asset_url as team_logo_url,
  team_seasons.conference,
  team_seasons.division,
  stats.listed_position,
  stats.player_age,
  stats.games_played,
  stats.games_started,
  stats.minutes_played,
  stats.points,
  stats.total_rebounds,
  stats.assists,
  stats.source_name,
  stats.source_updated_at,
  stats.created_at as imported_at
from public.nba_player_team_season_stats as stats
join public.nba_players as players on players.id = stats.player_id
join public.nba_seasons as seasons on seasons.season_end_year = stats.season_end_year
join public.nba_team_seasons as team_seasons on team_seasons.id = stats.team_season_id
left join public.nba_franchises as franchises on franchises.id = team_seasons.franchise_id
left join lateral (
  select media.asset_url
  from public.nba_media_assets as media
  where media.player_id = players.id
    and media.asset_kind = 'headshot'
    and media.is_primary
    and media.rights_confirmed
  order by media.updated_at desc
  limit 1
) as player_headshot on true
left join lateral (
  select media.asset_url
  from public.nba_media_assets as media
  where media.team_season_id = team_seasons.id
    and media.asset_kind = 'team_logo'
    and media.is_primary
    and media.rights_confirmed
  order by media.updated_at desc
  limit 1
) as team_logo on true
where not stats.is_multi_team_aggregate;

alter table public.nba_seasons enable row level security;
alter table public.nba_franchises enable row level security;
alter table public.nba_team_seasons enable row level security;
alter table public.nba_players enable row level security;
alter table public.nba_player_external_ids enable row level security;
alter table public.nba_media_assets enable row level security;
alter table public.nba_stat_import_runs enable row level security;
alter table public.nba_player_team_season_stats enable row level security;
alter table public.nba_stat_metric_definitions enable row level security;
alter table public.nba_player_team_season_metric_values enable row level security;
alter table public.nba_stat_source_records enable row level security;

create policy "Public can read NBA seasons"
on public.nba_seasons for select to anon, authenticated using (true);
create policy "Public can read NBA franchises"
on public.nba_franchises for select to anon, authenticated using (true);
create policy "Public can read NBA team seasons"
on public.nba_team_seasons for select to anon, authenticated using (true);
create policy "Public can read NBA players"
on public.nba_players for select to anon, authenticated using (true);
create policy "Public can read NBA player external IDs"
on public.nba_player_external_ids for select to anon, authenticated using (true);
create policy "Public can read confirmed NBA media assets"
on public.nba_media_assets for select to anon, authenticated using (rights_confirmed);
create policy "Public can read NBA player team season stats"
on public.nba_player_team_season_stats for select to anon, authenticated using (true);
create policy "Public can read NBA metric definitions"
on public.nba_stat_metric_definitions for select to anon, authenticated using (true);
create policy "Public can read NBA player metric values"
on public.nba_player_team_season_metric_values for select to anon, authenticated using (true);
create policy "Site admins can read NBA import runs"
on public.nba_stat_import_runs for select to authenticated using (public.is_site_admin());
create policy "Site admins can read NBA source records"
on public.nba_stat_source_records for select to authenticated using (public.is_site_admin());
create policy "Site admins can read NBA media assets"
on public.nba_media_assets for select to authenticated using (public.is_site_admin());

grant select on public.nba_player_season_totals to anon, authenticated;
grant select on public.nba_player_team_history to anon, authenticated;

comment on table public.nba_stat_import_runs is
  'Private audit log for NBA data imports. rights_confirmed must be true before a source is loaded.';
comment on table public.nba_stat_source_records is
  'Private raw-source provenance. Never expose this table through browser write policies.';
comment on table public.nba_media_assets is
  'Player headshots and era-specific team logos. Public reads require rights_confirmed = true.';
comment on view public.nba_player_season_totals is
  'Read-only player season aggregates derived from individual team stints when they exist.';
comment on view public.nba_player_team_history is
  'Read-only player team-season history. Each non-aggregate row is a player stint with one historical team.';
