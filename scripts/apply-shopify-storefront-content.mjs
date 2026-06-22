import fs from 'node:fs';
import path from 'node:path';

const THEME_KEYS = [
  'templates/index.json',
  'sections/header-group.json',
  'sections/footer-group.json'
];
const FEATURED_COLLECTION_HANDLE = 'djhc-featured-showcase';
const MAIN_SITE_URL = 'https://www.djshouseofcards-comics.com/';
const FACEBOOK_URL = 'https://www.facebook.com/DJCardsComics/';
const WHATNOT_URL = 'https://www.whatnot.com/user/djshouseofcards';
const TIKTOK_SHOP_URL = 'https://www.tiktok.com/@djshouseofcards/shop';
const PRODUCT_SPOTLIGHTS = [
  {
    label: 'Baseball auto',
    title: '1997 Just Minors Zach Sorensen Limited Edition Rookie Auto SP',
    href: '/search?q=Zach+Sorensen&type=product',
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/Baseball/Pre-2010/1997%20Just%20Minors%20Zach%20Sorensen%20Limited%20Edition%20Rookie%20Auto%20SP%20(1).jpg`
  },
  {
    label: 'Basketball icons',
    title: '1991-92 Upper Deck Michael Jordan / Magic Johnson Set',
    href: '/search?q=Michael+Jordan+Magic+Johnson&type=product',
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/1900-2000/1991-92%20Upper%20Deck%20Confrontation%20Michael%20Jordan%20Magic%20Johnson%20%2B%201990%20Hoops%20Set%20(1).jpg`
  },
  {
    label: 'Football rookies',
    title: '2001 Pacific Dynagon Chad Johnson + Reggie Wayne Rookie Set',
    href: '/search?q=Chad+Johnson+Reggie+Wayne&type=product',
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/Football/1990-2013/2001%20Pacific%20Dynagon%20Chad%20Johnson%20%23118%20%2B%20Reggie%20Wayne%20%23126%20Rookie%20Set%20(1).jpg`
  },
  {
    label: 'Pop culture',
    title: '2008 Donruss Celebrity Cuts Carrie Fisher /499',
    href: '/search?q=Carrie+Fisher&type=product',
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/MISC/2008%20Donruss%20Celebrity%20Cuts%20Carrie%20Fisher%20Silver%20Foil%20499%20%2312%20Star%20Wars%20(1).jpg`
  }
];

const apply = process.argv.includes('--apply');

function loadLocalEnv() {
  const envPath = path.resolve('codex_account_keys.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    if (!line || /^\s*#/.test(line) || !line.includes('=')) continue;
    const [rawName, ...rest] = line.split('=');
    const name = rawName.trim();
    if (!name || process.env[name]) continue;
    let value = rest.join('=').trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
  }
}

function supabaseConfig() {
  const supabaseUrl = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(supabaseUrl) || !serviceRoleKey) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before applying Shopify storefront content.');
  }
  return { supabaseUrl, serviceRoleKey };
}

async function callThemeFunction(payload) {
  const { supabaseUrl, serviceRoleKey } = supabaseConfig();
  const response = await fetch(`${supabaseUrl}/functions/v1/shopify-theme-apply`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok || result?.ok !== true) {
    throw new Error(result?.error || `Shopify theme function failed with HTTP ${response.status}`);
  }
  return result;
}

function findSectionByType(template, type) {
  return Object.values(template.sections || {}).find((section) => section?.type === type) || null;
}

function firstBlockByType(section, type) {
  return Object.values(section?.blocks || {}).find((block) => block?.type === type) || null;
}

function backupThemeAssets(theme, assets) {
  const backupDir = path.resolve('outputs', 'shopify-theme-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const themeId = String(theme?.id || 'unknown').replace(/[^0-9A-Za-z_-]/g, '-');
  const manifest = {};

  for (const [key, value] of Object.entries(assets || {})) {
    const safeKey = key.replace(/[\\/]/g, '__').replace(/[^0-9A-Za-z._-]/g, '-');
    const backupPath = path.join(backupDir, `${stamp}-theme-${themeId}-${safeKey}`);
    fs.writeFileSync(backupPath, String(value || ''), 'utf8');
    manifest[key] = path.relative(process.cwd(), backupPath).replaceAll('\\', '/');
  }

  const manifestPath = path.join(backupDir, `${stamp}-theme-${themeId}-storefront-content-manifest.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify({ theme, assets: manifest }, null, 2)}\n`, 'utf8');
  return path.relative(process.cwd(), manifestPath).replaceAll('\\', '/');
}

function customLiquidSection(customLiquid, { colorScheme = 'scheme-1', paddingStart = 0, paddingEnd = 0 } = {}) {
  return {
    type: 'custom-liquid',
    settings: {
      custom_liquid: customLiquid.trim(),
      color_scheme: colorScheme,
      section_width: 'page-width',
      'padding-block-start': paddingStart,
      'padding-block-end': paddingEnd
    }
  };
}

function placeSectionFirst(template, sectionId) {
  const currentOrder = Array.isArray(template.order) ? template.order : Object.keys(template.sections || {});
  template.order = [sectionId, ...currentOrder.filter((id) => id !== sectionId)];
}

function placeSectionAfter(template, sectionId, afterSectionId) {
  const currentOrder = Array.isArray(template.order) ? template.order : Object.keys(template.sections || {});
  const order = currentOrder.filter((id) => id !== sectionId);
  const afterIndex = afterSectionId ? order.indexOf(afterSectionId) : -1;
  order.splice(afterIndex >= 0 ? afterIndex + 1 : order.length, 0, sectionId);
  template.order = order;
}

function storefrontHeroMarkup() {
  const heroImages = PRODUCT_SPOTLIGHTS.map((item) => `
    <img src="${item.image}" alt="" loading="eager" decoding="async">
  `).join('');

  return `
<section class="djhc-hero" aria-labelledby="djhc-hero-heading">
  <div class="djhc-hero__media" aria-hidden="true">
    ${heroImages}
  </div>
  <div class="djhc-hero__shade" aria-hidden="true"></div>
  <div class="djhc-hero__content">
    <p class="djhc-eyebrow">Collector-run shop</p>
    <h1 id="djhc-hero-heading">DJ's House of Cards & Comics</h1>
    <p>Sports cards, comics, autographs, memorabilia, and oddball hobby finds with clear photos and Shopify checkout.</p>
    <div class="djhc-hero__actions" aria-label="Primary shopping actions">
      <a class="djhc-hero__button" href="/collections/all">Shop all inventory</a>
      <a class="djhc-hero__button djhc-hero__button--secondary" href="#djhc-inventory-search">Search inventory</a>
      <a class="djhc-hero__button djhc-hero__button--secondary" href="${MAIN_SITE_URL}sell-trade-want-list.html" target="_blank" rel="noopener noreferrer">Sell / Trade</a>
    </div>
    <dl class="djhc-hero__facts">
      <div><dt>Inventory</dt><dd>Thousands of one-of-a-kind listings</dd></div>
      <div><dt>Details</dt><dd>Actual item photos and condition notes</dd></div>
      <div><dt>Checkout</dt><dd>Secure Shopify purchasing</dd></div>
    </dl>
  </div>
</section>
`;
}

function storefrontToolsMarkup() {
  return `
<section class="djhc-shop-tools" aria-labelledby="djhc-shop-tools-heading">
  <div class="djhc-shop-tools__intro">
    <p class="djhc-eyebrow">Shop by department</p>
    <h2 id="djhc-shop-tools-heading">Cards, comics, and collectible finds.</h2>
    <p>Start with the full Shopify catalog or narrow the browse by the areas collectors ask for most.</p>
  </div>
  <div class="djhc-shop-tools__grid" aria-label="Shop by lane">
    <a class="djhc-shop-card djhc-shop-card--primary" href="/collections/all">
      <strong>All Inventory</strong>
      <span>Browse every active listing available through Shopify checkout.</span>
    </a>
    <a class="djhc-shop-card" href="/collections/djhc-featured-showcase">
      <strong>Featured Picks</strong>
      <span>A rotating set of cards, comics, and collectibles worth a closer look.</span>
    </a>
    <a class="djhc-shop-card" href="/search?q=baseball&type=product">
      <strong>Baseball Cards</strong>
      <span>Vintage stars, modern rookies, autos, and slabs.</span>
    </a>
    <a class="djhc-shop-card" href="/search?q=basketball&type=product">
      <strong>Basketball Cards</strong>
      <span>Modern parallels, graded rookies, and inserts.</span>
    </a>
    <a class="djhc-shop-card" href="/search?q=football&type=product">
      <strong>Football Cards</strong>
      <span>Hall of Fame names, rookies, and standout singles.</span>
    </a>
    <a class="djhc-shop-card" href="/collections/comics">
      <strong>Comics</strong>
      <span>Reader copies, collectible issues, keys, and character favorites.</span>
    </a>
    <a class="djhc-shop-card" href="/collections/collectibles">
      <strong>Collectibles</strong>
      <span>Autographs, memorabilia, and oddball hobby finds.</span>
    </a>
  </div>
  <nav class="djhc-quick-actions" aria-label="Buyer shortcuts">
    <a href="/search">Search</a>
    <a href="/cart">Cart</a>
    <a href="/account">Account</a>
    <a href="${MAIN_SITE_URL}wishlist.html" target="_blank" rel="noopener noreferrer">Wishlist</a>
    <a href="${MAIN_SITE_URL}sell-trade-want-list.html" target="_blank" rel="noopener noreferrer">Sell / Trade</a>
    <a href="${FACEBOOK_URL}" target="_blank" rel="noopener noreferrer">Facebook</a>
    <a href="${WHATNOT_URL}" target="_blank" rel="noopener noreferrer">Whatnot</a>
    <a href="${TIKTOK_SHOP_URL}" target="_blank" rel="noopener noreferrer">TikTok Shop</a>
  </nav>
</section>
`;
}

function storefrontSpotlightMarkup() {
  const cards = PRODUCT_SPOTLIGHTS.map((item) => `
    <a class="djhc-spotlight-card" href="${item.href}">
      <img src="${item.image}" alt="${item.title}" loading="lazy" decoding="async">
      <span>${item.label}</span>
      <strong>${item.title}</strong>
    </a>
  `).join('');

  return `
<section class="djhc-spotlight" id="djhc-inventory-search" aria-labelledby="djhc-spotlight-heading">
  <div class="djhc-spotlight__copy">
    <div>
      <p class="djhc-eyebrow">Inventory search</p>
      <h2 id="djhc-spotlight-heading">Find the player, set, title, or team you collect.</h2>
    </div>
    <form class="djhc-inventory-search" action="/search" method="get" role="search">
      <label for="djhc-search-query">Search all Shopify listings</label>
      <div>
        <input id="djhc-search-query" name="q" type="search" placeholder="Try Michael Jordan, Topps, Batman..." autocomplete="off">
        <input name="type" type="hidden" value="product">
        <button type="submit">Search inventory</button>
      </div>
    </form>
  </div>
  <p class="djhc-spotlight__hint">A few examples from the catalog. Select one to search for the matching listing without leaving Shopify.</p>
  <div class="djhc-spotlight__rail" aria-label="Representative DJHC inventory">
    ${cards}
  </div>
</section>
`;
}

function storefrontProofMarkup() {
  return `
<section class="djhc-storefront-proof" aria-label="Why shop DJ's House on Shopify">
  <article>
    <strong>Actual items shown</strong>
    <span>Listings use the product photos and details available for the item being sold.</span>
  </article>
  <article>
    <strong>Collector-run selection</strong>
    <span>The catalog is built around recognizable players, teams, eras, characters, and hobby categories.</span>
  </article>
  <article>
    <strong>Review before purchase</strong>
    <span>Sales are final, so review the photos, description, condition, and shipping details before checkout.</span>
  </article>
</section>
`;
}

function updateHomepage(rawJson) {
  const template = JSON.parse(rawJson);
  const changes = [];
  const hero = findSectionByType(template, 'hero');
  const heroSectionId = hero
    ? Object.keys(template.sections || {}).find((id) => template.sections[id] === hero)
    : null;
  const productList = findSectionByType(template, 'product-list');

  if (hero) {
    const heroText = firstBlockByType(hero, 'text');
    const heroButton = firstBlockByType(hero, 'button');
    if (heroText?.settings) {
      heroText.settings.text = "<p>DJ's House of Cards & Comics</p><p>Sports cards, comics, and collectible finds from a collector-run shop.</p>";
      heroText.settings.alignment = 'center';
      heroText.settings.width = 'fill';
      heroText.settings.max_width = 'wide';
      heroText.settings.type_preset = 'h1';
      heroText.settings.font_size = '4rem';
      heroText.settings.line_height = '1.04';
      heroText.settings.letter_spacing = '0';
      heroText.settings.case = 'none';
      heroText.settings.color = '#ffffff';
      changes.push('homepage hero headline');
    }
    if (heroButton?.settings) {
      heroButton.settings.label = 'Shop all inventory';
      heroButton.settings.link = 'shopify://collections/all';
      heroButton.settings.style_class = 'button';
      changes.push('homepage hero button');
    }
    hero.settings.color_scheme = 'scheme-djhc';
    hero.settings.horizontal_alignment_flex_direction_column = 'center';
    hero.settings.vertical_alignment_flex_direction_column = 'center';
    hero.settings.vertical_alignment = 'center';
    hero.settings.toggle_overlay = true;
    hero.settings.overlay_color = '#101829cc';
    hero.settings['padding-block-start'] = 88;
    hero.settings['padding-block-end'] = 72;
    changes.push('homepage hero layout');
  }

  template.sections ||= {};
  template.sections.djhc_hero = customLiquidSection(storefrontHeroMarkup(), {
    colorScheme: 'scheme-djhc',
    paddingStart: 0,
    paddingEnd: 0
  });
  placeSectionFirst(template, 'djhc_hero');
  if (heroSectionId) {
    delete template.sections[heroSectionId];
    template.order = template.order.filter((id) => id !== heroSectionId);
  }
  changes.push('custom DJHC hero');

  template.sections.djhc_spotlight = customLiquidSection(storefrontSpotlightMarkup(), {
    colorScheme: 'scheme-1',
    paddingStart: 24,
    paddingEnd: 18
  });
  placeSectionAfter(template, 'djhc_spotlight', 'djhc_hero');
  changes.push('homepage product spotlight');

  template.sections.djhc_shop_tools = customLiquidSection(storefrontToolsMarkup(), {
    colorScheme: 'scheme-1',
    paddingStart: 28,
    paddingEnd: 20
  });
  placeSectionAfter(template, 'djhc_shop_tools', 'djhc_spotlight');
  changes.push('homepage shop lane shortcuts');

  template.sections.djhc_storefront_proof = customLiquidSection(storefrontProofMarkup(), {
    colorScheme: 'scheme-1',
    paddingStart: 0,
    paddingEnd: 28
  });
  placeSectionAfter(template, 'djhc_storefront_proof', 'djhc_shop_tools');
  changes.push('homepage buyer proof strip');

  if (productList) {
    productList.name = 'Featured DJHC Showcase';
    productList.settings.collection = FEATURED_COLLECTION_HANDLE;
    productList.settings.max_products = 8;
    productList.settings.columns = 4;
    productList.settings.columns_gap = 18;
    productList.settings.rows_gap = 30;
    productList.settings.color_scheme = 'scheme-1';
    productList.settings['padding-block-start'] = 42;
    productList.settings['padding-block-end'] = 64;
    const staticHeader = productList.blocks?.['static-header'];
    const title = Object.values(staticHeader?.blocks || {}).find((block) => block?.type === '_product-list-text');
    const button = Object.values(staticHeader?.blocks || {}).find((block) => block?.type === '_product-list-button');
    if (title?.settings) {
      title.settings.text = '<h3>Featured picks</h3>';
      title.settings.type_preset = 'h3';
      title.settings.font_size = '2.2rem';
      title.settings.color = 'var(--djhc-text)';
      changes.push('featured collection heading');
    }
    if (button?.settings) {
      button.settings.label = 'View featured picks';
      button.settings.link = `shopify://collections/${FEATURED_COLLECTION_HANDLE}`;
      button.settings.style_class = 'button-secondary';
      changes.push('featured collection button');
    }
  }

  return { value: JSON.stringify(template, null, 2), changes };
}

function updateHeader(rawJson) {
  const header = JSON.parse(rawJson);
  const changes = [];
  const sections = header.sections || {};
  const announcements = Object.values(sections).find((section) => section?.type === 'header-announcements');
  const announcement = Object.values(announcements?.blocks || {}).find((block) => block?.type === '_announcement');
  if (announcement?.settings) {
    announcement.settings.text = 'Actual item photos | Secure Shopify checkout | Collector-run inventory';
    announcement.settings.font_size = '0.82rem';
    announcement.settings.weight = '700';
    announcement.settings.letter_spacing = '0';
    announcement.settings.case = 'none';
    changes.push('announcement text');
  }

  const headerSection = Object.values(sections).find((section) => section?.type === 'header');
  if (headerSection?.settings) {
    headerSection.settings.show_country = false;
    headerSection.settings.show_language = false;
    headerSection.settings.enable_transparent_header_home = false;
    headerSection.settings.color_scheme_top = 'scheme-djhc';
    changes.push('header settings');
  }

  return { value: JSON.stringify(header, null, 2), changes };
}

function updateFooter(rawJson) {
  const footer = JSON.parse(rawJson);
  const changes = [];
  const footerSection = Object.values(footer.sections || {}).find((section) => section?.type === 'footer');
  const utilitySection = Object.values(footer.sections || {}).find((section) => section?.type === 'footer-utilities');

  const group = Object.values(footerSection?.blocks || {}).find((block) => block?.type === 'group');
  const textBlocks = Object.values(group?.blocks || {}).filter((block) => block?.type === 'text');
  if (textBlocks[0]?.settings) {
    textBlocks[0].settings.text = "<h2>Follow DJ's House</h2>";
    textBlocks[0].settings.type_preset = 'h3';
    changes.push('footer heading');
  }
  if (textBlocks[1]?.settings) {
    textBlocks[1].settings.text = `<p>Shop here through Shopify, browse the full DJHC catalog on the <a href="${MAIN_SITE_URL}">main website</a>, or follow along on <a href="${FACEBOOK_URL}">Facebook</a>, <a href="${WHATNOT_URL}">Whatnot</a>, and <a href="${TIKTOK_SHOP_URL}">TikTok Shop</a>.</p><p><a href="/policies/refund-policy">Final-sale policy</a> · <a href="/policies/shipping-policy">Shipping policy</a> · <a href="/policies/privacy-policy">Privacy</a> · <a href="/policies/terms-of-service">Terms</a></p>`;
    changes.push('footer body copy');
  }
  if (footerSection?.settings) {
    footerSection.settings.color_scheme = 'scheme-djhc';
    footerSection.settings['padding-block-start'] = 44;
    footerSection.settings['padding-block-end'] = 38;
    changes.push('footer section spacing');
  }

  const copyright = Object.values(utilitySection?.blocks || {}).find((block) => block?.type === 'footer-copyright');
  if (copyright?.settings) {
    copyright.settings.show_powered_by = false;
    changes.push('hide powered-by text');
  }
  const socials = Object.values(utilitySection?.blocks || {}).find((block) => block?.type === 'social-links');
  if (socials?.settings) {
    socials.settings.facebook_url = FACEBOOK_URL;
    socials.settings.instagram_url = '';
    socials.settings.youtube_url = '';
    socials.settings.tiktok_url = 'https://www.tiktok.com/@djshouseofcards';
    socials.settings.twitter_url = '';
    changes.push('footer social links');
  }

  return { value: JSON.stringify(footer, null, 2), changes };
}

async function main() {
  loadLocalEnv();
  const inspected = await callThemeFunction({ action: 'inspect', inspectKeys: THEME_KEYS });
  const assets = inspected.assets || {};
  const updates = {
    'templates/index.json': updateHomepage(assets['templates/index.json']),
    'sections/header-group.json': updateHeader(assets['sections/header-group.json']),
    'sections/footer-group.json': updateFooter(assets['sections/footer-group.json'])
  };

  const summary = {
    ok: true,
    apply,
    theme: inspected.theme,
    changes: Object.fromEntries(Object.entries(updates).map(([key, update]) => [key, update.changes]))
  };

  if (!apply) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  summary.backupManifestPath = backupThemeAssets(inspected.theme, assets);

  const result = await callThemeFunction({
    action: 'apply',
    themeAssets: Object.entries(updates).map(([key, update]) => ({
      key,
      value: update.value
    }))
  });

  console.log(JSON.stringify({ ...summary, applied: result.applied }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
