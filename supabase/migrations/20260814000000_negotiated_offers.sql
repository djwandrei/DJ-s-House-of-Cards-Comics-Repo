-- Private, case-specific offer negotiation records. Public browser clients have
-- no table policies; the offer Edge Function is the only access path.

create table if not exists public.negotiated_offers (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null references public.products(id) on delete restrict,
  product_name text not null default '',
  product_image text not null default '',
  product_public_amount_cents integer check (
    product_public_amount_cents is null
    or product_public_amount_cents between 0 and 99999999
  ),
  buyer_name text not null check (char_length(buyer_name) between 2 and 120),
  buyer_email text not null check (
    char_length(buyer_email) <= 254
    and buyer_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  buyer_phone text not null default '' check (char_length(buyer_phone) <= 80),
  customer_note text not null default '' check (char_length(customer_note) <= 2000),
  admin_note text not null default '' check (char_length(admin_note) <= 2000),
  initial_amount_cents integer not null check (initial_amount_cents between 50 and 99999999),
  current_amount_cents integer not null check (current_amount_cents between 50 and 99999999),
  currency text not null default 'usd' check (currency = 'usd'),
  status text not null default 'pending' check (
    status in ('pending', 'countered', 'accepted', 'declined', 'rejected', 'expired', 'purchased')
  ),
  expires_at timestamptz not null,
  stripe_session_id text unique,
  stripe_payment_intent_id text,
  accepted_at timestamptz,
  declined_at timestamptz,
  rejected_at timestamptz,
  purchased_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.negotiated_offer_events (
  id bigint generated always as identity primary key,
  offer_id uuid not null references public.negotiated_offers(id) on delete cascade,
  actor text not null check (actor in ('customer', 'admin', 'system')),
  action text not null check (
    action in (
      'submitted', 'customer_counter', 'customer_accept', 'customer_reject',
      'admin_accept', 'admin_counter', 'admin_decline', 'checkout_started',
      'checkout_expired', 'expired', 'purchased'
    )
  ),
  amount_cents integer check (amount_cents is null or amount_cents between 50 and 99999999),
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default now()
);

create index if not exists negotiated_offers_status_created_idx
  on public.negotiated_offers(status, created_at desc);
create index if not exists negotiated_offers_buyer_email_created_idx
  on public.negotiated_offers(lower(buyer_email), created_at desc);
create index if not exists negotiated_offers_product_id_created_idx
  on public.negotiated_offers(product_id, created_at desc);
create index if not exists negotiated_offer_events_offer_created_idx
  on public.negotiated_offer_events(offer_id, created_at asc);

create or replace function public.set_negotiated_offer_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists negotiated_offers_set_updated_at on public.negotiated_offers;
create trigger negotiated_offers_set_updated_at
before update on public.negotiated_offers
for each row
execute function public.set_negotiated_offer_updated_at();

-- Only the server-side checkout function may use this reservation path. It
-- locks the accepted offer and product together, so a private price cannot be
-- turned into a public checkout or outlive its seller-approved deadline.
create or replace function public.reserve_negotiated_offer_checkout(
  p_offer_id uuid,
  p_buyer_user_id uuid,
  p_buyer_email text,
  p_expires_at timestamptz
)
returns setof public.product_checkout_reservations
language plpgsql
security definer
set search_path = public
as $$
declare
  offer_record public.negotiated_offers%rowtype;
  product_record public.products%rowtype;
  reservation_record public.product_checkout_reservations%rowtype;
  active_quantity integer;
begin
  if p_offer_id is null
    or length(trim(coalesce(p_buyer_email, ''))) = 0
    or p_expires_at is null
    or p_expires_at <= now() then
    raise exception 'Invalid negotiated checkout reservation request';
  end if;

  select * into offer_record
  from public.negotiated_offers
  where id = p_offer_id
  for update;

  if not found
    or offer_record.status <> 'accepted'
    or offer_record.expires_at <= now()
    or lower(trim(p_buyer_email)) <> lower(offer_record.buyer_email)
    or p_expires_at > offer_record.expires_at + interval '2 minutes' then
    raise exception 'This negotiated offer is not available for checkout';
  end if;

  select * into product_record
  from public.products
  where id = offer_record.product_id
  for update;

  if not found
    or product_record.is_deleted
    or coalesce(product_record.sale_status, 'available') <> 'available' then
    raise exception 'This listing is not available for negotiated checkout';
  end if;

  update public.product_checkout_reservations
  set status = 'expired'
  where product_id = offer_record.product_id
    and status in ('creating', 'pending')
    and expires_at <= now();

  select coalesce(sum(quantity), 0) into active_quantity
  from public.product_checkout_reservations
  where product_id = offer_record.product_id
    and status in ('creating', 'pending')
    and expires_at > now();

  if coalesce(product_record.quantity_available, product_record.copy_count, 1) - active_quantity < 1 then
    raise exception 'This listing is no longer available for negotiated checkout';
  end if;

  insert into public.product_checkout_reservations (
    product_id, buyer_user_id, buyer_email, quantity, status, expires_at
  ) values (
    offer_record.product_id,
    p_buyer_user_id,
    lower(trim(p_buyer_email)),
    1,
    'creating',
    p_expires_at
  ) returning * into reservation_record;

  return next reservation_record;
end;
$$;

alter table public.negotiated_offers enable row level security;
alter table public.negotiated_offer_events enable row level security;

revoke all on table public.negotiated_offers from anon, authenticated;
revoke all on table public.negotiated_offer_events from anon, authenticated;
revoke all on function public.reserve_negotiated_offer_checkout(uuid, uuid, text, timestamptz) from public;
grant execute on function public.reserve_negotiated_offer_checkout(uuid, uuid, text, timestamptz) to service_role;
