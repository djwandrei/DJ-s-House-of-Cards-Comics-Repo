import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const productsPath = path.join(root, 'products.json');
const outputDir = path.join(root, 'outputs', 'marketplace-sync');
const siteUrl = 'https://www.djshouseofcards-comics.com/';
const SHOPIFY_SHIPPING_WEIGHT_TIERS = [
  { label: '3 oz or under', grams: 85 },
  { label: '8 oz', grams: 227 },
  { label: '12 oz', grams: 340 },
  { label: '1 lb', grams: 454 }
];
const publish = process.argv.includes('--publish');
const requestedStatus = process.argv
  .find((argument) => argument.startsWith('--status='))
  ?.split('=', 2)[1]
  ?.trim()
  ?.toLowerCase();
const status = ['active', 'archived', 'draft'].includes(requestedStatus)
  ? requestedStatus
  : 'draft';

const headers = [
  'URL handle',
  'Title',
  'Description',
  'Vendor',
  'Product category',
  'Type',
  'Tags',
  'Published on online store',
  'Status',
  'SKU',
  'Barcode',
  'Option1 name',
  'Option1 value',
  'Price',
  'Compare-at price',
  'Cost per item',
  'Charge tax',
  'Inventory tracker',
  'Inventory quantity',
  'Continue selling when out of stock',
  'Weight value (grams)',
  'Weight unit for display',
  'Requires shipping',
  'Fulfillment service',
  'Product image URL',
  'Image position',
  'Image alt text',
  'Variant image URL',
  'Gift card',
  'SEO title',
  'SEO description',
  'Google Shopping / Condition',
  'Collection'
];

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function htmlEscape(value = '') {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function publicAssetUrl(relativePath = '') {
  const encodedPath = String(relativePath || '')
    .replaceAll('\\', '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return new URL(encodedPath, siteUrl).href;
}

function quantityFor(product = {}) {
  const quantity = Number(product.quantityAvailable ?? product.copyCount ?? 1);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 1;
}

function numberOfCards(product = {}) {
  const value = Number(product.metadata?.excelFields?.['C:Number of Cards']);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function shippingTierForEstimate(estimatedGrams) {
  const tier = SHOPIFY_SHIPPING_WEIGHT_TIERS.find((item) => estimatedGrams <= item.grams)
    || SHOPIFY_SHIPPING_WEIGHT_TIERS[SHOPIFY_SHIPPING_WEIGHT_TIERS.length - 1];
  return {
    ...tier,
    needsReview: estimatedGrams > tier.grams
  };
}

function suggestedWeight(product = {}) {
  const category = cleanText(product.category).toLowerCase();
  const cardCount = numberOfCards(product);
  let estimatedGrams = 85;
  let basis = 'Shopify 3 oz or under card tier';

  if (category === 'comics') {
    estimatedGrams = 454;
    basis = 'Shopify 1 lb comic tier';
  } else if (category === 'collectibles') {
    estimatedGrams = 454;
    basis = 'Shopify 1 lb collectible tier';
  } else {
    const graded = /\b(PSA|BGS|SGC|CGC|CSG|TAG|HGA|GMA|KSA)\b/i.test(
      `${product.condition || ''} ${product.name || ''}`
    );
    const baseGrams = graded ? 170 : 85;
    estimatedGrams = baseGrams + Math.max(0, cardCount - 1) * 5;
    basis = graded
      ? `Shopify graded-card weight tier${cardCount > 1 ? ` for ${cardCount} cards` : ''}`
      : `Shopify raw-card weight tier${cardCount > 1 ? ` for ${cardCount} cards` : ''}`;
  }

  const tier = shippingTierForEstimate(estimatedGrams);
  return {
    grams: tier.grams,
    basis: `${basis}; assigned to ${tier.label}`,
    needsReview: tier.needsReview
  };
}

function isNonlegacy(product = {}) {
  return Boolean(product.metadata?.excelFields && typeof product.metadata.excelFields === 'object');
}

function productImages(product = {}) {
  const candidates = [
    product.image,
    ...(Array.isArray(product.imageGallery) ? product.imageGallery : [])
  ];
  return [...new Set(candidates.map((item) => cleanText(item)).filter(Boolean))];
}

function productType(product = {}) {
  const category = cleanText(product.category);
  if (['Baseball', 'Basketball', 'Football'].includes(category)) {
    return `${category} Cards`;
  }
  return category || 'Collectibles';
}

function productTags(product = {}) {
  const tags = [
    'DJHC',
    `DJHC-${product.id}`,
    'Cards Comics Collectibles',
    isNonlegacy(product) ? 'Website Catalog' : '',
    product.isFeatured === true ? 'Featured Pick' : '',
    product.category,
    product.sport,
    product.league,
    product.team,
    product.playerAthlete,
    product.year,
    ...(Array.isArray(product.attributes) ? product.attributes : [])
  ];
  return [...new Set(tags.map((tag) => cleanText(tag).replaceAll(',', ' ')).filter(Boolean))].join(', ');
}

function productDescription(product = {}) {
  const supplied = cleanText(product.description);
  const details = [
    ['Category', product.category],
    ['Sport', product.sport],
    ['League', product.league],
    ['Player/Athlete', product.playerAthlete],
    ['Team', product.team],
    ['Year', product.year],
    ['Condition', product.condition]
  ].filter(([, value]) => cleanText(value));
  const list = details
    .map(([label, value]) => `<li><strong>${htmlEscape(label)}:</strong> ${htmlEscape(cleanText(value))}</li>`)
    .join('');

  if (supplied) {
    const hasInlineDetails = /\bDetails:/i.test(supplied);
    return [
      `<p>${htmlEscape(supplied)}</p>`,
      !hasInlineDetails && list ? `<ul>${list}</ul>` : '',
      `<p>Please review all photos for the exact item you will receive. DJHC inventory ID: DJHC-${htmlEscape(product.id)}.</p>`
    ].filter(Boolean).join('');
  }

  return `<p>${htmlEscape(product.name)}</p>${list ? `<ul>${list}</ul>` : ''}<p>Please review all photos for the exact item you will receive. DJHC inventory ID: DJHC-${htmlEscape(product.id)}.</p>`;
}

function seoDescription(product = {}) {
  const details = [
    product.name,
    product.condition,
    product.team,
    product.category
  ].map((item) => cleanText(item)).filter(Boolean);
  return details.join(' | ').slice(0, 320);
}

const productsFile = JSON.parse(await fs.readFile(productsPath, 'utf8'));
const products = (Array.isArray(productsFile) ? productsFile : productsFile.products || [])
  .filter((product) => product?.isDeleted !== true)
  .sort((left, right) => Number(left.id) - Number(right.id));

const rows = [];
const review = [];
for (const product of products) {
  const quantity = quantityFor(product);
  const price = Number(product.price);
  const images = productImages(product);
  const weight = suggestedWeight(product);
  const handle = `djhc-${product.id}`;
  const sku = `DJHC-${product.id}`;
  const imageUrls = images.map(publicAssetUrl);
  const primaryRow = Object.fromEntries(headers.map((header) => [header, '']));

  Object.assign(primaryRow, {
    'URL handle': handle,
    Title: cleanText(product.name),
    Description: productDescription(product),
    Vendor: "DJ's House of Cards & Comics",
    Type: productType(product),
    Tags: productTags(product),
    'Published on online store': publish ? 'true' : 'false',
    Status: status,
    SKU: sku,
    'Option1 name': 'Default Title',
    'Option1 value': 'Default Title',
    Price: Number.isFinite(price) ? price.toFixed(2) : '',
    'Charge tax': 'true',
    'Inventory tracker': 'shopify',
    'Inventory quantity': quantity,
    'Continue selling when out of stock': 'deny',
    'Weight value (grams)': weight.grams,
    'Weight unit for display': 'g',
    'Requires shipping': 'true',
    'Fulfillment service': 'manual',
    'Product image URL': imageUrls[0] || '',
    'Image position': imageUrls.length ? 1 : '',
    'Image alt text': cleanText(product.name).slice(0, 125),
    'Variant image URL': imageUrls[0] || '',
    'Gift card': 'false',
    'SEO title': cleanText(product.name).slice(0, 70),
    'SEO description': seoDescription(product),
    'Google Shopping / Condition': /\bnew\b/i.test(product.condition || '') ? 'new' : 'used',
    Collection: cleanText(product.category)
  });
  rows.push(primaryRow);

  imageUrls.slice(1).forEach((imageUrl, index) => {
    const imageRow = Object.fromEntries(headers.map((header) => [header, '']));
    imageRow['URL handle'] = handle;
    imageRow['Product image URL'] = imageUrl;
    imageRow['Image position'] = index + 2;
    imageRow['Image alt text'] = cleanText(product.name).slice(0, 125);
    rows.push(imageRow);
  });

  review.push({
    productId: Number(product.id),
    sku,
    handle,
    title: cleanText(product.name),
    category: cleanText(product.category),
    source: isNonlegacy(product) ? 'Non-Legacy Workbook' : 'Legacy Site Catalog',
    price: Number.isFinite(price) ? price : null,
    quantity,
    imageCount: imageUrls.length,
    primaryImageUrl: imageUrls[0] || '',
    suggestedWeightGrams: weight.grams,
    weightBasis: weight.basis,
    weightNeedsReview: weight.needsReview,
    shopifyStatus: status,
    publishedOnOnlineStore: publish
  });
}

await fs.mkdir(outputDir, { recursive: true });
const csvPath = path.join(outputDir, `shopify-products-${status}.csv`);
const reviewPath = path.join(outputDir, 'shopify-product-review.json');
const summaryPath = path.join(outputDir, 'shopify-catalog-summary.json');
const csv = [
  headers.map(csvValue).join(','),
  ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(','))
].join('\n');
const summary = {
  generatedAt: new Date().toISOString(),
  source: 'products.json',
  siteUrl,
  status,
  publishedOnOnlineStore: publish,
  productCount: products.length,
  inventoryUnitCount: review.reduce((sum, item) => sum + item.quantity, 0),
  csvRowCount: rows.length,
  imageCount: review.reduce((sum, item) => sum + item.imageCount, 0),
  nonlegacyCount: review.filter((item) => item.source === 'Non-Legacy Workbook').length,
  legacyCount: review.filter((item) => item.source === 'Legacy Site Catalog').length,
  provisionalWeightCount: review.filter((item) => item.weightNeedsReview).length,
  productsWithoutImages: review.filter((item) => !item.primaryImageUrl).length,
  productsWithoutPrices: review.filter((item) => !Number.isFinite(item.price) || item.price <= 0).length,
  productsWithoutInventory: review.filter((item) => item.quantity <= 0).length
};

await Promise.all([
  fs.writeFile(csvPath, `${csv}\n`, 'utf8'),
  fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8'),
  fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
]);

console.log(JSON.stringify({
  ...summary,
  csvPath: path.relative(root, csvPath).replaceAll('\\', '/'),
  reviewPath: path.relative(root, reviewPath).replaceAll('\\', '/'),
  summaryPath: path.relative(root, summaryPath).replaceAll('\\', '/')
}, null, 2));
