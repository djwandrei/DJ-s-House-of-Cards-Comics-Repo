-- Backend hardening: reproducible authorization, durable notifications,
-- abuse-resistant checkout holds, ordered Shopify inventory, revocable offer
-- capabilities, and auditable product deletion.

create table if not exists public.site_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references auth.users(id) on delete set null,
  email text not null unique check (email = lower(trim(email))),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.site_admins (email)
values ('djwandrei@gmail.com')
on conflict (email) do nothing;

create or replace function public.is_site_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.site_admins
    where enabled
      and (
        (user_id is not null and user_id = auth.uid())
        or email = lower(trim(coalesce(auth.jwt() ->> 'email', '')))
      )
  );
$$;

revoke all on function public.is_site_admin() from public;
grant execute on function public.is_site_admin() to authenticated;

alter table public.site_admins enable row level security;
drop policy if exists "Site admins can read admin registry" on public.site_admins;
create policy "Site admins can read admin registry"
on public.site_admins
for select
to authenticated
using (public.is_site_admin());

-- Replace hard-coded email policies with the central registry. Product deletion
-- is intentionally excluded; it must use the service-side audited workflow.
drop policy if exists "Admin can manage products" on public.products;
drop policy if exists "Site admins can read products" on public.products;
create policy "Site admins can read products"
on public.products for select to authenticated
using (public.is_site_admin());
drop policy if exists "Site admins can create products" on public.products;
create policy "Site admins can create products"
on public.products for insert to authenticated
with check (public.is_site_admin());
drop policy if exists "Site admins can update products" on public.products;
create policy "Site admins can update products"
on public.products for update to authenticated
using (public.is_site_admin())
with check (public.is_site_admin());

drop policy if exists "Admin can upload product images" on storage.objects;
create policy "Admin can upload product images"
on storage.objects for insert to authenticated
with check (bucket_id = 'product-images' and public.is_site_admin());
drop policy if exists "Admin can update product images" on storage.objects;
create policy "Admin can update product images"
on storage.objects for update to authenticated
using (bucket_id = 'product-images' and public.is_site_admin())
with check (bucket_id = 'product-images' and public.is_site_admin());
drop policy if exists "Admin can delete product images" on storage.objects;
create policy "Admin can delete product images"
on storage.objects for delete to authenticated
using (bucket_id = 'product-images' and public.is_site_admin());

drop policy if exists "Admin can manage customer account profiles" on public.customer_account_profiles;
create policy "Admin can manage customer account profiles"
on public.customer_account_profiles for all to authenticated
using (public.is_site_admin()) with check (public.is_site_admin());
drop policy if exists "Admin can manage customer wishlists" on public.customer_wishlist_items;
create policy "Admin can manage customer wishlists"
on public.customer_wishlist_items for all to authenticated
using (public.is_site_admin()) with check (public.is_site_admin());

drop policy if exists "Admin can manage customer profiles" on public.customer_profiles;
create policy "Admin can manage customer profiles"
on public.customer_profiles for all to authenticated
using (public.is_site_admin()) with check (public.is_site_admin());
drop policy if exists "Admin can manage checkout orders" on public.checkout_orders;
create policy "Admin can manage checkout orders"
on public.checkout_orders for all to authenticated
using (public.is_site_admin()) with check (public.is_site_admin());
drop policy if exists "Admin can manage checkout reservations" on public.product_checkout_reservations;
create policy "Admin can manage checkout reservations"
on public.product_checkout_reservations for all to authenticated
using (public.is_site_admin()) with check (public.is_site_admin());
drop policy if exists "Admin can manage checkout order items" on public.checkout_order_items;
create policy "Admin can manage checkout order items"
on public.checkout_order_items for all to authenticated
using (public.is_site_admin()) with check (public.is_site_admin());
drop policy if exists "Admin can read webhook events" on public.webhook_events;
create policy "Admin can read webhook events"
on public.webhook_events for select to authenticated
using (public.is_site_admin());

drop policy if exists "Admin can read Shopify product mappings" on public.shopify_product_mappings;
create policy "Admin can read Shopify product mappings"
on public.shopify_product_mappings for select to authenticated
using (public.is_site_admin());
drop policy if exists "Admin can read marketplace webhook events" on public.marketplace_webhook_events;
create policy "Admin can read marketplace webhook events"
on public.marketplace_webhook_events for select to authenticated
using (public.is_site_admin());

-- Durable notification queue. One row represents one event/channel delivery,
-- so email and webhook failures retry independently without duplicate sends.
create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  channel text not null check (channel in ('email', 'webhook')),
  notification_type text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'sent', 'failed')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  locked_at timestamptz,
  last_error text not null default '',
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_key, channel)
);

create index if not exists notification_outbox_delivery_idx
on public.notification_outbox(status, next_attempt_at, created_at);

alter table public.notification_outbox enable row level security;
drop policy if exists "Site admins can read notification outbox" on public.notification_outbox;
create policy "Site admins can read notification outbox"
on public.notification_outbox for select to authenticated
using (public.is_site_admin());

create or replace function public.claim_notification_outbox(
  p_worker_token uuid,
  p_limit integer default 25,
  p_lease_seconds integer default 120
)
returns setof public.notification_outbox
language sql
security definer
set search_path = public
as $$
  with claimable as (
    select id
    from public.notification_outbox
    where next_attempt_at <= now()
      and (
        status in ('pending', 'failed')
        or (status = 'processing' and locked_at <= now() - make_interval(secs => greatest(30, p_lease_seconds)))
      )
    order by next_attempt_at, created_at
    for update skip locked
    limit least(100, greatest(1, p_limit))
  )
  update public.notification_outbox as outbox
  set status = 'processing',
      attempt_count = outbox.attempt_count + 1,
      lease_token = p_worker_token,
      locked_at = now(),
      updated_at = now()
  from claimable
  where outbox.id = claimable.id
  returning outbox.*;
$$;

create or replace function public.complete_notification_outbox(
  p_id uuid,
  p_worker_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_outbox
  set status = 'sent', sent_at = now(), lease_token = null, locked_at = null,
      last_error = '', updated_at = now()
  where id = p_id and status = 'processing' and lease_token = p_worker_token;
  return found;
end;
$$;

create or replace function public.fail_notification_outbox(
  p_id uuid,
  p_worker_token uuid,
  p_error text,
  p_retry_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.notification_outbox
  set status = 'failed',
      next_attempt_at = now() + make_interval(secs => least(86400, greatest(30, p_retry_seconds))),
      lease_token = null,
      locked_at = null,
      last_error = left(coalesce(p_error, 'Unknown notification error'), 4000),
      updated_at = now()
  where id = p_id and status = 'processing' and lease_token = p_worker_token;
  return found;
end;
$$;

revoke all on function public.claim_notification_outbox(uuid, integer, integer) from public;
revoke all on function public.complete_notification_outbox(uuid, uuid) from public;
revoke all on function public.fail_notification_outbox(uuid, uuid, text, integer) from public;
grant execute on function public.claim_notification_outbox(uuid, integer, integer) to service_role;
grant execute on function public.complete_notification_outbox(uuid, uuid) to service_role;
grant execute on function public.fail_notification_outbox(uuid, uuid, text, integer) to service_role;

-- Webhook claims use a bounded processing lease. Concurrent duplicate
-- deliveries cannot both enter the business workflow, while genuinely failed
-- or abandoned attempts remain retryable.
alter table public.webhook_events add column if not exists locked_at timestamptz;
alter table public.webhook_events add column if not exists attempt_count integer not null default 0;
alter table public.marketplace_webhook_events add column if not exists locked_at timestamptz;
alter table public.marketplace_webhook_events add column if not exists attempt_count integer not null default 0;

create or replace function public.claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.webhook_events (
    stripe_event_id, event_type, processing_status, locked_at, attempt_count
  ) values (
    p_event_id, p_event_type, 'processing', now(), 1
  ) on conflict (stripe_event_id) do nothing;
  if found then return true; end if;
  update public.webhook_events
  set event_type = p_event_type, processing_status = 'processing', error_message = '',
      locked_at = now(), attempt_count = attempt_count + 1, processed_at = null
  where stripe_event_id = p_event_id
    and (
      processing_status = 'failed'
      or (processing_status = 'processing'
        and coalesce(locked_at, created_at) <= now() - make_interval(secs => greatest(60, p_lease_seconds)))
    );
  return found;
end;
$$;

create or replace function public.claim_marketplace_webhook_event(
  p_provider text,
  p_event_id text,
  p_event_type text,
  p_shop_domain text,
  p_payload_summary jsonb default '{}'::jsonb,
  p_lease_seconds integer default 300
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.marketplace_webhook_events (
    provider, event_id, event_type, shop_domain, processing_status,
    payload_summary, locked_at, attempt_count
  ) values (
    lower(trim(p_provider)), p_event_id, p_event_type, coalesce(p_shop_domain, ''),
    'processing', coalesce(p_payload_summary, '{}'::jsonb), now(), 1
  ) on conflict (provider, event_id) do nothing;
  if found then return true; end if;
  update public.marketplace_webhook_events
  set event_type = p_event_type, shop_domain = coalesce(p_shop_domain, ''),
      processing_status = 'processing', payload_summary = coalesce(p_payload_summary, '{}'::jsonb),
      error_message = '', locked_at = now(), attempt_count = attempt_count + 1, processed_at = null
  where provider = lower(trim(p_provider)) and event_id = p_event_id
    and (
      processing_status = 'failed'
      or (processing_status = 'processing'
        and coalesce(locked_at, created_at) <= now() - make_interval(secs => greatest(60, p_lease_seconds)))
    );
  return found;
end;
$$;

revoke all on function public.claim_stripe_webhook_event(text, text, integer) from public;
revoke all on function public.claim_marketplace_webhook_event(text, text, text, text, jsonb, integer) from public;
grant execute on function public.claim_stripe_webhook_event(text, text, integer) to service_role;
grant execute on function public.claim_marketplace_webhook_event(text, text, text, text, jsonb, integer) to service_role;

-- Audit data remains after a product row and its Shopify mapping are removed.
create table if not exists public.product_deletion_audit (
  id uuid primary key default gen_random_uuid(),
  product_id bigint not null,
  deleted_by text not null default '',
  shopify_action text not null default '',
  product_snapshot jsonb not null default '{}'::jsonb,
  mapping_snapshot jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  deleted_at timestamptz not null default now()
);

alter table public.product_deletion_audit enable row level security;
drop policy if exists "Site admins can read product deletion audit" on public.product_deletion_audit;
create policy "Site admins can read product deletion audit"
on public.product_deletion_audit for select to authenticated
using (public.is_site_admin());

-- Preserve order/offer history when a listing is permanently removed. Active
-- checkout reservations and negotiations still block deletion below.
alter table public.checkout_orders drop constraint if exists checkout_orders_product_id_fkey;
alter table public.checkout_orders
  add constraint checkout_orders_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;
alter table public.checkout_order_items drop constraint if exists checkout_order_items_product_id_fkey;
alter table public.checkout_order_items
  add constraint checkout_order_items_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;
alter table public.negotiated_offers alter column product_id drop not null;
alter table public.negotiated_offers drop constraint if exists negotiated_offers_product_id_fkey;
alter table public.negotiated_offers
  add constraint negotiated_offers_product_id_fkey
  foreign key (product_id) references public.products(id) on delete set null;

create or replace function public.prepare_product_deletion(p_product_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(p_product_id);
  update public.negotiated_offers
  set status = 'expired', access_token_revoked_at = coalesce(access_token_revoked_at, now())
  where product_id = p_product_id
    and status in ('pending', 'countered', 'accepted')
    and expires_at <= now();
  if exists (
    select 1 from public.product_checkout_reservations
    where product_id = p_product_id
      and status in ('creating', 'pending')
      and expires_at > now()
  ) then
    raise exception 'Product % has an active checkout reservation', p_product_id;
  end if;
  if exists (
    select 1 from public.negotiated_offers
    where product_id = p_product_id
      and status in ('pending', 'countered', 'accepted')
      and expires_at > now()
  ) then
    raise exception 'Product % has an active offer negotiation', p_product_id;
  end if;
  update public.products
  set is_deleted = true,
      checkout_enabled = false,
      sale_status = 'hidden',
      hidden_reason = 'Pending permanent deletion',
      updated_at = now()
  where id = p_product_id;
  if not found then raise exception 'Product % does not exist', p_product_id; end if;
end;
$$;

revoke all on function public.prepare_product_deletion(bigint) from public;
grant execute on function public.prepare_product_deletion(bigint) to service_role;

create or replace function public.delete_product_with_audit(
  p_product_id bigint,
  p_deleted_by text,
  p_shopify_action text,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  product_snapshot jsonb;
  mapping_snapshot jsonb;
begin
  perform pg_advisory_xact_lock(p_product_id);
  update public.negotiated_offers
  set status = 'expired', access_token_revoked_at = coalesce(access_token_revoked_at, now())
  where product_id = p_product_id
    and status in ('pending', 'countered', 'accepted')
    and expires_at <= now();
  if exists (
    select 1 from public.product_checkout_reservations
    where product_id = p_product_id
      and status in ('creating', 'pending')
      and expires_at > now()
  ) then
    raise exception 'Product % has an active checkout reservation', p_product_id;
  end if;
  if exists (
    select 1 from public.negotiated_offers
    where product_id = p_product_id
      and status in ('pending', 'countered', 'accepted')
      and expires_at > now()
  ) then
    raise exception 'Product % has an active offer negotiation', p_product_id;
  end if;
  delete from public.product_checkout_reservations
  where product_id = p_product_id
    and (status not in ('creating', 'pending') or expires_at <= now());
  select to_jsonb(product_row.*) into product_snapshot
  from public.products as product_row where product_row.id = p_product_id for update;
  if product_snapshot is null then
    raise exception 'Product % does not exist', p_product_id;
  end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb) -> 'originalProductSnapshot') = 'object' then
    product_snapshot := p_metadata -> 'originalProductSnapshot';
  end if;
  select coalesce(to_jsonb(mappings.*), '{}'::jsonb) into mapping_snapshot
  from public.shopify_product_mappings as mappings
  where mappings.product_id = p_product_id;
  insert into public.product_deletion_audit (
    product_id, deleted_by, shopify_action, product_snapshot, mapping_snapshot, metadata
  ) values (
    p_product_id, lower(trim(coalesce(p_deleted_by, ''))), trim(coalesce(p_shopify_action, '')),
    product_snapshot, coalesce(mapping_snapshot, '{}'::jsonb),
    coalesce(p_metadata, '{}'::jsonb) - 'originalProductSnapshot'
  );
  delete from public.products where id = p_product_id;
end;
$$;

revoke all on function public.delete_product_with_audit(bigint, text, text, jsonb) from public;
grant execute on function public.delete_product_with_audit(bigint, text, text, jsonb) to service_role;

-- OAuth tokens are encrypted by the Edge Function before storage. Browser
-- clients have no table policy and therefore cannot read these credentials.
create table if not exists public.shopify_oauth_credentials (
  shop_domain text primary key,
  encrypted_access_token text not null,
  initialization_vector text not null,
  scopes text not null default '',
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.shopify_oauth_credentials enable row level security;

-- Random, hashed offer capabilities replace deterministic permanent links.
alter table public.negotiated_offers add column if not exists access_token_hash text;
alter table public.negotiated_offers add column if not exists access_token_expires_at timestamptz;
alter table public.negotiated_offers add column if not exists access_token_revoked_at timestamptz;
alter table public.negotiated_offers add column if not exists submission_key uuid;
create unique index if not exists negotiated_offers_submission_key_idx
on public.negotiated_offers(submission_key)
where submission_key is not null;
update public.negotiated_offers
set access_token_expires_at = expires_at
where access_token_expires_at is null;

-- Anonymous reservation identity is stored only as a one-way fingerprint.
alter table public.product_checkout_reservations add column if not exists request_fingerprint text;
create index if not exists product_checkout_reservations_fingerprint_active_idx
on public.product_checkout_reservations(request_fingerprint, expires_at)
where buyer_user_id is null and status in ('creating', 'pending');

drop function if exists public.reserve_checkout_items(uuid, text, jsonb, timestamptz);
create function public.reserve_checkout_items(
  p_buyer_user_id uuid,
  p_buyer_email text,
  p_request_fingerprint text,
  p_items jsonb,
  p_expires_at timestamptz,
  p_max_active_reservations integer default 5
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
  active_reservation_count integer;
  identity_key text;
  product_record public.products%rowtype;
  reservation_record public.product_checkout_reservations%rowtype;
begin
  if (p_buyer_user_id is null and length(trim(coalesce(p_buyer_email, ''))) = 0)
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0
    or jsonb_array_length(p_items) > 25
    or p_max_active_reservations < 1
  then
    raise exception 'Invalid checkout reservation request';
  end if;
  if p_buyer_user_id is null and length(trim(coalesce(p_request_fingerprint, ''))) < 32 then
    raise exception 'Anonymous checkout fingerprint is required';
  end if;

  identity_key := case
    when p_buyer_user_id is not null then 'user:' || p_buyer_user_id::text
    else 'guest:' || trim(p_request_fingerprint)
  end;
  perform pg_advisory_xact_lock(hashtext('checkout-reservations:' || identity_key));

  update public.product_checkout_reservations
  set status = 'expired'
  where status in ('creating', 'pending') and expires_at <= now();

  select count(*) into active_reservation_count
  from public.product_checkout_reservations
  where status in ('creating', 'pending') and expires_at > now()
    and (
      (p_buyer_user_id is not null and buyer_user_id = p_buyer_user_id)
      or (p_buyer_user_id is null and buyer_user_id is null and request_fingerprint = trim(p_request_fingerprint))
    );
  if active_reservation_count + jsonb_array_length(p_items) > p_max_active_reservations then
    raise exception 'Too many active checkout reservations';
  end if;

  for item in
    select value from jsonb_array_elements(p_items)
    order by (value ->> 'productId')::bigint
  loop
    requested_product_id := (item ->> 'productId')::bigint;
    requested_quantity := (item ->> 'quantity')::integer;
    if requested_product_id is null or requested_quantity is null or requested_quantity <= 0 then
      raise exception 'Invalid checkout item';
    end if;
    select * into product_record from public.products
    where id = requested_product_id for update;
    if not found or product_record.is_deleted or not product_record.checkout_enabled
      or product_record.sale_status <> 'available' then
      raise exception 'Listing % is not available for checkout', requested_product_id;
    end if;
    update public.product_checkout_reservations set status = 'expired'
    where product_id = requested_product_id and status in ('creating', 'pending') and expires_at <= now();
    select coalesce(sum(quantity), 0) into active_quantity
    from public.product_checkout_reservations
    where product_id = requested_product_id and status in ('creating', 'pending') and expires_at > now();
    if requested_quantity > product_record.quantity_available - active_quantity then
      raise exception 'Requested quantity is unavailable for listing %', requested_product_id;
    end if;
    insert into public.product_checkout_reservations (
      product_id, buyer_user_id, buyer_email, request_fingerprint, quantity, status, expires_at
    ) values (
      requested_product_id, p_buyer_user_id, lower(trim(coalesce(p_buyer_email, ''))),
      nullif(trim(coalesce(p_request_fingerprint, '')), ''), requested_quantity, 'creating', p_expires_at
    ) returning * into reservation_record;
    return next reservation_record;
  end loop;
end;
$$;

revoke all on function public.reserve_checkout_items(uuid, text, text, jsonb, timestamptz, integer) from public;
grant execute on function public.reserve_checkout_items(uuid, text, text, jsonb, timestamptz, integer) to service_role;

drop function if exists public.reserve_negotiated_offer_checkout(uuid, uuid, text, timestamptz);
create function public.reserve_negotiated_offer_checkout(
  p_offer_id uuid,
  p_buyer_user_id uuid,
  p_buyer_email text,
  p_request_fingerprint text,
  p_expires_at timestamptz,
  p_max_active_reservations integer default 5
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
  active_reservation_count integer;
  identity_key text;
begin
  if p_offer_id is null or length(trim(coalesce(p_buyer_email, ''))) = 0
    or p_expires_at is null or p_expires_at <= now() or p_max_active_reservations < 1 then
    raise exception 'Invalid negotiated checkout request';
  end if;
  if p_buyer_user_id is null and length(trim(coalesce(p_request_fingerprint, ''))) < 32 then
    raise exception 'Anonymous checkout fingerprint is required';
  end if;
  identity_key := case when p_buyer_user_id is not null then 'user:' || p_buyer_user_id::text
    else 'guest:' || trim(p_request_fingerprint) end;
  perform pg_advisory_xact_lock(hashtext('checkout-reservations:' || identity_key));
  update public.product_checkout_reservations set status = 'expired'
  where status in ('creating', 'pending') and expires_at <= now();
  select count(*) into active_reservation_count
  from public.product_checkout_reservations
  where status in ('creating', 'pending') and expires_at > now()
    and ((p_buyer_user_id is not null and buyer_user_id = p_buyer_user_id)
      or (p_buyer_user_id is null and buyer_user_id is null and request_fingerprint = trim(p_request_fingerprint)));
  if active_reservation_count + 1 > p_max_active_reservations then
    raise exception 'Too many active checkout reservations';
  end if;
  select * into offer_record from public.negotiated_offers where id = p_offer_id for update;
  if not found or offer_record.status <> 'accepted' or offer_record.expires_at <= now()
    or lower(trim(offer_record.buyer_email)) <> lower(trim(p_buyer_email))
    or offer_record.stripe_session_id is not null then
    raise exception 'Negotiated offer is not available for checkout';
  end if;
  select * into product_record from public.products where id = offer_record.product_id for update;
  if not found or product_record.is_deleted or not product_record.checkout_enabled
    or product_record.sale_status <> 'available' then
    raise exception 'Negotiated listing is not available for checkout';
  end if;
  select coalesce(sum(quantity), 0) into active_quantity
  from public.product_checkout_reservations
  where product_id = offer_record.product_id and status in ('creating', 'pending') and expires_at > now();
  if active_quantity >= product_record.quantity_available then
    raise exception 'Negotiated listing is already reserved';
  end if;
  insert into public.product_checkout_reservations (
    product_id, buyer_user_id, buyer_email, request_fingerprint, quantity, status, expires_at
  ) values (
    offer_record.product_id, p_buyer_user_id, lower(trim(p_buyer_email)),
    nullif(trim(coalesce(p_request_fingerprint, '')), ''), 1, 'creating', p_expires_at
  ) returning * into reservation_record;
  return next reservation_record;
end;
$$;

revoke all on function public.reserve_negotiated_offer_checkout(uuid, uuid, text, text, timestamptz, integer) from public;
grant execute on function public.reserve_negotiated_offer_checkout(uuid, uuid, text, text, timestamptz, integer) to service_role;

-- Do not finalize released/expired reservations if an unexpected late event
-- arrives. Paid inventory must come from a currently active checkout hold.
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
  finalized_count integer := 0;
begin
  select * into order_record from public.checkout_orders
  where stripe_session_id = p_stripe_session_id for update;
  if not found or order_record.inventory_finalized_at is not null then return; end if;
  if order_record.status not in ('paid', 'complete', 'succeeded', 'no_payment_required') then
    raise exception 'Checkout order % is not paid', order_record.id;
  end if;
  for reservation_record in
    select * from public.product_checkout_reservations
    where stripe_session_id = p_stripe_session_id
      and status in ('creating', 'pending')
      and expires_at > now()
    order by product_id
  loop
    select * into product_record from public.products
    where id = reservation_record.product_id for update;
    if not found then raise exception 'Reserved listing % no longer exists', reservation_record.product_id; end if;
    if reservation_record.quantity > product_record.quantity_available then
      raise exception 'Reserved quantity exceeds available inventory for listing %', reservation_record.product_id;
    end if;
    remaining_quantity := product_record.quantity_available - reservation_record.quantity;
    update public.products set
      quantity_available = remaining_quantity,
      copy_count = remaining_quantity,
      checkout_enabled = case when remaining_quantity > 0 then checkout_enabled else false end,
      sale_status = case when remaining_quantity > 0 then sale_status else 'sold' end,
      is_deleted = case when remaining_quantity > 0 then is_deleted else true end,
      sold_at = case when remaining_quantity > 0 then sold_at else now() end,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'sold_via', 'stripe_checkout', 'stripe_session_id', p_stripe_session_id,
        'last_quantity_sold', reservation_record.quantity, 'last_sold_at', now()
      )
    where id = reservation_record.product_id;
    finalized_count := finalized_count + 1;
  end loop;
  if finalized_count = 0 then
    raise exception 'Checkout session % has no active inventory reservations', p_stripe_session_id;
  end if;
  update public.product_checkout_reservations set status = 'paid'
  where stripe_session_id = p_stripe_session_id
    and status in ('creating', 'pending')
    and expires_at > now();
  update public.checkout_orders set inventory_finalized_at = now() where id = order_record.id;
end;
$$;

-- Shopify source timestamps prevent delayed, distinct webhook IDs from
-- regressing inventory to an older quantity.
alter table public.shopify_product_mappings
  add column if not exists last_shopify_source_updated_at timestamptz;
alter table public.marketplace_webhook_events
  add column if not exists source_updated_at timestamptz;

drop function if exists public.apply_shopify_inventory_level(text, text, text, bigint, bigint, integer, jsonb);
create function public.apply_shopify_inventory_level(
  p_event_id text,
  p_event_type text,
  p_shop_domain text,
  p_inventory_item_id bigint,
  p_location_id bigint,
  p_available integer,
  p_source_updated_at timestamptz,
  p_payload_summary jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  mapping_record public.shopify_product_mappings%rowtype;
  product_record public.products%rowtype;
  existing_status text;
  existing_locked_at timestamptz;
  next_sale_status text;
  next_checkout_enabled boolean;
  next_is_deleted boolean;
  has_checkout_price boolean;
begin
  if coalesce(p_event_id, '') = '' or p_inventory_item_id is null or p_location_id is null
    or p_available is null or p_available < 0 then
    raise exception 'Invalid Shopify inventory webhook payload';
  end if;
  insert into public.marketplace_webhook_events (
    provider, event_id, event_type, shop_domain, processing_status, source_updated_at,
    payload_summary, locked_at, attempt_count
  ) values (
    'shopify', p_event_id, p_event_type, coalesce(p_shop_domain, ''), 'processing',
    p_source_updated_at, coalesce(p_payload_summary, '{}'::jsonb), now(), 1
  ) on conflict (provider, event_id) do nothing;
  if not found then
    select processing_status, locked_at into existing_status, existing_locked_at
    from public.marketplace_webhook_events
    where provider = 'shopify' and event_id = p_event_id;
    if existing_status in ('processed', 'ignored')
      or (existing_status = 'processing' and coalesce(existing_locked_at, now()) > now() - interval '5 minutes') then
      return jsonb_build_object('duplicate', true, 'status', existing_status);
    end if;
    update public.marketplace_webhook_events set
      event_type = p_event_type, shop_domain = coalesce(p_shop_domain, ''),
      processing_status = 'processing', source_updated_at = p_source_updated_at,
      payload_summary = coalesce(p_payload_summary, '{}'::jsonb), error_message = '',
      processed_at = null, locked_at = now(), attempt_count = attempt_count + 1
    where provider = 'shopify' and event_id = p_event_id;
  end if;
  select * into mapping_record from public.shopify_product_mappings
  where shopify_inventory_item_id = p_inventory_item_id and shopify_location_id = p_location_id
  for update;
  if not found then
    update public.marketplace_webhook_events set processing_status = 'ignored',
      error_message = 'No Shopify product mapping matched this inventory level.', processed_at = now()
    where provider = 'shopify' and event_id = p_event_id;
    return jsonb_build_object('ignored', true, 'reason', 'mapping_not_found');
  end if;
  if p_source_updated_at is not null and mapping_record.last_shopify_source_updated_at is not null
    and p_source_updated_at <= mapping_record.last_shopify_source_updated_at then
    update public.marketplace_webhook_events set processing_status = 'ignored',
      product_id = mapping_record.product_id, error_message = 'Stale Shopify inventory event.', processed_at = now()
    where provider = 'shopify' and event_id = p_event_id;
    return jsonb_build_object(
      'ignored', true,
      'stale', true,
      'product_id', mapping_record.product_id,
      'quantity_available', mapping_record.last_shopify_quantity
    );
  end if;
  select * into product_record from public.products where id = mapping_record.product_id for update;
  if not found then raise exception 'Mapped product % no longer exists', mapping_record.product_id; end if;
  has_checkout_price := coalesce(product_record.checkout_price, product_record.price, 0) > 0
    and lower(coalesce(product_record.display_price, product_record.price_label, '')) !~ '(contact|ask|inquir|availability)';
  if p_available <= 0 then
    next_sale_status := 'sold'; next_checkout_enabled := false; next_is_deleted := true;
  else
    next_sale_status := case when product_record.sale_status in ('sold', 'reserved') then 'available' else product_record.sale_status end;
    next_checkout_enabled := case when product_record.sale_status = 'sold' then has_checkout_price else product_record.checkout_enabled end;
    next_is_deleted := case when product_record.sale_status = 'sold' and coalesce(product_record.hidden_reason, '') = '' then false else product_record.is_deleted end;
  end if;
  update public.products set
    quantity_available = p_available, copy_count = p_available,
    checkout_enabled = next_checkout_enabled, sale_status = next_sale_status,
    is_deleted = next_is_deleted,
    sold_at = case when p_available <= 0 then coalesce(sold_at, now()) when next_sale_status = 'available' then null else sold_at end,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_inventory_source', 'shopify', 'last_shopify_webhook_id', p_event_id,
      'last_shopify_inventory_at', now(), 'last_shopify_source_updated_at', p_source_updated_at
    )
  where id = mapping_record.product_id;
  update public.shopify_product_mappings set
    last_shopify_quantity = p_available, last_synced_at = now(),
    last_shopify_source_updated_at = coalesce(p_source_updated_at, last_shopify_source_updated_at)
  where product_id = mapping_record.product_id;
  update public.marketplace_webhook_events set processing_status = 'processed',
    product_id = mapping_record.product_id, error_message = '', processed_at = now()
  where provider = 'shopify' and event_id = p_event_id;
  return jsonb_build_object('processed', true, 'product_id', mapping_record.product_id,
    'quantity_available', p_available, 'source_updated_at', p_source_updated_at);
end;
$$;

revoke all on function public.apply_shopify_inventory_level(text, text, text, bigint, bigint, integer, timestamptz, jsonb) from public;
grant execute on function public.apply_shopify_inventory_level(text, text, text, bigint, bigint, integer, timestamptz, jsonb) to service_role;

create or replace function public.prune_operational_history(p_processed_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  stripe_count integer;
  marketplace_count integer;
  notification_count integer;
begin
  delete from public.webhook_events
  where processing_status in ('processed', 'ignored')
    and coalesce(processed_at, created_at) < now() - make_interval(days => greatest(30, p_processed_days));
  get diagnostics stripe_count = row_count;
  delete from public.marketplace_webhook_events
  where processing_status in ('processed', 'ignored')
    and coalesce(processed_at, created_at) < now() - make_interval(days => greatest(30, p_processed_days));
  get diagnostics marketplace_count = row_count;
  delete from public.notification_outbox
  where status = 'sent' and sent_at < now() - make_interval(days => greatest(30, p_processed_days));
  get diagnostics notification_count = row_count;
  return jsonb_build_object('stripe', stripe_count, 'marketplace', marketplace_count, 'notifications', notification_count);
end;
$$;

revoke all on function public.prune_operational_history(integer) from public;
grant execute on function public.prune_operational_history(integer) to service_role;
