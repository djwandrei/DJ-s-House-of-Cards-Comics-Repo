-- Media provenance for the isolated Sports Reference warehouse.
-- These tables intentionally mirror the sport-specific player/team keys so a
-- media row cannot be attached to a commerce or unrelated analytics record.

create table if not exists public.mlb_media_assets (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.mlb_players(id) on delete cascade,
  team_season_id bigint references public.mlb_team_seasons(id) on delete cascade,
  asset_kind text not null check (asset_kind in ('headshot', 'team_logo')),
  asset_url text not null check (length(trim(asset_url)) > 0),
  alt_text text not null default '',
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text not null default '',
  source_license_note text not null default '',
  rights_confirmed boolean not null default false,
  capture_method text not null default 'source_page'
    check (capture_method in ('source_page', 'derived_template', 'browser_cache')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mlb_media_assets_single_subject check (
    (player_id is not null and team_season_id is null and asset_kind = 'headshot')
    or (player_id is null and team_season_id is not null and asset_kind = 'team_logo')
  )
);

create unique index if not exists mlb_media_assets_player_kind_idx
  on public.mlb_media_assets (player_id, asset_kind) where player_id is not null;
create unique index if not exists mlb_media_assets_team_kind_idx
  on public.mlb_media_assets (team_season_id, asset_kind) where team_season_id is not null;

create table if not exists public.nfl_media_assets (
  id uuid primary key default gen_random_uuid(),
  player_id uuid references public.nfl_players(id) on delete cascade,
  team_season_id bigint references public.nfl_team_seasons(id) on delete cascade,
  asset_kind text not null check (asset_kind in ('headshot', 'team_logo')),
  asset_url text not null check (length(trim(asset_url)) > 0),
  alt_text text not null default '',
  source_name text not null check (length(trim(source_name)) > 0),
  source_url text not null default '',
  source_license_note text not null default '',
  rights_confirmed boolean not null default false,
  capture_method text not null default 'source_page'
    check (capture_method in ('source_page', 'derived_template', 'browser_cache')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint nfl_media_assets_single_subject check (
    (player_id is not null and team_season_id is null and asset_kind = 'headshot')
    or (player_id is null and team_season_id is not null and asset_kind = 'team_logo')
  )
);

create unique index if not exists nfl_media_assets_player_kind_idx
  on public.nfl_media_assets (player_id, asset_kind) where player_id is not null;
create unique index if not exists nfl_media_assets_team_kind_idx
  on public.nfl_media_assets (team_season_id, asset_kind) where team_season_id is not null;

alter table public.mlb_media_assets enable row level security;
alter table public.nfl_media_assets enable row level security;
revoke all on table public.mlb_media_assets, public.nfl_media_assets from anon, authenticated;
grant all on table public.mlb_media_assets, public.nfl_media_assets to service_role;

