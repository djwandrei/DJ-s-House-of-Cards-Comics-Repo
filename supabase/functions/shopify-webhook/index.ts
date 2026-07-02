import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { shopifyShopDomain } from '../_shared/shopify.ts';
import { sendSaleNotification } from '../_shared/sale-notifications.ts';
import type { SaleNotification, SaleNotificationItem } from '../_shared/sale-notifications.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const clientSecret = String(Deno.env.get('SHOPIFY_CLIENT_SECRET') || '').trim();
const notifyInventoryZero = Deno.env.get('SALE_NOTIFY_SHOPIFY_INVENTORY_ZERO') === 'true';
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const encoder = new TextEncoder();

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function isConfigured() {
  try {
    return Boolean(
      supabaseUrl
      && serviceRoleKey
      && clientSecret
      && shopifyShopDomain()
      && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)
    );
  } catch {
    return false;
  }
}

function base64Bytes(value: string) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return new Uint8Array();
  }
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length || !left.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

async function validHmac(rawBody: string, providedHmac: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  );
  return timingSafeEqual(digest, base64Bytes(providedHmac));
}

async function recordFailure(options: {
  eventId: string;
  eventType: string;
  shopDomain: string;
  error: unknown;
  summary?: Record<string, unknown>;
}) {
  if (!options.eventId) return;
  const message = options.error instanceof Error ? options.error.message : String(options.error || '');
  const { error } = await admin.from('marketplace_webhook_events').upsert({
    provider: 'shopify',
    event_id: options.eventId,
    event_type: options.eventType || 'unknown',
    shop_domain: options.shopDomain || '',
    processing_status: 'failed',
    payload_summary: options.summary || {},
    error_message: message.slice(0, 4000),
    processed_at: new Date().toISOString()
  }, { onConflict: 'provider,event_id' });
  if (error) console.error('[shopify-webhook] Could not persist failure', error);
}

async function beginMarketplaceEvent(options: {
  eventId: string;
  eventType: string;
  shopDomain: string;
  summary?: Record<string, unknown>;
}) {
  const { error: insertError } = await admin.from('marketplace_webhook_events').insert({
    provider: 'shopify',
    event_id: options.eventId,
    event_type: options.eventType,
    shop_domain: options.shopDomain,
    processing_status: 'processing',
    payload_summary: options.summary || {}
  });
  if (!insertError) return true;
  if (insertError.code !== '23505') throw insertError;

  const { data, error } = await admin
    .from('marketplace_webhook_events')
    .select('processing_status')
    .eq('provider', 'shopify')
    .eq('event_id', options.eventId)
    .single();
  if (error) throw error;
  if (data?.processing_status === 'processed' || data?.processing_status === 'ignored') return false;

  const { error: updateError } = await admin.from('marketplace_webhook_events').update({
    event_type: options.eventType,
    shop_domain: options.shopDomain,
    processing_status: 'processing',
    payload_summary: options.summary || {},
    error_message: '',
    processed_at: null
  })
    .eq('provider', 'shopify')
    .eq('event_id', options.eventId);
  if (updateError) throw updateError;
  return true;
}

async function finishMarketplaceEvent(options: {
  eventId: string;
  status: 'processed' | 'failed' | 'ignored';
  productId?: number | null;
  errorMessage?: string;
}) {
  const { error } = await admin.from('marketplace_webhook_events').update({
    processing_status: options.status,
    product_id: options.productId || null,
    error_message: String(options.errorMessage || '').slice(0, 4000),
    processed_at: new Date().toISOString()
  })
    .eq('provider', 'shopify')
    .eq('event_id', options.eventId);
  if (error) throw error;
}

function amountCents(value: unknown) {
  const amount = Number(String(value ?? '').replace(/,/g, ''));
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function productIdFromSku(sku: unknown) {
  const match = String(sku || '').trim().match(/^DJHC-(\d+)$/i);
  return match ? Number(match[1]) : null;
}

function shopifyOrderItems(payload: Record<string, unknown>): SaleNotificationItem[] {
  const lineItems = Array.isArray(payload.line_items) ? payload.line_items as Array<Record<string, unknown>> : [];
  return lineItems.map((item) => {
    const productId = productIdFromSku(item.sku);
    return {
      productId,
      name: String(item.title || item.name || item.sku || `Shopify line item ${item.id || ''}`).trim(),
      quantity: Number(item.quantity) || 1,
      unitAmount: amountCents(item.price),
      sku: String(item.sku || ''),
      category: String(item.vendor || ''),
      image: ''
    };
  });
}

function shopifyOrderNotification(
  payload: Record<string, unknown>,
  eventId: string,
  shopDomain: string
): SaleNotification {
  const orderId = String(payload.id || '').trim();
  return {
    provider: 'Shopify',
    eventId,
    platformOrderId: String(payload.name || orderId || eventId),
    status: String(payload.financial_status || 'paid'),
    buyerEmail: String(payload.email || payload.contact_email || ''),
    amountTotal: amountCents(payload.current_total_price ?? payload.total_price),
    currency: String(payload.currency || 'usd'),
    occurredAt: String(payload.processed_at || payload.created_at || new Date().toISOString()),
    orderUrl: orderId ? `https://${shopDomain}/admin/orders/${orderId}` : null,
    items: shopifyOrderItems(payload),
    metadata: {
      shopify_order_id: orderId,
      shopify_webhook_id: eventId
    }
  };
}

async function sendNotificationWithoutBlocking(source: string, notification: SaleNotification) {
  try {
    const result = await sendSaleNotification(notification);
    if (!result.sent) console.warn(`[shopify-webhook] ${source} sale notification skipped:`, result.skippedReason);
  } catch (error) {
    console.error(`[shopify-webhook] ${source} sale notification failed`, error);
  }
}

async function handleOrderPaidWebhook(options: {
  eventId: string;
  eventType: string;
  shopDomain: string;
  payload: Record<string, unknown>;
}) {
  const items = shopifyOrderItems(options.payload);
  const summary = {
    order_id: options.payload.id || null,
    order_name: options.payload.name || null,
    current_total_price: options.payload.current_total_price ?? options.payload.total_price ?? null,
    currency: options.payload.currency || null,
    item_count: items.length,
    product_ids: items.map((item) => item.productId).filter(Boolean)
  };

  if (!await beginMarketplaceEvent({ ...options, summary })) {
    return jsonResponse({ received: true, duplicate: true });
  }

  const primaryProductId = Number(items.find((item) => item.productId)?.productId) || null;
  await finishMarketplaceEvent({
    eventId: options.eventId,
    status: 'processed',
    productId: primaryProductId
  });
  await sendNotificationWithoutBlocking(
    'order',
    shopifyOrderNotification(options.payload, options.eventId, options.shopDomain)
  );
  return jsonResponse({ received: true });
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!isConfigured()) return jsonResponse({ error: 'Shopify webhook is not configured.' }, 503);

  const eventId = String(request.headers.get('x-shopify-webhook-id') || '').trim();
  const eventType = String(request.headers.get('x-shopify-topic') || '').trim().toLowerCase();
  const shopDomain = String(request.headers.get('x-shopify-shop-domain') || '').trim().toLowerCase();
  const hmac = String(request.headers.get('x-shopify-hmac-sha256') || '').trim();
  const rawBody = await request.text();

  if (!eventId || !eventType || !shopDomain || !hmac) {
    return jsonResponse({ error: 'Missing Shopify webhook headers.' }, 400);
  }
  if (shopDomain !== shopifyShopDomain()) {
    return jsonResponse({ error: 'Unexpected Shopify shop domain.' }, 401);
  }
  if (!await validHmac(rawBody, hmac)) {
    return jsonResponse({ error: 'Invalid Shopify webhook signature.' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'Invalid Shopify webhook JSON.' }, 400);
  }

  if (eventType === 'orders/paid') {
    try {
      return await handleOrderPaidWebhook({ eventId, eventType, shopDomain, payload });
    } catch (error) {
      console.error('[shopify-webhook]', error);
      await recordFailure({ eventId, eventType, shopDomain, error });
      return jsonResponse({ error: 'Shopify order webhook processing failed.' }, 500);
    }
  }

  if (eventType !== 'inventory_levels/update') {
    return jsonResponse({ received: true, ignored: true });
  }

  const inventoryItemId = Number(payload.inventory_item_id);
  const locationId = Number(payload.location_id);
  const available = Number(payload.available);
  const summary = {
    inventory_item_id: inventoryItemId,
    location_id: locationId,
    available,
    updated_at: payload.updated_at || null
  };

  if (
    !Number.isSafeInteger(inventoryItemId)
    || inventoryItemId <= 0
    || !Number.isSafeInteger(locationId)
    || locationId <= 0
    || !Number.isSafeInteger(available)
    || available < 0
  ) {
    await recordFailure({
      eventId,
      eventType,
      shopDomain,
      error: new Error('Invalid inventory level payload.'),
      summary
    });
    return jsonResponse({ error: 'Invalid inventory level payload.' }, 400);
  }

  try {
    const { data, error } = await admin.rpc('apply_shopify_inventory_level', {
      p_event_id: eventId,
      p_event_type: eventType,
      p_shop_domain: shopDomain,
      p_inventory_item_id: inventoryItemId,
      p_location_id: locationId,
      p_available: available,
      p_payload_summary: summary
    });
    if (error) throw error;
    const result = data as { processed?: boolean; product_id?: number; quantity_available?: number } | null;
    if (
      notifyInventoryZero
      && result?.processed
      && Number(result.quantity_available) <= 0
      && Number(result.product_id) > 0
    ) {
      await sendNotificationWithoutBlocking('inventory', {
        provider: 'Shopify Inventory',
        eventId,
        platformOrderId: eventId,
        status: 'inventory_zero',
        occurredAt: String(payload.updated_at || new Date().toISOString()),
        items: [{
          productId: Number(result.product_id),
          name: `Listing #${result.product_id}`,
          quantity: 1
        }],
        metadata: summary
      });
    }
    return jsonResponse({ received: true, result: data });
  } catch (error) {
    console.error('[shopify-webhook]', error);
    await recordFailure({ eventId, eventType, shopDomain, error, summary });
    return jsonResponse({ error: 'Shopify webhook processing failed.' }, 500);
  }
});
