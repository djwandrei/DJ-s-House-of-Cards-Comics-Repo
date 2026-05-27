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
const normalizedHoldMinutes = Number.isFinite(requestedHoldMinutes) ? requestedHoldMinutes : 31;
const checkoutHoldMinutes = Math.min(1440, Math.max(31, Math.round(normalizedHoldMinutes)));
const admin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false }
});

const corsHeaders = {
  'Access-Control-Allow-Origin': siteUrl,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function friendlyServerError(error: unknown, fallback = 'Checkout could not be started. Please try again or contact DJ.') {
  const message = error instanceof Error ? error.message : String(error || '');
  console.error('[create-checkout-session]', message);
  return jsonResponse({ error: fallback }, 500);
}

function isDirectCheckoutEligible(product: Record<string, unknown>) {
  const price = Number(product.price);
  const display = String(product.display_price || product.price_label || '').toLowerCase();
  if (!Number.isFinite(price) || price <= 0) return false;
  if (/contact|ask|inquir|availability/.test(display)) return false;
  if (/\$\s*[\d,.]+\s*(?:-|\u2013|\u2014|\bto\b)\s*\$?\s*[\d,.]+/.test(display)) return false;
  return true;
}

function isServerConfigured() {
  // Fail closed if any server-only secret or trusted origin setting is missing.
  return Boolean(
    Deno.env.get('STRIPE_SECRET_KEY') &&
    supabaseUrl &&
    serviceRoleKey &&
    /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) &&
    /^https:\/\/[a-z0-9.-]+/i.test(siteUrl)
  );
}

function absoluteSiteUrl(path = '/') {
  const rawPath = String(path || '/').trim();
  const safePath = rawPath.startsWith('/') && !rawPath.startsWith('//') ? rawPath : '/';
  try {
    const site = new URL(siteUrl);
    const url = new URL(safePath, `${site.origin}/`);
    if (url.origin !== site.origin) return `${site.origin}/`;
    return url.href;
  } catch {
    return `${siteUrl}/`;
  }
}

function encodePathSegments(path = '') {
  return String(path || '')
    .split('/')
    .map((segment) => {
      try {
        return encodeURIComponent(decodeURIComponent(segment));
      } catch {
        return encodeURIComponent(segment);
      }
    })
    .join('/')
    .replace(/%28/g, '(')
    .replace(/%29/g, ')');
}

function absoluteImageUrl(image = '') {
  const value = String(image || '').trim();
  if (!value) return '';
  try {
    const url = /^https?:\/\//i.test(value) ? new URL(value) : null;
    if (url) {
      url.pathname = encodePathSegments(url.pathname);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    }
    const localPath = encodePathSegments(value.replace(/^\/+/, ''));
    const localUrl = new URL(`/${localPath}`, `${siteUrl}/`);
    if (localUrl.protocol !== 'http:' && localUrl.protocol !== 'https:') return '';
    return localUrl.href;
  } catch {
    return '';
  }
}

async function expireStaleReservations(productId: number) {
  const nowIso = new Date().toISOString();
  const { error } = await admin
    .from('product_checkout_reservations')
    .update({ status: 'expired' })
    .eq('product_id', productId)
    .in('status', ['creating', 'pending'])
    .lt('expires_at', nowIso);

  if (error) throw error;
}

async function releaseReservation(reservationId: string, status = 'released') {
  const { error } = await admin
    .from('product_checkout_reservations')
    .update({ status })
    .eq('id', reservationId);

  if (error) {
    console.error('[create-checkout-session] Could not release reservation', reservationId, error);
  }
}

async function hasPaidOrder(productId: number) {
  const { data, error } = await admin
    .from('checkout_orders')
    .select('id')
    .eq('product_id', productId)
    .in('status', ['paid', 'complete', 'succeeded'])
    .limit(1);

  if (error) throw error;
  return Boolean(data?.length);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed.' }, 405);
  }

  if (!isServerConfigured()) {
    return jsonResponse({ error: 'Secure checkout is not fully configured on the server yet.' }, 503);
  }

  if (!shippingRateId && !allowFreeShipping) {
    return jsonResponse({
      error: 'Shipping is not configured yet. Please contact DJ to complete this purchase.'
    }, 503);
  }

  const authHeader = request.headers.get('Authorization') || '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!jwt) {
    return jsonResponse({ error: 'Sign in before checkout.' }, 401);
  }

  const { data: userResult, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userResult?.user) {
    return jsonResponse({ error: 'Your session expired. Sign in again before checkout.' }, 401);
  }

  let payload: { productId?: number; returnPath?: string } = {};
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid checkout request.' }, 400);
  }

  const productId = Number(payload.productId);
  if (!Number.isSafeInteger(productId) || productId <= 0) {
    return jsonResponse({ error: 'Choose a valid product before checkout.' }, 400);
  }

  const { data: product, error: productError } = await admin
    .from('products')
    .select('id,name,category,team,year,condition,price,price_label,display_price,image,image_gallery,description,is_deleted')
    .eq('id', productId)
    .eq('is_deleted', false)
    .single();

  if (productError || !product) {
    return jsonResponse({ error: 'That listing is no longer available.' }, 404);
  }

  if (!isDirectCheckoutEligible(product)) {
    return jsonResponse({ error: 'This listing needs confirmation before checkout.' }, 409);
  }

  try {
    await expireStaleReservations(productId);
  } catch (error) {
    return friendlyServerError(error, 'Checkout inventory could not be checked. Please contact DJ.');
  }

  try {
    if (await hasPaidOrder(productId)) {
      return jsonResponse({ error: 'That listing is no longer available.' }, 404);
    }
  } catch (error) {
    return friendlyServerError(error, 'Checkout order history could not be verified. Please contact DJ.');
  }

  const { data: activeReservation, error: activeReservationError } = await admin
    .from('product_checkout_reservations')
    .select('id,buyer_user_id,stripe_session_id,expires_at,status')
    .eq('product_id', productId)
    .in('status', ['creating', 'pending'])
    .maybeSingle();

  if (activeReservationError) {
    return friendlyServerError(activeReservationError, 'Checkout inventory could not be reserved. Please contact DJ.');
  }

  if (activeReservation) {
    const sameBuyer = activeReservation.buyer_user_id === userResult.user.id;
    const existingSessionId = String(activeReservation.stripe_session_id || '').trim();

    if (sameBuyer && existingSessionId) {
      try {
        const existingSession = await stripe.checkout.sessions.retrieve(existingSessionId);
        if (existingSession.status === 'open' && existingSession.url) {
          return jsonResponse({ url: existingSession.url });
        }
      } catch (error) {
        console.error('[create-checkout-session] Could not retrieve existing checkout session', error);
      }

      await releaseReservation(activeReservation.id, 'expired');
    } else if (sameBuyer) {
      return jsonResponse({
        error: 'Checkout is still being prepared for this listing. Please try again in a moment.'
      }, 409);
    } else {
      return jsonResponse({
        error: 'This listing is already in another customer checkout. Please try again in a few minutes or contact DJ.'
      }, 409);
    }
  }

  const email = userResult.user.email || undefined;
  const { data: profile } = await admin
    .from('customer_profiles')
    .select('stripe_customer_id')
    .eq('id', userResult.user.id)
    .maybeSingle();
  const stripeCustomerId = String(profile?.stripe_customer_id || '').trim();
  const customerOptions = stripeCustomerId
    ? { customer: stripeCustomerId }
    : { customer_email: email, customer_creation: 'always' as const };
  const amount = Math.round(Number(product.price) * 100);
  if (!Number.isSafeInteger(amount) || amount < 50) {
    return jsonResponse({ error: 'This listing needs confirmation before checkout.' }, 409);
  }
  const imageGallery = Array.isArray(product.image_gallery) ? product.image_gallery : [];
  const image = absoluteImageUrl(String(product.image || imageGallery[0] || ''));
  const description = [
    product.description,
    product.year ? `Year: ${product.year}` : '',
    product.condition ? `Condition: ${product.condition}` : '',
    product.team ? `Team/Publisher: ${product.team}` : ''
  ].filter(Boolean).join('\n').slice(0, 1000);

  // Keep the database reservation slightly longer than Stripe's session so a
  // delayed webhook cannot briefly reopen the item before Stripe marks it expired.
  const reservationExpiresAt = new Date(Date.now() + (checkoutHoldMinutes + 2) * 60 * 1000).toISOString();
  const checkoutExpiresAt = Math.floor(Date.now() / 1000) + (checkoutHoldMinutes * 60);
  const { data: reservation, error: reservationError } = await admin
    .from('product_checkout_reservations')
    .insert({
      product_id: productId,
      buyer_user_id: userResult.user.id,
      buyer_email: email || '',
      status: 'creating',
      expires_at: reservationExpiresAt
    })
    .select('id')
    .single();

  if (reservationError || !reservation) {
    if (reservationError?.code === '23505') {
      return jsonResponse({
        error: 'This listing is already in another customer checkout. Please try again in a few minutes or contact DJ.'
      }, 409);
    }
    return friendlyServerError(reservationError, 'Checkout reservation could not be created. Please contact DJ.');
  }

  const metadata = {
    product_id: String(product.id),
    buyer_user_id: userResult.user.id,
    reservation_id: String(reservation.id)
  };

  let checkoutSession: Stripe.Checkout.Session;
  try {
    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      client_reference_id: String(product.id),
      ...customerOptions,
      allow_promotion_codes: allowPromotionCodes,
      billing_address_collection: 'auto',
      shipping_address_collection: {
        allowed_countries: ['US']
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: String(product.name || `Listing #${product.id}`).slice(0, 250),
            description,
            images: image ? [image] : [],
            metadata: {
              product_id: String(product.id),
              category: String(product.category || '')
            }
          }
        }
      }],
      metadata,
      payment_intent_data: { metadata },
      expires_at: checkoutExpiresAt,
      success_url: `${siteUrl}/wishlist.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: absoluteSiteUrl(payload.returnPath || '/')
    };

    if (shippingRateId) {
      sessionParams.shipping_options = [{ shipping_rate: shippingRateId }];
    }

    checkoutSession = await stripe.checkout.sessions.create(sessionParams);
  } catch (error) {
    await releaseReservation(reservation.id);
    return friendlyServerError(error);
  }

  const expiresAt = checkoutSession.expires_at
    ? new Date(checkoutSession.expires_at * 1000).toISOString()
    : reservationExpiresAt;

  const { error: pendingError } = await admin
    .from('product_checkout_reservations')
    .update({
      status: 'pending',
      stripe_session_id: checkoutSession.id,
      expires_at: expiresAt
    })
    .eq('id', reservation.id)
    .eq('status', 'creating');

  if (pendingError) {
    try {
      await stripe.checkout.sessions.expire(checkoutSession.id);
    } catch (error) {
      console.error('[create-checkout-session] Could not expire orphan checkout session', error);
    }
    await releaseReservation(reservation.id);
    return friendlyServerError(pendingError, 'Checkout could not be finalized. Please try again.');
  }

  return jsonResponse({ url: checkoutSession.url });
});
