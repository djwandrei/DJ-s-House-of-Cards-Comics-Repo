import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API_VERSION = '2026-04';
const STYLE_ASSET_KEY = valueAfter('--style-asset-key') || 'assets/djhc-storefront-20260618.css';
const MIRRORED_STYLE_ASSET_KEYS = [
  STYLE_ASSET_KEY,
  'assets/djhc-storefront.css',
  'assets/djhc-custom.css',
  'assets/djhc-live.css',
  'assets/djhc-storefront-20260617-overflow.css'
].filter((assetKey, index, assetKeys) => assetKeys.indexOf(assetKey) === index);
const LOGO_ASSET_KEY = 'assets/dj-logo.png';
const THEME_LAYOUT_KEY = 'layout/theme.liquid';
const STYLE_FILENAME = path.basename(STYLE_ASSET_KEY);
const STYLE_TAG = `{{ '${STYLE_FILENAME}' | asset_url | stylesheet_tag }}`;
const STYLE_MARKER = valueAfter('--style-marker') || STYLE_FILENAME;
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const viaSupabase = args.has('--via-supabase');
const layoutCacheBust = args.has('--layout-cache-bust');
const layoutCacheBustMarker = valueAfter('--layout-cache-bust-marker')
  || `djhc-cache-bust-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
const themeIdArg = valueAfter('--theme-id');
const apiVersion = valueAfter('--api-version') || process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function valueAfter(flag) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(flag);
  return index >= 0 ? String(argv[index + 1] || '').trim() : '';
}

function normalizeShopDomain(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');
}

function requireShopDomain() {
  const domain = normalizeShopDomain(valueAfter('--shop') || process.env.SHOPIFY_SHOP_DOMAIN);
  if (!SHOP_DOMAIN_RE.test(domain)) {
    throw new Error('Set SHOPIFY_SHOP_DOMAIN to the store myshopify.com domain.');
  }
  return domain;
}

function optionalEnv(name) {
  return String(process.env[name] || '').trim();
}

function hasDirectShopifyAuth() {
  return Boolean(
    optionalEnv('SHOPIFY_THEME_ACCESS_TOKEN')
    || optionalEnv('SHOPIFY_ADMIN_ACCESS_TOKEN')
    || (optionalEnv('SHOPIFY_CLIENT_ID') && optionalEnv('SHOPIFY_CLIENT_SECRET'))
  );
}

function supabaseConfig() {
  const supabaseUrl = optionalEnv('SUPABASE_URL').replace(/\/+$/, '');
  const serviceRoleKey = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !serviceRoleKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before using the Supabase theme bridge.');
  }
  return { supabaseUrl, serviceRoleKey };
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function shopifyAccessToken(shopDomain) {
  const explicitThemeToken = optionalEnv('SHOPIFY_THEME_ACCESS_TOKEN');
  if (explicitThemeToken) return explicitThemeToken;

  const clientId = optionalEnv('SHOPIFY_CLIENT_ID');
  const clientSecret = optionalEnv('SHOPIFY_CLIENT_SECRET');
  if (clientId && clientSecret) {
    const response = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    const payload = await readResponse(response);
    if (!response.ok || !payload.access_token) {
      const detail = payload.error_description || payload.error || payload.raw || `HTTP ${response.status}`;
      throw new Error(`Shopify token request failed: ${detail}`);
    }
    return String(payload.access_token);
  }

  const adminToken = optionalEnv('SHOPIFY_ADMIN_ACCESS_TOKEN');
  if (adminToken) return adminToken;

  throw new Error('Set SHOPIFY client credentials or SHOPIFY_THEME_ACCESS_TOKEN before applying the theme.');
}

function describeShopifyError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (payload.errors) return typeof payload.errors === 'string' ? payload.errors : JSON.stringify(payload.errors);
  if (payload.error_description) return String(payload.error_description);
  if (payload.error) return String(payload.error);
  if (payload.raw) return String(payload.raw).slice(0, 500);
  return '';
}

function makeRestClient({ shopDomain, token }) {
  return async function rest(method, endpoint, body) {
    const response = await fetch(`https://${shopDomain}/admin/api/${apiVersion}/${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': token
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await readResponse(response);
    if (!response.ok) {
      const detail = describeShopifyError(payload);
      throw new Error(`Shopify REST ${method} ${endpoint} failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return payload;
  };
}

function djhcCss() {
  return `/*
 * DJHC Shopify storefront layer.
 * Applied by scripts/apply-shopify-theme.mjs so the Shopify storefront tracks
 * the same brand system as the primary DJ's House of Cards website.
 * Curated sports cards, comics, collectibles, and trusted hobby finds.
 */
:root {
  --djhc-blue: #1f2fa3;
  --djhc-blue-dark: #15206b;
  --djhc-red: #ef1823;
  --djhc-red-dark: #b40f18;
  --djhc-gold: #e4b141;
  --djhc-green: #1b8d3d;
  --djhc-bg: #f3f6fb;
  --djhc-surface: rgba(255, 255, 255, .96);
  --djhc-text: #172033;
  --djhc-muted: #5c667f;
  --djhc-border: rgba(24, 37, 73, .12);
  --djhc-shadow: 0 14px 34px rgba(16, 27, 57, .14);
  --djhc-radius: 22px;
  --djhc-font-body: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --djhc-font-display: "Bebas Neue", "Arial Narrow", Impact, sans-serif;
}

html {
  scroll-behavior: smooth;
}

body {
  color: var(--djhc-text);
  font-family: var(--djhc-font-body);
  background:
    radial-gradient(circle at top left, rgba(31, 47, 163, .10), transparent 34%),
    radial-gradient(circle at top right, rgba(239, 24, 35, .10), transparent 28%),
    linear-gradient(180deg, #f8fbff 0%, #eef3fb 100%);
}

.shopify-section,
.section {
  position: relative;
}

.header,
.header-wrapper,
.shopify-section-group-header-group,
.shopify-section-group-footer-group,
.footer {
  background:
    linear-gradient(180deg, rgba(8, 14, 32, .92), rgba(14, 23, 47, .88)),
    linear-gradient(90deg, var(--djhc-blue), var(--djhc-blue-dark));
  color: #fff;
}

.header-wrapper,
.shopify-section-group-header-group {
  border-bottom: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 12px 30px rgba(0, 0, 0, .18);
}

.header a,
.header button,
.header__heading-link,
.header__menu-item,
.header-actions__action,
.menu-list__link,
.footer a,
.footer button {
  color: #fff;
}

.header__heading,
.header__heading-link,
.header-logo,
.header-logo__link {
  font-family: var(--djhc-font-display);
  letter-spacing: .035em;
  text-transform: uppercase;
}

.header__heading-link::after,
.header-logo__link::after {
  content: "Trusted Hobby Finds";
  display: block;
  margin-top: .15rem;
  color: rgba(255, 255, 255, .82);
  font-family: var(--djhc-font-body);
  font-size: .68rem;
  font-weight: 700;
  letter-spacing: .18em;
  line-height: 1;
}

.menu-list__link,
.header__menu-item {
  border-radius: 999px;
  font-weight: 800;
}

.menu-list__link:hover,
.header__menu-item:hover,
.header-actions__action:hover {
  background: rgba(255, 255, 255, .12);
  color: #fff;
}

.banner,
.banner__box,
.slideshow,
.slideshow__text-wrapper,
.rich-text__wrapper,
.image-with-text,
.multicolumn-card,
.collection-card-wrapper,
.card-wrapper,
.card,
.product-card,
.product-grid__card,
.product-media-container,
.facets-container,
.main-collection-grid,
.cart-drawer,
.drawer,
.product-information,
.product__info-container {
  border: 1px solid var(--djhc-border);
  border-radius: var(--djhc-radius);
  box-shadow: var(--djhc-shadow);
}

.banner,
.banner__box,
.rich-text__wrapper,
.image-with-text,
.product-information,
.product__info-container,
.facets-container,
.main-collection-grid,
.cart-drawer,
.drawer {
  background: var(--djhc-surface);
}

.banner__heading,
.rich-text__heading,
.collection-hero__title,
.main-page-title,
.product__title,
.product-title,
.title,
h1,
h2 {
  color: var(--djhc-text);
  font-family: var(--djhc-font-display);
  letter-spacing: .035em;
}

.banner__text,
.rich-text__text,
.collection-hero__description,
.product__description,
.rte,
.facets__summary,
.caption,
.price-facet__label {
  color: var(--djhc-muted);
}

.button,
.button-primary,
.shopify-payment-button__button,
.product-form__submit,
.add-to-cart-button,
.quick-add__button,
.cart__checkout-button,
.customer button,
.facets__see-results,
.clear-filter.button {
  border: 0;
  border-radius: 999px;
  background: linear-gradient(135deg, var(--djhc-blue), var(--djhc-red));
  color: #fff;
  font-weight: 800;
  letter-spacing: .02em;
  box-shadow: 0 14px 28px rgba(31, 47, 163, .22);
  transition: transform .18s ease, box-shadow .18s ease, opacity .18s ease;
}

.button:hover,
.button-primary:hover,
.shopify-payment-button__button:hover,
.product-form__submit:hover,
.add-to-cart-button:hover,
.quick-add__button:hover,
.cart__checkout-button:hover,
.customer button:hover,
.facets__see-results:hover {
  transform: translateY(-1px);
  box-shadow: 0 18px 34px rgba(31, 47, 163, .28);
}

.button-secondary,
.button-text,
.facets__clear-all,
.facets__clear-all-link,
.clear-filter {
  border-color: rgba(31, 47, 163, .22);
  border-radius: 999px;
  color: var(--djhc-blue);
  font-weight: 800;
}

.product-grid,
.collection-list,
.grid {
  gap: clamp(1rem, 2vw, 1.6rem);
}

.product-grid__card,
.product-card,
.card,
.card-wrapper {
  overflow: hidden;
  background: #fff;
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}

.product-grid__card:hover,
.product-card:hover,
.card-wrapper:hover,
.collection-card-wrapper:hover {
  transform: translateY(-3px);
  border-color: rgba(31, 47, 163, .26);
  box-shadow: 0 18px 42px rgba(16, 27, 57, .18);
}

.product-card__content,
.card__content,
.card-information {
  padding: 1rem;
}

.product-card__link,
.card__heading a,
.full-unstyled-link {
  color: var(--djhc-text);
  font-weight: 850;
}

.product-card__link:hover,
.card__heading a:hover,
.full-unstyled-link:hover {
  color: var(--djhc-blue);
}

.product-media,
.card__media,
.media {
  background:
    linear-gradient(135deg, rgba(31, 47, 163, .08), rgba(239, 24, 35, .08)),
    #fff;
}

.product-media img,
.card__media img,
.product-media__image {
  object-fit: contain;
}

.price,
.price-item,
.price__regular,
.price__sale,
.price-item--sale,
.price-item--regular {
  color: var(--djhc-red);
  font-weight: 900;
}

.badge,
.product-badges .badge,
.card__badge,
.inventory-status,
.product-form__inventory {
  border-radius: 999px;
  background: rgba(228, 177, 65, .18);
  color: #7b5200;
  font-weight: 850;
}

.facet-checkbox,
.facets__summary,
.field__input,
.quantity__input,
.select__select,
input,
select,
textarea {
  border-color: rgba(24, 37, 73, .14);
  border-radius: 14px;
}

.field__input:focus,
.quantity__input:focus,
.select__select:focus,
input:focus,
select:focus,
textarea:focus {
  border-color: var(--djhc-blue);
  box-shadow: 0 0 0 3px rgba(31, 47, 163, .16);
}

.cart-drawer,
.drawer {
  overflow: hidden;
}

.footer {
  border-top: 1px solid rgba(255, 255, 255, .14);
  box-shadow: 0 -12px 30px rgba(0, 0, 0, .14);
}

.footer .footer-block__heading,
.footer h2,
.footer h3 {
  color: #fff;
  font-family: var(--djhc-font-display);
  letter-spacing: .04em;
}

.footer .rte,
.footer p,
.footer small {
  color: rgba(255, 255, 255, .78);
}

@media screen and (max-width: 749px) {
  :root {
    --djhc-radius: 18px;
  }

  .header__heading-link::after,
  .header-logo__link::after {
    font-size: .58rem;
    letter-spacing: .12em;
  }

  .product-card__content,
  .card__content,
  .card-information {
    padding: .85rem;
  }

  .main-collection-grid,
  .facets-container {
    border-radius: 16px;
  }
}

/*
 * Horizon hardening layer.
 * Horizon ships most visual choices through generated color-scheme and spacing
 * classes. These selectors intentionally use higher specificity so the Shopify
 * storefront looks unmistakably connected to the primary DJHC website.
 */
body.page-width-narrow.card-hover-effect-none {
  max-width: none !important;
  background:
    radial-gradient(circle at top left, rgba(31, 47, 163, .16), transparent 32%),
    radial-gradient(circle at top right, rgba(239, 24, 35, .13), transparent 30%),
    linear-gradient(180deg, #f8fbff 0%, #eef3fb 48%, #f3f6fb 100%) !important;
}

.shopify-section-group-header-group,
.header__row.color-scheme-djhc,
.header__row--top.color-scheme-djhc,
.header,
header.header {
  background:
    linear-gradient(180deg, rgba(8, 14, 32, .96), rgba(14, 23, 47, .92)),
    linear-gradient(90deg, var(--djhc-blue-dark), var(--djhc-blue) 58%, var(--djhc-red)) !important;
  border-bottom: 1px solid rgba(255, 255, 255, .16) !important;
  color: #fff !important;
  box-shadow: 0 16px 36px rgba(10, 18, 42, .26) !important;
}

.shopify-section-group-header-group::after,
.header-section::after {
  content: none !important;
  display: none !important;
}

.header a,
.header button,
.header .menu-list__link,
.header .menu-list__link-title,
.header-actions__action,
.header-actions__action svg,
.menu-list__link,
.menu-list__link-title {
  color: #fff !important;
  fill: #fff !important;
}

.header-logo__image,
.header-logo__image-container img {
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, .28)) !important;
  transform: scale(1.06);
}

.announcement-bar,
.announcement-bar.color-scheme-5 {
  background: linear-gradient(90deg, var(--djhc-red-dark), var(--djhc-red), var(--djhc-blue)) !important;
  color: #fff !important;
  font-weight: 900 !important;
}

body:not(:has(.main-collection-grid)):not(:has(.product-information)):not(:has(.product__info-container)) main::before {
  content: none !important;
  display: none !important;
}

.hero-wrapper,
.hero {
  overflow: hidden !important;
  border-radius: 0 0 34px 34px !important;
}

.hero.color-scheme-djhc {
  background:
    radial-gradient(circle at 18% 18%, rgba(228, 177, 65, .34), transparent 27%),
    radial-gradient(circle at 82% 12%, rgba(239, 24, 35, .28), transparent 30%),
    linear-gradient(135deg, rgba(8, 14, 32, .96), rgba(21, 32, 107, .94) 52%, rgba(31, 47, 163, .9)) !important;
}

.hero .text-block,
.hero .text-block p {
  color: #fff !important;
  text-shadow: 0 12px 30px rgba(0, 0, 0, .32) !important;
}

.hero .button {
  min-height: 52px !important;
  padding-inline: 1.8rem !important;
  border: 1px solid rgba(255, 255, 255, .28) !important;
}

.djhc-spotlight {
  width: min(1180px, calc(100% - 2rem));
  margin: 0 auto;
  padding: clamp(1rem, 3vw, 1.65rem);
  border: 1px solid rgba(24, 37, 73, .12);
  border-radius: 18px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, .98), rgba(246, 249, 253, .94)),
    radial-gradient(circle at top right, rgba(228, 177, 65, .18), transparent 34%);
  box-shadow: 0 16px 38px rgba(16, 27, 57, .12);
}

.djhc-spotlight__copy {
  display: grid;
  grid-template-columns: minmax(220px, .72fr) minmax(280px, 1fr);
  gap: 1rem;
  align-items: end;
  margin-bottom: 1rem;
}

.djhc-spotlight__copy h2 {
  margin: 0;
  color: var(--djhc-blue-dark) !important;
  font-family: var(--djhc-font-display);
  font-size: clamp(2rem, 4vw, 3.6rem);
  letter-spacing: .035em;
  line-height: .92;
}

.djhc-spotlight__copy p:last-child {
  margin: 0;
  color: var(--djhc-muted);
  font-weight: 650;
  line-height: 1.55;
}

.djhc-spotlight__rail {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: .9rem;
}

.djhc-spotlight-card {
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto auto;
  gap: .58rem;
  min-height: 100%;
  padding: .72rem;
  border: 1px solid rgba(24, 37, 73, .13);
  border-radius: 12px;
  background: #fff;
  color: var(--djhc-text) !important;
  text-decoration: none;
  box-shadow: 0 10px 24px rgba(16, 27, 57, .10);
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}

.djhc-spotlight-card:hover {
  transform: translateY(-2px);
  border-color: rgba(31, 47, 163, .34);
  box-shadow: 0 16px 34px rgba(16, 27, 57, .16);
}

.djhc-spotlight-card img {
  width: 100%;
  aspect-ratio: 4 / 5;
  object-fit: contain;
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(31, 47, 163, .06), rgba(239, 24, 35, .06)),
    #f8fafc;
}

.djhc-spotlight-card span {
  color: var(--djhc-red);
  font-size: .72rem;
  font-weight: 950;
  letter-spacing: .09em;
  text-transform: uppercase;
}

.djhc-spotlight-card strong {
  display: -webkit-box;
  min-height: 2.6em;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  color: var(--djhc-text);
  font-size: .9rem;
  font-weight: 900;
  line-height: 1.3;
}

.djhc-sync-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: .55rem;
  margin-top: .95rem;
}

.djhc-sync-strip span {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 40px;
  padding: .5rem .7rem;
  border: 1px solid rgba(31, 47, 163, .16);
  border-radius: 999px;
  background: rgba(31, 47, 163, .07);
  color: var(--djhc-blue-dark);
  font-size: .78rem;
  font-weight: 900;
  text-align: center;
}

.djhc-shop-tools,
.djhc-storefront-proof {
  width: min(1180px, calc(100% - 2rem));
  margin: 0 auto;
}

.djhc-shop-tools {
  display: grid;
  grid-template-columns: minmax(260px, .82fr) minmax(0, 1.35fr);
  gap: clamp(1rem, 3vw, 2rem);
  padding: clamp(1.2rem, 3vw, 2rem);
  border: 1px solid rgba(24, 37, 73, .12);
  border-radius: 30px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, .98), rgba(245, 248, 253, .94)),
    radial-gradient(circle at top left, rgba(31, 47, 163, .1), transparent 30%);
  box-shadow: 0 18px 46px rgba(16, 27, 57, .14);
}

.djhc-eyebrow {
  margin: 0 0 .45rem;
  color: var(--djhc-red);
  font-size: .78rem;
  font-weight: 950;
  letter-spacing: .12em;
  text-transform: uppercase;
}

.djhc-shop-tools__intro h2 {
  margin: 0;
  color: var(--djhc-blue-dark);
  font-family: var(--djhc-font-display);
  font-size: clamp(2.2rem, 5vw, 4.2rem);
  letter-spacing: .035em;
  line-height: .9;
}

.djhc-shop-tools__intro p:last-child {
  max-width: 34rem;
  margin: 1rem 0 0;
  color: var(--djhc-muted);
  font-weight: 650;
  line-height: 1.65;
}

.djhc-shop-tools__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: .85rem;
}

.djhc-shop-card {
  display: flex;
  min-height: 118px;
  flex-direction: column;
  justify-content: space-between;
  gap: .7rem;
  padding: 1rem;
  border: 1px solid rgba(24, 37, 73, .13);
  border-radius: 22px;
  background: #fff;
  color: var(--djhc-text) !important;
  text-decoration: none;
  box-shadow: 0 10px 26px rgba(16, 27, 57, .09);
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}

.djhc-shop-card:hover {
  transform: translateY(-3px);
  border-color: rgba(31, 47, 163, .35);
  box-shadow: 0 18px 38px rgba(16, 27, 57, .16);
}

.djhc-shop-card--primary {
  background:
    linear-gradient(135deg, rgba(21, 32, 107, .96), rgba(31, 47, 163, .92) 58%, rgba(239, 24, 35, .9));
  color: #fff !important;
}

.djhc-shop-card strong {
  color: inherit;
  font-size: 1.02rem;
  font-weight: 950;
}

.djhc-shop-card span {
  color: currentColor;
  font-size: .9rem;
  font-weight: 650;
  line-height: 1.45;
  opacity: .78;
}

.djhc-quick-actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: .65rem;
  padding-top: .35rem;
}

.djhc-quick-actions a {
  display: inline-flex;
  align-items: center;
  min-height: 42px;
  padding: .65rem .95rem;
  border: 1px solid rgba(31, 47, 163, .18);
  border-radius: 999px;
  background: rgba(31, 47, 163, .08);
  color: var(--djhc-blue) !important;
  font-size: .88rem;
  font-weight: 900;
  text-decoration: none;
}

.djhc-quick-actions a:hover {
  background: var(--djhc-blue);
  color: #fff !important;
}

.djhc-storefront-proof {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1rem;
}

.djhc-storefront-proof article {
  min-height: 122px;
  padding: 1.15rem;
  border: 1px solid rgba(228, 177, 65, .34);
  border-radius: 24px;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, .97), rgba(255, 248, 226, .78)),
    radial-gradient(circle at top right, rgba(228, 177, 65, .2), transparent 32%);
  box-shadow: 0 14px 32px rgba(16, 27, 57, .1);
}

.djhc-storefront-proof strong {
  display: block;
  color: var(--djhc-blue-dark);
  font-size: 1rem;
  font-weight: 950;
}

.djhc-storefront-proof span {
  display: block;
  margin-top: .55rem;
  color: var(--djhc-muted);
  font-size: .92rem;
  font-weight: 650;
  line-height: 1.5;
}

body:has(.main-collection-grid) main::before {
  content: "Checkout-Ready DJHC Inventory";
  display: block;
  width: min(1180px, calc(100% - 2rem));
  margin: 1.25rem auto 1rem;
  padding: 1.1rem 1.4rem;
  border-radius: 24px;
  background:
    linear-gradient(90deg, var(--djhc-blue-dark), var(--djhc-blue) 62%, var(--djhc-red));
  color: #fff;
  font-family: var(--djhc-font-display);
  font-size: clamp(2rem, 4vw, 3.4rem);
  letter-spacing: .045em;
  text-align: center;
  box-shadow: 0 18px 42px rgba(16, 27, 57, .18);
}

body:has(.main-collection-grid) h1 {
  font-size: 0 !important;
  line-height: 1 !important;
}

body:has(.main-collection-grid) h1::after {
  content: "Shop Cards, Comics & Collectibles";
  display: inline-block;
  color: var(--djhc-text);
  font-family: var(--djhc-font-display);
  font-size: clamp(2.15rem, 5vw, 3.65rem);
  letter-spacing: .04em;
  line-height: .95;
}

main,
.content-for-layout,
.shopify-section,
.section,
.section-content-wrapper {
  background: transparent !important;
}

.collection-wrapper,
.main-collection-grid,
.facets-container,
.product-information,
.product__info-container,
.cart-drawer,
.drawer,
.predictive-search-results__card {
  background: rgba(255, 255, 255, .97) !important;
  border: 1px solid rgba(24, 37, 73, .14) !important;
  border-radius: var(--djhc-radius) !important;
  box-shadow: 0 18px 44px rgba(16, 27, 57, .16) !important;
}

.product-grid__card,
.product-card,
.card-gallery,
.card,
.card-wrapper,
.product-media-container,
.predictive-search-results__card--product {
  overflow: hidden !important;
  background: #fff !important;
  border: 1px solid rgba(24, 37, 73, .16) !important;
  border-radius: 22px !important;
  box-shadow: 0 16px 34px rgba(16, 27, 57, .15) !important;
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease !important;
}

.product-grid__card:hover,
.product-card:hover,
.card-gallery:hover,
.card-wrapper:hover {
  transform: translateY(-4px) !important;
  border-color: rgba(31, 47, 163, .42) !important;
  box-shadow: 0 22px 52px rgba(16, 27, 57, .22) !important;
}

.product-media,
.product-media-container,
.card-gallery,
.card__media,
.media {
  background:
    linear-gradient(135deg, rgba(31, 47, 163, .08), rgba(239, 24, 35, .08)),
    #fff !important;
}

.product-card__content,
.card__content,
.card-information {
  background: #fff !important;
  color: var(--djhc-text) !important;
}

.product-card__link,
.card__heading a,
.full-unstyled-link,
.text-block[class*="product_title"] {
  color: var(--djhc-text) !important;
  font-weight: 900 !important;
}

.price,
.price-item,
.price__regular,
.price__sale,
.price-item--sale,
.price-item--regular {
  color: var(--djhc-red) !important;
  font-size: 1.07rem !important;
  font-weight: 950 !important;
}

.button,
.button-primary,
.button.button,
.shopify-payment-button__button,
.product-form__submit,
.add-to-cart-button,
.quick-add__button,
.cart__checkout-button,
.facets__see-results,
.email-signup__button {
  border: 0 !important;
  border-radius: 999px !important;
  background: linear-gradient(135deg, var(--djhc-blue), var(--djhc-red)) !important;
  color: #fff !important;
  font-weight: 900 !important;
  box-shadow: 0 14px 30px rgba(31, 47, 163, .28) !important;
}

.button-secondary,
.clear-filter.button,
.facets__clear-all,
.facets__clear-all-link {
  border: 1px solid rgba(31, 47, 163, .28) !important;
  border-radius: 999px !important;
  background: #fff !important;
  color: var(--djhc-blue) !important;
  font-weight: 900 !important;
}

.product-badges .badge,
.badge,
.product-form__inventory,
.inventory-status {
  border: 1px solid rgba(228, 177, 65, .42) !important;
  border-radius: 999px !important;
  background: rgba(228, 177, 65, .2) !important;
  color: #6b4700 !important;
  font-weight: 900 !important;
}

.footer,
.shopify-section-group-footer-group,
.footer-content {
  background:
    linear-gradient(180deg, rgba(8, 14, 32, .96), rgba(14, 23, 47, .94)),
    linear-gradient(90deg, var(--djhc-blue-dark), var(--djhc-blue)) !important;
  color: #fff !important;
}

.footer a,
.footer p,
.footer small,
.footer .rte,
.footer-utilities__text {
  color: rgba(255, 255, 255, .86) !important;
}

.shopify-section:has(.product-list),
.shopify-section:has(.product-grid) {
  width: min(1240px, calc(100% - 2rem)) !important;
  margin: 0 auto 2rem !important;
  padding: clamp(1.25rem, 3vw, 2rem) !important;
  border: 1px solid rgba(24, 37, 73, .12) !important;
  border-radius: 30px !important;
  background:
    linear-gradient(180deg, rgba(255, 255, 255, .96), rgba(243, 246, 251, .9)),
    radial-gradient(circle at top left, rgba(31, 47, 163, .09), transparent 28%) !important;
  box-shadow: 0 18px 46px rgba(16, 27, 57, .14) !important;
}

.shopify-section:has(.product-list) h2,
.shopify-section:has(.product-list) h3,
.shopify-section:has(.product-grid) h2,
.shopify-section:has(.product-grid) h3 {
  color: var(--djhc-blue-dark) !important;
  letter-spacing: .04em !important;
}

.shopify-section:has(.product-list)::before {
  content: "Website featured picks";
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  margin-bottom: .85rem;
  padding: .38rem .72rem;
  border: 1px solid rgba(31, 47, 163, .16);
  border-radius: 999px;
  background: rgba(31, 47, 163, .08);
  color: var(--djhc-blue);
  font-size: .78rem;
  font-weight: 950;
  letter-spacing: .1em;
  text-transform: uppercase;
}

.shopify-section:has(.product-list) .product-card,
.shopify-section:has(.product-list) .card-wrapper {
  border-radius: 24px !important;
}

.shopify-section:has(.product-list) .product-media,
.shopify-section:has(.product-list) .card__media,
.shopify-section:has(.product-list) .media {
  min-height: 220px;
}

/*
 * 2026 shopping-layout pass.
 * Keep the DJHC colors, but make the storefront feel easier to scan: product
 * grids should not sit inside decorative cards, media areas should stay stable,
 * and mobile filters/drawers must not introduce horizontal overflow.
 */
html,
body {
  max-width: 100%;
  overflow-x: clip !important;
}

main,
#MainContent,
.content-for-layout,
.shopify-section {
  max-width: 100% !important;
}

main,
#MainContent,
.content-for-layout {
  overflow-x: clip !important;
}

.skip-to-content-link:not(:focus):not(:focus-visible) {
  position: fixed !important;
  inset-block-start: 0 !important;
  inset-inline-start: 0 !important;
  width: 1px !important;
  height: 1px !important;
  overflow: hidden !important;
  clip-path: inset(50%) !important;
  white-space: nowrap !important;
  transform: translateY(-120%) !important;
}

.skip-to-content-link:focus,
.skip-to-content-link:focus-visible {
  position: fixed !important;
  inset-block-start: 1rem !important;
  inset-inline-start: 1rem !important;
  width: auto !important;
  height: auto !important;
  clip-path: none !important;
  transform: none !important;
  z-index: 9999 !important;
}

.shopify-section:has(.product-list),
.shopify-section:has(.product-grid) {
  width: min(1240px, calc(100% - 2rem)) !important;
  margin: 0 auto 2.25rem !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.collection-wrapper,
.main-collection-grid,
.facets-container {
  border-radius: 14px !important;
  box-shadow: 0 10px 24px rgba(16, 27, 57, .09) !important;
}

.product-grid,
.collection-list,
.grid {
  align-items: stretch !important;
}

.product-grid__card,
.product-card,
.card-gallery,
.card,
.card-wrapper,
.product-media-container,
.predictive-search-results__card--product {
  border-radius: 10px !important;
  box-shadow: 0 10px 24px rgba(16, 27, 57, .11) !important;
}

.product-grid__card:hover,
.product-card:hover,
.card-gallery:hover,
.card-wrapper:hover {
  transform: translateY(-2px) !important;
  box-shadow: 0 16px 32px rgba(16, 27, 57, .17) !important;
}

.product-media,
.product-media-container,
.card-gallery,
.card__media,
.media {
  aspect-ratio: 4 / 5 !important;
  min-height: 0 !important;
}

.card-gallery,
.product-media-container,
slideshow-component,
slideshow-container {
  max-width: 100% !important;
  overflow: hidden !important;
}

.card-gallery slideshow-slide,
.product-media-container slideshow-slide {
  max-width: 100% !important;
}

.product-media img,
.product-media-container img,
.card__media img,
.media img,
.product-media__image {
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
}

.product-card__content,
.card__content,
.card-information {
  display: grid !important;
  align-content: start !important;
  gap: .55rem !important;
  padding: .85rem .9rem 1rem !important;
}

.product-card__link,
.card__heading a,
.full-unstyled-link,
.text-block[class*="product_title"] {
  display: -webkit-box !important;
  min-height: 2.7em !important;
  overflow: hidden !important;
  -webkit-box-orient: vertical !important;
  -webkit-line-clamp: 2 !important;
  line-height: 1.35 !important;
}

.facets-container,
.facets,
.facets-vertical,
.facets-wrapper {
  max-width: 100% !important;
}

.facets__summary,
.facet-filters__field,
.mobile-facets__open,
.mobile-facets__close-button {
  min-height: 42px !important;
}

.mobile-facets__inner,
.drawer,
.cart-drawer {
  max-width: min(100vw, 440px) !important;
}

@media screen and (max-width: 749px) {
  .shopify-section-group-header-group::after {
    font-size: .68rem;
    line-height: 1.35;
    padding: .5rem .75rem;
  }

  body:not(:has(.main-collection-grid)):not(:has(.product-information)):not(:has(.product__info-container)) main::before {
    display: none !important;
  }

  body:has(.main-collection-grid) main::before {
    border-radius: 18px;
    font-size: clamp(1.9rem, 10vw, 2.7rem);
  }

  .shopify-section:has(.product-list),
  .shopify-section:has(.product-grid) {
    width: min(100% - 1rem, 720px) !important;
    padding: 1rem !important;
    border-radius: 22px !important;
  }

  .shopify-section:has(.product-list),
  .shopify-section:has(.product-grid) {
    padding: 0 !important;
    border-radius: 0 !important;
  }

  .product-grid__card,
  .product-card,
  .card-gallery,
  .card,
  .card-wrapper {
    border-radius: 9px !important;
  }

  .hero-wrapper,
  .hero {
    border-radius: 0 0 22px 22px !important;
  }

  .djhc-shop-tools,
  .djhc-spotlight,
  .djhc-storefront-proof {
    width: min(100% - 1rem, 720px);
  }

  .djhc-shop-tools,
  .djhc-spotlight__copy,
  .djhc-storefront-proof {
    grid-template-columns: 1fr;
  }

  .djhc-spotlight__rail,
  .djhc-sync-strip {
    grid-template-columns: 1fr 1fr;
  }

  .djhc-sync-strip span {
    border-radius: 12px;
  }

  .djhc-shop-tools__grid {
    grid-template-columns: 1fr;
  }

  .djhc-shop-card {
    min-height: 96px;
  }
}

/* Final override for older mirrored DJHC assets that may still be loaded by the theme. */
body:has(.main-collection-grid) main::before,
body:has(.main-collection-grid) #MainContent::before {
  content: "Checkout-Ready DJHC Inventory" !important;
}
`;
}

function injectStylesheet(layoutLiquid) {
  const injection = [
    '  {% comment %} DJHC custom storefront styling injected by Codex. {% endcomment %}',
    `  ${STYLE_TAG}`
  ].join('\n');
  const normalized = layoutLiquid
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed === '{% comment %} DJHC custom storefront styling injected by Codex. {% endcomment %}') return false;
      if (/^\{% comment %\} djhc-cache-bust-[^%]+ \{% endcomment %\}$/.test(trimmed)) return false;
      return !/^\{\{ 'djhc-[^']+\.css' \| asset_url \| stylesheet_tag \}\}$/.test(trimmed);
    })
    .join('\n');
  if (normalized.includes(STYLE_MARKER)) {
    return { value: normalized, changed: normalized !== layoutLiquid };
  }
  if (normalized.includes('</head>')) {
    return {
      value: normalized.replace('</head>', `${injection}\n</head>`),
      changed: true
    };
  }
  return { value: `${normalized.trimEnd()}\n${injection}\n`, changed: true };
}

function backupLayout(themeId, layoutLiquid) {
  const backupDir = path.join(repoRoot, 'outputs', 'shopify-theme-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${stamp}-theme-${themeId}-layout-theme.liquid`);
  fs.writeFileSync(backupPath, layoutLiquid, 'utf8');
  return backupPath;
}

function themePayload(action, options = {}) {
  const styleAssetKey = options.styleAssetKey || STYLE_ASSET_KEY;
  const styleFilename = path.basename(styleAssetKey);
  const shouldBustLayout = Boolean(options.layoutCacheBust);
  const styleMarker = styleAssetKey === STYLE_ASSET_KEY ? STYLE_MARKER : styleFilename;
  const styleTag = shouldBustLayout
    ? `{% comment %} ${options.layoutCacheBustMarker} {% endcomment %}\n  {{ '${styleFilename}' | asset_url | stylesheet_tag }}`
    : `{{ '${styleFilename}' | asset_url | stylesheet_tag }}`;
  const logoPath = path.join(repoRoot, 'assets', 'dj-logo.png');
  const logoExists = options.includeLogo !== false && fs.existsSync(logoPath);
  return {
    action,
    css: djhcCss(),
    styleAssetKey,
    styleMarker,
    styleTag,
    themeId: themeIdArg || undefined,
    includeLayoutBackup: Boolean(options.includeLayoutBackup),
    logo: logoExists
      ? {
        assetKey: LOGO_ASSET_KEY,
        attachment: action === 'apply' ? fs.readFileSync(logoPath).toString('base64') : ''
      }
      : null
  };
}

async function applyViaSupabase() {
  const { supabaseUrl, serviceRoleKey } = supabaseConfig();
  const action = apply ? 'apply' : 'plan';
  const payloads = [];

  for (const [index, styleAssetKey] of MIRRORED_STYLE_ASSET_KEYS.entries()) {
    const response = await fetch(`${supabaseUrl}/functions/v1/shopify-theme-apply`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(themePayload(action, {
        styleAssetKey,
        includeLogo: index === 0,
        includeLayoutBackup: action === 'apply' && index === 0,
        layoutCacheBust: layoutCacheBust && index === 0,
        layoutCacheBustMarker
      }))
    });

    const payload = await readResponse(response);
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error || `Supabase Shopify theme function failed with HTTP ${response.status}`);
    }
    payloads.push(payload);
  }

  const primaryPayload = payloads[0];
  if (primaryPayload.layoutBackup && primaryPayload.theme?.id) {
    primaryPayload.backupPath = backupLayout(primaryPayload.theme.id, String(primaryPayload.layoutBackup));
    delete primaryPayload.layoutBackup;
  }
  primaryPayload.mirroredStyleAssets = payloads.map((payload) => payload?.changes?.stylesheetAsset).filter(Boolean);
  primaryPayload.mirroredStyleResults = payloads.map((payload) => ({
    stylesheetAsset: payload?.changes?.stylesheetAsset,
    layoutNeedsStylesheetTag: payload?.changes?.layoutNeedsStylesheetTag,
    applied: payload?.applied?.stylesheetAsset || false
  }));
  console.log(JSON.stringify(primaryPayload, null, 2));
}

async function getMainTheme(rest) {
  const payload = await rest('GET', 'themes.json');
  const themes = Array.isArray(payload.themes) ? payload.themes : [];
  if (!themes.length) throw new Error('No Shopify themes were returned for this store.');
  if (themeIdArg) {
    const selected = themes.find((theme) => String(theme.id) === themeIdArg);
    if (!selected) throw new Error(`Theme id ${themeIdArg} was not found.`);
    return selected;
  }
  return themes.find((theme) => theme.role === 'main') || themes[0];
}

async function getThemeAsset(rest, themeId, key) {
  const params = new URLSearchParams({ 'asset[key]': key });
  const payload = await rest('GET', `themes/${themeId}/assets.json?${params}`);
  if (!payload.asset?.value) throw new Error(`Theme asset ${key} did not return editable text.`);
  return String(payload.asset.value);
}

async function putThemeAsset(rest, themeId, asset) {
  return rest('PUT', `themes/${themeId}/assets.json`, { asset });
}

async function main() {
  if (viaSupabase || !hasDirectShopifyAuth()) {
    await applyViaSupabase();
    return;
  }

  const shopDomain = requireShopDomain();
  const token = await shopifyAccessToken(shopDomain);
  const rest = makeRestClient({ shopDomain, token });
  const theme = await getMainTheme(rest);
  const themeId = theme.id;

  const layoutLiquid = await getThemeAsset(rest, themeId, THEME_LAYOUT_KEY);
  const injection = injectStylesheet(layoutLiquid);
  const logoPath = path.join(repoRoot, 'assets', 'dj-logo.png');
  const logoExists = fs.existsSync(logoPath);

  const summary = {
    ok: true,
    apply,
    shopDomain,
    apiVersion,
    theme: {
      id: theme.id,
      name: theme.name,
      role: theme.role
    },
    changes: {
      stylesheetAsset: STYLE_ASSET_KEY,
      mirroredStyleAssets: MIRRORED_STYLE_ASSET_KEYS,
      layoutNeedsStylesheetTag: injection.changed,
      logoAsset: logoExists ? LOGO_ASSET_KEY : null
    }
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const backupPath = backupLayout(themeId, layoutLiquid);
  for (const styleAssetKey of MIRRORED_STYLE_ASSET_KEYS) {
    await putThemeAsset(rest, themeId, {
      key: styleAssetKey,
      value: djhcCss()
    });
  }

  if (injection.changed) {
    await putThemeAsset(rest, themeId, {
      key: THEME_LAYOUT_KEY,
      value: injection.value
    });
  }

  if (logoExists) {
    await putThemeAsset(rest, themeId, {
      key: LOGO_ASSET_KEY,
      attachment: fs.readFileSync(logoPath).toString('base64')
    });
  }

  console.log(JSON.stringify({
    ...summary,
    backupPath,
    applied: {
      stylesheetAsset: true,
      mirroredStyleAssets: MIRRORED_STYLE_ASSET_KEYS,
      layoutStylesheetTag: injection.changed ? 'inserted' : 'already-present',
      logoAsset: logoExists
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
