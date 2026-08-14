#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE_ORIGIN = 'https://www.djshouseofcards-comics.com';
const SITEMAP_LASTMOD = '2026-08-13';
const publicIndexable = new Set([
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
  'policies.html',
  'shipping.html',
  'returns.html'
]);
const crawlableNoindex = new Set([
  'wishlist.html',
  'cart.html',
  'checkout-success.html',
  'account.html',
  'offer.html',
  'offline.html'
]);
const authenticationProtected = new Set(['admin.html', 'inbox.html', 'metrics.html']);
const allPolicyFiles = new Set([...publicIndexable, ...crawlableNoindex, ...authenticationProtected]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(file) {
  return readFileSync(path.join(root, file), 'utf8');
}

function attributes(tag = '') {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)]
    .map((match) => [match[1].toLowerCase(), match[3]]));
}

function metaContent(html, name) {
  const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
  return tags.find((tag) => tag.name?.toLowerCase() === name)?.content || '';
}

function canonicalHref(html) {
  const tags = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
  return tags.find((tag) => tag.rel?.toLowerCase() === 'canonical')?.href || '';
}

function expectedCanonical(file) {
  return file === 'index.html' ? `${SITE_ORIGIN}/` : `${SITE_ORIGIN}/${file}`;
}

function expectedSitemapUrl(file) {
  return expectedCanonical(file);
}

function readSitemapEntries() {
  const xml = read('sitemap.xml');
  return [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>\s*<\/url>/g)]
    .map((match) => ({ loc: match[1].trim(), lastmod: match[2].trim() }));
}

const htmlFiles = readdirSync(root).filter((file) => file.endsWith('.html')).sort();
assert(htmlFiles.length === allPolicyFiles.size, 'Search policy matrix does not cover every HTML page.');
for (const file of htmlFiles) {
  assert(allPolicyFiles.has(file), `${file}: missing from search policy matrix.`);
  const html = read(file);
  const robots = metaContent(html, 'robots').toLowerCase();
  const canonical = canonicalHref(html);

  if (file !== 'offline.html') {
    assert(canonical === expectedCanonical(file), `${file}: canonical must be ${expectedCanonical(file)}.`);
  }

  if (publicIndexable.has(file)) {
    assert(!robots.includes('noindex'), `${file}: public page must not use noindex.`);
    assert(robots.includes('index') && robots.includes('follow'), `${file}: public page needs index,follow robots metadata.`);
    assert(metaContent(html, 'description'), `${file}: public page is missing a description.`);
    if (file !== 'index.html') {
      assert(/class=["']breadcrumb-nav["']/.test(html) && /aria-current=["']page["']/.test(html), `${file}: visible breadcrumb is missing or incomplete.`);
    }
  } else {
    assert(robots.includes('noindex'), `${file}: private or transactional page must include noindex.`);
  }
}

const robotsTxt = read('robots.txt');
assert(/^Allow:\s*\/$/m.test(robotsTxt), 'robots.txt must permit crawler access to page-level noindex directives.');
assert(!/^Disallow:\s*\//m.test(robotsTxt), 'robots.txt must not block pages that rely on noindex.');

const sitemapEntries = readSitemapEntries();
const sitemapUrls = new Set(sitemapEntries.map((entry) => entry.loc));
assert(sitemapEntries.length === publicIndexable.size, 'Sitemap must contain every and only public-indexable URL.');
for (const file of publicIndexable) {
  assert(sitemapUrls.has(expectedSitemapUrl(file)), `${file}: public URL missing from sitemap.`);
}
for (const entry of sitemapEntries) {
  assert(entry.lastmod === SITEMAP_LASTMOD, `${entry.loc}: sitemap lastmod must match the current public release date.`);
  assert(/^\d{4}-\d{2}-\d{2}$/.test(entry.lastmod), `${entry.loc}: sitemap lastmod must be ISO-8601 date-only.`);
}

const structuredBuilder = read('scripts/build-structured-data.mjs');
const structuredAudit = read('scripts/audit-structured-data.mjs');
for (const file of publicIndexable) {
  assert(structuredBuilder.includes(`'${file}': {`), `${file}: missing from structured-data build registry.`);
  assert(structuredAudit.includes(`'${file}'`), `${file}: missing from structured-data audit registry.`);
}

console.log(`Search index policy audit passed for ${htmlFiles.length} pages and ${sitemapEntries.length} sitemap URLs.`);
