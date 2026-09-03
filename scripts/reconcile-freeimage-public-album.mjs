#!/usr/bin/env node

/**
 * Reconcile a public FreeImage album to an immutable player-photo manifest.
 *
 * The album is read page-by-page from its public URL. Provider titles are
 * matched only to immutable source identifiers: the original remote URL's
 * basename or a locally staged filename. Ambiguous or missing matches fail
 * closed, leaving the output ledger untouched.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

function usage() {
  return `
Usage:
  node .\\scripts\\reconcile-freeimage-public-album.mjs \\
    --sport <mlb|nfl|nba> --album-url <public FreeImage album URL> \\
    --manifest <manifest.jsonl> --staging-root <directory> --output <ledger.jsonl> \\
    [--expected-count <positive integer>] [--receipt-root <directory>]
`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') return { help: true };
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}.`);
    values.set(key, value);
    index += 1;
  }
  for (const required of ['sport', 'album-url', 'manifest', 'staging-root', 'output']) {
    if (!values.has(required)) throw new Error(`Missing --${required}.`);
  }
  const sport = String(values.get('sport')).trim().toLowerCase();
  if (!['mlb', 'nfl', 'nba'].includes(sport)) throw new Error('--sport must be mlb, nfl, or nba.');
  const expectedCount = values.has('expected-count') ? Number(values.get('expected-count')) : null;
  if (expectedCount !== null && (!Number.isInteger(expectedCount) || expectedCount < 1)) {
    throw new Error('--expected-count must be a positive whole number.');
  }
  return {
    sport,
    albumUrl: trustedUrl(values.get('album-url'), 'freeimage.host', 'album'),
    manifestPath: path.resolve(values.get('manifest')),
    stagingRoot: path.resolve(values.get('staging-root')),
    outputPath: path.resolve(values.get('output')),
    receiptRoot: values.has('receipt-root') ? path.resolve(values.get('receipt-root')) : null,
    expectedCount,
  };
}

function trustedUrl(value, host, kind) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error(`Invalid ${kind} URL.`); }
  if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port || url.hash) {
    throw new Error(`Invalid ${kind} URL.`);
  }
  return url.href;
}

function normalizeKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function remoteBasename(value) {
  const url = new URL(String(value));
  const name = url.pathname.split('/').filter(Boolean).at(-1);
  if (!name) throw new Error(`Source remote URL has no basename: ${value}`);
  return decodeURIComponent(name);
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`Invalid JSONL at ${filePath}:${index + 1}.`); }
  });
}

function sourceIdentity(row) {
  const playerId = String(row?.player_id ?? '').trim();
  const remoteUrl = String(row?.remote_url ?? '').trim();
  if (!playerId || !remoteUrl) throw new Error('Source row is missing player_id or remote_url.');
  return `${playerId}\u0000${remoteUrl}`;
}

function addCandidate(candidates, key, row) {
  const normalized = normalizeKey(key);
  if (!normalized) return;
  const identity = sourceIdentity(row);
  let sourceRows = candidates.get(normalized);
  if (!sourceRows) {
    sourceRows = new Map();
    candidates.set(normalized, sourceRows);
  }
  sourceRows.set(identity, row);
}

function receiptCandidates(receiptRoot, byIdentity) {
  const candidates = new Map();
  if (!receiptRoot) return candidates;
  if (!fs.existsSync(receiptRoot)) throw new Error(`Receipt root does not exist: ${receiptRoot}`);
  const pending = [receiptRoot];
  const receiptPaths = [];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) receiptPaths.push(entryPath);
    }
  }
  for (const receiptPath of receiptPaths.sort()) {
    for (const receipt of readJsonl(receiptPath)) {
      const viewerValue = receipt?.freeimage_url ?? receipt?.freeimage_viewer_url;
      if (!viewerValue) continue;
      const viewer = trustedUrl(viewerValue, 'freeimage.host', 'receipt viewer');
      const identity = sourceIdentity(receipt);
      const source = byIdentity.get(identity);
      if (!source) throw new Error(`Receipt row is not present in the immutable source manifest: ${receiptPath}`);
      let sourceRows = candidates.get(viewer);
      if (!sourceRows) {
        sourceRows = new Map();
        candidates.set(viewer, sourceRows);
      }
      sourceRows.set(identity, source);
    }
  }
  return candidates;
}

function buildCandidates(manifestRows, stagingRoot, receiptRoot) {
  const byIdentity = new Map();
  const candidates = new Map();
  for (const row of manifestRows) {
    const identity = sourceIdentity(row);
    if (byIdentity.has(identity)) throw new Error(`Duplicate manifest identity: ${identity.replace('\u0000', ' / ')}.`);
    byIdentity.set(identity, row);
    addCandidate(candidates, remoteBasename(row.remote_url), row);
  }
  if (!fs.existsSync(stagingRoot)) throw new Error(`Staging root does not exist: ${stagingRoot}`);
  const manifestPaths = [];
  const pending = [stagingRoot];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      if (entry.isFile() && entry.name === 'manifest.json') manifestPaths.push(entryPath);
    }
  }
  for (const manifestPath of manifestPaths.sort()) {
    let staged;
    try { staged = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw new Error(`Invalid staging manifest: ${manifestPath}`); }
    for (const outcome of staged?.outcomes ?? []) {
      if (outcome?.status !== 'staged' || !outcome?.file) continue;
      // Fallback staging preserves the immutable source URL as
      // `original_remote_url`; it remains the identity used by the source
      // manifest, rather than treating the fetched fallback as a new source.
      const identity = sourceIdentity({
        player_id: outcome.player_id,
        remote_url: outcome.remote_url ?? outcome.original_remote_url,
      });
      const row = byIdentity.get(identity);
      if (!row) throw new Error(`Staging row is not present in the immutable source manifest: ${manifestPath}`);
      addCandidate(candidates, path.parse(String(outcome.file)).name, row);
    }
  }
  return { candidates, receiptByViewer: receiptCandidates(receiptRoot, byIdentity) };
}

function htmlDecode(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function imageEntriesFromHtml(html, pageUrl) {
  const entries = [];
  for (const match of html.matchAll(/data-object='([^']+)'/g)) {
    let data;
    try { data = JSON.parse(decodeURIComponent(match[1])); } catch { throw new Error(`Invalid image metadata on ${pageUrl}.`); }
    const title = String(data?.title ?? data?.name ?? '').trim();
    const direct = trustedUrl(data?.image?.url, 'iili.io', 'direct image');
    const viewer = trustedUrl(data?.url_viewer, 'freeimage.host', 'image viewer');
    if (!title) throw new Error(`Image metadata has no title on ${pageUrl}.`);
    entries.push({ title, direct, viewer });
  }
  if (!entries.length) throw new Error(`No image metadata was found on ${pageUrl}.`);
  return entries;
}

function nextAlbumPage(html, currentUrl) {
  const current = new URL(currentUrl);
  const currentPage = Number(current.searchParams.get('page') || '1');
  const candidates = [];
  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    let url;
    try { url = new URL(htmlDecode(match[1]), current); } catch { continue; }
    if (url.origin !== current.origin || url.pathname !== current.pathname) continue;
    const page = Number(url.searchParams.get('page'));
    if (Number.isInteger(page) && page > currentPage && url.searchParams.get('seek')) candidates.push({ page, href: url.href });
  }
  candidates.sort((left, right) => left.page - right.page || left.href.localeCompare(right.href));
  return candidates[0]?.href ?? null;
}

async function readAlbum(albumUrl) {
  const pages = [];
  const entries = new Map();
  const seenPages = new Set();
  let currentUrl = albumUrl;
  while (currentUrl) {
    if (seenPages.has(currentUrl)) throw new Error(`Album pagination repeated a page: ${currentUrl}`);
    seenPages.add(currentUrl);
    if (seenPages.size > 1000) throw new Error('Album pagination exceeded 1,000 pages.');
    const response = await fetch(currentUrl, { headers: { Accept: 'text/html' } });
    if (!response.ok) throw new Error(`Could not read ${currentUrl}: HTTP ${response.status}.`);
    const html = await response.text();
    const pageEntries = imageEntriesFromHtml(html, currentUrl);
    for (const entry of pageEntries) {
      const prior = entries.get(entry.direct);
      if (prior && (prior.title !== entry.title || prior.viewer !== entry.viewer)) {
        throw new Error(`One direct image has conflicting metadata: ${entry.direct}`);
      }
      entries.set(entry.direct, entry);
    }
    pages.push({ url: currentUrl, images: pageEntries.length });
    currentUrl = nextAlbumPage(html, currentUrl);
  }
  return { pages, entries: [...entries.values()] };
}

function writeNew(filePath, contents) {
  if (fs.existsSync(filePath)) throw new Error(`Refusing to overwrite existing output: ${filePath}`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx' });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const manifestRows = readJsonl(options.manifestPath);
  const { candidates, receiptByViewer } = buildCandidates(manifestRows, options.stagingRoot, options.receiptRoot);
  const album = await readAlbum(options.albumUrl);
  if (options.expectedCount !== null && album.entries.length !== options.expectedCount) {
    throw new Error(`Album has ${album.entries.length} unique images; expected ${options.expectedCount}.`);
  }
  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  const sourceToHosted = new Map();
  for (const entry of album.entries) {
    // A verified upload receipt identifies the FreeImage viewer URL exactly,
    // which takes precedence over a generic provider title such as "current".
    const sourceRows = receiptByViewer.get(entry.viewer) ?? candidates.get(normalizeKey(entry.title));
    if (!sourceRows?.size) {
      unmatched.push(entry);
      continue;
    }
    if (sourceRows.size !== 1) {
      ambiguous.push({ entry, candidates: [...sourceRows.values()].map(sourceIdentity) });
      continue;
    }
    const source = sourceRows.values().next().value;
    const identity = sourceIdentity(source);
    const earlier = sourceToHosted.get(identity);
    if (earlier && earlier !== entry.direct) {
      throw new Error(`One source image maps to multiple hosted images: ${identity.replace('\u0000', ' / ')}.`);
    }
    sourceToHosted.set(identity, entry.direct);
    matched.push({
      format: 'freeimage-public-album-reconciliation/v1',
      reconciled_at: new Date().toISOString(),
      sport: options.sport,
      album_url: options.albumUrl,
      player_id: String(source.player_id),
      player_name: String(source.player_name ?? ''),
      remote_url: String(source.remote_url),
      source_url: String(source.source_url ?? ''),
      source_name: String(source.source_name ?? ''),
      rights_confirmed: Boolean(source.rights_confirmed),
      provider_title: entry.title,
      freeimage_viewer_url: entry.viewer,
      freeimage_direct_url: entry.direct,
      transfer_status: 'uploaded',
    });
  }
  if (unmatched.length || ambiguous.length) {
    const describe = (items) => items.slice(0, 5).map((item) => item.title ?? item.entry?.title).join(', ');
    throw new Error(`Album reconciliation failed: ${unmatched.length} unmatched (${describe(unmatched)}); ${ambiguous.length} ambiguous (${describe(ambiguous)}).`);
  }
  if (matched.length !== album.entries.length) throw new Error('Album reconciliation did not preserve every hosted image.');
  writeNew(options.outputPath, `${matched.map((row) => JSON.stringify(row)).join('\n')}\n`);
  console.log(JSON.stringify({
    sport: options.sport,
    album: options.albumUrl,
    pages: album.pages.length,
    images: album.entries.length,
    matched: matched.length,
    output: path.relative(ROOT, options.outputPath),
  }, null, 2));
}

main().catch((error) => {
  console.error(`FreeImage public-album reconciliation failed: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
