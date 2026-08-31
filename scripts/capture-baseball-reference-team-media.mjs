#!/usr/bin/env node

/**
 * Resumable authorized-session helper for Baseball Reference roster pages.
 * Each team-season page contains the provider's headshot URLs for its roster,
 * allowing 2010+ player media to be captured with far fewer requests than
 * visiting every player page. It does not spoof headers, bypass challenges, or
 * continue after a blocked response.
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SOURCES,
  executeSql,
  extractTeamPageHeadshots,
  teamCacheFile,
} from './import-sports-reference-media.mjs';
import {
  crawlDelayForUserAgent,
  isPathAllowedByRobots,
  parseRobotsTxt,
} from './update-nba-basketball-reference-weekly.mjs';

const ROOT = process.cwd();
const SOURCE = SOURCES.mlb;
const USER_AGENT = process.env.SPORTS_REFERENCE_USER_AGENT?.trim()
  || 'DJHC-Sports-Analytics/1.0 (+https://www.djshouseofcards-comics.com/contact.html)';
const DEFAULT_DELAY_MS = 4000;
const CACHE_ROOT = path.join(ROOT, 'outputs', 'sports-reference-media-cache');
const CHECKPOINT = path.join(CACHE_ROOT, 'mlb', 'team-pages-checkpoint-2010-2026.json');

function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const [name, inline] = token.slice(2).split(/=(.*)/s, 2);
    if (inline !== undefined) values.set(name, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) values.set(name, argv[++i]);
    else flags.add(name);
  }
  const integer = (value, name, fallback) => {
    const parsed = Number.parseInt(String(value ?? fallback), 10);
    if (!Number.isInteger(parsed) || parsed < 1950 || parsed > 2200) throw new Error(`${name} must be a valid season year.`);
    return parsed;
  };
  const start = integer(values.get('season-start'), '--season-start', 2010);
  const end = integer(values.get('season-end'), '--season-end', 2026);
  const delay = Number.parseInt(String(values.get('request-delay-ms') ?? DEFAULT_DELAY_MS), 10);
  if (!Number.isInteger(delay) || delay < 3000 || delay > 120000) throw new Error('--request-delay-ms must be 3000-120000.');
  return { start, end, delay, newRun: flags.has('new-run'), help: flags.has('help') };
}

function ensureDirectory(directory) { fs.mkdirSync(directory, { recursive: true }); return directory; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, value) { ensureDirectory(path.dirname(file)); const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, file); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log('Use --season-start/--season-end and --request-delay-ms; output is resumable under outputs/sports-reference-media-cache.'); return; }
  const rows = await executeSql(`select id, season_year, team_code, team_name from public.mlb_team_seasons where season_year between ${options.start} and ${options.end} order by season_year, team_code;`, 'mlb-team-media-teams');
  const prior = options.newRun ? null : readJson(CHECKPOINT);
  const checkpoint = prior?.start === options.start && prior?.end === options.end
    ? prior
    : { version: 1, sport: 'mlb', start: options.start, end: options.end, status: 'running', completed: {}, blocked: {}, createdAt: new Date().toISOString() };
  const robotsResponse = await fetch(`${SOURCE.baseUrl}/robots.txt`, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' } });
  if (!robotsResponse.ok) throw new Error(`Baseball Reference robots.txt returned HTTP ${robotsResponse.status}.`);
  const robots = parseRobotsTxt(await robotsResponse.text());
  const effectiveDelay = Math.max(options.delay, Math.ceil((crawlDelayForUserAgent(robots, USER_AGENT) ?? 3) * 1000));
  let lastRequestAt = 0;
  for (const team of rows) {
    const key = `${team.season_year}:${team.team_code}`;
    if (checkpoint.completed[key]) continue;
    const url = SOURCE.teamPageUrl(team.team_code, team.season_year);
    const pathname = new URL(url).pathname;
    if (!isPathAllowedByRobots(pathname, robots, USER_AGENT)) {
      checkpoint.blocked[key] = { reason: 'robots_path_disallowed', url };
      checkpoint.status = 'blocked'; writeJson(CHECKPOINT, checkpoint); break;
    }
    const wait = effectiveDelay - (Date.now() - lastRequestAt);
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' } });
    const html = await response.text();
    if (!response.ok || /performing security verification|verify you are not a bot|cf-chl/i.test(html)) {
      checkpoint.blocked[key] = { reason: 'source_blocked', status: response.status, url };
      checkpoint.status = 'blocked'; writeJson(CHECKPOINT, checkpoint); break;
    }
    const cacheFile = teamCacheFile(SOURCE, team.team_code, team.season_year);
    ensureDirectory(path.dirname(cacheFile));
    fs.writeFileSync(`${cacheFile}.${process.pid}.tmp`, html, 'utf8');
    fs.renameSync(`${cacheFile}.${process.pid}.tmp`, cacheFile);
    checkpoint.completed[key] = { completedAt: new Date().toISOString(), bytes: Buffer.byteLength(html), headshots: extractTeamPageHeadshots(html, SOURCE, url).size };
    checkpoint.status = 'running'; writeJson(CHECKPOINT, checkpoint);
    console.log(JSON.stringify({ seasonYear: team.season_year, teamCode: team.team_code, headshots: checkpoint.completed[key].headshots }));
  }
  if (Object.keys(checkpoint.blocked).length === 0 && Object.keys(checkpoint.completed).length >= rows.length) checkpoint.status = 'completed';
  writeJson(CHECKPOINT, checkpoint);
  console.log(JSON.stringify({ status: checkpoint.status, completed: Object.keys(checkpoint.completed).length, teams: rows.length, checkpoint: CHECKPOINT }, null, 2));
}

const invokedModuleUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedModuleUrl) run().catch((error) => { console.error(`Baseball team media capture failed: ${String(error?.stack ?? error)}`); process.exitCode = 1; });

export { parseArgs, run };

