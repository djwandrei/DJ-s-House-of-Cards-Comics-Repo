import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const productsPath = path.join(root, 'products.json');
const outputPath = path.join(root, 'outputs', 'product-asset-title-audit.json');

const CATEGORY_FOLDERS = {
  Baseball: 'assets/baseball-cards',
  Basketball: 'assets/basketball-cards',
  Football: 'assets/football-cards',
  Comics: 'assets/comics',
  Collectibles: 'assets/collectibles',
  Other: 'assets/collectibles'
};
const LOCAL_IMAGE_RE = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const REMOTE_RE = /^(?:https?:|data:|blob:)/i;

function normalizeAssetPath(value = '') {
  const raw = String(value || '').trim().replaceAll('\\', '/').split('?', 1)[0];
  if (!raw || REMOTE_RE.test(raw)) return '';
  const index = raw.toLowerCase().indexOf('assets/');
  return index >= 0 ? raw.slice(index).replace(/^\/+/, '') : '';
}

function comparableText(value = '') {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/(\d+)\s*\/\s*(\d+)/g, '$1$2')
    .replace(/&/g, ' and ')
    .replace(/['\u2019`]/g, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function stripOneGallerySuffix(stem = '') {
  return String(stem || '')
    .trim()
    .replace(/\s*[-_]\s*(?:front|back|obverse|reverse|main|primary)\s*$/i, '')
    .replace(/\s*[-_]\s*(?:photo|image|img|scan)\s*\d{1,3}\s*$/i, '')
    .replace(/\s*[-_]\s*\d{1,3}\s*$/i, '')
    .replace(/\s*\(\s*(?:front|back|obverse|reverse|main|primary|\d{1,3})\s*\)\s*$/i, '')
    .trim();
}

function stemComparables(stem = '') {
  return [...new Set([
    comparableText(stem),
    comparableText(stripOneGallerySuffix(stem))
  ].filter(Boolean))];
}

function hasBackOnlySuffix(stem = '') {
  return /\s*(?:[-_]\s*|\(\s*)(?:back|reverse)\s*\)?$/i.test(String(stem || '').trim());
}

function safeAssetStem(title = '') {
  return String(title || 'product-photo')
    .replace(/[\\/]+/g, ' - ')
    .replace(/[<>:"|?*\u0000-\u001F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160) || 'product-photo';
}

function expectedFolder(product) {
  return CATEGORY_FOLDERS[product.category] || CATEGORY_FOLDERS.Other;
}

async function exists(relativePath) {
  try {
    await fs.access(path.join(root, relativePath));
    return true;
  } catch {
    return false;
  }
}

const products = JSON.parse(await fs.readFile(productsPath, 'utf8'));
const productsByAsset = new Map();
const missingAssets = [];
const folderMismatches = [];
const titleMismatches = [];
const mainImageBacks = [];
const remoteAssets = [];

for (const product of products) {
  const refs = [
    { field: 'image', value: product.image, galleryIndex: null },
    ...(Array.isArray(product.imageGallery)
      ? product.imageGallery.map((value, index) => ({ field: 'imageGallery', value, galleryIndex: index }))
      : [])
  ];
  const titleComparable = comparableText(product.name);
  const expectedBase = safeAssetStem(product.name);
  const expectedDirectory = expectedFolder(product);

  for (const ref of refs) {
    const raw = String(ref.value || '').trim();
    if (REMOTE_RE.test(raw)) {
      remoteAssets.push({ id: product.id, title: product.name, field: ref.field, asset: raw });
      continue;
    }

    const asset = normalizeAssetPath(raw);
    if (!asset || !LOCAL_IMAGE_RE.test(asset)) continue;
    const owners = productsByAsset.get(asset) || [];
    owners.push(Number(product.id));
    productsByAsset.set(asset, owners);

    if (!await exists(asset)) {
      missingAssets.push({ id: product.id, title: product.name, field: ref.field, asset });
      continue;
    }

    const assetDirectory = path.dirname(asset).replaceAll('\\', '/');
    if (!assetDirectory.startsWith(expectedDirectory)) {
      folderMismatches.push({
        id: product.id,
        title: product.name,
        category: product.category,
        field: ref.field,
        asset,
        expectedDirectory
      });
    }

    const parsed = path.parse(asset);
    const titleMatches = stemComparables(parsed.name).some((stemComparable) => (
      stemComparable === titleComparable || stemComparable.startsWith(`${titleComparable} `)
    ));
    if (!titleMatches) {
      titleMismatches.push({
        id: product.id,
        title: product.name,
        field: ref.field,
        asset,
        filenameStem: parsed.name,
        expectedStem: expectedBase
      });
    }

    if (ref.field === 'image' && hasBackOnlySuffix(parsed.name)) {
      mainImageBacks.push({ id: product.id, title: product.name, asset });
    }
  }
}

const sharedAssets = [...productsByAsset.entries()]
  .map(([asset, owners]) => ({ asset, productIds: [...new Set(owners)].sort((a, b) => a - b) }))
  .filter((item) => item.productIds.length > 1);

const report = {
  generatedAt: new Date().toISOString(),
  productCount: products.length,
  referencedLocalAssetCount: productsByAsset.size,
  missingAssetCount: missingAssets.length,
  folderMismatchCount: folderMismatches.length,
  titleMismatchCount: titleMismatches.length,
  mainImageBackCount: mainImageBacks.length,
  remoteAssetCount: remoteAssets.length,
  sharedAssetCount: sharedAssets.length,
  missingAssets,
  folderMismatches,
  titleMismatches,
  mainImageBacks,
  remoteAssets,
  sharedAssets
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  productCount: report.productCount,
  referencedLocalAssetCount: report.referencedLocalAssetCount,
  missingAssetCount: report.missingAssetCount,
  folderMismatchCount: report.folderMismatchCount,
  titleMismatchCount: report.titleMismatchCount,
  mainImageBackCount: report.mainImageBackCount,
  remoteAssetCount: report.remoteAssetCount,
  sharedAssetCount: report.sharedAssetCount,
  outputPath: path.relative(root, outputPath).replaceAll('\\', '/')
}, null, 2));
