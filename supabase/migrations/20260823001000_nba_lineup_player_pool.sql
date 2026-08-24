-- Browser-safe, team-specific player pools for the standalone Lineup Lab.
--
-- `nba_player_season_totals` intentionally aggregates all team stints, which
-- is useful for a player-season page but unsuitable for a team lineup tool.
-- This view retains one regular-season or playoff stint per player/team while
-- exposing the precise fields needed to derive per-game optimizer inputs.

create or replace view public.nba_lineup_player_pool
with (security_invoker = true)
as
select
  stats.player_id,
  players.full_name as player_name,
  players.primary_position as player_primary_position,
  player_headshot.asset_url as player_headshot_url,
  team_logo.asset_url as team_logo_url,
  stats.season_end_year,
  seasons.season_label,
  stats.season_phase,
  stats.team_code,
  team_seasons.team_name,
  stats.listed_position,
  stats.player_age,
  stats.games_played,
  stats.games_started,
  stats.minutes_played,
  stats.field_goals_made,
  stats.field_goals_attempted,
  stats.three_point_field_goals_made,
  stats.three_point_field_goals_attempted,
  stats.free_throws_made,
  stats.free_throws_attempted,
  stats.offensive_rebounds,
  stats.defensive_rebounds,
  stats.total_rebounds,
  stats.assists,
  stats.steals,
  stats.blocks,
  stats.turnovers,
  stats.personal_fouls,
  stats.points,
  stats.source_name,
  stats.source_url
from public.nba_player_team_season_stats as stats
join public.nba_players as players on players.id = stats.player_id
join public.nba_seasons as seasons on seasons.season_end_year = stats.season_end_year
join public.nba_team_seasons as team_seasons on team_seasons.id = stats.team_season_id
left join lateral (
  select media.asset_url
  from public.nba_media_assets as media
  where media.player_id = players.id
    and media.asset_kind = 'headshot'
    and media.is_primary
    and media.rights_confirmed
  order by media.updated_at desc
  limit 1
) as player_headshot on true
left join lateral (
  select media.asset_url
  from public.nba_media_assets as media
  where media.team_season_id = team_seasons.id
    and media.asset_kind = 'team_logo'
    and media.is_primary
    and media.rights_confirmed
  order by media.updated_at desc
  limit 1
) as team_logo on true
where not stats.is_multi_team_aggregate;

grant select on public.nba_lineup_player_pool to anon, authenticated;

comment on view public.nba_lineup_player_pool is
  'Read-only player-team-season pool for the Lineup Lab. Excludes provider multi-team aggregate rows.';
