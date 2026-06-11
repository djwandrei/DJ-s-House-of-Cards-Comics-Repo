import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const applyChanges = process.argv.includes('--apply');
const products = JSON.parse(fs.readFileSync(path.join(root, 'products.json'), 'utf8'));
const projectUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!projectUrl || !serviceRoleKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
}

const deletionTargets = products
  .filter((product) => product?.isDeleted === true)
  .map((product) => ({
    id: Number(product.id),
    name: String(product.name || '')
  }))
  .filter((product) => Number.isFinite(product.id));

if (!deletionTargets.length) {
  throw new Error('No products are marked isDeleted: true locally.');
}

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  'Content-Type': 'application/json'
};

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${await response.text()}`);
  }
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchTargets() {
  const ids = deletionTargets.map((product) => product.id).join(',');
  const query = new URLSearchParams({
    select: '*',
    id: `in.(${ids})`,
    order: 'id.asc'
  });
  return requestJson(`${projectUrl}/rest/v1/products?${query}`, { headers });
}

const remoteRows = await fetchTargets();
const remoteById = new Map(remoteRows.map((row) => [Number(row.id), row]));
const missingBeforeDelete = deletionTargets.filter((product) => !remoteById.has(product.id));
const nameMismatches = deletionTargets
  .filter((product) => remoteById.has(product.id))
  .filter((product) => String(remoteById.get(product.id)?.name || '') !== product.name)
  .map((product) => ({
    id: product.id,
    localName: product.name,
    remoteName: String(remoteById.get(product.id)?.name || '')
  }));

const summary = {
  mode: applyChanges ? 'apply' : 'audit',
  localDeletionTargets: deletionTargets.length,
  remoteRowsFound: remoteRows.length,
  remoteIdsFound: remoteRows.map((row) => Number(row.id)),
  alreadyMissingIds: missingBeforeDelete.map((row) => row.id),
  nameMismatches
};

if (!applyChanges) {
  console.log(JSON.stringify(summary, null, 2));
  if (nameMismatches.length) process.exitCode = 1;
} else {
  if (nameMismatches.length) {
    throw new Error(`Refusing to delete because ${nameMismatches.length} target name(s) differ between local and remote.`);
  }

  const outputDir = path.join(root, 'outputs');
  fs.mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(outputDir, `supabase-hard-delete-backup-${timestamp}.json`);
  fs.writeFileSync(backupPath, `${JSON.stringify(remoteRows, null, 2)}\n`, 'utf8');

  if (remoteRows.length) {
    const ids = remoteRows.map((row) => Number(row.id)).join(',');
    const query = new URLSearchParams({ id: `in.(${ids})` });
    await requestJson(`${projectUrl}/rest/v1/products?${query}`, {
      method: 'DELETE',
      headers: {
        ...headers,
        Prefer: 'return=representation'
      }
    });
  }

  const remainingRows = await fetchTargets();
  console.log(JSON.stringify({
    ...summary,
    backupPath,
    hardDeletedRows: remoteRows.length,
    remainingRows: remainingRows.length,
    remainingIds: remainingRows.map((row) => Number(row.id))
  }, null, 2));

  if (remainingRows.length) process.exitCode = 1;
}
