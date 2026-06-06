import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const applyChanges = process.argv.includes('--apply');
const configText = fs.readFileSync(path.join(root, 'backend-config.js'), 'utf8');
const products = JSON.parse(fs.readFileSync(path.join(root, 'products.json'), 'utf8'));

function configValue(name) {
  return configText.match(new RegExp(`${name}:\\s*'([^']+)'`))?.[1] || '';
}

function isRemoteOrEmbeddedAsset(value = '') {
  return /^(?:https?:|data:|blob:)/i.test(String(value || '').trim());
}

function localAssetExists(reference = '') {
  if (!reference || isRemoteOrEmbeddedAsset(reference)) return true;
  return fs.existsSync(path.join(root, String(reference).replace(/^\//, '')));
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchActiveRows(projectUrl, apiKey) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const query = new URLSearchParams({
      select: 'id,name,image,image_gallery',
      is_deleted: 'eq.false',
      limit: '1000',
      offset: String(offset)
    });
    const page = await requestJson(`${projectUrl}/rest/v1/products?${query}`, {
      headers: { apikey: apiKey }
    });
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

const projectUrl = configValue('supabaseUrl').replace(/\/+$/, '');
const publicApiKey = configValue('supabasePublishableKey') || configValue('supabaseAnonKey');
if (!projectUrl || !publicApiKey) {
  throw new Error('backend-config.js is missing the public Supabase URL or publishable key.');
}

const localById = new Map(products.map((product) => [Number(product.id), product]));
const remoteRows = await fetchActiveRows(projectUrl, publicApiKey);
const mismatches = [];

for (const remote of remoteRows) {
  const local = localById.get(Number(remote.id));
  if (!local) continue;

  const localGallery = Array.isArray(local.imageGallery) ? local.imageGallery : [];
  const remoteGallery = Array.isArray(remote.image_gallery) ? remote.image_gallery : [];
  if (String(remote.image || '') === String(local.image || '')
    && JSON.stringify(remoteGallery) === JSON.stringify(localGallery)) {
    continue;
  }

  const missingTargets = [local.image, ...localGallery]
    .filter(Boolean)
    .filter((reference) => !localAssetExists(reference));
  mismatches.push({
    id: Number(remote.id),
    name: remote.name,
    remoteImage: remote.image || '',
    localImage: local.image || '',
    remoteGalleryCount: remoteGallery.length,
    localGalleryCount: localGallery.length,
    missingTargets,
    patch: {
      image: local.image || '',
      image_gallery: localGallery
    }
  });
}

const unsafe = mismatches.filter((item) => item.missingTargets.length);
const summary = {
  mode: applyChanges ? 'apply' : 'audit',
  activeRemoteRows: remoteRows.length,
  localRows: products.length,
  mediaPathMismatchRows: mismatches.length,
  unsafeMismatchRows: unsafe.length,
  mismatchIds: mismatches.map((item) => item.id)
};

if (!applyChanges) {
  console.log(JSON.stringify({ ...summary, mismatches }, null, 2));
  process.exit(unsafe.length ? 1 : 0);
}

if (unsafe.length) {
  throw new Error(`Refusing to apply because ${unsafe.length} row(s) point to missing local targets.`);
}

const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
if (!serviceRoleKey) {
  throw new Error('Set SUPABASE_SERVICE_ROLE_KEY for this process before using --apply.');
}

for (const mismatch of mismatches) {
  const query = new URLSearchParams({ id: `eq.${mismatch.id}` });
  await requestJson(`${projectUrl}/rest/v1/products?${query}`, {
    method: 'PATCH',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(mismatch.patch)
  });
}

const verifiedRows = await fetchActiveRows(projectUrl, publicApiKey);
const remaining = verifiedRows.filter((remote) => {
  const local = localById.get(Number(remote.id));
  if (!local) return false;
  const localGallery = Array.isArray(local.imageGallery) ? local.imageGallery : [];
  const remoteGallery = Array.isArray(remote.image_gallery) ? remote.image_gallery : [];
  return String(remote.image || '') !== String(local.image || '')
    || JSON.stringify(remoteGallery) !== JSON.stringify(localGallery);
});

console.log(JSON.stringify({
  ...summary,
  patchedRows: mismatches.length,
  remainingMismatches: remaining.length,
  remainingIds: remaining.map((item) => Number(item.id))
}, null, 2));

if (remaining.length) process.exit(1);
