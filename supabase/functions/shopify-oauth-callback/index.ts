import {
  isShopifyConfigured,
  shopifyClientCredentials,
  shopifyOauthScopes,
  shopifyShopDomain,
  verifyShopifyOauthHmac
} from '../_shared/shopify.ts';

const OAUTH_STATE_COOKIE = 'shopify_oauth_state';

function htmlEscape(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

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

function cookieValue(request: Request, name: string) {
  const cookies = String(request.headers.get('cookie') || '').split(';');
  for (const cookie of cookies) {
    const [rawName, ...rawValue] = cookie.trim().split('=');
    if (rawName === name) return rawValue.join('=');
  }
  return '';
}

function clearStateCookieHeader() {
  return `${OAUTH_STATE_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

function requiredScopes() {
  return shopifyOauthScopes().split(',').map((scope) => scope.trim()).filter(Boolean);
}

function hasGrantedScope(grantedScopes: Set<string>, scope: string) {
  if (grantedScopes.has(scope)) return true;
  if (scope.startsWith('read_')) return grantedScopes.has(`write_${scope.slice(5)}`);
  return false;
}

function validateGrantedScopes(scopeText = '') {
  const grantedScopes = new Set(
    scopeText.split(',').map((scope) => scope.trim()).filter(Boolean)
  );
  const missing = requiredScopes().filter((scope) => !hasGrantedScope(grantedScopes, scope));
  if (missing.length) throw new Error(`Shopify OAuth missing required scopes: ${missing.join(', ')}`);
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

async function exchangeAuthorizationCode(shop: string, code: string) {
  const { clientId, clientSecret } = shopifyClientCredentials();
  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code
    })
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    const description = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Shopify OAuth token exchange failed: ${description}`);
  }
  validateGrantedScopes(payload.scope || '');
  return payload.scope || '';
}

Deno.serve(async (request) => {
  if (request.method !== 'GET') return htmlResponse('Method not allowed.', 405);
  if (!isShopifyConfigured() || !isOauthConfigured()) {
    return htmlResponse('Shopify OAuth is not configured.', 503);
  }

  const url = new URL(request.url);
  const shop = String(url.searchParams.get('shop') || '').trim().toLowerCase();
  const code = String(url.searchParams.get('code') || '').trim();
  const state = String(url.searchParams.get('state') || '').trim();
  const stateCookie = cookieValue(request, OAUTH_STATE_COOKIE);

  try {
    if (shop !== shopifyShopDomain()) throw new Error('Unexpected Shopify shop.');
    if (!code) throw new Error('Missing Shopify OAuth code.');
    if (!state || state !== stateCookie) throw new Error('Invalid Shopify OAuth state.');
    if (!await verifyShopifyOauthHmac(url)) throw new Error('Invalid Shopify OAuth signature.');

    const scopes = await exchangeAuthorizationCode(shop, code);
    console.info('[shopify-oauth-callback] Shopify app installed', { shop, scopes });

    return htmlResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shopify Installed</title></head><body><h1>Shopify app installed</h1><p>DJHC Website Inventory Sync is authorized for ${htmlEscape(shop)}. You can close this tab and return to Codex.</p></body></html>`,
      200,
      { 'Set-Cookie': clearStateCookieHeader() }
    );
  } catch (error) {
    console.error('[shopify-oauth-callback]', error);
    const message = error instanceof Error ? error.message : 'Shopify OAuth failed.';
    return htmlResponse(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Shopify OAuth Failed</title></head><body><h1>Shopify OAuth failed</h1><p>${htmlEscape(message)}</p></body></html>`,
      400,
      { 'Set-Cookie': clearStateCookieHeader() }
    );
  }
});
