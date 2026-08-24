begin;

create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(29);

select has_table('public', 'sports', 'Universal sports table exists');
select has_table('public', 'sports_leagues', 'Universal league table exists');
select has_table('public', 'athletes', 'Universal athlete table exists');
select has_table('public', 'athlete_league_memberships', 'League memberships exist');
select has_table('public', 'athlete_aliases', 'League-scoped aliases exist');
select has_table('public', 'athlete_external_ids', 'Universal external IDs exist');
select has_table('public', 'product_athlete_mappings', 'Universal product mappings exist');
select has_column('public', 'nba_players', 'athlete_id', 'NBA profiles reference universal athletes');
select is(
  public.normalize_athlete_name('  Kareem   Abdul-Jabbar  '),
  'kareem abdul-jabbar',
  'Name normalization collapses whitespace without stripping meaningful punctuation'
);

insert into public.nba_players (
  id,
  full_name,
  normalized_name,
  birth_date,
  height_inches,
  weight_pounds,
  primary_position,
  country,
  debut_season_end_year,
  final_season_end_year
)
values (
  '10000000-0000-4000-8000-000000000001',
  'Test Player',
  'test player',
  '1980-01-02',
  78,
  210,
  'G',
  'USA',
  2004,
  2004
);

select is(
  (select athlete_id from public.nba_players where id = '10000000-0000-4000-8000-000000000001'),
  '10000000-0000-4000-8000-000000000001'::uuid,
  'A new NBA profile receives a deterministic universal athlete ID'
);
select is(
  (select canonical_name from public.athletes where id = '10000000-0000-4000-8000-000000000001'),
  'Test Player',
  'The NBA profile trigger creates its universal athlete identity'
);
select ok(
  exists (
    select 1
    from public.athlete_league_memberships
    where athlete_id = '10000000-0000-4000-8000-000000000001'
      and league_code = 'NBA'
      and membership_status = 'verified'
  ),
  'The NBA membership is verified'
);
select ok(
  exists (
    select 1
    from public.athlete_aliases
    where athlete_id = '10000000-0000-4000-8000-000000000001'
      and league_code = 'NBA'
      and normalized_alias = 'test player'
      and alias_type = 'canonical'
      and review_state = 'verified'
  ),
  'The NBA canonical alias is verified'
);

insert into public.nba_player_external_ids (
  source_name,
  external_id,
  player_id,
  is_primary_for_source
)
values (
  'test_provider',
  'test-player-1',
  '10000000-0000-4000-8000-000000000001',
  true
);

select ok(
  exists (
    select 1
    from public.athlete_external_ids
    where athlete_id = '10000000-0000-4000-8000-000000000001'
      and league_code = 'NBA'
      and source_name = 'test_provider'
      and external_id = 'test-player-1'
      and is_primary_for_source
  ),
  'NBA external IDs synchronize to the universal identity'
);

select ok(
  not has_table_privilege('anon', 'public.product_athlete_mappings', 'SELECT'),
  'Anonymous users cannot read mapping evidence directly'
);
select ok(
  has_function_privilege('anon', 'public.get_nba_product_slab_stats(bigint)', 'EXECUTE'),
  'Anonymous shoppers can execute only the fixed-shape stats RPC'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.product_athlete_mappings'::regclass),
  'Product-athlete mappings enforce RLS'
);

insert into public.products (
  id,
  name,
  category,
  league,
  sport,
  player_athlete,
  sale_status,
  is_deleted
)
values (
  9000001,
  '2003-04 Test Player Rookie',
  'Basketball',
  'NBA',
  'Basketball',
  'Test Player',
  'available',
  false
);

insert into public.nba_franchises (id, franchise_code, display_name)
values
  ('20000000-0000-4000-8000-000000000001', 'TST', 'Test Franchise'),
  ('20000000-0000-4000-8000-000000000002', 'QST', 'Second Test Franchise');

insert into public.nba_team_seasons (
  id,
  franchise_id,
  season_end_year,
  team_code,
  team_name,
  city
)
values
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    2004,
    'TST',
    'Test Team',
    'Test City'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    2004,
    'QST',
    'Second Test Team',
    'Second City'
  );

insert into public.nba_player_team_season_stats (
  player_id,
  season_end_year,
  team_season_id,
  team_code,
  season_phase,
  is_multi_team_aggregate,
  games_played,
  games_started,
  minutes_played,
  field_goals_made,
  field_goals_attempted,
  three_point_field_goals_made,
  three_point_field_goals_attempted,
  free_throws_made,
  free_throws_attempted,
  total_rebounds,
  assists,
  steals,
  blocks,
  turnovers,
  points,
  source_name,
  source_record_id
)
values
  (
    '10000000-0000-4000-8000-000000000001',
    2004,
    '30000000-0000-4000-8000-000000000001',
    'TST',
    'regular',
    false,
    10,
    10,
    350,
    70,
    140,
    20,
    50,
    40,
    50,
    80,
    60,
    20,
    10,
    30,
    200,
    'test_provider',
    'test-player-2004-tst'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    2004,
    '30000000-0000-4000-8000-000000000002',
    'QST',
    'regular',
    false,
    5,
    5,
    150,
    35,
    70,
    10,
    25,
    20,
    25,
    40,
    30,
    10,
    5,
    15,
    100,
    'test_provider',
    'test-player-2004-qst'
  );

insert into public.nba_player_team_season_metric_values (
  stat_id,
  metric_code,
  metric_value,
  source_name
)
select stats.id, metric.metric_code, metric.metric_value, 'test_provider'
from public.nba_player_team_season_stats as stats
cross join lateral (
  values
    ('true_shooting_percentage', case stats.team_code when 'TST' then 0.600 else 0.500 end),
    ('box_plus_minus', case stats.team_code when 'TST' then 5.000 else 3.000 end),
    ('value_over_replacement_player', case stats.team_code when 'TST' then 2.000 else 1.000 end)
) as metric(metric_code, metric_value)
where stats.player_id = '10000000-0000-4000-8000-000000000001'
  and stats.season_end_year = 2004;

insert into public.nba_media_assets (
  player_id,
  asset_kind,
  asset_url,
  alt_text,
  source_name,
  rights_confirmed,
  is_primary
)
values (
  '10000000-0000-4000-8000-000000000001',
  'headshot',
  'https://example.test/test-player.jpg',
  'Test Player',
  'test_provider',
  false,
  true
);

insert into public.product_athlete_mappings (
  product_id,
  athlete_id,
  league_code,
  subject_order,
  subject_role,
  depicted_season_label,
  depicted_season_start_year,
  depicted_season_end_year,
  season_mapping_method,
  match_method,
  match_confidence,
  review_state,
  source_player_text
)
values (
  9000001,
  '10000000-0000-4000-8000-000000000001',
  'NBA',
  1,
  'primary',
  '2003-04',
  2003,
  2004,
  'title_season_range',
  'catalog_player_exact',
  1,
  'auto_verified',
  'Test Player'
);

select is(
  public.get_nba_product_slab_stats(9000001)->>'provider',
  'NBA',
  'The public payload names its league adapter'
);
select is(
  jsonb_array_length(public.get_nba_product_slab_stats(9000001)->'players'),
  1,
  'One verified mapping creates one player panel'
);
select is(
  public.get_nba_product_slab_stats(9000001)#>>'{players,0,player,name}',
  'Test Player',
  'The RPC returns the mapped NBA profile name'
);
select is(
  (public.get_nba_product_slab_stats(9000001)#>>'{players,0,mapping,depictedSeasonEndYear}')::integer,
  2004,
  'The RPC preserves reviewed card-season context'
);
select is(
  (public.get_nba_product_slab_stats(9000001)#>>'{players,0,seasons,0,gamesPlayed}')::integer,
  15,
  'Two team stints aggregate games without using a duplicate provider total'
);
select is(
  (public.get_nba_product_slab_stats(9000001)#>>'{players,0,seasons,0,points}')::integer,
  300,
  'Two team stints aggregate additive box-score totals'
);
select is(
  round((public.get_nba_product_slab_stats(9000001)#>>'{players,0,seasons,0,trueShootingPercentage}')::numeric, 3),
  0.570::numeric,
  'Rate metrics use minutes-weighted team-stint aggregation'
);
select is(
  (public.get_nba_product_slab_stats(9000001)#>>'{players,0,seasons,0,valueOverReplacementPlayer}')::numeric,
  3.000000::numeric,
  'Additive advanced metrics sum across team stints'
);
select is(
  public.get_nba_product_slab_stats(9000001)#>>'{players,0,player,headshotUrl}',
  null::text,
  'Unconfirmed media rights never reach the public payload'
);

update public.nba_media_assets
set rights_confirmed = true
where player_id = '10000000-0000-4000-8000-000000000001';

select is(
  public.get_nba_product_slab_stats(9000001)#>>'{players,0,player,headshotUrl}',
  'https://example.test/test-player.jpg',
  'Rights-confirmed primary headshots can reach the public payload'
);

update public.product_athlete_mappings
set review_state = 'needs_review'
where product_id = 9000001;

select is(
  jsonb_array_length(public.get_nba_product_slab_stats(9000001)->'players'),
  0,
  'Unverified mappings are withheld from shoppers'
);

update public.product_athlete_mappings
set review_state = 'auto_verified'
where product_id = 9000001;

update public.products
set sale_status = 'sold'
where id = 9000001;

select is(
  public.get_nba_product_slab_stats(9000001),
  null::jsonb,
  'Sold products do not expose a Slab-to-Stats payload'
);

select * from finish();
rollback;
