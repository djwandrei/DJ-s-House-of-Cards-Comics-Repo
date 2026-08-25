-- Supabase project defaults may grant new RPCs directly to browser roles.
-- These cache-maintenance helpers are worker-only, so explicitly revoke those
-- role grants rather than relying on a revoke from PUBLIC alone.
revoke all on function public.get_nba_product_slab_stats_cached(bigint)
  from public, anon, authenticated;
revoke all on function public.verify_nba_product_slab_stats_cache(bigint[])
  from public, anon, authenticated;

grant execute on function public.get_nba_product_slab_stats_cached(bigint)
  to service_role;
grant execute on function public.verify_nba_product_slab_stats_cache(bigint[])
  to service_role;
