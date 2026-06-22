import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const productsPath = path.join(root, 'products.json');
const outputDir = path.join(root, 'outputs', 'marketplace-sync');
const publicFeedDir = path.join(root, 'feeds');
const siteUrl = 'https://www.djshouseofcards-comics.com/';
const includeDrafts = process.argv.includes('--include-drafts');

const categoryRoutes = new Map([
  ['Baseball', 'baseball-cards.html'],
  ['Basketball', 'basketball-cards.html'],
  ['Football', 'football-cards.html'],
  ['Comics', 'comics.html'],
  ['Collectibles', 'collectibles.html']
]);

const headers = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'mpn',
  'inventory',
  'google_product_category',
  'product_type',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4'
];

function csvValue(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
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

function productUrl(product = {}) {
  const category = cleanText(product.category);
  const route = categoryRoutes.get(category);
  if (!route) {
    throw new Error(
      `Product ${product.id || '(unknown id)'} has no Facebook deep-link route for category "${category || '(blank)'}". `
      + 'Add a category route or make shop.html catalog-aware before generating item links.'
    );
  }
  return new URL(`${route}?item=${encodeURIComponent(product.id)}`, siteUrl).href;
}

function quantityFor(product = {}) {
  const quantity = Number(product.quantityAvailable ?? product.copyCount ?? 1);
  return Number.isFinite(quantity) ? Math.max(0, Math.floor(quantity)) : 1;
}

function isNonlegacy(product = {}) {
  return Boolean(product.metadata?.excelFields && typeof product.metadata.excelFields === 'object');
}

function productImages(product = {}) {
  const candidates = [
    product.image,
    ...(Array.isArray(product.imageGallery) ? product.imageGallery : [])
  ];
  return [...new Set(candidates.map((item) => String(item || '').trim()).filter(Boolean))]
    .filter((item) => /^assets\//i.test(item))
    .filter((item) => !/assets\/placeholder-/i.test(item));
}

function productType(product = {}) {
  const category = cleanText(product.category);
  if (['Baseball', 'Basketball', 'Football'].includes(category)) {
    return `${category} Cards`;
  }
  return category || 'Collectibles';
}

function googleProductCategory(product = {}) {
  const category = cleanText(product.category);
  if (category === 'Comics') return 'Arts & Entertainment > Hobbies & Creative Arts > Collectibles';
  if (category === 'Collectibles') return 'Arts & Entertainment > Hobbies & Creative Arts > Collectibles';
  return 'Arts & Entertainment > Hobbies & Creative Arts > Collectibles';
}

function productBrand(product = {}) {
  const metadata = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  return cleanText(
    metadata.manufacturer
    || metadata.publisher
    || product.publisher
    || product.setName
    || "DJ's House of Cards & Comics"
  );
}

function fieldList(items = [], limit = 4) {
  return [...new Set(items
    .map((item) => cleanText(item).replace(/\s*\|\s*/g, ' | '))
    .filter(Boolean))]
    .slice(0, limit)
    .join(' | ');
}

function readablePriceBand(price) {
  if (!Number.isFinite(price)) return '';
  if (price < 10) return 'Under $10';
  if (price < 25) return '$10-$24.99';
  if (price < 50) return '$25-$49.99';
  if (price < 100) return '$50-$99.99';
  return '$100+';
}

function productDescription(product = {}) {
  const supplied = cleanText(product.description);
  const facts = fieldList([
    product.year ? `Year: ${product.year}` : '',
    product.category ? `Category: ${product.category}` : '',
    product.sport ? `Sport: ${product.sport}` : '',
    product.league ? `League: ${product.league}` : '',
    product.playerAthlete ? `Player/Athlete: ${product.playerAthlete}` : '',
    product.team ? `Team: ${product.team}` : '',
    product.condition ? `Condition: ${product.condition}` : ''
  ], 7);
  const galleryCount = productImages(product).length;

  if (supplied) {
    const hasInlineDetails = /\bDetails:/i.test(supplied);
    return [
      supplied,
      !hasInlineDetails && facts ? `Listing details: ${facts}.` : '',
      galleryCount > 1 ? `${galleryCount} product photos are included for review.` : 'Review the product photo before purchase.',
      `DJHC inventory ID: DJHC-${product.id}.`
    ].filter(Boolean).join(' ').slice(0, 4999);
  }

  const details = [
    product.name,
    product.year ? `Year: ${product.year}` : '',
    product.category ? `Category: ${product.category}` : '',
    product.sport ? `Sport: ${product.sport}` : '',
    product.league ? `League: ${product.league}` : '',
    product.playerAthlete ? `Player/Athlete: ${product.playerAthlete}` : '',
    product.team ? `Team: ${product.team}` : '',
    product.condition ? `Condition: ${product.condition}` : '',
    'Review photos and listing details before purchase.'
  ].map(cleanText).filter(Boolean);

  return details.join(' | ').slice(0, 4999);
}

function marketplaceLabel(product = {}) {
  return fieldList([
    product.sport,
    product.league,
    product.team,
    product.year
  ], 3);
}

const productsFile = JSON.parse(await fs.readFile(productsPath, 'utf8'));
const products = (Array.isArray(productsFile) ? productsFile : productsFile.products || [])
  .filter((product) => product?.isDeleted !== true)
  .sort((left, right) => Number(left.id) - Number(right.id));

const rows = [];
const review = [];
for (const product of products) {
  const source = isNonlegacy(product) ? 'Non-Legacy Workbook' : 'Legacy Site Catalog';
  const price = Number(product.price);
  const quantity = quantityFor(product);
  const images = productImages(product);
  const eligible = (
    includeDrafts
    || (
      source === 'Non-Legacy Workbook'
      && Number.isFinite(price)
      && price > 0
      && quantity > 0
      && images.length > 0
    )
  );

  review.push({
    productId: Number(product.id),
    sku: `DJHC-${product.id}`,
    title: cleanText(product.name),
    category: cleanText(product.category),
    source,
    eligible,
    price: Number.isFinite(price) ? price : null,
    quantity,
    imageCount: images.length,
    primaryImageUrl: images[0] ? publicAssetUrl(images[0]) : '',
    link: productUrl(product),
    reason: eligible
      ? ''
      : [
        source !== 'Non-Legacy Workbook' ? 'legacy_draft_gated' : '',
        !Number.isFinite(price) || price <= 0 ? 'missing_price' : '',
        quantity <= 0 ? 'out_of_stock' : '',
        images.length === 0 ? 'missing_real_image' : ''
      ].filter(Boolean).join('|')
  });

  if (!eligible) continue;

  rows.push({
    id: `DJHC-${product.id}`,
    title: cleanText(product.name).slice(0, 150),
    description: productDescription(product),
    availability: quantity > 0 ? 'in stock' : 'out of stock',
    condition: 'used',
    price: `${price.toFixed(2)} USD`,
    link: productUrl(product),
    image_link: publicAssetUrl(images[0]),
    additional_image_link: images[1] ? publicAssetUrl(images[1]) : '',
    brand: productBrand(product).slice(0, 100),
    mpn: `DJHC-${product.id}`,
    inventory: quantity,
    google_product_category: googleProductCategory(product),
    product_type: productType(product),
    custom_label_0: source,
    custom_label_1: cleanText(product.category),
    custom_label_2: cleanText(product.attributes?.[0] || product.condition || ''),
    custom_label_3: readablePriceBand(price),
    custom_label_4: marketplaceLabel(product)
  });
}

await Promise.all([
  fs.mkdir(outputDir, { recursive: true }),
  fs.mkdir(publicFeedDir, { recursive: true })
]);
const csvPath = path.join(outputDir, 'facebook-products.csv');
const publicCsvPath = path.join(publicFeedDir, 'facebook-products.csv');
const reviewPath = path.join(outputDir, 'facebook-product-review.json');
const summaryPath = path.join(outputDir, 'facebook-catalog-summary.json');
const csv = [
  headers.map(csvValue).join(','),
  ...rows.map((row) => headers.map((header) => csvValue(row[header])).join(','))
].join('\n');

const ineligible = review.filter((item) => !item.eligible);
const summary = {
  generatedAt: new Date().toISOString(),
  source: 'products.json',
  siteUrl,
  mode: includeDrafts ? 'include-drafts' : 'facebook-ready',
  productCount: products.length,
  feedProductCount: rows.length,
  nonlegacyCount: review.filter((item) => item.source === 'Non-Legacy Workbook').length,
  legacyCount: review.filter((item) => item.source === 'Legacy Site Catalog').length,
  ineligibleCount: ineligible.length,
  ineligibleReasonCounts: ineligible.reduce((counts, item) => {
    for (const reason of String(item.reason || 'unknown').split('|').filter(Boolean)) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
    return counts;
  }, {}),
  productsWithoutImages: review.filter((item) => item.imageCount === 0).length,
  productsWithoutPrices: review.filter((item) => !Number.isFinite(item.price) || item.price <= 0).length,
  productsWithoutInventory: review.filter((item) => item.quantity <= 0).length
};

await Promise.all([
  fs.writeFile(csvPath, `${csv}\n`, 'utf8'),
  fs.writeFile(publicCsvPath, `${csv}\n`, 'utf8'),
  fs.writeFile(reviewPath, `${JSON.stringify(review, null, 2)}\n`, 'utf8'),
  fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
]);

console.log(JSON.stringify({
  ...summary,
  csvPath: path.relative(root, csvPath).replaceAll('\\', '/'),
  publicCsvPath: path.relative(root, publicCsvPath).replaceAll('\\', '/'),
  reviewPath: path.relative(root, reviewPath).replaceAll('\\', '/'),
  summaryPath: path.relative(root, summaryPath).replaceAll('\\', '/')
}, null, 2));
