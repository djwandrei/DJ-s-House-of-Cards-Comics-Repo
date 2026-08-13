import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const DEFAULT_CORS_ORIGINS = [
  'https://www.djshouseofcards-comics.com',
  'https://djshouseofcards-comics.com'
];
const allowedEvents = new Set([
  'page_view', 'catalog_search', 'catalog_filter', 'product_open', 'add_to_cart',
  'begin_checkout', 'guest_checkout', 'contact_submit', 'inquiry_submit',
  'offer_open', 'bundle_open', 'web_vitals'
]);
function normalizedOrigin(value: string) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

const allowedCorsOrigins = [...new Set([
  ...DEFAULT_CORS_ORIGINS,
  normalizedOrigin(siteUrl),
  ...String(Deno.env.get('ANALYTICS_CORS_ALLOWED_ORIGINS') || '').split(',').map(normalizedOrigin)
].filter(Boolean))];

function corsHeadersFor(request: Request) {
  const requestOrigin = normalizedOrigin(request.headers.get('origin') || '');
  const allowOrigin = requestOrigin && allowedCorsOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedCorsOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, request: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(request), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function safeNumber(value: unknown, max: number) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? Math.round(number * 100) / 100 : undefined;
}

function safeText(value: unknown, max: number) {
  return String(value ?? '').trim().slice(0, max);
}

function allowedOrigin(request: Request) {
  const origin = normalizedOrigin(request.headers.get('origin') || '');
  return !origin || allowedCorsOrigins.includes(origin);
}

async function fingerprint(request: Request) {
  const ip = String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
    || String(request.headers.get('cf-connecting-ip') || '').trim()
    || 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`analytics-event:${ip}`));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function compactPayload(value: unknown) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const productId = safeNumber(source.productId, 9_999_999_999);
  const resultCount = safeNumber(source.resultCount, 100_000);
  const queryLength = safeNumber(source.queryLength, 200);
  const filterCount = safeNumber(source.filterCount, 100);
  const lcp = safeNumber(source.lcp, 120_000);
  const cls = safeNumber(source.cls, 100);
  const inp = safeNumber(source.inp, 120_000);
  const ttfb = safeNumber(source.ttfb, 120_000);
  const domContentLoaded = safeNumber(source.domContentLoaded, 120_000);
  const load = safeNumber(source.load, 120_000);
  const category = safeText(source.category, 80);
  const kind = safeText(source.kind, 40);
  return {
    ...(productId !== undefined ? { productId } : {}),
    ...(resultCount !== undefined ? { resultCount } : {}),
    ...(queryLength !== undefined ? { queryLength } : {}),
    ...(filterCount !== undefined ? { filterCount } : {}),
    ...(lcp !== undefined ? { lcp } : {}),
    ...(cls !== undefined ? { cls } : {}),
    ...(inp !== undefined ? { inp } : {}),
    ...(ttfb !== undefined ? { ttfb } : {}),
    ...(domContentLoaded !== undefined ? { domContentLoaded } : {}),
    ...(load !== undefined ? { load } : {}),
    ...(category ? { category } : {}),
    ...(kind ? { kind } : {})
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(request) });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, request);
  if (!allowedOrigin(request)) return jsonResponse({ error: 'This request origin is not allowed.' }, 403, request);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ recorded: false }, 202, request);

  let input: Record<string, unknown>;
  try {
    input = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid event.' }, 400, request);
  }
  const eventType = safeText(input.event, 40).toLowerCase();
  const pagePath = safeText(input.page, 240);
  if (!allowedEvents.has(eventType) || !/^\/[A-Za-z0-9._/-]*$/.test(pagePath)) {
    return jsonResponse({ error: 'Invalid event.' }, 400, request);
  }

  const { error } = await admin.rpc('record_site_analytics_event', {
    p_fingerprint: await fingerprint(request),
    p_event_type: eventType,
    p_page_path: pagePath,
    p_payload: compactPayload(input.data)
  });
  if (error) {
    // Telemetry must never alter a shopper flow; rate-limited samples are simply dropped.
    console.error('[analytics-event]', error.message);
  }
  return jsonResponse({ recorded: !error }, 202, request);
});
