-- Stripe checkout support for DJ's House of Cards.
-- Run this after the existing products schema in the Supabase SQL Editor.

create table if not exists public.customer_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.checkout_orders (
  id uuid primary key default gen_random_uuid(),
  product_id bigint references public.products(id),
  buyer_user_id uuid references auth.users(id),
  buyer_email text,
  stripe_customer_id text,
  stripe_session_id text unique not null,
  stripe_payment_intent_id text,
  amount_total integer,
  currency text not null default 'usd',
  status text not null default 'pending',
  item_count integer not null default 1,
  inventory_finalized_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_checkout_reservations (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.products(id),
  buyer_user_id uuid references auth.users(id),
  buyer_email text,
  stripe_session_id text,
  quantity integer not null default 1,
  status text not null default 'creating',
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.checkout_order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.checkout_orders(id) on delete cascade,
  product_id bigint references public.products(id),
  quantity integer not null default 1,
  unit_amount integer,
  product_name text not null default '',
  product_image text not null default '',
  product_price_label text not null default '',
  product_category text not null default '',
  product_year integer,
  product_condition text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (order_id, product_id)
);

create table if not exists public.webhook_events (
  stripe_event_id text primary key,
  event_type text not null,
  processing_status text not null default 'received',
  error_message text not null default '',
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.checkout_orders alter column product_id drop not null;
alter table public.checkout_orders add column if not exists item_count integer;
alter table public.checkout_orders add column if not exists inventory_finalized_at timestamptz;
update public.checkout_orders set item_count = coalesce(item_count, 1);
alter table public.checkout_orders alter column item_count set default 1;
alter table public.checkout_orders alter column item_count set not null;

alter table public.product_checkout_reservations add column if not exists quantity integer;
update public.product_checkout_reservations set quantity = coalesce(quantity, 1);
alter table public.product_checkout_reservations alter column quantity set default 1;
alter table public.product_checkout_reservations alter column quantity set not null;
alter table public.product_checkout_reservations
drop constraint if exists product_checkout_reservations_stripe_session_id_key;

create index if not exists checkout_orders_product_id_idx on public.checkout_orders(product_id);
create index if not exists checkout_orders_buyer_user_id_idx on public.checkout_orders(buyer_user_id);
drop index if exists checkout_orders_one_paid_per_product_idx;

create index if not exists product_checkout_reservations_product_id_idx on public.product_checkout_reservations(product_id);
drop index if exists product_checkout_reservations_one_active_per_product_idx;
create index if not exists product_checkout_reservations_session_idx
on public.product_checkout_reservations(stripe_session_id)
where stripe_session_id is not null;
create index if not exists product_checkout_reservations_buyer_active_idx
on public.product_checkout_reservations(buyer_user_id, expires_at)
where status in ('creating', 'pending');
create index if not exists checkout_order_items_order_idx on public.checkout_order_items(order_id);
create index if not exists checkout_order_items_product_idx on public.checkout_order_items(product_id);
create index if not exists webhook_events_status_created_idx on public.webhook_events(processing_status, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'checkout_orders_amount_total_nonnegative'
  ) then
    alter table public.checkout_orders
    add constraint checkout_orders_amount_total_nonnegative
    check (amount_total is null or amount_total >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'product_checkout_reservations_status_valid'
  ) then
    alter table public.product_checkout_reservations
    add constraint product_checkout_reservations_status_valid
    check (status in ('creating', 'pending', 'paid', 'expired', 'released'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'checkout_orders_status_valid'
  ) then
    alter table public.checkout_orders
    add constraint checkout_orders_status_valid
    check (status in ('pending', 'paid', 'complete', 'succeeded', 'expired', 'unpaid', 'no_payment_required'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'checkout_orders_item_count_positive'
  ) then
    alter table public.checkout_orders
    add constraint checkout_orders_item_count_positive
    check (item_count > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'product_checkout_reservations_quantity_positive'
  ) then
    alter table public.product_checkout_reservations
    add constraint product_checkout_reservations_quantity_positive
    check (quantity > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'checkout_order_items_quantity_positive'
  ) then
    alter table public.checkout_order_items
    add constraint checkout_order_items_quantity_positive
    check (quantity > 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'checkout_order_items_unit_amount_nonnegative'
  ) then
    alter table public.checkout_order_items
    add constraint checkout_order_items_unit_amount_nonnegative
    check (unit_amount is null or unit_amount >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'webhook_events_processing_status_valid'
  ) then
    alter table public.webhook_events
    add constraint webhook_events_processing_status_valid
    check (processing_status in ('received', 'processing', 'processed', 'failed', 'ignored'));
  end if;
end;
$$;

create or replace function public.set_checkout_records_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.reserve_checkout_items(
  p_buyer_user_id uuid,
  p_buyer_email text,
  p_items jsonb,
  p_expires_at timestamptz
)
returns setof public.product_checkout_reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  requested_product_id bigint;
  requested_quantity integer;
  active_quantity integer;
  product_record public.products%rowtype;
  reservation_record public.product_checkout_reservations%rowtype;
begin
  if p_buyer_user_id is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Invalid checkout reservation request';
  end if;

  for item in
    select value
    from jsonb_array_elements(p_items)
    order by (value ->> 'productId')::bigint
  loop
    requested_product_id := (item ->> 'productId')::bigint;
    requested_quantity := (item ->> 'quantity')::integer;
    if requested_product_id is null or requested_quantity is null or requested_quantity <= 0 then
      raise exception 'Invalid checkout item';
    end if;

    select *
    into product_record
    from public.products
    where id = requested_product_id
    for update;

    if not found
      or product_record.is_deleted
      or not product_record.checkout_enabled
      or product_record.sale_status <> 'available'
    then
      raise exception 'Listing % is not available for checkout', requested_product_id;
    end if;

    update public.product_checkout_reservations
    set status = 'expired'
    where product_id = requested_product_id
      and status in ('creating', 'pending')
      and expires_at <= now();

    select coalesce(sum(quantity), 0)
    into active_quantity
    from public.product_checkout_reservations
    where product_id = requested_product_id
      and status in ('creating', 'pending')
      and expires_at > now();

    if requested_quantity > product_record.quantity_available - active_quantity then
      raise exception 'Requested quantity is unavailable for listing %', requested_product_id;
    end if;

    insert into public.product_checkout_reservations (
      product_id,
      buyer_user_id,
      buyer_email,
      quantity,
      status,
      expires_at
    )
    values (
      requested_product_id,
      p_buyer_user_id,
      coalesce(p_buyer_email, ''),
      requested_quantity,
      'creating',
      p_expires_at
    )
    returning * into reservation_record;

    return next reservation_record;
  end loop;
end;
$$;

create or replace function public.finalize_checkout_inventory(p_stripe_session_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  order_record public.checkout_orders%rowtype;
  reservation_record public.product_checkout_reservations%rowtype;
  product_record public.products%rowtype;
  remaining_quantity integer;
begin
  select *
  into order_record
  from public.checkout_orders
  where stripe_session_id = p_stripe_session_id
  for update;

  if not found or order_record.inventory_finalized_at is not null then
    return;
  end if;

  if order_record.status not in ('paid', 'complete', 'succeeded', 'no_payment_required') then
    raise exception 'Checkout order % is not paid', order_record.id;
  end if;

  for reservation_record in
    select *
    from public.product_checkout_reservations
    where stripe_session_id = p_stripe_session_id
    order by product_id
  loop
    select *
    into product_record
    from public.products
    where id = reservation_record.product_id
    for update;

    if not found then
      raise exception 'Reserved listing % no longer exists', reservation_record.product_id;
    end if;

    if reservation_record.quantity > product_record.quantity_available then
      raise exception 'Reserved quantity exceeds available inventory for listing %', reservation_record.product_id;
    end if;

    remaining_quantity := product_record.quantity_available - reservation_record.quantity;
    update public.products
    set
      quantity_available = remaining_quantity,
      copy_count = remaining_quantity,
      checkout_enabled = case when remaining_quantity > 0 then checkout_enabled else false end,
      sale_status = case when remaining_quantity > 0 then sale_status else 'sold' end,
      is_deleted = case when remaining_quantity > 0 then is_deleted else true end,
      sold_at = case when remaining_quantity > 0 then sold_at else now() end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'sold_via', 'stripe_checkout',
        'stripe_session_id', p_stripe_session_id,
        'last_quantity_sold', reservation_record.quantity,
        'last_sold_at', now()
      )
    where id = reservation_record.product_id;
  end loop;

  update public.product_checkout_reservations
  set status = 'paid'
  where stripe_session_id = p_stripe_session_id;

  update public.checkout_orders
  set inventory_finalized_at = now()
  where id = order_record.id;
end;
$$;

revoke all on function public.reserve_checkout_items(uuid, text, jsonb, timestamptz) from public;
revoke all on function public.finalize_checkout_inventory(text) from public;
grant execute on function public.reserve_checkout_items(uuid, text, jsonb, timestamptz) to service_role;
grant execute on function public.finalize_checkout_inventory(text) to service_role;

drop trigger if exists customer_profiles_set_updated_at on public.customer_profiles;
create trigger customer_profiles_set_updated_at
before update on public.customer_profiles
for each row
execute function public.set_checkout_records_updated_at();

drop trigger if exists checkout_orders_set_updated_at on public.checkout_orders;
create trigger checkout_orders_set_updated_at
before update on public.checkout_orders
for each row
execute function public.set_checkout_records_updated_at();

drop trigger if exists product_checkout_reservations_set_updated_at on public.product_checkout_reservations;
create trigger product_checkout_reservations_set_updated_at
before update on public.product_checkout_reservations
for each row
execute function public.set_checkout_records_updated_at();

alter table public.customer_profiles enable row level security;
alter table public.checkout_orders enable row level security;
alter table public.product_checkout_reservations enable row level security;
alter table public.checkout_order_items enable row level security;
alter table public.webhook_events enable row level security;

drop policy if exists "Customers can read own profile" on public.customer_profiles;
create policy "Customers can read own profile"
on public.customer_profiles
for select
using (auth.uid() = id);

drop policy if exists "Customers can update own profile" on public.customer_profiles;
-- Customer profile writes are intentionally service-role only. The storefront
-- should not be able to alter Stripe customer IDs from browser credentials.

drop policy if exists "Customers can read own orders" on public.checkout_orders;
create policy "Customers can read own orders"
on public.checkout_orders
for select
using (auth.uid() = buyer_user_id);

drop policy if exists "Customers can read own order items" on public.checkout_order_items;
create policy "Customers can read own order items"
on public.checkout_order_items
for select
using (
  exists (
    select 1
    from public.checkout_orders
    where checkout_orders.id = checkout_order_items.order_id
      and checkout_orders.buyer_user_id = auth.uid()
  )
);

drop policy if exists "Customers can read own checkout reservations" on public.product_checkout_reservations;
create policy "Customers can read own checkout reservations"
on public.product_checkout_reservations
for select
using (auth.uid() = buyer_user_id);

drop policy if exists "Admin can manage customer profiles" on public.customer_profiles;
create policy "Admin can manage customer profiles"
on public.customer_profiles
for all
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Admin can manage checkout orders" on public.checkout_orders;
create policy "Admin can manage checkout orders"
on public.checkout_orders
for all
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Admin can manage checkout reservations" on public.product_checkout_reservations;
create policy "Admin can manage checkout reservations"
on public.product_checkout_reservations
for all
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Admin can manage checkout order items" on public.checkout_order_items;
create policy "Admin can manage checkout order items"
on public.checkout_order_items
for all
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Admin can read webhook events" on public.webhook_events;
create policy "Admin can read webhook events"
on public.webhook_events
for select
using (public.is_site_admin());
