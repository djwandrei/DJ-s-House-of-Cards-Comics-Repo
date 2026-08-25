-- Remove duplicate historical NBA analytics facts from the commerce project
-- after the dedicated analytics project is proven complete.  This migration
-- retains the small commerce identity projection required by
-- product_athlete_mappings and never touches products, assets, or buyer data.
--
-- The compact product stats cache is the storefront's only statistics source
-- after this migration.  It must be complete for every visible verified NBA
-- product before the legacy fact tables are truncated.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '5min';

lock table public.product_athlete_mappings in share row exclusive mode;
lock table public.nba_product_slab_stats_cache in share row exclusive mode;

do $$
declare
  expected_analytics_project_ref constant text := 'fbbmuqbdpgsmvnezowwn';
  incomplete_cache_count integer := 0;
  wrong_project_count integer := 0;
begin
  if to_regclass('public.nba_product_slab_stats_cache') is null then
    raise exception 'NBA analytics decommission requires public.nba_product_slab_stats_cache.';
  end if;
  if to_regprocedure('public.get_nba_product_slab_stats_cached(bigint)') is null then
    raise exception 'NBA analytics decommission requires the private cached stats RPC.';
  end if;

  with eligible_mappings as (
    select
      mappings.product_id,
      mappings.athlete_id,
      mappings.updated_at
    from public.product_athlete_mappings as mappings
    join public.products as products
      on products.id = mappings.product_id
    join public.athletes as athletes
      on athletes.id = mappings.athlete_id
     and athletes.identity_status = 'active'
    where mappings.league_code = 'NBA'
      and mappings.review_state in ('auto_verified', 'human_verified')
      and lower(trim(products.category)) = 'basketball'
      and upper(trim(products.league)) = 'NBA'
      and not products.is_deleted
      and products.sale_status not in ('hidden', 'archived', 'sold')
  ), eligible_products as (
    select
      product_id,
      array_agg(athlete_id order by athlete_id) as athlete_ids,
      max(updated_at) as latest_mapping_update
    from eligible_mappings
    group by product_id
  )
  select count(*)
    into incomplete_cache_count
  from eligible_products
  left join public.nba_product_slab_stats_cache as cache
    on cache.product_id = eligible_products.product_id
  where cache.product_id is null
    or cache.athlete_ids is distinct from eligible_products.athlete_ids
    or cache.synced_at < eligible_products.latest_mapping_update;

  if incomplete_cache_count <> 0 then
    raise exception 'NBA analytics decommission aborted: % visible verified products lack a current cache entry.', incomplete_cache_count;
  end if;

  select count(*)
    into wrong_project_count
  from public.nba_product_slab_stats_cache as cache
  where cache.analytics_project_ref <> expected_analytics_project_ref;

  if wrong_project_count <> 0 then
    raise exception 'NBA analytics decommission aborted: % cache entries are not sourced from the dedicated analytics project.', wrong_project_count;
  end if;
end;
$$;

-- Preserve the public contract and shopper-safe behavior, but remove the
-- original-table fallback.  A cache miss returns null and the optional stats
-- panel is hidden rather than showing data for an outdated player mapping.
create or replace function public.get_nba_product_slab_stats(p_product_id bigint)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.get_nba_product_slab_stats_cached(p_product_id);
$$;

revoke all on function public.get_nba_product_slab_stats(bigint) from public;
grant execute on function public.get_nba_product_slab_stats(bigint) to anon, authenticated;

comment on function public.get_nba_product_slab_stats(bigint) is
  'Returns public-safe NBA product statistics only from the validated commerce cache sourced by the dedicated analytics project.';

drop function if exists public.get_nba_product_slab_stats_legacy(bigint);
drop function if exists public.verify_nba_product_slab_stats_cache(bigint[]);

-- Lineup Lab already reads the equivalent browser-safe views from the dedicated
-- analytics project.  Removing old views prevents an accidental original-DB
-- read after the historical fact tables are cleared.
drop view if exists public.nba_lineup_available_teams;
drop view if exists public.nba_lineup_available_seasons;
drop view if exists public.nba_lineup_player_pool;
drop view if exists public.nba_player_team_history;
drop view if exists public.nba_player_season_totals;

-- Explicitly list the analytics-only tables. Do not use CASCADE: the retained
-- athlete identity/membership rows are referenced by product_athlete_mappings.
-- TRUNCATE releases the duplicated table data while keeping an empty schema
-- available for a controlled restore from the verified analytics project.
truncate table
  public.nba_player_team_season_metric_values,
  public.nba_stat_source_records,
  public.nba_player_team_season_stats,
  public.nba_media_assets,
  public.nba_player_external_ids,
  public.nba_players,
  public.nba_team_seasons,
  public.nba_franchises,
  public.nba_stat_metric_definitions,
  public.nba_stat_import_runs,
  public.nba_seasons
continue identity;

commit;
