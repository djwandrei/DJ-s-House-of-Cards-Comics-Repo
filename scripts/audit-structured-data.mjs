import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const HTML_PAGES = [
  'index.html',
  'shop.html',
  'sports-cards.html',
  'baseball-cards.html',
  'basketball-cards.html',
  'football-cards.html',
  'comics.html',
  'collectibles.html',
  'about.html',
  'contact.html',
  'sell-trade-want-list.html',
  'wishlist.html',
  'cart.html',
  'checkout-success.html',
  'account.html',
  'admin.html',
  'inbox.html',
  'metrics.html',
  'offer.html',
  'policies.html',
  'shipping.html',
  'returns.html'
];

const EXPECTED_PAGE_TYPES = {
  'index.html': 'WebPage',
  'shop.html': 'CollectionPage',
  'sports-cards.html': 'CollectionPage',
  'baseball-cards.html': 'CollectionPage',
  'basketball-cards.html': 'CollectionPage',
  'football-cards.html': 'CollectionPage',
  'comics.html': 'CollectionPage',
  'collectibles.html': 'CollectionPage',
  'about.html': 'AboutPage',
  'contact.html': 'ContactPage',
  'sell-trade-want-list.html': 'ContactPage',
  'wishlist.html': 'WebPage',
  'cart.html': 'WebPage',
  'checkout-success.html': 'WebPage',
  'account.html': 'WebPage',
  'admin.html': 'WebPage',
  'inbox.html': 'WebPage',
  'metrics.html': 'WebPage',
  'offer.html': 'WebPage',
  'policies.html': 'WebPage',
  'shipping.html': 'WebPage',
  'returns.html': 'WebPage'
};

const NESTED_PAGE_TYPES = {
  'tools/index.html': 'CollectionPage',
  'tools/player-card-matchups/index.html': 'CollectionPage'
};

function discoverToolsHtml(relativeDirectory = 'tools') {
  return readdirSync(relativeDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) return discoverToolsHtml(relativePath);
    return entry.isFile() && entry.name.endsWith('.html') ? [relativePath] : [];
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJsonLd(fileName) {
  const html = readFileSync(fileName, 'utf8');
  const scripts = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => JSON.parse(match[1].trim()));
  assert(scripts.length > 0, `${fileName}: missing JSON-LD script`);
  return scripts;
}

function graphItems(jsonLd) {
  if (Array.isArray(jsonLd)) return jsonLd.flatMap(graphItems);
  if (Array.isArray(jsonLd?.['@graph'])) return jsonLd['@graph'];
  return jsonLd ? [jsonLd] : [];
}

function typeMatches(item, expectedType) {
  const type = item?.['@type'];
  return Array.isArray(type) ? type.includes(expectedType) : type === expectedType;
}

function findType(items, expectedType) {
  return items.find((item) => typeMatches(item, expectedType));
}

function uniqueTypes(items) {
  return [...new Set(
    items.flatMap((item) => Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).filter(Boolean)
  )];
}

function htmlForUrlPath(pathname = '') {
  const normalized = String(pathname || '/').replace(/^\/+/, '') || 'index.html';
  return normalized === '' ? 'index.html' : normalized;
}

function hasSearchableCatalogRuntime(fileName) {
  const html = readFileSync(fileName, 'utf8');
  return (
    /\bid=["']productContainer["']/.test(html)
    && /src=["']catalog\.js(?:\?v=[^"']+)?["']/.test(html)
  );
}

function validateSearchAction(fileName, website) {
  const actions = [website.potentialAction].flat().filter(Boolean);
  for (const action of actions) {
    if (!typeMatches(action, 'SearchAction')) continue;
    const rawTarget = typeof action.target === 'string'
      ? action.target
      : action.target?.urlTemplate;
    assert(rawTarget, `${fileName}: SearchAction missing target`);
    assert(rawTarget.includes('{search_term_string}'), `${fileName}: SearchAction target must include search_term_string`);
    const target = new URL(rawTarget.replace('{search_term_string}', 'djhc-audit-search'), 'https://www.djshouseofcards-comics.com/');
    const targetFile = htmlForUrlPath(target.pathname);
    assert(HTML_PAGES.includes(targetFile), `${fileName}: SearchAction target page ${targetFile} is not audited`);
    assert(hasSearchableCatalogRuntime(targetFile), `${fileName}: SearchAction target ${targetFile} is not a searchable catalog runtime page`);
    assert(target.searchParams.has('search'), `${fileName}: SearchAction target must use the catalog search parameter`);
  }
}

function validateAbsoluteUrl(value, label) {
  assert(/^https:\/\/www\.djshouseofcards-comics\.com\//.test(String(value || '')), `${label}: expected production HTTPS URL`);
}

function validateBreadcrumb(fileName, breadcrumb) {
  assert(Array.isArray(breadcrumb.itemListElement), `${fileName}: breadcrumb missing itemListElement`);
  assert(breadcrumb.itemListElement.length >= 2, `${fileName}: breadcrumb should have at least two items`);
  breadcrumb.itemListElement.forEach((item, index) => {
    assert(item['@type'] === 'ListItem', `${fileName}: breadcrumb item ${index + 1} must be ListItem`);
    assert(item.position === index + 1, `${fileName}: breadcrumb positions must be sequential`);
    assert(String(item.name || '').trim(), `${fileName}: breadcrumb item ${index + 1} missing name`);
    validateAbsoluteUrl(item.item, `${fileName}: breadcrumb item ${index + 1}`);
  });
}

function validateStaticPage(fileName) {
  const items = readJsonLd(fileName).flatMap(graphItems);
  const organization = findType(items, 'Organization');
  const localBusiness = findType(items, 'LocalBusiness');
  const website = findType(items, 'WebSite');
  const page = findType(items, EXPECTED_PAGE_TYPES[fileName]);

  assert(organization, `${fileName}: missing Organization`);
  assert(localBusiness, `${fileName}: missing LocalBusiness`);
  assert(website, `${fileName}: missing WebSite`);
  assert(page, `${fileName}: missing ${EXPECTED_PAGE_TYPES[fileName]}`);

  validateAbsoluteUrl(organization.url, `${fileName}: Organization URL`);
  validateAbsoluteUrl(localBusiness.url, `${fileName}: LocalBusiness URL`);
  validateAbsoluteUrl(website.url, `${fileName}: WebSite URL`);
  validateAbsoluteUrl(page.url, `${fileName}: page URL`);
  validateSearchAction(fileName, website);

  if (fileName !== 'index.html') {
    validateBreadcrumb(fileName, findType(items, 'BreadcrumbList'));
  }

  if (fileName === 'contact.html') {
    const faq = findType(items, 'FAQPage');
    assert(faq, 'contact.html: missing FAQPage');
    assert(Array.isArray(faq.mainEntity) && faq.mainEntity.length >= 4, 'contact.html: FAQPage needs visible Q&A entries');
    faq.mainEntity.forEach((question, index) => {
      assert(question['@type'] === 'Question', `contact.html: FAQ item ${index + 1} must be Question`);
      assert(String(question.name || '').trim(), `contact.html: FAQ item ${index + 1} missing question`);
      assert(question.acceptedAnswer?.['@type'] === 'Answer', `contact.html: FAQ item ${index + 1} missing Answer`);
      assert(String(question.acceptedAnswer?.text || '').trim(), `contact.html: FAQ item ${index + 1} missing answer text`);
    });
  }

  return {
    fileName,
    types: uniqueTypes(items)
  };
}

function validateNestedPage(fileName) {
  const items = readJsonLd(fileName).flatMap(graphItems);
  const expectedType = NESTED_PAGE_TYPES[fileName];
  const page = findType(items, expectedType);

  assert(page, `${fileName}: missing ${expectedType}`);
  validateAbsoluteUrl(page.url, `${fileName}: page URL`);
  validateAbsoluteUrl(page['@id'], `${fileName}: page @id`);
  assert(page.isPartOf?.['@id'], `${fileName}: page must identify its parent website`);
  validateAbsoluteUrl(page.isPartOf['@id'], `${fileName}: parent website @id`);

  return {
    fileName,
    types: uniqueTypes(items)
  };
}

function installProductSchemaRuntime() {
  global.window = {
    DJ: {
      productPageUrl(product = {}) {
        const category = String(product.category || '').toLowerCase();
        const page = category.includes('baseball')
          ? 'baseball-cards.html'
          : category.includes('basketball')
            ? 'basketball-cards.html'
            : category.includes('football')
              ? 'football-cards.html'
              : category.includes('comic')
                ? 'comics.html'
                : category.includes('collect')
                  ? 'collectibles.html'
                  : 'shop.html';
        return product.id == null ? page : `${page}?item=${encodeURIComponent(String(product.id))}`;
      },
      payablePrice(product = {}) {
        const price = Number(product.price);
        return Number.isFinite(price) ? price : null;
      }
    }
  };
  vm.runInThisContext(readFileSync('seo.js', 'utf8'), { filename: 'seo.js' });
  return global.window.DJ.seo;
}

function validateProductRuntime() {
  const seo = installProductSchemaRuntime();
  const sample = JSON.parse(readFileSync('products-featured.json', 'utf8'))[0];
  const graph = graphItems(seo.productSchema(sample));
  const product = findType(graph, 'Product');
  const offer = findType(graph, 'Offer');
  const breadcrumb = findType(graph, 'BreadcrumbList');

  assert(product, 'seo.js: product runtime missing Product');
  assert(offer, 'seo.js: product runtime missing Offer');
  assert(breadcrumb, 'seo.js: product runtime missing BreadcrumbList');
  assert(product.offers?.['@id'] === offer['@id'], 'seo.js: Product must reference Offer by @id');
  assert(offer.priceCurrency === 'USD', 'seo.js: Offer must include USD currency for priced items');
  assert(Number.isFinite(offer.price), 'seo.js: Offer must include numeric price for priced items');
  validateAbsoluteUrl(product.url, 'seo.js: Product URL');
  validateAbsoluteUrl(offer.url, 'seo.js: Offer URL');
  validateBreadcrumb('seo.js product sample', breadcrumb);

  return {
    fileName: 'seo.js product sample',
    types: uniqueTypes(graph)
  };
}

const discoveredToolsPages = discoverToolsHtml();
assert(discoveredToolsPages.length === Object.keys(NESTED_PAGE_TYPES).length, 'Structured-data audit does not cover every Fan Tools page');
discoveredToolsPages.forEach((fileName) => {
  assert(NESTED_PAGE_TYPES[fileName], `${fileName}: missing from nested structured-data audit registry`);
});

const results = HTML_PAGES.map(validateStaticPage);
results.push(...Object.keys(NESTED_PAGE_TYPES).map(validateNestedPage));
results.push(validateProductRuntime());

console.log('Structured data audit passed');
results.forEach((result) => {
  console.log(`${result.fileName}: ${result.types.join(', ')}`);
});
