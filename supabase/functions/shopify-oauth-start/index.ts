import {
  isShopifyConfigured,
  shopifyClientCredentials,
  shopifyOauthScopes,
  shopifyShopDomain,
  verifyShopifyOauthHmac
} from '../_shared/shopify.ts';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const encoder = new TextEncoder();

function htmlResponse(body: string, status = 200, headers: HeadersInit = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers
    }
  });
}

function redirectResponse(location: string, state: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
      'Set-Cookie': `${OAUTH_STATE_COOKIE}=${state}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
    }
  });
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

async function signedManualState(shop: string) {
  const issuedAt = Date.now().toString(36);
  const nonce = crypto.randomUUID();
  const message = `${shop}|${issuedAt}|${nonce}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(shopifyClientCredentials().clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message))));
  return base64Url(encoder.encode(`${issuedAt}.${nonce}.${signature}`));
}

function callbackUrlFor(requestUrl: URL) {
  return String(Deno.env.get('SHOPIFY_OAUTH_CALLBACK_URL') || '').trim()
    || `${requestUrl.origin}/functions/v1/shopify-oauth-callback`;
}

function isOauthConfigured() {
  try {
    shopifyShopDomain();
    shopifyClientCredentials();
    return true;
  } catch {
    return false;
  }
}

function bearerToken(request: Request) {
  return String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

function authorizeUrlFor(requestUrl: URL, shop: string, state: string) {
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', shopifyClientCredentials().clientId);
  authorizeUrl.searchParams.set('scope', shopifyOauthScopes());
  authorizeUrl.searchParams.set('redirect_uri', callbackUrlFor(requestUrl));
  authorizeUrl.searchParams.set('state', state);
  return authorizeUrl;
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') return htmlResponse('Method not allowed.', 405);
  if (!isShopifyConfigured() || !isOauthConfigured()) {
    return htmlResponse('Shopify OAuth is not configured.', 503);
  }

  const url = new URL(request.url);
  const shop = String(url.searchParams.get('shop') || '').trim().toLowerCase();
  if (shop !== shopifyShopDomain()) return htmlResponse('Unexpected Shopify shop.', 401);
  if (url.searchParams.get('manual') === '1' && serviceRoleKey && bearerToken(request) === serviceRoleKey) {
    const state = await signedManualState(shop);
    const authorizeUrl = authorizeUrlFor(url, shop, state);
    return jsonResponse({ authorizeUrl: authorizeUrl.toString(), scopes: shopifyOauthScopes() });
  }
  if (!await verifyShopifyOauthHmac(url)) return htmlResponse('Invalid Shopify OAuth signature.', 401);

  const state = crypto.randomUUID();
  const authorizeUrl = authorizeUrlFor(url, shop, state);

  return redirectResponse(authorizeUrl.toString(), state);
});
