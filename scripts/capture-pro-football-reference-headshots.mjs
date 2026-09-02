#!/usr/bin/env node

/**
 * Local, resumable NFL player-page capture worker.
 *
 * This is intended for Windows Task Scheduler, not Codex. It uses a locally
 * installed Chromium browser to render normal Pro Football Reference profile
 * pages and stores only the rendered document in the existing media cache.
 * The existing media importer remains responsible for validating and writing
 * provider-hosted headshot URLs to the isolated analytics project.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const CACHE_DIRECTORY = path.join(ROOT, 'outputs', 'sports-reference-media-cache', 'nfl', 'players');
const STATE_FILE = path.join(ROOT, 'outputs', 'sports-reference-media-cache', 'nfl', 'headshot-capture-state.json');
const DEFERRED_FAILURES_FILE = path.join(ROOT, 'outputs', 'sports-reference-media-cache', 'nfl', 'headshot-capture-deferred.jsonl');
const PENDING_IMPORTS_FILE = path.join(ROOT, 'outputs', 'sports-reference-media-cache', 'nfl', 'headshot-import-pending.json');
const BROWSER_PROFILE_ROOT = path.join(ROOT, 'outputs', 'sports-reference-media-cache', 'nfl', 'browser-profiles');
const BROWSER_PROFILE_DIRECTORY = path.join(BROWSER_PROFILE_ROOT, 'normal-session');
const IMPORTER = path.join(ROOT, 'scripts', 'import-sports-reference-media.mjs');
const ANALYTICS_WORKDIR = path.join(ROOT, 'supabase-sports-analytics');
const SUPABASE_CLI_VERSION = '2.115.0';
const SOURCE_NAME = 'pro_football_reference';
const DEFAULT_LIMIT = 50;
const DEFAULT_CONCURRENCY = 2;
const MAX_LIMIT = 100;
const MAX_CONCURRENCY = 2;
const MAX_PROFILE_RETRY_ATTEMPTS = 3;
const CDP_START_TIMEOUT_MS = 20_000;
const PROFILE_CAPTURE_TIMEOUT_MS = 45_000;
const SOURCE_CHALLENGE_GRACE_MS = 30_000;
// Sports Reference blocks PFR users that exceed 20 source requests/minute.
// Each player navigation can request more than its HTML document, so keep a
// deliberate 10-navigation/minute ceiling instead of relying on tab count.
const MIN_NAVIGATION_INTERVAL_MS = 6_000;
const PLAYER_ID_PATTERN = /^[A-Za-z0-9.]+$/;

function usage() {
  return `
Usage:
  node .\\scripts\\capture-pro-football-reference-headshots.mjs [options]

Options:
  --limit <1-100>             Profiles to examine per scheduled run (default: ${DEFAULT_LIMIT})
  --concurrency <1-2>         Reusable normal-browser tabs (default: ${DEFAULT_CONCURRENCY})
  --skip-import               Cache pages only; do not run the approved media importer
  --resume-after-challenge    Clear a recorded source challenge after it is resolved in a normal browser
  --headless                  Diagnostic mode only; normal runs use standard Chrome verification
  --help                      Show this message
`;
}

function positiveInteger(value, label, maximum) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  return parsed;
}

function parseArgs(argv) {
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
  const known = new Set(['limit', 'concurrency', 'skip-import', 'resume-after-challenge', 'headless', 'help']);
  for (const name of [...values.keys(), ...flags]) if (!known.has(name)) throw new Error(`Unknown option: --${name}`);
  return {
    help: flags.has('help'),
    limit: positiveInteger(values.get('limit') ?? DEFAULT_LIMIT, '--limit', MAX_LIMIT),
    concurrency: positiveInteger(values.get('concurrency') ?? DEFAULT_CONCURRENCY, '--concurrency', MAX_CONCURRENCY),
    skipImport: flags.has('skip-import'),
    resumeAfterChallenge: flags.has('resume-after-challenge'),
    headless: flags.has('headless'),
  };
}

function sqlLiteral(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function cacheFile(externalId) { return path.join(CACHE_DIRECTORY, `${externalId}.html`); }

function hasCachedDocument(externalId) {
  try {
    const html = fs.readFileSync(cacheFile(externalId), 'utf8');
    return html.length > 10_000
      && !isSourceChallenge(html)
      && html.includes('pro-football-reference')
      && /<[^>]+\bid=["']meta["'][^>]*>[\s\S]{0,6000}?<h1\b/i.test(html);
  } catch { return false; }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      lastExternalId: PLAYER_ID_PATTERN.test(String(parsed?.lastExternalId ?? '')) ? String(parsed.lastExternalId) : '',
      retryExternalId: PLAYER_ID_PATTERN.test(String(parsed?.retryExternalId ?? '')) ? String(parsed.retryExternalId) : '',
      retryAttempts: Math.max(0, Math.min(MAX_PROFILE_RETRY_ATTEMPTS, Number.parseInt(String(parsed?.retryAttempts ?? 0), 10) || 0)),
      blockedReason: String(parsed?.blockedReason ?? '').slice(0, 1000),
    };
  } catch { return { lastExternalId: '', retryExternalId: '', retryAttempts: 0, blockedReason: '' }; }
}

async function saveState(lastExternalId, { retryExternalId = '', retryAttempts = 0, blockedReason = '' } = {}) {
  await fsp.mkdir(path.dirname(STATE_FILE), { recursive: true });
  const next = { lastExternalId, retryExternalId, retryAttempts, blockedReason, updatedAt: new Date().toISOString() };
  const temporary = `${STATE_FILE}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, STATE_FILE);
}

async function recordDeferredFailure(externalId, error) {
  await fsp.mkdir(path.dirname(DEFERRED_FAILURES_FILE), { recursive: true });
  const entry = { externalId, deferredAt: new Date().toISOString(), error: String(error?.message ?? error).slice(0, 1000) };
  await fsp.appendFile(DEFERRED_FAILURES_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

function normalizeExternalIds(ids) {
  return [...new Set(ids.map((value) => String(value)).filter((value) => PLAYER_ID_PATTERN.test(value)))];
}

function loadPendingImportIds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(PENDING_IMPORTS_FILE, 'utf8'));
    return normalizeExternalIds(Array.isArray(parsed) ? parsed : Array.isArray(parsed?.externalIds) ? parsed.externalIds : []);
  } catch { return []; }
}

async function savePendingImportIds(ids) {
  const externalIds = normalizeExternalIds(ids);
  await fsp.mkdir(path.dirname(PENDING_IMPORTS_FILE), { recursive: true });
  const temporary = `${PENDING_IMPORTS_FILE}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify({ externalIds, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  await fsp.rename(temporary, PENDING_IMPORTS_FILE);
  return externalIds;
}

async function enqueuePendingImportIds(ids) {
  if (!ids.length) return loadPendingImportIds();
  return savePendingImportIds([...loadPendingImportIds(), ...ids]);
}

function browserExecutable() {
  const candidates = [
    process.env.PRO_FOOTBALL_REFERENCE_BROWSER_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error('No local Chrome or Edge executable was found. Set PRO_FOOTBALL_REFERENCE_BROWSER_PATH to an installed browser executable.');
  return found;
}

function runProcess(command, argumentsList, timeoutMs, { cwd = ROOT, shell = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, { cwd, windowsHide: true, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      // Chrome can keep renderer descendants alive after its parent process is
      // signalled. End the process tree so a single slow page cannot leave a
      // scheduled Node worker permanently running.
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
        killer.unref();
      } else child.kill();
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function delay(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

class NavigationPacer {
  #tail = Promise.resolve();
  #nextStartAt = 0;

  async acquire() {
    const reservation = this.#tail.then(async () => {
      const waitMs = Math.max(0, this.#nextStartAt - Date.now());
      if (waitMs) await delay(waitMs);
      this.#nextStartAt = Date.now() + MIN_NAVIGATION_INTERVAL_MS;
    });
    // Keep later callers queued even when a prior caller is interrupted.
    this.#tail = reservation.catch(() => {});
    await reservation;
  }
}

async function waitFor(read, timeoutMs, description) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await read();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}.${lastError ? ` ${String(lastError.message ?? lastError)}` : ''}`);
}

function terminateProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.unref();
  } else child.kill();
}

class CdpPage {
  #webSocket;
  #sequence = 0;
  #pending = new Map();

  constructor(webSocket) {
    this.#webSocket = webSocket;
    webSocket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Chrome DevTools error: ${message.error.message ?? JSON.stringify(message.error)}`));
      else pending.resolve(message.result ?? {});
    });
    const rejectAll = () => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Chrome DevTools connection closed.'));
      }
      this.#pending.clear();
    };
    webSocket.addEventListener('close', rejectAll);
    webSocket.addEventListener('error', rejectAll);
  }

  command(method, params = {}, timeoutMs = PROFILE_CAPTURE_TIMEOUT_MS) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for Chrome DevTools ${method}.`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#webSocket.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() {
    try { await this.command('Page.close', {}, 2_000); } catch { /* browser cleanup closes the target too */ }
    try { this.#webSocket.close(); } catch { /* already closed */ }
  }
}

async function connectCdpPage(port) {
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
  if (!targetResponse.ok) throw new Error(`Chrome DevTools target creation failed (${targetResponse.status}).`);
  const target = await targetResponse.json();
  const webSocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out connecting to Chrome DevTools.')), CDP_START_TIMEOUT_MS);
    webSocket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    webSocket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Chrome DevTools.')); }, { once: true });
  });
  const page = new CdpPage(webSocket);
  await page.command('Page.enable', {}, CDP_START_TIMEOUT_MS);
  await page.command('Runtime.enable', {}, CDP_START_TIMEOUT_MS);
  return page;
}

async function launchBrowserPool(browser, concurrency, { headless = false } = {}) {
  const browserProfile = BROWSER_PROFILE_DIRECTORY;
  await fsp.mkdir(browserProfile, { recursive: true });
  // A prior Chrome run can leave this file behind.  Treating it as the new
  // browser's endpoint races the launch and causes an immediate failed fetch
  // against a dead debugging port.
  const devToolsActivePort = path.join(browserProfile, 'DevToolsActivePort');
  await fsp.rm(devToolsActivePort, { force: true });
  const browserArgs = [
    '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${browserProfile}`, 'about:blank',
  ];
  if (headless) browserArgs.unshift('--headless=new');
  const child = spawn(browser, browserArgs, { windowsHide: headless, stdio: 'ignore' });
  child.unref();
  try {
    const port = await waitFor(async () => {
      const text = await fsp.readFile(devToolsActivePort, 'utf8');
      const parsed = Number.parseInt(text.split(/\r?\n/, 1)[0], 10);
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
    }, CDP_START_TIMEOUT_MS, 'Chrome DevTools startup');
    const pages = await Promise.all(Array.from({ length: concurrency }, () => connectCdpPage(port)));
    return {
      pages,
      async close() {
        await Promise.allSettled(pages.map((page) => page.close()));
        terminateProcessTree(child);
      },
    };
  } catch (error) {
    terminateProcessTree(child);
    throw error;
  }
}

async function nextCandidates(afterExternalId, needed) {
  const batchSize = Math.max(160, needed * 4);
  const query = `
    select e.external_id
    from public.nfl_player_external_ids as e
    left join public.nfl_media_assets as media
      on media.player_id = e.player_id and media.asset_kind = 'headshot'
    where e.source_name = ${sqlLiteral(SOURCE_NAME)}
      and media.id is null
      and exists (
        select 1
        from public.nfl_player_team_season_stats as stats
        where stats.player_id = e.player_id
          and stats.season_year >= 2010
      )
      and e.external_id > ${sqlLiteral(afterExternalId)}
    order by e.external_id
    limit ${batchSize};
  `.replace(/\s+/g, ' ').trim();
  const quotedQuery = `"${query.replaceAll('"', '\\"')}"`;
  const result = await runProcess('npx.cmd', [
    '--yes', `supabase@${SUPABASE_CLI_VERSION}`, 'db', 'query', '--linked', '--workdir', ANALYTICS_WORKDIR,
    '--output-format', 'json', quotedQuery,
  ], 90_000, { cwd: ANALYTICS_WORKDIR, shell: true });
  if (result.code !== 0) throw new Error(`Candidate query failed (${result.code}): ${String(`${result.stderr}\n${result.stdout}`).trim().slice(0, 1600)}`);
  const payloadText = String(result.stdout).trim();
  let rows = null;
  try {
    const parsed = JSON.parse(payloadText);
    if (Array.isArray(parsed)) rows = parsed;
    else if (Array.isArray(parsed?.rows)) rows = parsed.rows;
  } catch { /* scan for an envelope after CLI notices */ }
  for (const match of payloadText.matchAll(/\{/g)) {
    if (rows) break;
    try {
      const parsed = JSON.parse(payloadText.slice(match.index));
      if (Array.isArray(parsed?.rows)) { rows = parsed.rows; break; }
    } catch { /* scan for the JSON envelope after CLI notices */ }
  }
  if (!rows) throw new Error(`Candidate query returned invalid JSON: ${payloadText.slice(0, 1200)}`);
  const candidates = [];
  for (const row of rows) {
    const externalId = String(row.external_id ?? '');
    if (!PLAYER_ID_PATTERN.test(externalId)) throw new Error(`Unsafe NFL external ID returned by the database: ${externalId}`);
    if (!hasCachedDocument(externalId)) candidates.push(externalId);
    if (candidates.length >= needed) break;
  }
  return { candidates, lastScannedId: candidates.at(-1) ?? String(rows.at(-1)?.external_id ?? afterExternalId), exhausted: rows.length < batchSize };
}

class SourceChallengeError extends Error {}

function isSourceChallenge(html) {
  return /just a moment|attention required|challenge-platform|cf-chl-|captcha/i.test(html);
}

function isExpectedProfileProbe(snapshot, expectedPath) {
  return String(snapshot.pathname ?? '').toLowerCase() === expectedPath
    && snapshot.readyState === 'complete'
    && snapshot.hasMetaH1 === true;
}

async function captureProfile(page, externalId, navigationPacer) {
  const url = `https://www.pro-football-reference.com/players/${externalId[0].toUpperCase()}/${externalId}.htm`;
  const expectedPath = `/players/${externalId[0].toUpperCase()}/${externalId}.htm`.toLowerCase();
  const destination = cacheFile(externalId);
  await navigationPacer.acquire();
  await page.command('Page.navigate', { url }, PROFILE_CAPTURE_TIMEOUT_MS);
  const challengeDeadline = Date.now() + SOURCE_CHALLENGE_GRACE_MS;
  const deadline = Date.now() + PROFILE_CAPTURE_TIMEOUT_MS;
  let lastSnapshot = {};
  while (Date.now() < deadline) {
    const result = await page.command('Runtime.evaluate', {
      expression: `(() => ({
        pathname: location.pathname,
        readyState: document.readyState,
        title: document.title || '',
        hasMetaH1: Boolean(document.querySelector('#meta h1')),
        challengeMarker: Boolean(document.querySelector('[id*="cf-chl"], [class*="cf-chl"], iframe[src*="challenge"], input[name*="turnstile"]')),
        bodyText: (document.body?.innerText || '').slice(0, 320)
      }))()`,
      returnByValue: true,
    }, 5_000);
    const snapshot = result?.result?.value ?? {};
    lastSnapshot = snapshot;
    const sourceSignal = `${snapshot.title ?? ''}\n${snapshot.bodyText ?? ''}\n${snapshot.challengeMarker ? 'cf-chl-' : ''}`;
    if (isSourceChallenge(sourceSignal)) {
      if (Date.now() >= challengeDeadline) {
        throw new SourceChallengeError('Pro Football Reference did not complete its normal security verification. Resolve any visible challenge in the dedicated browser, then resume the worker.');
      }
      await delay(500);
      continue;
    }
    if (isExpectedProfileProbe(snapshot, expectedPath)) {
      const htmlResult = await page.command('Runtime.evaluate', {
        expression: 'document.documentElement ? document.documentElement.outerHTML : ""',
        returnByValue: true,
      }, 10_000);
      const html = String(htmlResult?.result?.value ?? '');
      const expectedDocument = html.includes('pro-football-reference')
        && /\bid=["']meta["']/i.test(html)
        && /<h1\b/i.test(html)
        && !isSourceChallenge(html);
      if (!expectedDocument) {
        await delay(250);
        continue;
      }
      const temporary = `${destination}.tmp`;
      await fsp.writeFile(temporary, html, 'utf8');
      await fsp.rename(temporary, destination);
      return { externalId, headshotDetected: html.includes('images/headshots') };
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for a valid Pro Football Reference profile document for ${externalId}. Last signal: ${JSON.stringify({ pathname: lastSnapshot.pathname ?? '', readyState: lastSnapshot.readyState ?? '', title: lastSnapshot.title ?? '', hasMetaH1: Boolean(lastSnapshot.hasMetaH1), challengeMarker: Boolean(lastSnapshot.challengeMarker), bodyText: String(lastSnapshot.bodyText ?? '').slice(0, 160) })}`);
}

async function importCachedHeadshots(externalIds) {
  const args = [IMPORTER, '--sport', 'nfl', '--kind', 'headshots', '--profile-start', '2010', '--external-ids', externalIds.join(','), '--cache-only', '--apply', '--analytics'];
  const result = await runProcess(process.execPath, args, 180_000);
  if (result.code !== 0) throw new Error(`Media import failed: ${String(result.stderr || result.stdout).trim().slice(0, 1200)}`);
  return String(result.stdout).trim();
}

async function importPendingHeadshots() {
  const externalIds = loadPendingImportIds().slice(0, 200);
  if (!externalIds.length) return { importedIds: [], report: '' };
  const report = await importCachedHeadshots(externalIds);
  const imported = new Set(externalIds);
  await savePendingImportIds(loadPendingImportIds().filter((externalId) => !imported.has(externalId)));
  return { importedIds: externalIds, report };
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage()); return; }
  await fsp.mkdir(CACHE_DIRECTORY, { recursive: true });
  const state = loadState();
  if (state.blockedReason && !options.resumeAfterChallenge) {
    console.log(JSON.stringify({ status: 'blocked_source_challenge', cursor: state.lastExternalId, reason: state.blockedReason }, null, 2));
    return;
  }
  const selection = await nextCandidates(state.lastExternalId, options.limit);
  if (!selection.candidates.length) {
    // Valid cached pages may not have a headshot. Move past such a window so
    // the scheduler cannot repeatedly rescan it forever.
    if (selection.lastScannedId !== state.lastExternalId) {
      await saveState(selection.lastScannedId);
      console.log(JSON.stringify({ status: selection.exhausted ? 'complete' : 'advanced_cached_window', cursor: selection.lastScannedId }, null, 2));
    } else console.log(JSON.stringify({ status: selection.exhausted ? 'complete' : 'no_uncached_candidates_in_window', cursor: state.lastExternalId }, null, 2));
    return;
  }
  const captured = [];
  let cursor = state.lastExternalId;
  let retryPending = '';
  let retryAttempts = 0;
  let deferredExternalId = '';
  let sourceChallenge = '';
  const navigationPacer = new NavigationPacer();
  const pool = await launchBrowserPool(browserExecutable(), Math.min(options.concurrency, selection.candidates.length), { headless: options.headless });
  try {
    for (let start = 0; start < selection.candidates.length; start += options.concurrency) {
      const wave = selection.candidates.slice(start, start + options.concurrency);
      const settled = await Promise.allSettled(wave.map((externalId, index) => captureProfile(pool.pages[index], externalId, navigationPacer)));
      const failedIndex = settled.findIndex((entry) => entry.status === 'rejected');
      const waveResults = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
      captured.push(...waveResults);
      // Keep the cursor immediately before a failed profile. Pages captured in
      // the same parallel wave still import now; the failed profile is retried
      // first on the next scheduled run instead of aborting the full batch.
      if (failedIndex >= 0) {
        retryPending = wave[failedIndex];
        if (settled[failedIndex].reason instanceof SourceChallengeError) {
          sourceChallenge = settled[failedIndex].reason.message;
          await saveState(cursor, { blockedReason: sourceChallenge });
          break;
        }
        retryAttempts = state.retryExternalId === retryPending ? state.retryAttempts + 1 : 1;
        if (failedIndex > 0) {
          cursor = wave[failedIndex - 1];
        }
        if (retryAttempts >= MAX_PROFILE_RETRY_ATTEMPTS) {
          deferredExternalId = retryPending;
          await recordDeferredFailure(retryPending, settled[failedIndex].reason);
          cursor = retryPending;
          retryPending = '';
          retryAttempts = 0;
          await saveState(cursor);
        } else await saveState(cursor, { retryExternalId: retryPending, retryAttempts });
        break;
      }
      cursor = wave.at(-1);
      await saveState(cursor);
    }
  } finally { await pool.close(); }
  const detectedHeadshotIds = captured.filter((entry) => entry.headshotDetected).map((entry) => entry.externalId);
  const pendingExternalIds = await enqueuePendingImportIds(detectedHeadshotIds);
  if (sourceChallenge) {
    console.log(JSON.stringify({ status: 'blocked_source_challenge', cursor, reason: sourceChallenge, queuedForImport: detectedHeadshotIds.length }, null, 2));
    return;
  }
  // Import only the durable queue of newly discovered player IDs.  This keeps
  // source capture continuous and avoids repeatedly upserting the full cache.
  const importResult = options.skipImport ? { importedIds: [], report: '' } : await importPendingHeadshots();
  const headshotsDetected = detectedHeadshotIds.length;
  const importSkipped = options.skipImport || importResult.importedIds.length === 0;
  console.log(JSON.stringify({
    status: retryPending ? 'captured_with_retry_pending' : 'captured', cursor, retryPending,
    retryAttempts, deferredExternalId,
    requested: selection.candidates.length, saved: captured.length,
    headshotsDetected, queuedForImport: detectedHeadshotIds.length, pendingImports: pendingExternalIds.length,
    importSkipped, importReport: importResult.report,
  }, null, 2));
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) run().catch((error) => { console.error(`NFL profile capture failed: ${String(error?.stack ?? error)}`); process.exitCode = 1; });

export { parseArgs, nextCandidates, captureProfile, browserExecutable, launchBrowserPool };
