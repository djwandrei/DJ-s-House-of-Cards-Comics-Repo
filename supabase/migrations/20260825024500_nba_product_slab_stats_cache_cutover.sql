-- The cache worker completed a zero-mismatch shadow run before this cutover.
-- Preserve the original implementation under a private name so an uncached
-- product, a newly changed mapping, or an invalidated cache row keeps the
-- established public result instead of failing closed.
alter function public.get_nba_product_slab_stats(bigint)
  rename to get_nba_product_slab_stats_legacy;

revoke all on function public.get_nba_product_slab_stats_legacy(bigint)
  from public, anon, authenticated;

create or replace function public.get_nba_product_slab_stats(p_product_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    public.get_nba_product_slab_stats_cached(p_product_id),
    public.get_nba_product_slab_stats_legacy(p_product_id)
  );
$$;

revoke all on function public.get_nba_product_slab_stats(bigint) from public;
grant execute on function public.get_nba_product_slab_stats(bigint) to anon, authenticated;

-- Keep the worker's shadow verifier independent from the cache-preferred
-- public wrapper so future cache refreshes compare against the source query.
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
    cache.payload = public.get_nba_product_slab_stats_legacy(cache.product_id) as payload_matches
  from public.nba_product_slab_stats_cache as cache
  where cache.product_id = any(coalesce(p_product_ids, '{}'::bigint[]))
  order by cache.product_id
$$;

revoke all on function public.verify_nba_product_slab_stats_cache(bigint[]) from public;
grant execute on function public.verify_nba_product_slab_stats_cache(bigint[]) to service_role;

comment on function public.get_nba_product_slab_stats(bigint) is
  'Returns public-safe NBA stats from a validated cache when current; otherwise falls back to the original scoped source query.';
comment on function public.get_nba_product_slab_stats_legacy(bigint) is
  'Private original NBA product-stats query retained as the cache fallback and shadow-validation source.';
