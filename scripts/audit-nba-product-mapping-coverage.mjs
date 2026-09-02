import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildNbaProductMappingCoverage } from './lib/nba-product-mapping-coverage.mjs';

const ROOT = process.cwd();

function workspacePath(relativePath, label) {
  const resolved = path.resolve(ROOT, String(relativePath || ''));
  const root = path.resolve(ROOT);
  const prefix = `${root}${path.sep}`.toLowerCase();
  if (resolved.toLowerCase() !== root.toLowerCase()
    && !resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  return resolved;
}

export function optionsFromArgs(argv = []) {
  const options = {
    catalogPath: 'products.json',
    mappingSnapshotPath: '',
    reportPath: 'outputs/nba-product-mapping-coverage.json',
  };
  for (const argument of argv) {
    if (argument.startsWith('--catalog=')) options.catalogPath = argument.slice('--catalog='.length);
    else if (argument.startsWith('--mapping-snapshot=')) {
      options.mappingSnapshotPath = argument.slice('--mapping-snapshot='.length);
    } else if (argument.startsWith('--report=')) options.reportPath = argument.slice('--report='.length);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function latestMappingSnapshot() {
  const outputDirectory = path.join(ROOT, 'outputs');
  const names = await fs.readdir(outputDirectory);
  const candidates = names
    .filter((name) => /^nba-product-athlete-mappings-backup-.*\.json$/i.test(name))
    .sort((left, right) => right.localeCompare(left));
  if (!candidates.length) {
    throw new Error('No local NBA product mapping snapshot is available.');
  }
  return path.join(outputDirectory, candidates[0]);
}

export async function main(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  const catalogPath = workspacePath(options.catalogPath, 'Catalog path');
  const snapshotPath = options.mappingSnapshotPath
    ? workspacePath(options.mappingSnapshotPath, 'Mapping snapshot path')
    : await latestMappingSnapshot();
  const reportPath = workspacePath(options.reportPath, 'Report path');
  const [products, mappingRows] = await Promise.all([
    fs.readFile(catalogPath, 'utf8').then(JSON.parse),
    fs.readFile(snapshotPath, 'utf8').then(JSON.parse),
  ]);
  if (!Array.isArray(products) || !Array.isArray(mappingRows)) {
    throw new Error('Catalog and mapping snapshot must both be JSON arrays.');
  }

  const coverage = buildNbaProductMappingCoverage({ products, mappingRows });
  const report = {
    generatedAt: new Date().toISOString(),
    mode: 'review_only',
    policy: 'verified-snapshot-exact-source-name-consistency',
    catalogPath: path.relative(ROOT, catalogPath).replace(/\\/g, '/'),
    mappingSnapshotPath: path.relative(ROOT, snapshotPath).replace(/\\/g, '/'),
    ...coverage,
  };
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const expansionCandidates = report.queue
    .filter((item) => item.disposition === 'source_consistent_exact_candidate')
    .map((item) => ({
      productId: item.productId,
      productName: item.current.productName,
      playerAthlete: item.current.playerAthlete,
      proposedAthleteIds: item.proposed.map((subject) => subject.athleteId),
    }));
  console.log(JSON.stringify({
    ...report.summary,
    reportPath: path.relative(ROOT, reportPath).replace(/\\/g, '/'),
    expansionCandidates,
  }, null, 2));
  return report;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
