-- Base Supabase catalog schema for DJ's House of Cards.
-- Run this in the Supabase SQL Editor before supabase/stripe-schema.sql.

create table if not exists public.products (
  id bigint primary key,
  name text not null,
  category text not null default 'Other',
  team text not null default '',
  year integer,
  condition text not null default '',
  price numeric(12, 2),
  price_label text not null default '',
  display_price text not null default '',
  image text not null default '',
  image_gallery text[] not null default array[]::text[],
  description text not null default '',
  photo_host_page_url text not null default '',
  legacy_image_label text not null default '',
  source_page text not null default '',
  league text not null default '',
  sport text not null default '',
  player_athlete text not null default '',
  copy_count integer,
  quantity_available integer not null default 1,
  checkout_enabled boolean not null default true,
  checkout_price numeric(12, 2),
  sale_status text not null default 'available',
  sold_at timestamptz,
  hidden_reason text not null default '',
  archived_at timestamptz,
  item_photo_url text not null default '',
  item_photo_urls text[] not null default array[]::text[],
  html_full_link text not null default '',
  html_image_urls text[] not null default array[]::text[],
  metadata jsonb not null default '{}'::jsonb,
  is_featured boolean not null default false,
  is_deleted boolean not null default false,
  sort_rank integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.products add column if not exists quantity_available integer;
alter table public.products add column if not exists checkout_enabled boolean;
alter table public.products add column if not exists checkout_price numeric(12, 2);
alter table public.products add column if not exists sale_status text;
alter table public.products add column if not exists sold_at timestamptz;
alter table public.products add column if not exists hidden_reason text;
alter table public.products add column if not exists archived_at timestamptz;

update public.products
set
  quantity_available = greatest(0, coalesce(quantity_available, copy_count, 1)),
  checkout_enabled = coalesce(checkout_enabled, not is_deleted),
  sale_status = coalesce(nullif(sale_status, ''), case when is_deleted then 'hidden' else 'available' end),
  hidden_reason = coalesce(hidden_reason, '');

alter table public.products alter column quantity_available set default 1;
alter table public.products alter column quantity_available set not null;
alter table public.products alter column checkout_enabled set default true;
alter table public.products alter column checkout_enabled set not null;
alter table public.products alter column sale_status set default 'available';
alter table public.products alter column sale_status set not null;
alter table public.products alter column hidden_reason set default '';
alter table public.products alter column hidden_reason set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'products_id_positive'
  ) then
    alter table public.products
    add constraint products_id_positive
    check (id > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_price_nonnegative'
  ) then
    alter table public.products
    add constraint products_price_nonnegative
    check (price is null or price >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_copy_count_nonnegative'
  ) then
    alter table public.products
    add constraint products_copy_count_nonnegative
    check (copy_count is null or copy_count >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_quantity_available_nonnegative'
  ) then
    alter table public.products
    add constraint products_quantity_available_nonnegative
    check (quantity_available >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_checkout_price_nonnegative'
  ) then
    alter table public.products
    add constraint products_checkout_price_nonnegative
    check (checkout_price is null or checkout_price >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'products_sale_status_valid'
  ) then
    alter table public.products
    add constraint products_sale_status_valid
    check (sale_status in ('available', 'inquiry_only', 'reserved', 'sold', 'hidden', 'archived'));
  end if;
end;
$$;

create index if not exists products_visible_category_sort_idx
on public.products (category, sort_rank, year desc, id)
where is_deleted = false;

create index if not exists products_visible_featured_sort_idx
on public.products (is_featured, sort_rank, year desc, id)
where is_deleted = false;

create index if not exists products_visible_year_idx
on public.products (year desc)
where is_deleted = false and year is not null;

create index if not exists products_visible_price_idx
on public.products (price)
where is_deleted = false and price is not null;

create index if not exists products_checkout_inventory_idx
on public.products (sale_status, checkout_enabled, quantity_available)
where is_deleted = false;

create index if not exists products_metadata_gin_idx
on public.products using gin (metadata);

create or replace function public.set_products_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists products_set_updated_at on public.products;
create trigger products_set_updated_at
before update on public.products
for each row
execute function public.set_products_updated_at();

create table if not exists public.site_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique check (email = lower(trim(email))),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.site_admins (email) values ('djwandrei@gmail.com') on conflict (email) do nothing;
create or replace function public.is_site_admin()
returns boolean language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.site_admins where enabled and (
      (user_id is not null and user_id = auth.uid())
      or email = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
    )
  );
$$;
revoke all on function public.is_site_admin() from public;
grant execute on function public.is_site_admin() to authenticated;
alter table public.site_admins enable row level security;

alter table public.products enable row level security;

drop policy if exists "Public can read visible products" on public.products;
create policy "Public can read visible products"
on public.products
for select
using (is_deleted = false and sale_status not in ('hidden', 'archived', 'sold'));

drop policy if exists "Admin can manage products" on public.products;
drop policy if exists "Site admins can create products" on public.products;
create policy "Site admins can create products" on public.products
for insert to authenticated with check (public.is_site_admin());
drop policy if exists "Site admins can update products" on public.products;
create policy "Site admins can update products" on public.products
for update to authenticated using (public.is_site_admin()) with check (public.is_site_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'product-images',
  'product-images',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Public can read product images" on storage.objects;
create policy "Public can read product images"
on storage.objects
for select
using (bucket_id = 'product-images');

drop policy if exists "Admin can upload product images" on storage.objects;
create policy "Admin can upload product images"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'product-images'
  and public.is_site_admin()
);

drop policy if exists "Admin can update product images" on storage.objects;
create policy "Admin can update product images"
on storage.objects
for update
to authenticated
using (
  bucket_id = 'product-images'
  and public.is_site_admin()
)
with check (
  bucket_id = 'product-images'
  and public.is_site_admin()
);

drop policy if exists "Admin can delete product images" on storage.objects;
create policy "Admin can delete product images"
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'product-images'
  and public.is_site_admin()
);
