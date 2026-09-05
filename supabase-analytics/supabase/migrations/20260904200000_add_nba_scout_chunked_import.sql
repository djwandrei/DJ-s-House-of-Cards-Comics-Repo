-- The compact Scout query payload for a single team can be larger than the
-- managed PostgREST gateway accepts reliably. Keep the immutable archive
-- contract, but let the service-role importer register a shard once and write
-- bounded, idempotent section batches. No raw archive fields or browser roles
-- are introduced by this migration.

alter table public.nba_scout_archive_shards
  add column if not exists team_context_row_count integer,
  add column if not exists player_on_off_context_row_count integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'nba_scout_archive_shards_team_context_row_count_check'
      and conrelid = 'public.nba_scout_archive_shards'::regclass
  ) then
    alter table public.nba_scout_archive_shards
      add constraint nba_scout_archive_shards_team_context_row_count_check
      check (team_context_row_count is null or team_context_row_count >= 0);
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'nba_scout_archive_shards_player_on_off_context_row_count_check'
      and conrelid = 'public.nba_scout_archive_shards'::regclass
  ) then
    alter table public.nba_scout_archive_shards
      add constraint nba_scout_archive_shards_player_on_off_context_row_count_check
      check (player_on_off_context_row_count is null or player_on_off_context_row_count >= 0);
  end if;
end;
$$;

comment on column public.nba_scout_archive_shards.team_context_row_count is
  'Expected compact team-context rows for a chunked private Scout import; null preserves compatibility with pre-chunked imports.';
comment on column public.nba_scout_archive_shards.player_on_off_context_row_count is
  'Expected compact player on/off context rows for a chunked private Scout import; null preserves compatibility with pre-chunked imports.';

create or replace function public.register_nba_scout_archive_shard(
  p_archive_import_id uuid,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_existing public.nba_scout_archive_shards%rowtype;
  v_shard jsonb;
  v_expected jsonb;
  v_team_id uuid;
  v_team_name text;
  v_gzip_relative_path text;
  v_gzip_sha256 text;
  v_gzip_bytes bigint;
  v_json_sha256 text;
  v_json_bytes bigint;
  v_team_rows integer;
  v_lineup_rows integer;
  v_on_off_rows integer;
  v_profile_rows integer;
  v_wowy_rows integer;
  v_team_context_rows integer;
  v_on_off_context_rows integer;
  v_key text;
  v_payload_sha256 text;
begin
  if p_archive_import_id is null or jsonb_typeof(p_payload) <> 'object'
     or jsonb_typeof(p_payload -> 'shard') <> 'object'
     or jsonb_typeof(p_payload -> 'expected') <> 'object'
  then
    raise exception 'Scout chunked shard registration requires an import ID plus shard and expected objects.';
  end if;
  v_shard := p_payload -> 'shard';
  v_expected := p_payload -> 'expected';
  foreach v_key in array array['team_contexts', 'lineups', 'player_on_off', 'player_on_off_contexts', 'player_profiles', 'wowy']
  loop
    if coalesce(v_expected ->> v_key, '') !~ '^\\d+$' then
      raise exception 'Scout chunked shard registration requires a non-negative expected count for %.', v_key;
    end if;
  end loop;
  begin
    v_team_id := nullif(v_shard ->> 'team_id', '')::uuid;
    v_team_name := trim(coalesce(v_shard ->> 'team_name', ''));
    v_gzip_relative_path := trim(coalesce(v_shard ->> 'gzip_relative_path', ''));
    v_gzip_sha256 := lower(trim(coalesce(v_shard ->> 'gzip_sha256', '')));
    v_gzip_bytes := nullif(v_shard ->> 'gzip_bytes', '')::bigint;
    v_json_sha256 := lower(trim(coalesce(v_shard ->> 'json_sha256', '')));
    v_json_bytes := nullif(v_shard ->> 'json_bytes', '')::bigint;
    v_team_rows := nullif(v_shard ->> 'team_row_count', '')::integer;
    v_lineup_rows := nullif(v_shard ->> 'lineup_row_count', '')::integer;
    v_on_off_rows := nullif(v_shard ->> 'player_on_off_row_count', '')::integer;
    v_profile_rows := nullif(v_shard ->> 'player_profile_row_count', '')::integer;
    v_wowy_rows := nullif(v_shard ->> 'wowy_row_count', '')::integer;
    v_team_context_rows := (v_expected ->> 'team_contexts')::integer;
    v_on_off_context_rows := (v_expected ->> 'player_on_off_contexts')::integer;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Scout chunked shard registration contains an invalid UUID or numeric value.';
  end;
  if v_team_id is null
     or v_team_name = ''
     or v_gzip_relative_path !~ '^teams/[A-Za-z0-9._-]+\\.json\\.gz$'
     or v_gzip_sha256 !~ '^[a-f0-9]{64}$'
     or v_json_sha256 !~ '^[a-f0-9]{64}$'
     or v_gzip_bytes is null or v_gzip_bytes < 1
     or v_json_bytes is null or v_json_bytes < 1
     or v_team_rows <> 1
     or v_lineup_rows is null or v_lineup_rows < 0
     or v_on_off_rows is null or v_on_off_rows < 0
     or v_profile_rows is null or v_profile_rows < 0
     or v_wowy_rows is null or v_wowy_rows < 0
     or v_lineup_rows <> (v_expected ->> 'lineups')::integer
     or v_on_off_rows <> (v_expected ->> 'player_on_off')::integer
     or v_profile_rows <> (v_expected ->> 'player_profiles')::integer
     or v_wowy_rows <> (v_expected ->> 'wowy')::integer
  then
    raise exception 'Scout chunked shard metadata is incomplete or conflicts with its expected compact rows.';
  end if;

  select * into v_import
  from public.nba_scout_archive_imports
  where id = p_archive_import_id
  for update;
  if not found then
    raise exception 'Unknown Scout archive import.';
  end if;
  if v_import.status <> 'staging' then
    raise exception 'Scout chunked shard registration is allowed only while the immutable import is staging.';
  end if;

  -- jsonb text is canonicalized by PostgreSQL. This hash binds every retry to
  -- the same source artifact identity and all six expected compact row counts.
  v_payload_sha256 := encode(
    extensions.digest(jsonb_build_object('shard', v_shard, 'expected', v_expected)::text, 'sha256'),
    'hex'
  );
  select * into v_existing
  from public.nba_scout_archive_shards
  where archive_import_id = p_archive_import_id and team_id = v_team_id
  for update;
  if found then
    if v_existing.team_name <> v_team_name
       or v_existing.gzip_relative_path <> v_gzip_relative_path
       or v_existing.gzip_sha256 <> v_gzip_sha256
       or v_existing.gzip_bytes <> v_gzip_bytes
       or v_existing.json_sha256 <> v_json_sha256
       or v_existing.json_bytes <> v_json_bytes
       or v_existing.payload_sha256 <> v_payload_sha256
       or v_existing.team_row_count <> v_team_rows
       or v_existing.lineup_row_count <> v_lineup_rows
       or v_existing.player_on_off_row_count <> v_on_off_rows
       or v_existing.player_profile_row_count <> v_profile_rows
       or v_existing.wowy_row_count <> v_wowy_rows
       or v_existing.team_context_row_count is distinct from v_team_context_rows
       or v_existing.player_on_off_context_row_count is distinct from v_on_off_context_rows
    then
      raise exception 'Existing Scout chunked shard has conflicting immutable metadata.';
    end if;
    return jsonb_build_object('archiveImportId', p_archive_import_id, 'teamId', v_team_id, 'mode', 'already-registered');
  end if;

  insert into public.nba_scout_archive_shards (
    archive_import_id, team_id, team_name, gzip_relative_path, gzip_sha256,
    gzip_bytes, json_sha256, json_bytes, payload_sha256, team_row_count,
    lineup_row_count, player_on_off_row_count, player_profile_row_count,
    wowy_row_count, team_context_row_count, player_on_off_context_row_count
  ) values (
    p_archive_import_id, v_team_id, v_team_name, v_gzip_relative_path, v_gzip_sha256,
    v_gzip_bytes, v_json_sha256, v_json_bytes, v_payload_sha256, v_team_rows,
    v_lineup_rows, v_on_off_rows, v_profile_rows, v_wowy_rows,
    v_team_context_rows, v_on_off_context_rows
  );
  return jsonb_build_object('archiveImportId', p_archive_import_id, 'teamId', v_team_id, 'mode', 'registered');
end;
$$;

create or replace function public.ingest_nba_scout_archive_shard_chunk(
  p_archive_import_id uuid,
  p_team_id uuid,
  p_section text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_shard public.nba_scout_archive_shards%rowtype;
  v_section text := lower(trim(coalesce(p_section, '')));
  v_count integer;
  v_actual integer;
  v_invalid integer;
begin
  if p_archive_import_id is null or p_team_id is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Scout chunk ingest requires an import ID, team ID, and JSON array rows.';
  end if;
  if v_section not in ('team_contexts', 'lineups', 'player_on_off', 'player_on_off_contexts', 'player_profiles', 'wowy') then
    raise exception 'Scout chunk ingest received an unsupported compact section.';
  end if;
  v_count := jsonb_array_length(p_rows);
  if v_count < 1 or v_count > 1000 then
    raise exception 'Scout chunk ingest accepts from one through 1000 compact rows.';
  end if;
  select * into v_import
  from public.nba_scout_archive_imports
  where id = p_archive_import_id
  for update;
  if not found then
    raise exception 'Unknown Scout archive import.';
  end if;
  if v_import.status <> 'staging' then
    raise exception 'Scout chunk ingest is allowed only while the immutable import is staging.';
  end if;
  select * into v_shard
  from public.nba_scout_archive_shards
  where archive_import_id = p_archive_import_id and team_id = p_team_id
  for update;
  if not found then
    raise exception 'Scout chunk ingest requires registered immutable shard metadata.';
  end if;

  if v_section = 'team_contexts' then
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      context_key text, metrics jsonb, total_possessions numeric,
      net_rating numeric, offensive_rating numeric, defensive_rating numeric
    )
    where trim(coalesce(rows.context_key, '')) = ''
       or rows.context_key <> lower(trim(rows.context_key))
       or coalesce(jsonb_typeof(rows.metrics), '') <> 'object';
    if v_invalid > 0 then raise exception 'Scout chunk contains an invalid team-context row.'; end if;
    select count(*) - count(distinct context_key) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(context_key text);
    if v_invalid > 0 then raise exception 'Scout chunk repeats a team-context identity.'; end if;
    insert into public.nba_scout_team_context_metrics (
      archive_import_id, team_id, context_key, metrics, total_possessions,
      net_rating, offensive_rating, defensive_rating
    )
    select p_archive_import_id, p_team_id, rows.context_key, rows.metrics,
      rows.total_possessions, rows.net_rating, rows.offensive_rating, rows.defensive_rating
    from jsonb_to_recordset(p_rows) as rows(
      context_key text, metrics jsonb, total_possessions numeric,
      net_rating numeric, offensive_rating numeric, defensive_rating numeric
    ) on conflict do nothing;
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      context_key text, metrics jsonb, total_possessions numeric,
      net_rating numeric, offensive_rating numeric, defensive_rating numeric
    ) join public.nba_scout_team_context_metrics as existing
      on existing.archive_import_id = p_archive_import_id
     and existing.team_id = p_team_id
     and existing.context_key = rows.context_key
    where existing.metrics is distinct from rows.metrics
       or existing.total_possessions is distinct from rows.total_possessions
       or existing.net_rating is distinct from rows.net_rating
       or existing.offensive_rating is distinct from rows.offensive_rating
       or existing.defensive_rating is distinct from rows.defensive_rating;
    if v_invalid > 0 then raise exception 'Existing Scout team-context rows conflict with this immutable chunk.'; end if;
    select count(*) into v_actual from public.nba_scout_team_context_metrics
      where archive_import_id = p_archive_import_id and team_id = p_team_id;
    if v_actual > v_shard.team_context_row_count then raise exception 'Scout team-context chunks exceed the registered expected count.'; end if;

  elsif v_section = 'lineups' then
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_ids uuid[], player_names text[], player_count smallint, semantics text,
      minutes numeric, exposure jsonb, continuity jsonb, projection jsonb, metrics jsonb,
      total_possessions numeric, net_rating numeric, offensive_rating numeric, defensive_rating numeric
    )
    where rows.player_ids is null
       or rows.player_names is null
       or rows.player_count not between 1 and 5
       or cardinality(rows.player_ids) <> rows.player_count
       or cardinality(rows.player_names) <> rows.player_count
       or cardinality(rows.player_ids) <> (select count(distinct player_id) from unnest(rows.player_ids) as members(player_id))
       or rows.player_ids <> (select array_agg(player_id order by player_id) from unnest(rows.player_ids) as members(player_id))
       or exists (select 1 from unnest(rows.player_names) as names(player_name) where trim(coalesce(names.player_name, '')) = '')
       or trim(coalesce(rows.semantics, '')) = ''
       or coalesce(jsonb_typeof(rows.exposure), '') <> 'object'
       or coalesce(jsonb_typeof(rows.continuity), '') <> 'object'
       or coalesce(jsonb_typeof(rows.projection), '') <> 'object'
       or coalesce(jsonb_typeof(rows.metrics), '') <> 'object';
    if v_invalid > 0 then raise exception 'Scout chunk contains an invalid lineup/co-presence row.'; end if;
    select count(*) - count(distinct player_ids) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(player_ids uuid[]);
    if v_invalid > 0 then raise exception 'Scout chunk repeats a lineup/co-presence identity.'; end if;
    insert into public.nba_scout_lineup_summaries (
      archive_import_id, team_id, team_name, player_ids, player_names, player_count,
      semantics, minutes, exposure, continuity, projection, metrics, total_possessions,
      net_rating, offensive_rating, defensive_rating
    )
    select p_archive_import_id, p_team_id, v_shard.team_name, rows.player_ids,
      rows.player_names, rows.player_count, rows.semantics, rows.minutes, rows.exposure,
      rows.continuity, rows.projection, rows.metrics, rows.total_possessions,
      rows.net_rating, rows.offensive_rating, rows.defensive_rating
    from jsonb_to_recordset(p_rows) as rows(
      player_ids uuid[], player_names text[], player_count smallint, semantics text,
      minutes numeric, exposure jsonb, continuity jsonb, projection jsonb, metrics jsonb,
      total_possessions numeric, net_rating numeric, offensive_rating numeric, defensive_rating numeric
    ) on conflict do nothing;
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_ids uuid[], player_names text[], player_count smallint, semantics text,
      minutes numeric, exposure jsonb, continuity jsonb, projection jsonb, metrics jsonb,
      total_possessions numeric, net_rating numeric, offensive_rating numeric, defensive_rating numeric
    ) join public.nba_scout_lineup_summaries as existing
      on existing.archive_import_id = p_archive_import_id
     and existing.team_id = p_team_id
     and existing.player_ids = rows.player_ids
    where existing.team_name is distinct from v_shard.team_name
       or existing.player_names is distinct from rows.player_names
       or existing.player_count is distinct from rows.player_count
       or existing.semantics is distinct from rows.semantics
       or existing.minutes is distinct from rows.minutes
       or existing.exposure is distinct from rows.exposure
       or existing.continuity is distinct from rows.continuity
       or existing.projection is distinct from rows.projection
       or existing.metrics is distinct from rows.metrics
       or existing.total_possessions is distinct from rows.total_possessions
       or existing.net_rating is distinct from rows.net_rating
       or existing.offensive_rating is distinct from rows.offensive_rating
       or existing.defensive_rating is distinct from rows.defensive_rating;
    if v_invalid > 0 then raise exception 'Existing Scout lineup rows conflict with this immutable chunk.'; end if;
    select count(*) into v_actual from public.nba_scout_lineup_summaries
      where archive_import_id = p_archive_import_id and team_id = p_team_id;
    if v_actual > v_shard.lineup_row_count then raise exception 'Scout lineup chunks exceed the registered expected count.'; end if;

  elsif v_section = 'player_on_off' then
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, player_name text, on_minutes numeric, off_minutes numeric,
      on_off_net_rating numeric, exposure jsonb, scope jsonb, differences jsonb
    )
    where rows.player_id is null
       or trim(coalesce(rows.player_name, '')) = ''
       or coalesce(jsonb_typeof(rows.exposure), '') <> 'object'
       or coalesce(jsonb_typeof(rows.scope), '') <> 'object'
       or coalesce(jsonb_typeof(rows.differences), '') <> 'object';
    if v_invalid > 0 then raise exception 'Scout chunk contains an invalid player on/off summary.'; end if;
    select count(*) - count(distinct player_id) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(player_id uuid);
    if v_invalid > 0 then raise exception 'Scout chunk repeats a player on/off identity.'; end if;
    insert into public.nba_scout_player_on_off_summaries (
      archive_import_id, team_id, team_name, player_id, player_name, on_minutes,
      off_minutes, on_off_net_rating, exposure, scope, differences
    )
    select p_archive_import_id, p_team_id, v_shard.team_name, rows.player_id,
      rows.player_name, rows.on_minutes, rows.off_minutes, rows.on_off_net_rating,
      rows.exposure, rows.scope, rows.differences
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, player_name text, on_minutes numeric, off_minutes numeric,
      on_off_net_rating numeric, exposure jsonb, scope jsonb, differences jsonb
    ) on conflict do nothing;
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, player_name text, on_minutes numeric, off_minutes numeric,
      on_off_net_rating numeric, exposure jsonb, scope jsonb, differences jsonb
    ) join public.nba_scout_player_on_off_summaries as existing
      on existing.archive_import_id = p_archive_import_id
     and existing.team_id = p_team_id
     and existing.player_id = rows.player_id
    where existing.team_name is distinct from v_shard.team_name
       or existing.player_name is distinct from rows.player_name
       or existing.on_minutes is distinct from rows.on_minutes
       or existing.off_minutes is distinct from rows.off_minutes
       or existing.on_off_net_rating is distinct from rows.on_off_net_rating
       or existing.exposure is distinct from rows.exposure
       or existing.scope is distinct from rows.scope
       or existing.differences is distinct from rows.differences;
    if v_invalid > 0 then raise exception 'Existing Scout player on/off rows conflict with this immutable chunk.'; end if;
    select count(*) into v_actual from public.nba_scout_player_on_off_summaries
      where archive_import_id = p_archive_import_id and team_id = p_team_id;
    if v_actual > v_shard.player_on_off_row_count then raise exception 'Scout player on/off chunks exceed the registered expected count.'; end if;

  elsif v_section = 'player_on_off_contexts' then
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, partition text, context_key text, metrics jsonb,
      total_possessions numeric, net_rating numeric, offensive_rating numeric, defensive_rating numeric
    )
    where rows.player_id is null
       or rows.partition not in ('on', 'off')
       or trim(coalesce(rows.context_key, '')) = ''
       or rows.context_key <> lower(trim(rows.context_key))
       or coalesce(jsonb_typeof(rows.metrics), '') <> 'object'
       or not exists (
         select 1 from public.nba_scout_player_on_off_summaries as on_off
         where on_off.archive_import_id = p_archive_import_id
           and on_off.team_id = p_team_id
           and on_off.player_id = rows.player_id
       );
    if v_invalid > 0 then raise exception 'Scout chunk contains an invalid player on/off context.'; end if;
    select count(*) - count(distinct (player_id, partition, context_key)) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(player_id uuid, partition text, context_key text);
    if v_invalid > 0 then raise exception 'Scout chunk repeats a player on/off context identity.'; end if;
    insert into public.nba_scout_player_on_off_context_metrics (
      archive_import_id, team_id, player_id, partition, context_key, metrics,
      total_possessions, net_rating, offensive_rating, defensive_rating
    )
    select p_archive_import_id, p_team_id, rows.player_id, rows.partition,
      rows.context_key, rows.metrics, rows.total_possessions, rows.net_rating,
      rows.offensive_rating, rows.defensive_rating
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, partition text, context_key text, metrics jsonb,
      total_possessions numeric, net_rating numeric, offensive_rating numeric, defensive_rating numeric
    ) on conflict do nothing;
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, partition text, context_key text, metrics jsonb,
      total_possessions numeric, net_rating numeric, offensive_rating numeric, defensive_rating numeric
    ) join public.nba_scout_player_on_off_context_metrics as existing
      on existing.archive_import_id = p_archive_import_id
     and existing.team_id = p_team_id
     and existing.player_id = rows.player_id
     and existing.partition = rows.partition
     and existing.context_key = rows.context_key
    where existing.metrics is distinct from rows.metrics
       or existing.total_possessions is distinct from rows.total_possessions
       or existing.net_rating is distinct from rows.net_rating
       or existing.offensive_rating is distinct from rows.offensive_rating
       or existing.defensive_rating is distinct from rows.defensive_rating;
    if v_invalid > 0 then raise exception 'Existing Scout player on/off context rows conflict with this immutable chunk.'; end if;
    select count(*) into v_actual from public.nba_scout_player_on_off_context_metrics
      where archive_import_id = p_archive_import_id and team_id = p_team_id;
    if v_actual > v_shard.player_on_off_context_row_count then raise exception 'Scout player on/off context chunks exceed the registered expected count.'; end if;

  elsif v_section = 'player_profiles' then
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, player_name text, games_appeared integer, minutes numeric, profile jsonb
    )
    where rows.player_id is null
       or trim(coalesce(rows.player_name, '')) = ''
       or coalesce(jsonb_typeof(rows.profile), '') <> 'object'
       or not exists (
         select 1 from public.nba_scout_player_on_off_summaries as on_off
         where on_off.archive_import_id = p_archive_import_id
           and on_off.team_id = p_team_id
           and on_off.player_id = rows.player_id
       );
    if v_invalid > 0 then raise exception 'Scout chunk contains an invalid player profile.'; end if;
    select count(*) - count(distinct player_id) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(player_id uuid);
    if v_invalid > 0 then raise exception 'Scout chunk repeats a player profile identity.'; end if;
    insert into public.nba_scout_player_profiles (
      archive_import_id, team_id, team_name, player_id, player_name, games_appeared, minutes, profile
    )
    select p_archive_import_id, p_team_id, v_shard.team_name, rows.player_id,
      rows.player_name, rows.games_appeared, rows.minutes, rows.profile
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, player_name text, games_appeared integer, minutes numeric, profile jsonb
    ) on conflict do nothing;
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_id uuid, player_name text, games_appeared integer, minutes numeric, profile jsonb
    ) join public.nba_scout_player_profiles as existing
      on existing.archive_import_id = p_archive_import_id
     and existing.team_id = p_team_id
     and existing.player_id = rows.player_id
    where existing.team_name is distinct from v_shard.team_name
       or existing.player_name is distinct from rows.player_name
       or existing.games_appeared is distinct from rows.games_appeared
       or existing.minutes is distinct from rows.minutes
       or existing.profile is distinct from rows.profile;
    if v_invalid > 0 then raise exception 'Existing Scout player profile rows conflict with this immutable chunk.'; end if;
    select count(*) into v_actual from public.nba_scout_player_profiles
      where archive_import_id = p_archive_import_id and team_id = p_team_id;
    if v_actual > v_shard.player_profile_row_count then raise exception 'Scout player profile chunks exceed the registered expected count.'; end if;

  else
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_a_id uuid, player_a_name text, player_b_id uuid, player_b_name text,
      semantics text, cell_metrics jsonb
    )
    where rows.player_a_id is null
       or rows.player_b_id is null
       or rows.player_a_id >= rows.player_b_id
       or trim(coalesce(rows.player_a_name, '')) = ''
       or trim(coalesce(rows.player_b_name, '')) = ''
       or trim(coalesce(rows.semantics, '')) = ''
       or coalesce(jsonb_typeof(rows.cell_metrics), '') <> 'object';
    if v_invalid > 0 then raise exception 'Scout chunk contains an invalid canonical WOWY row.'; end if;
    select count(*) - count(distinct (player_a_id, player_b_id)) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(player_a_id uuid, player_b_id uuid);
    if v_invalid > 0 then raise exception 'Scout chunk repeats a WOWY identity.'; end if;
    insert into public.nba_scout_wowy_summaries (
      archive_import_id, team_id, team_name, player_a_id, player_a_name, player_b_id,
      player_b_name, semantics, cell_metrics
    )
    select p_archive_import_id, p_team_id, v_shard.team_name, rows.player_a_id,
      rows.player_a_name, rows.player_b_id, rows.player_b_name, rows.semantics,
      rows.cell_metrics
    from jsonb_to_recordset(p_rows) as rows(
      player_a_id uuid, player_a_name text, player_b_id uuid, player_b_name text,
      semantics text, cell_metrics jsonb
    ) on conflict do nothing;
    select count(*) into v_invalid
    from jsonb_to_recordset(p_rows) as rows(
      player_a_id uuid, player_a_name text, player_b_id uuid, player_b_name text,
      semantics text, cell_metrics jsonb
    ) join public.nba_scout_wowy_summaries as existing
      on existing.archive_import_id = p_archive_import_id
     and existing.team_id = p_team_id
     and existing.player_a_id = rows.player_a_id
     and existing.player_b_id = rows.player_b_id
    where existing.team_name is distinct from v_shard.team_name
       or existing.player_a_name is distinct from rows.player_a_name
       or existing.player_b_name is distinct from rows.player_b_name
       or existing.semantics is distinct from rows.semantics
       or existing.cell_metrics is distinct from rows.cell_metrics;
    if v_invalid > 0 then raise exception 'Existing Scout WOWY rows conflict with this immutable chunk.'; end if;
    select count(*) into v_actual from public.nba_scout_wowy_summaries
      where archive_import_id = p_archive_import_id and team_id = p_team_id;
    if v_actual > v_shard.wowy_row_count then raise exception 'Scout WOWY chunks exceed the registered expected count.'; end if;
  end if;

  return jsonb_build_object(
    'archiveImportId', p_archive_import_id,
    'teamId', p_team_id,
    'section', v_section,
    'rowCount', v_count,
    'mode', 'ingested'
  );
end;
$$;

-- Add per-team completeness checks before the existing global counts. This is
-- required for chunked writes: a globally correct total is not enough if one
-- team is missing rows and another has extra rows.
create or replace function public.finalize_nba_scout_archive_import(p_archive_import_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_import public.nba_scout_archive_imports%rowtype;
  v_expected jsonb;
  v_actual integer;
  v_counts jsonb := '{}'::jsonb;
  v_incomplete_shards integer;
begin
  select * into v_import
  from public.nba_scout_archive_imports
  where id = p_archive_import_id
  for update;
  if not found then
    raise exception 'Unknown Scout archive import.';
  end if;
  if v_import.status = 'ready' then
    return jsonb_build_object('archiveImportId', v_import.id, 'status', 'ready', 'mode', 'already-ready');
  end if;

  select count(*) into v_incomplete_shards
  from public.nba_scout_archive_shards as shards
  where shards.archive_import_id = v_import.id
    and (
      shards.lineup_row_count <> (
        select count(*) from public.nba_scout_lineup_summaries as rows
        where rows.archive_import_id = shards.archive_import_id and rows.team_id = shards.team_id
      )
      or shards.player_on_off_row_count <> (
        select count(*) from public.nba_scout_player_on_off_summaries as rows
        where rows.archive_import_id = shards.archive_import_id and rows.team_id = shards.team_id
      )
      or shards.player_profile_row_count <> (
        select count(*) from public.nba_scout_player_profiles as rows
        where rows.archive_import_id = shards.archive_import_id and rows.team_id = shards.team_id
      )
      or shards.wowy_row_count <> (
        select count(*) from public.nba_scout_wowy_summaries as rows
        where rows.archive_import_id = shards.archive_import_id and rows.team_id = shards.team_id
      )
      or (shards.team_context_row_count is not null and shards.team_context_row_count <> (
        select count(*) from public.nba_scout_team_context_metrics as rows
        where rows.archive_import_id = shards.archive_import_id and rows.team_id = shards.team_id
      ))
      or (shards.player_on_off_context_row_count is not null and shards.player_on_off_context_row_count <> (
        select count(*) from public.nba_scout_player_on_off_context_metrics as rows
        where rows.archive_import_id = shards.archive_import_id and rows.team_id = shards.team_id
      ))
    );
  if v_incomplete_shards > 0 then
    raise exception 'Scout archive cannot finalize: % team shards are incomplete or have conflicting compact row counts.', v_incomplete_shards;
  end if;

  v_expected := v_import.expected_row_counts;
  select count(*) into v_actual from public.nba_scout_archive_shards where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('teams', v_actual);
  if v_actual <> (v_expected ->> 'teams')::integer then
    raise exception 'Scout archive cannot finalize: expected % team shards, found %.', v_expected ->> 'teams', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_lineup_summaries where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('lineups', v_actual);
  if v_actual <> (v_expected ->> 'lineups')::integer then
    raise exception 'Scout archive cannot finalize: expected % lineup summaries, found %.', v_expected ->> 'lineups', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_player_on_off_summaries where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('playerOnOff', v_actual);
  if v_actual <> (v_expected ->> 'playerOnOff')::integer then
    raise exception 'Scout archive cannot finalize: expected % player on/off summaries, found %.', v_expected ->> 'playerOnOff', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_player_profiles where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('playerProfiles', v_actual);
  if v_actual <> (v_expected ->> 'playerProfiles')::integer then
    raise exception 'Scout archive cannot finalize: expected % player profiles, found %.', v_expected ->> 'playerProfiles', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_wowy_summaries where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('wowy', v_actual);
  if v_actual <> (v_expected ->> 'wowy')::integer then
    raise exception 'Scout archive cannot finalize: expected % WOWY summaries, found %.', v_expected ->> 'wowy', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_rapm_models where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('rapmModels', v_actual);
  if v_actual <> (v_expected ->> 'rapmModels')::integer then
    raise exception 'Scout archive cannot finalize: expected % RAPM models, found %.', v_expected ->> 'rapmModels', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_rapm_players where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('rapmPlayers', v_actual);
  if v_actual <> (v_expected ->> 'rapmPlayers')::integer then
    raise exception 'Scout archive cannot finalize: expected % RAPM players, found %.', v_expected ->> 'rapmPlayers', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_team_context_metrics where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('teamContexts', v_actual);
  if v_actual <> (v_expected ->> 'teamContexts')::integer then
    raise exception 'Scout archive cannot finalize: expected % team contexts, found %.', v_expected ->> 'teamContexts', v_actual;
  end if;
  select count(*) into v_actual from public.nba_scout_player_on_off_context_metrics where archive_import_id = v_import.id;
  v_counts := v_counts || jsonb_build_object('playerOnOffContexts', v_actual);
  if v_actual <> (v_expected ->> 'playerOnOffContexts')::integer then
    raise exception 'Scout archive cannot finalize: expected % player on/off contexts, found %.', v_expected ->> 'playerOnOffContexts', v_actual;
  end if;
  update public.nba_scout_archive_imports
  set status = 'ready', completed_at = now()
  where id = v_import.id;
  return jsonb_build_object('archiveImportId', v_import.id, 'status', 'ready', 'counts', v_counts);
end;
$$;

revoke all on function public.register_nba_scout_archive_shard(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ingest_nba_scout_archive_shard_chunk(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.register_nba_scout_archive_shard(uuid, jsonb) to service_role;
grant execute on function public.ingest_nba_scout_archive_shard_chunk(uuid, uuid, text, jsonb) to service_role;

comment on function public.register_nba_scout_archive_shard(uuid, jsonb) is
  'Private idempotent Scout shard registration for bounded compact-data batches; validates immutable artifact metadata and expected row counts.';
comment on function public.ingest_nba_scout_archive_shard_chunk(uuid, uuid, text, jsonb) is
  'Private bounded idempotent compact Scout section ingestion. Browser roles remain revoked; raw PBP and nested archive payloads remain rejected.';
