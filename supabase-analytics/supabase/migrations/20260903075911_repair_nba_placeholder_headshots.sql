-- Restore the original Basketball Reference asset URLs for the twelve NBA
-- records that were incorrectly pointed at one byte-identical FreeImage
-- placeholder. The source pages and rights metadata are deliberately retained.
do $$
declare
  corrected_rows integer;
  expected_rows constant integer := 12;
begin
with corrections(player_id, asset_url) as (
  values
    ('3d11008d-3acf-438e-bc74-e6887094513e'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/hopsosc01.jpg'),
    ('42ef5289-b851-42c8-8078-3d5218fb7639'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/baglema02.jpg'),
    ('66ce6398-74e5-440f-9777-16490ff9ff38'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/hurtma01.jpg'),
    ('79d70163-b747-4169-988e-fd95b4a0a94e'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/wheelph02.jpg'),
    ('bd0aafee-a4c6-454e-a508-855996415f22'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/comanch01.jpg'),
    ('ca88a549-c914-42ee-8eb7-61e9a0ce1d06'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/swordcr01.jpg'),
    ('ce469fa8-bf70-4abb-827a-bc1784e30fed'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/basspa01.jpg'),
    ('eaae582b-221c-4912-b418-e3f86f3d9783'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/willima11.jpg'),
    ('edfc47da-159e-44bd-ad4c-2d8880d1d78c'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/palmetr01.jpg'),
    ('f4d4b87b-23a4-4329-8462-5c09cc7ceb3b'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/caverah01.jpg'),
    ('f6f13b2e-c50d-4a4c-be32-236f725d4243'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/allenti01.jpg'),
    ('fb558776-bb88-4e7c-92f4-d4709d9be3a8'::uuid, 'https://www.basketball-reference.com/req/202605210/images/headshots/yorkga01.jpg')
),
source_validation as (
  select
    count(*)::integer as source_rows,
    count(distinct player_id)::integer as unique_players,
    count(distinct asset_url)::integer as unique_urls
  from corrections
)
update public.nba_media_assets as media
set
  asset_url = corrections.asset_url,
  updated_at = now()
from corrections
cross join source_validation
where media.player_id = corrections.player_id
  and media.asset_kind = 'headshot'
  and media.is_primary
  and media.rights_confirmed
  and media.asset_url = 'https://iili.io/nHzfRl2.jpg'
  and source_validation.source_rows = expected_rows
  and source_validation.unique_players = expected_rows
  and source_validation.unique_urls = expected_rows;

get diagnostics corrected_rows = row_count;
if corrected_rows <> expected_rows then
  raise exception 'Expected % NBA placeholder-headshot repairs; changed %.', expected_rows, corrected_rows;
end if;
end $$;
