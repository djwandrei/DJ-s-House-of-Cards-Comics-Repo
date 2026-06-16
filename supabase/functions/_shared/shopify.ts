const DEFAULT_API_VERSION = '2026-04';
const DEFAULT_OAUTH_SCOPES = [
  'read_products',
  'write_products',
  'read_inventory',
  'write_inventory',
  'read_locations',
  'read_publications',
  'write_publications',
  'read_themes',
  'write_themes'
].join(',');
const SHOPIFY_SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

type GraphqlError = {
  message?: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: GraphqlError[];
};

type TokenCache = {
  accessToken: string;
  expiresAt: number;
};

export type ShopifyInventoryAdjustment = {
  delta: number;
  inventoryItemId: string;
  locationId: string;
};

export type ShopifyInventoryQuantity = {
  compareQuantity: number | null;
  inventoryItemId: string;
  locationId: string;
  quantity: number;
};

let clientCredentialsToken: TokenCache | null = null;
const encoder = new TextEncoder();

function configuredShopDomain() {
  return String(Deno.env.get('SHOPIFY_SHOP_DOMAIN') || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

export function isShopifyShopDomain(domain: string) {
  return SHOPIFY_SHOP_DOMAIN_RE.test(String(domain || '').trim());
}

export function shopifyApiVersion() {
  return String(Deno.env.get('SHOPIFY_API_VERSION') || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;
}

export function shopifyOauthScopes() {
  return String(Deno.env.get('SHOPIFY_OAUTH_SCOPES') || DEFAULT_OAUTH_SCOPES)
    .split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
    .join(',');
}

export function isShopifyConfigured() {
  const staticToken = String(Deno.env.get('SHOPIFY_ADMIN_ACCESS_TOKEN') || '').trim();
  const clientId = String(Deno.env.get('SHOPIFY_CLIENT_ID') || '').trim();
  const clientSecret = String(Deno.env.get('SHOPIFY_CLIENT_SECRET') || '').trim();
  return Boolean(
    isShopifyShopDomain(configuredShopDomain())
    && (staticToken || (clientId && clientSecret))
  );
}

export function shopifyShopDomain() {
  const domain = configuredShopDomain();
  if (!isShopifyShopDomain(domain)) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be the store myshopify.com domain.');
  }
  return domain;
}

export function shopifyClientCredentials() {
  const clientId = String(Deno.env.get('SHOPIFY_CLIENT_ID') || '').trim();
  const clientSecret = String(Deno.env.get('SHOPIFY_CLIENT_SECRET') || '').trim();
  if (!clientId || !clientSecret) throw new Error('Shopify client credentials are not configured.');
  return { clientId, clientSecret };
}

export function shopifyGid(resource: string, legacyId: number | string) {
  const id = String(legacyId || '').trim();
  if (!/^\d+$/.test(id)) throw new Error(`Invalid Shopify ${resource} id.`);
  return `gid://shopify/${resource}/${id}`;
}

function graphqlErrorMessage(errors: GraphqlError[] = []) {
  return errors
    .map((error) => {
      const path = Array.isArray(error.path) && error.path.length ? ` (${error.path.join('.')})` : '';
      return `${error.message || 'Unknown Shopify GraphQL error'}${path}`;
    })
    .join('; ');
}

function hexBytes(bytes: Uint8Array) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeTextEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length || !leftBytes.length) return false;
  let mismatch = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    mismatch |= leftBytes[index] ^ rightBytes[index];
  }
  return mismatch === 0;
}

function oauthHmacMessage(searchParams: URLSearchParams) {
  return [...searchParams.entries()]
    .filter(([key]) => key !== 'hmac' && key !== 'signature')
    .map(([key, value]) => `${key}=${value}`)
    .sort()
    .join('&');
}

export async function verifyShopifyOauthHmac(url: URL) {
  const providedHmac = String(url.searchParams.get('hmac') || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(providedHmac)) return false;

  const { clientSecret } = shopifyClientCredentials();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = hexBytes(new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(oauthHmacMessage(url.searchParams)))
  ));
  return timingSafeTextEqual(digest, providedHmac);
}

export async function shopifyAccessToken() {
  const staticToken = String(Deno.env.get('SHOPIFY_ADMIN_ACCESS_TOKEN') || '').trim();
  if (staticToken) return staticToken;

  const { clientId, clientSecret } = shopifyClientCredentials();

  const now = Date.now();
  if (clientCredentialsToken && now < clientCredentialsToken.expiresAt - 60_000) {
    return clientCredentialsToken.accessToken;
  }

  const response = await fetch(`https://${shopifyShopDomain()}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret
    })
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    const description = payload.error_description || payload.error || `HTTP ${response.status}`;
    throw new Error(`Shopify token request failed: ${description}`);
  }

  clientCredentialsToken = {
    accessToken: payload.access_token,
    expiresAt: now + Math.max(60, Number(payload.expires_in) || 86_399) * 1000
  };
  return clientCredentialsToken.accessToken;
}

function shopifyRestErrorMessage(payload: unknown) {
  if (!payload || typeof payload !== 'object') return '';
  const data = payload as { errors?: unknown; error?: unknown; error_description?: unknown; raw?: unknown };
  if (typeof data.errors === 'string') return data.errors;
  if (data.errors) return JSON.stringify(data.errors);
  if (data.error_description) return String(data.error_description);
  if (data.error) return String(data.error);
  if (data.raw) return String(data.raw).slice(0, 500);
  return '';
}

export async function shopifyRest<T>(
  method: string,
  endpoint: string,
  body: Record<string, unknown> | null = null
): Promise<T> {
  if (!isShopifyConfigured()) throw new Error('Shopify Admin API is not configured.');

  const response = await fetch(`https://${shopifyShopDomain()}/admin/api/${shopifyApiVersion()}/${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await shopifyAccessToken()
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  let payload: unknown = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }

  if (!response.ok) {
    const detail = shopifyRestErrorMessage(payload);
    throw new Error(`Shopify REST ${method} ${endpoint} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}.`);
  }
  return payload as T;
}

export async function shopifyGraphql<T>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  if (!isShopifyConfigured()) throw new Error('Shopify Admin API is not configured.');

  const response = await fetch(
    `https://${shopifyShopDomain()}/admin/api/${shopifyApiVersion()}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': await shopifyAccessToken()
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const payload = await response.json().catch(() => ({})) as GraphqlResponse<T>;
  if (!response.ok) {
    throw new Error(`Shopify Admin API returned HTTP ${response.status}.`);
  }
  if (payload.errors?.length) {
    throw new Error(`Shopify GraphQL failed: ${graphqlErrorMessage(payload.errors)}`);
  }
  if (!payload.data) throw new Error('Shopify GraphQL returned no data.');
  return payload.data;
}

export async function adjustShopifyInventory(options: {
  changes: ShopifyInventoryAdjustment[];
  idempotencyKey: string;
  reason?: string;
  referenceDocumentUri: string;
}) {
  if (!options.changes.length) return null;
  const idempotencyKey = String(options.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('A Shopify inventory idempotency key is required.');

  const data = await shopifyGraphql<{
    inventoryAdjustQuantities: {
      inventoryAdjustmentGroup?: {
        createdAt?: string;
        reason?: string;
        referenceDocumentUri?: string;
      } | null;
      userErrors?: Array<{ code?: string; field?: string[]; message?: string }>;
    };
  }>(
    `mutation AdjustInventory(
      $input: InventoryAdjustQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventoryAdjustQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          createdAt
          reason
          referenceDocumentUri
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    {
      idempotencyKey,
      input: {
        reason: options.reason || 'correction',
        name: 'available',
        referenceDocumentUri: options.referenceDocumentUri,
        changes: options.changes
      }
    }
  );

  const result = data.inventoryAdjustQuantities;
  if (result.userErrors?.length) {
    throw new Error(
      `Shopify inventory adjustment failed: ${result.userErrors
        .map((error) => `${error.code || 'ERROR'}: ${error.message || 'Unknown error'}`)
        .join('; ')}`
    );
  }
  return result.inventoryAdjustmentGroup || null;
}

export async function setShopifyInventory(options: {
  idempotencyKey: string;
  quantities: ShopifyInventoryQuantity[];
  reason?: string;
  referenceDocumentUri: string;
}) {
  if (!options.quantities.length) return null;
  const idempotencyKey = String(options.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('A Shopify inventory idempotency key is required.');

  const data = await shopifyGraphql<{
    inventorySetQuantities: {
      inventoryAdjustmentGroup?: {
        createdAt?: string;
        reason?: string;
        referenceDocumentUri?: string;
      } | null;
      userErrors?: Array<{ code?: string; field?: string[]; message?: string }>;
    };
  }>(
    `mutation SetInventory(
      $input: InventorySetQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) {
        inventoryAdjustmentGroup {
          createdAt
          reason
          referenceDocumentUri
        }
        userErrors {
          code
          field
          message
        }
      }
    }`,
    {
      idempotencyKey,
      input: {
        reason: options.reason || 'correction',
        name: 'available',
        referenceDocumentUri: options.referenceDocumentUri,
        ignoreCompareQuantity: false,
        quantities: options.quantities
      }
    }
  );

  const result = data.inventorySetQuantities;
  if (result.userErrors?.length) {
    throw new Error(
      `Shopify inventory set failed: ${result.userErrors
        .map((error) => `${error.code || 'ERROR'}: ${error.message || 'Unknown error'}`)
        .join('; ')}`
    );
  }
  return result.inventoryAdjustmentGroup || null;
}
