#!/usr/bin/env node
/**
 * Keep the static primary-navigation shell synchronized across every public
 * page, and verify that nav.js understands every body[data-page] value.
 *
 * Run with --write only when intentionally applying the canonical header.
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = process.argv.includes('--write');

function discoverToolsHtml(relativeDirectory = 'tools') {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return [];

  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDirectory.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) return discoverToolsHtml(relativePath);
    return entry.isFile() && entry.name.endsWith('.html') ? [relativePath] : [];
  });
}

const htmlFiles = [
  ...fs.readdirSync(root).filter((name) => name.endsWith('.html')),
  ...discoverToolsHtml()
].sort();
const excludedPages = new Set(['offline', 'scout-studio']);
const normalizeLineEndings = (value) => value.replace(/\r\n?/g, '\n');
const canonicalNav = `<nav aria-label="Primary navigation" class="site-nav" id="siteNav">
     <ul class="primary-nav__list">
      <li class="primary-nav__item">
       <a class="primary-nav__link" href="shop.html">Shop</a>
      </li>
      <li class="primary-nav__item primary-nav__item--has-submenu">
       <div class="primary-nav__item-group">
        <a class="primary-nav__link" href="sports-cards.html">Sports Cards</a>
        <button aria-controls="sportsCardsSubmenu" aria-expanded="false" aria-label="Toggle Sports Cards submenu" class="submenu-toggle" type="button">&#9662;</button>
       </div>
       <ul class="primary-nav__submenu" id="sportsCardsSubmenu">
        <li class="primary-nav__submenu-item"><a href="sports-cards.html">Sports Hub</a></li>
        <li class="primary-nav__submenu-item"><a href="baseball-cards.html">Baseball</a></li>
        <li class="primary-nav__submenu-item"><a href="basketball-cards.html">Basketball</a></li>
        <li class="primary-nav__submenu-item"><a href="football-cards.html">Football</a></li>
       </ul>
      </li>
      <li class="primary-nav__item">
       <a class="primary-nav__link" href="comics.html">Comics</a>
      </li>
      <li class="primary-nav__item">
       <a class="primary-nav__link" href="collectibles.html">Collectibles</a>
      </li>
      <li class="primary-nav__item">
       <a class="primary-nav__link" href="about.html">About</a>
      </li>
      <li class="primary-nav__item header-wishlist-item">
       <a class="header-wishlist-link primary-nav__link" href="wishlist.html">Wishlist</a>
      </li>
      <li class="primary-nav__item header-cart-item">
       <a class="header-cart-link primary-nav__link" data-cart-link href="cart.html">Cart <span data-cart-count="0">(0)</span></a>
      </li>
      <li class="primary-nav__item">
       <a class="primary-nav__link" href="account.html">Account</a>
      </li>
     </ul>
    </nav>`;

function loadNavConfig() {
  const source = fs.readFileSync(path.join(root, 'nav.js'), 'utf8');
  const window = {
    DJ: {},
    location: { pathname: '/index.html' },
    matchMedia: () => ({ matches: false })
  };
  const document = {
    readyState: 'loading',
    addEventListener() {},
    body: { dataset: {} }
  };
  vm.runInNewContext(source, { window, document, console });
  return window.DJ.PAGE_NAV_CONFIG || {};
}

function getPageKey(html, file) {
  const match = html.match(/<body\b[^>]*\bdata-page="([^"]+)"/i);
  if (!match) throw new Error(`${file}: body[data-page] is missing.`);
  return match[1];
}

function getNavMarkup(html, file) {
  const match = html.match(/<nav\b[^>]*\bid="siteNav"[^>]*>[\s\S]*?<\/nav>/i);
  if (!match) throw new Error(`${file}: #siteNav is missing.`);
  return match[0];
}

function applyCanonicalNav(html, file) {
  const navMarkup = getNavMarkup(html, file);
  return html.replace(navMarkup, canonicalNav);
}

function verifyCanonicalNav(html, file) {
  const navMarkup = getNavMarkup(html, file);
  if (normalizeLineEndings(navMarkup) !== canonicalNav) {
    throw new Error(`${file}: primary navigation differs from the canonical header.`);
  }
  if ((navMarkup.match(/data-cart-link/g) || []).length !== 1) {
    throw new Error(`${file}: canonical Cart link is missing or duplicated.`);
  }
  if ((navMarkup.match(/href="shop\.html"/g) || []).length < 1) {
    throw new Error(`${file}: canonical Shop link is missing.`);
  }
  if ((navMarkup.match(/id="sportsCardsSubmenu"/g) || []).length !== 1) {
    throw new Error(`${file}: Sports Cards submenu is missing or duplicated.`);
  }
}

function verifyNestedNav(html, file) {
  const navMarkup = getNavMarkup(html, file);
  const resolvedPaths = [...navMarkup.matchAll(/href="([^"]+)"/g)].map((match) => (
    new URL(match[1], `https://local.djhc.test/${file}`).pathname
  ));
  const requiredPaths = [
    '/shop.html',
    '/sports-cards.html',
    '/baseball-cards.html',
    '/basketball-cards.html',
    '/football-cards.html',
    '/comics.html',
    '/collectibles.html',
    '/tools/',
    '/about.html',
    '/wishlist.html',
    '/cart.html',
    '/account.html'
  ];

  requiredPaths.forEach((requiredPath) => {
    if (!resolvedPaths.includes(requiredPath)) {
      throw new Error(`${file}: primary navigation is missing ${requiredPath}.`);
    }
  });
  if ((navMarkup.match(/data-cart-link/g) || []).length !== 1) {
    throw new Error(`${file}: Cart link is missing or duplicated.`);
  }
  if ((navMarkup.match(/data-fan-tools-link/g) || []).length !== 1) {
    throw new Error(`${file}: Fan Tools link is missing or duplicated.`);
  }
  if ((navMarkup.match(/id="sportsCardsSubmenu"/g) || []).length !== 1) {
    throw new Error(`${file}: Sports Cards submenu is missing or duplicated.`);
  }
}

const navConfig = loadNavConfig();
let changed = 0;

for (const file of htmlFiles) {
  const filePath = path.join(root, file);
  const original = fs.readFileSync(filePath, 'utf8');
  const pageKey = getPageKey(original, file);
  if (excludedPages.has(pageKey)) continue;

  if (!navConfig[pageKey]) {
    throw new Error(`${file}: PAGE_NAV_CONFIG has no entry for "${pageKey}".`);
  }

  // Nested routes need page-relative hrefs, so --write remains intentionally
  // limited to the canonical root shell while nested shells are verified.
  const nested = file.includes('/');
  const next = write && !nested ? applyCanonicalNav(original, file) : original;
  if (next !== original) {
    fs.writeFileSync(filePath, next, 'utf8');
    changed += 1;
  }
  if (nested) verifyNestedNav(next, file);
  else verifyCanonicalNav(next, file);
}

console.log(`Navigation consistency check passed for ${htmlFiles.length - excludedPages.size} pages.${write ? ` Updated ${changed} header${changed === 1 ? '' : 's'}.` : ''}`);
