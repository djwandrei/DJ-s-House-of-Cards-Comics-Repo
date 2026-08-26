-- Publish only buyer-facing product fields. The base products table keeps
-- import, reconciliation, and operational metadata behind authenticated RLS.

drop policy if exists "Public can read visible products" on public.products;
revoke select on table public.products from anon;
grant select on table public.products to authenticated;

drop view if exists public.storefront_products;
create view public.storefront_products
with (security_barrier = true)
as
select
  p.id,
  p.name,
  p.category,
  p.team,
  p.year,
  p.condition,
  p.price,
  p.price_label,
  p.display_price,
  p.image,
  p.image_gallery,
  p.description,
  p.photo_host_page_url,
  p.legacy_image_label,
  p.source_page,
  p.league,
  p.sport,
  p.player_athlete,
  p.copy_count,
  p.quantity_available,
  p.checkout_enabled,
  p.checkout_price,
  p.sale_status,
  jsonb_strip_nulls(jsonb_build_object(
    'conditionNotes', p.metadata -> 'conditionNotes',
    'playerAthlete', p.metadata -> 'playerAthlete',
    'excelFields', nullif(jsonb_strip_nulls(jsonb_build_object(
      'Title', p.metadata #> '{excelFields,Title}',
      'C:Features', p.metadata #> '{excelFields,C:Features}',
      'C:Autographed', p.metadata #> '{excelFields,C:Autographed}'
    )), '{}'::jsonb)
  )) as metadata,
  p.is_featured,
  p.is_deleted,
  p.sort_rank,
  p.created_at,
  p.updated_at
from public.products p
where p.is_deleted = false
  and p.sale_status not in ('hidden', 'archived', 'sold');

revoke all on table public.storefront_products from public;
grant select on table public.storefront_products to anon, authenticated;

comment on view public.storefront_products is
  'Buyer-facing catalog projection. Internal product metadata remains on public.products.';
