-- An ADMIN-ONLY bridge, never a public data API. The commerce Edge Function
-- authenticates the user and checks the live site_admins registry first.
-- Only allowlisted derived fields leave the private NBA project. No PBP,
-- Storage paths, full context trees, keys, or signed archive URLs are returned.
create or replace function public.get_nba_lineup_scout_preview(
  p_season_end_year smallint, p_team_code text, p_player_ids uuid[]
)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_archive uuid;
  v_model jsonb;
  v_players jsonb;
begin
  if p_season_end_year not between 1980 and 2200
    or p_team_code !~ '^[A-Z0-9]{2,8}$'
    or coalesce(cardinality(p_player_ids), 0) not between 1 and 1000
    or array_position(p_player_ids, null) is not null then
    raise exception 'Invalid Scout preview scope.';
  end if;
  select id into v_archive from public.nba_scout_archive_imports
  where season_end_year = p_season_end_year and status = 'ready'
    and source_validation_passed
  order by completed_at desc, id desc limit 1;
  if v_archive is null then raise exception 'No validated Scout archive for this season.'; end if;
  select model_metadata into v_model from public.nba_scout_rapm_models
  where archive_import_id = v_archive and model_kind = 'offense_defense';
  if v_model -> 'calibration' ->> 'status' is distinct from 'validated'
    or v_model -> 'calibration' ->> 'allComponentsImproved' is distinct from 'true' then
    raise exception 'Scout offense/defense calibration is unavailable.';
  end if;
  if v_model ->> 'seasonPhase' is distinct from 'regular_in_season_tournament_play_in_playoffs_official_franchise_sportradar-nba-lineup-reconstruction-v3_possession_start_lineups' then
    raise exception 'This Scout package has an unsupported phase or reconstruction scope.';
  end if;

  -- Prefer an existing cross-provider key. Without one, require exact name AND
  -- same-season team agreement, and reject both one-to-many and many-to-one
  -- matches. These matches are explicitly labelled roster-concordance, not
  -- independently verified IDs. No fuzzy name match or global identity write.
  with requested as (
    select distinct p.id, p.full_name, t.team_name
    from public.nba_players p
    join public.nba_player_team_season_stats s on s.player_id = p.id
    join public.nba_team_seasons t on t.id = s.team_season_id
    where p.id = any(p_player_ids) and s.season_end_year = p_season_end_year
      and s.team_code = p_team_code and not s.is_multi_team_aggregate
  ), candidates as (
    select distinct r.id, profile.player_id, profile.team_id,
      case when x.external_id is not null then 'external-id' else 'exact-name-team-season' end as method
    from requested r
    left join public.nba_player_external_ids x on x.player_id = r.id and x.source_name = 'sportradar_nba'
    join public.nba_scout_player_profiles profile on profile.archive_import_id = v_archive
      and ((x.external_id is not null and x.external_id = profile.player_id::text)
        or (x.external_id is null and profile.games_appeared >= 3
          and lower(regexp_replace(profile.player_name, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(r.full_name, '[^[:alnum:]]', '', 'g'))))
      and lower(regexp_replace(profile.team_name, '[^[:alnum:]]', '', 'g')) = lower(regexp_replace(r.team_name, '[^[:alnum:]]', '', 'g'))
  ), unique_matches as (
    select c.* from candidates c
    where (select count(distinct q.player_id) from candidates q where q.id = c.id) = 1
      and (select count(distinct q.id) from candidates q where q.player_id = c.player_id) = 1
  )
  select coalesce(jsonb_object_agg(m.id::text, jsonb_build_object(
    'providerPlayerId', m.player_id, 'identityMethod', m.method,
    'offensiveRapmPer100', rapm.offensive_rapm_per_100,
    'defensiveRapmPer100', rapm.defensive_rapm_per_100,
    'displayEligible', rapm.display_eligible,
    'pairedPossessions', rapm.paired_possessions,
    'reliability', rapm.metrics -> 'ridgeReliabilityProxy',
    'alreadyRegularized', true,
    'context', jsonb_build_object(
      'games', profile.games_appeared, 'minutes', profile.minutes,
      'shooting', profile.profile -> 'shooting',
      'per100Possessions', profile.profile -> 'per100Possessions',
      'coverage', profile.profile -> 'coverage'
    )
  )), '{}'::jsonb) into v_players
  from unique_matches m
  join public.nba_scout_rapm_players rapm on rapm.archive_import_id = v_archive
    and rapm.player_id = m.player_id and rapm.model_kind = 'offense_defense'
  join public.nba_scout_player_profiles profile on profile.archive_import_id = v_archive
    and profile.team_id = m.team_id and profile.player_id = m.player_id;

  return jsonb_build_object(
    'contractVersion', 1,
    'archive', public.nba_scout_archive_descriptor(v_archive),
    'scope', jsonb_build_object('seasonEndYear', p_season_end_year, 'team', p_team_code,
      'seasonPhase', 'combined'),
    'model', v_model,
    'players', v_players,
    'contextPolicy', 'Scout O/D RAPM is primary. Basketball Reference supplies constraints and historical context. Roster-concordance is not an independently verified external ID.'
  );
end;
$$;
revoke all on function public.get_nba_lineup_scout_preview(smallint, text, uuid[]) from public, anon, authenticated;
grant execute on function public.get_nba_lineup_scout_preview(smallint, text, uuid[]) to service_role;
