import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import Stripe from 'npm:stripe@22.1.0';
import { requireSiteAdmin, SiteAdminError } from '../_shared/admin-auth.ts';
import {
  processNotificationOutbox,
  queueEmailNotification
} from '../_shared/notification-outbox.ts';
import { enforcePublicRateLimits } from '../_shared/request-security.ts';
import { readJsonBody } from '../_shared/http.ts';
import { timingSafeEqualText } from '../_shared/constant-time.ts';

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const offerReplyTo = String(
  Deno.env.get('OFFER_NOTIFICATION_EMAIL_REPLY_TO')
    || Deno.env.get('INQUIRY_NOTIFICATION_EMAIL_REPLY_TO')
    || Deno.env.get('SALE_NOTIFICATION_EMAIL_REPLY_TO')
    || ''
).trim();
const offerRecipients = String(
  Deno.env.get('OFFER_NOTIFICATION_EMAIL_TO')
    || Deno.env.get('INQUIRY_NOTIFICATION_EMAIL_TO')
    || Deno.env.get('SALE_NOTIFICATION_EMAIL_TO')
    || ''
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const stripeSecretKey = String(Deno.env.get('STRIPE_SECRET_KEY') || '').trim();
const inquiryUploadBucket = String(Deno.env.get('INQUIRY_UPLOAD_BUCKET') || 'collector-inquiry-uploads').trim();
const requestedExpirationDays = Number(Deno.env.get('OFFER_EXPIRATION_DAYS'));
const defaultExpirationDays = Math.min(30, Math.max(1, Math.round(
  Number.isFinite(requestedExpirationDays) ? requestedExpirationDays : 7
)));
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const activeOfferStatuses = ['pending', 'countered', 'accepted'];
const inquiryStatuses = new Set(['new', 'reviewing', 'replied', 'closed', 'spam']);
const adminDecisions = new Set(['accept', 'counter', 'decline']);
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, {
  // Stripe's SDK types only model its latest API; production remains intentionally pinned.
  // @ts-expect-error Older supported Stripe API version.
  apiVersion: '2026-02-25.clover',
  maxNetworkRetries: 1,
  timeout: 12_000
}) : null;

const corsHeaders = {
  'Access-Control-Allow-Origin': siteUrl,
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type ProductRow = {
  id: number;
  name?: string | null;
  category?: string | null;
  image?: string | null;
  image_gallery?: unknown;
  price?: number | null;
  checkout_price?: number | null;
  price_label?: string | null;
  display_price?: string | null;
  is_deleted?: boolean | null;
  checkout_enabled?: boolean | null;
  sale_status?: string | null;
  quantity_available?: number | null;
  copy_count?: number | null;
};

type OfferRow = {
  id: string;
  product_id: number | null;
  product_name: string;
  product_image: string;
  product_public_amount_cents: number | null;
  buyer_name: string;
  buyer_email: string;
  buyer_phone: string;
  customer_note: string;
  admin_note: string;
  initial_amount_cents: number;
  current_amount_cents: number;
  currency: string;
  status: string;
  expires_at: string;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  accepted_at: string | null;
  declined_at: string | null;
  rejected_at: string | null;
  purchased_at: string | null;
  access_token_hash: string | null;
  access_token_expires_at: string | null;
  access_token_revoked_at: string | null;
  submission_key?: string | null;
  created_at: string;
  updated_at: string;
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || error || '');
}

function safeText(value: unknown, limit: number) {
  return String(value ?? '').trim().slice(0, limit);
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function allowedOrigin(request: Request) {
  const origin = String(request.headers.get('origin') || '').replace(/\/+$/, '');
  return !origin || origin === siteUrl;
}

function moneyCents(value: unknown, label = 'amount') {
  const normalized = String(value ?? '').trim().replace(/^\$/, '').replaceAll(',', '');
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error(`Enter a valid ${label}.`);
  }
  const dollars = Number(normalized);
  const cents = Math.round(dollars * 100);
  if (!Number.isSafeInteger(cents) || cents < 50 || cents > 99_999_999) {
    throw new Error(`Enter a ${label} between $0.50 and $999,999.99.`);
  }
  return cents;
}

function formatMoney(cents: number | null | undefined) {
  const amount = Number(cents);
  return Number.isFinite(amount) ? `$${(amount / 100).toFixed(2)}` : '';
}

function expiresAtFromDays(value: unknown, fallbackDays = defaultExpirationDays) {
  const parsed = Number(value);
  const days = Number.isInteger(parsed) && parsed >= 1 && parsed <= 30 ? parsed : fallbackDays;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function parsePriceRangeLabel(value = '') {
  const label = String(value || '').trim();
  const match = label.match(/\$?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:-|[\u2013\u2014]|\bto\b)\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const first = Number(match[1].replaceAll(',', ''));
  const second = Number(match[2].replaceAll(',', ''));
  return Number.isFinite(first) && Number.isFinite(second) ? Math.max(first, second) : null;
}

function checkoutPriceCents(product: ProductRow) {
  const direct = Number(product.checkout_price);
  const range = parsePriceRangeLabel(String(product.display_price || product.price_label || ''));
  const fallback = Number(product.price);
  const dollars = Number.isFinite(direct) && direct > 0
    ? direct
    : range ?? (Number.isFinite(fallback) && fallback > 0 ? fallback : null);
  return dollars == null ? null : Math.round(dollars * 100);
}

function availableQuantity(product: ProductRow) {
  const quantity = Number(product.quantity_available ?? product.copy_count ?? 1);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 0;
}

function isOfferable(product: ProductRow | null | undefined) {
  return Boolean(
    product
    && product.is_deleted !== true
    && String(product.sale_status || 'available') === 'available'
    && availableQuantity(product) > 0
  );
}

function productImage(product: ProductRow) {
  if (String(product.image || '').trim()) return String(product.image).trim();
  return Array.isArray(product.image_gallery)
    ? String(product.image_gallery.find((value) => String(value || '').trim()) || '').trim()
    : '';
}

function isConfigured() {
  return Boolean(
    supabaseUrl
    && serviceRoleKey
    && /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl)
    && /^https:\/\/[a-z0-9.-]+/i.test(siteUrl)
  );
}

function base64Url(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function randomOfferAccessToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function hashOfferAccessToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return base64Url(new Uint8Array(digest));
}

// Compatibility for links issued before random capability tokens were added.
// Legacy links are accepted only through the offer's existing expiration.
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

async function newOfferCapability(expiresAt: string) {
  const token = randomOfferAccessToken();
  return {
    token,
    access_token_hash: await hashOfferAccessToken(token),
    access_token_expires_at: expiresAt,
    access_token_revoked_at: null
  };
}

function customerOfferUrl(offerId: string, token: string) {
  // The capability is in the fragment, so it is not sent in HTTP requests,
  // access logs, or Referer headers. The page moves it into sessionStorage.
  return `${siteUrl}/offer.html?offer=${encodeURIComponent(offerId)}#token=${encodeURIComponent(token)}`;
}

const tokensMatch = timingSafeEqualText;

function inboxUrl(offerId = '') {
  const query = offerId ? `?offer=${encodeURIComponent(offerId)}` : '';
  return `${siteUrl}/inbox.html${query}`;
}

async function queueOfferEmail(eventKey: string, input: {
  to: string[];
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
}) {
  const queued = await queueEmailNotification(admin, eventKey, 'offer', {
    ...input,
    ...(input.replyTo || offerReplyTo ? { replyTo: input.replyTo || offerReplyTo } : {})
  });
  if (queued) {
    try {
      await processNotificationOutbox(admin, 10);
    } catch (error) {
      console.error('[offer-workflow] Immediate notification processing failed', errorMessage(error));
    }
  }
  return { queued };
}

async function queueOwnerOfferNotification(eventKey: string, offer: OfferRow, subject: string, summary: string) {
  const url = inboxUrl(offer.id);
  const text = [
    summary,
    `Listing: #${offer.product_id} ${offer.product_name}`,
    `Buyer: ${offer.buyer_name} <${offer.buyer_email}>`,
    offer.buyer_phone ? `Phone: ${offer.buyer_phone}` : '',
    `Current offer: ${formatMoney(offer.current_amount_cents)}`,
    offer.customer_note ? `Message: ${offer.customer_note}` : '',
    `Review in Admin Inbox: ${url}`
  ].filter(Boolean).join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#1f2933;">
      <h2 style="margin:0 0 12px;">${escapeHtml(summary)}</h2>
      <p style="margin:0 0 16px;">
        <strong>Listing:</strong> #${escapeHtml(offer.product_id)} ${escapeHtml(offer.product_name)}<br>
        <strong>Buyer:</strong> ${escapeHtml(offer.buyer_name)} &lt;${escapeHtml(offer.buyer_email)}&gt;<br>
        ${offer.buyer_phone ? `<strong>Phone:</strong> ${escapeHtml(offer.buyer_phone)}<br>` : ''}
        <strong>Current offer:</strong> ${escapeHtml(formatMoney(offer.current_amount_cents))}
      </p>
      ${offer.customer_note ? `<p style="white-space:pre-wrap;">${escapeHtml(offer.customer_note)}</p>` : ''}
      <p><a href="${escapeHtml(url)}">Open the Admin Inbox</a></p>
    </div>
  `;
  return await queueOfferEmail(eventKey, { to: offerRecipients, subject, text, html, replyTo: offer.buyer_email });
}

async function queueBuyerOfferNotification(
  eventKey: string,
  offer: OfferRow,
  subject: string,
  summary: string,
  accessToken = ''
) {
  const url = accessToken ? customerOfferUrl(offer.id, accessToken) : '';
  const text = [
    `Hi ${offer.buyer_name},`,
    '',
    summary,
    `Listing: #${offer.product_id} ${offer.product_name}`,
    `Agreed/current price: ${formatMoney(offer.current_amount_cents)}`,
    offer.admin_note ? `Note from DJ: ${offer.admin_note}` : '',
    url ? `Open your private offer page: ${url}` : ''
  ].filter(Boolean).join('\n');
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.45;color:#1f2933;">
      <h2 style="margin:0 0 12px;">${escapeHtml(summary)}</h2>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(offer.buyer_name)},</p>
      <p>
        <strong>Listing:</strong> #${escapeHtml(offer.product_id)} ${escapeHtml(offer.product_name)}<br>
        <strong>Agreed/current price:</strong> ${escapeHtml(formatMoney(offer.current_amount_cents))}
      </p>
      ${offer.admin_note ? `<p style="white-space:pre-wrap;"><strong>Note from DJ:</strong> ${escapeHtml(offer.admin_note)}</p>` : ''}
      ${url ? `<p><a href="${escapeHtml(url)}">Open your private offer page</a></p>` : ''}
    </div>
  `;
  return await queueOfferEmail(eventKey, { to: [offer.buyer_email], subject, text, html });
}

async function findOffer(id: string) {
  const { data, error } = await admin.from('negotiated_offers').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Offer lookup failed: ${error.message}`);
  return data as OfferRow | null;
}

async function addOfferEvent(offerId: string, actor: 'customer' | 'admin' | 'system', action: string, amountCents: number | null, note = '') {
  const { data, error } = await admin.from('negotiated_offer_events').insert({
    offer_id: offerId,
    actor,
    action,
    amount_cents: amountCents,
    note: safeText(note, 2000)
  }).select('id').single();
  if (error || !data) throw new Error(`Offer event could not be recorded: ${error?.message || 'no row returned'}`);
  return String(data.id);
}

async function invalidateOpenOfferCheckout(offer: OfferRow) {
  const sessionId = String(offer.stripe_session_id || '').trim();
  if (!sessionId) return;
  if (!stripe) throw new Error('The active Stripe checkout could not be withdrawn because Stripe is not configured.');
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.status === 'complete' || session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
    throw new Error('This checkout was already submitted. Wait for its payment status before changing the accepted offer.');
  }
  if (session.status === 'open') await stripe.checkout.sessions.expire(sessionId);
  const { error } = await admin
    .from('product_checkout_reservations')
    .update({ status: 'released' })
    .eq('stripe_session_id', sessionId)
    .in('status', ['creating', 'pending']);
  if (error) throw new Error(`Checkout reservation release failed: ${error.message}`);
}

function isExpired(offer: OfferRow) {
  return activeOfferStatuses.includes(offer.status)
    && Number.isFinite(Date.parse(offer.expires_at))
    && Date.parse(offer.expires_at) <= Date.now();
}

async function expireIfNeeded(offer: OfferRow) {
  if (!isExpired(offer)) return offer;
  const { data, error } = await admin
    .from('negotiated_offers')
    .update({ status: 'expired', access_token_revoked_at: new Date().toISOString() })
    .eq('id', offer.id)
    .in('status', activeOfferStatuses)
    .lte('expires_at', new Date().toISOString())
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`Offer expiration update failed: ${error.message}`);
  if (data) {
    await addOfferEvent(offer.id, 'system', 'expired', offer.current_amount_cents);
    return data as OfferRow;
  }
  return await findOffer(offer.id) || offer;
}

async function requireOfferAccess(input: Record<string, unknown>) {
  const offerId = safeText(input.offerId, 50);
  const token = safeText(input.token, 120);
  if (!uuidPattern.test(offerId) || !token) return { error: jsonResponse({ error: 'This offer link is invalid.' }, 400) };
  const offer = await findOffer(offerId);
  if (!offer) return { error: jsonResponse({ error: 'This offer could not be found.' }, 404) };
  const accessExpiresAt = Date.parse(String(offer.access_token_expires_at || offer.expires_at || ''));
  if (offer.access_token_revoked_at || !Number.isFinite(accessExpiresAt) || accessExpiresAt <= Date.now()) {
    return { error: jsonResponse({ error: 'This offer link is invalid or has expired.' }, 403) };
  }
  const expectedToken = offer.access_token_hash
    ? offer.access_token_hash
    : await legacyOfferAccessToken(offerId);
  const suppliedToken = offer.access_token_hash ? await hashOfferAccessToken(token) : token;
  if (!tokensMatch(suppliedToken, expectedToken)) {
    return { error: jsonResponse({ error: 'This offer link is invalid or has expired.' }, 403) };
  }
  return { offer: await expireIfNeeded(offer) };
}

async function requireAdmin(request: Request) {
  try {
    const identity = await requireSiteAdmin(request, admin);
    return { ...identity, error: null as Response | null };
  } catch (error) {
    if (error instanceof SiteAdminError) {
      return { id: '', email: '', error: jsonResponse({ error: error.message }, error.status) };
    }
    throw error;
  }
}

function publicOffer(offer: OfferRow) {
  const productId = Number(offer.product_id);
  return {
    id: offer.id,
    product: {
      id: Number.isSafeInteger(productId) && productId > 0 ? productId : null,
      name: offer.product_name,
      image: offer.product_image
    },
    currentAmountCents: Number(offer.current_amount_cents),
    publicAmountCents: offer.product_public_amount_cents == null ? null : Number(offer.product_public_amount_cents),
    initialAmountCents: Number(offer.initial_amount_cents),
    status: offer.status,
    expiresAt: offer.expires_at,
    customerNote: offer.customer_note,
    adminNote: offer.admin_note,
    createdAt: offer.created_at,
    updatedAt: offer.updated_at,
    acceptedAt: offer.accepted_at,
    purchasedAt: offer.purchased_at,
    buyerName: offer.buyer_name
  };
}

function adminOffer(offer: OfferRow) {
  return {
    ...publicOffer(offer),
    buyerEmail: offer.buyer_email,
    buyerPhone: offer.buyer_phone,
    declinedAt: offer.declined_at,
    rejectedAt: offer.rejected_at,
    stripeSessionId: offer.stripe_session_id,
    stripePaymentIntentId: offer.stripe_payment_intent_id
  };
}

async function getProduct(productId: number) {
  const { data, error } = await admin
    .from('products')
    .select('id,name,category,image,image_gallery,price,checkout_price,price_label,display_price,is_deleted,checkout_enabled,sale_status,quantity_available,copy_count')
    .eq('id', productId)
    .maybeSingle();
  if (error) throw new Error(`Listing lookup failed: ${error.message}`);
  return data as ProductRow | null;
}

async function reuseOfferSubmission(submissionKey: string, productId: number, buyerEmail: string) {
  if (!submissionKey) return null;
  const { data: existing, error: existingError } = await admin
    .from('negotiated_offers')
    .select('*')
    .eq('submission_key', submissionKey)
    .maybeSingle();
  if (existingError) throw new Error(`Existing offer request lookup failed: ${existingError.message}`);
  if (!existing) return null;

  const existingOffer = existing as OfferRow;
  if (Number(existingOffer.product_id) !== productId || existingOffer.buyer_email !== buyerEmail) {
    return jsonResponse({ error: 'This offer request identifier is already in use.' }, 409);
  }
  if (!activeOfferStatuses.includes(existingOffer.status) || Date.parse(existingOffer.expires_at) <= Date.now()) {
    return jsonResponse({ accepted: true, reused: true, offer: publicOffer(existingOffer) });
  }

  const capability = await newOfferCapability(existingOffer.expires_at);
  const { data: refreshed, error: refreshError } = await admin
    .from('negotiated_offers')
    .update({
      access_token_hash: capability.access_token_hash,
      access_token_expires_at: capability.access_token_expires_at,
      access_token_revoked_at: null
    })
    .eq('id', existingOffer.id)
    .eq('status', existingOffer.status)
    .select('*')
    .maybeSingle();
  if (refreshError || !refreshed) throw new Error('Your private offer link could not be renewed.');
  const refreshedOffer = refreshed as OfferRow;
  await queueOwnerOfferNotification(
    `offer-submission:${refreshedOffer.id}:owner`,
    refreshedOffer,
    `[DJHC Offer] ${formatMoney(refreshedOffer.current_amount_cents)} for ${refreshedOffer.product_name}`,
    'New offer awaiting your review'
  );
  return jsonResponse({
    accepted: true,
    reused: true,
    offer: publicOffer(refreshedOffer),
    offerUrl: customerOfferUrl(refreshedOffer.id, capability.token)
  });
}

async function createOffer(request: Request, input: Record<string, unknown>) {
  if (safeText(input.website, 200)) return jsonResponse({ accepted: true }, 202);
  const productId = Number(input.productId);
  const buyerName = safeText(input.name, 120);
  const buyerEmail = safeText(input.email, 254).toLowerCase();
  const buyerPhone = safeText(input.phone, 80);
  const customerNote = safeText(input.message, 2000);
  const submissionKey = safeText(input.requestId, 50);
  let amountCents: number;
  try {
    amountCents = moneyCents(input.amount, 'offer amount');
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 400);
  }
  if (
    !Number.isSafeInteger(productId)
    || productId <= 0
    || buyerName.length < 2
    || !emailPattern.test(buyerEmail)
    || (submissionKey && !uuidPattern.test(submissionKey))
  ) {
    return jsonResponse({ error: 'Enter the listing, your name, a valid email address, and an offer amount.' }, 400);
  }

  if (submissionKey) {
    try {
      const reused = await reuseOfferSubmission(submissionKey, productId, buyerEmail);
      if (reused) return reused;
    } catch (error) {
      console.error('[offer-workflow] Existing offer request lookup failed', errorMessage(error));
      return jsonResponse({ error: 'Your offer could not be checked. Please try again.' }, 503);
    }
  }

  let product: ProductRow | null;
  try {
    product = await getProduct(productId);
  } catch (error) {
    console.error('[offer-workflow] Product lookup failed', errorMessage(error));
    return jsonResponse({ error: 'The listing could not be checked. Please try again.' }, 503);
  }
  if (!isOfferable(product)) return jsonResponse({ error: 'This listing is no longer available for an offer.' }, 409);

  try {
    await enforcePublicRateLimits(admin, request, {
      scope: 'negotiated-offer',
      discriminator: buyerEmail,
      perIpLimit: 12,
      perIdentityLimit: 5,
      windowSeconds: 3600
    });
  } catch (error) {
    const message = errorMessage(error);
    if (/wait before|rate limit|too many/i.test(message)) {
      return jsonResponse({ error: 'Please wait before submitting another offer.' }, 429);
    }
    console.error('[offer-workflow] Offer rate limit failed', message);
    return jsonResponse({ error: 'Your offer could not be accepted. Please try again.' }, 503);
  }

  const publicAmount = checkoutPriceCents(product!);
  const expiresAt = expiresAtFromDays(undefined);
  const capability = await newOfferCapability(expiresAt);
  const { data, error } = await admin.from('negotiated_offers').insert({
    product_id: productId,
    product_name: safeText(product!.name, 250) || `Listing #${productId}`,
    product_image: productImage(product!),
    product_public_amount_cents: publicAmount,
    buyer_name: buyerName,
    buyer_email: buyerEmail,
    buyer_phone: buyerPhone,
    customer_note: customerNote,
    initial_amount_cents: amountCents,
    current_amount_cents: amountCents,
    expires_at: expiresAt,
    submission_key: submissionKey || null,
    access_token_hash: capability.access_token_hash,
    access_token_expires_at: capability.access_token_expires_at,
    access_token_revoked_at: null
  }).select('*').single();
  if (error || !data) {
    if (submissionKey && String(error?.code || '') === '23505') {
      try {
        const reused = await reuseOfferSubmission(submissionKey, productId, buyerEmail);
        if (reused) return reused;
      } catch (reuseError) {
        console.error('[offer-workflow] Concurrent offer request recovery failed', errorMessage(reuseError));
      }
    }
    console.error('[offer-workflow] Offer insert failed', error?.message || 'No inserted row');
    return jsonResponse({ error: 'Your offer could not be saved. Please try again.' }, 503);
  }

  const offer = data as OfferRow;
  await addOfferEvent(offer.id, 'customer', 'submitted', offer.current_amount_cents, customerNote);
  await queueOwnerOfferNotification(
    `offer-submission:${offer.id}:owner`,
    offer,
    `[DJHC Offer] ${formatMoney(offer.current_amount_cents)} for ${offer.product_name}`,
    'New offer awaiting your review'
  );

  return jsonResponse({
    accepted: true,
    offer: publicOffer(offer),
    offerUrl: customerOfferUrl(offer.id, capability.token)
  }, 201);
}

async function viewOffer(input: Record<string, unknown>) {
  const access = await requireOfferAccess(input);
  if (access.error) return access.error;
  const offer = access.offer!;
  const { data: events, error } = await admin
    .from('negotiated_offer_events')
    .select('actor,action,amount_cents,note,created_at')
    .eq('offer_id', offer.id)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[offer-workflow] Offer event lookup failed', error.message);
    return jsonResponse({ error: 'Your offer could not be loaded. Please try again.' }, 503);
  }
  return jsonResponse({
    offer: publicOffer(offer),
    events: (events || []).map((event) => ({
      actor: event.actor,
      action: event.action,
      amountCents: event.amount_cents == null ? null : Number(event.amount_cents),
      note: String(event.note || ''),
      createdAt: event.created_at
    }))
  });
}

async function updateCustomerOffer(input: Record<string, unknown>, action: 'customer-accept' | 'customer-counter' | 'customer-reject') {
  const access = await requireOfferAccess(input);
  if (access.error) return access.error;
  const offer = access.offer!;
  let next: Record<string, unknown>;
  let eventAction = '';
  let eventAmount: number | null = offer.current_amount_cents;
  let ownerSummary = '';
  let ownerSubject = '';

  if (action === 'customer-accept') {
    if (offer.status !== 'countered') return jsonResponse({ error: 'This counteroffer is no longer available to accept.' }, 409);
    next = { status: 'accepted', accepted_at: new Date().toISOString() };
    eventAction = 'customer_accept';
    ownerSummary = 'Customer accepted your counteroffer';
    ownerSubject = `[DJHC Offer] Counteroffer accepted for ${offer.product_name}`;
  } else if (action === 'customer-counter') {
    if (offer.status !== 'countered') return jsonResponse({ error: 'A counteroffer is required before you can send another offer.' }, 409);
    let amountCents: number;
    try {
      amountCents = moneyCents(input.amount, 'counteroffer');
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
    const note = safeText(input.message, 2000);
    const nextExpiresAt = expiresAtFromDays(undefined);
    next = {
      status: 'pending',
      current_amount_cents: amountCents,
      customer_note: note,
      expires_at: nextExpiresAt,
      access_token_expires_at: nextExpiresAt
    };
    eventAction = 'customer_counter';
    eventAmount = amountCents;
    ownerSummary = 'Customer sent a counteroffer';
    ownerSubject = `[DJHC Offer] Counteroffer for ${offer.product_name}`;
  } else {
    if (!['pending', 'countered', 'accepted'].includes(offer.status)) {
      return jsonResponse({ error: 'This offer is already closed.' }, 409);
    }
    const note = safeText(input.message, 2000);
    next = {
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      customer_note: note || offer.customer_note,
      access_token_revoked_at: new Date().toISOString()
    };
    eventAction = 'customer_reject';
    ownerSummary = 'Customer declined the offer';
    ownerSubject = `[DJHC Offer] Customer declined ${offer.product_name}`;
  }

  if (action === 'customer-reject' && offer.status === 'accepted') {
    try {
      await invalidateOpenOfferCheckout(offer);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) || 'The active checkout could not be withdrawn.' }, 409);
    }
  }

  const { data, error } = await admin
    .from('negotiated_offers')
    .update(next)
    .eq('id', offer.id)
    .eq('status', offer.status)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[offer-workflow] Customer offer update failed', error.message);
    return jsonResponse({ error: 'Your response could not be saved. Please try again.' }, 503);
  }
  if (!data) return jsonResponse({ error: 'This offer changed before your response was saved. Refresh to see the latest status.' }, 409);

  const updatedOffer = data as OfferRow;
  const eventId = await addOfferEvent(updatedOffer.id, 'customer', eventAction, eventAmount, safeText(input.message, 2000));
  await queueOwnerOfferNotification(`offer-event:${eventId}:owner`, updatedOffer, ownerSubject, ownerSummary);
  return jsonResponse({ offer: publicOffer(updatedOffer) });
}

async function listAdminInbox(request: Request, input: Record<string, unknown>) {
  const access = await requireAdmin(request);
  if (access.error) return access.error;
  const limit = Math.min(100, Math.max(10, Math.floor(Number(input.limit) || 50)));
  const offerOffset = Math.max(0, Math.floor(Number(input.offerOffset) || 0));
  const inquiryOffset = Math.max(0, Math.floor(Number(input.inquiryOffset) || 0));
  const offerStatus = safeText(input.offerStatus, 24);
  const inquiryStatus = safeText(input.inquiryStatus, 24);

  await admin
    .from('negotiated_offers')
    .update({ status: 'expired', access_token_revoked_at: new Date().toISOString() })
    .in('status', activeOfferStatuses)
    .lte('expires_at', new Date().toISOString());

  let offerQuery = admin
    .from('negotiated_offers')
    .select('*')
    .order('updated_at', { ascending: false })
    .range(offerOffset, offerOffset + limit);
  if (offerStatus && offerStatus !== 'all') offerQuery = offerQuery.eq('status', offerStatus);

  let inquiryQuery = admin
    .from('collector_inquiries')
    .select('id,kind,name,email,phone,preferred_contact,subject,message,offer_amount,product_ids,source_path,photo_paths,status,created_at,updated_at')
    .order('updated_at', { ascending: false })
    .range(inquiryOffset, inquiryOffset + limit);
  if (inquiryStatus && inquiryStatus !== 'all') inquiryQuery = inquiryQuery.eq('status', inquiryStatus);

  const [{ data: offerRows, error: offersError }, { data: inquiryRows, error: inquiriesError }] = await Promise.all([offerQuery, inquiryQuery]);
  if (offersError || inquiriesError) {
    console.error('[offer-workflow] Admin inbox lookup failed', offersError?.message || inquiriesError?.message || 'Unknown error');
    return jsonResponse({ error: 'The Admin Inbox could not be loaded. Please try again.' }, 503);
  }

  const offers = (offerRows || []) as OfferRow[];
  const inquiries = inquiryRows || [];
  const allPhotoPaths = [...new Set(inquiries.flatMap((inquiry) => (
    Array.isArray(inquiry.photo_paths) ? inquiry.photo_paths.map(String).filter(Boolean) : []
  )))];
  const signedPhotos = new Map<string, string>();
  if (allPhotoPaths.length) {
    const { data: signedRows, error: signedError } = await admin.storage
      .from(inquiryUploadBucket)
      .createSignedUrls(allPhotoPaths, 60 * 60);
    if (signedError) console.error('[offer-workflow] Inquiry photo signing failed', signedError.message);
    for (const signed of signedRows || []) {
      if (signed.path && signed.signedUrl) signedPhotos.set(String(signed.path), String(signed.signedUrl));
    }
  }
  const notificationQueries = await Promise.all([
    admin.from('notification_outbox').select('id', { count: 'exact', head: true }).in('status', ['pending', 'processing']),
    admin.from('notification_outbox').select('id', { count: 'exact', head: true }).eq('status', 'failed')
  ]);
  const photoUrlsFor = (inquiry: Record<string, unknown>) => (
    Array.isArray(inquiry.photo_paths)
      ? inquiry.photo_paths.map((path) => signedPhotos.get(String(path)) || '').filter(Boolean)
      : []
  );
  return jsonResponse({
    offers: offers.slice(0, limit).map(adminOffer),
    inquiries: inquiries.slice(0, limit).map((inquiry) => ({
      id: String(inquiry.id),
      kind: String(inquiry.kind || ''),
      name: String(inquiry.name || ''),
      email: String(inquiry.email || ''),
      phone: String(inquiry.phone || ''),
      preferredContact: String(inquiry.preferred_contact || ''),
      subject: String(inquiry.subject || ''),
      message: String(inquiry.message || ''),
      offerAmount: inquiry.offer_amount == null ? null : Number(inquiry.offer_amount),
      productIds: Array.isArray(inquiry.product_ids) ? inquiry.product_ids.map(Number).filter(Number.isFinite) : [],
      sourcePath: String(inquiry.source_path || ''),
      photoUrls: photoUrlsFor(inquiry),
      status: String(inquiry.status || 'new'),
      createdAt: inquiry.created_at,
      updatedAt: inquiry.updated_at
    })),
    hasMoreOffers: offers.length > limit,
    hasMoreInquiries: inquiries.length > limit,
    notificationSummary: {
      pending: notificationQueries[0].error ? null : Number(notificationQueries[0].count || 0),
      failed: notificationQueries[1].error ? null : Number(notificationQueries[1].count || 0)
    }
  });
}

async function decideOffer(request: Request, input: Record<string, unknown>) {
  const adminAccess = await requireAdmin(request);
  if (adminAccess.error) return adminAccess.error;
  const offerId = safeText(input.offerId, 50);
  const decision = safeText(input.decision, 20).toLowerCase();
  if (!uuidPattern.test(offerId) || !adminDecisions.has(decision)) {
    return jsonResponse({ error: 'Choose a valid offer and decision.' }, 400);
  }
  const existingOffer = await findOffer(offerId);
  if (!existingOffer) return jsonResponse({ error: 'This offer could not be found.' }, 404);
  const offer = await expireIfNeeded(existingOffer);
  const allowedStatus = decision === 'decline'
    ? ['pending', 'countered', 'accepted']
    : ['pending', 'countered'];
  if (!allowedStatus.includes(offer.status)) {
    return jsonResponse({ error: 'This offer is no longer open for that decision.' }, 409);
  }

  const adminNote = safeText(input.note, 2000);
  const expiresAt = expiresAtFromDays(input.expiresInDays);
  let update: Record<string, unknown>;
  let eventAction = '';
  let subject = '';
  let summary = '';
  let nextAccessToken = '';
  if (decision === 'accept') {
    const capability = await newOfferCapability(expiresAt);
    nextAccessToken = capability.token;
    update = {
      status: 'accepted',
      admin_note: adminNote,
      accepted_at: new Date().toISOString(),
      expires_at: expiresAt,
      access_token_hash: capability.access_token_hash,
      access_token_expires_at: capability.access_token_expires_at,
      access_token_revoked_at: null
    };
    eventAction = 'admin_accept';
    subject = `[DJHC Offer Accepted] ${offer.product_name}`;
    summary = `DJ accepted your offer. You can purchase this item at the agreed price until ${new Date(expiresAt).toLocaleDateString('en-US')}.`;
  } else if (decision === 'counter') {
    let amountCents: number;
    try {
      amountCents = moneyCents(input.amount, 'counteroffer');
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) }, 400);
    }
    const capability = await newOfferCapability(expiresAt);
    nextAccessToken = capability.token;
    update = {
      status: 'countered',
      current_amount_cents: amountCents,
      admin_note: adminNote,
      expires_at: expiresAt,
      access_token_hash: capability.access_token_hash,
      access_token_expires_at: capability.access_token_expires_at,
      access_token_revoked_at: null
    };
    eventAction = 'admin_counter';
    subject = `[DJHC Counteroffer] ${offer.product_name}`;
    summary = `DJ sent a counteroffer of ${formatMoney(amountCents)}. Review it and accept, counter, or decline on your private offer page.`;
  } else {
    update = {
      status: 'declined',
      admin_note: adminNote,
      declined_at: new Date().toISOString(),
      access_token_revoked_at: new Date().toISOString()
    };
    eventAction = 'admin_decline';
    subject = `[DJHC Offer Update] ${offer.product_name}`;
    summary = 'DJ is unable to accept this offer.';
  }

  if (decision === 'decline' && offer.status === 'accepted') {
    try {
      await invalidateOpenOfferCheckout(offer);
    } catch (error) {
      return jsonResponse({ error: errorMessage(error) || 'The active checkout could not be withdrawn.' }, 409);
    }
  }

  const { data, error } = await admin
    .from('negotiated_offers')
    .update(update)
    .eq('id', offer.id)
    .eq('status', offer.status)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('[offer-workflow] Admin decision update failed', error.message);
    return jsonResponse({ error: 'The offer decision could not be saved. Please try again.' }, 503);
  }
  if (!data) return jsonResponse({ error: 'This offer changed before your decision was saved. Refresh the inbox.' }, 409);

  const updatedOffer = data as OfferRow;
  const eventId = await addOfferEvent(updatedOffer.id, 'admin', eventAction, updatedOffer.current_amount_cents, adminNote);
  await queueBuyerOfferNotification(
    `offer-event:${eventId}:buyer`,
    updatedOffer,
    subject,
    summary,
    nextAccessToken
  );
  return jsonResponse({ offer: adminOffer(updatedOffer) });
}

async function updateInquiry(request: Request, input: Record<string, unknown>) {
  const access = await requireAdmin(request);
  if (access.error) return access.error;
  const inquiryId = safeText(input.inquiryId, 50);
  const status = safeText(input.status, 24).toLowerCase();
  if (!uuidPattern.test(inquiryId) || !inquiryStatuses.has(status)) {
    return jsonResponse({ error: 'Choose a valid message and status.' }, 400);
  }
  const { data, error } = await admin
    .from('collector_inquiries')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', inquiryId)
    .select('id,status,updated_at')
    .maybeSingle();
  if (error) {
    console.error('[offer-workflow] Inquiry update failed', error.message);
    return jsonResponse({ error: 'The message status could not be saved. Please try again.' }, 503);
  }
  if (!data) return jsonResponse({ error: 'This message no longer exists.' }, 404);
  return jsonResponse({ inquiry: { id: String(data.id), status: String(data.status), updatedAt: data.updated_at } });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!allowedOrigin(request)) return jsonResponse({ error: 'This request origin is not allowed.' }, 403);
  if (!isConfigured()) return jsonResponse({ error: 'The offer service is not configured yet.' }, 503);

  let input: Record<string, unknown>;
  try {
    const parsed = await readJsonBody(request, 64 * 1024);
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return jsonResponse({ error: 'Please submit the form again.' }, 400);
  }

  try {
    switch (safeText(input.action, 40).toLowerCase()) {
      case 'create':
        return await createOffer(request, input);
      case 'view':
        return await viewOffer(input);
      case 'customer-accept':
      case 'customer-counter':
      case 'customer-reject':
        return await updateCustomerOffer(input, safeText(input.action, 40).toLowerCase() as 'customer-accept' | 'customer-counter' | 'customer-reject');
      case 'admin-list-inbox':
        return await listAdminInbox(request, input);
      case 'admin-decide':
        return await decideOffer(request, input);
      case 'admin-update-inquiry':
        return await updateInquiry(request, input);
      default:
        return jsonResponse({ error: 'Choose a valid offer action.' }, 400);
    }
  } catch (error) {
    console.error('[offer-workflow]', errorMessage(error));
    return jsonResponse({ error: 'The offer service could not complete that request. Please try again.' }, 503);
  }
});
