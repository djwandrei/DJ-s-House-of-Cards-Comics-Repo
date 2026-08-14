import Stripe from 'npm:stripe@22.1.0';
import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import {
  adjustShopifyInventory,
  isShopifyConfigured,
  shopifyGid
} from '../_shared/shopify.ts';
import {
  sendSaleNotification
} from '../_shared/sale-notifications.ts';
import type { SaleNotification, SaleNotificationItem } from '../_shared/sale-notifications.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  // Stripe's SDK types only model its latest API; production remains intentionally pinned.
  // @ts-expect-error Older supported Stripe API version.
  apiVersion: '2026-02-25.clover'
});
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET') || '';
const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

type Reservation = { id: string; product_id: number; quantity: number; status: string };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type OrderProduct = {
  id: number;
  name?: string | null;
  image?: string | null;
  price?: number | null;
  checkout_price?: number | null;
  price_label?: string | null;
  display_price?: string | null;
  category?: string | null;
  year?: number | null;
  condition?: string | null;
};

function isServerConfigured() {
  return Boolean(
    Deno.env.get('STRIPE_SECRET_KEY')
    && webhookSecret
    && supabaseUrl
    && serviceRoleKey
    && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)
  );
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function compactSessionMetadata(session: Stripe.Checkout.Session) {
  const shippingDetails = (
    session as Stripe.Checkout.Session & { shipping_details?: unknown }
  ).shipping_details;
  return {
    stripe_session_id: session.id,
    payment_status: session.payment_status,
    checkout_status: session.status,
    customer_details: session.customer_details || null,
    shipping_details: shippingDetails || null,
    total_details: session.total_details || null,
    metadata: session.metadata || {}
  };
}

function parsePriceRangeHigh(value = '') {
  const match = String(value || '').match(/\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:-|[\u2013\u2014]|\bto\b)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const first = Number(match[1].replace(/,/g, ''));
  const second = Number(match[2].replace(/,/g, ''));
  return Number.isFinite(first) && Number.isFinite(second) ? Math.max(first, second) : null;
}

function checkoutUnitAmount(product: Record<string, unknown>) {
  const explicit = Number(product.checkout_price);
  const rangeHigh = parsePriceRangeHigh(String(product.display_price || product.price_label || ''));
  const fallback = Number(product.price);
  const amount = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : rangeHigh ?? fallback;
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function assertNoSupabaseError(error: unknown, step: string) {
  if (!error) return;
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  throw new Error(`Supabase ${step} failed: ${message}`);
}

async function beginWebhookEvent(event: Stripe.Event) {
  const { error: insertError } = await admin.from('webhook_events').insert({
    stripe_event_id: event.id,
    event_type: event.type,
    processing_status: 'processing'
  });
  if (!insertError) return true;
  if (insertError.code !== '23505') assertNoSupabaseError(insertError, 'webhook event insert');

  const { data, error } = await admin
    .from('webhook_events')
    .select('processing_status')
    .eq('stripe_event_id', event.id)
    .single();
  assertNoSupabaseError(error, 'webhook event lookup');
  if (data?.processing_status === 'processed' || data?.processing_status === 'ignored') return false;
  const { error: updateError } = await admin.from('webhook_events').update({
    event_type: event.type,
    processing_status: 'processing',
    error_message: ''
  }).eq('stripe_event_id', event.id);
  assertNoSupabaseError(updateError, 'webhook event retry');
  return true;
}

async function finishWebhookEvent(eventId: string, status: 'processed' | 'failed' | 'ignored', errorMessage = '') {
  const { error } = await admin.from('webhook_events').update({
    processing_status: status,
    error_message: errorMessage.slice(0, 4000),
    processed_at: new Date().toISOString()
  }).eq('stripe_event_id', eventId);
  assertNoSupabaseError(error, 'webhook event completion');
}

async function getReservations(session: Stripe.Checkout.Session) {
  const { data, error } = await admin
    .from('product_checkout_reservations')
    .select('id,product_id,quantity,status')
    .eq('stripe_session_id', session.id)
    .order('product_id');
  assertNoSupabaseError(error, 'reservation lookup');
  if (Array.isArray(data) && data.length) return data as Reservation[];

  const legacyReservationId = String(session.metadata?.reservation_id || '').trim();
  if (!legacyReservationId) return [];
  const { data: legacy, error: legacyError } = await admin
    .from('product_checkout_reservations')
    .select('id,product_id,quantity,status')
    .eq('id', legacyReservationId)
    .maybeSingle();
  assertNoSupabaseError(legacyError, 'legacy reservation lookup');
  return legacy ? [legacy as Reservation] : [];
}

async function updateReservations(session: Stripe.Checkout.Session, status: 'pending' | 'paid' | 'expired' | 'released', expiresAt?: string) {
  const update: Record<string, unknown> = { status };
  if (expiresAt) update.expires_at = expiresAt;
  const { error } = await admin
    .from('product_checkout_reservations')
    .update(update)
    .eq('stripe_session_id', session.id);
  assertNoSupabaseError(error, 'reservation update');
}

async function upsertOrder(session: Stripe.Checkout.Session, status: string, reservations: Reservation[]) {
  const buyerUserId = String(session.metadata?.buyer_user_id || '') || null;
  const firstProductId = reservations[0]?.product_id || Number(session.metadata?.product_id || session.client_reference_id) || null;
  const { data: existingOrder, error: existingOrderError } = await admin
    .from('checkout_orders')
    .select('id,status,inventory_finalized_at')
    .eq('stripe_session_id', session.id)
    .maybeSingle();
  assertNoSupabaseError(existingOrderError, 'existing order lookup');
  const resolvedStatus = existingOrder?.status === 'paid' && status !== 'paid' ? 'paid' : status;

  const { data, error } = await admin.from('checkout_orders').upsert({
    product_id: firstProductId,
    buyer_user_id: buyerUserId,
    buyer_email: session.customer_details?.email || session.customer_email || '',
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : '',
    stripe_session_id: session.id,
    stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : '',
    amount_total: session.amount_total,
    currency: session.currency || 'usd',
    status: resolvedStatus,
    item_count: Math.max(1, reservations.reduce((total, reservation) => total + reservation.quantity, 0)),
    metadata: compactSessionMetadata(session)
  }, {
    onConflict: 'stripe_session_id'
  }).select('id,status,inventory_finalized_at,buyer_user_id,buyer_email,amount_total,currency,stripe_session_id,created_at').single();
  assertNoSupabaseError(error, 'order upsert');
  if (!data) throw new Error(`Supabase order upsert returned no row for Stripe session ${session.id}`);
  return data;
}

function negotiatedUnitAmount(session: Stripe.Checkout.Session, reservationCount: number) {
  if (reservationCount !== 1 || !uuidPattern.test(String(session.metadata?.negotiated_offer_id || '').trim())) return null;
  const amount = Number(session.metadata?.negotiated_offer_price_cents);
  return Number.isSafeInteger(amount) && amount >= 50 && amount <= 99_999_999 ? amount : null;
}

async function snapshotOrderItems(orderId: string, reservations: Reservation[], session: Stripe.Checkout.Session) {
  if (!reservations.length) return [];
  const productIds = reservations.map((reservation) => reservation.product_id);
  const { data: products, error } = await admin
    .from('products')
    .select('id,name,image,price,checkout_price,price_label,display_price,category,year,condition')
    .in('id', productIds);
  assertNoSupabaseError(error, 'order item product lookup');
  const productsById = new Map<number, OrderProduct>(
    (products || []).map((product) => [Number(product.id), product as OrderProduct])
  );
  const rows = reservations.map((reservation) => {
    const product = productsById.get(Number(reservation.product_id));
    return {
      order_id: orderId,
      product_id: reservation.product_id,
      quantity: reservation.quantity,
      unit_amount: negotiatedUnitAmount(session, reservations.length) ?? checkoutUnitAmount(product || {}),
      product_name: String(product?.name || `Listing #${reservation.product_id}`),
      product_image: String(product?.image || ''),
      product_price_label: String(product?.display_price || product?.price_label || ''),
      product_category: String(product?.category || ''),
      product_year: Number.isFinite(Number(product?.year)) ? Number(product?.year) : null,
      product_condition: String(product?.condition || '')
    };
  });
  const { error: upsertError } = await admin.from('checkout_order_items').upsert(rows, {
    onConflict: 'order_id,product_id'
  });
  assertNoSupabaseError(upsertError, 'order item snapshot');
  return rows;
}

async function markNegotiatedOfferPurchased(session: Stripe.Checkout.Session) {
  const offerId = String(session.metadata?.negotiated_offer_id || '').trim();
  if (!uuidPattern.test(offerId)) return;
  const { data: existing, error: lookupError } = await admin
    .from('negotiated_offers')
    .select('id,status,current_amount_cents')
    .eq('id', offerId)
    .eq('stripe_session_id', session.id)
    .maybeSingle();
  assertNoSupabaseError(lookupError, 'negotiated offer lookup');
  if (!existing || existing.status === 'purchased') return;
  const { data, error } = await admin
    .from('negotiated_offers')
    .update({
      status: 'purchased',
      stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      purchased_at: new Date().toISOString()
    })
    .eq('id', offerId)
    .eq('stripe_session_id', session.id)
    .eq('status', 'accepted')
    .select('id,current_amount_cents')
    .maybeSingle();
  assertNoSupabaseError(error, 'negotiated offer payment update');
  if (!data) return;
  const { error: eventError } = await admin.from('negotiated_offer_events').insert({
    offer_id: offerId,
    actor: 'system',
    action: 'purchased',
    amount_cents: Number(data.current_amount_cents)
  });
  if (eventError) console.error('[stripe-webhook] Could not record negotiated offer purchase', eventError.message);
}

async function clearNegotiatedOfferCheckoutSession(session: Stripe.Checkout.Session) {
  const offerId = String(session.metadata?.negotiated_offer_id || '').trim();
  if (!uuidPattern.test(offerId)) return;
  const { data, error } = await admin
    .from('negotiated_offers')
    .update({ stripe_session_id: null })
    .eq('id', offerId)
    .eq('stripe_session_id', session.id)
    .eq('status', 'accepted')
    .select('id,current_amount_cents')
    .maybeSingle();
  assertNoSupabaseError(error, 'negotiated offer checkout expiration update');
  if (!data) return;
  const { error: eventError } = await admin.from('negotiated_offer_events').insert({
    offer_id: offerId,
    actor: 'system',
    action: 'checkout_expired',
    amount_cents: Number(data.current_amount_cents)
  });
  if (eventError) console.error('[stripe-webhook] Could not record negotiated checkout expiration', eventError.message);
}

async function upsertCustomerProfile(session: Stripe.Checkout.Session, buyerUserId: string | null) {
  if (!buyerUserId || typeof session.customer !== 'string') return;
  const { error } = await admin.from('customer_profiles').upsert({
    id: buyerUserId,
    email: session.customer_details?.email || session.customer_email || '',
    stripe_customer_id: session.customer
  }, { onConflict: 'id' });
  assertNoSupabaseError(error, 'customer profile upsert');
}

async function syncCheckoutInventoryToShopify(
  session: Stripe.Checkout.Session,
  reservations: Reservation[],
  eventId: string
) {
  if (!isShopifyConfigured()) return;

  const productIds = reservations.map((reservation) => reservation.product_id);
  const { data: mappings, error } = await admin
    .from('shopify_product_mappings')
    .select('product_id,shopify_inventory_item_id,shopify_location_id')
    .in('product_id', productIds);
  assertNoSupabaseError(error, 'Shopify product mapping lookup');

  const mappingsByProductId = new Map(
    (mappings || []).map((mapping) => [Number(mapping.product_id), mapping])
  );
  const missingProductIds = productIds.filter((productId) => !mappingsByProductId.has(Number(productId)));
  if (missingProductIds.length) {
    throw new Error(`Shopify inventory mappings are missing for product ids: ${missingProductIds.join(', ')}`);
  }

  await adjustShopifyInventory({
    idempotencyKey: eventId,
    reason: 'sale',
    referenceDocumentUri: `gid://djshouseofcards/StripeCheckoutSession/${session.id}`,
    changes: reservations.map((reservation) => {
      const mapping = mappingsByProductId.get(Number(reservation.product_id))!;
      return {
        delta: -Math.abs(reservation.quantity),
        inventoryItemId: shopifyGid('InventoryItem', mapping.shopify_inventory_item_id),
        locationId: shopifyGid('Location', mapping.shopify_location_id)
      };
    })
  });
}

function saleNotificationFromStripe(
  session: Stripe.Checkout.Session,
  order: Record<string, unknown>,
  items: Array<Record<string, unknown>>,
  eventId: string
): SaleNotification {
  const notificationItems: SaleNotificationItem[] = items.map((item) => {
    const numericProductId = Number(item.product_id);
    return {
      productId: Number.isFinite(numericProductId) && numericProductId > 0
        ? numericProductId
        : String(item.product_id || ''),
      name: String(item.product_name || `Listing #${item.product_id || ''}`).trim(),
      quantity: Number(item.quantity) || 1,
      unitAmount: Number(item.unit_amount),
      priceLabel: String(item.product_price_label || ''),
      category: String(item.product_category || ''),
      image: String(item.product_image || '')
    };
  });
  return {
    provider: 'Stripe Checkout',
    eventId,
    platformOrderId: session.id,
    status: 'paid',
    buyerEmail: String(order.buyer_email || session.customer_details?.email || session.customer_email || ''),
    amountTotal: Number(order.amount_total ?? session.amount_total),
    currency: String(order.currency || session.currency || 'usd'),
    occurredAt: String(order.created_at || new Date().toISOString()),
    items: notificationItems,
    metadata: {
      stripe_session_id: session.id,
      stripe_payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : ''
    }
  };
}

async function finalizePaidCheckout(session: Stripe.Checkout.Session, eventId: string) {
  const reservations = await getReservations(session);
  if (!reservations.length) throw new Error(`No checkout reservations found for Stripe session ${session.id}`);
  const order = await upsertOrder(session, 'paid', reservations);
  const items = await snapshotOrderItems(order.id, reservations, session);
  await upsertCustomerProfile(session, order.buyer_user_id);
  const { error } = await admin.rpc('finalize_checkout_inventory', { p_stripe_session_id: session.id });
  assertNoSupabaseError(error, 'inventory finalization');
  await markNegotiatedOfferPurchased(session);
  await syncCheckoutInventoryToShopify(session, reservations, eventId);
  return saleNotificationFromStripe(session, order, items, eventId);
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, eventId: string) {
  if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    return await finalizePaidCheckout(session, eventId);
  }
  const reservations = await getReservations(session);
  const order = await upsertOrder(session, 'unpaid', reservations);
  if (order?.status === 'paid') return null;
  await updateReservations(session, 'pending', new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  return null;
}

async function handleNonPaidTerminalEvent(session: Stripe.Checkout.Session, orderStatus: 'unpaid' | 'expired', reservationStatus: 'released' | 'expired') {
  const reservations = await getReservations(session);
  const order = await upsertOrder(session, orderStatus, reservations);
  if (order?.status === 'paid') return;
  await updateReservations(session, reservationStatus);
  await clearNegotiatedOfferCheckoutSession(session);
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!isServerConfigured()) return jsonResponse({ error: 'Stripe webhook is not fully configured.' }, 503);
  const signature = request.headers.get('stripe-signature');
  if (!signature) return jsonResponse({ error: 'Missing Stripe signature.' }, 400);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(await request.text(), signature, webhookSecret);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Invalid Stripe signature.' }, 400);
  }

  try {
    if (!await beginWebhookEvent(event)) return jsonResponse({ received: true, duplicate: true });
    const session = event.data.object as Stripe.Checkout.Session;
    let saleNotification: SaleNotification | null = null;
    switch (event.type) {
      case 'checkout.session.completed':
        saleNotification = await handleCheckoutCompleted(session, event.id);
        break;
      case 'checkout.session.async_payment_succeeded':
        saleNotification = await finalizePaidCheckout(session, event.id);
        break;
      case 'checkout.session.async_payment_failed':
        await handleNonPaidTerminalEvent(session, 'unpaid', 'released');
        break;
      case 'checkout.session.expired':
        await handleNonPaidTerminalEvent(session, 'expired', 'expired');
        break;
      default:
        await finishWebhookEvent(event.id, 'ignored');
        return jsonResponse({ received: true, ignored: true });
    }
    await finishWebhookEvent(event.id, 'processed');
    if (saleNotification) {
      try {
        const result = await sendSaleNotification(saleNotification);
        if (!result.sent) console.warn('[stripe-webhook] Sale notification skipped:', result.skippedReason);
      } catch (notificationError) {
        console.error('[stripe-webhook] Sale notification failed', notificationError);
      }
    }
  } catch (error) {
    console.error('[stripe-webhook]', error);
    try {
      await finishWebhookEvent(event.id, 'failed', error instanceof Error ? error.message : String(error));
    } catch (loggingError) {
      console.error('[stripe-webhook] Could not persist failure state', loggingError);
    }
    return jsonResponse({ error: 'Webhook processing failed.' }, 500);
  }
  return jsonResponse({ received: true });
});
