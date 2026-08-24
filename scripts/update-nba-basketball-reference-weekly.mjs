#!/usr/bin/env node

/**
 * Refresh the active NBA season from Basketball Reference.
 *
 * This is intentionally a guarded wrapper around the historical importer:
 * - it refreshes exactly one season;
 * - it is a dry-run unless --apply is supplied;
 * - every run re-checks Basketball Reference robots.txt;
 * - it requires an explicit source-permission acknowledgement even in dry-run;
 * - writes require a second, independent environment gate.
 *
 * The checked-in GitHub workflow contains a weekly schedule, but it cannot
 * access the source or write Supabase unless both confirmation gates and the
 * linked-project credentials are configured.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BASKETBALL_REFERENCE_ROBOTS_URL = 'https://www.basketball-reference.com/robots.txt';
export const SPORTS_REFERENCE_POLICY_URLS = Object.freeze([
  'https://www.sports-reference.com/data_use.html',
  'https://www.sports-reference.com/termsofuse.html',
  'https://www.sports-reference.com/bot-traffic.html'
]);
export const SOURCE_CONFIRMATION_ENV = 'BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED';
export const WRITE_CONFIRMATION_ENV = 'NBA_WEEKLY_UPDATE_ALLOW_WRITE';
export const DEFAULT_REQUEST_DELAY_MS = 4000;
export const MINIMUM_REQUEST_DELAY_MS = 3000;

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SCRIPT_PATH));
const IMPORTER_PATH = path.join(ROOT, 'scripts', 'import-nba-basketball-reference.mjs');
const DEFAULT_USER_AGENT = 'DJHC-Lineup-Lab-Updater/1.0 (+https://www.djshouseofcards-comics.com/contact.html)';
const VALID_PHASES = new Set(['regular', 'playoffs', 'both']);
const MAX_CAPTURE_CHARACTERS = 100000;

function printUsage() {
  console.log(`
Usage:
  node .\\scripts\\update-nba-basketball-reference-weekly.mjs [options]

Options:
  --apply                     Write the refreshed snapshot to linked Supabase
  --season-end-year <year>    Override the automatically selected NBA season
  --phase <regular|playoffs|both>
                              Refresh phase(s); default: both
  --request-delay-ms <ms>     Uncached request delay; default: 4000, minimum: 3000
  --report-file <path>        JSON report path under the repository
  --help                      Show this help without making a network request

Required environment acknowledgement:
  ${SOURCE_CONFIRMATION_ENV}=confirmed

Additional write gate for --apply:
  ${WRITE_CONFIRMATION_ENV}=confirmed

The default mode downloads and validates one current-season snapshot but does
not write Supabase. Playoffs are skipped cleanly until their current-season
tables exist. Media pages are never requested by this wrapper.
`);
}

function parseInteger(value, name, { min, max }) {
  if (!/^\d+$/.test(String(value ?? '').trim())) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function readOption(argv, index, name) {
  const token = argv[index];
  const inlinePrefix = `${name}=`;
  if (token.startsWith(inlinePrefix)) return { value: token.slice(inlinePrefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return { value, consumed: 1 };
}

export function seasonEndYearForDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid date is required to determine the NBA season.');
  const calendarYear = date.getUTCFullYear();
  return date.getUTCMonth() >= 9 ? calendarYear + 1 : calendarYear;
}

export function parseWeeklyUpdateOptions(argv, { now = new Date() } = {}) {
  const options = {
    apply: false,
    help: false,
    seasonEndYear: seasonEndYearForDate(now),
    phase: 'both',
    requestDelayMs: DEFAULT_REQUEST_DELAY_MS,
    reportFile: path.join(ROOT, 'outputs', 'nba-weekly-update', 'report.json')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--apply') {
      options.apply = true;
      continue;
    }
    if (token === '--help') {
      options.help = true;
      continue;
    }
    if (token === '--season-end-year' || token.startsWith('--season-end-year=')) {
      const result = readOption(argv, index, '--season-end-year');
      options.seasonEndYear = parseInteger(result.value, '--season-end-year', { min: 1947, max: 2200 });
      index += result.consumed;
      continue;
    }
    if (token === '--request-delay-ms' || token.startsWith('--request-delay-ms=')) {
      const result = readOption(argv, index, '--request-delay-ms');
      options.requestDelayMs = parseInteger(result.value, '--request-delay-ms', {
        min: MINIMUM_REQUEST_DELAY_MS,
        max: 120000
      });
      index += result.consumed;
      continue;
    }
    if (token === '--phase' || token.startsWith('--phase=')) {
      const result = readOption(argv, index, '--phase');
      options.phase = String(result.value).trim().toLowerCase();
      if (!VALID_PHASES.has(options.phase)) throw new Error('--phase must be regular, playoffs, or both.');
      index += result.consumed;
      continue;
    }
    if (token === '--report-file' || token.startsWith('--report-file=')) {
      const result = readOption(argv, index, '--report-file');
      const requestedPath = path.resolve(ROOT, result.value);
      const relative = path.relative(ROOT, requestedPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('--report-file must resolve to a file inside the repository.');
      }
      options.reportFile = requestedPath;
      index += result.consumed;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return options;
}

function robotsPatternExpression(pattern) {
  const anchoredAtEnd = pattern.endsWith('$');
  const body = anchoredAtEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
  return new RegExp(`^${escaped}${anchoredAtEnd ? '$' : ''}`);
}

export function parseRobotsTxt(text) {
  const groups = [];
  let agents = [];
  let rules = [];
  let crawlDelaySeconds = null;

  const finishGroup = () => {
    if (agents.length) groups.push({ agents, rules, crawlDelaySeconds });
    agents = [];
    rules = [];
    crawlDelaySeconds = null;
  };

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    // Sports Reference currently uses blank lines between directives inside
    // its wildcard group, so a new user-agent after rules—not whitespace—is
    // the reliable group boundary for this fail-closed check.
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === 'user-agent') {
      if (rules.length || crawlDelaySeconds !== null) finishGroup();
      agents.push(value.toLowerCase());
      continue;
    }
    if (!agents.length) continue;
    if ((directive === 'allow' || directive === 'disallow') && value) {
      rules.push({ directive, pattern: value });
    } else if (directive === 'crawl-delay' && Number.isFinite(Number(value))) {
      crawlDelaySeconds = Math.max(0, Number(value));
    }
  }
  finishGroup();

  const wildcardGroups = groups.filter((group) => group.agents.includes('*'));
  return {
    groups,
    wildcardRules: wildcardGroups.flatMap((group) => group.rules),
    crawlDelaySeconds: wildcardGroups.reduce(
      (maximum, group) => Math.max(maximum, group.crawlDelaySeconds ?? 0),
      0
    )
  };
}

function robotsGroupsForUserAgent(robots, userAgent = '*') {
  const normalized = String(userAgent).trim().toLowerCase();
  const productToken = normalized === '*' ? '*' : normalized.split(/[\s/]/, 1)[0];
  const specificGroups = robots.groups.filter((group) => group.agents.some(
    (agent) => agent !== '*' && agent === productToken
  ));
  return specificGroups.length
    ? specificGroups
    : robots.groups.filter((group) => group.agents.includes('*'));
}

export function isPathAllowedByRobots(pathname, robots, userAgent = '*') {
  const rules = robotsGroupsForUserAgent(robots, userAgent).flatMap((group) => group.rules);
  const matches = rules
    .filter((rule) => robotsPatternExpression(rule.pattern).test(pathname))
    .map((rule) => ({
      ...rule,
      specificity: rule.pattern.replace(/[\*$]/g, '').length
    }))
    .sort((left, right) => right.specificity - left.specificity
      || (left.directive === 'allow' ? -1 : 1));
  return !matches.length || matches[0].directive === 'allow';
}

export function crawlDelayForUserAgent(robots, userAgent = '*') {
  const groups = robotsGroupsForUserAgent(robots, userAgent);
  if (!groups.length) return null;
  return groups.reduce((maximum, group) => Math.max(maximum, group.crawlDelaySeconds ?? 0), 0);
}

export function sourcePathsForSeason(seasonEndYear, phase = 'both') {
  const year = parseInteger(seasonEndYear, 'seasonEndYear', { min: 1947, max: 2200 });
  const paths = [`/leagues/NBA_${year}.html`];
  if (phase === 'regular' || phase === 'both') {
    paths.push(`/leagues/NBA_${year}_totals.html`, `/leagues/NBA_${year}_advanced.html`);
  }
  if (phase === 'playoffs' || phase === 'both') {
    paths.push(`/playoffs/NBA_${year}_totals.html`, `/playoffs/NBA_${year}_advanced.html`);
  }
  return paths;
}

export function shouldAllowMissingPlayoffs(options, { now = new Date() } = {}) {
  if (!['playoffs', 'both'].includes(options.phase)) return false;
  if (Number(options.seasonEndYear) !== seasonEndYearForDate(now)) return false;
  return now.getTime() < Date.UTC(Number(options.seasonEndYear), 3, 1);
}

export function buildImporterArgs(options, { now = new Date() } = {}) {
  const year = String(options.seasonEndYear);
  const args = [
    IMPORTER_PATH,
    '--season-start', year,
    '--season-end', year,
    '--phase', options.phase,
    '--request-delay-ms', String(options.requestDelayMs),
    '--refresh-cache',
    '--new-run'
  ];
  if (shouldAllowMissingPlayoffs(options, { now })) args.push('--allow-missing-playoffs');
  if (options.apply) args.push('--apply');
  return args;
}

export function isConfirmationPresent(value) {
  return String(value ?? '').trim().toLowerCase() === 'confirmed';
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function eventLog(event, details = {}) {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function appendTail(current, chunk) {
  const combined = `${current}${chunk}`;
  return combined.length <= MAX_CAPTURE_CHARACTERS
    ? combined
    : combined.slice(combined.length - MAX_CAPTURE_CHARACTERS);
}

function ensureReportPath(reportFile) {
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
}

function writeReport(reportFile, report) {
  ensureReportPath(reportFile);
  fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function retryAfterMilliseconds(value) {
  const normalized = String(value ?? '').trim();
  if (!normalized) return 0;
  if (/^\d+$/.test(normalized)) return Number(normalized) * 1000;
  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

async function fetchRobots({ userAgent, requestDelayMs }) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    eventLog('robots_request_started', { url: BASKETBALL_REFERENCE_ROBOTS_URL, attempt });
    let response;
    try {
      response = await fetch(BASKETBALL_REFERENCE_ROBOTS_URL, {
        headers: { 'User-Agent': userAgent, Accept: 'text/plain' },
        signal: AbortSignal.timeout(30000)
      });
    } catch (error) {
      if (attempt === 3) throw error;
      const retryDelayMs = Math.min(120000, requestDelayMs * (2 ** (attempt - 1)));
      eventLog('robots_request_retry', { attempt, retryDelayMs, reason: String(error?.message ?? error).slice(0, 240) });
      await sleep(retryDelayMs);
      continue;
    }
    if (response.ok) return response.text();
    if (attempt === 3 || (response.status >= 400 && response.status < 500 && response.status !== 429)) {
      throw new Error(`Basketball Reference robots.txt request failed with HTTP ${response.status}.`);
    }
    const retryDelayMs = Math.min(120000, Math.max(
      requestDelayMs * (2 ** (attempt - 1)),
      retryAfterMilliseconds(response.headers.get('retry-after'))
    ));
    eventLog('robots_request_retry', { attempt, status: response.status, retryDelayMs });
    await sleep(retryDelayMs);
  }
  throw new Error('Basketball Reference robots.txt could not be retrieved.');
}

async function verifyRobots(options, userAgent) {
  const text = await fetchRobots({ userAgent, requestDelayMs: options.requestDelayMs });
  const robots = parseRobotsTxt(text);
  const crawlDelaySeconds = crawlDelayForUserAgent(robots, userAgent);
  if (crawlDelaySeconds === null) {
    throw new Error('Basketball Reference robots.txt did not contain an applicable user-agent group.');
  }
  const paths = sourcePathsForSeason(options.seasonEndYear, options.phase);
  const blocked = paths.filter((pathname) => !isPathAllowedByRobots(pathname, robots, userAgent));
  if (blocked.length) {
    throw new Error(`Basketball Reference robots.txt currently disallows required path(s): ${blocked.join(', ')}`);
  }
  const effectiveDelayMs = Math.max(options.requestDelayMs, Math.ceil(crawlDelaySeconds * 1000));
  eventLog('robots_policy_verified', {
    url: BASKETBALL_REFERENCE_ROBOTS_URL,
    crawlDelaySeconds,
    effectiveDelayMs,
    checkedPaths: paths.length
  });
  // The importer is a separate process with its own request clock, so preserve
  // the robots delay after this preflight request before launching it.
  await sleep(effectiveDelayMs);
  return effectiveDelayMs;
}

function runImporter(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdoutTail = '';
    let stderrTail = '';
    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      process.stdout.write(text);
      stdoutTail = appendTail(stdoutTail, text);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      process.stderr.write(text);
      stderrTail = appendTail(stderrTail, text);
    });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode: exitCode ?? 1, signal, stdoutTail, stderrTail }));
  });
}

export async function runWeeklyUpdate(argv = process.argv.slice(2), env = process.env) {
  const now = new Date();
  const options = parseWeeklyUpdateOptions(argv, { now });
  if (options.help) {
    printUsage();
    return 0;
  }
  if (!isConfirmationPresent(env[SOURCE_CONFIRMATION_ENV])) {
    throw new Error(`Set ${SOURCE_CONFIRMATION_ENV}=confirmed only after confirming the source automation permission remains valid.`);
  }
  if (options.apply && !isConfirmationPresent(env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply also requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }

  const userAgent = String(env.NBA_BREF_USER_AGENT || DEFAULT_USER_AGENT).trim();
  if (userAgent.length < 20 || userAgent.length > 240) throw new Error('NBA_BREF_USER_AGENT must be 20-240 characters.');
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    status: 'running',
    mode: options.apply ? 'apply' : 'dry-run',
    seasonEndYear: options.seasonEndYear,
    phase: options.phase,
    startedAt,
    finishedAt: null,
    requestDelayMs: options.requestDelayMs,
    source: {
      robotsUrl: BASKETBALL_REFERENCE_ROBOTS_URL,
      policyUrls: SPORTS_REFERENCE_POLICY_URLS
    },
    importerExitCode: null,
    importerSignal: null,
    error: null
  };
  writeReport(options.reportFile, report);
  eventLog('weekly_update_started', {
    mode: report.mode,
    seasonEndYear: options.seasonEndYear,
    phase: options.phase,
    reportFile: path.relative(ROOT, options.reportFile)
  });

  try {
    const effectiveDelayMs = await verifyRobots(options, userAgent);
    options.requestDelayMs = effectiveDelayMs;
    report.requestDelayMs = effectiveDelayMs;
    const args = buildImporterArgs(options, { now });
    const result = await runImporter(args, { ...env, NBA_BREF_USER_AGENT: userAgent });
    report.importerExitCode = result.exitCode;
    report.importerSignal = result.signal;
    report.stdoutTail = result.stdoutTail;
    report.stderrTail = result.stderrTail;
    if (result.exitCode !== 0) throw new Error(`NBA importer exited with code ${result.exitCode}.`);
    report.status = 'completed';
    report.finishedAt = new Date().toISOString();
    writeReport(options.reportFile, report);
    eventLog('weekly_update_completed', {
      mode: report.mode,
      seasonEndYear: options.seasonEndYear,
      reportFile: path.relative(ROOT, options.reportFile)
    });
    return 0;
  } catch (error) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    report.error = String(error?.message ?? error).slice(0, 1200);
    writeReport(options.reportFile, report);
    eventLog('weekly_update_failed', { error: report.error, reportFile: path.relative(ROOT, options.reportFile) });
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  runWeeklyUpdate().catch((error) => {
    console.error(`Weekly NBA update failed: ${String(error?.stack ?? error)}`);
    process.exitCode = 1;
  });
}
