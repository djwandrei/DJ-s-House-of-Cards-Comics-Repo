import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { BOX_FIELDS, readOfficialBox, inspectSummaryCompleteness } from '../lib/nba-summary-completeness.mjs';
import { summarySourceOptions, refreshScoutSummaries } from '../refresh-scout-model-summaries.mjs';
import { weeklyArchiveIsComplete } from '../download-nba-sportradar-weekly.mjs';

const id = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  return {
    source: { accessLevel: 'trial' },
    game: { providerGameId: id(1), seasonStartYear: 2025, primaryPhase: 'regular', status: 'closed',
      homeProviderTeamId: id(2), awayProviderTeamId: id(3), homePoints: 0, awayPoints: 0 },
    teams: [2, 3].map(n => ({ id: id(n), srId: `sr:team:${n}` })),
    players: [2, 3].map(n => ({ id: id(n + 2), providerTeamId: id(n), minutesPlayed: 24,
      officialBoxScore: { source: 'summary_endpoint', availableFields: [...BOX_FIELDS],
        fields: Object.fromEntries(BOX_FIELDS.map(field => [field, 0])) } })),
  };
}

test('real zero counts are complete, but presence never certifies reconciliation', () => {
  const result = inspectSummaryCompleteness(fixture());
  assert.equal(result.complete, true);
  assert.equal(result.reconciled, false);
  assert.equal(result.requiredPlayers, 2);
});

test('legacy, partial, invalid, and non-official counts cannot pass the resume guard', () => {
  for (const mutate of [
    row => { delete row.officialBoxScore; },
    row => { row.officialBoxScore.availableFields = BOX_FIELDS.filter(field => field !== 'steals'); },
    row => { row.officialBoxScore.fields.steals = -1; },
    row => { row.officialBoxScore.invalidFields = ['steals']; },
    row => { row.officialBoxScore.source = 'pbp'; },
    row => { row.officialBoxScore.fields.steals = '0'; },
    row => { row.minutesPlayed = null; },
  ]) {
    const record = fixture();
    // Preserve independent membership when Summary minutes are absent.
    record.lineups = [{ providerTeamId: id(2), playerIds: [id(4)] }];
    mutate(record.players[0]);
    assert.equal(inspectSummaryCompleteness(record).complete, false);
    assert.equal(weeklyArchiveIsComplete(record, id(1), 'trial'), false);
  }
  assert.equal(readOfficialBox({}).steals, null);
});

test('an overlay cannot drop a playing player, move teams, or hide duplicate rows', () => {
  const record = fixture();
  assert.equal(inspectSummaryCompleteness(record, { players: record.players.slice(1) }).complete, false);
  const overlay = structuredClone(record); overlay.players[0].providerTeamId = id(3);
  assert.equal(inspectSummaryCompleteness(record, overlay).complete, false);
  record.players.push(structuredClone(record.players[0]));
  assert.equal(inspectSummaryCompleteness(record).complete, false);
  assert.equal(inspectSummaryCompleteness({ players: [] }).complete, false);
});

test('DNP rows need not invent box scores, and resume remains game/access bound', () => {
  const record = fixture(); record.players.push({ id: id(6), providerTeamId: id(2), minutesPlayed: 0 });
  assert.equal(inspectSummaryCompleteness(record).complete, true);
  assert.equal(weeklyArchiveIsComplete(record, id(1), 'trial'), true);
  assert.equal(weeklyArchiveIsComplete(record, id(7), 'trial'), false);
  assert.equal(weeklyArchiveIsComplete(record, id(1), 'production'), false);
  record.lineups = [{ providerTeamId: id(2), playerIds: [id(4)] }];
  record.players[0].minutesPlayed = 0;
  assert.equal(inspectSummaryCompleteness(record).complete, true, 'Reported zero minutes are present, not missing.');
});

test('source-only refresh requires private, explicit, non-overlapping artifact paths', () => {
  const args = ['--source-only', 'true', '--archive-dir', 'outputs/test-archive', '--source-validation', 'outputs/test-source.json',
    '--seasons', '2020,2021', '--summary-overlay', 'outputs/test-overlay'];
  assert.deepEqual(summarySourceOptions(args).seasons, [2020, 2021]);
  assert.throws(() => summarySourceOptions([...args.slice(0, -1), 'lineup-lab']), /private/);
  assert.throws(() => summarySourceOptions([...args.slice(0, -1), 'outputs/test-archive/overlay']), /separate/);
  assert.throws(() => summarySourceOptions([...args, '--seasons', '2025']), /Invalid/);
});

async function refreshFixture(t) {
  const root = await fs.mkdtemp(path.resolve('outputs/test-summary-refresh-'));
  const archive = path.join(root, 'archive'), overlay = path.join(root, 'overlay');
  await fs.mkdir(path.join(archive, '2025/games'), { recursive: true });
  const record = fixture(); delete record.players[0].officialBoxScore;
  const bytes = gzipSync(JSON.stringify(record));
  const gameFile = path.join(archive, `2025/games/${id(1)}.json.gz`);
  await fs.writeFile(gameFile, bytes);
  const report = path.join(root, 'source.json');
  await fs.writeFile(report, JSON.stringify({ passed: true, errors: [], seasons: [{ seasonStartYear: 2025,
    files: { records: [{ gameId: id(1), relativePath: `games/${id(1)}.json.gz`, gzipSha256: hash(bytes) }] } }] }));
  const previousKey = process.env.SPORTRADAR_NBA_API_KEY, previousKey2 = process.env.SPORTRADAR_NBA_API_KEY_2;
  process.env.SPORTRADAR_NBA_API_KEY = 'test-only-no-network'; delete process.env.SPORTRADAR_NBA_API_KEY_2;
  t.after(async () => {
    for (const [name, value] of [['SPORTRADAR_NBA_API_KEY', previousKey], ['SPORTRADAR_NBA_API_KEY_2', previousKey2]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    // Only remove the unique fixture directory created by this test.
    assert.ok(root.startsWith(`${path.resolve('outputs')}${path.sep}test-summary-refresh-`));
    await fs.rm(root, { recursive: true });
  });
  const args = ['--source-only', 'true', '--archive-dir', archive, '--source-validation', report,
    '--summary-overlay', overlay, '--seasons', '2025'];
  const payload = { id: id(1), status: 'closed', home: { id: id(2), points: 0, players: [] }, away: { id: id(3), points: 0, players: [] } };
  const aliases = ['points', 'field_goals_att', 'field_goals_made', 'two_points_att', 'two_points_made', 'three_points_att', 'three_points_made',
    'free_throws_att', 'free_throws_made', 'offensive_rebounds', 'defensive_rebounds', 'rebounds', 'assists', 'steals', 'blocks', 'turnovers', 'personal_fouls'];
  for (const [side, playerId] of [['home', id(4)], ['away', id(5)]]) payload[side].players.push({ id: playerId,
    statistics: { minutes: '24:00', ...Object.fromEntries(aliases.map(field => [field, 0])) } });
  return { args, overlay, bytes, gameFile, payload };
}

test('full source pass repairs legacy data, resumes complete overlays, and never changes PBP', async t => {
  const f = await refreshFixture(t); let requests = 0;
  const fetchJson = async () => { requests++; return { payload: f.payload }; };
  const first = await refreshScoutSummaries(f.args, { fetchJson });
  assert.equal(first.complete, true); assert.equal(requests, 1);
  const second = await refreshScoutSummaries(f.args, { fetchJson });
  assert.equal(second.complete, true); assert.equal(second.reused, 1); assert.equal(requests, 1);
  assert.deepEqual(await fs.readFile(f.gameFile), f.bytes);
});

test('a partial response is retained but not completed, and is re-fetched on resume', async t => {
  const f = await refreshFixture(t), partial = structuredClone(f.payload);
  partial.home.players[0].statistics.steals = -1;
  const first = await refreshScoutSummaries(f.args, { fetchJson: async () => ({ payload: partial }) });
  assert.equal(first.complete, false); assert.equal(first.incompleteGames, 1);
  const progress = JSON.parse(await fs.readFile(path.join(f.overlay, 'progress.json')));
  assert.equal(progress.status, 'blocked_incomplete_summaries');
  const second = await refreshScoutSummaries(f.args, { fetchJson: async () => ({ payload: f.payload }) });
  assert.equal(second.complete, true); assert.equal(second.downloaded, 1); assert.equal(second.reused, 0);
  assert.ok((await fs.readdir(path.join(f.overlay, '2025'))).some(name => name.includes('.incomplete-')));
});

test('source hash mismatch stops before network; provider quota stops without retry or key switching', async t => {
  const f = await refreshFixture(t); let requests = 0;
  const fetchJson = async () => { requests++; throw Object.assign(new Error('test quota'), { status: 429, providerLimit: 'quota_exceeded' }); };
  await assert.rejects(refreshScoutSummaries(f.args, { fetchJson }), /test quota/);
  assert.equal(requests, 1);
  await fs.writeFile(f.gameFile, gzipSync('{}'));
  await assert.rejects(refreshScoutSummaries(f.args, { fetchJson }), /Source game changed/);
  assert.equal(requests, 1);
});
