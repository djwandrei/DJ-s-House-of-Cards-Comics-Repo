import { readFileSync } from 'node:fs';
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
  'wishlist.html',
  'account.html',
  'admin.html'
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
  'wishlist.html': 'WebPage',
  'account.html': 'WebPage',
  'admin.html': 'WebPage'
};

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
    types: [...new Set(items.flatMap((item) => Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).filter(Boolean))]
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
    types: [...new Set(graph.flatMap((item) => Array.isArray(item['@type']) ? item['@type'] : [item['@type']]).filter(Boolean))]
  };
}

const results = HTML_PAGES.map(validateStaticPage);
results.push(validateProductRuntime());

console.log('Structured data audit passed');
results.forEach((result) => {
  console.log(`${result.fileName}: ${result.types.join(', ')}`);
});
