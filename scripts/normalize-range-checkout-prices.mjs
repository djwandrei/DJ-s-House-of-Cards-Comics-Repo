import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const apply = process.argv.includes('--apply');
const check = process.argv.includes('--check');
if (apply && check) throw new Error('Choose either --apply or --check, not both.');
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
const RANGE_PATTERN = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|\bto\b)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i;

function rangeHigh(item = {}) {
  for (const candidate of [item.priceLabel, item.displayPrice]) {
    const match = String(candidate || '').match(RANGE_PATTERN);
    if (!match) continue;
    const high = Number(match[2].replaceAll(',', ''));
    if (Number.isFinite(high) && high > 0) return Math.round(high * 100) / 100;
  }
  return null;
}

let incorrectCount = 0;
let rangedCount = 0;

for (const file of FILES) {
  const fullPath = path.join(root, file);
  const products = JSON.parse(await fs.readFile(fullPath, 'utf8'));
  let fileIncorrect = 0;
  let fileRanged = 0;

  for (const product of products) {
    const high = rangeHigh(product);
    if (high == null) continue;
    fileRanged += 1;
    if (Math.abs(Number(product.price) - high) < 0.001) continue;
    fileIncorrect += 1;
    if (apply) product.price = high;
  }

  if (apply && fileIncorrect) {
    await fs.writeFile(fullPath, `${JSON.stringify(products, null, 2)}\n`, 'utf8');
  }

  incorrectCount += fileIncorrect;
  rangedCount += fileRanged;
  console.log(`${file}: ${fileRanged} ranged listings, ${fileIncorrect} ${apply ? 'normalized' : 'would change'}`);
}

console.log(`${apply ? 'Normalized' : 'Audited'} ${rangedCount} ranged listings across ${FILES.length} catalog files.`);
if (check && incorrectCount) {
  throw new Error(`${incorrectCount} of ${rangedCount} ranged listings do not use the high price.`);
}
if (!apply && incorrectCount) {
  console.log(`Audit only: ${incorrectCount} listing prices would change. Re-run with --apply to write them.`);
}
