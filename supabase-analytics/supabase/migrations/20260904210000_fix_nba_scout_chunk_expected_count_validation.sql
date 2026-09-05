-- Repair the first chunked-registration definition's escaped regular
-- expressions. `[0-9]` and `[.]` avoid server string-escape settings while
-- retaining the exact same immutable metadata contract.

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
    if coalesce(v_expected ->> v_key, '') !~ '^[0-9]+$' then
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
     or v_gzip_relative_path !~ '^teams/[A-Za-z0-9._-]+[.]json[.]gz$'
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

revoke all on function public.register_nba_scout_archive_shard(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.register_nba_scout_archive_shard(uuid, jsonb) to service_role;
