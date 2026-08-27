#!/usr/bin/env node

/**
 * Backfill source-backed multi-position eligibility for imported NBA players.
 *
 * Basketball Reference season totals provide one historical `Pos` value. Its
 * player profiles can list several real career positions, which lets Lineup
 * Lab honor a forward-center or guard-forward constraint without pretending
 * to know the exact role on every historical possession. The database status
 * row is intentionally the checkpoint, so a stopped run resumes from the
 * first missing or retry profile on its next invocation.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  BASKETBALL_REFERENCE_BASE_URL,
  basketballReferencePlayerPageUrl,
  parseBasketballReferencePlayerProfilePositions,
} from './lib/nba-basketball-reference.mjs';
import {
  buildPositionProfileCandidateQuery,
  buildPositionProfileUpsertSql,
  normalizePositionProfileCandidateRows,
  positionProfileCacheFile,
  positionProfileFailureRecord,
  positionProfileRecordFromParsed,
} from './lib/nba-position-profile-backfill.mjs';
import {
  analyticsDatabaseTarget,
  createPageFetcher,
  executeLinkedSql,
} from './import-nba-basketball-reference.mjs';
import {
  BASKETBALL_REFERENCE_ROBOTS_URL,
  SOURCE_CONFIRMATION_ENV,
  WRITE_CONFIRMATION_ENV,
  crawlDelayForUserAgent,
  isConfirmationPresent,
  isPathAllowedByRobots,
  parseRobotsTxt,
} from './update-nba-basketball-reference-weekly.mjs';

const ROOT = process.cwd();
const SCRIPT_PATH = path.resolve(process.argv[1] || '');
const DEFAULT_LIMIT = 100;
const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_DELAY_MS = 4000;
const MINIMUM_DELAY_MS = 3000;
const USER_AGENT = process.env.NBA_BREF_USER_AGENT?.trim()
  || 'DJHC-Lineup-Lab-Updater/1.0 (+https://www.djshouseofcards-comics.com/contact.html)';

function printUsage() {
  console.log(`
Usage:
  node .\\scripts\\import-nba-basketball-reference-positions.mjs [options]

Options:
  --apply                     Write profile results to the dedicated NBA analytics project
  --limit <count>             Profiles to inspect this run (default: ${DEFAULT_LIMIT}; max: 500)
  --batch-size <count>        Idempotent write batch size (default: ${DEFAULT_BATCH_SIZE}; max: 100)
  --request-delay-ms <ms>     Delay between uncached profile requests (default: ${DEFAULT_DELAY_MS}; minimum: ${MINIMUM_DELAY_MS})
  --refresh-cache             Re-fetch cached profile pages
  --recheck-terminal          Include found/no-position/not-found rows (manual audit only)
  --help                      Show this help

Required environment acknowledgement before source requests:
  ${SOURCE_CONFIRMATION_ENV}=confirmed

Additional write gate for --apply:
  ${WRITE_CONFIRMATION_ENV}=confirmed

Notes:
  * The normal candidate query processes only missing and retry records.
  * A successful, no-position, or confirmed 404/410 result is terminal.
  * Temporary failures remain retryable, so another invocation continues safely.
  * Position labels come from Basketball Reference player profiles only; this
    tool never guesses a role from height, box-score statistics, or name.
`);
}

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] ?? '');
    if (!token.startsWith('--')) continue;
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { values, flags };
}

function readInteger(value, label, { min, max }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function optionsFromArgs(argv) {
  const { values, flags } = parseArgs(argv);
  if (flags.has('help')) return { help: true };
  return {
    help: false,
    apply: flags.has('apply'),
    limit: readInteger(values.get('limit') ?? DEFAULT_LIMIT, '--limit', { min: 1, max: 500 }),
    batchSize: readInteger(values.get('batch-size') ?? DEFAULT_BATCH_SIZE, '--batch-size', { min: 1, max: 100 }),
    requestDelayMs: readInteger(values.get('request-delay-ms') ?? DEFAULT_DELAY_MS, '--request-delay-ms', {
      min: MINIMUM_DELAY_MS,
      max: 120000,
    }),
    refreshCache: flags.has('refresh-cache'),
    recheckTerminal: flags.has('recheck-terminal'),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function event(name, details = {}) {
  // Keep automation logs useful without emitting player names, raw HTML, or
  // linked-database results. The database is the durable audit record.
  console.log(JSON.stringify({ event: name, at: new Date().toISOString(), ...details }));
}

async function fetchRobotsText(requestDelayMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(BASKETBALL_REFERENCE_ROBOTS_URL, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
        signal: AbortSignal.timeout(30000),
      });
      if (response.ok) return response.text();
      const error = new Error(`Basketball Reference robots.txt returned HTTP ${response.status}.`);
      error.status = response.status;
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (Number(error?.status) >= 400 && Number(error?.status) < 500 && Number(error?.status) !== 429) break;
    }
    if (attempt < 3) await sleep(Math.min(120000, requestDelayMs * (2 ** (attempt - 1))));
  }
  throw lastError || new Error('Basketball Reference robots.txt could not be retrieved.');
}

async function verifySourcePolicy(options, candidates) {
  if (!isConfirmationPresent(process.env[SOURCE_CONFIRMATION_ENV])) {
    throw new Error(`Set ${SOURCE_CONFIRMATION_ENV}=confirmed only after confirming source automation permission remains valid.`);
  }
  if (options.apply && !isConfirmationPresent(process.env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply also requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }
  if (USER_AGENT.length < 20 || USER_AGENT.length > 240) {
    throw new Error('NBA_BREF_USER_AGENT must be 20-240 characters.');
  }

  const robots = parseRobotsTxt(await fetchRobotsText(options.requestDelayMs));
  const crawlDelaySeconds = crawlDelayForUserAgent(robots, USER_AGENT);
  if (crawlDelaySeconds === null) {
    throw new Error('Basketball Reference robots.txt did not contain an applicable user-agent group.');
  }
  const disallowed = candidates.find((candidate) => {
    const url = basketballReferencePlayerPageUrl(candidate.externalId);
    return !url || !isPathAllowedByRobots(new URL(url).pathname, robots, USER_AGENT);
  });
  if (disallowed) throw new Error('Basketball Reference robots.txt currently disallows a requested player-profile path.');
  const effectiveDelayMs = Math.max(options.requestDelayMs, Math.ceil(crawlDelaySeconds * 1000));
  event('robots_policy_verified', {
    url: BASKETBALL_REFERENCE_ROBOTS_URL,
    profileHost: BASKETBALL_REFERENCE_BASE_URL,
    crawlDelaySeconds,
    effectiveDelayMs,
    candidates: candidates.length,
  });
  // The robots request itself is a source request, so pause before the first
  // player profile request rather than treating it as free traffic.
  await sleep(effectiveDelayMs);
  return { robots, effectiveDelayMs };
}

async function flushWriteBatch(records, options, summary, databaseTarget) {
  if (!records.length || !options.apply) return;
  await executeLinkedSql(
    buildPositionProfileUpsertSql(records),
    `position-profile-batch-${Date.now()}`,
    databaseTarget,
  );
  summary.written += records.length;
  records.length = 0;
}

export async function runPositionProfileBackfill(argv = process.argv.slice(2)) {
  const options = optionsFromArgs(argv);
  if (options.help) {
    printUsage();
    return { status: 'help' };
  }

  // This backfill never reads or writes the commerce project. Resolve the
  // dedicated link before its first candidate query so a stale CLI link fails
  // closed instead of yielding an empty, misleading queue.
  const databaseTarget = analyticsDatabaseTarget();

  // Do the read-only linked query first. It avoids a needless robots request
  // after the backfill has caught up, and it cannot modify profile data.
  const candidateRows = await executeLinkedSql(buildPositionProfileCandidateQuery({
    limit: options.limit,
    includeTerminal: options.recheckTerminal,
  }), `position-profile-candidates-${Date.now()}`, databaseTarget);
  const candidates = normalizePositionProfileCandidateRows(candidateRows);
  const summary = {
    status: 'running',
    mode: options.apply ? 'apply' : 'dry-run',
    candidates: candidates.length,
    found: 0,
    noPositions: 0,
    notFound: 0,
    retry: 0,
    written: 0,
  };
  if (!candidates.length) {
    summary.status = 'completed';
    event('position_profile_backfill_completed', summary);
    return summary;
  }

  const { robots, effectiveDelayMs } = await verifySourcePolicy(options, candidates);
  const cacheDirectory = path.join(ROOT, 'outputs', 'nba-basketball-reference-cache', 'position-profiles');
  fs.mkdirSync(cacheDirectory, { recursive: true });
  const fetchPage = createPageFetcher({
    cacheDirectory,
    requestDelayMs: effectiveDelayMs,
    refreshCache: options.refreshCache,
    robots,
  });
  const pendingWrite = [];
  for (const [index, candidate] of candidates.entries()) {
    let record;
    const sourceUrl = basketballReferencePlayerPageUrl(candidate.externalId);
    try {
      event('position_profile_fetch_started', { number: index + 1, candidates: candidates.length });
      const html = await fetchPage({
        url: sourceUrl,
        cacheFile: positionProfileCacheFile(ROOT, candidate.externalId),
        requestKind: 'stats',
      });
      record = positionProfileRecordFromParsed({
        candidate,
        profile: parseBasketballReferencePlayerProfilePositions(html),
      });
    } catch (error) {
      record = positionProfileFailureRecord({ candidate, error });
    }
    if (record.fetchStatus === 'found') summary.found += 1;
    if (record.fetchStatus === 'no_positions') summary.noPositions += 1;
    if (record.fetchStatus === 'not_found') summary.notFound += 1;
    if (record.fetchStatus === 'retry') summary.retry += 1;
    pendingWrite.push(record);
    if (pendingWrite.length >= options.batchSize) {
      await flushWriteBatch(pendingWrite, options, summary, databaseTarget);
    }
  }
  await flushWriteBatch(pendingWrite, options, summary, databaseTarget);
  summary.status = 'completed';
  event('position_profile_backfill_completed', summary);
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (isMain) {
  runPositionProfileBackfill().catch((error) => {
    event('position_profile_backfill_failed', { error: String(error?.message ?? error).slice(0, 1200) });
    process.exitCode = 1;
  });
}
