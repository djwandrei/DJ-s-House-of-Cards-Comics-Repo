import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { queueSaleNotification } from '../_shared/sale-notifications.ts';
import { readJsonBody } from '../_shared/http.ts';
import type { SaleNotification, SaleNotificationItem } from '../_shared/sale-notifications.ts';

const inboundSecret = String(Deno.env.get('SALE_NOTIFICATION_INBOUND_SECRET') || '').trim();
const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function authorized(request: Request) {
  if (!inboundSecret) return false;
  const bearer = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const headerSecret = String(request.headers.get('x-djhc-notification-secret') || '').trim();
  return bearer === inboundSecret || headerSecret === inboundSecret;
}

function amountCents(value: unknown, centsValue?: unknown) {
  const explicitCents = Number(centsValue);
  if (Number.isFinite(explicitCents)) return Math.round(explicitCents);
  const amount = Number(String(value ?? '').replace(/[$,]/g, '').trim());
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function optionalIdentifier(value: unknown): string | number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value.trim().slice(0, 250) || null;
  return null;
}

function positiveQuantity(value: unknown) {
  const quantity = Math.floor(Number(value));
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizedItems(payload: Record<string, unknown>): SaleNotificationItem[] {
  const rawItems = Array.isArray(payload.items) ? payload.items.filter(isRecord) : [];
  const items = rawItems.map((item) => ({
    productId: optionalIdentifier(item.productId ?? item.product_id ?? item.listingId ?? item.listing_id),
    name: String(item.name || item.title || item.sku || item.product_name || 'Marketplace item').trim(),
    quantity: positiveQuantity(item.quantity),
    unitAmount: amountCents(item.price ?? item.unitAmount, item.unitAmountCents ?? item.unit_amount),
    priceLabel: String(item.priceLabel || item.price_label || ''),
    sku: String(item.sku || ''),
    category: String(item.category || ''),
    image: String(item.image || item.product_image || '')
  }));
  if (items.length) return items;
  return [{
    productId: optionalIdentifier(payload.productId ?? payload.product_id ?? payload.listingId ?? payload.listing_id),
    name: String(payload.name || payload.title || payload.product_name || 'Marketplace item').trim(),
    quantity: positiveQuantity(payload.quantity),
    unitAmount: amountCents(payload.price ?? payload.unitAmount, payload.unitAmountCents ?? payload.unit_amount),
    priceLabel: String(payload.priceLabel || payload.price_label || '')
  }];
}

function notificationFromPayload(payload: Record<string, unknown>): SaleNotification {
  const provider = String(payload.provider || payload.platform || payload.source || 'Marketplace').trim();
  const eventId = String(payload.eventId || payload.event_id || payload.orderId || payload.order_id || '').trim();
  if (!eventId) throw new Error('A stable event or order identifier is required.');
  return {
    provider,
    eventId,
    platformOrderId: optionalIdentifier(payload.platformOrderId ?? payload.platform_order_id ?? payload.orderId ?? payload.order_id),
    status: String(payload.status || 'sold'),
    buyerEmail: String(payload.buyerEmail || payload.buyer_email || payload.email || ''),
    amountTotal: amountCents(payload.amountTotal ?? payload.total ?? payload.orderTotal, payload.amountTotalCents ?? payload.amount_total),
    currency: String(payload.currency || 'usd'),
    occurredAt: String(payload.occurredAt || payload.occurred_at || payload.createdAt || payload.created_at || new Date().toISOString()),
    orderUrl: String(payload.orderUrl || payload.order_url || ''),
    dashboardUrl: String(payload.dashboardUrl || payload.dashboard_url || ''),
    items: normalizedItems(payload),
    metadata: {
      inbound: true,
      raw_provider: provider
    }
  };
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!authorized(request)) return jsonResponse({ error: 'Unauthorized sale notification webhook.' }, 401);

  let payload: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, 256 * 1024);
    if (!isRecord(parsed)) throw new Error('Invalid payload shape.');
    payload = parsed;
  } catch {
    return jsonResponse({ error: 'Invalid JSON payload.' }, 400);
  }

  try {
    const result = await queueSaleNotification(admin, notificationFromPayload(payload));
    return jsonResponse({ received: true, notification: result }, 202);
  } catch (error) {
    console.error('[sale-notification]', error);
    return jsonResponse({ error: 'Sale notification failed.' }, 500);
  }
});
