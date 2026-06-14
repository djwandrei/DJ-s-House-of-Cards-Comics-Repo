import Stripe from 'npm:stripe@22.1.0';
import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  apiVersion: '2026-02-25.clover' as any
});

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const siteUrl = (Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const shippingRateId = (Deno.env.get('STRIPE_SHIPPING_RATE_ID') || '').trim();
const allowFreeShipping = Deno.env.get('STRIPE_ALLOW_FREE_SHIPPING') === 'true';
const allowPromotionCodes = Deno.env.get('STRIPE_ALLOW_PROMOTION_CODES') === 'true';
const requestedHoldMinutes = Number(Deno.env.get('STRIPE_CHECKOUT_HOLD_MINUTES'));
const checkoutHoldMinutes = Math.min(1440, Math.max(31, Math.round(Number.isFinite(requestedHoldMinutes) ? requestedHoldMinutes : 31)));
const requestedMaxReservations = Number(Deno.env.get('STRIPE_MAX_ACTIVE_RESERVATIONS_PER_USER'));
const maxActiveReservationsPerUser = Math.min(50, Math.max(1, Math.round(Number.isFinite(requestedMaxReservations) ? requestedMaxReservations : 20)));
const MAX_CHECKOUT_ITEMS = 20;
const MAX_ITEM_QUANTITY = 99;
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const corsHeaders = {
  'Access-Control-Allow-Origin': siteUrl,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type CheckoutItemRequest = { productId: number; quantity: number };

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || error || '');
}

function friendlyServerError(error: unknown, fallback = 'Checkout could not be started. Please try again or contact DJ.') {
  console.error('[create-checkout-session]', errorMessage(error));
  return jsonResponse({ error: fallback }, 500);
}

function parsePriceRangeLabel(value = '') {
  const label = String(value || '').trim();
  const match = label.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:-|[\u2013\u2014]|\bto\b)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const first = Number(match[1].replace(/,/g, ''));
  const second = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(first) || !Number.isFinite(second)) return null;
  return { label, high: Math.max(first, second) };
}

function checkoutPriceDollars(product: Record<string, unknown>) {
  const explicitCheckoutPrice = Number(product.checkout_price);
  if (Number.isFinite(explicitCheckoutPrice) && explicitCheckoutPrice > 0) return explicitCheckoutPrice;
  const range = parsePriceRangeLabel(String(product.display_price || product.price_label || ''));
  if (range) return range.high;
  const price = Number(product.price);
  return Number.isFinite(price) ? price : null;
}

function checkoutAmountCents(product: Record<string, unknown>) {
  return Math.round(Number(checkoutPriceDollars(product)) * 100);
}

function availableQuantity(product: Record<string, unknown>) {
  const quantity = Number(product.quantity_available ?? product.copy_count ?? 1);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
}

function isDirectCheckoutEligible(product: Record<string, unknown>) {
  const price = checkoutPriceDollars(product);
  const display = String(product.display_price || product.price_label || '').toLowerCase();
  return Number.isFinite(price)
    && Number(price) > 0
    && product.is_deleted !== true
    && product.checkout_enabled !== false
    && String(product.sale_status || 'available') === 'available'
    && availableQuantity(product) > 0
    && !/contact|ask|inquir|availability/.test(display);
}

function normalizeItems(payload: { productId?: number; items?: CheckoutItemRequest[] }) {
  const source = Array.isArray(payload.items) && payload.items.length
    ? payload.items
    : [{ productId: Number(payload.productId), quantity: 1 }];
  const normalized = new Map<number, number>();
  for (const item of source) {
    const productId = Number(item?.productId);
    const quantity = Math.floor(Number(item?.quantity) || 0);
    if (!Number.isSafeInteger(productId) || productId <= 0 || quantity <= 0 || quantity > MAX_ITEM_QUANTITY) {
      throw new Error('Invalid checkout item.');
    }
    const combinedQuantity = (normalized.get(productId) || 0) + quantity;
    if (combinedQuantity > MAX_ITEM_QUANTITY) throw new Error('Invalid checkout item quantity.');
    normalized.set(productId, combinedQuantity);
  }
  if (!normalized.size || normalized.size > MAX_CHECKOUT_ITEMS) throw new Error('Choose between 1 and 20 checkout items.');
  return [...normalized.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

function isServerConfigured() {
  return Boolean(
    Deno.env.get('STRIPE_SECRET_KEY')
    && supabaseUrl
    && serviceRoleKey
    && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)
    && /^https:\/\/[a-z0-9.-]+/i.test(siteUrl)
  );
}

function absoluteSiteUrl(path = '/') {
  const rawPath = String(path || '/').trim();
  const safePath = rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : '/';
  try {
    const site = new URL(siteUrl);
    const url = new URL(safePath, `${site.origin}/`);
    return url.origin === site.origin ? url.href : `${site.origin}/`;
  } catch {
    return `${siteUrl}/`;
  }
}

function encodePathSegments(path = '') {
  return String(path || '').split('/').map((segment) => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment);
    }
  }).join('/').replace(/%28/g, '(').replace(/%29/g, ')');
}

function absoluteImageUrl(image = '') {
  const value = String(image || '').trim();
  if (!value) return '';
  try {
    const external = /^https?:\/\//i.test(value) ? new URL(value) : null;
    if (external) {
      external.pathname = encodePathSegments(external.pathname);
      return external.protocol === 'https:' ? external.href : '';
    }
    const localUrl = new URL(`/${encodePathSegments(value.replace(/^\/+/, ''))}`, `${siteUrl}/`);
    return localUrl.protocol === 'https:' ? localUrl.href : '';
  } catch {
    return '';
  }
}

async function releaseReservations(reservationIds: string[], status = 'released') {
  if (!reservationIds.length) return;
  const { error } = await admin.from('product_checkout_reservations').update({ status }).in('id', reservationIds);
  if (error) console.error('[create-checkout-session] Could not release reservations', error);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!isServerConfigured()) return jsonResponse({ error: 'Secure checkout is not fully configured on the server yet.' }, 503);
  if (!shippingRateId && !allowFreeShipping) {
    return jsonResponse({ error: 'Shipping is not configured yet. Please contact DJ to complete this purchase.' }, 503);
  }

  const jwt = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) return jsonResponse({ error: 'Sign in before checkout.' }, 401);
  const { data: userResult, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userResult?.user) return jsonResponse({ error: 'Your session expired. Sign in again before checkout.' }, 401);

  let payload: { productId?: number; items?: CheckoutItemRequest[]; returnPath?: string } = {};
  let requestedItems: CheckoutItemRequest[] = [];
  try {
    payload = await request.json();
    requestedItems = normalizeItems(payload);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) || 'Invalid checkout request.' }, 400);
  }

  const productIds = requestedItems.map((item) => item.productId);
  const { data: products, error: productError } = await admin
    .from('products')
    .select('id,name,category,team,year,condition,price,checkout_price,price_label,display_price,image,image_gallery,description,is_deleted,copy_count,quantity_available,checkout_enabled,sale_status')
    .in('id', productIds);
  if (productError) return friendlyServerError(productError, 'Checkout inventory could not be loaded. Please contact DJ.');
  if (!products || products.length !== productIds.length) return jsonResponse({ error: 'One or more listings are no longer available.' }, 404);

  const productsById = new Map(products.map((product) => [Number(product.id), product]));
  for (const item of requestedItems) {
    const product = productsById.get(item.productId);
    const amount = product ? checkoutAmountCents(product) : 0;
    if (
      !product
      || !isDirectCheckoutEligible(product)
      || item.quantity > availableQuantity(product)
      || !Number.isSafeInteger(amount)
      || amount < 50
      || amount > 99_999_999
    ) {
      return jsonResponse({ error: `Listing #${item.productId} does not have the requested quantity available.` }, 409);
    }
  }

  const nowIso = new Date().toISOString();
  const { error: expireError } = await admin
    .from('product_checkout_reservations')
    .update({ status: 'expired' })
    .eq('buyer_user_id', userResult.user.id)
    .in('status', ['creating', 'pending'])
    .lt('expires_at', nowIso);
  if (expireError) return friendlyServerError(expireError, 'Checkout reservations could not be checked. Please contact DJ.');

  const { count: activeCount, error: countError } = await admin
    .from('product_checkout_reservations')
    .select('id', { count: 'exact', head: true })
    .eq('buyer_user_id', userResult.user.id)
    .in('status', ['creating', 'pending'])
    .gt('expires_at', nowIso);
  if (countError) return friendlyServerError(countError, 'Checkout reservation limits could not be verified. Please contact DJ.');
  if ((activeCount || 0) + requestedItems.length > maxActiveReservationsPerUser) {
    return jsonResponse({ error: 'You already have several checkout holds open. Complete or wait for one to expire before starting another checkout.' }, 429);
  }

  const email = userResult.user.email || '';
  const reservationExpiresAt = new Date(Date.now() + (checkoutHoldMinutes + 2) * 60 * 1000).toISOString();
  const checkoutExpiresAt = Math.floor(Date.now() / 1000) + checkoutHoldMinutes * 60;
  const { data: reservations, error: reservationError } = await admin.rpc('reserve_checkout_items', {
    p_buyer_user_id: userResult.user.id,
    p_buyer_email: email,
    p_items: requestedItems,
    p_expires_at: reservationExpiresAt
  });
  if (reservationError || !Array.isArray(reservations) || reservations.length !== requestedItems.length) {
    console.error('[create-checkout-session] Reservation failed', reservationError);
    return jsonResponse({ error: 'One or more requested quantities are already reserved or unavailable.' }, 409);
  }
  const reservationIds = reservations.map((reservation) => String(reservation.id));

  const { data: profile } = await admin.from('customer_profiles').select('stripe_customer_id').eq('id', userResult.user.id).maybeSingle();
  const stripeCustomerId = String(profile?.stripe_customer_id || '').trim();
  const customerOptions = stripeCustomerId
    ? { customer: stripeCustomerId }
    : { customer_email: email || undefined, customer_creation: 'always' as const };

  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = requestedItems.map((item) => {
    const product = productsById.get(item.productId)!;
    const amount = checkoutAmountCents(product);
    const priceRange = parsePriceRangeLabel(String(product.display_price || product.price_label || ''));
    const imageGallery = Array.isArray(product.image_gallery) ? product.image_gallery : [];
    const image = absoluteImageUrl(String(product.image || imageGallery[0] || ''));
    const description = [
      product.description,
      priceRange ? `Guide price range: ${priceRange.label}` : '',
      `Checkout price: $${(amount / 100).toFixed(2)}`,
      product.year ? `Year: ${product.year}` : '',
      product.condition ? `Condition: ${product.condition}` : '',
      product.team ? `Team/Publisher: ${product.team}` : ''
    ].filter(Boolean).join('\n').slice(0, 1000);
    return {
      quantity: item.quantity,
      price_data: {
        currency: 'usd',
        unit_amount: amount,
        product_data: {
          name: String(product.name || `Listing #${product.id}`).slice(0, 250),
          description,
          images: image ? [image] : [],
          metadata: { product_id: String(product.id), category: String(product.category || '') }
        }
      }
    };
  });

  let checkoutSession: Stripe.Checkout.Session;
  try {
    const metadata = { buyer_user_id: userResult.user.id, item_count: String(requestedItems.length) };
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      ...customerOptions,
      allow_promotion_codes: allowPromotionCodes,
      billing_address_collection: 'auto',
      shipping_address_collection: { allowed_countries: ['US'] },
      line_items: lineItems,
      metadata,
      payment_intent_data: { metadata },
      expires_at: checkoutExpiresAt,
      success_url: `${siteUrl}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: absoluteSiteUrl(payload.returnPath || '/cart.html')
    };
    if (shippingRateId) sessionParams.shipping_options = [{ shipping_rate: shippingRateId }];
    checkoutSession = await stripe.checkout.sessions.create(sessionParams);
  } catch (error) {
    await releaseReservations(reservationIds);
    return friendlyServerError(error);
  }

  const { error: pendingError } = await admin
    .from('product_checkout_reservations')
    .update({
      status: 'pending',
      stripe_session_id: checkoutSession.id,
      expires_at: checkoutSession.expires_at ? new Date(checkoutSession.expires_at * 1000).toISOString() : reservationExpiresAt
    })
    .in('id', reservationIds)
    .eq('status', 'creating');
  if (pendingError) {
    try {
      await stripe.checkout.sessions.expire(checkoutSession.id);
    } catch (error) {
      console.error('[create-checkout-session] Could not expire orphan checkout session', error);
    }
    await releaseReservations(reservationIds);
    return friendlyServerError(pendingError, 'Checkout could not be finalized. Please try again.');
  }

  return jsonResponse({ url: checkoutSession.url });
});
