import fs from 'node:fs';
import path from 'node:path';

const THEME_KEYS = [
  'templates/index.json',
  'sections/header-group.json',
  'sections/footer-group.json'
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

function updateHomepage(rawJson) {
  const template = JSON.parse(rawJson);
  const changes = [];
  const hero = findSectionByType(template, 'hero');
  const productList = findSectionByType(template, 'product-list');

  if (hero) {
    const heroText = firstBlockByType(hero, 'text');
    const heroButton = firstBlockByType(hero, 'button');
    if (heroText?.settings) {
      heroText.settings.text = "<p>DJ's House of Cards & Comics</p><p>Trusted hobby finds for sports cards, comics & collectibles.</p>";
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
      heroButton.settings.label = 'Shop Inventory';
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
    hero.settings['padding-block-start'] = 100;
    hero.settings['padding-block-end'] = 96;
    changes.push('homepage hero layout');
  }

  if (productList) {
    productList.name = 'Latest DJHC Inventory';
    productList.settings.collection = 'all';
    productList.settings.max_products = 12;
    productList.settings.columns = 4;
    productList.settings.columns_gap = 18;
    productList.settings.rows_gap = 30;
    productList.settings.color_scheme = 'scheme-1';
    productList.settings['padding-block-start'] = 56;
    productList.settings['padding-block-end'] = 64;
    const staticHeader = productList.blocks?.['static-header'];
    const title = Object.values(staticHeader?.blocks || {}).find((block) => block?.type === '_product-list-text');
    const button = Object.values(staticHeader?.blocks || {}).find((block) => block?.type === '_product-list-button');
    if (title?.settings) {
      title.settings.text = '<h3>Latest DJHC Inventory</h3>';
      title.settings.type_preset = 'h3';
      title.settings.font_size = 'clamp(1.8rem, 3vw, 3rem)';
      title.settings.color = 'var(--djhc-text)';
      changes.push('featured collection heading');
    }
    if (button?.settings) {
      button.settings.label = 'View full catalog';
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
    textBlocks[1].settings.text = '<p>Get first look at fresh cards, comics, collectibles, and storefront updates.</p>';
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
    socials.settings.facebook_url = 'https://www.facebook.com/DJCardsComics/';
    socials.settings.instagram_url = '';
    socials.settings.youtube_url = '';
    socials.settings.tiktok_url = '';
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
