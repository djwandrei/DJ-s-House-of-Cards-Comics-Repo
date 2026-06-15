-- Shopify marketplace synchronization support.
-- Run after supabase-schema.sql and supabase/stripe-schema.sql.

create table if not exists public.shopify_product_mappings (
  product_id bigint primary key references public.products(id) on delete cascade,
  sku text not null unique,
  source_class text not null default 'legacy',
  publish_enabled boolean not null default false,
  shop_domain text not null,
  shopify_product_id bigint not null unique,
  shopify_variant_id bigint not null unique,
  shopify_inventory_item_id bigint not null unique,
  shopify_location_id bigint not null,
  shopify_handle text not null default '',
  last_shopify_quantity integer,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.marketplace_webhook_events (
  provider text not null,
  event_id text not null,
  event_type text not null,
  shop_domain text not null default '',
  processing_status text not null default 'received',
  product_id bigint references public.products(id) on delete set null,
  payload_summary jsonb not null default '{}'::jsonb,
  error_message text not null default '',
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (provider, event_id)
);

create index if not exists shopify_product_mappings_inventory_lookup_idx
on public.shopify_product_mappings (shopify_inventory_item_id, shopify_location_id);

create index if not exists shopify_product_mappings_publish_idx
on public.shopify_product_mappings (source_class, publish_enabled);

create index if not exists marketplace_webhook_events_status_created_idx
on public.marketplace_webhook_events (provider, processing_status, created_at desc);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shopify_product_mappings_source_class_valid'
  ) then
    alter table public.shopify_product_mappings
    add constraint shopify_product_mappings_source_class_valid
    check (source_class in ('nonlegacy', 'legacy'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'shopify_product_mappings_quantity_nonnegative'
  ) then
    alter table public.shopify_product_mappings
    add constraint shopify_product_mappings_quantity_nonnegative
    check (last_shopify_quantity is null or last_shopify_quantity >= 0);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'marketplace_webhook_events_status_valid'
  ) then
    alter table public.marketplace_webhook_events
    add constraint marketplace_webhook_events_status_valid
    check (processing_status in ('received', 'processing', 'processed', 'failed', 'ignored'));
  end if;
end;
$$;

create or replace function public.set_shopify_mapping_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists shopify_product_mappings_set_updated_at on public.shopify_product_mappings;
create trigger shopify_product_mappings_set_updated_at
before update on public.shopify_product_mappings
for each row
execute function public.set_shopify_mapping_updated_at();

create or replace function public.apply_shopify_inventory_level(
  p_event_id text,
  p_event_type text,
  p_shop_domain text,
  p_inventory_item_id bigint,
  p_location_id bigint,
  p_available integer,
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
  next_sale_status text;
  next_checkout_enabled boolean;
  next_is_deleted boolean;
  has_checkout_price boolean;
begin
  if coalesce(p_event_id, '') = ''
    or p_inventory_item_id is null
    or p_location_id is null
    or p_available is null
    or p_available < 0
  then
    raise exception 'Invalid Shopify inventory webhook payload';
  end if;

  select processing_status
  into existing_status
  from public.marketplace_webhook_events
  where provider = 'shopify'
    and event_id = p_event_id;

  if existing_status in ('processed', 'ignored') then
    return jsonb_build_object('duplicate', true, 'status', existing_status);
  end if;

  insert into public.marketplace_webhook_events (
    provider,
    event_id,
    event_type,
    shop_domain,
    processing_status,
    payload_summary
  )
  values (
    'shopify',
    p_event_id,
    p_event_type,
    coalesce(p_shop_domain, ''),
    'processing',
    coalesce(p_payload_summary, '{}'::jsonb)
  )
  on conflict (provider, event_id) do update
  set
    event_type = excluded.event_type,
    shop_domain = excluded.shop_domain,
    processing_status = 'processing',
    payload_summary = excluded.payload_summary,
    error_message = '',
    processed_at = null;

  select *
  into mapping_record
  from public.shopify_product_mappings
  where shopify_inventory_item_id = p_inventory_item_id
    and shopify_location_id = p_location_id
  for update;

  if not found then
    update public.marketplace_webhook_events
    set
      processing_status = 'ignored',
      error_message = 'No Shopify product mapping matched this inventory level.',
      processed_at = now()
    where provider = 'shopify'
      and event_id = p_event_id;
    return jsonb_build_object('ignored', true, 'reason', 'mapping_not_found');
  end if;

  select *
  into product_record
  from public.products
  where id = mapping_record.product_id
  for update;

  if not found then
    raise exception 'Mapped product % no longer exists', mapping_record.product_id;
  end if;

  has_checkout_price := coalesce(product_record.checkout_price, product_record.price, 0) > 0
    and lower(coalesce(product_record.display_price, product_record.price_label, ''))
      !~ '(contact|ask|inquir|availability)';

  if p_available <= 0 then
    next_sale_status := 'sold';
    next_checkout_enabled := false;
    next_is_deleted := true;
  else
    next_sale_status := case
      when product_record.sale_status in ('sold', 'reserved') then 'available'
      else product_record.sale_status
    end;
    next_checkout_enabled := case
      when product_record.sale_status = 'sold' then has_checkout_price
      else product_record.checkout_enabled
    end;
    next_is_deleted := case
      when product_record.sale_status = 'sold' and coalesce(product_record.hidden_reason, '') = '' then false
      else product_record.is_deleted
    end;
  end if;

  update public.products
  set
    quantity_available = p_available,
    copy_count = p_available,
    checkout_enabled = next_checkout_enabled,
    sale_status = next_sale_status,
    is_deleted = next_is_deleted,
    sold_at = case
      when p_available <= 0 then coalesce(sold_at, now())
      when next_sale_status = 'available' then null
      else sold_at
    end,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'last_inventory_source', 'shopify',
      'last_shopify_webhook_id', p_event_id,
      'last_shopify_inventory_at', now()
    )
  where id = mapping_record.product_id;

  update public.shopify_product_mappings
  set
    last_shopify_quantity = p_available,
    last_synced_at = now()
  where product_id = mapping_record.product_id;

  update public.marketplace_webhook_events
  set
    processing_status = 'processed',
    product_id = mapping_record.product_id,
    error_message = '',
    processed_at = now()
  where provider = 'shopify'
    and event_id = p_event_id;

  return jsonb_build_object(
    'processed', true,
    'product_id', mapping_record.product_id,
    'quantity_available', p_available
  );
end;
$$;

revoke all on function public.apply_shopify_inventory_level(text, text, text, bigint, bigint, integer, jsonb) from public;
grant execute on function public.apply_shopify_inventory_level(text, text, text, bigint, bigint, integer, jsonb) to service_role;

alter table public.shopify_product_mappings enable row level security;
alter table public.marketplace_webhook_events enable row level security;

drop policy if exists "Admin can read Shopify product mappings" on public.shopify_product_mappings;
create policy "Admin can read Shopify product mappings"
on public.shopify_product_mappings
for select
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');

drop policy if exists "Admin can read marketplace webhook events" on public.marketplace_webhook_events;
create policy "Admin can read marketplace webhook events"
on public.marketplace_webhook_events
for select
using ((auth.jwt() ->> 'email') = 'djwandrei@gmail.com');
