-- Authenticated customer account data for DJ's House of Cards.
-- Run after supabase-schema.sql and supabase/stripe-schema.sql.

create table if not exists public.customer_account_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_account_profiles_profile_object
    check (jsonb_typeof(profile) = 'object'),
  constraint customer_account_profiles_profile_size
    check (octet_length(profile::text) <= 20000)
);

create table if not exists public.customer_wishlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create index if not exists customer_wishlist_items_user_created_idx
on public.customer_wishlist_items(user_id, created_at);

drop trigger if exists customer_account_profiles_set_updated_at on public.customer_account_profiles;
create trigger customer_account_profiles_set_updated_at
before update on public.customer_account_profiles
for each row
execute function public.set_checkout_records_updated_at();

alter table public.customer_account_profiles enable row level security;
alter table public.customer_wishlist_items enable row level security;

drop policy if exists "Customers can read purchased products" on public.products;
create policy "Customers can read purchased products"
on public.products
for select
to authenticated
using (
  exists (
    select 1
    from public.checkout_orders
    where checkout_orders.product_id = products.id
      and checkout_orders.buyer_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.checkout_order_items
    join public.checkout_orders on checkout_orders.id = checkout_order_items.order_id
    where checkout_order_items.product_id = products.id
      and checkout_orders.buyer_user_id = auth.uid()
  )
);

drop policy if exists "Customers can manage own account profile" on public.customer_account_profiles;
create policy "Customers can manage own account profile"
on public.customer_account_profiles
for all
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

drop policy if exists "Customers can manage own wishlist" on public.customer_wishlist_items;
create policy "Customers can manage own wishlist"
on public.customer_wishlist_items
for all
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "Admin can manage customer account profiles" on public.customer_account_profiles;
create policy "Admin can manage customer account profiles"
on public.customer_account_profiles
for all
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com')
with check ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');

drop policy if exists "Admin can manage customer wishlists" on public.customer_wishlist_items;
create policy "Admin can manage customer wishlists"
on public.customer_wishlist_items
for all
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com')
with check ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');

create or replace function public.replace_customer_wishlist(product_ids bigint[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  delete from public.customer_wishlist_items
  where user_id = auth.uid();

  insert into public.customer_wishlist_items (user_id, product_id)
  select auth.uid(), product.id
  from public.products as product
  where product.id = any(coalesce(product_ids, array[]::bigint[]))
    and product.is_deleted = false
  on conflict do nothing;
end;
$$;

revoke all on function public.replace_customer_wishlist(bigint[]) from public;
grant execute on function public.replace_customer_wishlist(bigint[]) to authenticated;
