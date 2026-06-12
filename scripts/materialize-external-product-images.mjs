import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const applyChanges = process.argv.includes('--apply');
const productsPath = path.join(root, 'products.json');
const outputPath = path.join(root, 'outputs', 'external-product-image-materialization.json');
const products = JSON.parse(await fs.readFile(productsPath, 'utf8'));

const SEGMENTS = {
  'products-baseball.json': (product) => product.category === 'Baseball',
  'products-basketball.json': (product) => product.category === 'Basketball',
  'products-football.json': (product) => product.category === 'Football',
  'products-comics.json': (product) => product.category === 'Comics',
  'products-collectibles.json': (product) => product.category === 'Collectibles',
  'products-sports.json': (product) => ['Baseball', 'Basketball', 'Football'].includes(product.category),
  'products-featured.json': (product) => product.isFeatured === true
};

function isExternal(value = '') {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function isNonlegacy(product = {}) {
  return Boolean(product.metadata?.excelFields && typeof product.metadata.excelFields === 'object');
}

function extensionFor(url = '') {
  const match = new URL(url).pathname.match(/\.(avif|gif|jpe?g|png|webp)$/i);
  return match ? `.${match[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

function categoryFolder(category = 'other') {
  return String(category || 'other').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'other';
}

function externalPhotos(product = {}) {
  const candidates = Array.isArray(product.itemPhotoUrls) && product.itemPhotoUrls.length
    ? product.itemPhotoUrls
    : Array.isArray(product.imageGallery) && product.imageGallery.length
      ? product.imageGallery
      : [product.image];
  return [...new Set(candidates.map((item) => String(item || '').trim()).filter(isExternal))];
}

async function writeCatalogFiles(items) {
  await fs.writeFile(productsPath, `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  const active = items.filter((product) => product?.isDeleted !== true);
  for (const [filename, predicate] of Object.entries(SEGMENTS)) {
    await fs.writeFile(
      path.join(root, filename),
      `${JSON.stringify(active.filter(predicate), null, 2)}\n`,
      'utf8'
    );
  }
}

const targets = products.filter((product) => (
  isNonlegacy(product)
  && product.isDeleted !== true
  && isExternal(product.image)
));
const report = {
  generatedAt: new Date().toISOString(),
  applied: applyChanges,
  targetProductCount: targets.length,
  products: []
};

for (const product of targets) {
  const photos = externalPhotos(product);
  const localPhotos = photos.map((url, index) => (
    `assets/hosted-listing-images/${categoryFolder(product.category)}/${product.id}-${String(index + 1).padStart(2, '0')}${extensionFor(url)}`
  ));
  const record = {
    id: Number(product.id),
    name: product.name,
    externalPhotos: photos,
    localPhotos
  };
  report.products.push(record);
  if (!applyChanges) continue;
  if (!photos.length) {
    throw new Error(`Product ${product.id} has no external photo URLs to materialize.`);
  }

  for (let index = 0; index < photos.length; index += 1) {
    const targetPath = path.join(root, localPhotos[index]);
    try {
      await fs.access(targetPath);
      continue;
    } catch {
      // Download only when the target is not already present.
    }
    const response = await fetch(photos[index], {
      headers: { 'User-Agent': 'Mozilla/5.0 DJHouseOfCardsAssetSync/1.0' }
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!response.ok || !contentType.startsWith('image/')) {
      throw new Error(`Image download failed for product ${product.id}: HTTP ${response.status} ${contentType}`);
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from(await response.arrayBuffer()));
  }

  product.image = localPhotos[0];
  product.imageGallery = localPhotos;
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
if (applyChanges) {
  await writeCatalogFiles(products);
}

console.log(JSON.stringify({
  applied: applyChanges,
  targetProductCount: report.targetProductCount,
  targetPhotoCount: report.products.reduce((total, item) => total + item.localPhotos.length, 0)
}, null, 2));
