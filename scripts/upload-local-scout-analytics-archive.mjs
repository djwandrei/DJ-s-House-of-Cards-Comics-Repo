#!/usr/bin/env node

/**
 * Upload a completed local Scout analytics package to a private, dedicated
 * Supabase Storage bucket. This is deliberately not the Sportradar raw-PBP
 * ingest path: the package contains normalized, derived Scout outputs and its
 * source provenance remains in its local manifest.
 *
 * No provider request is made. The default is a local integrity dry run.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertAnalyticsProjectTarget } from './lib/nba-analytics-project-target.mjs';

const MODULE_PATH = fileURLToPath(import.meta.url);
const ROOT = process.cwd();
const DEFAULT_BUCKET = 'nba-scout-analytics-archive';
const TUS_VERSION = '1.0.0';
const TUS_CHUNK_BYTES = 6 * 1024 * 1024;
const WRITE_CONFIRMATION_ENV = 'NBA_SCOUT_ARCHIVE_UPLOAD_ALLOW_WRITE';
// Both names are retained for immutable package compatibility. Earlier
// validators emitted `2025-26.validation-v2`; the current validator emits
// `validation-2025-26`. Each report is still hash-bound to its manifest.
const PACKAGE_VALIDATION_NAME_PATTERN = /^(?:nba-scout-analytics-\d{4}-\d{2}\.validation(?:-[a-z0-9]+)?|nba-scout-analytics-validation-\d{4}-\d{2})\.json$/i;

function usage() {
  return `
Usage:
  node .\\scripts\\upload-local-scout-analytics-archive.mjs --archive <directory> [options]

Options:
  --archive <directory>   Completed local Scout package under outputs/ (required)
  --checkpoint <path>     Local resumable-upload checkpoint (default: adjacent to package)
  --apply                 Create the private bucket if needed and upload artifacts
  --verify-remote         Verify the expected private Storage object names and sizes
  --help                  Show this help

Required for --apply or --verify-remote:
  SUPABASE_URL=https://your-analytics-project.supabase.co
  NBA_ANALYTICS_SUPABASE_URL=https://your-analytics-project.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

Additional requirement for --apply:
  ${WRITE_CONFIRMATION_ENV}=confirmed

The uploader permits only the private ${DEFAULT_BUCKET} bucket. It uploads the
root manifest, validation/provenance files, and gzip team shards. It refuses
uncompressed team JSON, raw provider payloads, public buckets, foreign projects,
and paths outside this workspace's outputs/ directory.
`;
}

function parseTokens(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!name) throw new Error('An option name is required.');
    if (inlineValue !== undefined) values.set(name, inlineValue);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(name, argv[++index]);
    else flags.add(name);
  }
  return { values, flags };
}

function workspacePath(value, name, { requireOutputs = false } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error(`${name} is required.`);
  const resolved = path.resolve(raw);
  const root = path.resolve(ROOT);
  const relative = path.relative(root, resolved);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${name} must stay inside this workspace.`);
  }
  const segments = relative.split(path.sep).filter(Boolean);
  if (requireOutputs && segments[0]?.toLowerCase() !== 'outputs') {
    throw new Error(`${name} must be under this workspace's outputs/ directory.`);
  }
  return resolved;
}

export function optionsFromArgs(argv = []) {
  const { values, flags } = parseTokens(argv);
  const known = new Set(['help', 'archive', 'checkpoint', 'apply', 'verify-remote']);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  const archiveDir = workspacePath(values.get('archive'), '--archive', { requireOutputs: true });
  const checkpointPath = values.has('checkpoint')
    ? workspacePath(values.get('checkpoint'), '--checkpoint', { requireOutputs: true })
    : path.join(path.dirname(archiveDir), `${path.basename(archiveDir)}.supabase-upload-checkpoint.json`);
  return {
    help: false,
    archiveDir,
    checkpointPath,
    apply: flags.has('apply'),
    verifyRemote: flags.has('verify-remote'),
  };
}

function isSafeRelativePath(value) {
  const normalized = String(value ?? '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) return false;
  const segments = normalized.split('/');
  return segments.every((segment) => segment && segment !== '.' && segment !== '..');
}

function safeRelativePath(value, label) {
  if (!isSafeRelativePath(value)) throw new Error(`${label} must be a non-empty safe relative path.`);
  return String(value).replace(/\\/g, '/');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fileDigest(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const digest = crypto.createHash('sha256');
    let bytes = 0;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
      position += bytesRead;
    }
    return { bytes, sha256: digest.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not readable JSON: ${String(error?.message ?? error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

function manifestNameFromEntries(entries) {
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => /^nba-scout-analytics-\d{4}-\d{2}\.json$/i.test(name));
  if (names.length !== 1) {
    throw new Error('The archive directory must contain exactly one nba-scout-analytics-YYYY-YY.json manifest.');
  }
  return names[0];
}

function archivePrefix({ manifest, archiveDir, manifestSha256 }) {
  const seasonStart = Number(manifest?.scope?.seasonStartYear);
  const seasonEnd = Number(manifest?.scope?.seasonEndYear);
  const schemaVersion = Number(manifest?.schemaVersion);
  if (!Number.isInteger(seasonStart) || !Number.isInteger(seasonEnd) || seasonEnd !== seasonStart + 1) {
    throw new Error('The Scout manifest must identify one valid NBA season.');
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new Error('The Scout manifest must identify a positive schemaVersion.');
  }
  return `schema-v${schemaVersion}/${seasonStart}-${String(seasonEnd).slice(-2)}/${path.basename(archiveDir)}-${manifestSha256.slice(0, 16)}`;
}

function artifactDescriptor({ archiveDir, relativePath, remotePath, expectedBytes = null, expectedSha256 = null, kind }) {
  const safeRelative = safeRelativePath(relativePath, 'Archive artifact path');
  const safeRemote = safeRelativePath(remotePath, 'Storage object path');
  const localPath = path.resolve(archiveDir, safeRelative);
  const archiveRelative = path.relative(archiveDir, localPath);
  if (archiveRelative.startsWith('..') || path.isAbsolute(archiveRelative)) {
    throw new Error(`Archive artifact path escapes the archive: ${safeRelative}`);
  }
  return { localPath, relativePath: safeRelative, remotePath: safeRemote, expectedBytes, expectedSha256, kind };
}

function metadataArtifactNames(entries, manifestName) {
  // A full derivation already produces corrected boundary-role fields, while
  // the separate repair utility adds an immutable provenance report.  Require
  // the report when it is present, but do not make a post-derivation repair a
  // prerequisite for uploading an otherwise valid, directly-derived package.
  const allowed = new Set([manifestName, `${manifestName}.gz`, 'README.md']);
  for (const entry of entries) {
    if (entry.isFile() && entry.name === 'boundary-role-repair-report.json') {
      allowed.add(entry.name);
    }
    if (entry.isFile() && PACKAGE_VALIDATION_NAME_PATTERN.test(entry.name)) {
      allowed.add(entry.name);
    }
  }
  return [...allowed].sort();
}

export async function buildArchiveUploadPlan({ archiveDir }) {
  const entries = await fs.readdir(archiveDir, { withFileTypes: true });
  const manifestName = manifestNameFromEntries(entries);
  const manifestPath = path.join(archiveDir, manifestName);
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (!Array.isArray(manifest.dataShards) || !manifest.dataShards.length) {
    throw new Error('The Scout manifest must provide at least one data shard.');
  }
  const manifestSha256 = sha256(manifestBytes);
  const prefix = archivePrefix({ manifest, archiveDir, manifestSha256 });
  const artifacts = [];
  for (const name of metadataArtifactNames(entries, manifestName)) {
    const localPath = path.join(archiveDir, name);
    if (!(await fs.stat(localPath)).isFile()) {
      throw new Error(`Required archive metadata file is missing: ${name}`);
    }
    artifacts.push(artifactDescriptor({
      archiveDir,
      relativePath: name,
      remotePath: `${prefix}/${name}`,
      kind: 'metadata',
    }));
  }
  const seenRemotePaths = new Set(artifacts.map((artifact) => artifact.remotePath));
  for (const shard of manifest.dataShards) {
    const gzipPath = safeRelativePath(shard?.gzipPath, 'Manifest gzipPath');
    if (!gzipPath.startsWith('teams/') || !gzipPath.endsWith('.json.gz')) {
      throw new Error(`Scout shard must be a gzip team artifact: ${gzipPath}`);
    }
    const expectedBytes = Number(shard?.gzipBytes);
    const expectedSha256 = String(shard?.gzipSha256 ?? '').toLowerCase();
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(`Scout shard integrity metadata is invalid for ${gzipPath}.`);
    }
    const remotePath = `${prefix}/${gzipPath}`;
    if (seenRemotePaths.has(remotePath)) throw new Error(`Scout manifest repeats a shard destination: ${gzipPath}`);
    seenRemotePaths.add(remotePath);
    artifacts.push(artifactDescriptor({
      archiveDir,
      relativePath: gzipPath,
      remotePath,
      expectedBytes,
      expectedSha256,
      kind: 'team-gzip-shard',
    }));
  }
  return {
    archiveDir,
    manifestName,
    manifest,
    manifestSha256,
    bucket: DEFAULT_BUCKET,
    prefix,
    artifacts: artifacts.sort((left, right) => left.remotePath.localeCompare(right.remotePath)),
  };
}

export async function validateLocalArchivePlan(plan) {
  const artifacts = [];
  for (const artifact of plan.artifacts) {
    let stats;
    try {
      stats = await fs.stat(artifact.localPath);
    } catch {
      throw new Error(`Archive artifact is missing: ${artifact.relativePath}`);
    }
    if (!stats.isFile()) throw new Error(`Archive artifact is not a file: ${artifact.relativePath}`);
    const digest = await fileDigest(artifact.localPath);
    if (artifact.expectedBytes !== null && digest.bytes !== artifact.expectedBytes) {
      throw new Error(`${artifact.relativePath} size does not match the Scout manifest.`);
    }
    if (artifact.expectedSha256 !== null && digest.sha256 !== artifact.expectedSha256) {
      throw new Error(`${artifact.relativePath} SHA-256 does not match the Scout manifest.`);
    }
    artifacts.push({ ...artifact, bytes: digest.bytes, sha256: digest.sha256 });
  }
  const totalBytes = artifacts.reduce((total, artifact) => total + artifact.bytes, 0);
  return { ...plan, artifacts, totalBytes };
}

function confirmed(value) {
  return String(value ?? '').trim().toLowerCase() === 'confirmed';
}

function remoteConfiguration({ requireWrite }) {
  const projectUrl = assertAnalyticsProjectTarget({
    projectUrl: process.env.SUPABASE_URL,
    expectedProjectUrl: process.env.NBA_ANALYTICS_SUPABASE_URL,
  });
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for private archive Storage access.');
  if (requireWrite && !confirmed(process.env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }
  return { projectUrl, serviceRoleKey };
}

function storageHeaders(serviceRoleKey, extra = {}) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    ...extra,
  };
}

function compactResponseText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').slice(0, 500);
}

async function requestJson(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  const raw = await response.text();
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}: ${compactResponseText(raw)}`);
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} returned malformed JSON.`);
  }
}

function storageApiUrl(projectUrl, pathname) {
  return `${projectUrl}/storage/v1${pathname}`;
}

export async function getBucket({ projectUrl, serviceRoleKey, bucket = DEFAULT_BUCKET, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(storageApiUrl(projectUrl, `/bucket/${encodeURIComponent(bucket)}`), {
    headers: storageHeaders(serviceRoleKey),
  });
  const raw = await response.text();
  const text = compactResponseText(raw);
  // The Storage API currently wraps a missing bucket as HTTP 400 with a
  // NoSuchBucket/404 payload on some projects, rather than a transport 404.
  // Treat only that documented semantic response as absence; every other
  // failure remains fail-closed.
  if (response.status === 404 || /(?:"code"\s*:\s*"NoSuchBucket"|"statusCode"\s*:\s*"?404"?|Bucket not found)/i.test(text)) {
    return null;
  }
  if (!response.ok) throw new Error(`Read private Storage bucket failed with HTTP ${response.status}: ${text}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Read private Storage bucket returned malformed JSON.');
  }
}

export async function ensurePrivateBucket({ projectUrl, serviceRoleKey, bucket = DEFAULT_BUCKET, apply = false, maxArtifactBytes = 0, fetchImpl = globalThis.fetch }) {
  let current = await getBucket({ projectUrl, serviceRoleKey, bucket, fetchImpl });
  if (!current) {
    if (!apply) return { status: 'would-create', bucket: null };
    // Some plans cap a bucket's configured object size below 100 MB. Configure
    // only the smallest whole-MiB limit that admits this immutable package,
    // rather than assuming a higher plan entitlement.
    const requiredFileLimit = Math.ceil(maxArtifactBytes / (1024 * 1024)) * 1024 * 1024;
    current = await requestJson(fetchImpl, storageApiUrl(projectUrl, '/bucket'), {
      method: 'POST',
      headers: storageHeaders(serviceRoleKey, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: bucket,
        name: bucket,
        public: false,
        file_size_limit: requiredFileLimit,
        allowed_mime_types: ['application/gzip', 'application/json', 'text/markdown'],
      }),
    }, 'Create private Scout archive bucket');
  }
  if (current.public === true) throw new Error(`Refusing to use public Storage bucket ${bucket}.`);
  const limit = Number(current.file_size_limit ?? 0);
  if (Number.isFinite(limit) && limit > 0 && maxArtifactBytes > limit) {
    throw new Error(`Private Storage bucket ${bucket} has a ${limit}-byte file limit below the largest archive artifact.`);
  }
  return { status: 'ready', bucket: current };
}

function tusEndpoint(projectUrl) {
  const parsed = new URL(projectUrl);
  if (!parsed.hostname.endsWith('.supabase.co')) {
    throw new Error('The analytics project URL must use the expected Supabase hostname.');
  }
  const storageHost = parsed.hostname.replace(/\.supabase\.co$/i, '.storage.supabase.co');
  return `https://${storageHost}/storage/v1/upload/resumable`;
}

function base64MetadataValue(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function tusMetadata({ bucket, objectPath, contentType }) {
  return [
    `bucketName ${base64MetadataValue(bucket)}`,
    `objectName ${base64MetadataValue(objectPath)}`,
    `contentType ${base64MetadataValue(contentType)}`,
    `cacheControl ${base64MetadataValue('31536000')}`,
  ].join(',');
}

function contentTypeForArtifact(artifact) {
  if (artifact.relativePath.endsWith('.json.gz')) return 'application/gzip';
  if (artifact.relativePath.endsWith('.json')) return 'application/json';
  if (artifact.relativePath.endsWith('.md')) return 'text/markdown';
  return 'application/octet-stream';
}

function parseTusOffset(response, label) {
  const value = Number.parseInt(String(response.headers.get('upload-offset') ?? ''), 10);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} returned an invalid Upload-Offset.`);
  return value;
}

async function tusRequest(fetchImpl, url, options, label) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    const text = compactResponseText(await response.text());
    throw new Error(`${label} failed with HTTP ${response.status}: ${text}`);
  }
  return response;
}

async function resumeTusUpload({ fetchImpl, uploadUrl, serviceRoleKey }) {
  const response = await fetchImpl(uploadUrl, {
    method: 'HEAD',
    headers: storageHeaders(serviceRoleKey, { 'Tus-Resumable': TUS_VERSION }),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (!response.ok) {
    const text = compactResponseText(await response.text());
    throw new Error(`Resume Scout archive upload failed with HTTP ${response.status}: ${text}`);
  }
  return parseTusOffset(response, 'Resume Scout archive upload');
}

async function createTusUpload({ projectUrl, serviceRoleKey, bucket, artifact, fetchImpl }) {
  const response = await tusRequest(fetchImpl, tusEndpoint(projectUrl), {
    method: 'POST',
    headers: storageHeaders(serviceRoleKey, {
      'Tus-Resumable': TUS_VERSION,
      'Upload-Length': String(artifact.bytes),
      'Upload-Metadata': tusMetadata({ bucket, objectPath: artifact.remotePath, contentType: contentTypeForArtifact(artifact) }),
    }),
  }, 'Start Scout archive resumable upload');
  const location = response.headers.get('location');
  if (!location) throw new Error('Start Scout archive resumable upload did not return a Location header.');
  const initialOffsetHeader = response.headers.get('upload-offset');
  return {
    uploadUrl: new URL(location, tusEndpoint(projectUrl)).toString(),
    // TUS creation responses may omit Upload-Offset; a newly created upload
    // is then defined to begin at byte zero.
    offset: initialOffsetHeader === null ? 0 : parseTusOffset(response, 'Start Scout archive resumable upload'),
  };
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(temporary, filePath);
}

async function loadCheckpoint(checkpointPath) {
  try {
    const raw = await fs.readFile(checkpointPath, 'utf8');
    const value = JSON.parse(raw);
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object') {
      throw new Error('Upload checkpoint uses an unsupported format.');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, entries: {} };
    throw error;
  }
}

function checkpointEntry(checkpoint, artifact) {
  const entry = checkpoint.entries[artifact.remotePath];
  if (!entry || entry.sha256 !== artifact.sha256 || entry.bytes !== artifact.bytes) return null;
  return entry;
}

async function uploadOneTusArtifact({ projectUrl, serviceRoleKey, bucket, artifact, checkpoint, checkpointPath, fetchImpl, onProgress }) {
  let entry = checkpointEntry(checkpoint, artifact) ?? {};
  let uploadUrl = entry.uploadUrl ?? null;
  let offset = 0;
  if (uploadUrl) {
    const resumed = await resumeTusUpload({ fetchImpl, uploadUrl, serviceRoleKey });
    if (resumed !== null) offset = resumed;
    else uploadUrl = null;
  }
  if (!uploadUrl) {
    const created = await createTusUpload({ projectUrl, serviceRoleKey, bucket, artifact, fetchImpl });
    uploadUrl = created.uploadUrl;
    offset = created.offset;
  }
  if (offset > artifact.bytes) throw new Error(`Remote upload offset exceeds local artifact size for ${artifact.relativePath}.`);
  checkpoint.entries[artifact.remotePath] = {
    sha256: artifact.sha256,
    bytes: artifact.bytes,
    uploadUrl,
    offset,
    complete: false,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(checkpointPath, checkpoint);
  const handle = await fs.open(artifact.localPath, 'r');
  try {
    while (offset < artifact.bytes) {
      const size = Math.min(TUS_CHUNK_BYTES, artifact.bytes - offset);
      const buffer = Buffer.allocUnsafe(size);
      const { bytesRead } = await handle.read(buffer, 0, size, offset);
      if (bytesRead !== size) throw new Error(`Could not read the expected bytes from ${artifact.relativePath}.`);
      const response = await tusRequest(fetchImpl, uploadUrl, {
        method: 'PATCH',
        headers: storageHeaders(serviceRoleKey, {
          'Tus-Resumable': TUS_VERSION,
          'Upload-Offset': String(offset),
          'Content-Type': 'application/offset+octet-stream',
        }),
        body: buffer,
      }, `Upload Scout archive chunk for ${artifact.relativePath}`);
      const nextOffset = parseTusOffset(response, `Upload Scout archive chunk for ${artifact.relativePath}`);
      if (nextOffset !== offset + size) {
        throw new Error(`Scout archive server returned a non-sequential offset for ${artifact.relativePath}.`);
      }
      offset = nextOffset;
      checkpoint.entries[artifact.remotePath] = {
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        uploadUrl,
        offset,
        complete: offset === artifact.bytes,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(checkpointPath, checkpoint);
      onProgress?.({ artifact, offset, total: artifact.bytes });
    }
  } finally {
    await handle.close();
  }
  return { artifact, status: 'uploaded' };
}

async function listObjects({ projectUrl, serviceRoleKey, bucket, prefix, fetchImpl }) {
  const value = await requestJson(fetchImpl, storageApiUrl(projectUrl, `/object/list/${encodeURIComponent(bucket)}`), {
    method: 'POST',
    headers: storageHeaders(serviceRoleKey, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } }),
  }, `List private Scout archive objects under ${prefix}`);
  if (!Array.isArray(value)) throw new Error('Private Storage object list returned a non-array response.');
  return value;
}

export async function remoteArtifactMap({ projectUrl, serviceRoleKey, bucket, prefix, fetchImpl = globalThis.fetch }) {
  const map = new Map();
  for (const folder of [prefix, `${prefix}/teams`]) {
    const rows = await listObjects({ projectUrl, serviceRoleKey, bucket, prefix: folder, fetchImpl });
    for (const row of rows) {
      if (!row?.name || !row?.metadata || typeof row.metadata !== 'object') continue;
      const remotePath = `${folder}/${row.name}`;
      const size = Number(row.metadata.size ?? row.metadata.contentLength ?? 0);
      map.set(remotePath, { size, metadata: row.metadata });
    }
  }
  return map;
}

export function verifyRemoteArtifacts({ plan, remoteArtifacts }) {
  const missing = [];
  const sizeMismatch = [];
  for (const artifact of plan.artifacts) {
    const remote = remoteArtifacts.get(artifact.remotePath);
    if (!remote) missing.push(artifact.remotePath);
    else if (remote.size !== artifact.bytes) sizeMismatch.push({ remotePath: artifact.remotePath, expectedBytes: artifact.bytes, actualBytes: remote.size });
  }
  return { complete: missing.length === 0 && sizeMismatch.length === 0, missing, sizeMismatch };
}

function reportForPlan(plan) {
  const shards = plan.artifacts.filter((artifact) => artifact.kind === 'team-gzip-shard');
  return {
    mode: 'dry-run',
    bucket: plan.bucket,
    targetPrefix: plan.prefix,
    manifestSha256: plan.manifestSha256,
    artifactCount: plan.artifacts.length,
    teamGzipShardCount: shards.length,
    totalBytes: plan.totalBytes,
    largestArtifactBytes: Math.max(...plan.artifacts.map((artifact) => artifact.bytes)),
    uploadsRawProviderPayloads: false,
    uploadsUncompressedTeamJson: false,
  };
}

export async function runArchiveUpload(options, { fetchImpl = globalThis.fetch, onProgress = null } = {}) {
  const rawPlan = await buildArchiveUploadPlan({ archiveDir: options.archiveDir });
  const plan = await validateLocalArchivePlan(rawPlan);
  const baseReport = reportForPlan(plan);
  if (!options.apply && !options.verifyRemote) return baseReport;
  const config = remoteConfiguration({ requireWrite: options.apply });
  const maxArtifactBytes = Math.max(...plan.artifacts.map((artifact) => artifact.bytes));
  const bucket = await ensurePrivateBucket({
    ...config,
    bucket: plan.bucket,
    apply: options.apply,
    maxArtifactBytes,
    fetchImpl,
  });
  if (!options.apply) {
    if (bucket.status !== 'ready') return { ...baseReport, mode: 'verify-remote', bucketStatus: bucket.status, remoteVerification: { complete: false, missing: plan.artifacts.map((artifact) => artifact.remotePath), sizeMismatch: [] } };
    const remoteArtifacts = await remoteArtifactMap({ ...config, bucket: plan.bucket, prefix: plan.prefix, fetchImpl });
    return { ...baseReport, mode: 'verify-remote', bucketStatus: bucket.status, remoteVerification: verifyRemoteArtifacts({ plan, remoteArtifacts }) };
  }
  const remoteBefore = await remoteArtifactMap({ ...config, bucket: plan.bucket, prefix: plan.prefix, fetchImpl });
  const checkpoint = await loadCheckpoint(options.checkpointPath);
  checkpoint.targetOrigin = config.projectUrl;
  checkpoint.bucket = plan.bucket;
  checkpoint.prefix = plan.prefix;
  checkpoint.manifestSha256 = plan.manifestSha256;
  const uploaded = [];
  const skipped = [];
  for (const artifact of plan.artifacts) {
    const remote = remoteBefore.get(artifact.remotePath);
    if (remote && remote.size === artifact.bytes) {
      skipped.push(artifact.remotePath);
      checkpoint.entries[artifact.remotePath] = {
        sha256: artifact.sha256,
        bytes: artifact.bytes,
        uploadUrl: null,
        offset: artifact.bytes,
        complete: true,
        updatedAt: new Date().toISOString(),
      };
      await writeJsonAtomic(options.checkpointPath, checkpoint);
      continue;
    }
    if (remote) {
      throw new Error(`Private Storage already contains a size-conflicting immutable object: ${artifact.remotePath}`);
    }
    const result = await uploadOneTusArtifact({
      ...config,
      bucket: plan.bucket,
      artifact,
      checkpoint,
      checkpointPath: options.checkpointPath,
      fetchImpl,
      onProgress,
    });
    uploaded.push(result.artifact.remotePath);
  }
  const remoteAfter = await remoteArtifactMap({ ...config, bucket: plan.bucket, prefix: plan.prefix, fetchImpl });
  const remoteVerification = verifyRemoteArtifacts({ plan, remoteArtifacts: remoteAfter });
  if (!remoteVerification.complete) throw new Error('Private Storage verification failed after the Scout archive upload.');
  return {
    ...baseReport,
    mode: 'apply',
    bucketStatus: bucket.status,
    checkpointPath: options.checkpointPath,
    uploaded,
    skipped,
    remoteVerification,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  const report = await runArchiveUpload(options, {
    onProgress: ({ artifact, offset, total }) => {
      if (offset === total || offset % TUS_CHUNK_BYTES === 0) {
        console.log(JSON.stringify({ event: 'upload-progress', artifact: artifact.relativePath, bytesUploaded: offset, totalBytes: total }));
      }
    },
  });
  console.log(JSON.stringify(report, null, 2));
  return report;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? '')).href) {
  main().catch((error) => {
    console.error(`Scout archive upload failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
