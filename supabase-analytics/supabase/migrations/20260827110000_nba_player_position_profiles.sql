-- Verified Basketball Reference player-profile positions for Lineup Lab.
--
-- A historical Basketball Reference totals row exposes one listed `Pos` for
-- the player-team-season. That remains the historical role evidence. A player
-- profile can list several real positions across a career, so this separate
-- record adds flexible solver eligibility without rewriting season data or
-- claiming possession-level role minutes.

create table if not exists public.nba_player_position_profiles (
  player_id uuid not null references public.nba_players(id) on delete cascade,
  source_name text not null check (length(trim(source_name)) > 0),
  source_scope text not null default 'career_profile'
    check (source_scope = 'career_profile'),
  source_url text not null check (length(trim(source_url)) > 0),
  source_position_text text not null default '' check (length(source_position_text) <= 500),
  eligible_positions text[] not null default '{}'::text[]
    check (
      eligible_positions <@ array['PG', 'SG', 'SF', 'PF', 'C', 'G', 'F']::text[]
      and array_position(eligible_positions, null) is null
    ),
  fetch_status text not null default 'retry'
    check (fetch_status in ('found', 'no_positions', 'not_found', 'retry')),
  source_hash text not null default '' check (length(source_hash) <= 128),
  source_fetched_at timestamptz not null default now(),
  last_error text not null default '' check (length(last_error) <= 1200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (player_id, source_name, source_scope),
  constraint nba_player_position_profiles_status_matches_positions check (
    (fetch_status = 'found' and cardinality(eligible_positions) > 0)
    or (fetch_status <> 'found' and cardinality(eligible_positions) = 0)
  )
);

create index if not exists nba_player_position_profiles_pending_idx
  on public.nba_player_position_profiles (source_name, source_scope, fetch_status, source_fetched_at);

drop trigger if exists nba_player_position_profiles_set_updated_at on public.nba_player_position_profiles;
create trigger nba_player_position_profiles_set_updated_at
before update on public.nba_player_position_profiles
for each row execute function public.set_nba_records_updated_at();

-- Browser clients can see only verified, read-only profile evidence already
-- exposed through the Lineup Lab view. Imports run through the linked database
-- CLI; there is deliberately no browser write policy or public retry/error log.
alter table public.nba_player_position_profiles enable row level security;
revoke all on public.nba_player_position_profiles from public, anon, authenticated;
grant select on public.nba_player_position_profiles to anon, authenticated;
drop policy if exists "Public can read analytics NBA player position profiles" on public.nba_player_position_profiles;
create policy "Public can read analytics NBA player position profiles"
on public.nba_player_position_profiles for select to anon, authenticated
using (fetch_status = 'found');

comment on table public.nba_player_position_profiles is
  'Source-backed career-profile position eligibility. It complements, but never replaces, the historical position listed on each player-team-season row.';

-- Preserve the optimized, one-team-season Lineup Lab view from the preceding
-- migration and append profile evidence at the end. Existing browser fields
-- stay stable while the solver gains only documented alternate positions.
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
  stats.source_url,
  team_context.team_total_minutes,
  team_context.estimated_team_possessions,
  league_context.league_points_per_36,
  league_context.league_rebounds_per_36,
  league_context.league_assists_per_36,
  league_context.league_steals_per_36,
  league_context.league_blocks_per_36,
  league_context.league_turnovers_per_36,
  league_context.league_efg_pct,
  league_context.league_three_pct,
  coalesce(advanced_metrics.values, '{}'::jsonb) as advanced_metrics,
  exists (
    select 1
    from public.nba_player_team_season_stats as playoff_stats
    where playoff_stats.player_id = stats.player_id
      and playoff_stats.season_end_year = stats.season_end_year
      and playoff_stats.team_code = stats.team_code
      and playoff_stats.season_phase = 'playoffs'
      and not playoff_stats.is_multi_team_aggregate
  ) as postseason_available,
  coalesce(position_profile.eligible_positions, '{}'::text[]) as career_profile_positions,
  coalesce(position_profile.source_position_text, '') as career_profile_position_text,
  coalesce(position_profile.source_url, '') as career_profile_source_url
from public.nba_player_team_season_stats as stats
join public.nba_players as players on players.id = stats.player_id
join public.nba_seasons as seasons on seasons.season_end_year = stats.season_end_year
join public.nba_team_seasons as team_seasons on team_seasons.id = stats.team_season_id
join lateral (
  select
    sum(coalesce(team_stats.minutes_played, 0))::numeric as team_total_minutes,
    (
      sum(coalesce(team_stats.field_goals_attempted, 0))::numeric
      + 0.44 * sum(coalesce(team_stats.free_throws_attempted, 0))::numeric
      - sum(coalesce(team_stats.offensive_rebounds, 0))::numeric
      + sum(coalesce(team_stats.turnovers, 0))::numeric
    ) as estimated_team_possessions
  from public.nba_player_team_season_stats as team_stats
  where not team_stats.is_multi_team_aggregate
    and team_stats.season_end_year = stats.season_end_year
    and team_stats.season_phase = stats.season_phase
    and team_stats.team_code = stats.team_code
) as team_context on true
join lateral (
  select
    36 * sum(coalesce(league_stats.points, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_points_per_36,
    36 * sum(coalesce(league_stats.total_rebounds, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_rebounds_per_36,
    36 * sum(coalesce(league_stats.assists, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_assists_per_36,
    36 * sum(coalesce(league_stats.steals, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_steals_per_36,
    36 * sum(coalesce(league_stats.blocks, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_blocks_per_36,
    36 * sum(coalesce(league_stats.turnovers, 0))::numeric
      / nullif(sum(coalesce(league_stats.minutes_played, 0)), 0) as league_turnovers_per_36,
    (
      sum(coalesce(league_stats.field_goals_made, 0))::numeric
      + 0.5 * sum(coalesce(league_stats.three_point_field_goals_made, 0))::numeric
    ) / nullif(sum(coalesce(league_stats.field_goals_attempted, 0)), 0) as league_efg_pct,
    sum(coalesce(league_stats.three_point_field_goals_made, 0))::numeric
      / nullif(sum(coalesce(league_stats.three_point_field_goals_attempted, 0)), 0) as league_three_pct
  from public.nba_player_team_season_stats as league_stats
  where not league_stats.is_multi_team_aggregate
    and league_stats.season_end_year = stats.season_end_year
    and league_stats.season_phase = stats.season_phase
) as league_context on true
left join lateral (
  select jsonb_object_agg(metrics.metric_code, metrics.metric_value) as values
  from public.nba_player_team_season_metric_values as metrics
  where metrics.stat_id = stats.id
) as advanced_metrics on true
left join lateral (
  select profile.eligible_positions, profile.source_position_text, profile.source_url
  from public.nba_player_position_profiles as profile
  where profile.player_id = players.id
    and profile.source_name = 'basketball_reference'
    and profile.source_scope = 'career_profile'
    and profile.fetch_status = 'found'
  order by profile.source_fetched_at desc
  limit 1
) as position_profile on true
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

revoke all on public.nba_lineup_player_pool from public, anon, authenticated;
grant select on public.nba_lineup_player_pool to anon, authenticated;

comment on view public.nba_lineup_player_pool is
  'Read-only team-stint pool for Lineup Lab. Career-profile positions are verified eligibility evidence, not season-specific position-minute tracking.';
