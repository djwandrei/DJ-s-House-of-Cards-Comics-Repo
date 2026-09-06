import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { describeScoutPlayer, describeScoutSample, describeScoutCombination, describeScoutWowy } from '../lib/scout-studio.mjs';
import { createScoutStudioSource } from '../lib/scout-studio-source.mjs';
import { createScoutStudioServer, parseStudioArgs } from '../preview-scout-studio.mjs';
import { compareBlueprints, formatStudioValue, toggleStudioPlayer, validRoster } from '../../tools/scout-studio/studio-model.js';
import { rawPlayer, rawSample, fixtureSource, readinessFixture, digest, snapshot } from './fixtures/scout-studio-fixture.mjs';
import { createDirectPlayerEventLine, playerProfileFromEvents } from '../derive-local-scout-analytics.mjs';

const metric = (player, key) => player.metrics.find(item => item.key === key);
test('Player Blueprint uses current package totals and shows its pooled grain', () => {
  const row = describeScoutPlayer(rawPlayer(), 'p0');
  assert.equal(metric(row, 'threePointAccuracy').value, 0.4);
  assert.equal(metric(row, 'assists').value, 8.3333);
  assert.match(row.coverage.note, /pooled/);
  assert.equal(row.tendencies.unlocatedTwoPointAttempts, 60);
  assert.equal(row.tendencies.zones[0].shareOfAllAttempts, 0.25);
  assert.equal(row.tendencies.missingShotDescriptions, 220);
  assert.equal(row.tendencies.labels[0].label, 'pull up');
});

test('adapter accepts profiles from the current derivation function, not a v10 imitation', () => {
  const events = createDirectPlayerEventLine();
  Object.assign(events, { recognizedStatisticRows: 5, structuredStatisticRows: 5,
    fieldGoalAttempts: 2, fieldGoalsMade: 1, threePointAttempts: 2, threePointersMade: 1 });
  const row = playerProfileFromEvents({ teamId: 'team', team: 'Team', playerId: 'id', player: 'Player', events,
    onOff: { onMinutes: 20, on: { all: { totalPossessions: 100, games: 1 } } }, starterGames: 1, closerGames: 0 });
  const result = describeScoutPlayer(row, 'p0');
  assert.equal(metric(result, 'threePointAccuracy').value, 0.5);
  assert.equal(result.estimatedTeamPossessions, 50);
  assert.equal(result.coverage.independentBoxScore, 'not_fully_reconciled');
});

for (const value of [null, undefined, '', false, NaN, Infinity, -1]) {
  test(`invalid numerator is unavailable, not coerced: ${String(value)}`, () => {
    const row = rawPlayer(); row.boxScore.assists = value;
    assert.equal(metric(describeScoutPlayer(row, 'p0'), 'assists').value, null);
  });
}

test('zero attempts and missing coverage do not become zero-percent shooting', () => {
  const row = rawPlayer(); row.boxScore.threePointAttempts = 0;
  assert.equal(metric(describeScoutPlayer(row, 'p0'), 'threePointAccuracy').value, null);
  row.boxScore.threePointAttempts = 150; row.coverage.unknownFieldGoalMadeStatus = 1;
  assert.equal(metric(describeScoutPlayer(row, 'p0'), 'threePointAccuracy').value, null);
  row.coverage.reboundsComplete = false;
  assert.equal(metric(describeScoutPlayer(row, 'p0'), 'rebounds').value, null);
  row.coverage.scoringComplete = false;
  assert.equal(metric(describeScoutPlayer(row, 'p0'), 'points').value, null);
});

test('zero is preserved when the denominator and source are valid', () => {
  const row = rawPlayer(); row.boxScore.assists = 0;
  assert.equal(metric(describeScoutPlayer(row, 'p0'), 'assists').value, 0);
  row.teamPossessionsWhileOnCourt = null;
  assert.equal(metric(describeScoutPlayer(row, 'p0'), 'assists').value, null);
});

test('unknown zone outcomes and absent optional descriptions stay explicit', () => {
  const row = rawPlayer(); row.shooting.shotZones.atRim.unknownMadeStatus = 1;
  delete row.shooting.providerShotDescriptionProfile;
  const result = describeScoutPlayer(row, 'p0');
  assert.equal(result.tendencies.zones[0].accuracy, null);
  assert.equal(result.tendencies.zones[0].attempts, 100);
  assert.deepEqual(result.tendencies.labels, []);
});

test('presentation projection never forwards private model fields or IDs', () => {
  const result = describeScoutPlayer(rawPlayer(), 'p0');
  assert.doesNotMatch(JSON.stringify(result), /DO-NOT-EXPOSE|private-player|private-team|"rapm"|"coefficient"|"archivePath"/);
  const sample = describeScoutSample(rawSample());
  assert.doesNotMatch(JSON.stringify(sample), /DO-NOT-EXPOSE|"rapm"|"archivePath"/);
});

test('chemistry requires publishable samples with both possession sides', () => {
  assert.equal(describeScoutSample(rawSample(6, false)).netRating, null);
  assert.equal(describeScoutSample({ ...rawSample(), offensivePossessions: 0 }).netRating, null);
  assert.equal(describeScoutSample(null).status, 'unavailable');
  assert.deepEqual(describeScoutSample(rawSample()).interval, { lower: -2, upper: 14 });
  const invalid = rawSample(); invalid.confidence95.netRating.lower = 20;
  assert.equal(describeScoutSample(invalid).interval, null);
});

test('exact-five and co-presence semantics never collapse together', () => {
  assert.equal(describeScoutCombination({ size: 5 }).kind, 'exact_five');
  assert.equal(describeScoutCombination({ size: 3 }).kind, 'shared_floor');
  assert.match(describeScoutCombination({ size: 2 }).note, /not an isolated unit/);
});

test('WOWY preserves all four cells without inventing missing partitions', () => {
  const cells = describeScoutWowy({ cells: { a_on_b_on: { all: rawSample() } } });
  assert.equal(cells.length, 4);
  assert.equal(cells[0].netRating, 6);
  assert.equal(cells[1].netRating, null);
  assert.equal(cells[3].status, 'unavailable');
});

test('comparison uses a matching unit and does not rank or fill missing metrics', () => {
  const a = describeScoutPlayer(rawPlayer(), 'p0'), b = describeScoutPlayer(rawPlayer('b', 1), 'p1');
  assert.ok(compareBlueprints(a, b)[0].difference > 0);
  b.metrics[0].value = null; b.metrics[0].status = 'unavailable';
  assert.equal(compareBlueprints(a, b)[0].difference, null);
  assert.deepEqual(compareBlueprints(a, a), []);
  assert.equal(formatStudioValue(null), 'Unavailable');
  assert.equal(formatStudioValue(0, 'percent'), '0.0%');
});

test('selection enforces five unique players and supports removal', () => {
  const selected = ['p0', 'p1', 'p2', 'p3', 'p4'];
  assert.equal(toggleStudioPlayer(selected, 'p5'), selected);
  assert.deepEqual(toggleStudioPlayer(selected, 'p0'), ['p1', 'p2', 'p3', 'p4']);
});

test('roster rejects stale package/team identities and duplicate players', async () => {
  const result = await fixtureSource().roster('t0');
  assert.equal(validRoster(result, snapshot, 't0'), true);
  assert.equal(validRoster(result, 'stale', 't0'), false);
  assert.equal(validRoster(result, snapshot, 't1'), false);
  result.players.push(result.players[0]);
  assert.equal(validRoster(result, snapshot, 't0'), false);
});

test('local server permits only bounded read-only routes, not archives or cross-origin access', async t => {
  const source = fixtureSource(); const server = createScoutStudioServer(source);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/api/scout-studio/status`)).status, 200);
  assert.equal((await fetch(`${base}/tools/scout-studio/`)).status, 200);
  for (const url of ['/outputs/private.json', '/.env', '/scripts/lib/scout-studio.mjs', '/%2e%2e/.env']) {
    assert.equal((await fetch(base + url)).status, 404);
  }
  assert.equal((await fetch(`${base}/api/scout-studio/status`, { headers: { Origin: 'https://evil.invalid' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/scout-studio/status`, { headers: { Host: 'evil.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(`${base}/api/scout-studio/status`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/scout-studio/chemistry?team=t0&snapshot=${snapshot}&players=p0,p0`)).status, 400);
  assert.equal((await fetch(`${base}/api/scout-studio/roster?team=t0&snapshot=${snapshot}`)).status, 200);
  source.roster = async () => { throw new Error('DO-NOT-EXPOSE /private/path'); };
  const failure = await fetch(`${base}/api/scout-studio/roster?team=t0&snapshot=${snapshot}`);
  assert.equal(failure.status, 503); assert.doesNotMatch(await failure.text(), /DO-NOT-EXPOSE|private\/path/);
});

test('preview CLI is exact-scope and never accepts an older season window', () => {
  const args = ['--manifest', 'a.json', '--package-validation', 'b.json', '--source-validation', 'c.json', '--seasons', '2022,2023,2024,2025'];
  assert.equal(parseStudioArgs(args).port, 4187);
  assert.throws(() => parseStudioArgs([...args, '--port', '0']), /Port/);
  assert.throws(() => parseStudioArgs([...args.slice(0, -1), '2024,2025']), /incoming/);
});

test('missing current manifest stays pending, even if an older package exists nearby', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-studio-pending-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'older-package.json'), JSON.stringify({ status: 'ready' }));
  const source = createScoutStudioSource({ manifest: path.join(root, 'incoming.json'), packageValidation: path.join(root, 'validation.json'),
    sourceValidation: path.join(root, 'source.json'), seasons: [2022, 2023, 2024, 2025] });
  const result = await source.status();
  assert.equal(result.phase, 'pending'); assert.deepEqual(result.teams, []);
  await assert.rejects(source.roster('t0', snapshot), /Refresh/);
});

test('streamed source binds the exact package, strips IDs, reconciles rows and rejects mutation', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'scout-studio-source-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fixture = readinessFixture();
  const rows = [rawPlayer('private-player-a'), rawPlayer('private-player-b', 1)];
  const shard = { schemaVersion: 4, metricsVersion: 'nba-scout-metrics-v4', seasonStartYear: 2022, seasonEndYear: 2026,
    seasonStartYears: [2022, 2023, 2024, 2025], latestSeasonStartYear: 2025,
    team: { teamId: 'private-team-a', team: 'Test Franchise 00' },
    lineupsAndCombinations: [{ teamId: 'private-team-a', size: 2, playerIds: rows.map(row => row.playerId), minutes: 200, contexts: { all: rawSample() } }],
    playerOnOff: [], playerProfiles: rows, wowy: [{ teamId: 'private-team-a', playerAId: rows[1].playerId,
      playerBId: rows[0].playerId, cells: { a_on_b_off: { all: rawSample() } } }] };
  const raw = JSON.stringify(shard);
  fixture.manifest.dataShards = Array.from({ length: 30 }, (_, i) => ({ teamId: `private-team-${i}`, team: `Test Franchise ${String(i).padStart(2, '0')}`,
    jsonPath: `team-${i}.json`, jsonBytes: Buffer.byteLength(raw), jsonSha256: digest(raw),
    rows: { team: 1, lineupsAndCombinations: 1, playerProfiles: 2, playerOnOff: 0, wowy: 1 } }));
  fixture.manifest.dataShards[0].teamId = 'private-team-a';
  const manifestRaw = JSON.stringify(fixture.manifest);
  const options = { manifest: path.join(root, 'manifest.json'), packageValidation: path.join(root, 'validation.json'),
    sourceValidation: path.join(root, 'source.json'), seasons: [2022, 2023, 2024, 2025] };
  await fs.writeFile(options.manifest, manifestRaw);
  await fs.writeFile(options.sourceValidation, JSON.stringify(fixture.source));
  await fs.writeFile(options.packageValidation, JSON.stringify({ schemaVersion: 3, passed: true, errors: [], warnings: [],
    inputSha256: digest(manifestRaw), checks: { teams: 30, playerProfiles: 2 } }));
  await fs.writeFile(path.join(root, 'team-0.json'), raw);
  const source = createScoutStudioSource(options);
  const status = await source.status(); assert.equal(status.phase, 'ready', JSON.stringify(status.issues));
  const roster = await source.roster('t0', status.snapshot);
  assert.equal(roster.players.length, 2);
  assert.doesNotMatch(JSON.stringify(roster), /private-player|private-team|DO-NOT-EXPOSE/);
  const chemistry = await source.chemistry('t0', status.snapshot, ['p0', 'p1']);
  assert.equal(chemistry.combination.sample.netRating, 6);
  assert.equal(chemistry.wowy[1].label, 'Test Player 2 only');
  await assert.rejects(source.chemistry('t0', status.snapshot, ['p0', 'p9']), /this team/);
  await assert.rejects(source.roster('t0', 'stale'), /Refresh/);
  await fs.writeFile(path.join(root, 'team-0.json'), raw.replace('Test Player 1', 'Test Player X'));
  await assert.rejects(source.roster('t0', status.snapshot), /changed/);
  await assert.rejects(createScoutStudioSource(options).roster('t0', status.snapshot), /digest/);
  await fs.writeFile(options.manifest, `${manifestRaw} `);
  assert.equal((await source.status()).phase, 'blocked');
});
