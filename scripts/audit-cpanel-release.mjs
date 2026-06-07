import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const manifestPath = process.argv[2] || 'scripts/cpanel-current-static-no-assets-release.txt';
const siteUrl = String(process.argv[3] || 'https://www.djshouseofcards-comics.com/').replace(/\/?$/, '/');
const resolvedManifest = path.resolve(root, manifestPath);

if (!fs.existsSync(resolvedManifest)) {
  throw new Error(`Release manifest not found: ${manifestPath}`);
}

const paths = fs.readFileSync(resolvedManifest, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

const results = [];
for (const relativePath of paths) {
  const localPath = path.join(root, relativePath);
  if (!fs.existsSync(localPath)) {
    results.push({ path: relativePath, status: 'missing-local' });
    continue;
  }

  if (relativePath === '.htaccess') {
    results.push({ path: relativePath, status: 'unverified-hidden-file' });
    continue;
  }

  try {
    const response = await fetch(new URL(relativePath, siteUrl), { cache: 'no-store' });
    if (response.status === 404) {
      const local = fs.readFileSync(localPath);
      results.push({
        path: relativePath,
        status: 'missing-remote',
        localBytes: local.length,
        remoteBytes: 0
      });
      continue;
    }
    if (!response.ok) {
      results.push({ path: relativePath, status: 'fetch-error', httpStatus: response.status });
      continue;
    }
    const remote = Buffer.from(await response.arrayBuffer());
    const local = fs.readFileSync(localPath);
    results.push({
      path: relativePath,
      status: remote.equals(local) ? 'same' : 'different',
      localBytes: local.length,
      remoteBytes: remote.length
    });
  } catch (error) {
    results.push({ path: relativePath, status: 'fetch-error', error: error.message });
  }
}

const count = (status) => results.filter((result) => result.status === status).length;
console.log(JSON.stringify({
  manifest: manifestPath,
  siteUrl,
  files: results.length,
  same: count('same'),
  different: count('different'),
  missingRemote: count('missing-remote'),
  unverified: count('unverified-hidden-file'),
  errors: count('missing-local') + count('fetch-error'),
  results
}, null, 2));

if (count('missing-local') || count('fetch-error')) process.exit(1);
