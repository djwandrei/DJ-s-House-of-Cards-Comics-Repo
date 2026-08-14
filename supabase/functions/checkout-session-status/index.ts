import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { readJsonBody } from '../_shared/http.ts';

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const SESSION_ID_PATTERN = /^cs_(?:test_|live_)?[A-Za-z0-9_]{12,255}$/;
const DEFAULT_ORIGINS = [
  'https://www.djshouseofcards-comics.com',
  'https://djshouseofcards-comics.com'
];

function origin(value: string) {
  try { return new URL(value).origin; } catch { return ''; }
}

const allowedOrigins = [...new Set([
  ...DEFAULT_ORIGINS,
  origin(siteUrl),
  ...String(Deno.env.get('PUBLIC_CORS_ALLOWED_ORIGINS') || '').split(',').map(origin)
].filter(Boolean))];

function headers(request: Request) {
  const requestOrigin = origin(request.headers.get('origin') || '');
  return {
    'Access-Control-Allow-Origin': requestOrigin && allowedOrigins.includes(requestOrigin)
      ? requestOrigin
      : allowedOrigins[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json',
    'Vary': 'Origin'
  };
}

function json(request: Request, body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(request) });
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: headers(request) });
  if (request.method !== 'POST') return json(request, { error: 'Method not allowed.' }, 405);
  const requestOrigin = origin(request.headers.get('origin') || '');
  if (requestOrigin && !allowedOrigins.includes(requestOrigin)) {
    return json(request, { error: 'This request origin is not allowed.' }, 403);
  }
  if (!supabaseUrl || !serviceRoleKey) {
    return json(request, { error: 'Checkout verification is not configured.' }, 503);
  }

  let payload: { sessionId?: string };
  try {
    payload = await readJsonBody<{ sessionId?: string }>(request, 4 * 1024);
  } catch {
    return json(request, { error: 'Invalid checkout verification request.' }, 400);
  }
  const sessionId = String(payload.sessionId || '').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return json(request, { error: 'Invalid checkout session.' }, 400);
  }

  const { data, error } = await admin
    .from('checkout_orders')
    .select('status')
    .eq('stripe_session_id', sessionId)
    .maybeSingle();
  if (error) {
    console.error('[checkout-session-status]', error.message);
    return json(request, { error: 'Checkout status could not be verified.' }, 503);
  }

  const orderStatus = String(data?.status || '').trim().toLowerCase();
  const status = orderStatus === 'paid'
    ? 'paid'
    : orderStatus === 'pending'
      ? 'pending'
      : orderStatus
        ? 'not_paid'
        : 'unknown';
  return json(request, { status });
});
