import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import {
  isShopifyConfigured,
  setShopifyInventory,
  shopifyGid,
  shopifyGraphql,
  shopifyShopDomain
} from '../_shared/shopify.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const adminEmail = String(Deno.env.get('ADMIN_EMAIL') || 'djwandrei@gmail.com').trim().toLowerCase();
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const PAGE_SIZE = 250;
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

type InventoryItemNode = {
  legacyResourceId: string;
  sku?: string | null;
  tracked: boolean;
  variants?: {
    nodes?: Array<{
      legacyResourceId: string;
      product: {
        legacyResourceId: string;
        handle: string;
        status: string;
      };
    }>;
  };
  inventoryLevels?: {
    nodes?: Array<{
      location: { legacyResourceId: string; name: string };
      quantities?: Array<{ name: string; quantity: number }>;
    }>;
  };
};

type InventoryLevelNode = {
  location: { legacyResourceId: string; name: string };
  quantities?: Array<{ name: string; quantity: number }>;
};

type InventoryItemsPage = {
  inventoryItems: {
    nodes: InventoryItemNode[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
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

async function requireAdmin(request: Request) {
  const jwt = String(request.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  if (!jwt) throw new Error('Admin sign-in is required.');
  // Local maintenance scripts can use the service-role JWT; browser callers
  // still have to prove they are the configured admin user below.
  if (serviceRoleKey && jwt === serviceRoleKey) return;
  const { data, error } = await admin.auth.getUser(jwt);
  if (error || !data.user || String(data.user.email || '').toLowerCase() !== adminEmail) {
    throw new Error('Admin authorization failed.');
  }
}

function numericId(value: unknown, label: string) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid Shopify ${label}.`);
  return Number(text);
}

function availableQuantity(level: InventoryLevelNode) {
  return Number(level?.quantities?.find((quantity) => quantity.name === 'available')?.quantity ?? 0);
}

function productIdFromSku(sku = '') {
  const match = String(sku || '').trim().match(/^DJHC-(\d+)$/);
  return match ? Number(match[1]) : null;
}

function sourceClass(product: Record<string, unknown>) {
  const metadata = product.metadata as { excelFields?: unknown } | null;
  return metadata?.excelFields && typeof metadata.excelFields === 'object'
    ? 'nonlegacy'
    : 'legacy';
}

function shopifyProductType(category = '') {
  const value = String(category || '').trim();
  return ['Baseball', 'Basketball', 'Football'].includes(value)
    ? `${value} Cards`
    : value || 'Collectibles';
}

function cleanTag(value: unknown) {
  return String(value || '').replaceAll(',', ' ').replace(/\s+/g, ' ').trim();
}

function productTags(product: Record<string, unknown>, classification: string) {
  const tags = [
    'DJHC',
    `DJHC-${product.id}`,
    'Website Sync',
    classification === 'nonlegacy' ? 'Non-Legacy' : 'Legacy',
    product.category,
    product.sport,
    product.league,
    product.team,
    product.player_athlete,
    product.year
  ];
  return [...new Set(tags.map(cleanTag).filter(Boolean))];
}

function htmlEscape(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function directCheckoutPrice(product: Record<string, unknown>) {
  const checkoutPrice = Number(product.checkout_price);
  const price = Number(product.price);
  if (Number.isFinite(checkoutPrice) && checkoutPrice > 0) return checkoutPrice;
  return Number.isFinite(price) && price > 0 ? price : null;
}

function shouldActivate(product: Record<string, unknown>, mapping: Record<string, unknown>) {
  return mapping.source_class === 'nonlegacy'
    && mapping.publish_enabled === true
    && product.is_deleted !== true
    && product.checkout_enabled !== false
    && product.sale_status === 'available'
    && Number(product.quantity_available) > 0
    && directCheckoutPrice(product) !== null;
}

async function loadInventoryItems() {
  const nodes: InventoryItemNode[] = [];
  let after: string | null = null;

  do {
    const data: InventoryItemsPage = await shopifyGraphql<InventoryItemsPage>(
      `query InventoryItems($first: Int!, $after: String) {
        inventoryItems(first: $first, after: $after) {
          nodes {
            legacyResourceId
            sku
            tracked
            variants(first: 1) {
              nodes {
                legacyResourceId
                product {
                  legacyResourceId
                  handle
                  status
                }
              }
            }
            inventoryLevels(first: 10) {
              nodes {
                location {
                  legacyResourceId
                  name
                }
                quantities(names: ["available"]) {
                  name
                  quantity
                }
              }
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { first: PAGE_SIZE, after }
    );
    nodes.push(...data.inventoryItems.nodes);
    after = data.inventoryItems.pageInfo.hasNextPage
      ? data.inventoryItems.pageInfo.endCursor || null
      : null;
  } while (after);

  return nodes.filter((node) => productIdFromSku(node.sku || '') !== null);
}

async function bootstrapMappings() {
  const items = await loadInventoryItems();
  const productIds = items
    .map((item) => productIdFromSku(item.sku || ''))
    .filter((id): id is number => Number.isSafeInteger(id));
  const productsById = new Map<number, Record<string, unknown>>();
  const existingById = new Map<number, Record<string, unknown>>();

  for (let index = 0; index < productIds.length; index += PAGE_SIZE) {
    const ids = productIds.slice(index, index + PAGE_SIZE);
    const [{ data: products, error: productError }, { data: mappings, error: mappingError }] = await Promise.all([
      admin.from('products').select('id,metadata').in('id', ids),
      admin.from('shopify_product_mappings').select('product_id,publish_enabled').in('product_id', ids)
    ]);
    if (productError) throw productError;
    if (mappingError) throw mappingError;
    for (const product of products || []) productsById.set(Number(product.id), product);
    for (const mapping of mappings || []) existingById.set(Number(mapping.product_id), mapping);
  }

  const rows = [];
  const skipped: Array<{ sku: string; reason: string }> = [];
  for (const item of items) {
    const productId = productIdFromSku(item.sku || '');
    const variant = item.variants?.nodes?.[0];
    const level = item.inventoryLevels?.nodes?.[0];
    const product = productId ? productsById.get(productId) : null;
    if (!productId || !variant || !level || !product) {
      skipped.push({ sku: item.sku || '', reason: 'Missing website product, variant, or inventory location.' });
      continue;
    }

    const existing = existingById.get(productId);
    rows.push({
      product_id: productId,
      sku: item.sku,
      source_class: sourceClass(product),
      publish_enabled: existing?.publish_enabled === true,
      shop_domain: shopifyShopDomain(),
      shopify_product_id: numericId(variant.product.legacyResourceId, 'product id'),
      shopify_variant_id: numericId(variant.legacyResourceId, 'variant id'),
      shopify_inventory_item_id: numericId(item.legacyResourceId, 'inventory item id'),
      shopify_location_id: numericId(level.location.legacyResourceId, 'location id'),
      shopify_handle: variant.product.handle || `djhc-${productId}`,
      last_shopify_quantity: availableQuantity(level),
      last_synced_at: new Date().toISOString()
    });
  }

  for (let index = 0; index < rows.length; index += PAGE_SIZE) {
    const { error } = await admin
      .from('shopify_product_mappings')
      .upsert(rows.slice(index, index + PAGE_SIZE), { onConflict: 'product_id' });
    if (error) throw error;
  }

  return { mapped: rows.length, skipped: skipped.length, skippedItems: skipped.slice(0, 50) };
}

async function syncProduct(productId: number) {
  const [{ data: product, error: productError }, { data: mapping, error: mappingError }] = await Promise.all([
    admin.from('products').select('*').eq('id', productId).single(),
    admin.from('shopify_product_mappings').select('*').eq('product_id', productId).single()
  ]);
  if (productError) throw productError;
  if (mappingError) throw mappingError;

  const classification = sourceClass(product);
  if (mapping.source_class !== classification) {
    const { error } = await admin
      .from('shopify_product_mappings')
      .update({ source_class: classification, publish_enabled: false })
      .eq('product_id', productId);
    if (error) throw error;
    mapping.source_class = classification;
    mapping.publish_enabled = false;
  }

  const price = directCheckoutPrice(product);
  const status = shouldActivate(product, mapping) ? 'ACTIVE' : 'DRAFT';
  const description = String(product.description || '').trim();
  const productIdGid = shopifyGid('Product', mapping.shopify_product_id);
  const variantIdGid = shopifyGid('ProductVariant', mapping.shopify_variant_id);

  const productResult = await shopifyGraphql<{
    productSet: {
      product?: { id: string; status: string } | null;
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  }>(
    `mutation SyncProduct($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
      productSet(identifier: $identifier, input: $input, synchronous: true) {
        product {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      identifier: { id: productIdGid },
      input: {
        title: String(product.name || `Listing #${productId}`),
        descriptionHtml: description
          ? `<p>${htmlEscape(description)}</p>`
          : `<p>Please review all photos for the exact item you will receive.</p>`,
        handle: mapping.shopify_handle || `djhc-${productId}`,
        productType: shopifyProductType(product.category),
        vendor: "DJ's House of Cards & Comics",
        tags: productTags(product, classification),
        status
      }
    }
  );
  if (productResult.productSet.userErrors?.length) {
    throw new Error(
      `Shopify product sync failed: ${productResult.productSet.userErrors
        .map((error) => error.message || 'Unknown product error')
        .join('; ')}`
    );
  }

  if (price !== null) {
    const variantResult = await shopifyGraphql<{
      productVariantsBulkUpdate: {
        userErrors?: Array<{ field?: string[]; message?: string }>;
      };
    }>(
      `mutation SyncVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          userErrors {
            field
            message
          }
        }
      }`,
      {
        productId: productIdGid,
        variants: [{
          id: variantIdGid,
          price: price.toFixed(2),
          inventoryPolicy: 'DENY',
          taxable: true
        }]
      }
    );
    if (variantResult.productVariantsBulkUpdate.userErrors?.length) {
      throw new Error(
        `Shopify variant sync failed: ${variantResult.productVariantsBulkUpdate.userErrors
          .map((error) => error.message || 'Unknown variant error')
          .join('; ')}`
      );
    }
  }

  const quantity = Math.max(0, Math.floor(Number(product.quantity_available) || 0));
  await setShopifyInventory({
    idempotencyKey: crypto.randomUUID(),
    reason: 'correction',
    referenceDocumentUri: `gid://djshouseofcards/Product/${productId}`,
    quantities: [{
      compareQuantity: Number.isSafeInteger(Number(mapping.last_shopify_quantity))
        ? Number(mapping.last_shopify_quantity)
        : null,
      inventoryItemId: shopifyGid('InventoryItem', mapping.shopify_inventory_item_id),
      locationId: shopifyGid('Location', mapping.shopify_location_id),
      quantity
    }]
  });

  await admin.from('shopify_product_mappings').update({
    last_shopify_quantity: quantity,
    last_synced_at: new Date().toISOString()
  }).eq('product_id', productId);

  return {
    productId,
    status,
    sourceClass: classification,
    publishEnabled: mapping.publish_enabled === true
  };
}

async function registerInventoryWebhook() {
  const webhookUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/shopify-webhook`;
  const existing = await shopifyGraphql<{
    webhookSubscriptions: {
      nodes: Array<{ id: string; topic: string; uri: string }>;
    };
  }>(
    `query InventoryWebhooks {
      webhookSubscriptions(first: 50, topics: [INVENTORY_LEVELS_UPDATE]) {
        nodes {
          id
          topic
          uri
        }
      }
    }`
  );
  const match = existing.webhookSubscriptions.nodes.find((subscription) => subscription.uri === webhookUrl);
  if (match) return { created: false, subscription: match };

  const created = await shopifyGraphql<{
    webhookSubscriptionCreate: {
      webhookSubscription?: { id: string; topic: string; uri: string } | null;
      userErrors?: Array<{ field?: string[]; message?: string }>;
    };
  }>(
    `mutation RegisterInventoryWebhook(
      $topic: WebhookSubscriptionTopic!,
      $subscription: WebhookSubscriptionInput!
    ) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
        webhookSubscription {
          id
          topic
          uri
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      topic: 'INVENTORY_LEVELS_UPDATE',
      subscription: {
        uri: webhookUrl,
        format: 'JSON',
        includeFields: ['inventory_item_id', 'location_id', 'available', 'updated_at']
      }
    }
  );
  if (created.webhookSubscriptionCreate.userErrors?.length) {
    throw new Error(
      `Shopify webhook registration failed: ${created.webhookSubscriptionCreate.userErrors
        .map((error) => error.message || 'Unknown webhook error')
        .join('; ')}`
    );
  }
  return { created: true, subscription: created.webhookSubscriptionCreate.webhookSubscription };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405);
  if (!supabaseUrl || !serviceRoleKey || !isShopifyConfigured()) {
    return jsonResponse({ error: 'Shopify catalog sync is not configured.' }, 503);
  }

  try {
    await requireAdmin(request);
  } catch (error) {
    return jsonResponse({ error: errorMessage(error) }, 401);
  }

  let payload: { action?: string; productId?: number } = {};
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON request.' }, 400);
  }

  try {
    switch (payload.action) {
      case 'bootstrap-mappings':
        return jsonResponse({ ok: true, result: await bootstrapMappings() });
      case 'sync-product': {
        const productId = Number(payload.productId);
        if (!Number.isSafeInteger(productId) || productId <= 0) {
          return jsonResponse({ error: 'A valid productId is required.' }, 400);
        }
        return jsonResponse({ ok: true, result: await syncProduct(productId) });
      }
      case 'register-webhooks':
        return jsonResponse({ ok: true, result: await registerInventoryWebhook() });
      default:
        return jsonResponse({ error: 'Unknown Shopify sync action.' }, 400);
    }
  } catch (error) {
    console.error('[shopify-catalog-sync]', error);
    return jsonResponse({ error: errorMessage(error) || 'Shopify catalog sync failed.' }, 500);
  }
});
