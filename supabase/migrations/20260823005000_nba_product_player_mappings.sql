-- Universal athlete identity and catalog mappings, plus the NBA Slab-to-Stats
-- read adapter.
--
-- The universal layer intentionally stops at identity. An athlete can belong
-- to more than one league, can have several source IDs and aliases, and can be
-- depicted on several products. League-specific profile and statistics tables
-- remain separate because basketball, baseball, and football do not share a
-- meaningful stat grain. The first adapter links the existing nba_players and
-- NBA season-stat model to that universal identity.
--
-- Catalog player_athlete text is import evidence, never an identity key. It can
-- contain aliases, qualifiers, sets, or multiple pipe-delimited subjects. The
-- conservative seed below publishes a mapping only when every subject on an
-- NBA product resolves to one distinct verified alias.

create table if not exists public.sports (
  sport_code text primary key
    check (sport_code ~ '^[a-z][a-z0-9_]{1,31}$'),
  display_name text not null check (length(trim(display_name)) > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sports_leagues (
  league_code text primary key
    check (league_code ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$'),
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
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
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
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
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
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
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

create table if not exists public.product_athlete_mappings (
  product_id bigint not null references public.products(id) on delete cascade,
  athlete_id uuid not null,
  league_code text not null,
  subject_order smallint not null default 1 check (subject_order between 1 and 100),
  subject_role text not null default 'primary'
    check (subject_role in ('primary', 'co_subject', 'lot_member')),
  depicted_season_label text not null default '',
  depicted_season_start_year smallint,
  depicted_season_end_year smallint,
  season_mapping_method text not null default 'unresolved'
    check (season_mapping_method in ('title_season_range', 'catalog_year_reviewed', 'manual', 'unresolved')),
  match_method text not null
    check (match_method in ('catalog_player_exact', 'catalog_player_alias', 'external_id', 'manual')),
  match_confidence numeric(4, 3) not null default 1
    check (match_confidence between 0 and 1),
  review_state text not null default 'needs_review'
    check (review_state in ('auto_verified', 'human_verified', 'needs_review', 'rejected')),
  source_player_text text not null check (length(trim(source_player_text)) > 0),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object'),
  admin_notes text not null default '',
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (product_id, athlete_id, league_code),
  foreign key (athlete_id, league_code)
    references public.athlete_league_memberships(athlete_id, league_code)
    on delete restrict,
  constraint product_athlete_mapping_season_order check (
    depicted_season_start_year is null
    or depicted_season_end_year is null
    or depicted_season_end_year >= depicted_season_start_year
  ),
  constraint product_athlete_mapping_human_review_timestamp check (
    review_state <> 'human_verified' or reviewed_at is not null
  ),
  constraint product_athlete_mapping_auto_method check (
    review_state <> 'auto_verified'
    or match_method in ('catalog_player_exact', 'catalog_player_alias', 'external_id')
  )
);

create or replace function public.normalize_athlete_name(p_name text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select lower(regexp_replace(trim(coalesce(p_name, '')), '[[:space:]]+', ' ', 'g'));
$$;

create or replace function public.set_universal_athlete_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists sports_set_updated_at on public.sports;
create trigger sports_set_updated_at
before update on public.sports
for each row execute function public.set_universal_athlete_updated_at();

drop trigger if exists sports_leagues_set_updated_at on public.sports_leagues;
create trigger sports_leagues_set_updated_at
before update on public.sports_leagues
for each row execute function public.set_universal_athlete_updated_at();

drop trigger if exists athletes_set_updated_at on public.athletes;
create trigger athletes_set_updated_at
before update on public.athletes
for each row execute function public.set_universal_athlete_updated_at();

drop trigger if exists athlete_league_memberships_set_updated_at
  on public.athlete_league_memberships;
create trigger athlete_league_memberships_set_updated_at
before update on public.athlete_league_memberships
for each row execute function public.set_universal_athlete_updated_at();

drop trigger if exists athlete_aliases_set_updated_at on public.athlete_aliases;
create trigger athlete_aliases_set_updated_at
before update on public.athlete_aliases
for each row execute function public.set_universal_athlete_updated_at();

drop trigger if exists athlete_external_ids_set_updated_at on public.athlete_external_ids;
create trigger athlete_external_ids_set_updated_at
before update on public.athlete_external_ids
for each row execute function public.set_universal_athlete_updated_at();

drop trigger if exists product_athlete_mappings_set_updated_at
  on public.product_athlete_mappings;
create trigger product_athlete_mappings_set_updated_at
before update on public.product_athlete_mappings
for each row execute function public.set_universal_athlete_updated_at();

create index if not exists sports_leagues_sport_idx
  on public.sports_leagues (sport_code, league_code);
create index if not exists athletes_normalized_name_idx
  on public.athletes (normalized_name);
create index if not exists athletes_merge_target_idx
  on public.athletes (merged_into_athlete_id)
  where merged_into_athlete_id is not null;
create index if not exists athlete_memberships_league_idx
  on public.athlete_league_memberships (league_code, athlete_id)
  where membership_status in ('verified', 'provisional');
create index if not exists athlete_alias_resolution_idx
  on public.athlete_aliases (league_code, normalized_alias, athlete_id)
  where review_state = 'verified';
create index if not exists athlete_external_ids_athlete_idx
  on public.athlete_external_ids (athlete_id, league_code);
create unique index if not exists athlete_external_ids_primary_idx
  on public.athlete_external_ids (athlete_id, league_code, source_name)
  where is_primary_for_source;
create unique index if not exists product_athlete_mapping_active_order_idx
  on public.product_athlete_mappings (product_id, subject_order)
  where review_state <> 'rejected';
create unique index if not exists product_athlete_mapping_single_primary_idx
  on public.product_athlete_mappings (product_id)
  where subject_role = 'primary'
    and review_state in ('auto_verified', 'human_verified');
create index if not exists product_athlete_mapping_athlete_idx
  on public.product_athlete_mappings (athlete_id, league_code, product_id)
  where review_state in ('auto_verified', 'human_verified');
create index if not exists product_athlete_mapping_review_queue_idx
  on public.product_athlete_mappings (review_state, updated_at, product_id);

insert into public.sports (sport_code, display_name)
values ('basketball', 'Basketball')
on conflict (sport_code) do update
set display_name = excluded.display_name,
    is_active = true;

insert into public.sports_leagues (league_code, sport_code, display_name)
values ('NBA', 'basketball', 'National Basketball Association')
on conflict (league_code) do update
set sport_code = excluded.sport_code,
    display_name = excluded.display_name,
    is_active = true;

-- Link every existing NBA profile to one universal identity. Reusing the
-- existing NBA UUID makes the migration deterministic and avoids a second
-- opaque identifier for the initial league. A future multi-sport merge can
-- repoint nba_players.athlete_id without changing NBA stat foreign keys.
alter table public.nba_players add column if not exists athlete_id uuid;

insert into public.athletes (
  id,
  canonical_name,
  normalized_name,
  birth_date,
  metadata
)
select
  players.id,
  players.full_name,
  public.normalize_athlete_name(players.normalized_name),
  players.birth_date,
  jsonb_build_object('originLeague', 'NBA', 'originProfileId', players.id)
from public.nba_players as players
on conflict (id) do update
set canonical_name = excluded.canonical_name,
    normalized_name = excluded.normalized_name,
    birth_date = coalesce(excluded.birth_date, public.athletes.birth_date);

insert into public.athlete_league_memberships (
  athlete_id,
  league_code,
  membership_status,
  source_name,
  evidence
)
select
  players.id,
  'NBA',
  'verified',
  'nba_players',
  jsonb_build_object('nbaPlayerId', players.id)
from public.nba_players as players
on conflict (athlete_id, league_code) do update
set membership_status = 'verified';

update public.nba_players
set athlete_id = id
where athlete_id is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.nba_players'::regclass
      and conname = 'nba_players_athlete_id_fkey'
  ) then
    alter table public.nba_players
      add constraint nba_players_athlete_id_fkey
      foreign key (athlete_id) references public.athletes(id) on delete restrict;
  end if;
end;
$$;

create unique index if not exists nba_players_athlete_id_idx
  on public.nba_players (athlete_id);

alter table public.nba_players alter column athlete_id set not null;

insert into public.athlete_aliases (
  athlete_id,
  league_code,
  alias,
  normalized_alias,
  alias_type,
  review_state,
  source_name,
  evidence
)
select
  players.athlete_id,
  'NBA',
  players.full_name,
  public.normalize_athlete_name(players.normalized_name),
  'canonical',
  'verified',
  'nba_players',
  jsonb_build_object('nbaPlayerId', players.id)
from public.nba_players as players
on conflict (athlete_id, league_code, normalized_alias) do update
set alias = excluded.alias,
    alias_type = 'canonical',
    review_state = 'verified';

insert into public.athlete_external_ids (
  athlete_id,
  league_code,
  source_name,
  external_id,
  is_primary_for_source
)
select
  players.athlete_id,
  'NBA',
  external_ids.source_name,
  external_ids.external_id,
  external_ids.is_primary_for_source
from public.nba_player_external_ids as external_ids
join public.nba_players as players on players.id = external_ids.player_id
on conflict (league_code, source_name, external_id) do update
set athlete_id = excluded.athlete_id,
    is_primary_for_source = excluded.is_primary_for_source;

create or replace function public.sync_nba_player_universal_identity()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.athlete_id is null then
    new.athlete_id := new.id;
  end if;

  if new.athlete_id = new.id then
    insert into public.athletes (
      id,
      canonical_name,
      normalized_name,
      birth_date,
      metadata
    )
    values (
      new.id,
      new.full_name,
      public.normalize_athlete_name(new.normalized_name),
      new.birth_date,
      jsonb_build_object('originLeague', 'NBA', 'originProfileId', new.id)
    )
    on conflict (id) do update
    set canonical_name = excluded.canonical_name,
        normalized_name = excluded.normalized_name,
        birth_date = coalesce(excluded.birth_date, public.athletes.birth_date);
  elsif not exists (
    select 1 from public.athletes where athletes.id = new.athlete_id
  ) then
    raise exception 'Universal athlete % does not exist', new.athlete_id
      using errcode = 'foreign_key_violation';
  end if;

  insert into public.athlete_league_memberships (
    athlete_id,
    league_code,
    membership_status,
    source_name,
    evidence
  )
  values (
    new.athlete_id,
    'NBA',
    'verified',
    'nba_players',
    jsonb_build_object('nbaPlayerId', new.id)
  )
  on conflict (athlete_id, league_code) do update
  set membership_status = 'verified';

  insert into public.athlete_aliases (
    athlete_id,
    league_code,
    alias,
    normalized_alias,
    alias_type,
    review_state,
    source_name,
    evidence
  )
  values (
    new.athlete_id,
    'NBA',
    new.full_name,
    public.normalize_athlete_name(new.normalized_name),
    'canonical',
    'verified',
    'nba_players',
    jsonb_build_object('nbaPlayerId', new.id)
  )
  on conflict (athlete_id, league_code, normalized_alias) do update
  set alias = excluded.alias,
      review_state = 'verified';

  return new;
end;
$$;

drop trigger if exists nba_players_sync_universal_identity on public.nba_players;
create trigger nba_players_sync_universal_identity
before insert or update of full_name, normalized_name, birth_date, athlete_id
on public.nba_players
for each row execute function public.sync_nba_player_universal_identity();

create or replace function public.sync_nba_external_id_to_athlete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_athlete_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    delete from public.athlete_external_ids
    where league_code = 'NBA'
      and source_name = old.source_name
      and external_id = old.external_id;
  end if;

  if tg_op <> 'DELETE' then
    select players.athlete_id
      into target_athlete_id
    from public.nba_players as players
    where players.id = new.player_id;

    if target_athlete_id is null then
      raise exception 'NBA player % has no universal athlete identity', new.player_id
        using errcode = 'foreign_key_violation';
    end if;

    insert into public.athlete_external_ids (
      athlete_id,
      league_code,
      source_name,
      external_id,
      is_primary_for_source
    )
    values (
      target_athlete_id,
      'NBA',
      new.source_name,
      new.external_id,
      new.is_primary_for_source
    )
    on conflict (league_code, source_name, external_id) do update
    set athlete_id = excluded.athlete_id,
        is_primary_for_source = excluded.is_primary_for_source;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end;
$$;

drop trigger if exists nba_external_ids_sync_universal_identity
  on public.nba_player_external_ids;
create trigger nba_external_ids_sync_universal_identity
after insert or update or delete on public.nba_player_external_ids
for each row execute function public.sync_nba_external_id_to_athlete();

alter table public.sports enable row level security;
alter table public.sports_leagues enable row level security;
alter table public.athletes enable row level security;
alter table public.athlete_league_memberships enable row level security;
alter table public.athlete_aliases enable row level security;
alter table public.athlete_external_ids enable row level security;
alter table public.product_athlete_mappings enable row level security;

revoke all on public.sports from public, anon, authenticated;
revoke all on public.sports_leagues from public, anon, authenticated;
revoke all on public.athletes from public, anon, authenticated;
revoke all on public.athlete_league_memberships from public, anon, authenticated;
revoke all on public.athlete_aliases from public, anon, authenticated;
revoke all on public.athlete_external_ids from public, anon, authenticated;
revoke all on public.product_athlete_mappings from public, anon, authenticated;

grant select on public.sports, public.sports_leagues to anon, authenticated;
grant insert, update, delete on public.sports, public.sports_leagues to authenticated;
grant select, insert, update, delete on
  public.athletes,
  public.athlete_league_memberships,
  public.athlete_aliases,
  public.athlete_external_ids,
  public.product_athlete_mappings
to authenticated;

drop policy if exists "Anyone can read active sports" on public.sports;
create policy "Anyone can read active sports"
on public.sports for select to anon, authenticated
using (is_active);

drop policy if exists "Site admins can manage sports" on public.sports;
create policy "Site admins can manage sports"
on public.sports for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Anyone can read active sports leagues" on public.sports_leagues;
create policy "Anyone can read active sports leagues"
on public.sports_leagues for select to anon, authenticated
using (is_active);

drop policy if exists "Site admins can manage sports leagues" on public.sports_leagues;
create policy "Site admins can manage sports leagues"
on public.sports_leagues for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Site admins can manage universal athletes" on public.athletes;
create policy "Site admins can manage universal athletes"
on public.athletes for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Site admins can manage athlete memberships"
  on public.athlete_league_memberships;
create policy "Site admins can manage athlete memberships"
on public.athlete_league_memberships for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Site admins can manage athlete aliases" on public.athlete_aliases;
create policy "Site admins can manage athlete aliases"
on public.athlete_aliases for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Site admins can manage athlete external IDs"
  on public.athlete_external_ids;
create policy "Site admins can manage athlete external IDs"
on public.athlete_external_ids for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Site admins can manage product athlete mappings"
  on public.product_athlete_mappings;
create policy "Site admins can manage product athlete mappings"
on public.product_athlete_mappings for all to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

-- Seed exact aliases only when every pipe-delimited catalog subject resolves
-- to one distinct athlete. Partial mappings are withheld because a panel for
-- only one member of a multi-player card would be materially misleading.
with nba_products as (
  select
    products.id as product_id,
    products.name as product_name,
    products.player_athlete,
    regexp_match(
      products.name,
      '^[[:space:]]*((?:19|20)[0-9]{2})[-/]([0-9]{2}|(?:19|20)[0-9]{2})(?:[^0-9]|$)',
      'i'
    ) as season_match
  from public.products as products
  where lower(trim(products.category)) = 'basketball'
    and upper(trim(products.league)) = 'NBA'
    and length(trim(products.player_athlete)) > 0
), product_context as (
  select
    nba_products.*,
    case
      when length((season_match)[2]) = 2
        and (((season_match)[1]::integer + 1) % 100) = (season_match)[2]::integer
      then (season_match)[1]::integer + 1
      when length((season_match)[2]) = 4
        and (season_match)[2]::integer = (season_match)[1]::integer + 1
      then (season_match)[2]::integer
    end::smallint as depicted_season_end_year,
    case
      when season_match is not null then (season_match)[1]::integer
    end::smallint as candidate_season_start_year
  from nba_products
), catalog_subjects as (
  select
    product_context.product_id,
    product_context.product_name,
    product_context.player_athlete,
    case
      when product_context.depicted_season_end_year is not null
      then product_context.candidate_season_start_year
    end as depicted_season_start_year,
    product_context.depicted_season_end_year,
    trim(subject.source_player_text) as source_player_text,
    subject.subject_order::smallint as subject_order,
    count(*) over (partition by product_context.product_id) as subject_count,
    public.normalize_athlete_name(subject.source_player_text) as normalized_source_name
  from product_context
  cross join lateral regexp_split_to_table(product_context.player_athlete, '\|')
    with ordinality as subject(source_player_text, subject_order)
  where length(trim(subject.source_player_text)) > 0
), subject_matches as (
  select
    catalog_subjects.*,
    count(distinct aliases.athlete_id) as athlete_match_count,
    min(aliases.athlete_id::text)::uuid as matched_athlete_id,
    min(aliases.alias_type) as matched_alias_type
  from catalog_subjects
  left join public.athlete_aliases as aliases
    on aliases.league_code = 'NBA'
   and aliases.review_state = 'verified'
   and aliases.normalized_alias = catalog_subjects.normalized_source_name
   and exists (
     select 1
     from public.athletes as candidate_athlete
     where candidate_athlete.id = aliases.athlete_id
       and candidate_athlete.identity_status = 'active'
   )
  group by
    catalog_subjects.product_id,
    catalog_subjects.product_name,
    catalog_subjects.player_athlete,
    catalog_subjects.depicted_season_start_year,
    catalog_subjects.depicted_season_end_year,
    catalog_subjects.source_player_text,
    catalog_subjects.subject_order,
    catalog_subjects.subject_count,
    catalog_subjects.normalized_source_name
), complete_products as (
  select product_id
  from subject_matches
  group by product_id
  having count(*) = max(subject_count)
    and count(*) filter (where athlete_match_count = 1) = max(subject_count)
    and count(distinct matched_athlete_id) = max(subject_count)
)
insert into public.product_athlete_mappings (
  product_id,
  athlete_id,
  league_code,
  subject_order,
  subject_role,
  depicted_season_label,
  depicted_season_start_year,
  depicted_season_end_year,
  season_mapping_method,
  match_method,
  match_confidence,
  review_state,
  source_player_text,
  evidence
)
select
  subject_matches.product_id,
  subject_matches.matched_athlete_id,
  'NBA',
  subject_matches.subject_order,
  case when subject_matches.subject_count = 1 then 'primary' else 'co_subject' end,
  case
    when subject_matches.depicted_season_end_year is not null
    then concat(
      subject_matches.depicted_season_start_year,
      '-',
      lpad((subject_matches.depicted_season_end_year % 100)::text, 2, '0')
    )
    else ''
  end,
  subject_matches.depicted_season_start_year,
  subject_matches.depicted_season_end_year,
  case
    when subject_matches.depicted_season_end_year is not null then 'title_season_range'
    else 'unresolved'
  end,
  case
    when subject_matches.matched_alias_type = 'canonical' then 'catalog_player_exact'
    else 'catalog_player_alias'
  end,
  1,
  'auto_verified',
  subject_matches.source_player_text,
  jsonb_build_object(
    'mappingVersion', 1,
    'catalogPlayerAthlete', subject_matches.player_athlete,
    'matchedAliasType', subject_matches.matched_alias_type,
    'normalizedSourceName', subject_matches.normalized_source_name,
    'productName', subject_matches.product_name
  )
from subject_matches
join complete_products using (product_id)
where subject_matches.athlete_match_count = 1
on conflict do nothing;

-- Public reads use one fixed-shape, security-definer adapter. Direct mapping,
-- alias, evidence, review-note, and external-ID tables remain private.
create or replace function public.get_nba_product_slab_stats(p_product_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
with visible_product as (
  select products.id
  from public.products as products
  where products.id = p_product_id
    and lower(trim(products.category)) = 'basketball'
    and upper(trim(products.league)) = 'NBA'
    and not products.is_deleted
    and products.sale_status not in ('hidden', 'archived', 'sold')
), published_mappings as (
  select mappings.*
  from public.product_athlete_mappings as mappings
  join visible_product on visible_product.id = mappings.product_id
  join public.athletes as athletes
    on athletes.id = mappings.athlete_id
   and athletes.identity_status = 'active'
  where mappings.league_code = 'NBA'
    and mappings.review_state in ('auto_verified', 'human_verified')
), player_scope as (
  select
    mappings.product_id,
    mappings.athlete_id,
    players.id as nba_player_id,
    mappings.subject_order,
    mappings.subject_role,
    mappings.depicted_season_label,
    mappings.depicted_season_start_year,
    mappings.depicted_season_end_year,
    mappings.season_mapping_method,
    mappings.review_state,
    players.full_name,
    players.primary_position,
    players.birth_date,
    players.height_inches,
    players.weight_pounds,
    players.college,
    players.country,
    players.debut_season_end_year,
    players.final_season_end_year,
    player_headshot.asset_url as headshot_url
  from published_mappings as mappings
  join public.nba_players as players on players.athlete_id = mappings.athlete_id
  left join lateral (
    select media.asset_url
    from public.nba_media_assets as media
    where media.player_id = players.id
      and media.asset_kind = 'headshot'
      and media.is_primary
      and media.rights_confirmed
    order by media.updated_at desc, media.id
    limit 1
  ) as player_headshot on true
), metric_candidates as (
  select
    stats.player_id,
    stats.season_end_year,
    stats.season_phase,
    metrics.metric_code,
    metrics.metric_value,
    stats.minutes_played,
    stats.is_multi_team_aggregate,
    bool_or(stats.is_multi_team_aggregate) over (
      partition by stats.player_id, stats.season_end_year, stats.season_phase, metrics.metric_code
    ) as has_provider_aggregate
  from public.nba_player_team_season_metric_values as metrics
  join public.nba_player_team_season_stats as stats on stats.id = metrics.stat_id
  join player_scope on player_scope.nba_player_id = stats.player_id
  where metrics.metric_code in (
    'player_efficiency_rating',
    'true_shooting_percentage',
    'win_shares',
    'win_shares_per_48',
    'box_plus_minus',
    'value_over_replacement_player'
  )
), metric_scope as (
  select *
  from metric_candidates
  where (has_provider_aggregate and is_multi_team_aggregate)
     or (not has_provider_aggregate and not is_multi_team_aggregate)
), metric_rollups as (
  select
    player_id,
    season_end_year,
    season_phase,
    metric_code,
    case
      when bool_or(has_provider_aggregate) then max(metric_value)
      when metric_code in ('win_shares', 'value_over_replacement_player') then sum(metric_value)
      else coalesce(
        sum(metric_value * nullif(minutes_played, 0)) / nullif(sum(nullif(minutes_played, 0)), 0),
        avg(metric_value)
      )
    end as metric_value
  from metric_scope
  group by player_id, season_end_year, season_phase, metric_code
), season_metrics as (
  select
    player_id,
    season_end_year,
    season_phase,
    max(metric_value) filter (where metric_code = 'player_efficiency_rating') as player_efficiency_rating,
    max(metric_value) filter (where metric_code = 'true_shooting_percentage') as true_shooting_percentage,
    max(metric_value) filter (where metric_code = 'win_shares') as win_shares,
    max(metric_value) filter (where metric_code = 'win_shares_per_48') as win_shares_per_48,
    max(metric_value) filter (where metric_code = 'box_plus_minus') as box_plus_minus,
    max(metric_value) filter (where metric_code = 'value_over_replacement_player') as value_over_replacement_player
  from metric_rollups
  group by player_id, season_end_year, season_phase
), season_rows as (
  select
    totals.player_id,
    totals.season_end_year,
    seasons.season_label,
    totals.season_phase,
    totals.games_played,
    totals.games_started,
    totals.minutes_played,
    totals.field_goals_made,
    totals.field_goals_attempted,
    totals.field_goal_percentage,
    totals.three_point_field_goals_made,
    totals.three_point_field_goals_attempted,
    totals.three_point_percentage,
    totals.free_throws_made,
    totals.free_throws_attempted,
    totals.free_throw_percentage,
    totals.total_rebounds,
    totals.assists,
    totals.steals,
    totals.blocks,
    totals.turnovers,
    totals.points,
    season_metrics.player_efficiency_rating,
    season_metrics.true_shooting_percentage,
    season_metrics.win_shares,
    season_metrics.win_shares_per_48,
    season_metrics.box_plus_minus,
    season_metrics.value_over_replacement_player
  from public.nba_player_season_totals as totals
  join public.nba_seasons as seasons on seasons.season_end_year = totals.season_end_year
  join player_scope on player_scope.nba_player_id = totals.player_id
  left join season_metrics
    on season_metrics.player_id = totals.player_id
   and season_metrics.season_end_year = totals.season_end_year
   and season_metrics.season_phase = totals.season_phase
  where totals.season_phase in ('regular', 'playoffs')
), season_payloads as (
  select
    season_rows.player_id,
    jsonb_agg(
      jsonb_build_object(
        'seasonEndYear', season_rows.season_end_year,
        'seasonLabel', season_rows.season_label,
        'phase', season_rows.season_phase,
        'gamesPlayed', season_rows.games_played,
        'gamesStarted', season_rows.games_started,
        'minutesPlayed', season_rows.minutes_played,
        'fieldGoalsMade', season_rows.field_goals_made,
        'fieldGoalsAttempted', season_rows.field_goals_attempted,
        'fieldGoalPercentage', season_rows.field_goal_percentage,
        'threePointFieldGoalsMade', season_rows.three_point_field_goals_made,
        'threePointFieldGoalsAttempted', season_rows.three_point_field_goals_attempted,
        'threePointPercentage', season_rows.three_point_percentage,
        'freeThrowsMade', season_rows.free_throws_made,
        'freeThrowsAttempted', season_rows.free_throws_attempted,
        'freeThrowPercentage', season_rows.free_throw_percentage,
        'totalRebounds', season_rows.total_rebounds,
        'assists', season_rows.assists,
        'steals', season_rows.steals,
        'blocks', season_rows.blocks,
        'turnovers', season_rows.turnovers,
        'points', season_rows.points,
        'playerEfficiencyRating', season_rows.player_efficiency_rating,
        'trueShootingPercentage', season_rows.true_shooting_percentage,
        'winShares', season_rows.win_shares,
        'winSharesPer48', season_rows.win_shares_per_48,
        'boxPlusMinus', season_rows.box_plus_minus,
        'valueOverReplacementPlayer', season_rows.value_over_replacement_player
      )
      order by
        season_rows.season_end_year desc,
        case season_rows.season_phase when 'regular' then 0 else 1 end
    ) as seasons
  from season_rows
  group by season_rows.player_id
), player_payloads as (
  select
    player_scope.subject_order,
    jsonb_build_object(
      'mapping', jsonb_build_object(
        'subjectOrder', player_scope.subject_order,
        'subjectRole', player_scope.subject_role,
        'depictedSeasonLabel', player_scope.depicted_season_label,
        'depictedSeasonStartYear', player_scope.depicted_season_start_year,
        'depictedSeasonEndYear', player_scope.depicted_season_end_year,
        'seasonMappingMethod', player_scope.season_mapping_method,
        'reviewState', player_scope.review_state
      ),
      'player', jsonb_build_object(
        'athleteId', player_scope.athlete_id,
        'nbaPlayerId', player_scope.nba_player_id,
        'name', player_scope.full_name,
        'primaryPosition', player_scope.primary_position,
        'birthDate', player_scope.birth_date,
        'heightInches', player_scope.height_inches,
        'weightPounds', player_scope.weight_pounds,
        'college', player_scope.college,
        'country', player_scope.country,
        'debutSeasonEndYear', player_scope.debut_season_end_year,
        'finalSeasonEndYear', player_scope.final_season_end_year,
        'headshotUrl', player_scope.headshot_url
      ),
      'seasons', coalesce(season_payloads.seasons, '[]'::jsonb)
    ) as payload
  from player_scope
  left join season_payloads on season_payloads.player_id = player_scope.nba_player_id
)
select jsonb_build_object(
  'schemaVersion', 1,
  'provider', 'NBA',
  'productId', visible_product.id,
  'players', coalesce(
    (select jsonb_agg(player_payloads.payload order by player_payloads.subject_order) from player_payloads),
    '[]'::jsonb
  )
)
from visible_product;
$$;

revoke all on function public.normalize_athlete_name(text) from public;
revoke all on function public.set_universal_athlete_updated_at() from public;
revoke all on function public.sync_nba_player_universal_identity() from public;
revoke all on function public.sync_nba_external_id_to_athlete() from public;
revoke all on function public.get_nba_product_slab_stats(bigint) from public;

grant execute on function public.get_nba_product_slab_stats(bigint) to anon, authenticated;

comment on table public.athletes is
  'Sport-neutral athlete identities. Names are indexed but never assumed globally unique.';
comment on table public.athlete_league_memberships is
  'Verified or provisional links between one athlete identity and one league context.';
comment on table public.athlete_aliases is
  'League-scoped identity aliases used for conservative exact resolution and manual overrides.';
comment on table public.product_athlete_mappings is
  'Audited many-to-many links between catalog products and universal athlete identities.';
comment on column public.product_athlete_mappings.depicted_season_end_year is
  'Optional league season context inferred or reviewed for the depicted product, not a player-career claim.';
comment on function public.get_nba_product_slab_stats(bigint) is
  'Returns public-safe NBA identity and season-stat payloads for one visible verified product mapping.';
