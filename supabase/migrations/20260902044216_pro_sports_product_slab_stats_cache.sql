-- Compact shopper-facing MLB/NFL product-stat cache.
--
-- Historical facts remain in the isolated Sports Reference warehouse. The
-- commerce project stores only a validated payload for a visible, verified
-- product mapping, mirroring the established NBA Slab-to-Stats boundary.
-- Direct cache and mapping-table reads remain private; the storefront can use
-- only the fixed-shape RPC below.

create table if not exists public.pro_sports_product_slab_stats_cache (
  product_id bigint primary key references public.products(id) on delete cascade,
  league_code text not null check (league_code in ('MLB', 'NFL')),
  athlete_ids uuid[] not null default '{}'::uuid[],
  mapping_sha256 text not null check (mapping_sha256 ~ '^[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  analytics_project_ref text not null check (analytics_project_ref ~ '^[a-z0-9]{20}$'),
  analytics_schema_version smallint not null default 1 check (analytics_schema_version > 0),
  analytics_refreshed_at timestamptz not null default now(),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pro_sports_product_slab_stats_cache_payload_product_id check (
    payload ? 'productId'
    and (payload ->> 'productId') ~ '^[0-9]+$'
    and (payload ->> 'productId')::bigint = product_id
  ),
  constraint pro_sports_product_slab_stats_cache_payload_provider check (
    payload ? 'provider'
    and payload ->> 'provider' = league_code
  )
);

create table if not exists public.pro_sports_product_slab_stats_cache_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'completed', 'failed')),
  analytics_project_ref text not null check (analytics_project_ref ~ '^[a-z0-9]{20}$'),
  league_code text not null check (league_code in ('MLB', 'NFL', 'BOTH')),
  mapped_product_count integer not null default 0 check (mapped_product_count >= 0),
  cache_upsert_count integer not null default 0 check (cache_upsert_count >= 0),
  cache_checked_count integer not null default 0 check (cache_checked_count >= 0),
  mismatch_count integer not null default 0 check (mismatch_count >= 0),
  stale_cache_count integer not null default 0 check (stale_cache_count >= 0),
  error_summary text not null default '',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists pro_sports_product_slab_stats_cache_synced_idx
  on public.pro_sports_product_slab_stats_cache (league_code, synced_at desc);
create index if not exists pro_sports_product_slab_stats_cache_runs_status_idx
  on public.pro_sports_product_slab_stats_cache_runs (status, started_at desc);

alter table public.pro_sports_product_slab_stats_cache enable row level security;
alter table public.pro_sports_product_slab_stats_cache_runs enable row level security;

-- The Edge Function is the only reader/writer. A browser cannot inspect cache
-- metadata, mapping hashes, or the underlying verified identity bridge.
revoke all on public.pro_sports_product_slab_stats_cache from public, anon, authenticated;
revoke all on public.pro_sports_product_slab_stats_cache_runs from public, anon, authenticated;

create or replace function public.get_pro_sports_product_slab_stats_cached(
  p_product_id bigint
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with visible_product as (
    select
      products.id,
      case
        when lower(trim(products.category)) = 'baseball'
          and upper(trim(products.league)) = 'MLB' then 'MLB'
        when lower(trim(products.category)) = 'football'
          and upper(trim(products.league)) = 'NFL' then 'NFL'
      end as league_code
    from public.products as products
    where products.id = p_product_id
      and not products.is_deleted
      and products.sale_status not in ('hidden', 'archived', 'sold')
  ), current_mappings as (
    select mappings.athlete_id, mappings.updated_at
    from public.product_athlete_mappings as mappings
    join visible_product on visible_product.id = mappings.product_id
      and visible_product.league_code = mappings.league_code
    join public.athletes as athletes
      on athletes.id = mappings.athlete_id
     and athletes.identity_status = 'active'
    join public.athlete_league_memberships as memberships
      on memberships.athlete_id = mappings.athlete_id
     and memberships.league_code = mappings.league_code
     and memberships.membership_status = 'verified'
    where mappings.review_state in ('auto_verified', 'human_verified')
  ), current_mapping_state as (
    select
      count(*)::integer as mapping_count,
      coalesce(array_agg(athlete_id order by athlete_id), '{}'::uuid[]) as athlete_ids,
      max(updated_at) as latest_mapping_update
    from current_mappings
  )
  select cache.payload
  from visible_product
  join public.pro_sports_product_slab_stats_cache as cache
    on cache.product_id = visible_product.id
   and cache.league_code = visible_product.league_code
  cross join current_mapping_state
  where visible_product.league_code in ('MLB', 'NFL')
    and current_mapping_state.mapping_count > 0
    and cache.athlete_ids = current_mapping_state.athlete_ids
    and cache.synced_at >= current_mapping_state.latest_mapping_update;
$$;

revoke all on function public.get_pro_sports_product_slab_stats_cached(bigint)
  from public, anon, authenticated;
grant execute on function public.get_pro_sports_product_slab_stats_cached(bigint)
  to service_role;

create or replace function public.get_pro_sports_product_slab_stats(
  p_product_id bigint
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.get_pro_sports_product_slab_stats_cached(p_product_id);
$$;

revoke all on function public.get_pro_sports_product_slab_stats(bigint)
  from public;
grant execute on function public.get_pro_sports_product_slab_stats(bigint)
  to anon, authenticated;

comment on table public.pro_sports_product_slab_stats_cache is
  'Validated compact MLB/NFL product-stat payloads. Full historical facts remain in the isolated Sports Reference warehouse.';
comment on table public.pro_sports_product_slab_stats_cache_runs is
  'Server-side MLB/NFL cache synchronization and verification summaries.';
comment on function public.get_pro_sports_product_slab_stats(bigint) is
  'Returns public-safe cached MLB/NFL product statistics only when the product remains visible and its verified mapping is current.';
