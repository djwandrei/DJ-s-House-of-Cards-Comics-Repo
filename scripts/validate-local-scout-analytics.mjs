import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const options = { input: null, validationReport: null, output: null, seasonStartYear: 2025 };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const [name, inline] = token.split(/=(.*)/s, 2);
    const value = inline ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
    if (name === '--input') options.input = path.resolve(value);
    else if (name === '--validation-report') options.validationReport = path.resolve(value);
    else if (name === '--output') options.output = path.resolve(value);
    else if (name === '--season') options.seasonStartYear = Number.parseInt(value, 10);
    else throw new Error(`Unknown option: ${name}`);
  }
  if (!options.input) throw new Error('--input is required.');
  return options;
}

function closeEnough(left, right, tolerance = 0.002) {
  return left === null || right === null ? left === right : Math.abs(left - right) <= tolerance;
}

function expectedNet(metric) {
  if (metric.offensiveRating === null || metric.defensiveRating === null) return null;
  return Math.round((metric.offensiveRating - metric.defensiveRating) * 1000) / 1000;
}

function checkMetric(metric, label, errors) {
  if (!metric || typeof metric !== 'object') {
    errors.push(`${label} is not an object.`);
    return;
  }
  const offensivePossessions = Number(metric.offensivePossessions);
  const defensivePossessions = Number(metric.defensivePossessions);
  if (!Number.isInteger(offensivePossessions) || offensivePossessions < 0) errors.push(`${label}.offensivePossessions is invalid.`);
  if (!Number.isInteger(defensivePossessions) || defensivePossessions < 0) errors.push(`${label}.defensivePossessions is invalid.`);
  if (metric.totalPossessions !== offensivePossessions + defensivePossessions) errors.push(`${label}.totalPossessions does not reconcile.`);
  if (!closeEnough(metric.netRating, expectedNet(metric))) errors.push(`${label}.netRating does not reconcile.`);
  if (offensivePossessions === 0 && metric.offensiveRating !== null) errors.push(`${label}.offensiveRating must be null with zero offensive possessions.`);
  if (defensivePossessions === 0 && metric.defensiveRating !== null) errors.push(`${label}.defensiveRating must be null with zero defensive possessions.`);
}

async function validate() {
  const options = parseArgs(process.argv.slice(2));
  const [inputRaw, validationRaw] = await Promise.all([
    fs.readFile(options.input, 'utf8'),
    options.validationReport ? fs.readFile(options.validationReport, 'utf8') : Promise.resolve(null),
  ]);
  const input = JSON.parse(inputRaw);
  const validation = validationRaw ? JSON.parse(validationRaw) : null;
  const errors = [];
  const warnings = [];
  const coverage = input.coverage ?? {};
  if (input.schemaVersion !== 1) errors.push('Unsupported Scout analytics schemaVersion.');
  if (input.scope?.seasonStartYear !== options.seasonStartYear) errors.push('Season scope does not match the requested season.');
  if (input.scope?.eligibility !== 'eligibleForPublication=true only') errors.push('Eligibility boundary is not explicit.');
  if (input.scope?.networkAccess !== 'not used' || input.scope?.supabaseWrites !== 'none') errors.push('Output provenance does not prove offline/no-write execution.');
  if (input.provenance?.validationPassed !== true) errors.push('Source validation report was not passed.');
  if (validation) {
    const season = validation.seasons?.find((item) => item.seasonStartYear === options.seasonStartYear);
    if (!season) errors.push('Validation report does not contain the requested season.');
    else {
      if (coverage.archivesDiscovered !== season.files?.discoveredGameFiles) errors.push('Discovered archive count differs from the validation report.');
      if (coverage.archivesEligible !== season.totals?.eligibleForPublication) errors.push('Eligible archive count differs from the validation report.');
      if (coverage.archivesIneligible + coverage.archivesPartial + coverage.archivesEligible !== coverage.archivesDiscovered) errors.push('Archive eligibility counts do not reconcile.');
      if (coverage.exactLineupPossessions + coverage.excludedPossessions !== coverage.possessionsInEligibleArchives) errors.push('Possession inclusion counts do not reconcile.');
    }
  }
  const comboKeys = new Set();
  for (const [index, row] of (input.lineupsAndCombinations ?? []).entries()) {
    const key = `${row.teamId}~${row.size}~${(row.playerIds ?? []).join('|')}`;
    if (comboKeys.has(key)) errors.push(`Duplicate combination key at row ${index}.`);
    comboKeys.add(key);
    if (![2, 3, 4, 5].includes(row.size)) errors.push(`Invalid combination size at row ${index}.`);
    for (const [context, metric] of Object.entries(row.contexts ?? {})) checkMetric(metric, `combination ${index} ${context}`, errors);
  }
  const playerKeys = new Set();
  for (const [index, row] of (input.playerOnOff ?? []).entries()) {
    const key = `${row.teamId}~${row.playerId}`;
    if (playerKeys.has(key)) errors.push(`Duplicate on/off key at row ${index}.`);
    playerKeys.add(key);
    for (const [state, contexts] of Object.entries({ on: row.on, off: row.off })) {
      for (const [context, metric] of Object.entries(contexts ?? {})) checkMetric(metric, `on/off ${index} ${state} ${context}`, errors);
    }
  }
  const wowyKeys = new Set();
  for (const [index, row] of (input.wowy ?? []).entries()) {
    const key = `${row.teamId}~${row.playerAId}~${row.playerBId}`;
    if (wowyKeys.has(key)) errors.push(`Duplicate WOWY key at row ${index}.`);
    wowyKeys.add(key);
    for (const [cell, contexts] of Object.entries(row.cells ?? {})) {
      if (!['a_on_b_on', 'a_on_b_off', 'a_off_b_on', 'a_off_b_off'].includes(cell)) errors.push(`Invalid WOWY cell at row ${index}.`);
      for (const [context, metric] of Object.entries(contexts ?? {})) checkMetric(metric, `WOWY ${index} ${cell} ${context}`, errors);
    }
  }
  const rapm = input.rapm ?? {};
  if (rapm.modelVersion !== 'weighted_ridge_rapm_v1') errors.push('Unexpected RAPM model version.');
  if (!Number.isInteger(rapm.observationCount) || rapm.observationCount <= 0) errors.push('RAPM has no observations.');
  if (!Array.isArray(rapm.players) || rapm.players.length === 0) errors.push('RAPM has no player results.');
  if (input.analyticsAvailability?.halfCourt?.status !== 'proxy_only') warnings.push('Half-court split is not provider-verified.');
  if (input.analyticsAvailability?.confidenceIntervals?.status !== 'not_available') errors.push('Confidence interval availability is misstated.');
  const report = {
    schemaVersion: 1,
    validatedAt: new Date().toISOString(),
    inputPath: options.input,
    inputSha256: crypto.createHash('sha256').update(inputRaw).digest('hex'),
    passed: errors.length === 0,
    errors,
    warnings,
    checks: {
      combinations: input.lineupsAndCombinations?.length ?? 0,
      onOff: input.playerOnOff?.length ?? 0,
      wowy: input.wowy?.length ?? 0,
      rapmPlayers: rapm.players?.length ?? 0,
      eligibleArchives: coverage.archivesEligible ?? null,
      exactLineupPossessions: coverage.exactLineupPossessions ?? null,
    },
  };
  const output = options.output || `${options.input}.validation.json`;
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ output, passed: report.passed, errors: errors.length, warnings: warnings.length, checks: report.checks }, null, 2)}\n`);
  if (!report.passed) process.exitCode = 1;
}

validate().catch((error) => {
  process.stderr.write(`${String(error?.stack ?? error)}\n`);
  process.exitCode = 1;
});
