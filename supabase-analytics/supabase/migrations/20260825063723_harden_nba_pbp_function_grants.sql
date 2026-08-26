-- Supabase production projects can grant new public-schema functions directly
-- to API roles through default privileges. Revoke every private helper/write
-- endpoint explicitly instead of relying on a PUBLIC-role revoke alone.

revoke all on function public.set_nba_records_updated_at()
  from public, anon, authenticated;
revoke all on function public.nba_lineup_metric_payload(numeric, integer, numeric, numeric, numeric, numeric)
  from public, anon, authenticated;
revoke all on function public.nba_invert_home_score_state_v1(text)
  from public, anon, authenticated;
revoke all on function public.ingest_nba_sportradar_game(jsonb)
  from public, anon, authenticated;
revoke all on function public.get_nba_rapm_stints(smallint, text)
  from public, anon, authenticated;
revoke all on function public.ingest_nba_rapm_model(jsonb)
  from public, anon, authenticated;

-- Reassert the intentional derived-read surface after removing any inherited
-- API-role grants from the complete PBP/RAPM function set.
revoke all on function public.get_nba_lineup_analytics(smallint, text, text, uuid[], text)
  from public, anon, authenticated;
revoke all on function public.get_nba_lineup_analytics_players(smallint, text, text)
  from public, anon, authenticated;
revoke all on function public.get_nba_adjusted_impacts(smallint, text, text)
  from public, anon, authenticated;

grant execute on function public.get_nba_lineup_analytics(smallint, text, text, uuid[], text)
  to anon, authenticated;
grant execute on function public.get_nba_lineup_analytics_players(smallint, text, text)
  to anon, authenticated;
grant execute on function public.get_nba_adjusted_impacts(smallint, text, text)
  to anon, authenticated;

grant execute on function public.ingest_nba_sportradar_game(jsonb)
  to service_role;
grant execute on function public.get_nba_rapm_stints(smallint, text)
  to service_role;
grant execute on function public.ingest_nba_rapm_model(jsonb)
  to service_role;
