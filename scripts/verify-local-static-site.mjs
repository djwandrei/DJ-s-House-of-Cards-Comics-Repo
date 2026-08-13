import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = process.cwd();
const SITE_ORIGIN = 'https://www.djshouseofcards-comics.com';
const CATEGORY_SEGMENTS = {
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
const BOOTSTRAP_FILES = {
  'products-baseball.json': 'products-bootstrap-baseball.json',
  'products-basketball.json': 'products-bootstrap-basketball.json',
  'products-football.json': 'products-bootstrap-football.json',
  'products-comics.json': 'products-bootstrap-comics.json',
  'products-collectibles.json': 'products-bootstrap-collectibles.json'
};
const BOOTSTRAP_PRODUCT_LIMIT = 48;
const STOREFRONT_FIELDS = new Set([
  'id', 'name', 'category', 'team', 'year', 'condition', 'price', 'priceLabel',
  'displayPrice', 'image', 'imageGallery', 'description', 'photoHostPageUrl',
  'legacyImageLabel', 'sourcePage', 'league', 'sport', 'playerAthlete', 'copyCount',
  'attributes', 'isFeatured', 'isDeleted', 'sortRank', 'hasThumbnail'
]);
const STOREFRONT_METADATA_FIELDS = new Set(['conditionNotes', 'playerAthlete']);
const STOREFRONT_EXCEL_FIELDS = new Set(['Title', 'C:Features', 'C:Autographed']);
const THUMBNAIL_ELIGIBLE_ROOTS = new Set([
  'baseball-cards',
  'basketball-cards',
  'collectibles',
  'comics',
  'ebay listing photos',
  'personal collection',
  'football-cards'
]);
const CATEGORY_PAGES = [
  { file: 'baseball-cards.html', category: 'Baseball' },
  { file: 'basketball-cards.html', category: 'Basketball' },
  { file: 'football-cards.html', category: 'Football' },
  { file: 'comics.html', category: 'Comics' },
  { file: 'collectibles.html', category: 'Collectibles' }
];

function run(command, args, options = {}) {
  const isWindowsGit = process.platform === 'win32' && command === 'git';
  const actualCommand = isWindowsGit ? (process.env.ComSpec || 'cmd.exe') : command;
  const actualArgs = isWindowsGit ? ['/d', '/s', '/c', ['git', ...args].join(' ')] : args;
  const result = spawnSync(actualCommand, actualArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `:\n${output}` : ''}`);
  }
  return result.stdout.trim();
}

function readJson(file) {
  return JSON.parse(readFileSync(path.join(ROOT, file), 'utf8'));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pickStorefrontMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (STOREFRONT_METADATA_FIELDS.has(key)) out[key] = value;
  }
  if (metadata.excelFields && typeof metadata.excelFields === 'object') {
    const excelFields = {};
    for (const [key, value] of Object.entries(metadata.excelFields)) {
      if (STOREFRONT_EXCEL_FIELDS.has(key) && value != null && value !== '') {
        excelFields[key] = value;
      }
    }
    if (Object.keys(excelFields).length) out.excelFields = excelFields;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizedAssetPath(reference = '') {
  return String(reference || '').trim().replace(/\\/g, '/').replace(/^\/+/, '').split(/[?#]/)[0];
}

function thumbnailPathForAsset(reference = '') {
  const normalized = normalizedAssetPath(reference);
  if (!/^assets\//i.test(normalized) || /^assets\/thumbnails\//i.test(normalized)) return '';
  const relativePath = normalized.replace(/^assets\//i, '');
  const rootSegment = relativePath.split('/')[0]?.toLowerCase() || '';
  if (!THUMBNAIL_ELIGIBLE_ROOTS.has(rootSegment) || /\.svg$/i.test(relativePath)) return '';
  return `assets/thumbnails/${relativePath.replace(/\.[^.]+$/, '.webp')}`;
}

function hasGeneratedThumbnail(reference = '') {
  const thumbnailPath = thumbnailPathForAsset(reference);
  return Boolean(thumbnailPath && existsSync(path.join(ROOT, thumbnailPath)));
}

function pickStorefrontFields(item) {
  const out = {};
  for (const key of STOREFRONT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item, key)) out[key] = item[key];
  }
  const metadata = pickStorefrontMetadata(item.metadata);
  if (metadata) out.metadata = metadata;
  if (hasGeneratedThumbnail(out.image)) out.hasThumbnail = true;
  else delete out.hasThumbnail;
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

function expectedStorefrontRows(canonicalProducts, file) {
  let raw = file === 'products.json'
    ? canonicalProducts
    : canonicalProducts.filter(CATEGORY_SEGMENTS[file]);
  if (file === 'products-featured.json') raw = sortByStorefrontRank(raw);
  return raw
    .filter((item) => item?.isDeleted !== true)
    .map((item) => pickStorefrontFields(item));
}

function readBundleProducts(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const match = text.match(/window\.DJ_PRELOADED_PRODUCTS\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) throw new Error(`${file}: missing DJ_PRELOADED_PRODUCTS assignment`);
  return JSON.parse(match[1]);
}

function verifyGeneratedCatalogParity() {
  const canonicalProducts = readJson('products.json');
  const checked = [];
  for (const [file, predicate] of Object.entries({ 'products.json': () => true, ...CATEGORY_SEGMENTS })) {
    const expected = expectedStorefrontRows(canonicalProducts, file);
    if (file !== 'products.json') {
      const actualJson = readJson(file);
      if (!sameJson(actualJson, expected)) throw new Error(`${file}: generated JSON is stale`);
      checked.push(file);
    }
    const bundleFile = BUNDLE_FILES[file];
    if (bundleFile) {
      const actualBundle = readBundleProducts(bundleFile);
      if (!sameJson(actualBundle, expected)) throw new Error(`${bundleFile}: preloaded bundle is stale`);
      checked.push(bundleFile);
    }
    const bootstrapFile = BOOTSTRAP_FILES[file];
    if (bootstrapFile) {
      const actualBootstrap = readJson(bootstrapFile);
      const expectedBootstrap = {
        source: file,
        total: expected.length,
        products: expected.slice(0, BOOTSTRAP_PRODUCT_LIMIT)
      };
      if (!sameJson(actualBootstrap, expectedBootstrap)) throw new Error(`${bootstrapFile}: bootstrap JSON is stale`);
      checked.push(bootstrapFile);
    }
    void predicate;
  }
  return { checked: checked.length };
}

function categoryOf(product) {
  return String(product.category || '').trim() || 'Collectibles';
}

function sortProducts(products) {
  return [...products].sort((left, right) => {
    const rankA = Number.isFinite(Number(left.sortRank)) ? Number(left.sortRank) : Number.MAX_SAFE_INTEGER;
    const rankB = Number.isFinite(Number(right.sortRank)) ? Number(right.sortRank) : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return Number(left.id) - Number(right.id);
  });
}

function featuredProducts(products) {
  const featured = sortProducts(products.filter((product) => product.isFeatured === true));
  const sorted = sortProducts(products);
  const usedIds = new Set();
  const take = (category, count) => {
    const picked = [];
    for (const pool of [featured, sorted]) {
      for (const product of pool) {
        if (picked.length >= count) break;
        if (usedIds.has(product.id) || categoryOf(product) !== category) continue;
        usedIds.add(product.id);
        picked.push(product);
      }
      if (picked.length >= count) break;
    }
    return picked;
  };
  const balanced = [
    ...take('Baseball', 2),
    ...take('Basketball', 1),
    ...take('Football', 1),
    ...take('Comics', 1),
    ...take('Collectibles', 1)
  ];
  const djPick = featured.find((product) => !usedIds.has(product.id))
    || sorted.find((product) => !usedIds.has(product.id));
  if (djPick) balanced.push(djPick);
  return balanced.slice(0, 7);
}

function staticProductCardIds(file) {
  const html = readFileSync(path.join(ROOT, file), 'utf8');
  return [...html.matchAll(/<article\b[^>]*\bclass=["'][^"']*\bstatic-product-card\b[^"']*["'][^>]*\bdata-product-id=["']([^"']+)["']/gi)]
    .map((match) => Number(match[1]));
}

function verifyStaticFallbackParity() {
  const products = readJson('products.json').filter((product) => product && product.id && product.name);
  const checks = [];
  const expectedFeatured = featuredProducts(products).map((product) => Number(product.id));
  const actualFeatured = staticProductCardIds('index.html');
  if (!sameJson(actualFeatured, expectedFeatured)) throw new Error('index.html: featured static fallback cards are stale');
  checks.push('index.html');
  for (const page of CATEGORY_PAGES) {
    const expected = sortProducts(products)
      .filter((product) => categoryOf(product) === page.category)
      .slice(0, 12)
      .map((product) => Number(product.id));
    const actual = staticProductCardIds(page.file);
    if (!sameJson(actual, expected)) throw new Error(`${page.file}: static fallback cards are stale`);
    checks.push(page.file);
  }
  return { checked: checks.length };
}

function localJavaScriptFiles(directory = ROOT, prefix = '') {
  const skipDirectories = new Set([
    '.deploy',
    '.git',
    '.idea',
    '.vscode',
    '_unused-review',
    'assets',
    'node_modules',
    'outputs'
  ]);
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) {
        files.push(...localJavaScriptFiles(path.join(directory, entry.name), path.join(prefix, entry.name)));
      }
      continue;
    }
    const relativePath = path.join(prefix, entry.name).replaceAll('\\', '/');
    if (!/\.(?:js|mjs)$/i.test(entry.name)) continue;
    if (/^products-data-/i.test(entry.name)) continue;
    files.push(relativePath);
  }
  return files.sort();
}

function verifyJavaScriptSyntax() {
  const files = localJavaScriptFiles();
  for (const file of files) run(process.execPath, ['--check', file]);
  return { checked: files.length };
}

function localTargetForReference(rawReference, sourceFile) {
  const value = String(rawReference || '').trim();
  if (!value || value.startsWith('#')) return null;
  if (/^(?:mailto|tel|sms|javascript|data|blob):/i.test(value)) return null;
  if (/^\/\//.test(value)) return null;
  let targetPath = value;
  try {
    const url = /^https?:\/\//i.test(value)
      ? new URL(value)
      : new URL(value, `${SITE_ORIGIN}/${sourceFile}`);
    if (url.origin !== SITE_ORIGIN) return null;
    targetPath = url.pathname;
  } catch {
    targetPath = value.split(/[?#]/, 1)[0];
  }
  targetPath = targetPath.split(/[?#]/, 1)[0].replace(/^\/+/, '');
  if (!targetPath) targetPath = 'index.html';
  if (targetPath.endsWith('/')) targetPath += 'index.html';
  try {
    return decodeURIComponent(targetPath);
  } catch {
    return targetPath;
  }
}

function verifyLocalHtmlReferences() {
  const htmlFiles = readdirSync(ROOT).filter((file) => file.endsWith('.html'));
  const missing = [];
  let references = 0;
  for (const file of htmlFiles) {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of html.matchAll(/(?:^|[\s<])(?:href|src)=(["'])(.*?)\1/gi)) {
      const target = localTargetForReference(match[2], file);
      if (!target) continue;
      references += 1;
      if (!existsSync(path.join(ROOT, ...target.split('/')))) {
        missing.push({ file, reference: match[2], target });
      }
    }
  }
  if (missing.length) {
    throw new Error(`Missing local HTML references:\n${JSON.stringify(missing.slice(0, 25), null, 2)}`);
  }
  return { htmlFiles: htmlFiles.length, references };
}

const checks = [
  ['site-integrity', () => run(process.execPath, ['scripts/site-integrity-check.mjs'])],
  ['navigation-consistency', () => run(process.execPath, ['scripts/audit-navigation-consistency.mjs'])],
  ['search-index-policy', () => run(process.execPath, ['scripts/audit-search-index-policy.mjs'])],
  ['storefront-accessibility', () => run(process.execPath, ['scripts/audit-storefront-accessibility.mjs'])],
  ['structured-data', () => run(process.execPath, ['scripts/audit-structured-data.mjs'])],
  ['correctness-regressions', () => run(process.execPath, ['scripts/run-correctness-regression-tests.mjs'])],
  ['javascript-syntax', verifyJavaScriptSyntax],
  ['generated-catalog-parity', verifyGeneratedCatalogParity],
  ['static-fallback-parity', verifyStaticFallbackParity],
  ['local-html-references', verifyLocalHtmlReferences],
  ['git-diff-check', () => run('git', ['diff', '--check'])]
];

const results = [];
for (const [name, check] of checks) {
  const started = Date.now();
  try {
    const detail = check();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message || String(error) });
    console.error(JSON.stringify({ ok: false, results }, null, 2));
    process.exit(1);
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
