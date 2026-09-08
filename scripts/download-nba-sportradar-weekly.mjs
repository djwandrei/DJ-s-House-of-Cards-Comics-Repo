#!/usr/bin/env node

/**
 * Resumable local Sportradar NBA updater.
 *
 * This is the script counterpart to the Basketball Reference weekly updater:
 * it discovers newly closed games, downloads summary/PBP once per game, writes
 * normalized gzip records to an ignored checkpoint, and stops on quota or
 * throttling responses. It never writes Supabase.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  SPORTRADAR_NBA_API_VERSION,
  SPORTRADAR_NBA_PHASE_CODES,
  buildSportradarNbaPlayByPlayUrl,
  buildSportradarNbaScheduleUrl,
  buildSportradarNbaSeasonsUrl,
  buildSportradarNbaSummaryUrl,
  fetchSportradarNbaJson,
  normalizeSportradarPlayByPlay,
  normalizeSportradarSchedule,
  normalizeSportradarSummary,
} from './lib/nba-sportradar-pbp.mjs';
import { reconstructNbaGameLineups } from './lib/nba-lineup-reconstruction.mjs';
import { inspectSummaryCompleteness } from './lib/nba-summary-completeness.mjs';

// A checkpoint label or an existing file is not evidence of Summary coverage.
// Legacy archives without official fields must re-enter the download queue.
export function weeklyArchiveIsComplete(record, gameId, accessLevel) {
  return record?.game?.providerGameId === gameId && record?.source?.accessLevel === accessLevel
    && inspectSummaryCompleteness(record).complete;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_OUTPUT_DIR = path.join(ROOT, 'outputs', 'nba-sportradar-weekly');
const DEFAULT_DELAY_MS = 3500;
const SOURCE = 'sportradar_nba';
const EXPORT_VERSION = 'nba-sportradar-weekly-v1';
const NETWORK_GATE_ENV = 'SPORTRADAR_WEEKLY_ALLOW_NETWORK';
const API_KEY_ENV = 'SPORTRADAR_NBA_API_KEY';
const LICENSE_ENV = 'SPORTRADAR_NBA_LICENSE_CONFIRMED';
const LICENSE_REFERENCE_ENV = 'SPORTRADAR_NBA_LICENSE_REFERENCE';
const ACCESS_LEVEL_ENV = 'SPORTRADAR_NBA_ACCESS_LEVEL';
const PHASES = new Set(Object.keys(SPORTRADAR_NBA_PHASE_CODES));
const PHASE_PRIORITY = Object.freeze({ regular: 0, in_season_tournament: 1, play_in: 2, playoffs: 3, preseason: 4 });
const PHASE_BY_CODE = Object.freeze(Object.fromEntries(Object.entries(SPORTRADAR_NBA_PHASE_CODES).map(([phase, code]) => [code, phase])));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function seasonStartYearForDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('A valid date is required to determine the NBA season.');
  const year = date.getUTCFullYear();
  return date.getUTCMonth() >= 9 ? year : year - 1;
}

function integer(value, name, { min, max }) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  return parsed;
}

function readOption(argv, index, name) {
  const token = argv[index];
  const prefix = `${name}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 0 };
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return { value, consumed: 1 };
}

function parsePhases(value) {
  const raw = String(value ?? 'regular,in_season_tournament,play_in,playoffs').trim().toLowerCase();
  if (raw === 'all') return [...PHASES];
  const phases = [...new Set(raw.split(',').map((phase) => phase.trim()).filter(Boolean))];
  if (!phases.length || phases.some((phase) => !PHASES.has(phase))) throw new Error(`--phase must be a comma-separated subset of ${[...PHASES].join(', ')} or all.`);
  return phases;
}

export function parseWeeklySportradarOptions(argv = [], { now = new Date() } = {}) {
  const options = {
    help: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    seasonStartYear: seasonStartYearForDate(now),
    phases: parsePhases(),
    accessLevel: String(process.env[ACCESS_LEVEL_ENV] ?? 'production').trim().toLowerCase() || 'production',
    requestDelayMs: DEFAULT_DELAY_MS,
    maxGames: 200,
    resume: true,
    reportFile: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help') { options.help = true; continue; }
    if (token === '--resume') { options.resume = true; continue; }
    if (token === '--no-resume') { options.resume = false; continue; }
    for (const name of ['--output-dir', '--season-start', '--phase', '--access-level', '--request-delay-ms', '--max-games', '--report-file']) {
      if (token === name || token.startsWith(`${name}=`)) {
        const result = readOption(argv, index, name);
        if (name === '--output-dir') options.outputDir = path.resolve(result.value);
        else if (name === '--season-start') options.seasonStartYear = integer(result.value, name, { min: 1947, max: 2199 });
        else if (name === '--phase') options.phases = parsePhases(result.value);
        else if (name === '--access-level') {
          options.accessLevel = String(result.value).trim().toLowerCase();
          if (!['trial', 'production'].includes(options.accessLevel)) throw new Error('--access-level must be trial or production.');
        } else if (name === '--request-delay-ms') options.requestDelayMs = integer(result.value, name, { min: 1000, max: 120000 });
        else if (name === '--max-games') options.maxGames = integer(result.value, name, { min: 1, max: 5000 });
        else {
          const requested = path.resolve(ROOT, result.value);
          const relative = path.relative(ROOT, requested);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('--report-file must stay inside this workspace.');
          options.reportFile = requested;
        }
        index += result.consumed;
        break;
      }
    }
    if (token.startsWith('--') && !['--help', '--resume', '--no-resume', '--output-dir', '--season-start', '--phase', '--access-level', '--request-delay-ms', '--max-games', '--report-file'].some((name) => token === name || token.startsWith(`${name}=`))) {
      throw new Error(`Unknown option: ${token}`);
    }
  }
  if (!options.reportFile) options.reportFile = path.join(options.outputDir, 'report.json');
  return options;
}

function usage() {
  return `
Usage:
  node .\\scripts\\download-nba-sportradar-weekly.mjs [options]

Options:
  --season-start <year>       Season start year; default is derived from today
  --phase <list|all>           Phase list; default regular,in_season_tournament,play_in,playoffs
  --max-games <count>          New games per run; default 200
  --request-delay-ms <ms>     Minimum request delay; default 3500, minimum 1000
  --output-dir <path>          Local checkpoint directory; default outputs/nba-sportradar-weekly
  --report-file <path>         Non-secret run report; defaults inside output-dir
  --resume                     Reuse completed game files (default)
  --no-resume                  Rebuild the checkpoint from the selected schedules
  --help                      Show this help without a network request

Required process-only environment:
  ${NETWORK_GATE_ENV}=confirmed
  ${LICENSE_ENV}=confirmed
  ${LICENSE_REFERENCE_ENV}=non-secret approval reference
  ${API_KEY_ENV}=provider key
  ${ACCESS_LEVEL_ENV}=production or trial (default production)

The script is local-only and never writes Supabase. It stops on provider 403,
429 quota, and 429 throttling responses; credentials never enter URLs, reports,
or error messages.
`;
}

function requireConfiguration() {
  if (String(process.env[NETWORK_GATE_ENV] ?? '').trim().toLowerCase() !== 'confirmed') throw new Error(`${NETWORK_GATE_ENV}=confirmed is required before this script may contact Sportradar.`);
  if (String(process.env[LICENSE_ENV] ?? '').trim().toLowerCase() !== 'confirmed') throw new Error(`${LICENSE_ENV}=confirmed is required.`);
  const licenseReference = String(process.env[LICENSE_REFERENCE_ENV] ?? '').trim();
  if (!licenseReference) throw new Error(`${LICENSE_REFERENCE_ENV} must be a non-secret approval reference.`);
  const apiKey = String(process.env[API_KEY_ENV] ?? '').trim();
  if (!apiKey) throw new Error(`${API_KEY_ENV} must be supplied only to this process.`);
  const accessLevel = String(process.env[ACCESS_LEVEL_ENV] ?? 'production').trim().toLowerCase();
  if (!['trial', 'production'].includes(accessLevel)) throw new Error(`${ACCESS_LEVEL_ENV} must be production or trial.`);
  return { apiKey, licenseReference, accessLevel };
}

function stableJson(value) { return JSON.stringify(value, null, 2); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function providerEligible(game) { return game.status === 'closed' && String(game.coverage ?? '').toLowerCase() === 'full' && game.trackOnCourt === true; }

function sanitizeSummaryPayload(payload) {
  if (!payload || typeof payload !== 'object') return { payload, skippedPlayerRows: 0 };
  let skippedPlayerRows = 0;
  const sanitized = { ...payload };
  for (const side of ['home', 'away']) {
    const team = payload[side];
    if (!team || typeof team !== 'object' || !Array.isArray(team.players)) continue;
    const players = team.players.filter((player) => {
      const valid = UUID_PATTERN.test(String(player?.id ?? '').trim());
      if (!valid) skippedPlayerRows += 1;
      return valid;
    });
    sanitized[side] = { ...team, players };
  }
  return { payload: sanitized, skippedPlayerRows };
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return fallback; throw error; }
}

async function writeAtomic(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  await fs.rename(temporary, filePath);
}

async function writeGzipAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, gzipSync(Buffer.from(stableJson(value))));
  await fs.rename(temporary, filePath);
}

function rateLimitedFetcher(apiKey, requestDelayMs) {
  let nextRequestAt = 0;
  return async (url) => {
    const waitMilliseconds = Math.max(0, nextRequestAt - Date.now());
    if (waitMilliseconds) await sleep(waitMilliseconds);
    nextRequestAt = Date.now() + requestDelayMs;
    return fetchSportradarNbaJson(url, { apiKey, maxAttempts: 1 });
  };
}

function manifestTemplate(options, config) {
  return {
    schemaVersion: 1,
    exportVersion: EXPORT_VERSION,
    source: SOURCE,
    apiVersion: SPORTRADAR_NBA_API_VERSION,
    accessLevel: config.accessLevel,
    licenseReference: config.licenseReference,
    seasonStartYear: options.seasonStartYear,
    seasonEndYear: options.seasonStartYear + 1,
    requestDelayMs: options.requestDelayMs,
    phases: {},
    games: {},
    progress: { completed: 0, failed: 0, discovered: 0, attemptedNewGames: 0, stoppedEarly: null },
  };
}

function recordForArchive({ scheduleGame, summary, playByPlay, reconstruction, responses, config, skippedSummaryPlayerRows }) {
  return {
    exportVersion: EXPORT_VERSION,
    source: {
      provider: SOURCE,
      apiVersion: SPORTRADAR_NBA_API_VERSION,
      accessLevel: config.accessLevel,
      licenseReference: config.licenseReference,
      fetchedAt: new Date().toISOString(),
      summaryUrl: responses.summary.sourceUrl,
      playByPlayUrl: responses.playByPlay.sourceUrl,
      summaryEtag: responses.summary.etag ?? null,
      playByPlayEtag: responses.playByPlay.etag ?? null,
      summaryLastModified: responses.summary.lastModified ?? null,
      playByPlayLastModified: responses.playByPlay.lastModified ?? null,
      skippedSummaryPlayerRows: skippedSummaryPlayerRows || 0,
    },
    game: {
      providerGameId: scheduleGame.id,
      reference: summary.reference || scheduleGame.reference,
      srId: summary.srId || scheduleGame.srId,
      seasonStartYear: scheduleGame.seasonStartYear,
      seasonEndYear: scheduleGame.seasonEndYear,
      primaryPhase: scheduleGame.phase || 'regular',
      sourcePhases: [scheduleGame.phase || 'regular'],
      scheduledAt: summary.scheduledAt || scheduleGame.scheduledAt,
      providerStatus: summary.providerStatus,
      status: summary.status,
      coverage: summary.coverage || scheduleGame.coverage,
      trackOnCourt: summary.trackOnCourt === true && scheduleGame.trackOnCourt === true,
      homeProviderTeamId: summary.home.id,
      awayProviderTeamId: summary.away.id,
      homePoints: summary.home.points,
      awayPoints: summary.away.points,
      providerUpdatedAt: summary.providerUpdatedAt || playByPlay.providerUpdatedAt || scheduleGame.providerUpdatedAt || null,
    },
    teams: (summary.teams ?? []).map(({ players, ...team }) => team),
    players: summary.players,
    events: playByPlay.events,
    deletedEvents: playByPlay.deletedEvents,
    lineups: reconstruction.lineupDefinitions ?? [],
    stints: reconstruction.stints ?? [],
    possessions: reconstruction.possessions ?? [],
    analytics: {
      methodVersion: reconstruction.methodVersion,
      coverageStatus: reconstruction.coverageStatus,
      eligibleForPublication: reconstruction.isEligible === true,
      counts: reconstruction.counts ?? {},
      validation: reconstruction.validation ?? {},
    },
  };
}

function isQuotaOrThrottle(error) { return Number(error?.status) === 429; }
function isProviderAuthorization(error) { return Number(error?.status) === 401 || Number(error?.status) === 403; }

async function discoverCandidates(options, fetchJson, manifest) {
  const catalog = await fetchJson(buildSportradarNbaSeasonsUrl({ accessLevel: options.accessLevel }));
  const available = (catalog.payload?.seasons ?? [])
    .filter((season) => Number(season.year) === options.seasonStartYear && PHASE_BY_CODE[String(season.type?.code ?? '')])
    .map((season) => ({ phase: PHASE_BY_CODE[String(season.type.code)], code: season.type.code }));
  const requested = new Set(options.phases);
  const phases = available.filter(({ phase }) => requested.has(phase));
  const candidates = new Map();
  for (const { phase, code } of phases) {
    const response = await fetchJson(buildSportradarNbaScheduleUrl({ seasonStartYear: options.seasonStartYear, seasonPhase: phase, accessLevel: options.accessLevel }));
    const schedule = normalizeSportradarSchedule(response.payload, { seasonStartYear: options.seasonStartYear, seasonPhase: phase });
    const eligible = schedule.games.filter(providerEligible);
    manifest.phases[phase] = {
      providerCode: code,
      sourceUrl: response.sourceUrl,
      sourceEtag: response.etag ?? null,
      sourceLastModified: response.lastModified ?? null,
      fetchedAt: response.receivedAt,
      gamesDiscovered: schedule.games.length,
      eligibleGames: eligible.length,
    };
    for (const game of eligible) {
      const existing = candidates.get(game.id) ?? { game, phases: new Set() };
      existing.phases.add(phase);
      existing.game = { ...existing.game, ...game, phase: [...existing.phases].sort((a, b) => (PHASE_PRIORITY[a] ?? 99) - (PHASE_PRIORITY[b] ?? 99))[0] };
      candidates.set(game.id, existing);
    }
  }
  return candidates;
}

async function runWeeklySportradar(argv = process.argv.slice(2), env = process.env) {
  const options = parseWeeklySportradarOptions(argv);
  if (options.help) { console.log(usage()); return { help: true }; }
  const config = requireConfiguration({ env });
  await fs.mkdir(options.outputDir, { recursive: true });
  const manifestPath = path.join(options.outputDir, String(options.seasonStartYear), 'manifest.json');
  const manifest = options.resume
    ? await readJson(manifestPath, manifestTemplate(options, config))
    : manifestTemplate(options, config);
  const fetchJson = rateLimitedFetcher(config.apiKey, options.requestDelayMs);
  const report = {
    schemaVersion: 1,
    status: 'running',
    source: SOURCE,
    mode: 'local_archive_only',
    seasonStartYear: options.seasonStartYear,
    seasonEndYear: options.seasonStartYear + 1,
    phases: options.phases,
    maxGames: options.maxGames,
    requestDelayMs: options.requestDelayMs,
    networkAccess: 'Sportradar only; no Supabase',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    discoveredGames: 0,
    attemptedNewGames: 0,
    completedGames: 0,
    failedGames: 0,
    stoppedEarly: null,
    games: [],
    error: null,
  };
  try {
    const candidates = await discoverCandidates(options, fetchJson, manifest);
    const orderedGames = [...candidates.values()].sort((left, right) => (
      (PHASE_PRIORITY[left.game.phase] ?? 99) - (PHASE_PRIORITY[right.game.phase] ?? 99)
      || String(left.game.scheduledAt ?? '').localeCompare(String(right.game.scheduledAt ?? ''))
      || left.game.id.localeCompare(right.game.id)
    ));
    report.discoveredGames = orderedGames.length;
    let attempted = 0;
    for (const { game } of orderedGames) {
      const gameFile = path.join(options.outputDir, String(options.seasonStartYear), 'games', `${game.id}.json.gz`);
      const prior = manifest.games[game.id];
      if (options.resume && prior?.status === 'completed') {
        try {
          const record = JSON.parse(gunzipSync(await fs.readFile(gameFile)));
          if (weeklyArchiveIsComplete(record, game.id, options.accessLevel)) continue;
        } catch { /* Missing/corrupt/legacy checkpoints must be fetched again. */ }
      }
      if (attempted >= options.maxGames) { report.stoppedEarly = 'max_games_reached'; break; }
      attempted += 1;
      report.attemptedNewGames = attempted;
      try {
        const summaryResponse = await fetchJson(buildSportradarNbaSummaryUrl({ gameId: game.id, accessLevel: options.accessLevel }));
        const pbpResponse = await fetchJson(buildSportradarNbaPlayByPlayUrl({ gameId: game.id, accessLevel: options.accessLevel }));
        const sanitizedSummary = sanitizeSummaryPayload(summaryResponse.payload);
        const summary = normalizeSportradarSummary(sanitizedSummary.payload, { expectedGameId: game.id });
        const playByPlay = normalizeSportradarPlayByPlay(pbpResponse.payload, { expectedGameId: game.id });
        const reconstruction = reconstructNbaGameLineups({
          gameId: game.id,
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
        const record = recordForArchive({ scheduleGame: game, summary, playByPlay, reconstruction, responses: { summary: summaryResponse, playByPlay: pbpResponse }, config, skippedSummaryPlayerRows: sanitizedSummary.skippedPlayerRows });
        record.summaryCompleteness = inspectSummaryCompleteness(record);
        await writeGzipAtomic(gameFile, record);
        const status = record.summaryCompleteness.complete ? 'completed' : 'incomplete_summary';
        manifest.games[game.id] = {
          status,
          phase: game.phase,
          gameFile: path.relative(path.dirname(manifestPath), gameFile).replaceAll('\\', '/'),
          fetchedAt: record.source.fetchedAt,
          counts: record.analytics.counts,
          coverageStatus: record.analytics.coverageStatus,
          eligibleForPublication: record.analytics.eligibleForPublication,
          summaryCompleteness: record.summaryCompleteness,
        };
        report.games.push({ gameId: game.id, status, coverageStatus: record.analytics.coverageStatus, eligibleForPublication: record.analytics.eligibleForPublication, events: record.analytics.counts.eventCount ?? 0, stints: record.analytics.counts.stintCount ?? 0, possessions: record.analytics.counts.possessionCount ?? 0 });
      } catch (error) {
        const failure = { gameId: game.id, status: isQuotaOrThrottle(error) ? 'paused_provider_limit' : isProviderAuthorization(error) ? 'paused_authorization' : 'failed', error: String(error?.message ?? error).slice(0, 800), providerStatus: error?.status ?? null, providerLimit: error?.providerLimit ?? null, retryAfterMs: error?.retryAfterMs ?? null };
        manifest.games[game.id] = { ...failure, failedAt: new Date().toISOString() };
        report.games.push(failure);
        if (isQuotaOrThrottle(error)) { report.stoppedEarly = error?.providerLimit === 'quota_exceeded' ? 'provider_quota_exhausted' : 'provider_throttled'; break; }
        if (isProviderAuthorization(error)) { report.stoppedEarly = 'provider_authorization_failed'; break; }
      }
      const statuses = Object.values(manifest.games);
      manifest.progress = { completed: statuses.filter((entry) => entry.status === 'completed').length, failed: statuses.filter((entry) => entry.status !== 'completed').length, discovered: orderedGames.length, attemptedNewGames: attempted, stoppedEarly: report.stoppedEarly };
      await writeAtomic(manifestPath, `${stableJson(manifest)}\n`);
    }
    const statuses = Object.values(manifest.games);
    report.completedGames = statuses.filter((entry) => entry.status === 'completed').length;
    report.failedGames = statuses.filter((entry) => entry.status !== 'completed').length;
    report.status = report.stoppedEarly?.startsWith('provider_') ? 'paused' : report.failedGames > 0 ? 'completed_with_gaps' : 'completed';
    report.finishedAt = new Date().toISOString();
    await writeAtomic(manifestPath, `${stableJson(manifest)}\n`);
    await writeAtomic(options.reportFile, `${stableJson(report)}\n`);
    console.log(JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    report.status = 'failed';
    report.finishedAt = new Date().toISOString();
    report.error = String(error?.message ?? error).slice(0, 1200);
    await writeAtomic(options.reportFile, `${stableJson(report)}\n`);
    throw error;
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH;
if (invoked) runWeeklySportradar().catch((error) => { console.error(`Weekly Sportradar update failed: ${String(error?.message ?? error)}`); process.exitCode = 1; });
