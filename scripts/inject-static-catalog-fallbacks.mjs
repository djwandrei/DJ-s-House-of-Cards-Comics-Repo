import fs from 'node:fs';
import path from 'node:path';

const PRODUCTS_PATH = 'products.json';
const FEATURED_PAGE = 'index.html';
const CATEGORY_PAGES = [
  { file: 'baseball-cards.html', category: 'Baseball', title: 'baseball' },
  { file: 'basketball-cards.html', category: 'Basketball', title: 'basketball' },
  { file: 'football-cards.html', category: 'Football', title: 'football' },
  { file: 'comics.html', category: 'Comics', title: 'comic' },
  { file: 'collectibles.html', category: 'Collectibles', title: 'collectible' }
];
const CATEGORY_ROUTES = new Map([
  ['Baseball', 'baseball-cards.html'],
  ['Basketball', 'basketball-cards.html'],
  ['Football', 'football-cards.html'],
  ['Comics', 'comics.html'],
  ['Collectibles', 'collectibles.html']
]);
const FALLBACK_BY_CATEGORY = {
  Baseball: 'assets/placeholder-baseball.svg',
  Basketball: 'assets/placeholder-basketball.svg',
  Football: 'assets/placeholder-football.svg',
  Comics: 'assets/placeholder-comics.svg',
  Collectibles: 'assets/clubhouse-sign.png',
  Other: 'assets/clubhouse-sign.png'
};
const THUMBNAIL_ELIGIBLE_ROOTS = new Set([
  'baseball-cards',
  'basketball-cards',
  'collectibles',
  'comics',
  'ebay listing photos',
  'personal collection',
  'football-cards'
]);

function readProducts() {
  const products = JSON.parse(fs.readFileSync(PRODUCTS_PATH, 'utf8'));
  if (!Array.isArray(products)) throw new Error(`${PRODUCTS_PATH} did not contain an array.`);
  return products.filter((product) => product && product.id && product.name);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeUrlAttribute(value) {
  return String(value ?? '')
    .replaceAll('#', '%23')
    .replaceAll('<', '%3C')
    .replaceAll('>', '%3E')
    .replaceAll('"', '%22');
}

function escapeDataAttribute(value) {
  return escapeHtml(value).replace(/\r?\n/g, '&#10;');
}

function normalizeAssetPath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/');
}

function decodeAssetSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function decodeAssetPath(assetPath) {
  return normalizeAssetPath(assetPath).split('/').map(decodeAssetSegment).join('/');
}

function encodeAssetUrl(assetPath) {
  const normalized = normalizeAssetPath(assetPath);
  if (!/^assets\//i.test(normalized)) {
    return escapeUrlAttribute(normalized);
  }

  return normalized
    .split('/')
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(decodeAssetSegment(segment))))
    .join('/');
}

function localAssetExists(assetPath) {
  const decoded = decodeAssetPath(assetPath);
  if (!/^assets\//i.test(decoded)) return false;
  return fs.existsSync(path.join(process.cwd(), ...decoded.split('/')));
}

function isThumbnailEligibleAsset(assetPath) {
  const normalized = normalizeAssetPath(assetPath);
  if (!/^assets\//i.test(normalized) || /^assets\/thumbnails\//i.test(normalized)) {
    return false;
  }

  const relativePath = normalized.replace(/^assets\//i, '');
  const rootSegment = relativePath.split('/')[0]?.toLowerCase() || '';
  return THUMBNAIL_ELIGIBLE_ROOTS.has(rootSegment);
}

function deriveThumbnailPath(assetPath) {
  const normalized = normalizeAssetPath(assetPath);
  if (!isThumbnailEligibleAsset(normalized)) return '';

  const relativePath = normalized.replace(/^assets\//i, '');
  const extension = relativePath.split('.').pop()?.toLowerCase() || '';
  if (!extension || extension === 'svg') return '';

  return `assets/thumbnails/${relativePath.replace(/\.[^.]+$/, '.webp')}`;
}

function categoryOf(product) {
  return String(product.category || '').trim() || 'Collectibles';
}

function sortProducts(products) {
  return [...products].sort((a, b) => {
    const rankA = Number.isFinite(Number(a.sortRank)) ? Number(a.sortRank) : Number.MAX_SAFE_INTEGER;
    const rankB = Number.isFinite(Number(b.sortRank)) ? Number(b.sortRank) : Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return Number(a.id) - Number(b.id);
  });
}

function displayPrice(product) {
  const label = String(product.priceLabel || product.displayPrice || '').trim();
  if (label) return label;
  const price = Number(product.price);
  return Number.isFinite(price)
    ? `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : 'Ask DJ for price';
}

function shouldSuppressStaticCondition(product, category) {
  if (!/collectibles/i.test(category)) return false;
  const raw = String(product.conditionCompact || product.condition || '').trim();
  if (!raw) return false;
  if (/\b(?:poor|fair|good|very good|excellent|mint|near mint|nm|graded|psa|sgc|bgs|cgc|beckett)\b/i.test(raw)) {
    return false;
  }
  return /\b(?:autographed?|signed|signature|multi[- ]signed|memorabilia|collectible|baseball|bat|ball|postcard|photo|display|program)\b/i.test(raw);
}

function primaryImage(product) {
  return String(product.image || '').trim() || 'assets/dj-logo.png';
}

function productThumbnailPath(product) {
  const metadata = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  const configuredThumbnail = normalizeAssetPath(metadata.thumbnailPath || product.thumbnailPath);
  if (configuredThumbnail && localAssetExists(configuredThumbnail)) {
    return configuredThumbnail;
  }

  const derivedThumbnail = deriveThumbnailPath(primaryImage(product));
  return derivedThumbnail && localAssetExists(derivedThumbnail) ? derivedThumbnail : '';
}

function productImageSources(product) {
  const category = categoryOf(product);
  const original = normalizeAssetPath(primaryImage(product));
  const thumbnail = productThumbnailPath(product);
  const source = thumbnail || original;
  const fallback = FALLBACK_BY_CATEGORY[category] || FALLBACK_BY_CATEGORY.Other;
  const candidates = [...new Set([thumbnail, original].filter(Boolean))].map(encodeAssetUrl);

  return {
    src: encodeAssetUrl(source),
    candidates,
    fallback: encodeAssetUrl(fallback)
  };
}

function productHref(product) {
  const route = CATEGORY_ROUTES.get(categoryOf(product)) || 'shop.html';
  return `${route}?item=${encodeURIComponent(product.id)}`;
}

function contextLine(product) {
  const metadata = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  return [
    product.year,
    product.setName,
    product.title,
    product.publisher,
    metadata.beckettTitle,
    metadata.manufacturer,
    metadata.publisher
  ].filter(Boolean).map(String).find(Boolean) || categoryOf(product);
}

function fallbackCard(product, index) {
  const category = categoryOf(product);
  const image = productImageSources(product);
  const condition = shouldSuppressStaticCondition(product, category)
    ? ''
    : (product.conditionCompact || product.condition || 'Condition available by request');
  return `    <article class="product-card static-product-card" data-product-id="${escapeHtml(product.id)}" data-product-category="${escapeHtml(category)}">
      <div class="product-media">
        <img src="${image.src}" data-asset-candidates="${escapeDataAttribute(image.candidates.join('\n'))}" data-fallback-src="${image.fallback}" alt="${escapeHtml(product.name)} product photo" width="320" height="320" loading="${index < 2 ? 'eager' : 'lazy'}" decoding="async">
      </div>
      <div class="product-content">
        <h3>${escapeHtml(product.name)}</h3>
        <div class="product-card-chip-rail">
          ${condition ? `<div class="product-topline">
            <span class="product-meta product-grade-meta" data-label="Condition">${escapeHtml(condition)}</span>
          </div>` : ''}
          <div class="product-card-summary">
            <p>${escapeHtml(contextLine(product))}</p>
          </div>
          <div class="product-meta-inline-list">
            <span class="product-meta-inline" data-label="Category">${escapeHtml(category)}</span>
            ${product.team ? `<span class="product-meta-inline" data-label="Team">${escapeHtml(product.team)}</span>` : ''}
          </div>
        </div>
        <div class="product-card-footer">
          <div class="product-pricing">
            <span class="product-price-label">Listing price</span>
            <div class="product-price">${escapeHtml(displayPrice(product))}</div>
          </div>
          <div class="product-actions product-card-actions" aria-label="Listing actions" role="group">
            <a class="button-secondary details-button" href="${escapeHtml(productHref(product))}">View details</a>
            <a class="buy-button buy-button--inquiry" href="contact.html?item=${encodeURIComponent(product.id)}">Ask DJ</a>
          </div>
        </div>
      </div>
    </article>`.replace(/[ \t]+$/gm, '');
}

function replaceProductGrid(file, cards) {
  const html = fs.readFileSync(file, 'utf8');
  const pattern = /(<div aria-live="polite" class="products-grid" id="productContainer">\r?\n)[\s\S]*(\r?\n     <\/div>\r?\n    <\/div>\r?\n   <\/section>\r?\n  <div aria-hidden)/;
  if (!pattern.test(html)) throw new Error(`Could not find productContainer in ${file}.`);
  const next = html.replace(
    pattern,
    (_match, open, close) => `${open}${cards.join('\n')}${close}`
  );
  fs.writeFileSync(file, next);
}

function replaceFeaturedGrid(products) {
  const html = fs.readFileSync(FEATURED_PAGE, 'utf8');
  const pattern = /(<div class="products-grid" id="featuredProducts">\r?\n)[\s\S]*(\r?\n<\/div>\r?\n<\/div>\r?\n<\/section>\r?\n<section class="section">\r?\n<div class="container features-grid">)/;
  if (!pattern.test(html)) throw new Error(`Could not find featuredProducts in ${FEATURED_PAGE}.`);
  const next = html.replace(
    pattern,
    (_match, open, close) => `${open}${products.map(fallbackCard).join('\n')}${close}`
  );
  fs.writeFileSync(FEATURED_PAGE, next);
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

function main() {
  const products = readProducts();
  replaceFeaturedGrid(featuredProducts(products));
  for (const page of CATEGORY_PAGES) {
    const cards = sortProducts(products)
      .filter((product) => categoryOf(product) === page.category)
      .slice(0, 12)
      .map(fallbackCard);
    replaceProductGrid(page.file, cards);
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
