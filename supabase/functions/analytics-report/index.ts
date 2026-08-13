import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const adminEmail = String(Deno.env.get('ADMIN_EMAIL') || 'djwandrei@gmail.com').trim().toLowerCase();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const DEFAULT_CORS_ORIGINS = [
  'https://www.djshouseofcards-comics.com',
  'https://djshouseofcards-comics.com'
];

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
  ...String(Deno.env.get('ADMIN_CORS_ALLOWED_ORIGINS') || '').split(',').map(normalizedOrigin)
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

function allowedOrigin(request: Request) {
  const origin = normalizedOrigin(request.headers.get('origin') || '');
  return !origin || allowedCorsOrigins.includes(origin);
}

async function requireAdmin(request: Request) {
  const jwt = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!jwt) throw new Error('Admin sign-in is required.');
  if (serviceRoleKey && jwt === serviceRoleKey) return;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user || String(data.user.email || '').toLowerCase() !== adminEmail) {
    throw new Error('Admin authorization failed.');
  }
}

function reportWindow(value: unknown) {
  const days = Number(value);
  return [7, 30, 90].includes(days) ? days : 30;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(request) });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, request);
  if (!allowedOrigin(request)) return jsonResponse({ error: 'This request origin is not allowed.' }, 403, request);
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: 'Metrics reporting is not configured.' }, 503, request);

  let payload: Record<string, unknown> = {};
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid report request.' }, 400, request);
  }

  try {
    await requireAdmin(request);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : 'Admin authorization failed.' }, 403, request);
  }

  const { data, error } = await admin.rpc('get_site_analytics_report', {
    p_days: reportWindow(payload.days)
  });
  if (error) {
    console.error('[analytics-report]', error.message);
    return jsonResponse({ error: 'The metrics report could not be loaded.' }, 500, request);
  }

  return jsonResponse({ report: data || {} }, 200, request);
});
