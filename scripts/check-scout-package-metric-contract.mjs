#!/usr/bin/env node

/**
 * Verify that a rebuilt Scout package retains the metric surface of a trusted
 * reference package while expanding its season scope. This checks published
 * schema/metric definitions and availability declarations; it does not make
 * a coverage claim for an individual historical player or game.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const PRIVATE_ROOT = path.join(REPOSITORY_ROOT, 'outputs');

function parseSeasons(value) {
  const years = String(value).split(',').map((item) => Number.parseInt(item.trim(), 10));
  if (!years.length || years.some((year) => !Number.isInteger(year) || year < 1947 || year > 2200)) {
    throw new Error('--expect-seasons must be a comma-separated list of NBA season start years.');
  }
  const unique = [...new Set(years)].sort((left, right) => left - right);
  if (unique.length !== years.length) throw new Error('--expect-seasons must not repeat a season.');
  return unique;
}

export function optionsFromArgs(argv) {
  const options = { referencePackage: null, candidatePackage: null, expectedSeasons: null, outputReport: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inlineValue] = token.split(/=(.*)/s, 2);
    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--reference-package') options.referencePackage = path.resolve(value);
    else if (name === '--candidate-package') options.candidatePackage = path.resolve(value);
    else if (name === '--expect-seasons') options.expectedSeasons = parseSeasons(value);
    else if (name === '--output-report') options.outputReport = path.resolve(value);
    else throw new Error(`Unknown option: ${name}`);
  }
  for (const [name, value] of Object.entries(options)) {
    if ((name !== 'expectedSeasons') && !value) throw new Error(`--${name.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)} is required.`);
  }
  if (!options.expectedSeasons?.length) throw new Error('--expect-seasons is required.');
  return options;
}

function isPrivateDescendant(target, privateRoot) {
  const relative = path.relative(privateRoot, target);
  return Boolean(relative) && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function requirePrivatePath(target, privateRoot, label) {
  if (!isPrivateDescendant(target, privateRoot)) throw new Error(`${label} must remain under the private outputs root.`);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const asPosix = (value) => value.replaceAll('\\', '/');

async function readPackage(target, label) {
  try {
    const raw = await fs.readFile(target, 'utf8');
    return { raw, value: JSON.parse(raw) };
  } catch (error) {
    throw new Error(`Cannot read ${label}: ${String(error?.message ?? error)}`);
  }
}

function availabilityKeys(pkg) {
  return Object.entries(pkg?.analyticsAvailability ?? {})
    .filter(([, value]) => value && typeof value === 'object' && String(value.status ?? '').startsWith('available'))
    .map(([key]) => key)
    .sort();
}

function missingKeys(actual, expected) {
  return expected.filter((key) => !Object.hasOwn(actual ?? {}, key));
}

function stableSeasons(value) {
  return Array.isArray(value) ? value.map(Number).sort((left, right) => left - right) : [];
}

function issue(errors, code, details = {}) {
  errors.push({ code, ...details });
}

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function writeAtomic(target, body) {
  const temporary = `${target}.partial-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temporary, body, 'utf8');
  await fs.rename(temporary, target);
}

export async function checkScoutPackageMetricContract({ referencePackage, candidatePackage, expectedSeasons, outputReport, privateRoot = PRIVATE_ROOT }) {
  const privateOutputRoot = path.resolve(privateRoot);
  const referencePath = path.resolve(referencePackage);
  const candidatePath = path.resolve(candidatePackage);
  const reportPath = path.resolve(outputReport);
  for (const [target, label] of [[referencePath, 'Reference package'], [candidatePath, 'Candidate package'], [reportPath, 'Output report']]) {
    requirePrivatePath(target, privateOutputRoot, label);
  }
  if (await exists(reportPath)) throw new Error(`Refusing to overwrite an existing metric-contract report: ${reportPath}`);
  const reference = await readPackage(referencePath, 'reference package');
  const candidate = await readPackage(candidatePath, 'candidate package');
  const errors = [];
  const referenceValue = reference.value;
  const candidateValue = candidate.value;
  const referenceDefinitions = Object.keys(referenceValue?.definitions ?? {}).sort();
  const referenceTables = Object.keys(referenceValue?.tables ?? {}).sort();
  const referenceAnalytics = availabilityKeys(referenceValue);

  if (!referenceDefinitions.length || !referenceTables.length || !referenceAnalytics.length) {
    throw new Error('Reference package does not contain a usable Scout metric surface.');
  }
  for (const key of ['schemaVersion', 'metricsVersion', 'provider']) {
    if (candidateValue?.[key] !== referenceValue?.[key]) issue(errors, 'package_identity_mismatch', { key, expected: referenceValue?.[key] ?? null, actual: candidateValue?.[key] ?? null });
  }
  const candidateSeasons = stableSeasons(candidateValue?.scope?.seasonStartYears);
  if (JSON.stringify(candidateSeasons) !== JSON.stringify(expectedSeasons)) {
    issue(errors, 'season_scope_mismatch', { expected: expectedSeasons, actual: candidateSeasons });
  }
  const missingDefinitions = missingKeys(candidateValue?.definitions, referenceDefinitions);
  if (missingDefinitions.length) issue(errors, 'missing_definition_families', { keys: missingDefinitions });
  const missingTables = missingKeys(candidateValue?.tables, referenceTables);
  if (missingTables.length) issue(errors, 'missing_analytic_tables', { keys: missingTables });
  const missingAnalytics = referenceAnalytics.filter((key) => !String(candidateValue?.analyticsAvailability?.[key]?.status ?? '').startsWith('available'));
  if (missingAnalytics.length) issue(errors, 'missing_available_analytics', { keys: missingAnalytics });
  if (candidateValue?.provenance?.sourceArchiveValidationPassed !== true) issue(errors, 'source_archive_validation_not_passed');

  const sourceAccess = candidateValue?.provenance?.sourceAccessLevelsBySeason ?? {};
  const sourceIntegrity = candidateValue?.provenance?.sourceGameFileIntegrityBySeason ?? {};
  for (const season of expectedSeasons) {
    if (sourceAccess[String(season)] !== 'trial') issue(errors, 'source_access_level_mismatch', { seasonStartYear: season, actual: sourceAccess[String(season)] ?? null });
    if (!Number.isSafeInteger(Number(sourceIntegrity[String(season)]?.expectedFileCount)) || Number(sourceIntegrity[String(season)]?.expectedFileCount) <= 0) {
      issue(errors, 'source_file_integrity_missing', { seasonStartYear: season });
    }
  }
  const report = {
    schemaVersion: 'scout-package-metric-contract-report-v1',
    checkedAt: new Date().toISOString(),
    passed: errors.length === 0,
    reference: {
      package: asPosix(path.relative(REPOSITORY_ROOT, referencePath)),
      sha256: sha256(reference.raw),
      schemaVersion: referenceValue?.schemaVersion ?? null,
      metricsVersion: referenceValue?.metricsVersion ?? null,
      provider: referenceValue?.provider ?? null,
      definitionFamilies: referenceDefinitions,
      tables: referenceTables,
      availableAnalytics: referenceAnalytics,
    },
    candidate: {
      package: asPosix(path.relative(REPOSITORY_ROOT, candidatePath)),
      sha256: sha256(candidate.raw),
      seasonStartYears: candidateSeasons,
    },
    expectedSeasons,
    errors,
  };
  await writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { report, reportPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  checkScoutPackageMetricContract(optionsFromArgs(process.argv.slice(2))).then(({ report, reportPath }) => {
    process.stdout.write(`${JSON.stringify({ passed: report.passed, errors: report.errors.length, reportPath })}\n`);
    if (!report.passed) process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`Scout package metric-contract check failed: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
