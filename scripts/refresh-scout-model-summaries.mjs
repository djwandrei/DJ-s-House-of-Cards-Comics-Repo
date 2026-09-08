import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildSportradarNbaSummaryUrl, normalizeSportradarSummary, fetchSportradarNbaJson } from './lib/nba-sportradar-pbp.mjs';
import { inspectSummaryCompleteness } from './lib/nba-summary-completeness.mjs';
import { rebuildOptions } from './rebuild-scout-model-evidence.mjs';
import { readReadinessMetadata, runReadinessAudit } from './audit-lineup-scout-readiness.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
const INCLUDED_PHASES = ['regular', 'in_season_tournament', 'play_in', 'playoffs'];
const PRIVATE_ROOT = path.resolve(path.dirname(SCRIPT), '../outputs');

/**
 * Acquisition must not depend on a finished derived package: missing Summary
 * fields are precisely what can interrupt that build. Source-only mode uses
 * an attested archive, verifies each gzip hash, and writes separate overlays.
 * It NEVER mutates the archive currently being read by the base derivation.
 */
export function summarySourceOptions(argv) {
  if (!argv.includes('--source-only')) return null;
  const values = {};
  const allowed = ['--source-only', '--archive-dir', '--source-validation', '--summary-overlay', '--previous-overlay', '--seasons'];
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    assert.ok(allowed.includes(name) && value && !value.startsWith('--') && !values[name], 'Invalid source-only Summary options.');
    values[name] = value;
  }
  assert.equal(values['--source-only'], 'true', 'Use --source-only true.');
  assert.ok(/^\d{4}(,\d{4})*$/.test(values['--seasons'] ?? ''), 'Explicit --seasons are required.');
  const seasons = values['--seasons'].split(',').map(Number);
  assert.equal(new Set(seasons).size, seasons.length, 'Duplicate season.');
  const options = { seasons, includedPhases: INCLUDED_PHASES };
  for (const [name, key] of [['--archive-dir', 'archive'], ['--source-validation', 'sourceValidation'], ['--summary-overlay', 'overlay'], ['--previous-overlay', 'previousOverlay']]) {
    if (key === 'previousOverlay' && !values[name]) continue;
    assert.ok(values[name], `Required: ${name}.`);
    const target = path.resolve(values[name]);
    assert.ok(target.startsWith(`${PRIVATE_ROOT}${path.sep}`), 'Source-only artifacts must remain in private outputs.');
    options[key] = target;
  }
  assert.ok(options.overlay !== options.archive && !options.overlay.startsWith(`${options.archive}${path.sep}`), 'Use a separate Summary overlay directory.');
  assert.notEqual(options.overlay, options.previousOverlay, 'Use a new overlay revision when reusing an earlier one.');
  return options;
}

function validateOverlayBinding(overlay, game, sourceHash) {
  assert.equal(overlay.sourceGzipSha256, sourceHash, 'Overlay is bound to a different source game.');
  assert.equal(overlay.gameId, game.providerGameId);
  assert.equal(overlay.homeTeamId, game.homeProviderTeamId);
  assert.equal(overlay.awayTeamId, game.awayProviderTeamId);
}

async function readOptional(target) {
  return fs.readFile(target).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
}

async function replaceOverlay(target, overlay, previousBytes) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  // A partial response is valuable source evidence. Keep a content-addressed
  // backup before replacing it on a later run, rather than erasing the gap.
  if (previousBytes) {
    const backup = `${target}.incomplete-${sha(previousBytes)}.json`;
    try { await fs.writeFile(backup, previousBytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(sha(await fs.readFile(backup)), sha(previousBytes));
    }
  }
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(overlay), { flag: 'wx' });
  await fs.rename(temporary, target);
}

/** A local request budget is a safety stop, not a claim about provider quota. */
export function summaryRefreshOptions(argv) {
  const rebuildArgs = []; let requestBudget = null;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (name !== '--request-budget') { rebuildArgs.push(name, value); continue; }
    if (requestBudget !== null || !/^[1-9]\d*$/.test(value ?? '') || !Number.isSafeInteger(Number(value))) {
      throw new Error('--request-budget must be one positive integer.');
    }
    requestBudget = Number(value);
  }
  return { rebuildArgs, requestBudget };
}

export function summaryQuotaHeaders(headers) {
  // Only numeric, allowlisted metering headers may enter progress/logs. Missing
  // headers mean unknown allowance, never an assumed fresh 1,000-call balance.
  const read = name => {
    const value = headers?.get?.(name);
    return /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  };
  return { allotted: read('x-plan-quota-allotted'), used: read('x-plan-quota-current'), remaining: read('x-plan-quota-remaining') };
}

export function normalizeSummaryOverlay(payload, expectedGame, source = {}) {
  // Provider pseudo-players are not real people; omit only rows lacking an ID,
  // just as the original downloader does, and retain an explicit skipped count.
  const sanitized = structuredClone(payload); let skippedPseudoPlayers = 0;
  for (const side of ['home', 'away']) {
    const rows = sanitized[side]?.players ?? [];
    if (!Array.isArray(rows)) throw new Error('Malformed Summary players array.');
    if (sanitized[side]) sanitized[side].players = rows.filter(row => {
      const keep = uuid(row?.id); if (!keep) skippedPseudoPlayers++; return keep;
    });
  }
  const summary = normalizeSportradarSummary(sanitized, { expectedGameId: expectedGame.providerGameId });
  assert.equal(summary.home.id, expectedGame.homeProviderTeamId, 'Summary home team changed.');
  assert.equal(summary.away.id, expectedGame.awayProviderTeamId, 'Summary away team changed.');
  assert.equal(summary.home.points, expectedGame.homePoints, 'Summary final score changed; source revalidation required.');
  assert.equal(summary.away.points, expectedGame.awayPoints, 'Summary final score changed; source revalidation required.');
  return { version: 'nba_independent_summary_overlay_v1', gameId: expectedGame.providerGameId,
    homeTeamId: summary.home.id, awayTeamId: summary.away.id,
    players: summary.players, skippedPseudoPlayers,
    source: { provider: 'sportradar_nba', endpoint: 'game_summary_v8', accessLevel: 'trial',
      fetchedAt: new Date().toISOString(), responsePayloadSha256: sha(JSON.stringify(payload)),
      etag: source.etag ?? null, lastModified: source.lastModified ?? null },
  };
}

/**
 * One serial request at most every two seconds across ALL supplied keys. Keys
 * rotate only for ordinary requests, never to escape 401/403/429/quota errors.
 * Credentials are inherited from the launcher and are never serialized.
 */
export async function refreshScoutSummaries(argv, { fetchJson = fetchSportradarNbaJson, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const { rebuildArgs, requestBudget } = summaryRefreshOptions(argv);
  let options = summarySourceOptions(rebuildArgs);
  if (!options) {
    const legacy = rebuildOptions(rebuildArgs);
    assert.equal((await runReadinessAudit(legacy.core)).readyForIntegrationReview, true);
    const { data: base } = await readReadinessMetadata(legacy.readiness.manifest);
    options = { ...legacy, seasons: legacy.readiness.seasons, sourceValidation: legacy.readiness.sourceValidation,
      includedPhases: base.scope.includedPhases };
  }
  assert.ok(options.overlay, '--summary-overlay is required.');
  const sourceFile = await readReadinessMetadata(options.sourceValidation);
  const sourceReport = sourceFile.data;
  assert.equal(sourceReport.passed, true, 'A passing source attestation is required.');
  assert.equal(sourceReport.errors?.length ?? 0, 0);
  for (const year of options.seasons) assert.ok(sourceReport.seasons.some(row => row.seasonStartYear === year), 'Season absent from source attestation.');
  const keys = [...new Set([process.env.SPORTRADAR_NBA_API_KEY, process.env.SPORTRADAR_NBA_API_KEY_2].filter(Boolean))];
  assert.ok(keys.length > 0, 'Configure a Sportradar API key in the process environment.');
  await fs.mkdir(options.overlay, { recursive: true });
  const lockPath = path.join(options.overlay, 'writer.lock');
  const lock = await fs.open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ processId: process.pid, startedAt: new Date().toISOString() }));
  let downloaded = 0, reused = 0, retained = 0, requestCount = 0, checked = 0, outsideScope = 0;
  const incompleteGames = [];
  let reportedQuota = null;
  let lastFailure = null;
  const emit = async status => {
    const value = { phase: 'official_summary_refresh', status, downloaded, reused, retained,
      checked, outsideScope, incompleteGames: incompleteGames.length,
      seasonStartYears: options.seasons, sourceValidationSha256: sourceFile.sha256,
      contract: 'nba_required_summary_fields_v1',
      lastFailure,
      requestCount, requestBudget, reportedQuota, updatedAt: new Date().toISOString(), processId: process.pid };
    const temporary = path.join(options.overlay, `progress.${process.pid}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(value));
    await fs.rename(temporary, path.join(options.overlay, 'progress.json'));
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  try {
    await emit('running');
    // Current-season evidence is most useful for the user's current-player
    // workload cases. Scope is unchanged; older missing games follow afterward.
    for (const year of [...options.seasons].sort((a, b) => b - a)) {
      const season = sourceReport.seasons.find(row => row.seasonStartYear === year);
      for (const file of season.files.records) {
        const target = path.resolve(options.archive, String(year), file.relativePath);
        assert.ok(target.startsWith(`${path.resolve(options.archive, String(year))}${path.sep}`));
        const compressed = await fs.readFile(target);
        assert.equal(sha(compressed), file.gzipSha256, 'Source game changed since validation.');
        const record = JSON.parse(gunzipSync(compressed));
        const game = record.game;
        assert.equal(game.providerGameId, file.gameId, 'Source game identity changed.');
        assert.equal(game.seasonStartYear, year);
        assert.equal(record.source?.accessLevel, 'trial', 'This refresh is explicitly scoped to the trial archive.');
        checked++;
        if (!options.includedPhases.includes(game.primaryPhase) || game.status !== 'closed'
          || record.teams?.length !== 2 || !record.teams.every(team => String(team.srId ?? '').startsWith('sr:team:'))) { outsideScope++; continue; }
        if (inspectSummaryCompleteness(record).complete) {
          retained++; continue;
        }
        assert.ok(uuid(game.providerGameId));
        const output = path.join(options.overlay, String(year), `${game.providerGameId}.json`);
        const previousBytes = await readOptional(output);
        let reusable = null;
        for (const bytes of [previousBytes, options.previousOverlay
          ? await readOptional(path.join(options.previousOverlay, String(year), `${game.providerGameId}.json`)) : null]) {
          if (!bytes) continue;
          let previous;
          try { previous = JSON.parse(bytes); } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
          validateOverlayBinding(previous, game, file.gzipSha256);
          if (inspectSummaryCompleteness(record, previous).complete) { reusable = previous; break; }
        }
        if (reusable) {
          if (!previousBytes || sha(previousBytes) !== sha(JSON.stringify(reusable))) await replaceOverlay(output, reusable, previousBytes);
          reused++; continue;
        }
        if (requestBudget !== null && requestCount >= requestBudget) {
          await emit('paused_request_budget');
          return { complete: false, downloaded, reused, retained, requestCount };
        }
        if (requestCount > 0) await sleep(2000);
        const apiKey = keys[requestCount % keys.length]; requestCount++;
        // On authentication, access, rate, or quota errors stop the job. Never
        // switch keys in response to an error or persist an error body.
        const response = await fetchJson(buildSportradarNbaSummaryUrl({ gameId: game.providerGameId, accessLevel: 'trial' }),
          { apiKey, maxAttempts: 1, signal: AbortSignal.timeout(45000), fetchImpl: async (url, init) => {
            // Do not forward an authentication header through a redirect.
            const result = await fetch(url, { ...init, redirect: 'error' });
            reportedQuota = summaryQuotaHeaders(result.headers);
            return result;
          } });
        const overlay = { ...normalizeSummaryOverlay(response.payload, game, response), sourceGzipSha256: file.gzipSha256 };
        overlay.completeness = inspectSummaryCompleteness(record, overlay);
        await replaceOverlay(output, overlay, previousBytes);
        if (!overlay.completeness.complete) {
          incompleteGames.push({ seasonStartYear: year, gameId: game.providerGameId, ...overlay.completeness });
          // Persist each gap immediately. An interruption must not erase the
          // record of a successfully downloaded but unusable provider response.
          const gapFile = path.join(options.overlay, `incomplete-games.${process.pid}.json`);
          const gapTemp = `${gapFile}.tmp`;
          await fs.writeFile(gapTemp, JSON.stringify(incompleteGames));
          await fs.rename(gapTemp, gapFile);
        }
        downloaded++;
        if (downloaded % 10 === 0 || downloaded === 1) await emit('running');
      }
    }
    assert.ok(downloaded + reused + retained > 0, 'No in-scope games checked.');
    const complete = incompleteGames.length === 0;
    await emit(complete ? 'complete' : 'blocked_incomplete_summaries');
    return { complete, downloaded, reused, retained, requestCount, incompleteGames: incompleteGames.length };
  } catch (error) {
    // Record only bounded, non-secret diagnostics. In particular a generic
    // HTTP 429 is not proof of exhausted quota; retain Retry-After when given.
    lastFailure = { code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'VALIDATION_ERROR',
      status: Number.isInteger(error.status) ? error.status : null,
      providerLimit: ['quota_exceeded', 'throttled', 'rate_limited_unknown'].includes(error.providerLimit) ? error.providerLimit : null,
      retryAfterMs: Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : null };
    await emit('stopped_needs_review');
    throw error;
  } finally {
    await lock.close();
    await fs.unlink(lockPath); // This process's lock only; all downloaded data remains resumable.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  try {
    const args = process.argv.slice(2);
    const refreshed = await refreshScoutSummaries(args);
    // Import only. The user requested that every season's required data be
    // present and checked before rebuilding. Even a completed Summary queue
    // is not permission to derive a new package or refit its coefficients.
    process.stdout.write(`${JSON.stringify({ ...refreshed, rebuildStarted: false })}\n`);
  } catch (error) {
    // The shared fetch wrapper has sanitized messages; prefer codes/status to
    // unknown provider text in long-lived process logs nonetheless.
    const limit = ['quota_exceeded', 'throttled', 'rate_limited_unknown'].includes(error.providerLimit) ? ` (${error.providerLimit})` : '';
    process.stderr.write(`Scout refresh/rebuild stopped: ${error.code ?? 'VALIDATION_ERROR'}${error.status ? ` HTTP ${error.status}` : ''}${limit}. Checkpoint retained; no package promoted.\n`);
    process.exitCode = 1;
  }
}
