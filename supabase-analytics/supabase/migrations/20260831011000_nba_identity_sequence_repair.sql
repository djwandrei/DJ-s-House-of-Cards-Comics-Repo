-- Earlier NBA migrations copied source IDs into generated-by-default tables.
-- Align both identity sequences before importing additional historical seasons.
select setval(
  pg_get_serial_sequence('public.nba_player_team_season_stats', 'id'),
  coalesce((select max(id) from public.nba_player_team_season_stats), 0) + 1,
  false
);

select setval(
  pg_get_serial_sequence('public.nba_stat_source_records', 'id'),
  coalesce((select max(id) from public.nba_stat_source_records), 0) + 1,
  false
);

