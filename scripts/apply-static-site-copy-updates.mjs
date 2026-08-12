import fs from 'node:fs';

const HTML_FILES = fs.readdirSync('.')
  .filter((file) => file.endsWith('.html'))
  .sort();
const CATALOG_FILES = [
  'shop.html',
  'sports-cards.html',
  'baseball-cards.html',
  'basketball-cards.html',
  'football-cards.html',
  'comics.html',
  'collectibles.html'
];

function replaceAll(value, replacements) {
  return replacements.reduce((current, [search, replacement]) => current.replace(search, replacement), value);
}

function ensureFooterLinks(html) {
  const footerStart = html.indexOf('<div class="footer-links">');
  if (footerStart < 0) return html;
  const footerEnd = html.indexOf('</div>', footerStart);
  if (footerEnd < 0) return html;

  const footer = html.slice(footerStart, footerEnd);
  if (footer.includes('policies.html') && footer.includes('sell-trade-want-list.html')) {
    return html;
  }

  const expandedLinks = [
    footer.includes('policies.html') ? '' : '<a href="policies.html">\n      Policies &amp; Authenticity\n     </a>',
    footer.includes('sell-trade-want-list.html') ? '' : '<a href="sell-trade-want-list.html">\n      Sell / Trade / Want List\n     </a>'
  ].filter(Boolean).join('\n');

  const compactLinks = [
    footer.includes('policies.html') ? '' : '<a href="policies.html">Policies &amp; Authenticity</a>',
    footer.includes('sell-trade-want-list.html') ? '' : '<a href="sell-trade-want-list.html">Sell / Trade / Want List</a>'
  ].filter(Boolean).join('');

  const footerNext = footer.includes('\n')
    ? footer.replace(/(<a href="contact\.html">\r?\n\s*Contact\r?\n\s*<\/a>)/, `${expandedLinks}\n$1`)
    : footer.replace('<a href="contact.html">Contact</a>', `${compactLinks}<a href="contact.html">Contact</a>`);

  if (footerNext !== footer) {
    return `${html.slice(0, footerStart)}${footerNext}${html.slice(footerEnd)}`;
  }

  return html;
}

function ensureCatalogNoscript(html) {
  if (html.includes('class="catalog-noscript"')) return html;
  const notice = [
    '     <noscript>',
    '      <div class="catalog-noscript">',
    '       Inventory filters and live availability require JavaScript. You can still review the sample listings below, then <a href="contact.html">contact DJ</a> or <a href="sell-trade-want-list.html">send a want list</a>.',
    '      </div>',
    '     </noscript>'
  ].join('\n');

  return html.replace(
    /(\s*)<div aria-live="polite" class="products-grid" id="productContainer">/,
    `$1${notice}\n$1<div aria-live="polite" class="products-grid" id="productContainer">`
  );
}

function updateCatalogLoadingCopy(html) {
  return replaceAll(html, [
    [/(\bid="resultsCount" role="status">\s*)0 items found(\s*<\/span>)/g, '$1Loading current inventory...$2'],
    [/(\bid="resultsSummary" role="status">\s*)Showing all available items\.(\s*<\/p>)/g, '$1Loading current inventory...$2']
  ]);
}

function updateWishlistCopy(html) {
  return html.replace(
    /(\bid="wishlistPageCount" role="status">\s*)0 saved items(\s*<\/span>)/,
    '$1Loading saved items...$2'
  );
}

function updateHomeLinks(html) {
  return html
    .replace(
      /(<a class="button-secondary" href=")contact\.html(">\s*Sell or Trade With DJ\s*<\/a>)/,
      '$1sell-trade-want-list.html$2'
    )
    .replace('Featured Inventory', 'Featured Finds');
}

function main() {
  for (const file of HTML_FILES) {
    let html = fs.readFileSync(file, 'utf8');
    html = ensureFooterLinks(html);
    if (CATALOG_FILES.includes(file)) {
      html = ensureCatalogNoscript(updateCatalogLoadingCopy(html));
    }
    if (file === 'wishlist.html') html = updateWishlistCopy(html);
    if (file === 'index.html') html = updateHomeLinks(html);
    fs.writeFileSync(file, html);
  }
}

main();
