#!/usr/bin/env node

/**
 * Download licensed Sportradar NBA v8 PBP, reconstruct verified five-player
 * lineup facts locally, and optionally persist them through the private
 * Supabase ingest RPC. The default is a read-only provider dry run.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  SPORTRADAR_NBA_API_VERSION,
  SPORTRADAR_NBA_PHASE_CODES,
  buildSportradarNbaScheduleUrl,
  buildSportradarNbaSummaryUrl,
  buildSportradarNbaPlayByPlayUrl,
  fetchSportradarNbaJson,
  normalizeSportradarPlayByPlay,
  normalizeSportradarSchedule,
  normalizeSportradarSummary,
} from './lib/nba-sportradar-pbp.mjs';
import { reconstructNbaGameLineups } from './lib/nba-lineup-reconstruction.mjs';
import {
  buildSportradarIngestPayload,
  SPORTRADAR_INGEST_METHOD_VERSION,
} from './lib/nba-sportradar-import-payload.mjs';
import { assertAnalyticsProjectTarget } from './lib/nba-analytics-project-target.mjs';

const ROOT = process.cwd();
const SOURCE_CONFIRMATION_ENV = 'SPORTRADAR_NBA_LICENSE_CONFIRMED';
const SOURCE_LICENSE_REFERENCE_ENV = 'SPORTRADAR_NBA_LICENSE_REFERENCE';
const SOURCE_API_KEY_ENV = 'SPORTRADAR_NBA_API_KEY';
const SOURCE_ACCESS_LEVEL_ENV = 'SPORTRADAR_NBA_ACCESS_LEVEL';
const WRITE_CONFIRMATION_ENV = 'NBA_SPORTRADAR_IMPORT_ALLOW_WRITE';
const VALID_PHASES = new Set(Object.keys(SPORTRADAR_NBA_PHASE_CODES));

function usage() {
  return `
Usage:
  node .\\scripts\\import-nba-sportradar-pbp.mjs --season-start <year> [options]

Options:
  --season-start <year>       NBA season start year; 2024 means 2024-25 (required)
  --season-end <year>         Last NBA season start year (default: --season-start)
  --phase <phase|all>         preseason, regular, in_season_tournament, play_in, playoffs, or all (default: regular)
  --game-id <uuid>            Limit to one game from the selected schedule
  --max-games <count>         Maximum closed/full/on-court games per phase (default: 1)
  --request-delay-ms <ms>     Minimum delay between provider requests (default: 1000)
  --report <workspace path>   Write a non-secret JSON import report
  --apply                     Upload private raw responses and call the private Supabase ingest RPC
  --help                      Show this help

Required for every provider request:
  ${SOURCE_CONFIRMATION_ENV}=confirmed
  ${SOURCE_LICENSE_REFERENCE_ENV}=your-internal-license-reference
  ${SOURCE_API_KEY_ENV}=your-api-key
  ${SOURCE_ACCESS_LEVEL_ENV}=production (or trial if entitled)

Additional requirements for --apply:
  ${WRITE_CONFIRMATION_ENV}=confirmed
  SUPABASE_URL=https://your-project.supabase.co
  NBA_ANALYTICS_SUPABASE_URL=https://your-analytics-project.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

The default is a provider read-only dry run. --apply is idempotent by provider
event IDs and source/build hashes, but always begin with --max-games 1.
`;
}

function parseTokens(argv) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inlineValue] = token.slice(2).split(/=(.*)/s, 2);
    if (!name) throw new Error('An option name is required.');
    if (inlineValue !== undefined) {
      values.set(name, inlineValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { values, flags };
}

function integer(value, name, { min, max }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

function parsePhases(value) {
  const raw = String(value ?? 'regular').trim().toLowerCase();
  if (raw === 'all') return [...VALID_PHASES];
  const phases = [...new Set(raw.split(',').map((phase) => phase.trim()).filter(Boolean))];
  if (!phases.length || phases.some((phase) => !VALID_PHASES.has(phase))) {
    throw new Error(`--phase must be one of ${[...VALID_PHASES].join(', ')}, a comma-separated subset, or all.`);
  }
  return phases;
}

function optionalUuid(value, name) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  const id = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`${name} must be a UUID.`);
  }
  return id;
}

export function optionsFromArgs(argv = []) {
  const { values, flags } = parseTokens(argv);
  const known = new Set([
    'help', 'season-start', 'season-end', 'phase', 'game-id', 'max-games',
    'request-delay-ms', 'report', 'apply'
  ]);
  for (const name of [...values.keys(), ...flags]) {
    if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  }
  if (flags.has('help')) return { help: true };
  if (!values.has('season-start')) throw new Error('--season-start is required.');
  const seasonStart = integer(values.get('season-start'), '--season-start', { min: 1947, max: 2199 });
  const seasonEnd = integer(values.get('season-end') ?? seasonStart, '--season-end', { min: seasonStart, max: 2199 });
  const maxGames = integer(values.get('max-games') ?? 1, '--max-games', { min: 1, max: 5000 });
  const requestDelayMs = integer(values.get('request-delay-ms') ?? 1000, '--request-delay-ms', { min: 0, max: 120000 });
  const reportPath = String(values.get('report') ?? '').trim();
  if (reportPath && path.isAbsolute(reportPath)) {
    const root = path.resolve(ROOT).toLowerCase();
    const resolved = path.resolve(reportPath).toLowerCase();
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
      throw new Error('--report must stay inside this workspace.');
    }
  }
  return {
    help: false,
    apply: flags.has('apply'),
    seasonStart,
    seasonEnd,
    phases: parsePhases(values.get('phase')),
    gameId: optionalUuid(values.get('game-id'), '--game-id'),
    maxGames,
    requestDelayMs,
    reportPath,
  };
}

function confirmed(value) {
  return String(value ?? '').trim().toLowerCase() === 'confirmed';
}

function sourceConfiguration({ requireWrite }) {
  if (!confirmed(process.env[SOURCE_CONFIRMATION_ENV])) {
    throw new Error(`Set ${SOURCE_CONFIRMATION_ENV}=confirmed after confirming the provider license applies to this import.`);
  }
  const licenseReference = String(process.env[SOURCE_LICENSE_REFERENCE_ENV] ?? '').trim();
  if (!licenseReference) throw new Error(`Set ${SOURCE_LICENSE_REFERENCE_ENV} to a non-secret internal license or approval reference.`);
  const apiKey = String(process.env[SOURCE_API_KEY_ENV] ?? '').trim();
  if (!apiKey) throw new Error(`Set ${SOURCE_API_KEY_ENV} in this process before requesting Sportradar.`);
  const accessLevel = String(process.env[SOURCE_ACCESS_LEVEL_ENV] ?? '').trim().toLowerCase();
  if (!['trial', 'production'].includes(accessLevel)) {
    throw new Error(`Set ${SOURCE_ACCESS_LEVEL_ENV} to trial or production.`);
  }
  const source = { apiKey, accessLevel, licenseReference };
  if (!requireWrite) return source;
  if (!confirmed(process.env[WRITE_CONFIRMATION_ENV])) {
    throw new Error(`--apply requires ${WRITE_CONFIRMATION_ENV}=confirmed.`);
  }
  const projectUrl = assertAnalyticsProjectTarget({
    projectUrl: process.env.SUPABASE_URL,
    expectedProjectUrl: process.env.NBA_ANALYTICS_SUPABASE_URL,
  });
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!serviceRoleKey) {
    throw new Error('--apply requires SUPABASE_SERVICE_ROLE_KEY in this process.');
  }
  return { ...source, projectUrl, serviceRoleKey };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createRateLimitedProviderFetcher(fetchJson, minimumDelayMs) {
  let nextRequestAt = 0;
  return async (url, options) => {
    const waitMilliseconds = Math.max(0, nextRequestAt - Date.now());
    if (waitMilliseconds) await sleep(waitMilliseconds);
    // Reserve the next request slot before dispatching. This makes accidental
    // future parallel call sites obey the same account-wide cadence.
    nextRequestAt = Date.now() + minimumDelayMs;
    return fetchJson(url, options);
  };
}

function sourceObjectPath({ gameId, resource, contentSha256, seasonStart, phase }) {
  const safeResource = String(resource).replace(/[^a-z_]+/gi, '-').toLowerCase();
  const partition = gameId || `schedule-${seasonStart}-${phase}`;
  return `v8/${seasonStart}/${phase}/${partition}/${safeResource}-${contentSha256}.json.gz`;
}

export function rawSourceDocument({ id = crypto.randomUUID(), resource, resourceKey, response, payload, gameId = '', seasonStart, phase, sourceGeneratedAt = null }) {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
  const contentSha256 = sha256(compressed);
  return {
    bytes: compressed,
    document: {
      id,
      resource,
      resourceKey,
      sourceUrl: response.sourceUrl,
      storageBucket: 'nba-sportradar-raw',
      storageObjectPath: sourceObjectPath({ gameId, resource, contentSha256, seasonStart, phase }),
      contentSha256,
      contentBytes: compressed.length,
      contentEncoding: 'gzip',
      sourceEtag: response.etag,
      sourceLastModified: response.lastModified,
      sourceGeneratedAt,
      receivedAt: response.receivedAt,
    },
  };
}

function safeStoragePath(pathname) {
  const segments = String(pathname).split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '.' || segment === '..')) {
    throw new Error('Refusing to write an unsafe Supabase Storage object path.');
  }
  return segments.map(encodeURIComponent).join('/');
}

async function remoteRequest(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      ...(options.headers ?? {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${new URL(url).pathname} failed with HTTP ${response.status}: ${body.slice(0, 800)}`);
  }
  return body ? JSON.parse(body) : null;
}

export async function uploadPrivateSourceDocument({ projectUrl, serviceRoleKey, raw }) {
  const objectPath = safeStoragePath(raw.document.storageObjectPath);
  await remoteRequest(`${projectUrl}/storage/v1/object/nba-sportradar-raw/${objectPath}`, serviceRoleKey, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/gzip',
      'x-upsert': 'true',
    },
    body: raw.bytes,
  });
}

export async function invokeIngest({ projectUrl, serviceRoleKey, payload }) {
  return remoteRequest(`${projectUrl}/rest/v1/rpc/ingest_nba_sportradar_game`, serviceRoleKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // PostgREST maps JSON object keys to SQL parameter names.  The ingest
    // function accepts one jsonb parameter named p_payload, so keep the full
    // provider-derived payload nested under that explicit boundary.
    body: JSON.stringify({ p_payload: payload }),
  });
}

async function createRemoteRun({ projectUrl, serviceRoleKey, run }) {
  await remoteRequest(`${projectUrl}/rest/v1/nba_pbp_import_runs`, serviceRoleKey, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: run.id,
      source_name: 'sportradar_nba',
      source_access_level: run.accessLevel,
      source_api_version: run.apiVersion,
      source_license_reference: run.licenseReference,
      rights_confirmed: true,
      requested_season_start: run.requestedSeasonStart,
      requested_season_end: run.requestedSeasonEnd,
      requested_phase: run.requestedPhase,
      status: 'running',
      started_at: run.startedAt,
    }),
  });
}

async function finishRemoteRun({ projectUrl, serviceRoleKey, runId, status, errorSummary = '' }) {
  const query = new URLSearchParams({ id: `eq.${runId}` });
  await remoteRequest(`${projectUrl}/rest/v1/nba_pbp_import_runs?${query}`, serviceRoleKey, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ status, error_summary: errorSummary.slice(0, 1200), finished_at: new Date().toISOString() }),
  });
}

export function analyticsForReconstruction(reconstruction, { sourcePayload, summary }) {
  const errors = reconstruction.validation?.errors ?? [];
  const warnings = reconstruction.validation?.warnings ?? [];
  const errorSummary = [...errors, ...warnings].join('; ').slice(0, 4000);
  return {
    build: {
      methodVersion: reconstruction.methodVersion || SPORTRADAR_INGEST_METHOD_VERSION,
      inputSha256: sha256(JSON.stringify({
        methodVersion: reconstruction.methodVersion,
        sourcePayload,
        summary: {
          homePoints: summary.home.points,
          awayPoints: summary.away.points,
          homePossessions: summary.home.possessions,
          awayPossessions: summary.away.possessions,
        },
      })),
      // An ineligible source result is a completed validation result, rather
      // than an importer error. It remains private and is never published.
      status: reconstruction.coverageStatus === 'partial' ? 'partial' : 'completed',
      coverageStatus: reconstruction.coverageStatus,
      eventCount: reconstruction.counts?.eventCount ?? 0,
      validSnapshotCount: reconstruction.counts?.validSnapshotCount ?? 0,
      invalidSnapshotCount: reconstruction.counts?.invalidSnapshotCount ?? 0,
      errorSummary,
      finalScoreVerified: reconstruction.validation?.finalScore?.verified === true,
      possessionTotalsVerified: reconstruction.validation?.possessionTotals?.verified === true,
      playerMinutesVerified: reconstruction.validation?.playerMinutes?.verified === true,
    },
    lineups: reconstruction.lineupDefinitions ?? [],
    stints: reconstruction.stints ?? [],
    possessions: reconstruction.possessions ?? [],
  };
}

function providerEligible(game) {
  return game.status === 'closed' && game.coverage.toLowerCase() === 'full' && game.trackOnCourt === true;
}

export function runMetadata(options, config) {
  return {
    id: crypto.randomUUID(),
    accessLevel: config.accessLevel,
    apiVersion: SPORTRADAR_NBA_API_VERSION,
    licenseReference: config.licenseReference,
    rightsConfirmed: true,
    // The provider accepts NBA season *start* years, while these foreign keys
    // intentionally reference the analytics domain's canonical end-year key.
    requestedSeasonStart: options.seasonStart + 1,
    requestedSeasonEnd: options.seasonEnd + 1,
    requestedPhase: options.phases.length === 1 ? options.phases[0] : 'mixed',
    startedAt: new Date().toISOString(),
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
  const config = sourceConfiguration({ requireWrite: options.apply });
  const fetchJson = createRateLimitedProviderFetcher(
    dependencies.fetchJson ?? fetchSportradarNbaJson,
    options.requestDelayMs,
  );
  const reconstruct = dependencies.reconstruct ?? reconstructNbaGameLineups;
  const buildPayload = dependencies.buildPayload ?? buildSportradarIngestPayload;
  const run = runMetadata(options, config);
  const report = {
    source: 'sportradar_nba',
    apiVersion: SPORTRADAR_NBA_API_VERSION,
    mode: options.apply ? 'apply' : 'dry-run',
    importRunId: options.apply ? run.id : null,
    seasonStart: options.seasonStart,
    seasonEnd: options.seasonEnd,
    phases: options.phases,
    maxGamesPerPhase: options.maxGames,
    startedAt: run.startedAt,
    schedules: [],
    games: [],
    failures: [],
  };

  if (options.apply) await createRemoteRun({ ...config, run });
  try {
    for (let seasonStart = options.seasonStart; seasonStart <= options.seasonEnd; seasonStart += 1) {
      for (const phase of options.phases) {
        const scheduleResponse = await fetchJson(buildSportradarNbaScheduleUrl({
          seasonStartYear: seasonStart,
          seasonPhase: phase,
          accessLevel: config.accessLevel,
        }), {
          apiKey: config.apiKey,
          requestDelayMs: options.requestDelayMs,
        });
        const schedule = normalizeSportradarSchedule(scheduleResponse.payload, {
          seasonStartYear: seasonStart,
          seasonPhase: phase,
        });
        let selectedGames = schedule.games.filter(providerEligible);
        if (options.gameId) selectedGames = selectedGames.filter((game) => game.id === options.gameId);
        selectedGames = selectedGames.slice(0, options.maxGames);
        const scheduleRaw = rawSourceDocument({
          resource: 'schedule',
          resourceKey: `${seasonStart}:${phase}`,
          response: scheduleResponse,
          payload: scheduleResponse.payload,
          seasonStart,
          phase,
          sourceGeneratedAt: schedule.sourceGeneratedAt,
        });
        report.schedules.push({
          seasonStart,
          phase,
          gamesDiscovered: schedule.games.length,
          eligibleGames: schedule.games.filter(providerEligible).length,
          selectedGames: selectedGames.length,
        });
        if (options.apply) {
          await uploadPrivateSourceDocument({ ...config, raw: scheduleRaw });
        }

        for (const scheduleGame of selectedGames) {
          try {
            const summaryResponse = await fetchJson(
              buildSportradarNbaSummaryUrl({ gameId: scheduleGame.id, accessLevel: config.accessLevel }),
              { apiKey: config.apiKey, requestDelayMs: options.requestDelayMs },
            );
            const pbpResponse = await fetchJson(
              buildSportradarNbaPlayByPlayUrl({ gameId: scheduleGame.id, accessLevel: config.accessLevel }),
              { apiKey: config.apiKey, requestDelayMs: options.requestDelayMs },
            );
            const summary = normalizeSportradarSummary(summaryResponse.payload, { expectedGameId: scheduleGame.id });
            const playByPlay = normalizeSportradarPlayByPlay(pbpResponse.payload, { expectedGameId: scheduleGame.id });
            const reconstruction = reconstruct({
              gameId: scheduleGame.id,
              homeTeamId: summary.home.id,
              awayTeamId: summary.away.id,
              status: summary.status,
              coverage: summary.coverage,
              trackOnCourt: summary.trackOnCourt,
              expectedFinalScore: { homePoints: summary.home.points, awayPoints: summary.away.points },
              providerTeamPossessions: { home: summary.home.possessions, away: summary.away.possessions },
              providerPlayerMinutes: summary.players,
              events: playByPlay.events,
            });
            const analytics = analyticsForReconstruction(reconstruction, { sourcePayload: pbpResponse.payload, summary });
            const summaryRaw = rawSourceDocument({
              resource: 'summary', resourceKey: scheduleGame.id, response: summaryResponse,
              payload: summaryResponse.payload, gameId: scheduleGame.id, seasonStart, phase,
              sourceGeneratedAt: summary.sourceGeneratedAt,
            });
            const pbpRaw = rawSourceDocument({
              resource: 'play_by_play', resourceKey: scheduleGame.id, response: pbpResponse,
              payload: pbpResponse.payload, gameId: scheduleGame.id, seasonStart, phase,
              sourceGeneratedAt: playByPlay.sourceGeneratedAt,
            });
            const documents = [
              { ...scheduleRaw.document, id: crypto.randomUUID(), resourceKey: `${seasonStart}:${phase}:${scheduleGame.id}` },
              summaryRaw.document,
              pbpRaw.document,
            ];
            const payload = buildPayload({
              run,
              scheduleGame,
              summary,
              playByPlay,
              documents,
              analytics,
            });
            let remote = null;
            if (options.apply) {
              await uploadPrivateSourceDocument({ ...config, raw: summaryRaw });
              await uploadPrivateSourceDocument({ ...config, raw: pbpRaw });
              remote = await invokeIngest({ ...config, payload });
            }
            report.games.push({
              gameId: scheduleGame.id,
              reconstructionCoverage: reconstruction.coverageStatus,
              eligibleForPublication: reconstruction.isEligible,
              events: reconstruction.counts?.eventCount ?? 0,
              stints: reconstruction.counts?.stintCount ?? 0,
              possessions: reconstruction.counts?.possessionCount ?? 0,
              possessionValidation: reconstruction.validation?.possessionTotals ?? null,
              validationErrors: reconstruction.validation?.errors ?? [],
              validationWarnings: reconstruction.validation?.warnings ?? [],
              remote,
            });
          } catch (error) {
            const failure = { gameId: scheduleGame.id, error: String(error?.message ?? error).slice(0, 1000) };
            report.failures.push(failure);
            report.games.push({ gameId: scheduleGame.id, failed: true, error: failure.error });
          }
        }
      }
    }
    report.finishedAt = new Date().toISOString();
    if (options.apply) {
      await finishRemoteRun({
        ...config,
        runId: run.id,
        status: report.failures.length ? 'failed' : 'completed',
        errorSummary: report.failures.map((failure) => `${failure.gameId}: ${failure.error}`).join('; '),
      });
    }
    await writeReport(options.reportPath, report);
    console.log(JSON.stringify(report, null, 2));
    if (report.failures.length) {
      const error = new Error(`${report.failures.length} scheduled game(s) failed; inspect the JSON report before retrying.`);
      error.report = report;
      throw error;
    }
    return report;
  } catch (error) {
    report.finishedAt = new Date().toISOString();
    report.fatalError = String(error?.message ?? error).slice(0, 1200);
    if (options.apply) {
      try {
        await finishRemoteRun({ ...config, runId: run.id, status: 'failed', errorSummary: report.fatalError });
      } catch (finishError) {
        report.finishRunError = String(finishError?.message ?? finishError).slice(0, 500);
      }
    }
    await writeReport(options.reportPath, report);
    throw error;
  }
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) {
  main().catch((error) => {
    console.error(`Sportradar NBA PBP import failed: ${String(error?.message ?? error)}`);
    process.exitCode = 1;
  });
}
