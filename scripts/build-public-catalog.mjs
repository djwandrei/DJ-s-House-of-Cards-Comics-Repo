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
const RANGE_PATTERN = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|\bto\b)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i;

const BOOTSTRAP_FILES = {
  'products-baseball.json': 'products-bootstrap-baseball.json',
  'products-basketball.json': 'products-bootstrap-basketball.json',
  'products-football.json': 'products-bootstrap-football.json',
  'products-comics.json': 'products-bootstrap-comics.json',
  'products-collectibles.json': 'products-bootstrap-collectibles.json'
};
const BOOTSTRAP_PRODUCT_LIMIT = 48;

// Category pages only need buyer-facing fields plus a small metadata subset
// used to derive storefront badges. The canonical products.json source is never
// rewritten here so admin tools and Supabase sync retain import bookkeeping.
const STOREFRONT_FIELDS = new Set([
  'id', 'name', 'category', 'team', 'year', 'condition', 'price', 'priceLabel',
  'displayPrice', 'image', 'imageGallery', 'description', 'photoHostPageUrl',
  'legacyImageLabel', 'sourcePage', 'league', 'sport', 'playerAthlete', 'copyCount',
  'attributes', 'isFeatured', 'isDeleted', 'sortRank'
]);
const STOREFRONT_METADATA_FIELDS = new Set(['conditionNotes', 'playerAthlete']);
const STOREFRONT_EXCEL_FIELDS = new Set(['Title', 'C:Features', 'C:Autographed']);
const RETRYABLE_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM', 'UNKNOWN']);

async function writeTextFile(fullPath, content, attempts = 6) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await fs.writeFile(fullPath, content, 'utf8');
      return;
    } catch (error) {
      if (!RETRYABLE_WRITE_CODES.has(error?.code) || attempt === attempts) throw error;
      // Windows can briefly lock a large bundle while a browser or sync client reads it.
      await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }
}

function rangeHigh(item = {}) {
  for (const candidate of [item.priceLabel, item.displayPrice]) {
    const match = String(candidate || '').match(RANGE_PATTERN);
    if (!match) continue;
    const high = Number(match[2].replaceAll(',', ''));
    if (Number.isFinite(high) && high > 0) return Math.round(high * 100) / 100;
  }
  return null;
}

function assertRangeCheckoutPrices(items, file) {
  const incorrect = items.filter((item) => {
    const high = rangeHigh(item);
    return high != null && Math.abs(Number(item.price) - high) >= 0.001;
  });
  if (incorrect.length) {
    throw new Error(
      `${file} has ${incorrect.length} ranged listings without the high checkout price. `
      + 'Run scripts/normalize-range-checkout-prices.mjs before rebuilding.'
    );
  }
}

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

function pickStorefrontFields(item) {
  const out = {};
  for (const key of STOREFRONT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      out[key] = item[key];
    }
  }

  const metadata = pickStorefrontMetadata(item.metadata);
  if (metadata) {
    out.metadata = metadata;
  }

  return out;
}

for (const file of FILES) {
  const fullPath = path.join(root, file);
  const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  assertRangeCheckoutPrices(raw, file);
  const isFullCatalog = file === 'products.json';
  const storefront = Array.isArray(raw)
    ? raw.map((item) => pickStorefrontFields(item))
    : [];
  if (!isFullCatalog && (cleanJsonSources || optimizeSegmentJson)) {
    await writeTextFile(fullPath, `${JSON.stringify(storefront)}\n`);
  }
  if (BOOTSTRAP_FILES[file]) {
    const bootstrap = {
      source: file,
      total: storefront.length,
      products: storefront.slice(0, BOOTSTRAP_PRODUCT_LIMIT)
    };
    await writeTextFile(path.join(root, BOOTSTRAP_FILES[file]), `${JSON.stringify(bootstrap)}\n`);
  }
  if (BUNDLE_FILES[file]) {
    const bundle = [
      `window.DJ_PRELOADED_SOURCE = ${JSON.stringify(file)};`,
      `window.DJ_PRELOADED_PRODUCTS = ${JSON.stringify(storefront)};`,
      ''
    ].join('\n');
    await writeTextFile(path.join(root, BUNDLE_FILES[file]), bundle);
  }
  const action = !isFullCatalog && (cleanJsonSources || optimizeSegmentJson)
    ? 'Optimized and bundled'
    : 'Bundled';
  console.log(`${action} ${file} (${storefront.length} rows)`);
}
