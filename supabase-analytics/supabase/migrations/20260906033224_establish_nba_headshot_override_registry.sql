-- Existing analytics projects already recorded the reviewed URLs directly in
-- nba_media_assets. Establish the registry there before the importer begins
-- consulting it, while keeping fresh schema replays independent of media data.
create table if not exists public.nba_headshot_url_overrides (
  player_id uuid primary key,
  asset_url text not null check (length(trim(asset_url)) > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.nba_headshot_url_overrides enable row level security;
revoke all on table public.nba_headshot_url_overrides from public, anon, authenticated, service_role;
grant select on table public.nba_headshot_url_overrides to service_role;

comment on table public.nba_headshot_url_overrides is
  'Private canonical NBA player-headshot URL overrides. Player IDs intentionally have no foreign key so a clean schema bootstrap can load reviewed URLs before player/media imports.';

do $$
declare
  expected_rows constant integer := 2325;
  override_rows integer;
  override_players integer;
  override_urls integer;
  media_rows integer;
  media_players integer;
  media_urls integer;
begin
  select
    count(*)::integer,
    count(distinct player_id)::integer,
    count(distinct asset_url)::integer
  into override_rows, override_players, override_urls
  from public.nba_headshot_url_overrides;

  -- A legacy deployed database has no registry yet, but it already contains
  -- the final, reviewed result of the two historical URL migrations.
  if override_rows = 0 then
    select
      count(*)::integer,
      count(distinct player_id)::integer,
      count(distinct asset_url)::integer
    into media_rows, media_players, media_urls
    from public.nba_media_assets
    where player_id is not null
      and asset_kind = 'headshot'
      and is_primary
      and rights_confirmed;

    if media_rows <> expected_rows
      or media_players <> expected_rows
      or media_urls <> expected_rows then
      raise exception
        'Cannot establish NBA headshot override registry: expected % distinct, rights-confirmed primary headshots; found rows %, players %, URLs %.',
        expected_rows, media_rows, media_players, media_urls;
    end if;

    insert into public.nba_headshot_url_overrides (player_id, asset_url)
    select player_id, asset_url
    from public.nba_media_assets
    where player_id is not null
      and asset_kind = 'headshot'
      and is_primary
      and rights_confirmed;
  end if;

  select
    count(*)::integer,
    count(distinct player_id)::integer,
    count(distinct asset_url)::integer
  into override_rows, override_players, override_urls
  from public.nba_headshot_url_overrides;

  if override_rows <> expected_rows
    or override_players <> expected_rows
    or override_urls <> expected_rows then
    raise exception
      'NBA headshot override registry must contain % unique reviewed rows; found rows %, players %, URLs %.',
      expected_rows, override_rows, override_players, override_urls;
  end if;
end $$;

-- Preserve original source provenance while correcting any matching media row
-- that was written before this forward-only registry migration ran.
update public.nba_media_assets as media
set
  asset_url = overrides.asset_url,
  updated_at = now()
from public.nba_headshot_url_overrides as overrides
where media.player_id = overrides.player_id
  and media.asset_kind = 'headshot'
  and media.asset_url is distinct from overrides.asset_url;
