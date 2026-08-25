-- This batch adapter is used only by the commerce-project cache worker.  Keep
-- raw player payload assembly off the browser-facing API even when project
-- default function grants are configured for anon/authenticated roles.
revoke all on function public.get_nba_athlete_slab_stats_batch(uuid[])
  from public, anon, authenticated;
grant execute on function public.get_nba_athlete_slab_stats_batch(uuid[])
  to service_role;
