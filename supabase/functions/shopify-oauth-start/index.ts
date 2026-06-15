import {
  isShopifyConfigured,
  shopifyClientCredentials,
  shopifyOauthScopes,
  shopifyShopDomain,
  verifyShopifyOauthHmac
} from '../_shared/shopify.ts';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';

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

Deno.serve(async (request) => {
  if (request.method !== 'GET') return htmlResponse('Method not allowed.', 405);
  if (!isShopifyConfigured() || !isOauthConfigured()) {
    return htmlResponse('Shopify OAuth is not configured.', 503);
  }

  const url = new URL(request.url);
  const shop = String(url.searchParams.get('shop') || '').trim().toLowerCase();
  if (shop !== shopifyShopDomain()) return htmlResponse('Unexpected Shopify shop.', 401);
  if (!await verifyShopifyOauthHmac(url)) return htmlResponse('Invalid Shopify OAuth signature.', 401);

  const state = crypto.randomUUID();
  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set('client_id', shopifyClientCredentials().clientId);
  authorizeUrl.searchParams.set('scope', shopifyOauthScopes());
  authorizeUrl.searchParams.set('redirect_uri', callbackUrlFor(url));
  authorizeUrl.searchParams.set('state', state);

  return redirectResponse(authorizeUrl.toString(), state);
});
