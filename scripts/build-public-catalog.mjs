import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const cleanJsonSources = process.argv.includes('--clean-json');
const optimizeSegmentJson = process.argv.includes('--optimize-segments');
const FILES = [
  'products.json',
  'products-baseball.json',
  'products-basketball.json',
  'products-football.json',
  'products-comics.json',
  'products-collectibles.json',
  'products-sports.json',
  'products-featured.json'
];

const BUNDLE_FILES = {
  'products.json': 'products-data-full.js',
  'products-baseball.json': 'products-data-baseball.js',
  'products-basketball.json': 'products-data-basketball.js',
  'products-football.json': 'products-data-football.js',
  'products-comics.json': 'products-data-comics.js',
  'products-collectibles.json': 'products-data-collectibles.js',
  'products-sports.json': 'products-data-sports.js',
  'products-featured.json': 'products-data-featured.js'
};

const PUBLIC_FIELDS = [
  'id', 'name', 'category', 'team', 'year', 'condition', 'price', 'priceLabel',
  'displayPrice', 'image', 'imageGallery', 'description', 'photoHostPageUrl',
  'legacyImageLabel', 'sourcePage', 'league', 'sport', 'playerAthlete', 'copyCount',
  'itemPhotoUrl', 'itemPhotoUrls', 'htmlFullLink', 'htmlImageUrls', 'metadata',
  'isFeatured', 'isDeleted', 'sortRank'
];
const PUBLIC_FIELD_SET = new Set(PUBLIC_FIELDS);

// Category pages only need buyer-facing fields plus a small metadata subset
// used to derive storefront badges. The full products.json source remains
// untouched so admin tools and Supabase sync retain their import bookkeeping.
const STOREFRONT_FIELDS = new Set([
  'id', 'name', 'category', 'team', 'year', 'condition', 'price', 'priceLabel',
  'displayPrice', 'image', 'imageGallery', 'description', 'photoHostPageUrl',
  'legacyImageLabel', 'sourcePage', 'league', 'sport', 'playerAthlete', 'copyCount',
  'isFeatured', 'isDeleted', 'sortRank'
]);
const STOREFRONT_METADATA_FIELDS = new Set(['conditionNotes', 'playerAthlete']);
const STOREFRONT_EXCEL_FIELDS = new Set(['Title', 'C:Features', 'C:Autographed']);

function pickStorefrontMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return undefined;
  }

  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (STOREFRONT_METADATA_FIELDS.has(key)) {
      out[key] = value;
    }
  }

  if (metadata.excelFields && typeof metadata.excelFields === 'object') {
    const excelFields = {};
    for (const [key, value] of Object.entries(metadata.excelFields)) {
      if (STOREFRONT_EXCEL_FIELDS.has(key) && value != null && value !== '') {
        excelFields[key] = value;
      }
    }
    if (Object.keys(excelFields).length) {
      out.excelFields = excelFields;
    }
  }

  return Object.keys(out).length ? out : undefined;
}

function pickPublicFields(item, options = {}) {
  const fields = options.storefront ? STOREFRONT_FIELDS : PUBLIC_FIELD_SET;
  const out = {};
  for (const key of fields) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      out[key] = item[key];
    }
  }

  if (options.storefront) {
    const metadata = pickStorefrontMetadata(item.metadata);
    if (metadata) {
      out.metadata = metadata;
    }
  }

  return out;
}

for (const file of FILES) {
  const fullPath = path.join(root, file);
  const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  const isFullCatalog = file === 'products.json';
  const cleaned = Array.isArray(raw)
    ? raw.map((item) => pickPublicFields(item, { storefront: !isFullCatalog }))
    : [];
  if (cleanJsonSources || (optimizeSegmentJson && !isFullCatalog)) {
    await fs.writeFile(fullPath, `${JSON.stringify(cleaned, null, 2)}\n`, 'utf8');
  }
  if (BUNDLE_FILES[file]) {
    const bundle = [
      `window.DJ_PRELOADED_SOURCE = ${JSON.stringify(file)};`,
      `window.DJ_PRELOADED_PRODUCTS = ${JSON.stringify(cleaned)};`,
      ''
    ].join('\n');
    await fs.writeFile(path.join(root, BUNDLE_FILES[file]), bundle, 'utf8');
  }
  const action = cleanJsonSources || (optimizeSegmentJson && !isFullCatalog)
    ? 'Optimized and bundled'
    : 'Bundled';
  console.log(`${action} ${file} (${cleaned.length} rows)`);
}
