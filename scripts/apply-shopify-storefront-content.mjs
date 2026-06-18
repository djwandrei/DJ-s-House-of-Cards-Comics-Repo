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
    href: `${MAIN_SITE_URL}baseball-cards.html?item=856`,
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/Baseball/Pre-2010/1997%20Just%20Minors%20Zach%20Sorensen%20Limited%20Edition%20Rookie%20Auto%20SP%20(1).jpg`
  },
  {
    label: 'Basketball icons',
    title: '1991-92 Upper Deck Michael Jordan / Magic Johnson Set',
    href: `${MAIN_SITE_URL}basketball-cards.html?item=854`,
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/1900-2000/1991-92%20Upper%20Deck%20Confrontation%20Michael%20Jordan%20Magic%20Johnson%20%2B%201990%20Hoops%20Set%20(1).jpg`
  },
  {
    label: 'Football rookies',
    title: '2001 Pacific Dynagon Chad Johnson + Reggie Wayne Rookie Set',
    href: `${MAIN_SITE_URL}football-cards.html?item=861`,
    image: `${MAIN_SITE_URL}assets/Ebay%20Listing%20Photos/Football/1990-2013/2001%20Pacific%20Dynagon%20Chad%20Johnson%20%23118%20%2B%20Reggie%20Wayne%20%23126%20Rookie%20Set%20(1).jpg`
  },
  {
    label: 'Pop culture',
    title: '2008 Donruss Celebrity Cuts Carrie Fisher /499',
    href: `${MAIN_SITE_URL}collectibles.html?item=888`,
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

function placeSectionAfter(template, sectionId, afterSectionId) {
  const currentOrder = Array.isArray(template.order) ? template.order : Object.keys(template.sections || {});
  const order = currentOrder.filter((id) => id !== sectionId);
  const afterIndex = afterSectionId ? order.indexOf(afterSectionId) : -1;
  order.splice(afterIndex >= 0 ? afterIndex + 1 : order.length, 0, sectionId);
  template.order = order;
}

function storefrontToolsMarkup() {
  return `
<section class="djhc-shop-tools" aria-labelledby="djhc-shop-tools-heading">
  <div class="djhc-shop-tools__intro">
    <p class="djhc-eyebrow">Shop the collection</p>
    <h2 id="djhc-shop-tools-heading">Find the right lane fast.</h2>
    <p>Use Shopify for cart checkout, then jump to the main DJHC site when you want wishlist, sell/trade, and deeper collector tools.</p>
  </div>
  <div class="djhc-shop-tools__grid" aria-label="Shop by lane">
    <a class="djhc-shop-card djhc-shop-card--primary" href="/collections/all">
      <strong>All Shopify Inventory</strong>
      <span>Browse every active checkout-ready listing.</span>
    </a>
    <a class="djhc-shop-card" href="/collections/djhc-featured-showcase">
      <strong>Featured Showcase</strong>
      <span>Curated high-signal pieces from the website.</span>
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
      <span>Bronze Age favorites, keys, and collectible issues.</span>
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
    <a href="${MAIN_SITE_URL}wishlist.html" target="_blank" rel="noopener noreferrer">Website Wishlist</a>
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
    <a class="djhc-spotlight-card" href="${item.href}" target="_blank" rel="noopener noreferrer">
      <img src="${item.image}" alt="${item.title}" loading="lazy" decoding="async">
      <span>${item.label}</span>
      <strong>${item.title}</strong>
    </a>
  `).join('');

  return `
<section class="djhc-spotlight" aria-labelledby="djhc-spotlight-heading">
  <div class="djhc-spotlight__copy">
    <p class="djhc-eyebrow">Fresh from the catalog</p>
    <h2 id="djhc-spotlight-heading">Real inventory, ready to inspect.</h2>
    <p>Shopify handles checkout while the main DJHC catalog remains the source for deeper photos, wishlist decisions, and cross-marketplace reconciliation.</p>
  </div>
  <div class="djhc-spotlight__rail" aria-label="Representative DJHC inventory">
    ${cards}
  </div>
  <div class="djhc-sync-strip" aria-label="Marketplace sync status">
    <span>Website catalog source</span>
    <span>Shopify checkout active</span>
    <span>Facebook feed prepared</span>
    <span>Whatnot/TikTok links ready</span>
  </div>
</section>
`;
}

function storefrontProofMarkup() {
  return `
<section class="djhc-storefront-proof" aria-label="Why shop DJ's House on Shopify">
  <article>
    <strong>Checkout-ready catalog</strong>
    <span>Active marketplace listings stay keyed to DJHC inventory, pricing, images, and quantities.</span>
  </article>
  <article>
    <strong>Collector-first browsing</strong>
    <span>Shop by lane, search by player or set, and use the main site wishlist for longer decisions.</span>
  </article>
  <article>
    <strong>Trusted hobby finds</strong>
    <span>Cards, comics, autographs, memorabilia, and showcase pieces selected with collector context.</span>
  </article>
</section>
`;
}

function updateHomepage(rawJson) {
  const template = JSON.parse(rawJson);
  const changes = [];
  const hero = findSectionByType(template, 'hero');
  const productList = findSectionByType(template, 'product-list');

  if (hero) {
    const heroText = firstBlockByType(hero, 'text');
    const heroButton = firstBlockByType(hero, 'button');
    if (heroText?.settings) {
      heroText.settings.text = "<p>DJ's House of Cards & Comics</p><p>Sports cards, comics & collectibles with checkout-ready listings and deeper collector context on the main DJHC site.</p>";
      heroText.settings.alignment = 'center';
      heroText.settings.width = 'fill';
      heroText.settings.max_width = 'wide';
      heroText.settings.type_preset = 'h1';
      heroText.settings.font_size = 'clamp(2.5rem, 6vw, 5rem)';
      heroText.settings.line_height = '0.95';
      heroText.settings.letter_spacing = '0.03em';
      heroText.settings.case = 'none';
      heroText.settings.color = '#ffffff';
      changes.push('homepage hero headline');
    }
    if (heroButton?.settings) {
      heroButton.settings.label = 'Shop Featured Showcase';
      heroButton.settings.link = `shopify://collections/${FEATURED_COLLECTION_HANDLE}`;
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
  template.sections.djhc_spotlight = customLiquidSection(storefrontSpotlightMarkup(), {
    colorScheme: 'scheme-1',
    paddingStart: 24,
    paddingEnd: 18
  });
  placeSectionAfter(template, 'djhc_spotlight', hero ? Object.keys(template.sections).find((id) => template.sections[id] === hero) : null);
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
      title.settings.text = '<h3>Featured DJHC Showcase</h3>';
      title.settings.type_preset = 'h3';
      title.settings.font_size = 'clamp(1.8rem, 3vw, 3rem)';
      title.settings.color = 'var(--djhc-text)';
      changes.push('featured collection heading');
    }
    if (button?.settings) {
      button.settings.label = 'View full featured showcase';
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
    announcement.settings.text = 'Trusted hobby finds | Sports cards, comics, collectibles, and new inventory added regularly';
    announcement.settings.font_size = '0.82rem';
    announcement.settings.weight = '700';
    announcement.settings.letter_spacing = '0.08em';
    announcement.settings.case = 'uppercase';
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
    textBlocks[0].settings.text = "<h2>Stay Close to DJ's House</h2>";
    textBlocks[0].settings.type_preset = 'h3';
    changes.push('footer heading');
  }
  if (textBlocks[1]?.settings) {
    textBlocks[1].settings.text = `<p>Get first look at fresh cards, comics, collectibles, and storefront updates. Visit the <a href="${MAIN_SITE_URL}">main DJHC website</a>, <a href="${FACEBOOK_URL}">Facebook</a>, <a href="${WHATNOT_URL}">Whatnot</a>, or <a href="${TIKTOK_SHOP_URL}">TikTok Shop</a>.</p>`;
    changes.push('footer signup copy');
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
