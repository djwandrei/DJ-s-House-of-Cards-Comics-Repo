#!/usr/bin/env node

// Build the buyer-safe, six-season Scout Studio release projection.  The
// source package remains local/private; this command keeps only the bounded
// presentation maps used by the browser and rewrites provider-keyed maps to
// opaque player ids.  It is intentionally separate from the archive importer.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseReadinessArgs } from './audit-lineup-scout-readiness.mjs';
import { createScoutStudioSource } from './lib/scout-studio-source.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PRIVATE_KEY = /(?:provider|raw|archive|gzip|jsonpath|sourcepath|coefficient|offensiveRapm|defensiveRapm|combinedRapm|rapm|impact|scout)/i;
const TEAM_CODE = Object.freeze({
  'Atlanta Hawks': 'ATL', 'Boston Celtics': 'BOS', 'Brooklyn Nets': 'BKN', 'Charlotte Hornets': 'CHA',
  'Chicago Bulls': 'CHI', 'Cleveland Cavaliers': 'CLE', 'Dallas Mavericks': 'DAL', 'Denver Nuggets': 'DEN',
  'Detroit Pistons': 'DET', 'Golden State Warriors': 'GSW', 'Houston Rockets': 'HOU', 'Indiana Pacers': 'IND',
  'LA Clippers': 'LAC', 'Los Angeles Lakers': 'LAL', 'Memphis Grizzlies': 'MEM', 'Miami Heat': 'MIA',
  'Milwaukee Bucks': 'MIL', 'Minnesota Timberwolves': 'MIN', 'New Orleans Pelicans': 'NOP', 'New York Knicks': 'NYK',
  'Oklahoma City Thunder': 'OKC', 'Orlando Magic': 'ORL', 'Philadelphia 76ers': 'PHI', 'Phoenix Suns': 'PHX',
  'Portland Trail Blazers': 'POR', 'Sacramento Kings': 'SAC', 'San Antonio Spurs': 'SAS', 'Toronto Raptors': 'TOR',
  'Utah Jazz': 'UTA', 'Washington Wizards': 'WAS',
});

function parseArgs(argv) {
  const args = [...argv];
  const outputIndex = args.indexOf('--output');
  const output = outputIndex >= 0 ? path.resolve(args.splice(outputIndex, 2)[1] || '') : path.resolve('outputs/scout-studio-public-2020-26');
  const concurrencyIndex = args.indexOf('--concurrency');
  const concurrency = concurrencyIndex >= 0 ? Number(args.splice(concurrencyIndex, 2)[1]) : 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error('--concurrency must be an integer from 1 through 4.');
  if (!output || output.endsWith(path.sep)) throw new Error('--output requires a directory.');
  const readiness = parseReadinessArgs(args);
  if (readiness.seasons.join(',') !== '2020,2021,2022,2023,2024,2025') {
    throw new Error('The public Scout Studio builder requires the exact 2020-26 season window.');
  }
  return { ...readiness, output, concurrency };
}

function assertSafe(value, location = 'bundle') {
  if (Array.isArray(value)) { value.forEach((item, index) => assertSafe(item, `${location}[${index}]`)); return; }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && UUID.test(value)) throw new Error(`${location} contains a provider identifier.`);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (PRIVATE_KEY.test(key)) throw new Error(`${location}.${key} is outside the public Scout projection.`);
    assertSafe(nested, `${location}.${key}`);
  }
}

function compactCombinations(combinations) {
  // Chemistry needs every observed membership for exact lookup, but it only
  // needs the sample summary in the initial browser response.  Context lenses
  // remain available for players and teams; no raw combination context is
  // copied into a public release file.
  return Object.fromEntries(Object.entries(combinations).map(([key, value]) => [key, {
    kind: value.kind, minutes: value.minutes, sample: value.sample, note: value.note,
  }]));
}

function donorProfiles(bundle) {
  const profiles = [];
  for (const [playerId, rows] of Object.entries(bundle.seasonProfiles || {})) {
    const player = bundle.players.find(item => item.id === playerId);
    if (!player) continue;
    for (const row of rows) profiles.push({ ...row, player: player.name, playerId,
      key: `${playerId}|${row.seasonStartYear}|${row.phase}|${row.team}|${row.scope}` });
  }
  profiles.sort((a, b) => a.player.localeCompare(b.player) || (a.seasonStartYear || 0) - (b.seasonStartYear || 0)
    || String(a.phase).localeCompare(String(b.phase)) || String(a.team).localeCompare(String(b.team)));
  return profiles;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = createScoutStudioSource(options);
  const status = await source.status();
  if (status.phase !== 'ready' || status.source?.seasonStartYears?.join(',') !== options.seasons.join(',')) {
    throw new Error('The selected Scout package is not ready for the exact six-season public projection.');
  }
  await fs.rm(options.output, { recursive: true, force: true });
  await fs.mkdir(options.output, { recursive: true });
  const manifest = { contractVersion: 1, generatedAt: new Date().toISOString(), snapshot: status.snapshot,
    source: status.source, modelEvidence: status.modelEvidence, teams: status.teams.map((team, index) => ({
      ...team, code: TEAM_CODE[team.name] || team.name.slice(0, 3).toUpperCase(), file: `team-${String(index).padStart(2, '0')}.json`,
    })) };
  assertSafe(manifest);
  await fs.writeFile(path.join(options.output, 'index.json'), `${JSON.stringify(manifest)}\n`, 'utf8');
  let cursor = 0;
  async function worker(workerId) {
    // Each worker owns a source cache so the adapter's one-team invariant is
    // preserved while independent shards are read in parallel.
    const workerSource = workerId === 0 ? source : createScoutStudioSource(options);
    while (true) {
      const index = cursor++;
      if (index >= status.teams.length) return;
      const team = status.teams[index];
      process.stdout.write(`Reading ${team.name} (${index + 1}/${status.teams.length})…\n`);
      const bundle = await workerSource.bundle(team.id, status.snapshot);
      const publicBundle = { contractVersion: 1, snapshot: bundle.snapshot, team: bundle.team,
        players: bundle.players, teamContexts: bundle.teamContexts, onOff: bundle.onOff,
        combinations: compactCombinations(bundle.combinations), wowy: bundle.wowy,
        seasonProfiles: bundle.seasonProfiles, seasonDonors: donorProfiles(bundle) };
      assertSafe(publicBundle, team.name);
      await fs.writeFile(path.join(options.output, manifest.teams[index].file), `${JSON.stringify(publicBundle)}\n`, 'utf8');
      const bytes = (await fs.stat(path.join(options.output, manifest.teams[index].file))).size;
      process.stdout.write(`Wrote ${manifest.teams[index].file} (${bytes} bytes)\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, status.teams.length) }, (_, index) => worker(index)));
  process.stdout.write(`Scout Studio public projection ready: ${options.output}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
