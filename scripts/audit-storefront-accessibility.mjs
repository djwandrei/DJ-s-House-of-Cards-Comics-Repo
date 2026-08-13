#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const catalogPages = [
  'baseball-cards.html',
  'basketball-cards.html',
  'football-cards.html',
  'comics.html',
  'collectibles.html'
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function tagForId(html, id) {
  return html.match(new RegExp(`<[^>]*\\bid=["']${id}["'][^>]*>`, 'i'))?.[0] || '';
}

for (const file of catalogPages) {
  const html = read(file);
  const resultsSummary = tagForId(html, 'resultsSummary');
  const resultsLive = tagForId(html, 'resultsLive');
  const resultsCount = tagForId(html, 'resultsCount');
  const productContainer = tagForId(html, 'productContainer');
  const liveRegions = html.match(/\baria-live=["'][^"']+["']/gi) || [];

  assert(resultsSummary && !/aria-live|role=["']status/i.test(resultsSummary), `${file}: visible results summary must not be a live region.`);
  assert(/aria-live=["']polite["']/i.test(resultsLive) && /role=["']status["']/i.test(resultsLive), `${file}: resultsLive must be the concise polite status region.`);
  assert(resultsCount && !/aria-live|role=["']status/i.test(resultsCount), `${file}: results count must not duplicate catalog announcements.`);
  assert(productContainer && !/aria-live/i.test(productContainer), `${file}: product grid must not be a live region.`);
  assert(liveRegions.length === 1, `${file}: expected exactly one catalog aria-live region, found ${liveRegions.length}.`);
}

const navSource = read('nav.js');
const styles = read('styles.css');
assert(/COMPACT_NAV_BREAKPOINT\s*=\s*1180/.test(navSource), 'nav.js compact-navigation breakpoint must be 1180px.');
assert(/@media \(max-width:1180px\)\s*\{\s*\.site-header/.test(styles), 'styles.css must provide the 1180px compact-header contract.');
assert(/@media \(max-width:900px\)\s*\{\s*\.filter-panel--drawer/.test(styles), 'styles.css must retain the 900px mobile-filter drawer contract.');
assert(/showCartActionFeedback/.test(read('catalog.js')), 'catalog add-to-cart feedback helper is missing.');
assert(/Only \$\{available\} available/.test(read('catalog.js')), 'catalog stock-limit feedback is missing.');

console.log(`Storefront accessibility audit passed for ${catalogPages.length} catalog pages.`);
