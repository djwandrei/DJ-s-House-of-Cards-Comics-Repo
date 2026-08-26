-- Guest checkout remains available, but reservation ownership cannot be reset by
-- rotating a browser-supplied email address. Guest holds use a one-way,
-- request-derived IP fingerprint plus normalized email and a bounded shared pool.
-- The Edge Function must pass rateLimit.ipFingerprint for guest requests.

create index if not exists product_checkout_reservations_guest_email_active_idx
on public.product_checkout_reservations(lower(trim(buyer_email)), expires_at)
where buyer_user_id is null and status in ('creating', 'pending');

create index if not exists product_checkout_reservations_guest_expires_active_idx
on public.product_checkout_reservations(expires_at)
where buyer_user_id is null and status in ('creating', 'pending');

comment on column public.product_checkout_reservations.request_fingerprint is
  'One-way request fingerprint: authenticated request identity or guest IP identity.';

create or replace function public.reserve_checkout_items(
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
  requested_item_count integer;
  active_quantity integer;
  active_user_reservation_count integer;
  active_guest_ip_count integer;
  active_guest_email_count integer;
  active_guest_total integer;
  normalized_guest_email text;
  identity_key text;
  guest_global_reservation_limit constant integer := 20;
  product_record public.products%rowtype;
  reservation_record public.product_checkout_reservations%rowtype;
begin
  if (p_buyer_user_id is null and length(trim(coalesce(p_buyer_email, ''))) = 0)
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0
    or jsonb_array_length(p_items) > 25
    or p_expires_at is null
    or p_expires_at <= now()
    or p_expires_at > now() + interval '25 hours'
    or p_max_active_reservations < 1
  then
    raise exception 'Invalid checkout reservation request';
  end if;
  if p_buyer_user_id is null and length(trim(coalesce(p_request_fingerprint, ''))) < 32 then
    raise exception 'Anonymous checkout fingerprint is required';
  end if;

  requested_item_count := jsonb_array_length(p_items);
  if p_buyer_user_id is null then
    normalized_guest_email := lower(trim(p_buyer_email));
    -- All guest checkouts acquire this first, making the global count and
    -- IP/email checks atomic without serializing signed-in customer holds.
    perform pg_advisory_xact_lock(hashtext('checkout-reservations:guest-global'));
    identity_key := 'guest-ip:' || trim(p_request_fingerprint);
  else
    identity_key := 'user:' || p_buyer_user_id::text;
  end if;
  perform pg_advisory_xact_lock(hashtext('checkout-reservations:' || identity_key));

  update public.product_checkout_reservations
  set status = 'expired'
  where status in ('creating', 'pending') and expires_at <= now();

  if p_buyer_user_id is null then
    select count(*) into active_guest_ip_count
    from public.product_checkout_reservations
    where buyer_user_id is null
      and status in ('creating', 'pending')
      and expires_at > now()
      and request_fingerprint = trim(p_request_fingerprint);

    select count(*) into active_guest_email_count
    from public.product_checkout_reservations
    where buyer_user_id is null
      and status in ('creating', 'pending')
      and expires_at > now()
      and lower(trim(buyer_email)) = normalized_guest_email;

    select count(*) into active_guest_total
    from public.product_checkout_reservations
    where buyer_user_id is null
      and status in ('creating', 'pending')
      and expires_at > now();

    if greatest(active_guest_ip_count, active_guest_email_count) + requested_item_count > p_max_active_reservations
      or active_guest_total + requested_item_count > guest_global_reservation_limit
    then
      raise exception 'Too many active checkout reservations';
    end if;
  else
    select count(*) into active_user_reservation_count
    from public.product_checkout_reservations
    where buyer_user_id = p_buyer_user_id
      and status in ('creating', 'pending')
      and expires_at > now();

    if active_user_reservation_count + requested_item_count > p_max_active_reservations then
      raise exception 'Too many active checkout reservations';
    end if;
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

create or replace function public.reserve_negotiated_offer_checkout(
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
  active_user_reservation_count integer;
  active_guest_ip_count integer;
  active_guest_email_count integer;
  active_guest_total integer;
  normalized_guest_email text;
  identity_key text;
  guest_global_reservation_limit constant integer := 20;
begin
  if p_offer_id is null or length(trim(coalesce(p_buyer_email, ''))) = 0
    or p_expires_at is null or p_expires_at <= now() or p_expires_at > now() + interval '25 hours'
    or p_max_active_reservations < 1 then
    raise exception 'Invalid negotiated checkout request';
  end if;
  if p_buyer_user_id is null and length(trim(coalesce(p_request_fingerprint, ''))) < 32 then
    raise exception 'Anonymous checkout fingerprint is required';
  end if;

  if p_buyer_user_id is null then
    normalized_guest_email := lower(trim(p_buyer_email));
    perform pg_advisory_xact_lock(hashtext('checkout-reservations:guest-global'));
    identity_key := 'guest-ip:' || trim(p_request_fingerprint);
  else
    identity_key := 'user:' || p_buyer_user_id::text;
  end if;
  perform pg_advisory_xact_lock(hashtext('checkout-reservations:' || identity_key));

  update public.product_checkout_reservations
  set status = 'expired'
  where status in ('creating', 'pending') and expires_at <= now();

  if p_buyer_user_id is null then
    select count(*) into active_guest_ip_count
    from public.product_checkout_reservations
    where buyer_user_id is null
      and status in ('creating', 'pending')
      and expires_at > now()
      and request_fingerprint = trim(p_request_fingerprint);

    select count(*) into active_guest_email_count
    from public.product_checkout_reservations
    where buyer_user_id is null
      and status in ('creating', 'pending')
      and expires_at > now()
      and lower(trim(buyer_email)) = normalized_guest_email;

    select count(*) into active_guest_total
    from public.product_checkout_reservations
    where buyer_user_id is null
      and status in ('creating', 'pending')
      and expires_at > now();

    if greatest(active_guest_ip_count, active_guest_email_count) + 1 > p_max_active_reservations
      or active_guest_total + 1 > guest_global_reservation_limit
    then
      raise exception 'Too many active checkout reservations';
    end if;
  else
    select count(*) into active_user_reservation_count
    from public.product_checkout_reservations
    where buyer_user_id = p_buyer_user_id
      and status in ('creating', 'pending')
      and expires_at > now();

    if active_user_reservation_count + 1 > p_max_active_reservations then
      raise exception 'Too many active checkout reservations';
    end if;
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
