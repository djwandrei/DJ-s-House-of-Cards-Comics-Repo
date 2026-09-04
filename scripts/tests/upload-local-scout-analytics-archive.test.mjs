import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import {
  buildArchiveUploadPlan,
  ensurePrivateBucket,
  getBucket,
  optionsFromArgs,
  validateLocalArchivePlan,
  verifyRemoteArtifacts,
} from '../upload-local-scout-analytics-archive.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function fixtureArchive({
  includeBoundaryRoleRepairReport = true,
  validationFilename = 'nba-scout-analytics-2025-26.validation-v2.json',
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-archive-upload-'));
  const archive = path.join(root, 'outputs', 'fixture-scout-package');
  await fs.mkdir(path.join(archive, 'teams'), { recursive: true });
  const shard = gzipSync(Buffer.from('{"fixture":true}'));
  await fs.writeFile(path.join(archive, 'teams', 'fixture.json.gz'), shard);
  const manifest = {
    schemaVersion: 4,
    scope: { seasonStartYear: 2025, seasonEndYear: 2026 },
    dataShards: [{
      gzipPath: 'teams/fixture.json.gz',
      gzipBytes: shard.length,
      gzipSha256: sha256(shard),
    }],
  };
  await fs.writeFile(path.join(archive, 'nba-scout-analytics-2025-26.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(archive, 'nba-scout-analytics-2025-26.json.gz'), gzipSync(Buffer.from(JSON.stringify(manifest))));
  await fs.writeFile(path.join(archive, 'README.md'), '# Fixture\n');
  if (includeBoundaryRoleRepairReport) {
    await fs.writeFile(path.join(archive, 'boundary-role-repair-report.json'), '{}');
  }
  await fs.writeFile(path.join(archive, validationFilename), '{}');
  return { root, archive };
}

test('archive uploader requires a package below workspace outputs/', () => {
  assert.throws(() => optionsFromArgs([]), /--archive is required/);
  assert.throws(() => optionsFromArgs(['--archive', '..']), /workspace/);
  assert.throws(() => optionsFromArgs(['--archive', 'lineup-lab']), /outputs/);
});

test('archive plan includes only metadata and gzip team shards with verified hashes', async () => {
  const fixture = await fixtureArchive();
  try {
    // The CLI intentionally resolves from the repository; direct plan building
    // permits a temporary fixture so the package contract can be tested.
    const plan = await validateLocalArchivePlan(await buildArchiveUploadPlan({ archiveDir: fixture.archive }));
    assert.equal(plan.bucket, 'nba-scout-analytics-archive');
    assert.equal(plan.artifacts.filter((artifact) => artifact.kind === 'team-gzip-shard').length, 1);
    assert.equal(plan.artifacts.some((artifact) => artifact.relativePath.endsWith('.json') && artifact.relativePath.startsWith('teams/')), false);
    assert.equal(plan.totalBytes > 0, true);
    assert.match(plan.prefix, /^schema-v4\/2025-26\/fixture-scout-package-/);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('archive plan accepts a directly-derived package without a repair-only report', async () => {
  const fixture = await fixtureArchive({ includeBoundaryRoleRepairReport: false });
  try {
    const plan = await validateLocalArchivePlan(await buildArchiveUploadPlan({ archiveDir: fixture.archive }));
    assert.equal(plan.artifacts.some((artifact) => artifact.relativePath === 'boundary-role-repair-report.json'), false);
    assert.equal(plan.artifacts.filter((artifact) => artifact.kind === 'team-gzip-shard').length, 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('archive plan includes the current validator report filename', async () => {
  const validationFilename = 'nba-scout-analytics-validation-2025-26.json';
  const fixture = await fixtureArchive({ validationFilename });
  try {
    const plan = await validateLocalArchivePlan(await buildArchiveUploadPlan({ archiveDir: fixture.archive }));
    assert.equal(plan.artifacts.some((artifact) => artifact.relativePath === validationFilename), true);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('remote verification distinguishes missing and size-conflicting immutable objects', async () => {
  const fixture = await fixtureArchive();
  try {
    const plan = await validateLocalArchivePlan(await buildArchiveUploadPlan({ archiveDir: fixture.archive }));
    const remote = new Map([[plan.artifacts[0].remotePath, { size: plan.artifacts[0].bytes + 1 }]]);
    const result = verifyRemoteArtifacts({ plan, remoteArtifacts: remote });
    assert.equal(result.complete, false);
    assert.equal(result.sizeMismatch.length, 1);
    assert.equal(result.missing.length, plan.artifacts.length - 1);
  } finally {
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

test('bucket lookup recognizes the Storage API missing-bucket response shape', async () => {
  const bucket = await getBucket({
    projectUrl: 'https://analytics-project.supabase.co',
    serviceRoleKey: 'test-service-role',
    fetchImpl: async () => ({
      ok: false,
      status: 400,
      text: async () => '{"statusCode":"404","error":"Bucket not found","code":"NoSuchBucket"}',
    }),
  });
  assert.equal(bucket, null);
});

test('new private bucket limit is rounded only to the largest archive artifact', async () => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return {
        ok: false,
        status: 400,
        text: async () => '{"statusCode":"404","code":"NoSuchBucket","message":"Bucket not found"}',
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 'nba-scout-analytics-archive', public: false, file_size_limit: 33554432 }),
    };
  };
  const result = await ensurePrivateBucket({
    projectUrl: 'https://analytics-project.supabase.co',
    serviceRoleKey: 'test-service-role',
    apply: true,
    maxArtifactBytes: 33433588,
    fetchImpl,
  });
  assert.equal(result.status, 'ready');
  assert.equal(JSON.parse(calls[1].options.body).file_size_limit, 32 * 1024 * 1024);
});
