#!/usr/bin/env node

/**
 * Build an immutable FreeImage upload/reference plan for NFL player photos.
 *
 * A provided reference icon is matched by exact SHA-256, not visual
 * similarity. Matching players receive one canonical hosted-image reference;
 * every other staged file remains in its source batch for upload.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const SPORT = 'nfl';
const BATCH_COUNT = 37;
const STAGING_ROOT = path.join(ROOT, 'outputs', 'freeimage-staging', SPORT);
const OUTPUT_ROOT = path.join(ROOT, 'outputs', 'freeimage-upload-runs', SPORT);

function usage() {
  return `
Usage:
  node .\\scripts\\build-freeimage-nfl-default-icon-plan.mjs [options]

Required:
  --reference-image <path>          Local default-icon image to match exactly
  --canonical-viewer-url <https>    Existing FreeImage viewer URL for the one icon
  --canonical-asset-url <https>     Direct image URL for the one icon

Options:
  --output-dir <path>               New output directory (default: hash-based)
  --existing-hosted-ledger <path>   Verified hosted rows to omit from upload batches
  --help                            Show this help

Reads completed outputs/freeimage-staging/nfl/batch-####-#### manifests and
writes a new, immutable local plan under outputs/freeimage-upload-runs/nfl.
`;
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (name === 'help') return { help: true };
    if (!['reference-image', 'canonical-viewer-url', 'canonical-asset-url', 'output-dir', 'existing-hosted-ledger'].includes(name)) {
      throw new Error(`Unknown option: --${name}`);
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values.set(name, value);
  }
  for (const name of ['reference-image', 'canonical-viewer-url', 'canonical-asset-url']) {
    if (!values.has(name)) throw new Error(`--${name} is required.`);
  }
  const validateHttps = (name) => {
    const value = String(values.get(name));
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
      throw new Error(`--${name} must be a plain HTTPS URL.`);
    }
    return url.href;
  };
  return {
    help: false,
    referenceImage: path.resolve(String(values.get('reference-image'))),
    canonicalViewerUrl: validateHttps('canonical-viewer-url'),
    canonicalAssetUrl: validateHttps('canonical-asset-url'),
    outputDirectory: values.has('output-dir') ? path.resolve(String(values.get('output-dir'))) : null,
    existingHostedLedger: values.has('existing-hosted-ledger') ? path.resolve(String(values.get('existing-hosted-ledger'))) : null,
  };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function batchDirectoryName(number) {
  return `batch-${String(number).padStart(4, '0')}-0001`;
}

function batchLabel(number) {
  return `${String(number).padStart(4, '0')}-of-${String(BATCH_COUNT).padStart(4, '0')}`;
}

async function loadCompletedBatches() {
  const batches = [];
  const missing = [];
  for (let number = 1; number <= BATCH_COUNT; number += 1) {
    const directory = path.join(STAGING_ROOT, batchDirectoryName(number));
    const manifestPath = path.join(directory, 'manifest.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      if (!Array.isArray(manifest.outcomes)) throw new Error('outcomes array missing');
      batches.push({ number, label: batchLabel(number), directory, manifest });
    } catch (error) {
      missing.push({ batch: batchLabel(number), reason: String(error.message ?? error) });
    }
  }
  if (missing.length) {
    throw new Error(`Refusing to build a partial plan; ${missing.length} staging manifest(s) are incomplete or missing: ${JSON.stringify(missing)}`);
  }
  return batches;
}

async function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(temporaryPath, content, 'utf8');
  await fs.rename(temporaryPath, filePath);
}

function asJsonl(rows) {
  return rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

async function loadExistingHostedRows(ledgerPath) {
  if (!ledgerPath) return new Map();
  const text = await fs.readFile(ledgerPath, 'utf8');
  const byStagedFile = new Map();
  for (const [index, line] of text.split(/\r?\n/).filter(Boolean).entries()) {
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`Existing-hosted ledger line ${index + 1} is invalid JSON: ${String(error.message ?? error)}`);
    }
    if (row.reconciliation_status !== 'matched_and_verified' || row.hosted_asset_matches_staged_bytes !== true) {
      throw new Error(`Existing-hosted ledger line ${index + 1} is not byte-verified.`);
    }
    const playerId = String(row.player_id ?? '').trim();
    const stagedFile = path.resolve(ROOT, String(row.staged_file ?? ''));
    if (!playerId || !stagedFile) throw new Error(`Existing-hosted ledger line ${index + 1} is missing player_id or staged_file.`);
    const directUrl = new URL(String(row.direct_hosted_asset_url ?? ''));
    const viewerUrl = new URL(String(row.viewer_url ?? ''));
    if (directUrl.protocol !== 'https:' || viewerUrl.protocol !== 'https:') {
      throw new Error(`Existing-hosted ledger line ${index + 1} contains a non-HTTPS hosted URL.`);
    }
    if (byStagedFile.has(stagedFile)) throw new Error(`Existing-hosted ledger repeats staged file: ${stagedFile}`);
    byStagedFile.set(stagedFile, row);
  }
  return byStagedFile;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const reference = await fs.readFile(options.referenceImage);
  if (reference.length < 512) throw new Error('Reference image is too small to be a valid player-icon asset.');
  const referenceSha256 = sha256(reference);
  const outputDirectory = options.outputDirectory
    ?? path.join(OUTPUT_ROOT, `default-icon-${referenceSha256.slice(0, 16)}`);
  await fs.mkdir(path.dirname(outputDirectory), { recursive: true });
  try {
    await fs.mkdir(outputDirectory, { recursive: false });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Refusing to overwrite existing plan directory: ${outputDirectory}`);
    throw error;
  }
  const batches = await loadCompletedBatches();
  const existingHostedByFile = await loadExistingHostedRows(options.existingHostedLedger);
  const defaultRows = [];
  const alreadyHostedRows = [];
  const uploadBatches = [];
  const missingFiles = [];
  const failedSources = [];
  let stagedRows = 0;

  for (const batch of batches) {
    const uploadRows = [];
    for (const outcome of batch.manifest.outcomes) {
      if (!['staged', 'staged_existing'].includes(outcome.status)) {
        failedSources.push({ batch: batch.label, ...outcome });
        continue;
      }
      const filePath = path.join(batch.directory, outcome.file);
      let fileStats;
      try {
        fileStats = await fs.stat(filePath);
      } catch (error) {
        missingFiles.push({ batch: batch.label, player_id: outcome.player_id, file: outcome.file, error: String(error.message ?? error) });
        continue;
      }
      stagedRows += 1;
      // Nearly all player photos differ in byte length, so avoid reading them
      // merely to rule out an exact match with the reference placeholder.
      const isDefaultIcon = fileStats.size === reference.length
        && sha256(await fs.readFile(filePath)) === referenceSha256;
      const base = {
        sport: SPORT,
        batch: batch.label,
        player_id: outcome.player_id,
        player_name: outcome.player_name,
        original_remote_url: outcome.remote_url,
        source_url: outcome.source_url,
        source_name: outcome.source_name,
        rights_confirmed: Boolean(outcome.rights_confirmed),
        staged_file: filePath,
        source_sha256: isDefaultIcon ? referenceSha256 : null,
      };
      if (isDefaultIcon) {
        defaultRows.push({
          ...base,
          transfer_status: 'canonical_default_icon_reference',
          canonical_freeimage_viewer_url: options.canonicalViewerUrl,
          canonical_asset_url: options.canonicalAssetUrl,
        });
      } else {
        const existingHosted = existingHostedByFile.get(filePath);
        if (existingHosted) {
          if (String(existingHosted.player_id) !== String(outcome.player_id)
            || String(existingHosted.original_remote_url) !== String(outcome.remote_url)) {
            throw new Error(`Existing-hosted ledger does not match staged player/source: ${filePath}`);
          }
          alreadyHostedRows.push({
            ...base,
            transfer_status: 'already_hosted_and_verified',
            freeimage_viewer_url: String(existingHosted.viewer_url),
            canonical_asset_url: String(existingHosted.direct_hosted_asset_url),
          });
        } else {
          uploadRows.push({ ...base, transfer_status: 'upload_required' });
        }
      }
    }
    uploadBatches.push({ batch: batch.label, rows: uploadRows });
  }

  if (missingFiles.length) {
    throw new Error(`Refusing to emit a plan with ${missingFiles.length} missing staged file(s): ${JSON.stringify(missingFiles.slice(0, 20))}`);
  }
  const uploadDirectory = path.join(outputDirectory, 'upload-batches');
  await fs.mkdir(uploadDirectory, { recursive: false });
  for (const batch of uploadBatches) {
    await atomicWrite(path.join(uploadDirectory, `${batch.batch}.jsonl`), asJsonl(batch.rows));
  }
  await atomicWrite(path.join(outputDirectory, 'default-icon-player-references.jsonl'), asJsonl(defaultRows));
  await atomicWrite(path.join(outputDirectory, 'already-hosted-player-references.jsonl'), asJsonl(alreadyHostedRows));
  await atomicWrite(path.join(outputDirectory, 'source-failures.jsonl'), asJsonl(failedSources));
  const summary = {
    sport: SPORT,
    created_at: new Date().toISOString(),
    reference_image: options.referenceImage,
    reference_sha256: referenceSha256,
    reference_bytes: reference.length,
    canonical_freeimage_viewer_url: options.canonicalViewerUrl,
    canonical_asset_url: options.canonicalAssetUrl,
    expected_batches: BATCH_COUNT,
    staged_rows: stagedRows,
    default_icon_players: defaultRows.length,
    already_hosted_verified: alreadyHostedRows.length,
    new_non_default_uploads_required: uploadBatches.reduce((sum, batch) => sum + batch.rows.length, 0),
    source_failures: failedSources.length,
    outputs: {
      default_icon_players: 'default-icon-player-references.jsonl',
      already_hosted_players: 'already-hosted-player-references.jsonl',
      non_default_upload_batches: 'upload-batches',
      source_failures: 'source-failures.jsonl',
    },
  };
  await atomicWrite(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output_directory: outputDirectory, ...summary })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
