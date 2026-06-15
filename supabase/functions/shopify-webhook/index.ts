import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { shopifyShopDomain } from '../_shared/shopify.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const clientSecret = String(Deno.env.get('SHOPIFY_CLIENT_SECRET') || '').trim();
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

  if (eventType !== 'inventory_levels/update') {
    return jsonResponse({ received: true, ignored: true });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'Invalid Shopify webhook JSON.' }, 400);
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
    return jsonResponse({ received: true, result: data });
  } catch (error) {
    console.error('[shopify-webhook]', error);
    await recordFailure({ eventId, eventType, shopDomain, error, summary });
    return jsonResponse({ error: 'Shopify webhook processing failed.' }, 500);
  }
});
