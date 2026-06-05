import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const cleanJsonSources = process.argv.includes('--clean-json');
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

function pickPublicFields(item) {
  const out = {};
  for (const key of PUBLIC_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, key)) {
      out[key] = item[key];
    }
  }
  return out;
}

for (const file of FILES) {
  const fullPath = path.join(root, file);
  const raw = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  const cleaned = Array.isArray(raw) ? raw.map(pickPublicFields) : [];
  if (cleanJsonSources) {
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
  console.log(`${cleanJsonSources ? 'Cleaned and bundled' : 'Bundled'} ${file} (${cleaned.length} rows)`);
}
