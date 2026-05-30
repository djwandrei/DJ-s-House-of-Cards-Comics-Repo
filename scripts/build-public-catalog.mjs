import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
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

const PUBLIC_FIELDS = [
  'id', 'name', 'category', 'team', 'year', 'condition', 'price', 'priceLabel',
  'image', 'imageGallery', 'description', 'photoHostPageUrl', 'legacyImageLabel',
  'sourcePage', 'league', 'sport', 'playerAthlete', 'isFeatured', 'isDeleted', 'sortRank'
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
  await fs.writeFile(fullPath, JSON.stringify(cleaned), 'utf8');
  console.log(`Rebuilt ${file} (${cleaned.length} rows)`);
}
