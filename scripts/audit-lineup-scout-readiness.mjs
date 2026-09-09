import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assessLineupScoutReadiness } from './lib/lineup-scout-readiness.mjs';

// Read-only and explicitly addressed: never auto-select a "latest" directory
// while another task is writing it. In particular, do not fall back to an old
// two-season archive if the new four-season manifest has not appeared yet.
export function parseReadinessArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!['--manifest', '--package-validation', '--source-validation', '--seasons'].includes(name)
      || !value || value.startsWith('--') || Object.hasOwn(values, name)) {
      throw new Error('Use each of --manifest, --package-validation, --source-validation, and --seasons exactly once, with a value.');
    }
    values[name] = value;
  }
  if (Object.keys(values).length !== 4 || !/^\d{4}(,\d{4})+$/.test(values['--seasons'] ?? '')) {
    throw new Error('Required: --manifest <json> --package-validation <json> --source-validation <json> --seasons 2020,2021,2022,2023,2024,2025');
  }
  return {
    manifest: path.resolve(values['--manifest']),
    packageValidation: path.resolve(values['--package-validation']),
    sourceValidation: path.resolve(values['--source-validation']),
    seasons: values['--seasons'].split(',').map(Number),
  };
}

export async function readReadinessMetadata(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const stat = await handle.stat();
    // This bounds accidental reads of giant team shards, not the model's
    // candidate/player count. Only the small manifest and reports belong here.
    const maxMetadataBytes = 16 * 1024 * 1024;
    if (!stat.isFile() || stat.size > maxMetadataBytes) throw new Error(`Expected metadata JSON no larger than 16 MiB: ${filePath}`);
    const raw = await handle.readFile();
    if (raw.length > maxMetadataBytes) throw new Error(`Metadata grew beyond 16 MiB while reading: ${filePath}`);
    return { data: JSON.parse(raw.toString('utf8')), sha256: createHash('sha256').update(raw).digest('hex') };
  } catch (error) {
    if (error.code === 'ENOENT') return { data: null, sha256: null };
    throw error; // Incomplete JSON, access failures, and wrong paths never pass.
  } finally {
    await handle?.close();
  }
}

export async function runReadinessAudit(argv) {
  const options = parseReadinessArgs(argv);
  const [manifest, packageValidation, sourceValidation] = await Promise.all([
    readReadinessMetadata(options.manifest),
    readReadinessMetadata(options.packageValidation),
    readReadinessMetadata(options.sourceValidation),
  ]);
  return assessLineupScoutReadiness({
    manifest: manifest.data, manifestSha256: manifest.sha256,
    packageValidation: packageValidation.data,
    sourceValidation: sourceValidation.data, sourceValidationSha256: sourceValidation.sha256,
    expectedSeasonStartYears: options.seasons,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runReadinessAudit(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'pending' ? 2 : result.readyForIntegrationReview ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Scout readiness audit failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
