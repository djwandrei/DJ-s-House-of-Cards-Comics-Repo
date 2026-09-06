import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rebuildOptions } from './rebuild-scout-model-evidence.mjs';
import { refreshScoutSummaries, summaryRefreshOptions } from './refresh-scout-model-summaries.mjs';

// Sequential imports only: finish the older archive's missing games before
// spending the remaining request budget on newer official Summary fields.
// No call to the analytics builder exists in this entry point. One inherited
// key serves both stages, so parallel workers cannot accidentally burst QPS.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE_ROOT = path.join(ROOT, 'outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons');
const olderArchive = path.join(ARCHIVE_ROOT, 'data-2020-2021-trial');
const downloader = path.join(ARCHIVE_ROOT, 'work/download-sportradar-nba-archive.mjs');
const emit = value => process.stdout.write(`${JSON.stringify({ ...value, processId: process.pid, rebuildStarted: false, updatedAt: new Date().toISOString() })}\n`);

try {
  const args = process.argv.slice(2);
  const { rebuildArgs, requestBudget } = summaryRefreshOptions(args);
  const options = rebuildOptions(rebuildArgs);
  assert.ok(requestBudget, 'Set an explicit request budget for the newer-summary stage.');
  assert.equal(options.archive, path.join(ARCHIVE_ROOT, 'data-2022-2025-trial-composed'));
  assert.ok(process.env.SPORTRADAR_NBA_API_KEY, 'An API key must be inherited in the process environment.');
  // This run intentionally has ONE active credential. Already limited keys
  // are not silently retried by the legacy downloader's rotation mechanism.
  for (const name of Object.keys(process.env)) if (/^SPORTRADAR_NBA_API_KEY_\d+$/.test(name)) delete process.env[name];
  const previous = JSON.parse(await fs.readFile(path.join(olderArchive, '2021/manifest.json'), 'utf8'));
  assert.ok(previous.licenseReference, 'Retain the existing source authorization reference.');
  const manifests = await Promise.all([2020, 2021].map(async year => JSON.parse(await fs.readFile(path.join(olderArchive, `${year}/manifest.json`), 'utf8'))));
  const pendingYears = manifests.filter(manifest => {
    const entries = Object.values(manifest.games ?? {});
    return !Number.isSafeInteger(manifest.uniqueEligibleGames)
      || entries.filter(row => row.status === 'completed').length !== manifest.uniqueEligibleGames
      || entries.some(row => row.status !== 'completed');
  }).map(manifest => manifest.seasonStartYear);
  // Completed seasons avoid unnecessary schedule requests. The separate
  // filesystem/source audit still verifies their actual records before use;
  // manifest counts alone are never treated as full data validation.
  emit({ phase: 'older_source_import', seasons: pendingYears });
  const exitCode = pendingYears.length ? await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [downloader, '--output-dir', olderArchive,
      '--seasons', pendingYears.join(','), '--access-level', 'trial', '--resume',
      '--request-delay-ms', '2000', '--transient-429-retries', '0', '--max-games', '100'], {
      cwd: ROOT, windowsHide: true, stdio: 'inherit',
      env: { ...process.env, SPORTRADAR_NBA_LICENSE_CONFIRMED: 'confirmed', SPORTRADAR_NBA_LICENSE_REFERENCE: previous.licenseReference },
    });
    child.on('error', reject); child.on('exit', resolve);
  }) : 0;
  assert.equal(exitCode, 0, 'Older-season downloader stopped; no next-stage request was made.');
  const report = pendingYears.length ? JSON.parse(await fs.readFile(path.join(olderArchive, 'download-report.json'), 'utf8')) : { seasons: [], failedGames: 0 };
  assert.deepEqual(report.seasons.map(row => row.year), pendingYears);
  emit({ phase: 'older_source_checkpoint', seasons: report.seasons });
  assert.ok(report.seasons.every(row => !row.stoppedEarly), 'Older import paused; review its checkpoint before continuing.');
  // A malformed source field remains an explicit unresolved game. It does not
  // justify fabricated counts, but other independent imports may still proceed.
  await new Promise(resolve => setTimeout(resolve, 2000));
  emit({ phase: 'newer_summary_import', seasons: options.readiness.seasons, requestBudget });
  const summaries = await refreshScoutSummaries(args);
  emit({ phase: 'import_checkpoint', olderUnresolvedGames: report.failedGames, summaries,
    readyForRebuild: false, requiredNextCheck: 'Six-season completeness and independent source reconciliation.' });
} catch (error) {
  // Provider bodies and credentials are never printed. Detailed data-specific
  // diagnostics remain in the downloader's existing private checkpoints.
  emit({ phase: 'stopped_needs_review', code: error.code ?? 'IMPORT_CHECK_FAILED',
    httpStatus: Number.isInteger(error.status) ? error.status : null });
  process.exitCode = 1;
}
