set local lock_timeout = '5s';
set local statement_timeout = '2min';
create temporary table _reviewed_identity_repairs on commit drop as
select * from jsonb_to_recordset('[{"athlete_id":"6928e0d0-5fdd-4e87-b376-6b14f711a85d","league_code":"MLB","source_name":"baseball_reference","external_id":"leebr02","old_name":"Brooks Lee #","old_normalized_name":"brooks lee #","new_name":"Brooks Lee","normalized_name":"brooks lee"},{"athlete_id":"d3d3199f-41b7-4896-acc8-7c7cd812ee5f","league_code":"MLB","source_name":"baseball_reference","external_id":"jonesch06","old_name":"Chipper Jones #","old_normalized_name":"chipper jones #","new_name":"Chipper Jones","normalized_name":"chipper jones"},{"athlete_id":"51c8029b-90dc-426a-8b8a-eafcfe045857","league_code":"MLB","source_name":"baseball_reference","external_id":"hollade01","old_name":"Derek Holland #","old_normalized_name":"derek holland #","new_name":"Derek Holland","normalized_name":"derek holland"},{"athlete_id":"678baa69-972a-4a76-a5eb-890d9ca80fee","league_code":"MLB","source_name":"baseball_reference","external_id":"storedr01","old_name":"Drew Storen #","old_normalized_name":"drew storen #","new_name":"Drew Storen","normalized_name":"drew storen"},{"athlete_id":"ff402f52-5c20-4c03-92c2-80ef9d0eff03","league_code":"MLB","source_name":"baseball_reference","external_id":"delacel01","old_name":"Elly De La Cruz #","old_normalized_name":"elly de la cruz #","new_name":"Elly De La Cruz","normalized_name":"elly de la cruz"},{"athlete_id":"010a8daa-ea1a-4b89-bf08-e3c808550436","league_code":"MLB","source_name":"baseball_reference","external_id":"varitja01","old_name":"Jason Varitek #","old_normalized_name":"jason varitek #","new_name":"Jason Varitek","normalized_name":"jason varitek"},{"athlete_id":"c866956f-e5f3-496d-8c61-ed6a73cf73cd","league_code":"MLB","source_name":"baseball_reference","external_id":"reyesjo01","old_name":"José Reyes #","old_normalized_name":"josé reyes #","new_name":"José Reyes","normalized_name":"josé reyes"},{"athlete_id":"90de7c80-db7c-48b2-bebe-0cb15cba735f","league_code":"MLB","source_name":"baseball_reference","external_id":"profaju01","old_name":"Jurickson Profar #","old_normalized_name":"jurickson profar #","new_name":"Jurickson Profar","normalized_name":"jurickson profar"},{"athlete_id":"5744144e-c25d-4818-ad25-25ca83e5bca2","league_code":"MLB","source_name":"baseball_reference","external_id":"teixema01","old_name":"Mark Teixeira #","old_normalized_name":"mark teixeira #","new_name":"Mark Teixeira","normalized_name":"mark teixeira"},{"athlete_id":"4c96cef9-aa58-4ce4-93ac-106f5963f4e0","league_code":"MLB","source_name":"baseball_reference","external_id":"mantlmi01","old_name":"Mickey Mantle #","old_normalized_name":"mickey mantle #","new_name":"Mickey Mantle","normalized_name":"mickey mantle"},{"athlete_id":"d2784452-efb1-45dd-9471-95e06b50689e","league_code":"MLB","source_name":"baseball_reference","external_id":"sandopa01","old_name":"Pablo Sandoval #","old_normalized_name":"pablo sandoval #","new_name":"Pablo Sandoval","normalized_name":"pablo sandoval"},{"athlete_id":"afd33643-8df2-4451-b4de-48ec54e5470b","league_code":"MLB","source_name":"baseball_reference","external_id":"sorenza01","old_name":"Zach Sorensen #","old_normalized_name":"zach sorensen #","new_name":"Zach Sorensen","normalized_name":"zach sorensen"},{"athlete_id":"953e6a2b-e805-411c-872d-95c301e813c1","league_code":"MLB","source_name":"baseball_reference","external_id":"walteza01","old_name":"Zach Walters #","old_normalized_name":"zach walters #","new_name":"Zach Walters","normalized_name":"zach walters"}]'::jsonb) as repairs(
  athlete_id uuid, league_code text, source_name text, external_id text, old_name text, old_normalized_name text, new_name text, normalized_name text
);

do $$
begin
  if (select count(*) from _reviewed_identity_repairs) <> 13 then
    raise exception 'Reviewed repair input count does not reconcile';
  end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athletes athletes on athletes.id = repairs.athlete_id
    where athletes.id is null or athletes.identity_status <> 'active'
      or not (
        (athletes.canonical_name = repairs.old_name and athletes.normalized_name = repairs.old_normalized_name)
        or (athletes.canonical_name = repairs.new_name and athletes.normalized_name = repairs.normalized_name)
      )
  ) then raise exception 'Athlete identity drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    where not exists (
      select 1 from public.athlete_aliases aliases
      where aliases.athlete_id = repairs.athlete_id and aliases.league_code = repairs.league_code
        and ((aliases.alias = repairs.old_name and aliases.normalized_alias = repairs.old_normalized_name)
          or (aliases.alias = repairs.new_name and aliases.normalized_alias = repairs.normalized_name))
        and aliases.review_state = 'verified'
    )
  ) then raise exception 'Verified alias drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athlete_league_memberships memberships
      on memberships.athlete_id = repairs.athlete_id
     and memberships.league_code = repairs.league_code
    where memberships.membership_status is distinct from 'verified'
  ) then raise exception 'Verified membership drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athlete_external_ids external_ids
      on external_ids.athlete_id = repairs.athlete_id
     and external_ids.league_code = repairs.league_code
     and external_ids.source_name = repairs.source_name
     and external_ids.external_id = repairs.external_id
    where external_ids.athlete_id is null
  ) then raise exception 'Provider external ID drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.mlb_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'MLB' and (players.athlete_id is null or not (
      (players.full_name = repairs.old_name and players.normalized_name = repairs.old_normalized_name)
      or (players.full_name = repairs.new_name and players.normalized_name = repairs.normalized_name)
    ))
  ) then raise exception 'MLB profile drift blocks the reviewed repair'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.nfl_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'NFL' and (players.athlete_id is null or not (
      (players.full_name = repairs.old_name and players.normalized_name = repairs.old_normalized_name)
      or (players.full_name = repairs.new_name and players.normalized_name = repairs.normalized_name)
    ))
  ) then raise exception 'NFL profile drift blocks the reviewed repair'; end if;
end $$;

update public.athlete_aliases aliases
set alias = repairs.new_name,
    normalized_alias = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where aliases.athlete_id = repairs.athlete_id
  and aliases.league_code = repairs.league_code
  and aliases.alias = repairs.old_name
  and aliases.review_state = 'verified';

update public.athletes athletes
set canonical_name = repairs.new_name,
    normalized_name = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where athletes.id = repairs.athlete_id and athletes.canonical_name = repairs.old_name;

update public.mlb_players players
set full_name = repairs.new_name,
    normalized_name = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where repairs.league_code = 'MLB' and players.athlete_id = repairs.athlete_id
  and players.full_name = repairs.old_name;

update public.nfl_players players
set full_name = repairs.new_name,
    normalized_name = repairs.normalized_name,
    updated_at = now()
from _reviewed_identity_repairs repairs
where repairs.league_code = 'NFL' and players.athlete_id = repairs.athlete_id
  and players.full_name = repairs.old_name;

do $$
begin
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.athletes athletes on athletes.id = repairs.athlete_id
    where athletes.canonical_name <> repairs.new_name
      or athletes.normalized_name <> repairs.normalized_name
  ) then raise exception 'Athlete repair readback failed'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    where not exists (
      select 1 from public.athlete_aliases aliases
      where aliases.athlete_id = repairs.athlete_id and aliases.league_code = repairs.league_code
        and aliases.alias = repairs.new_name
        and aliases.normalized_alias = repairs.normalized_name
        and aliases.review_state = 'verified'
    )
  ) then raise exception 'Alias repair readback failed'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.mlb_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'MLB'
      and (players.full_name <> repairs.new_name
        or players.normalized_name <> repairs.normalized_name)
  ) then raise exception 'MLB profile repair readback failed'; end if;
  if exists (
    select 1 from _reviewed_identity_repairs repairs
    left join public.nfl_players players on players.athlete_id = repairs.athlete_id
    where repairs.league_code = 'NFL'
      and (players.full_name <> repairs.new_name
        or players.normalized_name <> repairs.normalized_name)
  ) then raise exception 'NFL profile repair readback failed'; end if;
end $$;

