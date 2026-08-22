import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const cleanJsonSources = process.argv.includes('--clean-json');
const optimizeSegmentJson = process.argv.includes('--optimize-segments');
const JSON_INDENT = 2;
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
const SEGMENTS = {
  'products-baseball.json': (product) => product.category === 'Baseball',
  'products-basketball.json': (product) => product.category === 'Basketball',
  'products-football.json': (product) => product.category === 'Football',
  'products-comics.json': (product) => product.category === 'Comics',
  'products-collectibles.json': (product) => product.category === 'Collectibles',
  'products-sports.json': (product) => ['Baseball', 'Basketball', 'Football'].includes(product.category),
  'products-featured.json': (product) => product.isFeatured === true
};

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
  'attributes', 'isFeatured', 'isDeleted', 'sortRank', 'hasThumbnail'
]);
const STOREFRONT_METADATA_FIELDS = new Set(['conditionNotes', 'playerAthlete']);
const STOREFRONT_EXCEL_FIELDS = new Set(['Title', 'C:Features', 'C:Autographed']);
const RETRYABLE_WRITE_CODES = new Set(['EACCES', 'EBUSY', 'EPERM', 'UNKNOWN']);
const THUMBNAIL_ELIGIBLE_ROOTS = new Set([
  'baseball-cards',
  'basketball-cards',
  'collectibles',
  'comics',
  'ebay listing photos',
  'personal collection',
  'football-cards'
]);

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

function normalizedAssetPath(reference = '') {
  // A card number commonly contains "#" in the actual filename, so only a
  // query string is removable here. Fragment handling belongs to real URLs,
  // not local asset filenames.
  return String(reference || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').split('?', 1)[0];
}

function thumbnailPathForAsset(reference = '') {
  const normalized = normalizedAssetPath(reference);
  if (!/^assets\//i.test(normalized) || /^assets\/thumbnails\//i.test(normalized)) {
    return '';
  }

  const relativePath = normalized.replace(/^assets\//i, '');
  const rootSegment = relativePath.split('/')[0]?.toLowerCase() || '';
  if (!THUMBNAIL_ELIGIBLE_ROOTS.has(rootSegment) || /\.svg$/i.test(relativePath)) {
    return '';
  }

  return `assets/thumbnails/${relativePath.replace(/\.[^.]+$/, '.webp')}`;
}

function hasGeneratedThumbnail(reference = '') {
  const thumbnailPath = thumbnailPathForAsset(reference);
  return Boolean(thumbnailPath && existsSync(path.join(root, thumbnailPath)));
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

  if (hasGeneratedThumbnail(out.image)) {
    out.hasThumbnail = true;
  } else {
    delete out.hasThumbnail;
  }

  return out;
}

function sortByStorefrontRank(items = []) {
  return [...items].sort((left, right) => {
    const leftRank = Number.isFinite(Number(left.sortRank)) ? Number(left.sortRank) : Number.MAX_SAFE_INTEGER;
    const rightRank = Number.isFinite(Number(right.sortRank)) ? Number(right.sortRank) : Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return Number(left.id || 0) - Number(right.id || 0);
  });
}

const canonicalProducts = JSON.parse(await fs.readFile(path.join(root, 'products.json'), 'utf8'));

function structuredJson(value) {
  return `${JSON.stringify(value, null, JSON_INDENT)}\n`;
}

for (const file of FILES) {
  const fullPath = path.join(root, file);
  // Derive every segment from products.json so one canonical catalog update
  // cannot leave stale category JSON or preloaded bundles behind.
  let raw = file === 'products.json'
    ? canonicalProducts
    : canonicalProducts.filter(SEGMENTS[file]);
  if (file === 'products-featured.json') {
    raw = sortByStorefrontRank(raw);
  }
  assertRangeCheckoutPrices(raw, file);
  const isFullCatalog = file === 'products.json';
  const activeRaw = Array.isArray(raw)
    ? raw.filter((item) => item?.isDeleted !== true)
    : [];
  const storefront = Array.isArray(raw)
    ? activeRaw.map((item) => pickStorefrontFields(item))
    : [];
  if (!isFullCatalog && (cleanJsonSources || optimizeSegmentJson)) {
    await writeTextFile(fullPath, structuredJson(storefront));
  }
  if (BOOTSTRAP_FILES[file]) {
    const bootstrap = {
      source: file,
      total: storefront.length,
      products: storefront.slice(0, BOOTSTRAP_PRODUCT_LIMIT)
    };
    await writeTextFile(path.join(root, BOOTSTRAP_FILES[file]), structuredJson(bootstrap));
  }
  if (BUNDLE_FILES[file]) {
    const bundle = [
      `window.DJ_PRELOADED_SOURCE = ${JSON.stringify(file)};`,
      `window.DJ_PRELOADED_PRODUCTS = ${JSON.stringify(storefront, null, JSON_INDENT)};`,
      ''
    ].join('\n');
    await writeTextFile(path.join(root, BUNDLE_FILES[file]), bundle);
  }
  const action = !isFullCatalog && (cleanJsonSources || optimizeSegmentJson)
    ? 'Optimized and bundled'
    : 'Bundled';
  console.log(`${action} ${file} (${storefront.length} rows)`);
}
