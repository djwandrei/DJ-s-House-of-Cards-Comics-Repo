-- Restore the commerce-project boundary after a no-data position-profile
-- migration was applied to the wrong linked project. The dedicated NBA
-- analytics project owns all Lineup Lab facts and public views; commerce must
-- retain neither a duplicate player-pool view nor profile evidence.

do $$
begin
  if exists (
    select 1
    from public.nba_player_position_profiles
    limit 1
  ) then
    raise exception 'Commerce position-profile cleanup refused: profile rows exist and require an explicit audited migration.';
  end if;
end;
$$;

drop view if exists public.nba_lineup_player_pool;
drop table if exists public.nba_player_position_profiles;
