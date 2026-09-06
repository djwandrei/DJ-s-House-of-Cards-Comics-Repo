import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { buildSportradarNbaSummaryUrl, normalizeSportradarSummary, fetchSportradarNbaJson } from './lib/nba-sportradar-pbp.mjs';
import { BOX_FIELDS, readOfficialBox } from './lib/nba-scout-model-evidence.mjs';
import { rebuildOptions } from './rebuild-scout-model-evidence.mjs';
import { readReadinessMetadata, runReadinessAudit } from './audit-lineup-scout-readiness.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);

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
  const options = rebuildOptions(rebuildArgs);
  assert.ok(options.overlay, '--summary-overlay is required.');
  assert.equal((await runReadinessAudit(options.core)).readyForIntegrationReview, true);
  const { data: base } = await readReadinessMetadata(options.readiness.manifest);
  const { data: sourceReport } = await readReadinessMetadata(options.readiness.sourceValidation);
  const keys = [...new Set([process.env.SPORTRADAR_NBA_API_KEY, process.env.SPORTRADAR_NBA_API_KEY_2].filter(Boolean))];
  assert.ok(keys.length > 0, 'Configure a Sportradar API key in the process environment.');
  await fs.mkdir(options.overlay, { recursive: true });
  const lockPath = path.join(options.overlay, 'writer.lock');
  const lock = await fs.open(lockPath, 'wx');
  await lock.writeFile(JSON.stringify({ processId: process.pid, startedAt: new Date().toISOString() }));
  let downloaded = 0, reused = 0, retained = 0, requestCount = 0;
  let reportedQuota = null;
  const emit = async status => {
    const value = { phase: 'official_summary_refresh', status, downloaded, reused, retained,
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
    for (const year of [...options.readiness.seasons].sort((a, b) => b - a)) {
      const season = sourceReport.seasons.find(row => row.seasonStartYear === year);
      for (const file of season.files.records) {
        const target = path.resolve(options.archive, String(year), file.relativePath);
        assert.ok(target.startsWith(`${path.resolve(options.archive, String(year))}${path.sep}`));
        const compressed = await fs.readFile(target);
        assert.equal(sha(compressed), file.gzipSha256, 'Source game changed since validation.');
        const record = JSON.parse(gunzipSync(compressed));
        const game = record.game;
        if (!base.scope.includedPhases.includes(game.primaryPhase) || game.status !== 'closed'
          || record.teams?.length !== 2 || !record.teams.every(team => String(team.srId ?? '').startsWith('sr:team:'))) continue;
        const active = (record.players ?? []).filter(row => typeof row.minutesPlayed === 'number' && row.minutesPlayed > 0);
        if (active.length > 0 && active.every(row => BOX_FIELDS.every(field => readOfficialBox(row)[field] !== null))) {
          retained++; continue;
        }
        assert.ok(uuid(game.providerGameId));
        const output = path.join(options.overlay, String(year), `${game.providerGameId}.json`);
        try {
          const previous = JSON.parse(await fs.readFile(output, 'utf8'));
          assert.equal(previous.sourceGzipSha256, file.gzipSha256, 'Overlay is bound to different source game.');
          assert.equal(previous.gameId, game.providerGameId);
          assert.equal(previous.homeTeamId, game.homeProviderTeamId);
          assert.equal(previous.awayTeamId, game.awayProviderTeamId);
          reused++; continue;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
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
        await fs.mkdir(path.dirname(output), { recursive: true });
        const temporary = `${output}.${process.pid}.tmp`;
        await fs.writeFile(temporary, JSON.stringify(overlay), { flag: 'wx' });
        await fs.rename(temporary, output);
        downloaded++;
        if (downloaded % 10 === 0 || downloaded === 1) await emit('running');
      }
    }
    await emit('complete');
    return { complete: true, downloaded, reused, retained, requestCount };
  } catch (error) {
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
