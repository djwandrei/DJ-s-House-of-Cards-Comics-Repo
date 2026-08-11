-- Collector inquiries, first-party measurement, and guest checkout support.
-- Apply through `supabase db push` before deploying the dependent Edge Functions.

create table if not exists public.collector_inquiries (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('contact', 'sell', 'trade', 'want_list', 'offer', 'bundle')),
  name text not null,
  email text not null,
  phone text not null default '',
  preferred_contact text not null default '',
  subject text not null default '',
  message text not null,
  offer_amount numeric(12, 2),
  product_ids bigint[] not null default array[]::bigint[],
  source_path text not null default '',
  photo_paths text[] not null default array[]::text[],
  status text not null default 'new' check (status in ('new', 'reviewing', 'replied', 'closed', 'spam')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists collector_inquiries_status_created_idx
  on public.collector_inquiries(status, created_at desc);
create index if not exists collector_inquiries_kind_created_idx
  on public.collector_inquiries(kind, created_at desc);

create table if not exists public.site_analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null,
  page_path text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists site_analytics_events_type_created_idx
  on public.site_analytics_events(event_type, created_at desc);
create index if not exists site_analytics_events_page_created_idx
  on public.site_analytics_events(page_path, created_at desc);

-- The fingerprint is a one-way server-side hash; raw IP addresses and shopper
-- email addresses are never stored in this table.
create table if not exists public.public_submission_rate_limits (
  scope text not null,
  fingerprint text not null,
  window_started_at timestamptz not null default now(),
  attempt_count integer not null default 1 check (attempt_count > 0),
  primary key (scope, fingerprint)
);

alter table public.collector_inquiries enable row level security;
alter table public.site_analytics_events enable row level security;
alter table public.public_submission_rate_limits enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'collector-inquiry-uploads',
  'collector-inquiry-uploads',
  false,
  6291456,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.take_public_submission_slot(
  p_scope text,
  p_fingerprint text,
  p_limit integer,
  p_window_seconds integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_limit public.public_submission_rate_limits%rowtype;
begin
  if length(trim(coalesce(p_scope, ''))) = 0
    or length(trim(coalesce(p_fingerprint, ''))) < 16
    or p_limit < 1
    or p_window_seconds < 60 then
    raise exception 'Invalid rate limit request';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_scope || ':' || p_fingerprint));
  select * into current_limit
  from public.public_submission_rate_limits
  where scope = p_scope and fingerprint = p_fingerprint
  for update;

  if not found then
    insert into public.public_submission_rate_limits (scope, fingerprint)
    values (p_scope, p_fingerprint);
    return;
  end if;

  if current_limit.window_started_at <= now() - make_interval(secs => p_window_seconds) then
    update public.public_submission_rate_limits
    set window_started_at = now(), attempt_count = 1
    where scope = p_scope and fingerprint = p_fingerprint;
    return;
  end if;

  if current_limit.attempt_count >= p_limit then
    raise exception 'Please wait before submitting another request.';
  end if;

  update public.public_submission_rate_limits
  set attempt_count = attempt_count + 1
  where scope = p_scope and fingerprint = p_fingerprint;
end;
$$;

create or replace function public.create_collector_inquiry(
  p_fingerprint text,
  p_kind text,
  p_name text,
  p_email text,
  p_phone text,
  p_preferred_contact text,
  p_subject text,
  p_message text,
  p_offer_amount numeric,
  p_product_ids bigint[],
  p_source_path text,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  inquiry_id uuid;
  normalized_kind text := lower(trim(coalesce(p_kind, '')));
  normalized_name text := trim(coalesce(p_name, ''));
  normalized_email text := lower(trim(coalesce(p_email, '')));
  normalized_message text := trim(coalesce(p_message, ''));
begin
  if normalized_kind not in ('contact', 'sell', 'trade', 'want_list', 'offer', 'bundle')
    or length(normalized_name) not between 2 and 120
    or length(normalized_email) > 254
    or normalized_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(normalized_message) not between 3 and 5000
    or length(coalesce(p_subject, '')) > 180
    or length(coalesce(p_phone, '')) > 80
    or length(coalesce(p_preferred_contact, '')) > 40
    or length(coalesce(p_source_path, '')) > 300
    or coalesce(array_length(p_product_ids, 1), 0) > 20
    or (p_offer_amount is not null and (p_offer_amount < 0 or p_offer_amount > 1000000)) then
    raise exception 'Invalid inquiry details.';
  end if;

  perform public.take_public_submission_slot('collector-inquiry', p_fingerprint, 5, 3600);

  insert into public.collector_inquiries (
    kind, name, email, phone, preferred_contact, subject, message,
    offer_amount, product_ids, source_path, metadata
  ) values (
    normalized_kind, normalized_name, normalized_email, trim(coalesce(p_phone, '')),
    trim(coalesce(p_preferred_contact, '')), trim(coalesce(p_subject, '')),
    normalized_message, p_offer_amount,
    coalesce(p_product_ids, array[]::bigint[]), trim(coalesce(p_source_path, '')),
    coalesce(p_metadata, '{}'::jsonb)
  ) returning id into inquiry_id;

  return inquiry_id;
end;
$$;

create or replace function public.record_site_analytics_event(
  p_fingerprint text,
  p_event_type text,
  p_page_path text,
  p_payload jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_event text := lower(trim(coalesce(p_event_type, '')));
  normalized_page text := trim(coalesce(p_page_path, ''));
begin
  if normalized_event not in (
    'page_view', 'catalog_search', 'catalog_filter', 'product_open',
    'add_to_cart', 'begin_checkout', 'guest_checkout', 'contact_submit',
    'inquiry_submit', 'offer_open', 'bundle_open', 'web_vitals'
  ) or normalized_page !~ '^/[A-Za-z0-9._/-]*$' or length(normalized_page) > 240 then
    raise exception 'Invalid analytics event.';
  end if;

  perform public.take_public_submission_slot('analytics-event', p_fingerprint, 180, 3600);
  insert into public.site_analytics_events (event_type, page_path, payload)
  values (normalized_event, normalized_page, coalesce(p_payload, '{}'::jsonb));
end;
$$;

revoke all on table public.collector_inquiries from anon, authenticated;
revoke all on table public.site_analytics_events from anon, authenticated;
revoke all on table public.public_submission_rate_limits from anon, authenticated;
revoke all on function public.take_public_submission_slot(text, text, integer, integer) from public;
revoke all on function public.create_collector_inquiry(text, text, text, text, text, text, text, text, numeric, bigint[], text, jsonb) from public;
revoke all on function public.record_site_analytics_event(text, text, text, jsonb) from public;
grant execute on function public.create_collector_inquiry(text, text, text, text, text, text, text, text, numeric, bigint[], text, jsonb) to service_role;
grant execute on function public.record_site_analytics_event(text, text, text, jsonb) to service_role;

create index if not exists product_checkout_reservations_guest_active_idx
  on public.product_checkout_reservations(lower(buyer_email), expires_at)
  where buyer_user_id is null and status in ('creating', 'pending');

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
  if (p_buyer_user_id is null and length(trim(coalesce(p_buyer_email, ''))) = 0)
    or jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) = 0 then
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

    select * into product_record
    from public.products
    where id = requested_product_id
    for update;

    if not found
      or product_record.is_deleted
      or not product_record.checkout_enabled
      or product_record.sale_status <> 'available' then
      raise exception 'Listing % is not available for checkout', requested_product_id;
    end if;

    update public.product_checkout_reservations
    set status = 'expired'
    where product_id = requested_product_id
      and status in ('creating', 'pending')
      and expires_at <= now();

    select coalesce(sum(quantity), 0) into active_quantity
    from public.product_checkout_reservations
    where product_id = requested_product_id
      and status in ('creating', 'pending')
      and expires_at > now();

    if requested_quantity > product_record.quantity_available - active_quantity then
      raise exception 'Requested quantity is unavailable for listing %', requested_product_id;
    end if;

    insert into public.product_checkout_reservations (
      product_id, buyer_user_id, buyer_email, quantity, status, expires_at
    ) values (
      requested_product_id, p_buyer_user_id, lower(trim(coalesce(p_buyer_email, ''))),
      requested_quantity, 'creating', p_expires_at
    ) returning * into reservation_record;

    return next reservation_record;
  end loop;
end;
$$;
