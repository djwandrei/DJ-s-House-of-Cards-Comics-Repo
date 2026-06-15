const DEFAULT_API_VERSION = '2026-04';

type GraphqlError = {
  message?: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
};

type GraphqlResponse<T> = {
  data?: T;
  errors?: GraphqlError[];
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

function configuredShopDomain() {
  return String(Deno.env.get('SHOPIFY_SHOP_DOMAIN') || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

export function shopifyApiVersion() {
  return String(Deno.env.get('SHOPIFY_API_VERSION') || DEFAULT_API_VERSION).trim() || DEFAULT_API_VERSION;
}

export function isShopifyConfigured() {
  return Boolean(
    /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(configuredShopDomain())
    && String(Deno.env.get('SHOPIFY_ADMIN_ACCESS_TOKEN') || '').trim()
  );
}

export function shopifyShopDomain() {
  const domain = configuredShopDomain();
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i.test(domain)) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be the store myshopify.com domain.');
  }
  return domain;
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
        'X-Shopify-Access-Token': String(Deno.env.get('SHOPIFY_ADMIN_ACCESS_TOKEN') || '').trim()
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
