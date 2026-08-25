#!/usr/bin/env node

/**
 * Fit deterministic, league-wide weighted ridge RAPM from only completed,
 * eligible Sportradar five-on-five stints. Default mode is read-only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fitWeightedRidgeRapm, RAPM_MODEL_VERSION } from './lib/nba-rapm.mjs';
import { assertAnalyticsProjectTarget } from './lib/nba-analytics-project-target.mjs';

const ROOT = process.cwd();
const APPLY_CONFIRMATION_ENV = 'NBA_RAPM_DERIVE_ALLOW_WRITE';
const CODE_VERSION = 'djhc-nba-rapm-cli-v1';

function usage() {
  return `
Usage:
  node .\\scripts\\derive-nba-rapm.mjs --season-end <year> [options]

Options:
  --season-end <year>       NBA season ending year, e.g. 2025 for 2024-25 (required)
  --phase <regular|playoffs>  Season phase (default: regular)
  --lambda <number>         Positive ridge penalty (default: 100)
  --minimum-exposure <n>    Possessions required for display eligibility (default: 100)
  --report <workspace path> Write a non-secret model report
  --apply                   Persist the model and impacts with the private RPC
  --help                    Show this help

Required:
  SUPABASE_URL=https://your-project.supabase.co
  NBA_ANALYTICS_SUPABASE_URL=https://your-analytics-project.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

Additional requirement for --apply:
  ${APPLY_CONFIRMATION_ENV}=confirmed
`;
}

function parser(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values.set(name, inline);
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) values.set(name, argv[++index]);
    else flags.add(name);
  }
  return { values, flags };
}

function integer(value, name, min, max) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new RangeError(`${name} must be an integer from ${min} through ${max}.`);
  return parsed;
}

function positiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new RangeError(`${name} must be a positive number.`);
  return parsed;
}

export function optionsFromArgs(argv = []) {
  const { values, flags } = parser(argv);
  const known = new Set(['help', 'season-end', 'phase', 'lambda', 'minimum-exposure', 'report', 'apply']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  if (flags.has('help')) return { help: true };
  if (!values.has('season-end')) throw new Error('--season-end is required.');
  const phase = String(values.get('phase') ?? 'regular').trim().toLowerCase();
  if (!['regular', 'playoffs'].includes(phase)) throw new Error('--phase must be regular or playoffs.');
  return {
    help: false,
    apply: flags.has('apply'),
    seasonEndYear: integer(values.get('season-end'), '--season-end', 1947, 2200),
    phase,
    lambda: positiveNumber(values.get('lambda') ?? 100, '--lambda'),
    minimumExposure: positiveNumber(values.get('minimum-exposure') ?? 100, '--minimum-exposure'),
    reportPath: String(values.get('report') ?? '').trim(),
  };
}

function projectConfiguration({ requireApply }) {
  const projectUrl = assertAnalyticsProjectTarget({
    projectUrl: process.env.SUPABASE_URL,
    expectedProjectUrl: process.env.NBA_ANALYTICS_SUPABASE_URL,
  });
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to fetch the private RAPM source rows.');
  }
  if (requireApply && String(process.env[APPLY_CONFIRMATION_ENV] ?? '').trim().toLowerCase() !== 'confirmed') {
    throw new Error(`--apply requires ${APPLY_CONFIRMATION_ENV}=confirmed.`);
  }
  return { projectUrl, serviceRoleKey };
}

async function requestJson(url, serviceRoleKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname} failed with HTTP ${response.status}: ${body.slice(0, 800)}`);
  return body ? JSON.parse(body) : null;
}

export function modelPayload(model, { minimumExposure, codeVersion = CODE_VERSION } = {}) {
  return {
    model: {
      methodVersion: model.modelVersion || RAPM_MODEL_VERSION,
      seasonEndYear: model.seasonEndYear,
      seasonPhase: model.seasonPhase,
      lambda: model.lambda,
      observationCount: model.observationCount,
      gameCount: model.gameCount,
      excludedStintCount: model.excludedStintCount,
      inputSha256: model.inputSha256,
      codeVersion,
      errorSummary: model.excluded.length ? `${model.excluded.length} invalid source stint(s) excluded.` : '',
    },
    players: model.players.map((player) => ({
      ...player,
      displayEligible: player.pairedPossessions >= minimumExposure,
    })),
  };
}

async function writeReport(reportPath, report) {
  if (!reportPath) return;
  const resolved = path.resolve(ROOT, reportPath);
  const root = path.resolve(ROOT).toLowerCase();
  if (resolved.toLowerCase() !== root && !resolved.toLowerCase().startsWith(`${root}${path.sep}`)) {
    throw new Error('--report must stay inside this workspace.');
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = optionsFromArgs(argv);
  if (options.help) {
    console.log(usage());
    return { help: true };
  }
  const config = projectConfiguration({ requireApply: options.apply });
  const request = dependencies.requestJson ?? requestJson;
  const rows = await request(`${config.projectUrl}/rest/v1/rpc/get_nba_rapm_stints`, config.serviceRoleKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_season_end_year: options.seasonEndYear, p_season_phase: options.phase }),
  });
  if (!Array.isArray(rows)) throw new Error('Private RAPM source RPC did not return a JSON array.');
  const model = fitWeightedRidgeRapm(rows, {
    lambda: options.lambda,
    seasonEndYear: options.seasonEndYear,
    seasonPhase: options.phase,
  });
  const payload = modelPayload(model, { minimumExposure: options.minimumExposure });
  let remote = null;
  if (options.apply) {
    remote = await request(`${config.projectUrl}/rest/v1/rpc/ingest_nba_rapm_model`, config.serviceRoleKey, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  }
  const report = {
    sourceRows: rows.length,
    mode: options.apply ? 'apply' : 'dry-run',
    seasonEndYear: options.seasonEndYear,
    phase: options.phase,
    minimumExposure: options.minimumExposure,
    model: {
      ...payload.model,
      interceptPer100: model.interceptPer100,
      playerCount: model.players.length,
      displayEligiblePlayers: payload.players.filter((player) => player.displayEligible).length,
    },
    topPlayers: [...payload.players]
      .sort((left, right) => right.rapmPer100 - left.rapmPer100)
      .slice(0, 25),
    remote,
    generatedAt: new Date().toISOString(),
  };
  await writeReport(options.reportPath, report);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  main().catch((error) => {
    console.error(`NBA RAPM derivation failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
