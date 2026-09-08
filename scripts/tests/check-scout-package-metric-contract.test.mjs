import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { checkScoutPackageMetricContract, optionsFromArgs } from '../check-scout-package-metric-contract.mjs';

function scoutPackage(seasons, { metricsVersion = 'nba-scout-metrics-v4', omitAnalytics = false } = {}) {
  return {
    schemaVersion: 4,
    metricsVersion,
    provider: 'Sportradar NBA v8 licensed local archive',
    scope: { seasonStartYears: seasons },
    definitions: { fourFactors: {}, netRating: {} },
    tables: { teams: 30, playerProfiles: 1 },
    analyticsAvailability: omitAnalytics ? { onOff: { status: 'available' } } : {
      onOff: { status: 'available' }, directPlayerBoxScoreTotals: { status: 'available_with_coverage' },
    },
    provenance: {
      sourceArchiveValidationPassed: true,
      sourceAccessLevelsBySeason: Object.fromEntries(seasons.map((year) => [year, 'trial'])),
      sourceGameFileIntegrityBySeason: Object.fromEntries(seasons.map((year) => [year, { expectedFileCount: 1 }])),
    },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-package-contract-'));
  const reference = path.join(root, 'reference.json');
  const candidate = path.join(root, 'candidate.json');
  await fs.writeFile(reference, JSON.stringify(scoutPackage([2020, 2021])));
  await fs.writeFile(candidate, JSON.stringify(scoutPackage([2017, 2020, 2021])));
  return { root, reference, candidate, report: path.join(root, 'report.json') };
}

test('parses the package metric-contract command', () => {
  const options = optionsFromArgs([
    '--reference-package', 'outputs/reference.json', '--candidate-package', 'outputs/candidate.json',
    '--expect-seasons', '2017,2020', '--output-report', 'outputs/report.json',
  ]);
  assert.deepEqual(options.expectedSeasons, [2017, 2020]);
});

test('accepts an expanded package that retains the reference metric surface', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  const result = await checkScoutPackageMetricContract({
    referencePackage: setup.reference, candidatePackage: setup.candidate, expectedSeasons: [2017, 2020, 2021], outputReport: setup.report, privateRoot: setup.root,
  });
  assert.equal(result.report.passed, true);
  assert.equal(await fs.stat(setup.report).then(() => true), true);
});

test('reports a missing reference analytics surface', async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.root, { recursive: true, force: true }));
  await fs.writeFile(setup.candidate, JSON.stringify(scoutPackage([2017, 2020, 2021], { omitAnalytics: true })));
  const result = await checkScoutPackageMetricContract({
    referencePackage: setup.reference, candidatePackage: setup.candidate, expectedSeasons: [2017, 2020, 2021], outputReport: setup.report, privateRoot: setup.root,
  });
  assert.equal(result.report.passed, false);
  assert.ok(result.report.errors.some((error) => error.code === 'missing_available_analytics'));
});
