import Stripe from 'npm:stripe@22.1.0';
import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { enforcePublicRateLimits } from '../_shared/request-security.ts';
import { readJsonBody } from '../_shared/http.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') || '', {
  // Stripe's SDK types only model its latest API; production remains intentionally pinned.
  // @ts-expect-error Older supported Stripe API version.
  apiVersion: '2026-02-25.clover',
  maxNetworkRetries: 1,
  timeout: 12_000
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
const allowGuestCheckout = Deno.env.get('STRIPE_ALLOW_GUEST_CHECKOUT') === 'true';
const requestedGuestMaxReservations = Number(Deno.env.get('STRIPE_MAX_ACTIVE_RESERVATIONS_PER_GUEST'));
const maxActiveReservationsPerGuest = Math.min(10, Math.max(1, Math.round(Number.isFinite(requestedGuestMaxReservations) ? requestedGuestMaxReservations : 5)));
const MAX_CHECKOUT_ITEMS = 20;
const MAX_ITEM_QUANTITY = 99;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const corsHeaders = {
  'Access-Control-Allow-Origin': siteUrl,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type CheckoutItemRequest = { productId: number; quantity: number };
type NegotiatedOfferRequest = { offerId: string; token: string };
type CheckoutPayload = {
  productId?: number;
  items?: CheckoutItemRequest[];
  returnPath?: string;
  guestEmail?: string;
  negotiatedOffer?: NegotiatedOfferRequest;
};
type NegotiatedOffer = {
  id: string;
  product_id: number;
  buyer_email: string;
  current_amount_cents: number;
  status: string;
  expires_at: string;
  stripe_session_id: string | null;
  access_token_hash: string | null;
  access_token_expires_at: string | null;
  access_token_revoked_at: string | null;
};
type CheckoutSessionCreateParams = NonNullable<Parameters<typeof stripe.checkout.sessions.create>[0]>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function normalizeItems(payload: CheckoutPayload) {
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

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hashOfferAccessToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64Url(new Uint8Array(digest));
}

async function legacyOfferAccessToken(offerId: string) {
  const signingKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(serviceRoleKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    signingKey,
    new TextEncoder().encode(`djhc-offer-access:v1:${offerId}`)
  ));
  return base64Url(signature);
}

function tokensMatch(left = '', right = '') {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function offerCheckoutStillValid(offer: NegotiatedOffer) {
  return offer.status === 'accepted'
    && Number.isFinite(Date.parse(offer.expires_at))
    && Date.parse(offer.expires_at) > Date.now()
    && Number.isSafeInteger(Number(offer.current_amount_cents))
    && Number(offer.current_amount_cents) >= 50
    && Number(offer.current_amount_cents) <= 99_999_999;
}

async function validateNegotiatedOffer(input: unknown, requestedItems: CheckoutItemRequest[]) {
  const raw = input && typeof input === 'object' ? input as Partial<NegotiatedOfferRequest> : {};
  const offerId = String(raw.offerId || '').trim();
  const token = String(raw.token || '').trim();
  if (!uuidPattern.test(offerId) || !token) {
    return { error: 'This negotiated checkout link is invalid.', status: 400 };
  }
  if (requestedItems.length !== 1 || requestedItems[0]?.quantity !== 1) {
    return { error: 'A negotiated price applies to one listing only.', status: 400 };
  }
  const { data, error } = await admin
    .from('negotiated_offers')
    .select('id,product_id,buyer_email,current_amount_cents,status,expires_at,stripe_session_id,access_token_hash,access_token_expires_at,access_token_revoked_at')
    .eq('id', offerId)
    .maybeSingle();
  if (error) throw new Error(`Offer lookup failed: ${error.message}`);
  if (!data) return { error: 'This negotiated offer could not be found.', status: 404 };
  const offer = data as NegotiatedOffer;
  const tokenExpiresAt = Date.parse(String(offer.access_token_expires_at || offer.expires_at || ''));
  const expectedToken = offer.access_token_hash
    ? offer.access_token_hash
    : await legacyOfferAccessToken(offerId);
  const suppliedToken = offer.access_token_hash ? await hashOfferAccessToken(token) : token;
  if (
    offer.access_token_revoked_at
    || !Number.isFinite(tokenExpiresAt)
    || tokenExpiresAt <= Date.now()
    || !tokensMatch(suppliedToken, expectedToken)
  ) {
    return { error: 'This negotiated checkout link is invalid or has expired.', status: 403 };
  }
  if (requestedItems[0].productId !== Number(offer.product_id)) {
    return { error: 'This negotiated price does not match the selected listing.', status: 400 };
  }
  if (!offerCheckoutStillValid(offer)) {
    if (['pending', 'countered', 'accepted'].includes(offer.status) && Date.parse(offer.expires_at) <= Date.now()) {
      await admin.from('negotiated_offers').update({
        status: 'expired',
        access_token_revoked_at: new Date().toISOString()
      }).eq('id', offer.id).eq('status', offer.status);
    }
    return { error: 'This negotiated price is no longer available.', status: 409 };
  }
  return { offer };
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

  let payload: CheckoutPayload = {};
  let requestedItems: CheckoutItemRequest[] = [];
  try {
    payload = await readJsonBody<CheckoutPayload>(request, 32 * 1024);
    requestedItems = normalizeItems(payload);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) || 'Invalid checkout request.' }, 400);
  }

  let negotiatedOffer: NegotiatedOffer | null = null;
  if (payload.negotiatedOffer != null) {
    try {
      const validation = await validateNegotiatedOffer(payload.negotiatedOffer, requestedItems);
      if ('error' in validation) return jsonResponse({ error: validation.error }, validation.status);
      negotiatedOffer = validation.offer;
    } catch (error) {
      return friendlyServerError(error, 'The negotiated price could not be verified. Please try again.');
    }
  }

  const jwt = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  let buyerUserId: string | null = null;
  let email = String(payload.guestEmail || '').trim().toLowerCase();
  const hasValidGuestEmail = allowGuestCheckout && emailPattern.test(email) && email.length <= 254;
  if (jwt) {
    const { data: userResult, error: userError } = await admin.auth.getUser(jwt);
    if (!userError && userResult?.user) {
      buyerUserId = userResult.user.id;
      email = String(userResult.user.email || '').trim().toLowerCase();
    } else if (!hasValidGuestEmail && !negotiatedOffer) {
      return jsonResponse({ error: 'Your session expired. Sign in again before checkout.' }, 401);
    }
  }
  if (negotiatedOffer) {
    const offerEmail = String(negotiatedOffer.buyer_email || '').trim().toLowerCase();
    if (buyerUserId && email !== offerEmail) {
      return jsonResponse({ error: 'Sign in with the email address that received this offer before checkout.' }, 403);
    }
    if (!buyerUserId && !allowGuestCheckout) {
      return jsonResponse({ error: 'Sign in before using this negotiated checkout.' }, 401);
    }
    // Ignore browser-provided guest email for negotiated pricing. The private
    // offer record is the source of truth for both recipient and amount.
    email = offerEmail;
  } else {
    if (!buyerUserId && !allowGuestCheckout) {
      return jsonResponse({ error: 'Sign in before checkout.' }, 401);
    }
    if (!buyerUserId && !hasValidGuestEmail) {
      return jsonResponse({ error: 'Enter a valid email address to continue as a guest.' }, 400);
    }
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
    const amount = negotiatedOffer && item.productId === Number(negotiatedOffer.product_id)
      ? Number(negotiatedOffer.current_amount_cents)
      : product ? checkoutAmountCents(product) : 0;
    const availableForNegotiatedCheckout = Boolean(
      product
      && product.is_deleted !== true
      && String(product.sale_status || 'available') === 'available'
      && availableQuantity(product) > 0
    );
    if (
      !product
      || (negotiatedOffer ? !availableForNegotiatedCheckout : !isDirectCheckoutEligible(product))
      || item.quantity > availableQuantity(product)
      || !Number.isSafeInteger(amount)
      || amount < 50
      || amount > 99_999_999
    ) {
      return jsonResponse({ error: `Listing #${item.productId} does not have the requested quantity available.` }, 409);
    }
  }

  if (negotiatedOffer?.stripe_session_id) {
    try {
      const existingSession = await stripe.checkout.sessions.retrieve(negotiatedOffer.stripe_session_id);
      if (
        existingSession.status === 'open'
        && existingSession.url
        && String(existingSession.metadata?.negotiated_offer_id || '') === negotiatedOffer.id
      ) {
        return jsonResponse({ url: existingSession.url, sessionId: existingSession.id, reused: true });
      }
    } catch (error) {
      console.warn('[create-checkout-session] Existing negotiated checkout session could not be reused', errorMessage(error));
    }
  }
  const activeReservationLimit = buyerUserId ? maxActiveReservationsPerUser : maxActiveReservationsPerGuest;
  let checkoutFingerprint = '';
  try {
    const rateLimit = await enforcePublicRateLimits(admin, request, {
      scope: 'checkout',
      discriminator: email,
      perIpLimit: 30,
      perIdentityLimit: 12,
      windowSeconds: 3600
    });
    checkoutFingerprint = rateLimit.requestFingerprint;
  } catch (error) {
    const message = errorMessage(error);
    if (/wait before|rate limit|too many/i.test(message)) {
      return jsonResponse({ error: 'Too many checkout attempts were started. Please wait before trying again.' }, 429);
    }
    return friendlyServerError(error, 'Checkout request limits could not be verified. Please contact DJ.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const standardCheckoutExpiresAt = nowSeconds + checkoutHoldMinutes * 60;
  let checkoutExpiresAt = standardCheckoutExpiresAt;
  if (negotiatedOffer) {
    // A private price is valid only through its accepted-offer deadline. Stripe
    // requires a Checkout Session to remain open for at least 30 minutes, so
    // do not create a session when the seller's deadline is already too close.
    const offerExpiresAt = Math.floor(Date.parse(negotiatedOffer.expires_at) / 1000);
    if (!Number.isFinite(offerExpiresAt) || offerExpiresAt <= nowSeconds + 30 * 60) {
      return jsonResponse({ error: 'This accepted offer is too close to its deadline to start checkout. Ask DJ to renew it.' }, 409);
    }
    checkoutExpiresAt = Math.min(standardCheckoutExpiresAt, offerExpiresAt);
  }
  const reservationExpiresAt = new Date((checkoutExpiresAt + 2 * 60) * 1000).toISOString();
  const reservationRequest = negotiatedOffer
    ? admin.rpc('reserve_negotiated_offer_checkout', {
        p_offer_id: negotiatedOffer.id,
        p_buyer_user_id: buyerUserId,
        p_buyer_email: email,
        p_request_fingerprint: checkoutFingerprint,
        p_expires_at: reservationExpiresAt,
        p_max_active_reservations: activeReservationLimit
      })
    : admin.rpc('reserve_checkout_items', {
        p_buyer_user_id: buyerUserId,
        p_buyer_email: email,
        p_request_fingerprint: checkoutFingerprint,
        p_items: requestedItems,
        p_expires_at: reservationExpiresAt,
        p_max_active_reservations: activeReservationLimit
      });
  const { data: reservations, error: reservationError } = await reservationRequest;
  if (reservationError || !Array.isArray(reservations) || reservations.length !== requestedItems.length) {
    console.error('[create-checkout-session] Reservation failed', reservationError);
    const reservationMessage = String(reservationError?.message || '');
    if (/too many active checkout reservations/i.test(reservationMessage)) {
      return jsonResponse({ error: 'You already have several checkout holds open. Complete or wait for one to expire before starting another checkout.' }, 429);
    }
    return jsonResponse({ error: 'One or more requested quantities are already reserved or unavailable.' }, 409);
  }
  const reservationIds = reservations.map((reservation) => String(reservation.id));

  const { data: profile } = buyerUserId
    ? await admin.from('customer_profiles').select('stripe_customer_id').eq('id', buyerUserId).maybeSingle()
    : { data: null };
  const stripeCustomerId = String(profile?.stripe_customer_id || '').trim();
  const customerOptions = stripeCustomerId
    ? { customer: stripeCustomerId }
    : { customer_email: email || undefined, customer_creation: 'always' as const };

  const lineItems = requestedItems.map((item) => {
    const product = productsById.get(item.productId)!;
    const amount = negotiatedOffer && item.productId === Number(negotiatedOffer.product_id)
      ? Number(negotiatedOffer.current_amount_cents)
      : checkoutAmountCents(product);
    const priceRange = parsePriceRangeLabel(String(product.display_price || product.price_label || ''));
    const imageGallery = Array.isArray(product.image_gallery) ? product.image_gallery : [];
    const image = absoluteImageUrl(String(product.image || imageGallery[0] || ''));
    const description = [
      product.description,
      priceRange ? `Guide price range: ${priceRange.label}` : '',
      negotiatedOffer ? `Private negotiated checkout price: $${(amount / 100).toFixed(2)}` : `Checkout price: $${(amount / 100).toFixed(2)}`,
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
    const metadata = {
      buyer_user_id: buyerUserId || '',
      checkout_mode: buyerUserId ? 'account' : 'guest',
      item_count: String(requestedItems.length),
      ...(negotiatedOffer ? {
        negotiated_offer_id: negotiatedOffer.id,
        negotiated_offer_price_cents: String(negotiatedOffer.current_amount_cents)
      } : {})
    };
    const negotiatedCancelPath = negotiatedOffer
      ? `/offer.html?offer=${encodeURIComponent(negotiatedOffer.id)}&checkout_cancelled=1`
      : payload.returnPath || '/cart.html';
    const sessionParams: CheckoutSessionCreateParams = {
      mode: 'payment',
      ...customerOptions,
      allow_promotion_codes: negotiatedOffer ? false : allowPromotionCodes,
      billing_address_collection: 'auto',
      shipping_address_collection: { allowed_countries: ['US'] },
      line_items: lineItems,
      metadata,
      payment_intent_data: { metadata },
      expires_at: checkoutExpiresAt,
      success_url: `${siteUrl}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: absoluteSiteUrl(negotiatedCancelPath),
      ...(negotiatedOffer ? { client_reference_id: negotiatedOffer.id } : {}),
      ...(shippingRateId ? { shipping_options: [{ shipping_rate: shippingRateId }] } : {})
    };
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

  if (negotiatedOffer) {
    const { data: updatedOffer, error: offerUpdateError } = await admin
      .from('negotiated_offers')
      .update({ stripe_session_id: checkoutSession.id })
      .eq('id', negotiatedOffer.id)
      .eq('status', 'accepted')
      .gt('expires_at', new Date().toISOString())
      .select('id')
      .maybeSingle();
    if (offerUpdateError || !updatedOffer) {
      if (offerUpdateError) console.error('[create-checkout-session] Could not attach negotiated offer session', offerUpdateError);
      try {
        await stripe.checkout.sessions.expire(checkoutSession.id);
      } catch (error) {
        console.error('[create-checkout-session] Could not expire negotiated checkout session', error);
      }
      await releaseReservations(reservationIds);
      return jsonResponse({ error: 'This negotiated price changed before checkout could begin. Return to your offer page for the latest status.' }, 409);
    }
    const { error: eventError } = await admin.from('negotiated_offer_events').insert({
      offer_id: negotiatedOffer.id,
      actor: 'customer',
      action: 'checkout_started',
      amount_cents: Number(negotiatedOffer.current_amount_cents)
    });
    if (eventError) console.error('[create-checkout-session] Could not record negotiated checkout start', eventError);
  }

  // The browser stores a tab-scoped cart snapshot under this exact session ID.
  // Returning it lets checkout-success reconcile only the purchased quantities
  // instead of clearing whatever the shopper added in another tab meanwhile.
  return jsonResponse({ url: checkoutSession.url, sessionId: checkoutSession.id });
});
