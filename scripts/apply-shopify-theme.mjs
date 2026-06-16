import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API_VERSION = '2026-04';
const STYLE_ASSET_KEY = 'assets/djhc-custom.css';
const LOGO_ASSET_KEY = 'assets/dj-logo.png';
const THEME_LAYOUT_KEY = 'layout/theme.liquid';
const STYLE_TAG = "{{ 'djhc-custom.css' | asset_url | stylesheet_tag }}";
const STYLE_MARKER = 'djhc-custom.css';
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const viaSupabase = args.has('--via-supabase');
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
`;
}

function injectStylesheet(layoutLiquid) {
  if (layoutLiquid.includes(STYLE_MARKER)) {
    return { value: layoutLiquid, changed: false };
  }
  const injection = [
    '  {% comment %} DJHC custom storefront styling injected by Codex. {% endcomment %}',
    `  ${STYLE_TAG}`
  ].join('\n');
  if (layoutLiquid.includes('</head>')) {
    return {
      value: layoutLiquid.replace('</head>', `${injection}\n</head>`),
      changed: true
    };
  }
  return { value: `${layoutLiquid.trimEnd()}\n${injection}\n`, changed: true };
}

function backupLayout(themeId, layoutLiquid) {
  const backupDir = path.join(repoRoot, 'outputs', 'shopify-theme-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${stamp}-theme-${themeId}-layout-theme.liquid`);
  fs.writeFileSync(backupPath, layoutLiquid, 'utf8');
  return backupPath;
}

function themePayload(action) {
  const logoPath = path.join(repoRoot, 'assets', 'dj-logo.png');
  const logoExists = fs.existsSync(logoPath);
  return {
    action,
    css: djhcCss(),
    styleAssetKey: STYLE_ASSET_KEY,
    styleMarker: STYLE_MARKER,
    styleTag: STYLE_TAG,
    themeId: themeIdArg || undefined,
    includeLayoutBackup: action === 'apply',
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
  const response = await fetch(`${supabaseUrl}/functions/v1/shopify-theme-apply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(themePayload(action))
  });

  const payload = await readResponse(response);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error || `Supabase Shopify theme function failed with HTTP ${response.status}`);
  }

  if (payload.layoutBackup && payload.theme?.id) {
    payload.backupPath = backupLayout(payload.theme.id, String(payload.layoutBackup));
    delete payload.layoutBackup;
  }
  console.log(JSON.stringify(payload, null, 2));
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
      layoutNeedsStylesheetTag: injection.changed,
      logoAsset: logoExists ? LOGO_ASSET_KEY : null
    }
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const backupPath = backupLayout(themeId, layoutLiquid);
  await putThemeAsset(rest, themeId, {
    key: STYLE_ASSET_KEY,
    value: djhcCss()
  });

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
      layoutStylesheetTag: injection.changed ? 'inserted' : 'already-present',
      logoAsset: logoExists
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
