-- Compact product-facing NBA stats cache.
--
-- The original project retains product IDs, verified product-to-athlete
-- mappings, and the public product RPC.  The dedicated analytics project is
-- the source for full NBA facts; this cache stores only the reviewed
-- shopper-facing payload required by one visible product.
--
-- This migration intentionally does not replace get_nba_product_slab_stats.
-- A later, separate cutover migration is permitted only after the sync worker
-- records a zero-mismatch shadow validation run.

create table if not exists public.nba_product_slab_stats_cache (
  product_id bigint primary key references public.products(id) on delete cascade,
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
  constraint nba_product_slab_stats_cache_payload_product_id check (
    payload ? 'productId'
    and (payload ->> 'productId') ~ '^[0-9]+$'
    and (payload ->> 'productId')::bigint = product_id
  )
);

create table if not exists public.nba_product_slab_stats_cache_runs (
  id uuid primary key default gen_random_uuid(),
  status text not null check (status in ('running', 'completed', 'failed')),
  analytics_project_ref text not null check (analytics_project_ref ~ '^[a-z0-9]{20}$'),
  mapped_product_count integer not null default 0 check (mapped_product_count >= 0),
  cache_upsert_count integer not null default 0 check (cache_upsert_count >= 0),
  shadow_checked_count integer not null default 0 check (shadow_checked_count >= 0),
  mismatch_count integer not null default 0 check (mismatch_count >= 0),
  error_summary text not null default '',
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists nba_product_slab_stats_cache_synced_idx
  on public.nba_product_slab_stats_cache (synced_at desc);
create index if not exists nba_product_slab_stats_cache_runs_status_idx
  on public.nba_product_slab_stats_cache_runs (status, started_at desc);

alter table public.nba_product_slab_stats_cache enable row level security;
alter table public.nba_product_slab_stats_cache_runs enable row level security;

-- Only a server-side worker may write or inspect raw cache synchronization
-- metadata. Browser reads remain routed through the established product RPC.
revoke all on public.nba_product_slab_stats_cache from public, anon, authenticated;
revoke all on public.nba_product_slab_stats_cache_runs from public, anon, authenticated;

create or replace function public.get_nba_product_slab_stats_cached(p_product_id bigint)
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
  ), current_mappings as (
    select mappings.athlete_id, mappings.updated_at
    from public.product_athlete_mappings as mappings
    join public.athletes as athletes
      on athletes.id = mappings.athlete_id
     and athletes.identity_status = 'active'
    where mappings.product_id = p_product_id
      and mappings.league_code = 'NBA'
      and mappings.review_state in ('auto_verified', 'human_verified')
  ), current_mapping_state as (
    select
      count(*)::integer as mapping_count,
      coalesce(array_agg(athlete_id order by athlete_id), '{}'::uuid[]) as athlete_ids,
      max(updated_at) as latest_mapping_update
    from current_mappings
  )
  select cache.payload
  from visible_product
  join public.nba_product_slab_stats_cache as cache on cache.product_id = visible_product.id
  cross join current_mapping_state
  where current_mapping_state.mapping_count > 0
    and cache.athlete_ids = current_mapping_state.athlete_ids
    and cache.synced_at >= current_mapping_state.latest_mapping_update;
$$;

revoke all on function public.get_nba_product_slab_stats_cached(bigint) from public;
grant execute on function public.get_nba_product_slab_stats_cached(bigint) to service_role;

create or replace function public.verify_nba_product_slab_stats_cache(
  p_product_ids bigint[]
)
returns table (
  product_id bigint,
  payload_matches boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    cache.product_id,
    cache.payload = public.get_nba_product_slab_stats(cache.product_id) as payload_matches
  from public.nba_product_slab_stats_cache as cache
  where cache.product_id = any(coalesce(p_product_ids, '{}'::bigint[]))
  order by cache.product_id
$$;

revoke all on function public.verify_nba_product_slab_stats_cache(bigint[]) from public;
grant execute on function public.verify_nba_product_slab_stats_cache(bigint[]) to service_role;

comment on table public.nba_product_slab_stats_cache is
  'Original-project cache of public-safe product NBA stats. Full analytics remains in the dedicated analytics project.';
comment on table public.nba_product_slab_stats_cache_runs is
  'Auditable server-side cache synchronization and shadow-validation summaries.';
