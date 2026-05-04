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
  product_id bigint not null references public.products(id),
  buyer_user_id uuid references auth.users(id),
  buyer_email text,
  stripe_customer_id text,
  stripe_session_id text unique not null,
  stripe_payment_intent_id text,
  amount_total integer,
  currency text not null default 'usd',
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.product_checkout_reservations (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.products(id),
  buyer_user_id uuid references auth.users(id),
  buyer_email text,
  stripe_session_id text unique,
  status text not null default 'creating',
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists checkout_orders_product_id_idx on public.checkout_orders(product_id);
create index if not exists checkout_orders_buyer_user_id_idx on public.checkout_orders(buyer_user_id);
create unique index if not exists checkout_orders_one_paid_per_product_idx
on public.checkout_orders(product_id)
where status in ('paid', 'complete', 'succeeded');

create index if not exists product_checkout_reservations_product_id_idx on public.product_checkout_reservations(product_id);
create unique index if not exists product_checkout_reservations_one_active_per_product_idx
on public.product_checkout_reservations(product_id)
where status in ('creating', 'pending');

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

drop policy if exists "Customers can read own checkout reservations" on public.product_checkout_reservations;
create policy "Customers can read own checkout reservations"
on public.product_checkout_reservations
for select
using (auth.uid() = buyer_user_id);

drop policy if exists "Admin can manage customer profiles" on public.customer_profiles;
create policy "Admin can manage customer profiles"
on public.customer_profiles
for all
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com')
with check ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');

drop policy if exists "Admin can manage checkout orders" on public.checkout_orders;
create policy "Admin can manage checkout orders"
on public.checkout_orders
for all
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com')
with check ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');

drop policy if exists "Admin can manage checkout reservations" on public.product_checkout_reservations;
create policy "Admin can manage checkout reservations"
on public.product_checkout_reservations
for all
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com')
with check ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');
