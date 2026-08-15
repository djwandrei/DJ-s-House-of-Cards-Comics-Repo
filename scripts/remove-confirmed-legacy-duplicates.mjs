import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.cwd();
const applyChanges = process.argv.includes('--apply');
const productsPath = path.join(root, 'products.json');
const outputPath = path.join(root, 'outputs', 'confirmed-legacy-duplicates.json');
const products = JSON.parse(await fs.readFile(productsPath, 'utf8'));
const execFileAsync = promisify(execFile);

function normalize(value = '') {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isLegacy(product = {}) {
  return !(product.metadata?.excelFields && typeof product.metadata.excelFields === 'object');
}

function sourceLabel(product = {}) {
  return product.metadata?.sourceWorkbook || product.metadata?.cardsAddWorkbook || product.sourcePage || '';
}

function mediaKey(product = {}) {
  const gallery = Array.isArray(product.imageGallery) ? [...product.imageGallery].sort() : [];
  return JSON.stringify([normalize(product.name), product.image || '', gallery]);
}

const groups = new Map();
for (const product of products.filter((item) => item?.isDeleted !== true && isLegacy(item))) {
  const key = mediaKey(product);
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(product);
}

const confirmedGroups = [...groups.values()]
  .filter((group) => (
    group.length > 1
    && group.every((product) => product.category === group[0].category && product.year === group[0].year)
    && group.some((product) => /cards to remove/i.test(sourceLabel(product)))
  ))
  .map((group) => {
    const sorted = [...group].sort((left, right) => Number(left.id) - Number(right.id));
    const keep = sorted.at(-1);
    return {
      name: keep.name,
      image: keep.image,
      keepId: Number(keep.id),
      removeIds: sorted.slice(0, -1).map((product) => Number(product.id)),
      sources: sorted.map((product) => ({ id: Number(product.id), source: sourceLabel(product) }))
    };
  });

const removeIds = new Set(confirmedGroups.flatMap((group) => group.removeIds));
const permanentlyDeletedIds = products
  .filter((product) => product?.isDeleted === true)
  .map((product) => Number(product.id))
  .filter(Number.isFinite);
const allRemoveIds = new Set([...removeIds, ...permanentlyDeletedIds]);
const report = {
  generatedAt: new Date().toISOString(),
  applied: applyChanges,
  confirmedGroupCount: confirmedGroups.length,
  removedProductCount: removeIds.size,
  removedProductIds: [...removeIds].sort((left, right) => left - right),
  permanentlyDeletedProductCount: permanentlyDeletedIds.length,
  permanentlyDeletedProductIds: permanentlyDeletedIds.sort((left, right) => left - right),
  totalHardDeleteCount: allRemoveIds.size,
  totalHardDeleteIds: [...allRemoveIds].sort((left, right) => left - right),
  groups: confirmedGroups
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

if (applyChanges) {
  const finalProducts = products.filter((product) => !allRemoveIds.has(Number(product.id)));
  await fs.writeFile(productsPath, `${JSON.stringify(finalProducts, null, 2)}\n`, 'utf8');
  await execFileAsync(
    process.execPath,
    [path.join(root, 'scripts', 'build-public-catalog.mjs'), '--optimize-segments'],
    { cwd: root, maxBuffer: 16 * 1024 * 1024 }
  );
}

console.log(JSON.stringify({
  applied: applyChanges,
  confirmedGroupCount: confirmedGroups.length,
  removedProductCount: removeIds.size,
  removedProductIds: report.removedProductIds,
  permanentlyDeletedProductCount: report.permanentlyDeletedProductCount,
  permanentlyDeletedProductIds: report.permanentlyDeletedProductIds,
  totalHardDeleteCount: report.totalHardDeleteCount,
  totalHardDeleteIds: report.totalHardDeleteIds
}, null, 2));
