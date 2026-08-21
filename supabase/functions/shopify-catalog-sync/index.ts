import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { requireSiteAdmin, SiteAdminError, type SiteAdminIdentity } from '../_shared/admin-auth.ts';
import { readJsonBody } from '../_shared/http.ts';
import { timingSafeEqualText } from '../_shared/constant-time.ts';
import {
  isShopifyConfigured,
  setShopifyInventory,
  shopifyGid,
  shopifyGraphql,
  shopifyRest,
  shopifyShopDomain
} from '../_shared/shopify.ts';

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
const PAGE_SIZE = 250;
const FEATURED_COLLECTION_HANDLE = 'djhc-featured-showcase';
const FEATURED_COLLECTION_TITLE = 'Featured Picks';
const SHOPIFY_SHOWCASE_PRODUCT_IDS = [1607, 1441, 1449, 1480, 1473, 1649, 1650, 1550];
const SHOPIFY_PUBLICATION_CHANNELS = [
  'Online Store',
  'Shop',
  'Point of Sale',
  'Google & YouTube',
  'Facebook & Instagram',
  'Whatnot',
  'TikTok'
];
const PRODUCT_PUBLICATION_LIMIT = 10;
const PRODUCT_MEDIA_SNAPSHOT_LIMIT = 100;
const INVENTORY_LEVEL_SNAPSHOT_LIMIT = 10;
const DEFAULT_CORS_ORIGINS = [
  'https://www.djshouseofcards-comics.com',
  'https://djshouseofcards-comics.com'
];

type InventoryItemNode = {
  legacyResourceId: string;
  sku?: string | null;
  tracked: boolean;
  variants?: {
    nodes?: Array<{
      legacyResourceId: string;
      price?: string | null;
      product: {
        legacyResourceId: string;
        handle: string;
        status: string;
        featuredMedia?: { id?: string | null } | null;
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

type PublicationNode = {
  id: string;
  name?: string | null;
  autoPublish?: boolean | null;
  supportsFuturePublishing?: boolean | null;
  catalog?: {
    id?: string | null;
    title?: string | null;
    status?: string | null;
  } | null;
};

type PublicationsPage = {
  publications: {
    nodes: PublicationNode[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
};

type ResourcePublicationNode = {
  isPublished: boolean;
  publishDate?: string | null;
  publication: PublicationNode;
};

type ShopifyPublicationState = {
  __typename?: string;
  id: string;
  status?: string;
  resourcePublicationsV2?: {
    nodes: ResourcePublicationNode[];
    pageInfo: { hasNextPage: boolean; endCursor?: string | null };
  };
};

type ShopifyPublicationStatesResponse = {
  nodes: Array<ShopifyPublicationState | null>;
};

type ShopifySnapshotNode = {
  __typename: string;
  id: string;
  [key: string]: unknown;
};

type ShopifySnapshotResponse = {
  nodes: Array<ShopifySnapshotNode | null>;
};

type CustomCollectionPayload = {
  custom_collection?: {
    id?: number | string;
    handle?: string;
    title?: string;
  };
  custom_collections?: Array<{
    id?: number | string;
    handle?: string;
    title?: string;
  }>;
};

type CollectsPayload = {
  collect?: {
    id?: number | string;
    collection_id?: number | string;
    product_id?: number | string;
    position?: number;
  };
  collects?: Array<{
    id?: number | string;
    collection_id?: number | string;
    product_id?: number | string;
    position?: number;
  }>;
};

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

function corsHeadersFor(request?: Request) {
  const requestOrigin = normalizedOrigin(request?.headers.get('origin') || '');
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

function jsonResponse(body: Record<string, unknown>, status = 200, request?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(request), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String((error as { message?: string })?.message || error || '');
}

async function requireAdmin(request: Request): Promise<SiteAdminIdentity> {
  const jwt = String(request.headers.get('authorization') || '')
    .replace(/^Bearer\s+/i, '')
    .trim();
  // Local maintenance scripts can use the service-role JWT; browser callers
  // still have to prove membership in the centralized site-admin registry.
  if (serviceRoleKey && timingSafeEqualText(jwt, serviceRoleKey)) {
    return { id: 'service-role', email: 'service-role@internal.invalid' };
  }
  return await requireSiteAdmin(request, admin);
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

function firstItems<T>(items: T[], limit = 25) {
  return items.slice(0, limit);
}

function normalizedName(value: unknown) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function publicationLabel(publication: PublicationNode) {
  return String(publication.name || publication.catalog?.title || publication.id).trim();
}

function matchesRequestedChannel(publication: PublicationNode, requestedChannel: string) {
  const requested = normalizedName(requestedChannel);
  const label = normalizedName(publicationLabel(publication));
  const catalogTitle = normalizedName(publication.catalog?.title);
  return Boolean(
    requested
    && (label === requested || label.includes(requested) || catalogTitle === requested || catalogTitle.includes(requested))
  );
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

function uniqueTags(values: unknown[]) {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = cleanTag(value);
    if (!tag) continue;
    const key = tag.normalize('NFKC').toLocaleLowerCase('en-US');
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function workbookProductTags(product: Record<string, unknown>) {
  const metadata = product.metadata as { excelFields?: Record<string, unknown> } | null;
  const excelFields = metadata?.excelFields;
  if (!excelFields || typeof excelFields !== 'object') return [];

  const features = String(excelFields['C:Features'] || '')
    .split('|')
    .map(cleanTag)
    .filter(Boolean);
  const isAutographed = normalizedName(excelFields['C:Autographed']) === 'yes';
  const hasAutographFeature = features.some((feature) => normalizedName(feature) === 'autograph');
  if (isAutographed !== hasAutographFeature) {
    throw new Error(`Workbook autograph fields disagree for DJHC-${product.id}.`);
  }
  return uniqueTags(features);
}

function productTags(product: Record<string, unknown>, classification: string) {
  const tags = [
    'DJHC',
    `DJHC-${product.id}`,
    'Cards Comics Collectibles',
    classification === 'nonlegacy' ? 'Website Catalog' : '',
    product.is_featured === true || SHOPIFY_SHOWCASE_PRODUCT_IDS.includes(Number(product.id)) ? 'Featured Pick' : '',
    product.category,
    product.sport,
    product.league,
    product.team,
    product.player_athlete,
    product.year,
    ...workbookProductTags(product)
  ];
  return uniqueTags(tags);
}

function productDescriptionHtml(product: Record<string, unknown>) {
  const supplied = String(product.description || '').trim();
  const details = [
    ['Category', product.category],
    ['Sport', product.sport],
    ['League', product.league],
    ['Player/Athlete', product.player_athlete],
    ['Team', product.team],
    ['Year', product.year],
    ['Condition', product.condition]
  ].filter(([, value]) => String(value || '').trim());
  const list = details
    .map(([label, value]) => `<li><strong>${htmlEscape(String(label))}:</strong> ${htmlEscape(String(value || '').trim())}</li>`)
    .join('');
  const inventoryId = `DJHC-${product.id}`;
  const hasInlineDetails = /\bDetails:/i.test(supplied);

  return [
    supplied
      ? `<p>${htmlEscape(supplied)}</p>`
      : `<p>${htmlEscape(String(product.name || `Listing #${product.id}`))}</p>`,
    !hasInlineDetails && list ? `<ul>${list}</ul>` : '',
    `<p>Please review all photos for the exact item you will receive. DJHC inventory ID: ${htmlEscape(inventoryId)}.</p>`
  ].filter(Boolean).join('');
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
    && isActivationEligible(product);
}

function isActivationEligible(product?: Record<string, unknown>) {
  return Boolean(
    product
    && product.is_deleted === false
    && product.checkout_enabled === true
    && product.sale_status === 'available'
    && Number(product.quantity_available) > 0
    && directCheckoutPrice(product) !== null
  );
}

async function loadEligibleNonlegacyMappings(options: {
  limit?: number;
  afterProductId?: number;
}, config: {
  defaultLimit?: number;
  maxLimit?: number;
  publishEnabledOnly?: boolean;
} = {}) {
  const limit = Math.min(
    config.maxLimit || 100,
    Math.max(1, Math.floor(Number(options.limit) || config.defaultLimit || 50))
  );
  const afterProductId = Math.max(0, Math.floor(Number(options.afterProductId) || 0));
  let query = admin
    .from('shopify_product_mappings')
    .select('product_id,shopify_product_id,shopify_handle,publish_enabled')
    .eq('source_class', 'nonlegacy')
    .gt('product_id', afterProductId)
    .order('product_id', { ascending: true })
    .limit(limit);
  if (config.publishEnabledOnly) query = query.eq('publish_enabled', true);

  const { data, error } = await query;
  if (error) throw error;

  const mappings = (data || []) as Record<string, unknown>[];
  const nextAfterProductId = mappings.length ? Number(mappings[mappings.length - 1].product_id) : afterProductId;
  if (!mappings.length) {
    return { afterProductId, nextAfterProductId, mappings, eligibleMappings: [], skipped: [] };
  }

  const { data: products, error: productError } = await admin
    .from('products')
    .select('id,is_deleted,sale_status,checkout_enabled,quantity_available,checkout_price,price,display_price,price_label')
    .in('id', mappings.map((mapping) => Number(mapping.product_id)));
  if (productError) throw productError;

  const productsById = new Map(
    ((products || []) as Record<string, unknown>[]).map((product) => [Number(product.id), product])
  );
  const eligibleMappings = mappings.filter((mapping) => isActivationEligible(productsById.get(Number(mapping.product_id))));
  const skipped = mappings
    .filter((mapping) => !isActivationEligible(productsById.get(Number(mapping.product_id))))
    .map((mapping) => ({ productId: Number(mapping.product_id), reason: 'not_checkout_eligible' }));

  return { afterProductId, nextAfterProductId, mappings, eligibleMappings, skipped };
}

async function loadPagedRows(table: string, columns: string, orderColumn = 'id') {
  const rows: Record<string, unknown>[] = [];
  let from = 0;

  for (;;) {
    const { data, error } = await admin
      .from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const chunk = (data || []) as unknown as Record<string, unknown>[];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
}

async function loadWebhookHealth() {
  const statuses = ['pending', 'processing', 'processed', 'failed'];
  const [totalResult, failureResult, ...statusResults] = await Promise.all([
    admin.from('marketplace_webhook_events').select('event_id', { count: 'exact', head: true }),
    admin
      .from('marketplace_webhook_events')
      .select('event_id,event_type,product_id,error_message,created_at')
      .eq('processing_status', 'failed')
      .order('created_at', { ascending: false })
      .limit(10),
    ...statuses.map((status) => admin
      .from('marketplace_webhook_events')
      .select('event_id', { count: 'exact', head: true })
      .eq('processing_status', status))
  ]);
  if (totalResult.error) throw totalResult.error;
  if (failureResult.error) throw failureResult.error;

  const statusCounts: Record<string, number> = {};
  statusResults.forEach((result, index) => {
    if (result.error) throw result.error;
    statusCounts[statuses[index]] = Number(result.count) || 0;
  });
  return {
    total: Number(totalResult.count) || 0,
    statusCounts,
    recentFailures: (failureResult.data || []).map((event) => ({
      eventId: event.event_id,
      eventType: event.event_type,
      productId: event.product_id,
      error: event.error_message
    }))
  };
}

function mappedInventoryLevel(item: InventoryItemNode, mapping?: Record<string, unknown>) {
  const levels = item.inventoryLevels?.nodes || [];
  if (!mapping) return levels[0] || null;
  return levels.find((level) => (
    String(level.location.legacyResourceId) === String(mapping.shopify_location_id)
  )) || levels[0] || null;
}

function centsEqual(left: number | null, right: unknown) {
  if (left === null) return false;
  const numericRight = Number(right);
  return Number.isFinite(numericRight)
    && Math.round(left * 100) === Math.round(numericRight * 100);
}

function encodePathSegments(path = '') {
  return String(path || '').split('/').map((segment) => {
    try {
      return encodeURIComponent(decodeURIComponent(segment));
    } catch {
      return encodeURIComponent(segment);
    }
  }).join('/').replace(/%28/g, '(').replace(/%29/g, ')');
}

function absoluteImageUrl(image = '') {
  const value = String(image || '').trim();
  if (!value) return '';
  try {
    const external = /^https?:\/\//i.test(value) ? new URL(value) : null;
    if (external) {
      external.pathname = encodePathSegments(external.pathname);
      return external.protocol === 'https:' ? external.href : '';
    }
    const localUrl = new URL(`/${encodePathSegments(value.replace(/^\/+/, ''))}`, `${siteUrl}/`);
    return localUrl.protocol === 'https:' ? localUrl.href : '';
  } catch {
    return '';
  }
}

function productImageUrls(product: Record<string, unknown>) {
  const gallery = Array.isArray(product.image_gallery) ? product.image_gallery : [];
  const candidates = [product.image, ...gallery]
    .map((item) => absoluteImageUrl(String(item || '')))
    .filter(Boolean);
  return [...new Set(candidates)].slice(0, 10);
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
                price
                product {
                  legacyResourceId
                  handle
                  status
                  featuredMedia {
                    id
                  }
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

async function verifyCatalogState() {
  const [products, mappings, webhookHealth, shopifyItems] = await Promise.all([
    loadPagedRows(
      'products',
      'id,name,metadata,is_deleted,sale_status,checkout_enabled,quantity_available,price,checkout_price,display_price,price_label,image,image_gallery',
      'id'
    ),
    loadPagedRows(
      'shopify_product_mappings',
      'product_id,sku,source_class,publish_enabled,shopify_product_id,shopify_inventory_item_id,shopify_location_id,last_shopify_quantity,last_synced_at',
      'product_id'
    ),
    loadWebhookHealth().catch((error) => ({
      total: 0,
      statusCounts: {},
      recentFailures: [{ error: `Webhook health unavailable: ${errorMessage(error)}` }]
    })),
    isShopifyConfigured() ? loadInventoryItems() : Promise.resolve([])
  ]);

  const productsById = new Map(products.map((product) => [Number(product.id), product]));
  const mappingsById = new Map(mappings.map((mapping) => [Number(mapping.product_id), mapping]));
  const shopifyItemsByProductId = new Map<number, InventoryItemNode>();
  for (const item of shopifyItems) {
    const productId = productIdFromSku(item.sku || '');
    if (productId) shopifyItemsByProductId.set(productId, item);
  }

  const productSourceCounts = { nonlegacy: 0, legacy: 0 };
  const mappingSourceCounts = { nonlegacy: 0, legacy: 0 };
  const missingMappings: number[] = [];
  const extraMappings: number[] = [];
  const sourceClassMismatches: number[] = [];
  const legacyPublishEnabled: number[] = [];
  const nonlegacyPublishDisabled: number[] = [];
  const ineligiblePublishEnabled: number[] = [];
  const nonlegacyNotActive: Array<{ productId: number; status: string }> = [];
  const malformedSkus: Array<{ productId: number; sku: string }> = [];
  const quantityMismatches: Array<{ productId: number; website: number; shopify: number | null }> = [];
  const priceMismatches: Array<{ productId: number; website: number | null; shopify: string | null }> = [];
  const missingShopifyItems: number[] = [];
  const missingShopifyImages: number[] = [];
  const legacyNotDraft: Array<{ productId: number; status: string }> = [];
  const ineligibleNotDraft: Array<{ productId: number; status: string }> = [];

  for (const product of products) {
    const productId = Number(product.id);
    const classification = sourceClass(product);
    productSourceCounts[classification] += 1;
    const mapping = mappingsById.get(productId);
    if (!mapping) {
      missingMappings.push(productId);
      continue;
    }
    if (mapping.source_class !== classification) sourceClassMismatches.push(productId);
  }

  for (const mapping of mappings) {
    const productId = Number(mapping.product_id);
    const product = productsById.get(productId);
    const classification = String(mapping.source_class) === 'nonlegacy' ? 'nonlegacy' : 'legacy';
    const websiteClassification = product ? sourceClass(product) : classification;
    const eligible = websiteClassification === 'nonlegacy' && isActivationEligible(product);
    mappingSourceCounts[classification] += 1;

    if (!product) extraMappings.push(productId);
    if (classification === 'legacy' && mapping.publish_enabled === true) legacyPublishEnabled.push(productId);
    if (eligible && mapping.publish_enabled !== true) nonlegacyPublishDisabled.push(productId);
    if (!eligible && mapping.publish_enabled === true) ineligiblePublishEnabled.push(productId);
    if (String(mapping.sku || '') !== `DJHC-${productId}`) {
      malformedSkus.push({ productId, sku: String(mapping.sku || '') });
    }

    const shopifyItem = shopifyItemsByProductId.get(productId);
    if (!shopifyItem) {
      missingShopifyItems.push(productId);
      continue;
    }

    const variant = shopifyItem.variants?.nodes?.[0] || null;
    const level = mappedInventoryLevel(shopifyItem, mapping);
    const shopifyQuantity = level ? availableQuantity(level) : null;
    const websiteQuantity = Math.max(0, Math.floor(Number(product?.quantity_available) || 0));
    if (shopifyQuantity !== websiteQuantity) {
      quantityMismatches.push({ productId, website: websiteQuantity, shopify: shopifyQuantity });
    }

    const websitePrice = product ? directCheckoutPrice(product) : null;
    if (product && websitePrice !== null && !centsEqual(websitePrice, variant?.price)) {
      priceMismatches.push({ productId, website: websitePrice, shopify: variant?.price || null });
    }

    if (!variant?.product?.featuredMedia?.id) missingShopifyImages.push(productId);
    if (classification === 'legacy' && variant?.product?.status !== 'DRAFT') {
      legacyNotDraft.push({ productId, status: String(variant?.product?.status || 'UNKNOWN') });
    }
    if (eligible && variant?.product?.status !== 'ACTIVE') {
      nonlegacyNotActive.push({ productId, status: String(variant?.product?.status || 'UNKNOWN') });
    }
    if (!eligible && variant?.product?.status !== 'DRAFT') {
      ineligibleNotDraft.push({ productId, status: String(variant?.product?.status || 'UNKNOWN') });
    }
  }

  const blockers = {
    missingMappings,
    extraMappings,
    sourceClassMismatches,
    legacyPublishEnabled,
    nonlegacyPublishDisabled,
    ineligiblePublishEnabled,
    nonlegacyNotActive,
    malformedSkus,
    missingShopifyItems,
    quantityMismatches,
    priceMismatches,
    missingShopifyImages,
    legacyNotDraft,
    ineligibleNotDraft
  };
  const blockerCounts = Object.fromEntries(
    Object.entries(blockers).map(([key, value]) => [key, value.length])
  );

  return {
    generatedAt: new Date().toISOString(),
    products: {
      total: products.length,
      sourceCounts: productSourceCounts,
      withoutImages: products.filter((product) => {
        const gallery = Array.isArray(product.image_gallery) ? product.image_gallery : [];
        return !String(product.image || '').trim() && !gallery.length;
      }).length,
      withoutCheckoutPrice: products.filter((product) => directCheckoutPrice(product) === null).length
    },
    mappings: {
      total: mappings.length,
      sourceCounts: mappingSourceCounts,
      publishEnabled: mappings.filter((mapping) => mapping.publish_enabled === true).length,
      legacyPublishEnabled: legacyPublishEnabled.length,
      nonlegacyPublishDisabled: nonlegacyPublishDisabled.length,
      ineligiblePublishEnabled: ineligiblePublishEnabled.length
    },
    shopify: {
      checked: Boolean(shopifyItems.length),
      skuCount: shopifyItems.length,
      nonlegacyNotActive: nonlegacyNotActive.length,
      legacyNotDraft: legacyNotDraft.length,
      ineligibleNotDraft: ineligibleNotDraft.length,
      missingPrimaryImages: missingShopifyImages.length,
      quantityMismatches: quantityMismatches.length,
      priceMismatches: priceMismatches.length
    },
    webhooks: {
      total: webhookHealth.total,
      statusCounts: webhookHealth.statusCounts,
      recentFailures: webhookHealth.recentFailures
    },
    safeForChannelOnboarding: Object.values(blockerCounts).every((count) => count === 0),
    blockerCounts,
    blockerSamples: Object.fromEntries(
      Object.entries(blockers).map(([key, value]) => [key, value.slice(0, 25)])
    )
  };
}

async function addProductMedia(product: Record<string, unknown>, mapping: Record<string, unknown>) {
  // Use an additive media repair only for products with no primary Shopify image;
  // productSet file lists can replace product media, which is too broad here.
  const media = productImageUrls(product).map((url) => ({
    alt: String(product.name || `Listing #${product.id}`).slice(0, 512),
    mediaContentType: 'IMAGE',
    originalSource: url
  }));
  if (!media.length) throw new Error(`No website image URL is available for product ${product.id}.`);

  const data = await shopifyGraphql<{
    productCreateMedia: {
      media?: Array<{ alt?: string | null; mediaContentType?: string; status?: string }> | null;
      mediaUserErrors?: Array<{ field?: string[]; message?: string }> | null;
      product?: { id: string } | null;
    };
  }>(
    `mutation AddProductMedia($media: [CreateMediaInput!]!, $productId: ID!) {
      productCreateMedia(media: $media, productId: $productId) {
        media {
          alt
          mediaContentType
          status
        }
        mediaUserErrors {
          field
          message
        }
        product {
          id
        }
      }
    }`,
    {
      media,
      productId: shopifyGid('Product', numericId(mapping.shopify_product_id, 'product id'))
    }
  );

  const result = data.productCreateMedia;
  if (result.mediaUserErrors?.length) {
    throw new Error(
      result.mediaUserErrors
        .map((error) => `${error.field?.join('.') || 'media'}: ${error.message || 'Unknown media error'}`)
        .join('; ')
    );
  }
  return { added: result.media?.length || media.length, sources: media.map((item) => item.originalSource) };
}

async function repairMissingImages(options: { dryRun?: boolean; limit?: number; productId?: number } = {}) {
  const [products, mappings, shopifyItems] = await Promise.all([
    loadPagedRows(
      'products',
      'id,name,image,image_gallery,metadata,is_deleted',
      'id'
    ),
    loadPagedRows(
      'shopify_product_mappings',
      'product_id,source_class,shopify_product_id',
      'product_id'
    ),
    loadInventoryItems()
  ]);

  const productFilter = Number(options.productId);
  const limit = Math.min(100, Math.max(1, Math.floor(Number(options.limit) || 100)));
  const productsById = new Map(products.map((product) => [Number(product.id), product]));
  const shopifyItemsByProductId = new Map<number, InventoryItemNode>();
  for (const item of shopifyItems) {
    const productId = productIdFromSku(item.sku || '');
    if (productId) shopifyItemsByProductId.set(productId, item);
  }

  const candidates = mappings
    .filter((mapping) => !Number.isSafeInteger(productFilter) || Number(mapping.product_id) === productFilter)
    .map((mapping) => {
      const productId = Number(mapping.product_id);
      const product = productsById.get(productId);
      const shopifyItem = shopifyItemsByProductId.get(productId);
      const variant = shopifyItem?.variants?.nodes?.[0] || null;
      return {
        productId,
        mapping,
        product,
        title: String(product?.name || `Listing #${productId}`),
        imageUrls: product ? productImageUrls(product) : [],
        hasShopifyPrimaryImage: Boolean(variant?.product?.featuredMedia?.id)
      };
    })
    .filter((candidate) => (
      candidate.product
      && candidate.imageUrls.length
      && !candidate.hasShopifyPrimaryImage
    ));

  const selected = firstItems(candidates, limit);
  if (options.dryRun) {
    return {
      dryRun: true,
      candidateCount: candidates.length,
      selectedCount: selected.length,
      candidates: selected.map((candidate) => ({
        productId: candidate.productId,
        title: candidate.title,
        imageCount: candidate.imageUrls.length,
        firstImageUrl: candidate.imageUrls[0]
      }))
    };
  }

  const repaired = [];
  const failed = [];
  for (const candidate of selected) {
    try {
      const result = await addProductMedia(candidate.product!, candidate.mapping);
      repaired.push({ productId: candidate.productId, ...result });
    } catch (error) {
      failed.push({ productId: candidate.productId, error: errorMessage(error) });
    }
  }

  return {
    dryRun: false,
    candidateCount: candidates.length,
    selectedCount: selected.length,
    repairedCount: repaired.length,
    failedCount: failed.length,
    repaired,
    failed
  };
}

async function setShopifyProductStatus(productId: number, shopifyProductId: unknown, status: 'ACTIVE' | 'DRAFT') {
  const data = await shopifyGraphql<{
    productSet: {
      product?: { id: string; status: string } | null;
      userErrors?: Array<{ field?: string[]; message?: string }> | null;
    };
  }>(
    `mutation SetProductStatus($identifier: ProductSetIdentifiers, $input: ProductSetInput!) {
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
      identifier: { id: shopifyGid('Product', shopifyProductId as number | string) },
      input: {
        handle: `djhc-${productId}`,
        status
      }
    }
  );
  const result = data.productSet;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message || 'Unknown product status error').join('; '));
  }
  return result.product?.status || status;
}

async function loadPublications() {
  const publications: PublicationNode[] = [];
  let after: string | null = null;

  do {
    const data: PublicationsPage = await shopifyGraphql<PublicationsPage>(
      `query ShopifyPublications($first: Int!, $after: String) {
        publications(first: $first, after: $after) {
          nodes {
            id
            name
            autoPublish
            supportsFuturePublishing
            catalog {
              id
              title
              status
            }
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }`,
      { first: 50, after }
    );
    publications.push(...data.publications.nodes);
    after = data.publications.pageInfo.hasNextPage
      ? data.publications.pageInfo.endCursor || null
      : null;
  } while (after);

  return publications;
}

function resolveExactPublications(publications: PublicationNode[], channels?: string[]) {
  const requestedChannels = [...new Set(
    (Array.isArray(channels) && channels.length ? channels : SHOPIFY_PUBLICATION_CHANNELS)
      .map((channel) => String(channel || '').trim())
      .filter(Boolean)
  )];
  const selectedPublications: PublicationNode[] = [];
  const missingChannels: string[] = [];
  const ambiguousChannels: Array<{ channel: string; matches: string[] }> = [];

  for (const channel of requestedChannels) {
    const requested = normalizedName(channel);
    const matches = publications.filter((publication) => (
      normalizedName(publicationLabel(publication)) === requested
      || normalizedName(publication.catalog?.title) === requested
    ));
    if (!matches.length) {
      missingChannels.push(channel);
      continue;
    }
    if (matches.length > 1) {
      ambiguousChannels.push({ channel, matches: matches.map((publication) => publicationLabel(publication)) });
      continue;
    }
    selectedPublications.push(matches[0]);
  }

  const duplicatePublicationIds = selectedPublications
    .map((publication) => publication.id)
    .filter((id, index, ids) => ids.indexOf(id) !== index);
  const blocker = missingChannels.length || ambiguousChannels.length || duplicatePublicationIds.length
    ? 'Every requested Shopify channel must resolve to one unique publication before reconciliation can run.'
    : null;

  return {
    requestedChannels,
    selectedPublications,
    missingChannels,
    ambiguousChannels,
    duplicatePublicationIds: [...new Set(duplicatePublicationIds)],
    blocker
  };
}

function publicationSummary(publications: PublicationNode[], selectedPublications: PublicationNode[]) {
  const selectedIds = new Set(selectedPublications.map((publication) => publication.id));
  return publications.map((publication) => ({
    id: publication.id,
    label: publicationLabel(publication),
    catalogTitle: publication.catalog?.title || null,
    catalogStatus: publication.catalog?.status || null,
    autoPublish: publication.autoPublish ?? null,
    supportsFuturePublishing: publication.supportsFuturePublishing ?? null,
    selected: selectedIds.has(publication.id)
  }));
}

async function loadShopifyMappingBatch(options: { limit?: number; afterProductId?: number } = {}, maxLimit = 50) {
  const limit = Math.min(maxLimit, Math.max(1, Math.floor(Number(options.limit) || 25)));
  const afterProductId = Math.max(0, Math.floor(Number(options.afterProductId) || 0));
  const { data, error } = await admin
    .from('shopify_product_mappings')
    .select(
      'product_id,sku,source_class,publish_enabled,shop_domain,shopify_product_id,shopify_variant_id,shopify_inventory_item_id,shopify_location_id,shopify_handle,last_shopify_quantity,last_synced_at'
    )
    .gt('product_id', afterProductId)
    .order('product_id', { ascending: true })
    .limit(limit);
  if (error) throw error;
  const mappings = (data || []) as Record<string, unknown>[];
  const nextAfterProductId = mappings.length
    ? Number(mappings[mappings.length - 1].product_id)
    : afterProductId;
  return { limit, afterProductId, nextAfterProductId, mappings };
}

async function loadProductsForMappings(mappings: Record<string, unknown>[]) {
  if (!mappings.length) return new Map<number, Record<string, unknown>>();
  const { data, error } = await admin
    .from('products')
    .select('id,metadata,is_deleted,sale_status,checkout_enabled,quantity_available,checkout_price,price')
    .in('id', mappings.map((mapping) => Number(mapping.product_id)));
  if (error) throw error;
  return new Map(
    ((data || []) as Record<string, unknown>[]).map((product) => [Number(product.id), product])
  );
}

async function loadShopifyPublicationStates(mappings: Record<string, unknown>[]) {
  if (!mappings.length) return new Map<string, ShopifyPublicationState>();
  const ids = mappings.map((mapping) => (
    shopifyGid('Product', mapping.shopify_product_id as number | string)
  ));
  const data = await shopifyGraphql<ShopifyPublicationStatesResponse>(
    `query ShopifyProductPublicationStates($ids: [ID!]!, $publicationFirst: Int!) {
      nodes(ids: $ids) {
        __typename
        id
        ... on Product {
          status
          resourcePublicationsV2(first: $publicationFirst, onlyPublished: false) {
            nodes {
              isPublished
              publishDate
              publication {
                id
                name
                autoPublish
                supportsFuturePublishing
                catalog {
                  id
                  title
                  status
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`,
    { ids, publicationFirst: PRODUCT_PUBLICATION_LIMIT }
  );
  const states = new Map<string, ShopifyPublicationState>();
  for (const node of data.nodes || []) {
    if (node?.id) states.set(node.id, node);
  }
  return states;
}

async function publishShopifyProduct(shopifyProductId: unknown, publications: PublicationNode[]) {
  const publicationInput = publications.map((publication) => ({ publicationId: publication.id }));
  if (!publicationInput.length) throw new Error('No Shopify publications were selected.');

  const data = await shopifyGraphql<{
    publishablePublish: {
      publishable?: {
        availablePublicationsCount?: { count?: number | null } | null;
        resourcePublicationsCount?: { count?: number | null } | null;
      } | null;
      userErrors?: Array<{ field?: string[]; message?: string }> | null;
    };
  }>(
    `mutation PublishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishablePublish(id: $id, input: $input) {
        publishable {
          availablePublicationsCount {
            count
          }
          resourcePublicationsCount {
            count
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      id: shopifyGid('Product', shopifyProductId as number | string),
      input: publicationInput
    }
  );
  const result = data.publishablePublish;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message || 'Unknown publication error').join('; '));
  }
  return {
    availablePublications: result.publishable?.availablePublicationsCount?.count ?? null,
    resourcePublications: result.publishable?.resourcePublicationsCount?.count ?? null
  };
}

async function unpublishShopifyProduct(shopifyProductId: unknown, publications: PublicationNode[]) {
  const publicationInput = publications.map((publication) => ({ publicationId: publication.id }));
  if (!publicationInput.length) return { availablePublications: null, resourcePublications: null };

  const data = await shopifyGraphql<{
    publishableUnpublish: {
      publishable?: {
        availablePublicationsCount?: { count?: number | null } | null;
        resourcePublicationsCount?: { count?: number | null } | null;
      } | null;
      userErrors?: Array<{ field?: string[]; message?: string }> | null;
    };
  }>(
    `mutation UnpublishProduct($id: ID!, $input: [PublicationInput!]!) {
      publishableUnpublish(id: $id, input: $input) {
        publishable {
          availablePublicationsCount {
            count
          }
          resourcePublicationsCount {
            count
          }
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      id: shopifyGid('Product', shopifyProductId as number | string),
      input: publicationInput
    }
  );
  const result = data.publishableUnpublish;
  if (result.userErrors?.length) {
    throw new Error(result.userErrors.map((error) => error.message || 'Unknown unpublication error').join('; '));
  }
  return {
    availablePublications: result.publishable?.availablePublicationsCount?.count ?? null,
    resourcePublications: result.publishable?.resourcePublicationsCount?.count ?? null
  };
}

function publicationEligibility(product?: Record<string, unknown>) {
  if (!product) {
    return { classification: 'missing', eligible: false, reasons: ['missing_website_product'] };
  }
  const classification = sourceClass(product);
  const reasons: string[] = [];
  if (classification !== 'nonlegacy') reasons.push('legacy');
  if (product.is_deleted !== false) reasons.push('deleted');
  if (product.checkout_enabled !== true) reasons.push('checkout_disabled');
  if (product.sale_status !== 'available') reasons.push(`sale_status_${String(product.sale_status || 'missing')}`);
  if (!(Number(product.quantity_available) > 0)) reasons.push('out_of_stock');
  if (directCheckoutPrice(product) === null) reasons.push('missing_price');
  return { classification, eligible: reasons.length === 0, reasons };
}

function buildPublicationReconciliationPlan(
  mapping: Record<string, unknown>,
  product: Record<string, unknown> | undefined,
  state: ShopifyPublicationState | undefined,
  selectedPublications: PublicationNode[]
) {
  const productId = Number(mapping.product_id);
  const eligibility = publicationEligibility(product);
  const desiredStatus: 'ACTIVE' | 'DRAFT' = eligibility.eligible ? 'ACTIVE' : 'DRAFT';
  const desiredPublishEnabled = eligibility.eligible;
  const desiredSourceClass = eligibility.classification === 'missing'
    ? String(mapping.source_class || 'nonlegacy')
    : eligibility.classification;
  const selectedIds = new Set(selectedPublications.map((publication) => publication.id));
  const memberships = state?.resourcePublicationsV2?.nodes || [];
  const selectedMemberships = memberships.filter((membership) => selectedIds.has(membership.publication.id));
  const activeMemberships = selectedMemberships.filter((membership) => (
    membership.isPublished || Boolean(membership.publishDate)
  ));
  const publishedIds = new Set(
    selectedMemberships.filter((membership) => membership.isPublished).map((membership) => membership.publication.id)
  );
  const missingPublicationIds = eligibility.eligible
    ? selectedPublications.filter((publication) => !publishedIds.has(publication.id)).map((publication) => publication.id)
    : [];
  const scheduledPublicationIds = selectedMemberships
    .filter((membership) => !membership.isPublished && Boolean(membership.publishDate))
    .map((membership) => membership.publication.id);
  const publicationIdsToRemove = eligibility.eligible
    ? scheduledPublicationIds
    : activeMemberships.map((membership) => membership.publication.id);
  const publicationStateTruncated = state?.resourcePublicationsV2?.pageInfo?.hasNextPage === true;
  const actualStatus = state?.status || null;
  const missingShopifyProduct = !state || state.__typename !== 'Product';
  const statusMismatch = actualStatus !== desiredStatus;
  const mappingMismatch = mapping.publish_enabled !== desiredPublishEnabled
    || String(mapping.source_class || '') !== desiredSourceClass;
  const publicationMismatch = eligibility.eligible
    ? missingPublicationIds.length > 0 || scheduledPublicationIds.length > 0
    : activeMemberships.length > 0;
  const clean = !missingShopifyProduct
    && !publicationStateTruncated
    && !statusMismatch
    && !mappingMismatch
    && !publicationMismatch;

  return {
    productId,
    shopifyProductId: Number(mapping.shopify_product_id),
    classification: eligibility.classification,
    eligibilityReasons: eligibility.reasons,
    desiredStatus,
    actualStatus,
    desiredPublishEnabled,
    actualPublishEnabled: mapping.publish_enabled === true,
    desiredSourceClass,
    actualSourceClass: String(mapping.source_class || ''),
    missingShopifyProduct,
    publicationStateTruncated,
    statusMismatch,
    mappingMismatch,
    publicationMismatch,
    missingPublicationIds,
    scheduledPublicationIds,
    publicationIdsToRemove: [...new Set(publicationIdsToRemove)],
    memberships: selectedMemberships.map((membership) => ({
      publicationId: membership.publication.id,
      label: publicationLabel(membership.publication),
      isPublished: membership.isPublished,
      publishDate: membership.publishDate || null
    })),
    clean
  };
}

async function reconcilePublications(options: {
  dryRun?: boolean;
  limit?: number;
  afterProductId?: number;
} = {}) {
  const dryRun = options.dryRun !== false;
  const [batch, publications] = await Promise.all([
    loadShopifyMappingBatch(options, 50),
    loadPublications()
  ]);
  const resolution = resolveExactPublications(publications, SHOPIFY_PUBLICATION_CHANNELS);
  const availablePublications = publicationSummary(publications, resolution.selectedPublications);
  const baseResult = {
    dryRun,
    selectedCount: batch.mappings.length,
    nextAfterProductId: batch.nextAfterProductId,
    requestedChannels: resolution.requestedChannels,
    selectedPublications: resolution.selectedPublications.map((publication) => ({
      id: publication.id,
      label: publicationLabel(publication),
      catalogTitle: publication.catalog?.title || null
    })),
    availablePublications,
    missingChannels: resolution.missingChannels,
    ambiguousChannels: resolution.ambiguousChannels,
    duplicatePublicationIds: resolution.duplicatePublicationIds
  };

  if (resolution.blocker) {
    return { ...baseResult, blocker: resolution.blocker, mismatchCount: 0, candidates: [] };
  }
  if (!batch.mappings.length) {
    return {
      ...baseResult,
      desiredActiveCount: 0,
      desiredDraftCount: 0,
      cleanCount: 0,
      mismatchCount: 0,
      candidates: [],
      ...(dryRun ? {} : { appliedCount: 0, failedCount: 0, applied: [], failed: [] })
    };
  }

  const [productsById, statesByGid] = await Promise.all([
    loadProductsForMappings(batch.mappings),
    loadShopifyPublicationStates(batch.mappings)
  ]);
  const entries = batch.mappings.map((mapping) => {
    const productId = Number(mapping.product_id);
    const product = productsById.get(productId);
    const gid = shopifyGid('Product', mapping.shopify_product_id as number | string);
    return {
      mapping,
      product,
      plan: buildPublicationReconciliationPlan(
        mapping,
        product,
        statesByGid.get(gid),
        resolution.selectedPublications
      )
    };
  });
  const candidates = entries.filter((entry) => !entry.plan.clean);
  const counts = {
    desiredActiveCount: entries.filter((entry) => entry.plan.desiredStatus === 'ACTIVE').length,
    desiredDraftCount: entries.filter((entry) => entry.plan.desiredStatus === 'DRAFT').length,
    cleanCount: entries.length - candidates.length,
    mismatchCount: candidates.length
  };

  if (dryRun) {
    return { ...baseResult, ...counts, candidates: candidates.map((entry) => entry.plan) };
  }

  const publicationsById = new Map(
    resolution.selectedPublications.map((publication) => [publication.id, publication])
  );
  const applied = [];
  const failed = [];
  for (const entry of candidates) {
    const { mapping, product, plan } = entry;
    const productId = Number(mapping.product_id);
    try {
      if (plan.missingShopifyProduct) throw new Error('Mapped Shopify product was not found.');
      if (plan.publicationStateTruncated) {
        throw new Error('Shopify publication state exceeded the reconciliation query limit.');
      }

      const actions: string[] = [];
      if (!plan.desiredPublishEnabled && mapping.publish_enabled === true) {
        const { error } = await admin
          .from('shopify_product_mappings')
          .update({ publish_enabled: false, source_class: plan.desiredSourceClass })
          .eq('product_id', productId);
        if (error) throw error;
        mapping.publish_enabled = false;
        mapping.source_class = plan.desiredSourceClass;
        actions.push('closed_publish_gate');
      }

      if (plan.statusMismatch) {
        await setShopifyProductStatus(productId, mapping.shopify_product_id, plan.desiredStatus);
        actions.push(`set_status_${plan.desiredStatus.toLowerCase()}`);
      }

      const publicationsToRemove = plan.publicationIdsToRemove
        .map((id) => publicationsById.get(id))
        .filter((publication): publication is PublicationNode => Boolean(publication));
      if (publicationsToRemove.length) {
        await unpublishShopifyProduct(mapping.shopify_product_id, publicationsToRemove);
        actions.push(`unpublished_${publicationsToRemove.length}`);
      }

      if (plan.desiredPublishEnabled && plan.missingPublicationIds.length) {
        const publicationsToPublish = plan.missingPublicationIds
          .map((id) => publicationsById.get(id))
          .filter((publication): publication is PublicationNode => Boolean(publication));
        if (publicationsToPublish.length !== plan.missingPublicationIds.length) {
          throw new Error('A required Shopify publication could not be resolved during apply.');
        }
        await publishShopifyProduct(mapping.shopify_product_id, publicationsToPublish);
        actions.push(`published_${publicationsToPublish.length}`);
      }

      const refreshedStates = await loadShopifyPublicationStates([mapping]);
      const expectedMapping = {
        ...mapping,
        source_class: plan.desiredSourceClass,
        publish_enabled: plan.desiredPublishEnabled
      };
      const refreshedPlan = buildPublicationReconciliationPlan(
        expectedMapping,
        product,
        refreshedStates.get(shopifyGid('Product', mapping.shopify_product_id as number | string)),
        resolution.selectedPublications
      );
      if (!refreshedPlan.clean) {
        throw new Error('Shopify status or publication state did not match the requested state after apply.');
      }

      const { error: updateError } = await admin
        .from('shopify_product_mappings')
        .update({
          source_class: plan.desiredSourceClass,
          publish_enabled: plan.desiredPublishEnabled,
          last_synced_at: new Date().toISOString()
        })
        .eq('product_id', productId);
      if (updateError) throw updateError;
      applied.push({ productId, actions, finalStatus: refreshedPlan.actualStatus });
    } catch (error) {
      failed.push({ productId, error: errorMessage(error) });
    }
  }

  return {
    ...baseResult,
    ...counts,
    candidateCount: candidates.length,
    appliedCount: applied.length,
    failedCount: failed.length,
    applied,
    failed
  };
}

function snapshotConnectionHasNextPage(node: ShopifySnapshotNode | null, field: string) {
  const connection = node?.[field] as { pageInfo?: { hasNextPage?: boolean } } | undefined;
  return connection?.pageInfo?.hasNextPage === true;
}

async function snapshotCatalog(options: { limit?: number; afterProductId?: number } = {}) {
  const batch = await loadShopifyMappingBatch(options, 20);
  if (!batch.mappings.length) {
    return {
      generatedAt: new Date().toISOString(),
      selectedCount: 0,
      nextAfterProductId: batch.nextAfterProductId,
      snapshotCount: 0,
      missingNodeCount: 0,
      truncatedConnectionCount: 0,
      snapshots: [],
      missingNodes: [],
      truncatedConnections: []
    };
  }

  const ids = [...new Set(batch.mappings.flatMap((mapping) => [
    shopifyGid('Product', mapping.shopify_product_id as number | string),
    shopifyGid('ProductVariant', mapping.shopify_variant_id as number | string),
    shopifyGid('InventoryItem', mapping.shopify_inventory_item_id as number | string)
  ]))];
  const data = await shopifyGraphql<ShopifySnapshotResponse>(
    `query ShopifyCatalogSnapshot(
      $ids: [ID!]!,
      $inventoryLevelFirst: Int!,
      $mediaFirst: Int!,
      $publicationFirst: Int!
    ) {
      nodes(ids: $ids) {
        __typename
        id
        ... on Product {
          legacyResourceId
          title
          handle
          status
          productType
          vendor
          tags
          descriptionHtml
          updatedAt
          featuredMedia {
            id
            alt
            mediaContentType
            status
            preview {
              status
              image {
                id
                url
                altText
                width
                height
              }
            }
          }
          media(first: $mediaFirst) {
            nodes {
              id
              alt
              mediaContentType
              status
              preview {
                status
                image {
                  id
                  url
                  altText
                  width
                  height
                }
              }
              ... on MediaImage {
                image {
                  id
                  url
                  altText
                  width
                  height
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
          resourcePublicationsV2(first: $publicationFirst, onlyPublished: false) {
            nodes {
              isPublished
              publishDate
              publication {
                id
                name
                autoPublish
                supportsFuturePublishing
                catalog {
                  id
                  title
                  status
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
        ... on ProductVariant {
          legacyResourceId
          title
          sku
          price
          compareAtPrice
          barcode
          inventoryPolicy
          taxable
          selectedOptions {
            name
            value
          }
          product {
            id
            legacyResourceId
          }
          inventoryItem {
            id
            legacyResourceId
            tracked
          }
        }
        ... on InventoryItem {
          legacyResourceId
          sku
          tracked
          inventoryLevels(first: $inventoryLevelFirst) {
            nodes {
              location {
                id
                legacyResourceId
                name
              }
              quantities(names: ["available"]) {
                name
                quantity
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }`,
    {
      ids,
      inventoryLevelFirst: INVENTORY_LEVEL_SNAPSHOT_LIMIT,
      mediaFirst: PRODUCT_MEDIA_SNAPSHOT_LIMIT,
      publicationFirst: PRODUCT_PUBLICATION_LIMIT
    }
  );

  const nodesById = new Map<string, ShopifySnapshotNode>();
  for (const node of data.nodes || []) {
    if (node?.id) nodesById.set(node.id, node);
  }
  const missingNodes: Array<{ productId: number; resource: string; gid: string }> = [];
  const truncatedConnections: Array<{ productId: number; connection: string }> = [];
  const snapshots = batch.mappings.map((mapping) => {
    const productId = Number(mapping.product_id);
    const productGid = shopifyGid('Product', mapping.shopify_product_id as number | string);
    const variantGid = shopifyGid('ProductVariant', mapping.shopify_variant_id as number | string);
    const inventoryItemGid = shopifyGid('InventoryItem', mapping.shopify_inventory_item_id as number | string);
    const product = nodesById.get(productGid) || null;
    const variant = nodesById.get(variantGid) || null;
    const inventoryItem = nodesById.get(inventoryItemGid) || null;

    if (!product) missingNodes.push({ productId, resource: 'product', gid: productGid });
    if (!variant) missingNodes.push({ productId, resource: 'variant', gid: variantGid });
    if (!inventoryItem) missingNodes.push({ productId, resource: 'inventory_item', gid: inventoryItemGid });
    if (snapshotConnectionHasNextPage(product, 'media')) {
      truncatedConnections.push({ productId, connection: 'media' });
    }
    if (snapshotConnectionHasNextPage(product, 'resourcePublicationsV2')) {
      truncatedConnections.push({ productId, connection: 'resourcePublicationsV2' });
    }
    if (snapshotConnectionHasNextPage(inventoryItem, 'inventoryLevels')) {
      truncatedConnections.push({ productId, connection: 'inventoryLevels' });
    }

    return {
      websiteProductId: productId,
      mapping,
      shopify: { product, variant, inventoryItem }
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    selectedCount: batch.mappings.length,
    nextAfterProductId: batch.nextAfterProductId,
    snapshotCount: snapshots.length,
    missingNodeCount: missingNodes.length,
    truncatedConnectionCount: truncatedConnections.length,
    snapshots,
    missingNodes,
    truncatedConnections
  };
}

async function activateNonlegacyProducts(options: { dryRun?: boolean; limit?: number; afterProductId?: number } = {}) {
  const batch = await loadEligibleNonlegacyMappings(options, { defaultLimit: 50, maxLimit: 100 });

  if (options.dryRun) {
    return {
      dryRun: true,
      selectedCount: batch.mappings.length,
      eligibleCount: batch.eligibleMappings.length,
      skippedCount: batch.skipped.length,
      nextAfterProductId: batch.nextAfterProductId,
      candidates: batch.eligibleMappings.map((mapping) => ({
        productId: Number(mapping.product_id),
        shopifyProductId: Number(mapping.shopify_product_id),
        alreadyPublishEnabled: mapping.publish_enabled === true
      })),
      skipped: batch.skipped
    };
  }

  const activated = [];
  const failed = [];
  for (const mapping of batch.eligibleMappings) {
    const productId = Number(mapping.product_id);
    try {
      const status = await setShopifyProductStatus(productId, mapping.shopify_product_id, 'ACTIVE');
      const { error: updateError } = await admin
        .from('shopify_product_mappings')
        .update({ publish_enabled: true, last_synced_at: new Date().toISOString() })
        .eq('product_id', productId);
      if (updateError) throw updateError;
      activated.push({ productId, status });
    } catch (error) {
      failed.push({ productId, error: errorMessage(error) });
    }
  }

  return {
    dryRun: false,
    selectedCount: batch.mappings.length,
    eligibleCount: batch.eligibleMappings.length,
    skippedCount: batch.skipped.length,
    activatedCount: activated.length,
    failedCount: failed.length,
    nextAfterProductId: batch.nextAfterProductId,
    activated,
    failed,
    skipped: batch.skipped
  };
}

async function publishNonlegacyProducts(options: {
  dryRun?: boolean;
  limit?: number;
  afterProductId?: number;
  channels?: string[];
} = {}) {
  const requestedChannels = Array.isArray(options.channels) && options.channels.length
    ? options.channels.map((channel) => String(channel || '').trim()).filter(Boolean)
    : ['Online Store', 'TikTok', 'Whatnot'];
  const limit = Math.min(50, Math.max(1, Math.floor(Number(options.limit) || 25)));
  const afterProductId = Math.max(0, Math.floor(Number(options.afterProductId) || 0));
  const publications = await loadPublications();
  const selectedPublications = publications.filter((publication) => (
    requestedChannels.some((channel) => matchesRequestedChannel(publication, channel))
  ));
  const batch = await loadEligibleNonlegacyMappings(
    { limit, afterProductId },
    { defaultLimit: 25, maxLimit: 50, publishEnabledOnly: true }
  );

  const publicationSummary = publications.map((publication) => ({
    id: publication.id,
    label: publicationLabel(publication),
    catalogTitle: publication.catalog?.title || null,
    catalogStatus: publication.catalog?.status || null,
    selected: selectedPublications.some((selected) => selected.id === publication.id)
  }));

  if (!selectedPublications.length) {
    return {
      dryRun: options.dryRun !== false,
      selectedCount: batch.mappings.length,
      eligibleCount: batch.eligibleMappings.length,
      skippedCount: batch.skipped.length,
      requestedChannels,
      selectedPublications: [],
      availablePublications: publicationSummary,
      nextAfterProductId: batch.nextAfterProductId,
      candidates: firstItems(batch.eligibleMappings.map((mapping) => ({
        productId: Number(mapping.product_id),
        shopifyProductId: Number(mapping.shopify_product_id)
      }))),
      skipped: batch.skipped,
      blocker: 'No Shopify publication matched the requested channel names.'
    };
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      selectedCount: batch.mappings.length,
      eligibleCount: batch.eligibleMappings.length,
      skippedCount: batch.skipped.length,
      requestedChannels,
      selectedPublications: selectedPublications.map((publication) => ({
        id: publication.id,
        label: publicationLabel(publication),
        catalogTitle: publication.catalog?.title || null
      })),
      availablePublications: publicationSummary,
      nextAfterProductId: batch.nextAfterProductId,
      candidates: batch.eligibleMappings.map((mapping) => ({
        productId: Number(mapping.product_id),
        shopifyProductId: Number(mapping.shopify_product_id)
      })),
      skipped: batch.skipped
    };
  }

  const published = [];
  const failed = [];
  for (const mapping of batch.eligibleMappings) {
    const productId = Number(mapping.product_id);
    try {
      const result = await publishShopifyProduct(mapping.shopify_product_id, selectedPublications);
      published.push({ productId, ...result });
    } catch (error) {
      failed.push({ productId, error: errorMessage(error) });
    }
  }

  return {
    dryRun: false,
    selectedCount: batch.mappings.length,
    eligibleCount: batch.eligibleMappings.length,
    skippedCount: batch.skipped.length,
    publishedCount: published.length,
    failedCount: failed.length,
    requestedChannels,
    selectedPublications: selectedPublications.map((publication) => ({
      id: publication.id,
      label: publicationLabel(publication),
      catalogTitle: publication.catalog?.title || null
    })),
    nextAfterProductId: batch.nextAfterProductId,
    published,
    failed,
    skipped: batch.skipped
  };
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
        descriptionHtml: productDescriptionHtml(product),
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
      changeFromQuantity: Number.isSafeInteger(Number(mapping.last_shopify_quantity))
        ? Number(mapping.last_shopify_quantity)
        : null,
      inventoryItemId: shopifyGid('InventoryItem', mapping.shopify_inventory_item_id),
      locationId: shopifyGid('Location', mapping.shopify_location_id),
      quantity
    }]
  });

  const { error: mappingUpdateError } = await admin.from('shopify_product_mappings').update({
    last_shopify_quantity: quantity,
    last_synced_at: new Date().toISOString()
  }).eq('product_id', productId);
  if (mappingUpdateError) throw mappingUpdateError;

  return {
    productId,
    status,
    sourceClass: classification,
    publishEnabled: mapping.publish_enabled === true
  };
}

async function upsertFeaturedCustomCollection() {
  const bodyHtml = '<p>A rotating set of cards, comics, and collectibles worth a closer look from DJHC inventory.</p>';
  const existing = await shopifyRest<CustomCollectionPayload>(
    'GET',
    `custom_collections.json?handle=${encodeURIComponent(FEATURED_COLLECTION_HANDLE)}&limit=1`
  );
  const current = existing.custom_collections?.[0] || null;
  const payload = {
    custom_collection: {
      ...(current?.id ? { id: current.id } : {}),
      title: FEATURED_COLLECTION_TITLE,
      handle: FEATURED_COLLECTION_HANDLE,
      body_html: bodyHtml,
      published: true,
      sort_order: 'manual'
    }
  };

  if (current?.id) {
    const updated = await shopifyRest<CustomCollectionPayload>(
      'PUT',
      `custom_collections/${current.id}.json`,
      payload
    );
    return updated.custom_collection || current;
  }

  const created = await shopifyRest<CustomCollectionPayload>('POST', 'custom_collections.json', payload);
  if (!created.custom_collection?.id) {
    throw new Error('Shopify did not return a featured custom collection id.');
  }
  return created.custom_collection;
}

async function ensureFeaturedCollection() {
  const { data: showcaseProducts, error: showcaseError } = await admin
    .from('products')
    .select('id,name,is_deleted')
    .in('id', SHOPIFY_SHOWCASE_PRODUCT_IDS)
    .eq('is_deleted', false)
    .order('id', { ascending: true });
  if (showcaseError) throw showcaseError;

  const availableIds = new Set(
    (showcaseProducts || [])
      .map((product) => Number(product.id))
      .filter((id) => Number.isSafeInteger(id) && id > 0)
  );
  const featuredIds = SHOPIFY_SHOWCASE_PRODUCT_IDS.filter((id) => availableIds.has(id));
  if (!featuredIds.length) {
    throw new Error('No Shopify showcase products were found for the featured collection.');
  }

  const { data: websiteFeaturedProducts, error: websiteFeaturedError } = await admin
    .from('products')
    .select('id,is_featured,is_deleted,sort_rank')
    .eq('is_featured', true)
    .eq('is_deleted', false)
    .order('sort_rank', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true });
  if (websiteFeaturedError) throw websiteFeaturedError;
  const websiteFeaturedIds = (websiteFeaturedProducts || [])
    .map((product) => Number(product.id))
    .filter((id) => Number.isSafeInteger(id) && id > 0);

  const { data: mappings, error: mappingError } = await admin
    .from('shopify_product_mappings')
    .select('product_id,source_class,shopify_product_id,shopify_handle,publish_enabled')
    .in('product_id', featuredIds);
  if (mappingError) throw mappingError;

  const mappingByProductId = new Map<number, Record<string, unknown>>();
  for (const mapping of mappings || []) {
    mappingByProductId.set(Number(mapping.product_id), mapping);
  }

  const desired = featuredIds
    .map((productId) => {
      const mapping = mappingByProductId.get(productId);
      const shopifyProductId = String(mapping?.shopify_product_id || '').trim();
      const source = String(mapping?.source_class || '');
      return shopifyProductId && source === 'nonlegacy' && mapping?.publish_enabled === true
        ? { productId, shopifyProductId, mapping }
        : null;
    })
    .filter((entry): entry is { productId: number; shopifyProductId: string; mapping: Record<string, unknown> } => Boolean(entry));
  if (!desired.length) {
    throw new Error('Featured website products do not have Shopify product mappings yet.');
  }

  const collection = await upsertFeaturedCustomCollection();
  const collectionId = String(collection.id || '').trim();
  if (!collectionId) throw new Error('Featured custom collection id was missing.');

  const current = await shopifyRest<CollectsPayload>(
    'GET',
    `collects.json?collection_id=${encodeURIComponent(collectionId)}&limit=250`
  );
  const desiredShopifyIds = new Set(desired.map((entry) => entry.shopifyProductId));
  const currentCollects = current.collects || [];
  const currentByProductId = new Map(
    currentCollects.map((collect) => [String(collect.product_id || '').trim(), collect])
  );
  const removed: Array<{ collectId: string; shopifyProductId: string }> = [];
  const created: Array<{ productId: number; shopifyProductId: string }> = [];

  for (const collect of currentCollects) {
    const shopifyProductId = String(collect.product_id || '').trim();
    const collectId = String(collect.id || '').trim();
    if (!collectId || desiredShopifyIds.has(shopifyProductId)) continue;
    await shopifyRest('DELETE', `collects/${collectId}.json`);
    removed.push({ collectId, shopifyProductId });
  }

  for (const [index, entry] of desired.entries()) {
    if (currentByProductId.has(entry.shopifyProductId)) continue;
    await shopifyRest<CollectsPayload>('POST', 'collects.json', {
      collect: {
        collection_id: collectionId,
        product_id: entry.shopifyProductId,
        position: index + 1
      }
    });
    created.push({ productId: entry.productId, shopifyProductId: entry.shopifyProductId });
  }

  return {
    collection: {
      id: collectionId,
      handle: collection.handle || FEATURED_COLLECTION_HANDLE,
      title: collection.title || FEATURED_COLLECTION_TITLE
    },
    featuredProductIds: featuredIds,
    websiteFeaturedIds,
    mappedProductIds: desired.map((entry) => entry.productId),
    createdCount: created.length,
    removedCount: removed.length,
    created,
    removed
  };
}

type ShopifyWebhookTopic = {
  topic: 'INVENTORY_LEVELS_UPDATE' | 'ORDERS_PAID';
  includeFields?: string[];
};

async function registerShopifyWebhook({ topic, includeFields }: ShopifyWebhookTopic) {
  const webhookUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/shopify-webhook`;
  const existing = await shopifyGraphql<{
    webhookSubscriptions: {
      nodes: Array<{ id: string; topic: string; uri: string }>;
    };
  }>(
    `query ExistingWebhooks($topics: [WebhookSubscriptionTopic!]) {
      webhookSubscriptions(first: 50, topics: $topics) {
        nodes {
          id
          topic
          uri
        }
      }
    }`,
    { topics: [topic] }
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
      topic,
      subscription: {
        uri: webhookUrl,
        format: 'JSON',
        ...(includeFields?.length ? { includeFields } : {})
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

async function deleteProductEverywhere(productId: number, deletedBy: string, reason = '') {
  const [{ data: product, error: productError }, { data: mapping, error: mappingError }] = await Promise.all([
    admin.from('products').select('*').eq('id', productId).maybeSingle(),
    admin
      .from('shopify_product_mappings')
      .select('shopify_product_id,shopify_handle')
      .eq('product_id', productId)
      .maybeSingle()
  ]);
  if (productError) throw productError;
  if (mappingError) throw mappingError;
  if (!product) throw new Error(`Listing #${productId} does not exist.`);

  const { error: prepareError } = await admin.rpc('prepare_product_deletion', {
    p_product_id: productId
  });
  if (prepareError) throw new Error(`Listing deletion could not begin: ${prepareError.message}`);

  let shopifyAction = 'not_mapped';
  const shopifyProductId = String(mapping?.shopify_product_id || '').trim();
  if (shopifyProductId) {
    const gid = shopifyGid('Product', shopifyProductId);
    const lookup = await shopifyGraphql<{ product: { id: string } | null }>(
      `query ProductForDeletion($id: ID!) { product(id: $id) { id } }`,
      { id: gid }
    );
    if (lookup.product) {
      const deletion = await shopifyGraphql<{
        productDelete: {
          deletedProductId?: string | null;
          userErrors?: Array<{ field?: string[]; message?: string }>;
        };
      }>(
        `mutation DeleteProduct($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors { field message }
          }
        }`,
        { input: { id: gid } }
      );
      if (deletion.productDelete.userErrors?.length) {
        throw new Error(`Shopify product deletion failed: ${deletion.productDelete.userErrors
          .map((error) => error.message || 'Unknown deletion error')
          .join('; ')}`);
      }
      if (!deletion.productDelete.deletedProductId) {
        throw new Error('Shopify did not confirm product deletion.');
      }
      shopifyAction = 'deleted';
    } else {
      shopifyAction = 'already_absent';
    }
  }

  const { error: deleteError } = await admin.rpc('delete_product_with_audit', {
    p_product_id: productId,
    p_deleted_by: deletedBy,
    p_shopify_action: shopifyAction,
    p_metadata: {
      reason: String(reason || '').trim().slice(0, 500),
      shopifyProductId: shopifyProductId || null,
      shopifyHandle: mapping?.shopify_handle || null,
      originalProductSnapshot: product
    }
  });
  if (deleteError) {
    throw new Error(
      shopifyAction === 'deleted'
        ? `Shopify was deleted, but the audited Supabase deletion failed: ${deleteError.message}`
        : `The audited Supabase deletion failed: ${deleteError.message}`
    );
  }
  return { productId, name: product.name, shopifyAction };
}

async function registerShopifyWebhooks() {
  const topics: ShopifyWebhookTopic[] = [
    {
      topic: 'INVENTORY_LEVELS_UPDATE',
      includeFields: ['inventory_item_id', 'location_id', 'available', 'updated_at']
    },
    {
      topic: 'ORDERS_PAID'
    }
  ];
  const results = [];
  const failed = [];
  for (const topic of topics) {
    try {
      results.push({ topic: topic.topic, ...(await registerShopifyWebhook(topic)) });
    } catch (error) {
      failed.push({
        topic: topic.topic,
        error: errorMessage(error)
      });
    }
  }
  return {
    count: results.length,
    failedCount: failed.length,
    results,
    failed
  };
}

Deno.serve(async (request) => {
  const respond = (body: Record<string, unknown>, status = 200) => jsonResponse(body, status, request);
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(request) });
  if (request.method !== 'POST') return respond({ error: 'Method not allowed.' }, 405);
  if (!supabaseUrl || !serviceRoleKey || !isShopifyConfigured()) {
    return respond({ error: 'Shopify catalog sync is not configured.' }, 503);
  }

  let adminIdentity: SiteAdminIdentity;
  try {
    adminIdentity = await requireAdmin(request);
  } catch (error) {
    return respond({ error: errorMessage(error) }, error instanceof SiteAdminError ? error.status : 503);
  }

  let payload: {
    action?: string;
    productId?: number;
    dryRun?: boolean;
    limit?: number;
    afterProductId?: number;
    channels?: string[];
    confirmProductId?: number;
    reason?: string;
  } = {};
  try {
    payload = await readJsonBody(request, 64 * 1024);
  } catch {
    return respond({ error: 'Invalid JSON request.' }, 400);
  }

  try {
    switch (payload.action) {
      case 'bootstrap-mappings':
        return respond({ ok: true, result: await bootstrapMappings() });
      case 'sync-product': {
        const productId = Number(payload.productId);
        if (!Number.isSafeInteger(productId) || productId <= 0) {
          return respond({ error: 'A valid productId is required.' }, 400);
        }
        return respond({ ok: true, result: await syncProduct(productId) });
      }
      case 'delete-product': {
        const productId = Number(payload.productId);
        if (!Number.isSafeInteger(productId) || productId <= 0 || Number(payload.confirmProductId) !== productId) {
          return respond({ error: 'A matching productId and confirmProductId are required.' }, 400);
        }
        return respond({
          ok: true,
          result: await deleteProductEverywhere(productId, adminIdentity.email, payload.reason)
        });
      }
      case 'register-webhooks':
        return respond({ ok: true, result: await registerShopifyWebhooks() });
      case 'ensure-featured-collection':
        return respond({ ok: true, result: await ensureFeaturedCollection() });
      case 'verify-catalog':
      case 'verify-import':
        return respond({ ok: true, result: await verifyCatalogState() });
      case 'snapshot-catalog':
        return respond({
          ok: true,
          result: await snapshotCatalog({
            limit: payload.limit,
            afterProductId: payload.afterProductId
          })
        });
      case 'verify-publications':
        return respond({
          ok: true,
          result: await reconcilePublications({
            dryRun: true,
            limit: payload.limit,
            afterProductId: payload.afterProductId
          })
        });
      case 'reconcile-publications':
        return respond({
          ok: true,
          result: await reconcilePublications({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            afterProductId: payload.afterProductId
          })
        });
      case 'repair-missing-images':
        return respond({
          ok: true,
          result: await repairMissingImages({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            productId: payload.productId
          })
        });
      case 'activate-nonlegacy-products':
        return respond({
          ok: true,
          result: await activateNonlegacyProducts({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            afterProductId: payload.afterProductId
          })
        });
      case 'publish-nonlegacy-products':
        return respond({
          ok: true,
          result: await publishNonlegacyProducts({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            afterProductId: payload.afterProductId,
            channels: payload.channels
          })
        });
      default:
        return respond({ error: 'Unknown Shopify sync action.' }, 400);
    }
  } catch (error) {
    console.error('[shopify-catalog-sync]', error);
    return respond({ error: errorMessage(error) || 'Shopify catalog sync failed.' }, 500);
  }
});
