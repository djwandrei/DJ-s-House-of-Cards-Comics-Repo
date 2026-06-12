import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Make Supabase catalog membership exactly match products.json.
 *
 * The audit mode reports remote-only rows. --apply first upserts the complete
 * local catalog, writes a backup of remote-only rows, then permanently deletes
 * those rows. This is intentionally the only catalog reconciliation script
 * allowed to remove listings.
 */

const root = process.cwd();
const applyChanges = process.argv.includes('--apply');
const configText = await fs.readFile(path.join(root, 'backend-config.js'), 'utf8');
const products = JSON.parse(await fs.readFile(path.join(root, 'products.json'), 'utf8'));

function configValue(name) {
  return configText.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1] || '';
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchAllRows(projectUrl, apiKey, table) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      select: '*',
      limit: '1000',
      offset: String(offset),
      order: 'id.asc'
    });
    const page = await requestJson(`${projectUrl}/rest/v1/${table}?${query}`, {
      headers: { apikey: apiKey, Authorization: `Bearer ${apiKey}` }
    });
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

function array(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function remoteProduct(product) {
  return {
    id: Number(product.id),
    name: String(product.name || '').trim(),
    category: String(product.category || 'Other').trim() || 'Other',
    team: String(product.team || '').trim(),
    year: Number.isFinite(Number(product.year)) ? Number(product.year) : null,
    condition: String(product.condition || '').trim(),
    price: Number.isFinite(Number(product.price)) ? Number(product.price) : null,
    price_label: String(product.priceLabel || '').trim(),
    display_price: String(product.displayPrice || '').trim(),
    image: String(product.image || '').trim(),
    image_gallery: array(product.imageGallery),
    description: String(product.description || '').trim(),
    photo_host_page_url: String(product.photoHostPageUrl || '').trim(),
    legacy_image_label: String(product.legacyImageLabel || '').trim(),
    source_page: String(product.sourcePage || '').trim(),
    league: String(product.league || '').trim(),
    sport: String(product.sport || '').trim(),
    player_athlete: String(product.playerAthlete || '').trim(),
    is_featured: product.isFeatured === true,
    is_deleted: false,
    sort_rank: Number.isFinite(Number(product.sortRank)) ? Number(product.sortRank) : Number(product.id),
    copy_count: Number.isFinite(Number(product.copyCount)) ? Number(product.copyCount) : 1,
    item_photo_url: String(product.itemPhotoUrl || '').trim(),
    item_photo_urls: array(product.itemPhotoUrls),
    html_full_link: String(product.htmlFullLink || '').trim(),
    html_image_urls: array(product.htmlImageUrls),
    metadata: product.metadata && typeof product.metadata === 'object' ? product.metadata : {}
  };
}

async function upsertCatalog(projectUrl, apiKey, table, rows) {
  for (let index = 0; index < rows.length; index += 100) {
    const response = await fetch(`${projectUrl}/rest/v1/${table}?on_conflict=id`, {
      method: 'POST',
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(rows.slice(index, index + 100).map(remoteProduct))
    });
    if (!response.ok) {
      throw new Error(`Supabase upsert failed at row ${index}: ${response.status} ${await response.text()}`);
    }
  }
}

const projectUrl = configValue('supabaseUrl').replace(/\/+$/, '');
const table = configValue('productsTable') || 'products';
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!projectUrl || !serviceRoleKey) {
  throw new Error('Supabase URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const localIds = new Set(products.map((product) => Number(product.id)).filter(Number.isFinite));
if (applyChanges) await upsertCatalog(projectUrl, serviceRoleKey, table, products);
const beforeRows = await fetchAllRows(projectUrl, serviceRoleKey, table);
const deleteRows = beforeRows.filter((row) => !localIds.has(Number(row.id)));
const deleteIds = deleteRows.map((row) => Number(row.id)).sort((left, right) => left - right);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const report = {
  generatedAt: new Date().toISOString(),
  applied: applyChanges,
  localRows: localIds.size,
  remoteRowsBefore: beforeRows.length,
  hardDeleteCount: deleteRows.length,
  hardDeleteIds: deleteIds
};

await fs.mkdir(path.join(root, 'outputs'), { recursive: true });
await fs.writeFile(
  path.join(root, 'outputs', 'supabase-hard-delete-catalog-reconcile.json'),
  `${JSON.stringify(report, null, 2)}\n`,
  'utf8'
);

if (applyChanges && deleteRows.length) {
  await fs.writeFile(
    path.join(root, 'outputs', `supabase-hard-delete-backup-${timestamp}.json`),
    `${JSON.stringify(deleteRows, null, 2)}\n`,
    'utf8'
  );
  for (let index = 0; index < deleteIds.length; index += 100) {
    const ids = deleteIds.slice(index, index + 100).join(',');
    const response = await fetch(`${projectUrl}/rest/v1/${table}?id=in.(${ids})`, {
      method: 'DELETE',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        Prefer: 'return=minimal'
      }
    });
    if (!response.ok) {
      throw new Error(`Supabase hard delete failed: ${response.status} ${await response.text()}`);
    }
  }
}

const afterRows = applyChanges ? await fetchAllRows(projectUrl, serviceRoleKey, table) : beforeRows;
const remainingExtraIds = afterRows
  .filter((row) => !localIds.has(Number(row.id)))
  .map((row) => Number(row.id));
const missingRemoteIds = [...localIds].filter((id) => !afterRows.some((row) => Number(row.id) === id));

console.log(JSON.stringify({
  ...report,
  remoteRowsAfter: afterRows.length,
  remainingExtraCount: remainingExtraIds.length,
  remainingExtraIds,
  missingRemoteCount: missingRemoteIds.length,
  missingRemoteIds
}, null, 2));

if (applyChanges && (remainingExtraIds.length || missingRemoteIds.length)) process.exit(1);
