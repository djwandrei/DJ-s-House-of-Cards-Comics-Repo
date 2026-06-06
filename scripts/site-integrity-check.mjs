import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const HTML_FILES = fs.readdirSync(root).filter((file) => file.endsWith('.html')).sort();
const CATALOG_FILES = [
  'products.json',
  'products-baseball.json',
  'products-basketball.json',
  'products-football.json',
  'products-comics.json',
  'products-collectibles.json',
  'products-sports.json',
  'products-featured.json'
];
const MIRROR_FIELDS = [
  'name', 'category', 'team', 'year', 'condition', 'price',
  'priceLabel', 'displayPrice', 'image', 'imageGallery'
];
const CANONICAL_OPERATIONAL_FIELDS = ['itemPhotoUrls', 'htmlImageUrls'];
const WRONG_CONTACT_PATTERN = /djwandrei@gmail\.com|contact@djshouseofcards-comics\.com/i;
const RANGE_PATTERN = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|\u2013|\u2014|\bto\b)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i;
const issues = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function tagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

function localPathFromReference(reference, currentFile) {
  if (!reference || /^(?:https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(reference)) return null;
  const exactLocalPath = reference.replace(/^\//, '');
  if (exists(exactLocalPath)) return exactLocalPath;
  const [withoutHash] = reference.split('#');
  const [withoutQuery] = withoutHash.split('?');
  if (!withoutQuery) return currentFile;
  return withoutQuery.replace(/^\//, '');
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

const core = read('core.js');
const assetVersion = core.match(/PRODUCT_ASSET_VERSION\s*=\s*'([^']+)'/)?.[1] || '';
if (!assetVersion) issues.push({ file: 'core.js', type: 'missing product asset version' });

for (const file of HTML_FILES) {
  const html = read(file);
  const tags = [...html.matchAll(/<(?:meta|link|script|img|a)\b[^>]*>/gi)].map((match) => match[0]);
  const ids = [...html.matchAll(/\bid=(["'])(.*?)\1/gi)].map((match) => match[2]);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  const imagePreloads = tags
    .map(tagAttributes)
    .filter((attributes) => attributes.rel === 'preload' && attributes.as === 'image');

  if (duplicateIds.length) issues.push({ file, type: 'duplicate ids', values: duplicateIds });
  if ((html.match(/<h1\b/gi) || []).length !== 1) issues.push({ file, type: 'expected exactly one h1' });
  if (imagePreloads.length > 2) issues.push({ file, type: 'too many image preloads', count: imagePreloads.length });
  if (WRONG_CONTACT_PATTERN.test(html)) issues.push({ file, type: 'wrong public contact email' });

  const meta = tags.map(tagAttributes);
  const description = meta.find((attributes) => attributes.name?.toLowerCase() === 'description')?.content;
  const viewport = meta.find((attributes) => attributes.name?.toLowerCase() === 'viewport')?.content;
  const canonical = meta.find((attributes) => attributes.rel?.toLowerCase() === 'canonical')?.href;
  if (!description) issues.push({ file, type: 'missing meta description' });
  if (!viewport) issues.push({ file, type: 'missing viewport meta' });
  if (file !== 'offline.html' && !canonical) issues.push({ file, type: 'missing canonical link' });

  for (const tag of tags) {
    const attributes = tagAttributes(tag);
    for (const attribute of ['href', 'src']) {
      const reference = attributes[attribute];
      const localPath = localPathFromReference(reference, file);
      if (localPath && !exists(localPath)) {
        issues.push({ file, type: 'missing local reference', value: reference });
      }
    }
  }

  for (const match of html.matchAll(/href=(["'])(.*?)\1/gi)) {
    const reference = match[2];
    const hashIndex = reference.indexOf('#');
    if (hashIndex < 0) continue;
    const anchor = reference.slice(hashIndex + 1);
    if (!anchor) continue;
    const targetFile = localPathFromReference(reference, file);
    if (!targetFile || !exists(targetFile)) continue;
    const target = read(targetFile);
    const escapedAnchor = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`(?:id|name)=(["'])${escapedAnchor}\\1`, 'i').test(target)) {
      issues.push({ file, type: 'missing local anchor', value: reference });
    }
  }

  for (const match of html.matchAll(/<script[^>]+type=(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      JSON.parse(match[2]);
    } catch (error) {
      issues.push({ file, type: 'invalid JSON-LD', value: error.message });
    }
  }

  const versionedAssets = [...html.matchAll(/[?&]v=([0-9]+[a-z]?)/g)].map((match) => match[1]);
  const staleVersions = [...new Set(versionedAssets.filter((version) => version !== assetVersion))];
  if (staleVersions.length) issues.push({ file, type: 'stale asset versions', values: staleVersions });
}

const manifestRaw = fs.readFileSync(path.join(root, 'site.webmanifest'));
if (manifestRaw[0] === 0xEF && manifestRaw[1] === 0xBB && manifestRaw[2] === 0xBF) {
  issues.push({ file: 'site.webmanifest', type: 'UTF-8 BOM should be removed' });
}
try {
  const manifest = JSON.parse(manifestRaw.toString('utf8').replace(/^\uFEFF/, ''));
  for (const icon of manifest.icons || []) {
    if (!exists(icon.src)) issues.push({ file: 'site.webmanifest', type: 'missing icon', value: icon.src });
  }
} catch (error) {
  issues.push({ file: 'site.webmanifest', type: 'invalid JSON', value: error.message });
}

const sw = read('sw.js');
const shellMatch = sw.match(/const APP_SHELL_ASSETS = \[([\s\S]*?)\];/);
const shellAssets = shellMatch ? [...shellMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]) : [];
let shellImageBytes = 0;
for (const asset of shellAssets) {
  const localPath = localPathFromReference(asset, 'index.html');
  if (localPath && !exists(localPath)) issues.push({ file: 'sw.js', type: 'missing shell asset', value: asset });
  if (localPath && /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(localPath)) {
    shellImageBytes += fs.statSync(path.join(root, localPath)).size;
  }
  const version = asset.match(/[?&]v=([0-9]+[a-z]?)/)?.[1];
  if (version && version !== assetVersion) issues.push({ file: 'sw.js', type: 'stale shell asset version', value: asset });
}
if (shellImageBytes > 1024 * 1024) {
  issues.push({ file: 'sw.js', type: 'offline shell image payload exceeds 1 MB', bytes: shellImageBytes });
}

const catalogs = Object.fromEntries(CATALOG_FILES.map((file) => [file, JSON.parse(read(file))]));
const fullCatalog = new Map(catalogs['products.json'].map((item) => [String(item.id), item]));
for (const field of CANONICAL_OPERATIONAL_FIELDS) {
  const missingCount = catalogs['products.json'].filter(
    (item) => !Object.prototype.hasOwnProperty.call(item, field)
  ).length;
  if (missingCount) {
    issues.push({
      file: 'products.json',
      type: `canonical catalog lost operational field: ${field}`,
      count: missingCount
    });
  }
}
const richMetadataCount = catalogs['products.json'].filter((item) => {
  const metadata = item.metadata;
  return metadata
    && typeof metadata === 'object'
    && Object.keys(metadata).some((key) => !['conditionNotes', 'playerAthlete', 'excelFields'].includes(key));
}).length;
if (richMetadataCount < 1000) {
  issues.push({
    file: 'products.json',
    type: 'canonical catalog appears to have lost admin/import metadata',
    count: richMetadataCount
  });
}
for (const [file, items] of Object.entries(catalogs)) {
  const ids = items.map((item) => String(item.id));
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length) issues.push({ file, type: 'duplicate product ids', values: duplicateIds.slice(0, 10) });

  for (const item of items) {
    const high = rangeHigh(item);
    if (high != null && Math.abs(Number(item.price) - high) >= 0.001) {
      issues.push({ file, type: 'ranged listing does not use high checkout price', id: item.id });
    }
    for (const [field, references] of [
      ['image', [item.image]],
      ['imageGallery', Array.isArray(item.imageGallery) ? item.imageGallery : []]
    ]) {
      for (const reference of references) {
        const localPath = localPathFromReference(reference, file);
        if (localPath && !exists(localPath)) {
          issues.push({ file, type: `missing catalog ${field} asset`, id: item.id, value: reference });
        }
      }
    }
    if (file === 'products.json') continue;
    const fullItem = fullCatalog.get(String(item.id));
    if (!fullItem) {
      issues.push({ file, type: 'listing missing from full catalog', id: item.id });
      continue;
    }
    for (const field of MIRROR_FIELDS) {
      if (JSON.stringify(item[field] ?? null) !== JSON.stringify(fullItem[field] ?? null)) {
        issues.push({ file, type: `catalog mirror mismatch: ${field}`, id: item.id });
      }
    }
  }
}

const summary = {
  htmlFiles: HTML_FILES.length,
  catalogRows: catalogs['products.json'].length,
  assetVersion,
  shellAssets: shellAssets.length,
  shellImageKB: Math.round(shellImageBytes / 1024),
  richMetadataRows: richMetadataCount,
  issues: issues.length
};
console.log(JSON.stringify(summary, null, 2));
if (issues.length) {
  console.error(JSON.stringify(issues.slice(0, 100), null, 2));
  process.exit(1);
}
