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
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
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

function isActivationEligible(product?: Record<string, unknown>) {
  return Boolean(
    product
    && product.is_deleted !== true
    && product.checkout_enabled !== false
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
    const chunk = (data || []) as Record<string, unknown>[];
    rows.push(...chunk);
    if (chunk.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return rows;
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
  const [products, mappings, webhooks, shopifyItems] = await Promise.all([
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
    loadPagedRows(
      'marketplace_webhook_events',
      'provider,event_id,event_type,processing_status,product_id,created_at,processed_at,error_message',
      'created_at'
    ).catch(() => []),
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
  const nonlegacyNotActive: Array<{ productId: number; status: string }> = [];
  const malformedSkus: Array<{ productId: number; sku: string }> = [];
  const quantityMismatches: Array<{ productId: number; website: number; shopify: number | null }> = [];
  const priceMismatches: Array<{ productId: number; website: number | null; shopify: string | null }> = [];
  const missingShopifyItems: number[] = [];
  const missingShopifyImages: number[] = [];
  const legacyNotDraft: Array<{ productId: number; status: string }> = [];

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
    mappingSourceCounts[classification] += 1;

    if (!product) extraMappings.push(productId);
    if (classification === 'legacy' && mapping.publish_enabled === true) legacyPublishEnabled.push(productId);
    if (classification === 'nonlegacy' && mapping.publish_enabled !== true) nonlegacyPublishDisabled.push(productId);
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
    if (classification === 'nonlegacy' && mapping.publish_enabled === true && variant?.product?.status !== 'ACTIVE') {
      nonlegacyNotActive.push({ productId, status: String(variant?.product?.status || 'UNKNOWN') });
    }
  }

  const webhookStatusCounts = webhooks.reduce<Record<string, number>>((counts, event) => {
    const key = String(event.processing_status || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});

  const blockers = {
    missingMappings,
    extraMappings,
    sourceClassMismatches,
    legacyPublishEnabled,
    nonlegacyPublishDisabled,
    nonlegacyNotActive,
    malformedSkus,
    missingShopifyItems,
    quantityMismatches,
    priceMismatches,
    missingShopifyImages,
    legacyNotDraft
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
      nonlegacyPublishDisabled: nonlegacyPublishDisabled.length
    },
    shopify: {
      checked: Boolean(shopifyItems.length),
      skuCount: shopifyItems.length,
      nonlegacyNotActive: nonlegacyNotActive.length,
      legacyNotDraft: legacyNotDraft.length,
      missingPrimaryImages: missingShopifyImages.length,
      quantityMismatches: quantityMismatches.length,
      priceMismatches: priceMismatches.length
    },
    webhooks: {
      total: webhooks.length,
      statusCounts: webhookStatusCounts,
      recentFailures: firstItems(
        webhooks
          .filter((event) => event.processing_status === 'failed')
          .map((event) => ({
            eventId: event.event_id,
            eventType: event.event_type,
            productId: event.product_id,
            error: event.error_message
          })),
        10
      )
    },
    safeForChannelOnboarding: Object.values(blockerCounts).every((count) => count === 0),
    blockerCounts,
    blockerSamples: Object.fromEntries(
      Object.entries(blockers).map(([key, value]) => [key, firstItems(value)])
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
      productId: shopifyGid('Product', mapping.shopify_product_id)
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

  let payload: {
    action?: string;
    productId?: number;
    dryRun?: boolean;
    limit?: number;
    afterProductId?: number;
    channels?: string[];
  } = {};
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
      case 'verify-catalog':
      case 'verify-import':
        return jsonResponse({ ok: true, result: await verifyCatalogState() });
      case 'repair-missing-images':
        return jsonResponse({
          ok: true,
          result: await repairMissingImages({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            productId: payload.productId
          })
        });
      case 'activate-nonlegacy-products':
        return jsonResponse({
          ok: true,
          result: await activateNonlegacyProducts({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            afterProductId: payload.afterProductId
          })
        });
      case 'publish-nonlegacy-products':
        return jsonResponse({
          ok: true,
          result: await publishNonlegacyProducts({
            dryRun: payload.dryRun !== false,
            limit: payload.limit,
            afterProductId: payload.afterProductId,
            channels: payload.channels
          })
        });
      default:
        return jsonResponse({ error: 'Unknown Shopify sync action.' }, 400);
    }
  } catch (error) {
    console.error('[shopify-catalog-sync]', error);
    return jsonResponse({ error: errorMessage(error) || 'Shopify catalog sync failed.' }, 500);
  }
});
