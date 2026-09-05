import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const NESTED_HTML_ROOTS = ['tools', 'lineup-lab'];

function discoverNestedHtml(relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return [];

  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) return discoverNestedHtml(relativePath);
    return entry.isFile() && entry.name.endsWith('.html') ? [relativePath] : [];
  });
}

const HTML_FILES = [
  ...fs.readdirSync(root).filter((file) => file.endsWith('.html')),
  ...NESTED_HTML_ROOTS.flatMap(discoverNestedHtml)
].sort();
const CATALOG_FILES = [
  'products-public.json',
  'products-baseball.json',
  'products-basketball.json',
  'products-football.json',
  'products-comics.json',
  'products-collectibles.json',
  'products-sports.json',
  'products-featured.json'
];
const BOOTSTRAP_FILES = {
  'products-baseball.json': 'products-bootstrap-baseball.json',
  'products-basketball.json': 'products-bootstrap-basketball.json',
  'products-football.json': 'products-bootstrap-football.json',
  'products-comics.json': 'products-bootstrap-comics.json',
  'products-collectibles.json': 'products-bootstrap-collectibles.json',
  'products-sports.json': 'products-bootstrap-sports.json'
};
const MIRROR_FIELDS = [
  'name', 'category', 'team', 'year', 'condition', 'price',
  'priceLabel', 'displayPrice', 'image', 'imageGallery'
];
const CANONICAL_OPERATIONAL_FIELDS = ['itemPhotoUrls', 'htmlImageUrls'];
const PUBLIC_FORBIDDEN_FIELDS = new Set([
  'itemPhotoUrl', 'itemPhotoUrls', 'htmlFullLink', 'htmlImageUrls',
  'soldAt', 'hiddenReason', 'archivedAt'
]);
const PUBLIC_METADATA_FIELDS = new Set(['conditionNotes', 'playerAthlete', 'excelFields']);
const PUBLIC_EXCEL_FIELDS = new Set(['Title', 'C:Features', 'C:Autographed']);
const WRONG_CONTACT_PATTERN = /djwandrei@gmail\.com|contact@djshouseofcards-comics\.com/i;
const RANGE_PATTERN = /\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|\u2013|\u2014|\bto\b)\s*\$?\s*(\d[\d,]*(?:\.\d+)?)/i;
const issues = [];

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8').replace(/^\uFEFF/, '');
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  values.forEach((value) => {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  });
  return [...duplicates];
}

function tagAttributes(tag) {
  const attributes = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

function localPathFromReference(reference, currentFile) {
  const value = String(reference || '').trim();
  if (!value || /^(?:https?:|mailto:|tel:|sms:|data:|blob:|javascript:|\/\/)/i.test(value)) return null;

  // Product filenames can legitimately contain raw # characters. Check the
  // exact page-relative filesystem path before URL parsing treats them as a
  // fragment identifier.
  const normalizedCurrentFile = String(currentFile || '').replaceAll('\\', '/');
  const exactPath = value.startsWith('/')
    ? value.replace(/^\/+/, '')
    : path.posix.normalize(path.posix.join(path.posix.dirname(normalizedCurrentFile), value));
  if (!exactPath.startsWith('../') && exists(exactPath)) return exactPath;

  try {
    const url = new URL(value, `https://local.djhc.test/${normalizedCurrentFile}`);
    if (url.origin !== 'https://local.djhc.test') return null;
    let targetPath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!targetPath) targetPath = 'index.html';
    if (targetPath.endsWith('/')) targetPath += 'index.html';
    return targetPath;
  } catch {
    return value.split(/[?#]/, 1)[0].replace(/^\/+/, '') || currentFile;
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

const core = read('core.js');
const assetVersion = core.match(/PRODUCT_ASSET_VERSION\s*=\s*'([^']+)'/)?.[1] || '';
if (!assetVersion) issues.push({ file: 'core.js', type: 'missing product asset version' });

const backendConfig = read('backend-config.js');
const csp = read('.htaccess')
  .match(/Content-Security-Policy\s+"([^"]+)"/i)?.[1] || '';
const scriptSources = csp
  .split(';')
  .map((directive) => directive.trim())
  .find((directive) => directive.startsWith('script-src ')) || '';
if (/'unsafe-inline'/i.test(scriptSources)) {
  issues.push({ file: '.htaccess', type: 'CSP script-src permits unsafe inline scripts' });
}
const connectSources = csp
  .split(';')
  .map((directive) => directive.trim())
  .find((directive) => directive.startsWith('connect-src '))
  ?.split(/\s+/)
  .slice(1) || [];
for (const [name, property] of [
  ['commerce', 'supabaseUrl'],
  ['analytics', 'analyticsSupabaseUrl']
]) {
  const match = backendConfig.match(new RegExp(`${property}\\s*:\\s*['\"](https:\\/\\/[^'\"]+)['\"]`));
  const projectUrl = match?.[1] || '';
  if (!projectUrl) {
    issues.push({ file: 'backend-config.js', type: `missing ${name} Supabase URL` });
  } else if (!connectSources.includes(projectUrl)) {
    issues.push({ file: '.htaccess', type: `CSP connect-src blocks ${name} Supabase`, value: projectUrl });
  }
}

for (const file of HTML_FILES) {
  const html = read(file);
  const tags = [...html.matchAll(/<(?:meta|link|script|img|a)\b[^>]*>/gi)].map((match) => match[0]);
  const meta = tags.map(tagAttributes);
  const ids = [...html.matchAll(/\bid=(["'])(.*?)\1/gi)].map((match) => match[2]);
  const duplicateIds = duplicateValues(ids);
  const imagePreloads = meta
    .filter((attributes) => attributes.rel === 'preload' && attributes.as === 'image');

  if (duplicateIds.length) issues.push({ file, type: 'duplicate ids', values: duplicateIds });
  if ((html.match(/<h1\b/gi) || []).length !== 1) issues.push({ file, type: 'expected exactly one h1' });
  if (imagePreloads.length > 2) issues.push({ file, type: 'too many image preloads', count: imagePreloads.length });
  if (WRONG_CONTACT_PATTERN.test(html)) issues.push({ file, type: 'wrong public contact email' });
  if (file !== 'admin.html' && /admin-footer-link/i.test(html)) {
    issues.push({ file, type: 'public page exposes admin footer link' });
  }

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

  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attributes = tagAttributes(`<script${match[1]}>`);
    const scriptType = String(attributes.type || '').toLowerCase();
    const isDataScript = scriptType === 'application/ld+json' || scriptType === 'application/json';
    if (!attributes.src && !isDataScript && match[2].trim()) {
      issues.push({ file, type: 'executable inline script is not allowed by CSP' });
    }
  }

  const versionedAssets = [...html.matchAll(/[?&]v=([0-9]+[a-z]?)/g)].map((match) => match[1]);
  const staleVersions = file.startsWith('lineup-lab/')
    ? []
    : [...new Set(versionedAssets.filter((version) => version !== assetVersion))];
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

const supabaseClient = read('supabase-client.js');
const remoteSelectColumns = supabaseClient.match(/const PUBLIC_REMOTE_LIST_SELECT_COLUMNS = \[([\s\S]*?)\]\.join/)?.[1] || '';
for (const field of ['metadata', 'item_photo_url', 'item_photo_urls', 'html_full_link', 'html_image_urls']) {
  const present = new RegExp(`['"]${field}['"]`).test(remoteSelectColumns);
  if (field === 'metadata' ? !present : present) {
    issues.push({ file: 'supabase-client.js', type: 'unsafe public product select', value: field });
  }
}

const sdkVersion = supabaseClient.match(/SUPABASE_LIBRARY_VERSION\s*=\s*'([^']+)'/)?.[1] || '';
const vendoredSupabase = read('vendor/supabase.min.js');
if (!sdkVersion || !vendoredSupabase.includes(`supabase-js@${sdkVersion}`)) {
  issues.push({ file: 'vendor/supabase.min.js', type: 'vendored Supabase SDK version does not match adapter pin', value: sdkVersion });
}
for (const manifest of fs.readdirSync(path.join(root, 'scripts')).filter((file) => file.endsWith('.txt'))) {
  const content = read(path.join('scripts', manifest));
  if (content.split(/\r?\n/).includes('supabase-client.js') && !content.split(/\r?\n/).includes('vendor/supabase.min.js')) {
    issues.push({ file: path.join('scripts', manifest), type: 'release includes Supabase adapter without pinned vendor bundle' });
  }
}

const catalogs = Object.fromEntries(CATALOG_FILES.map((file) => [file, JSON.parse(read(file))]));
const catalogClient = read('catalog.js');
for (const [sourceFile, bootstrapFile] of Object.entries(BOOTSTRAP_FILES)) {
  const mapping = `'${sourceFile}': '${bootstrapFile}'`;
  if (!catalogClient.includes(mapping)) {
    issues.push({ file: 'catalog.js', type: 'missing catalog bootstrap source mapping', value: mapping });
  }
}
const canonicalProducts = JSON.parse(read('products.json'));
const fullCatalog = new Map(canonicalProducts.map((item) => [String(item.id), item]));
for (const [sourceFile, bootstrapFile] of Object.entries(BOOTSTRAP_FILES)) {
  if (!exists(bootstrapFile)) {
    issues.push({ file: bootstrapFile, type: 'missing catalog bootstrap file' });
    continue;
  }

  let bootstrap;
  try {
    bootstrap = JSON.parse(read(bootstrapFile));
  } catch (error) {
    issues.push({ file: bootstrapFile, type: 'invalid catalog bootstrap JSON', value: error.message });
    continue;
  }

  const sourceItems = catalogs[sourceFile] || [];
  const activeSourceItems = sourceItems.filter((item) => item?.isDeleted !== true);
  if (bootstrap.source !== sourceFile) {
    issues.push({ file: bootstrapFile, type: 'bootstrap source mismatch', value: bootstrap.source });
  }
  if (Number(bootstrap.total) !== activeSourceItems.length) {
    issues.push({ file: bootstrapFile, type: 'bootstrap total mismatch', value: bootstrap.total, expected: activeSourceItems.length });
  }
  if (!Array.isArray(bootstrap.products) || !bootstrap.products.length || bootstrap.products.length > 48) {
    issues.push({ file: bootstrapFile, type: 'bootstrap product window should contain 1-48 products' });
    continue;
  }

  bootstrap.products.forEach((item, index) => {
    const sourceItem = activeSourceItems[index];
    if (String(item?.id) !== String(sourceItem?.id)) {
      issues.push({ file: bootstrapFile, type: 'bootstrap product does not mirror source order', index, id: item?.id, expected: sourceItem?.id });
      return;
    }

    for (const field of MIRROR_FIELDS) {
      if (JSON.stringify(item?.[field]) !== JSON.stringify(sourceItem?.[field])) {
        issues.push({ file: bootstrapFile, type: 'bootstrap product field mismatch', index, id: item?.id, field });
      }
    }
  });
}
for (const field of CANONICAL_OPERATIONAL_FIELDS) {
  const missingCount = canonicalProducts.filter(
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
const richMetadataCount = canonicalProducts.filter((item) => {
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
  const duplicateIds = duplicateValues(ids);
  if (duplicateIds.length) issues.push({ file, type: 'duplicate product ids', values: duplicateIds.slice(0, 10) });

  for (const item of items) {
    for (const field of Object.keys(item || {})) {
      if (PUBLIC_FORBIDDEN_FIELDS.has(field)) {
        issues.push({ file, type: 'public catalog exposes internal product field', id: item.id, field });
      }
    }
    const metadata = item?.metadata;
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      for (const field of Object.keys(metadata)) {
        if (!PUBLIC_METADATA_FIELDS.has(field)) {
          issues.push({ file, type: 'public catalog exposes internal metadata field', id: item.id, field });
        }
      }
      if (metadata.excelFields && typeof metadata.excelFields === 'object' && !Array.isArray(metadata.excelFields)) {
        for (const field of Object.keys(metadata.excelFields)) {
          if (!PUBLIC_EXCEL_FIELDS.has(field)) {
            issues.push({ file, type: 'public catalog exposes internal workbook field', id: item.id, field });
          }
        }
      }
    }
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
  catalogRows: canonicalProducts.length,
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
