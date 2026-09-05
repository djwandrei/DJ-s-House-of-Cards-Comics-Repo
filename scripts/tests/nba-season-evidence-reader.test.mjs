import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createSupabaseNbaTeamDataset } from '../../prototypes/basketball-lineup-optimizer/supabase-nba-data.js';
import { loadOptimizerCore } from '../../prototypes/basketball-lineup-optimizer/tests/load-optimizer-core.mjs';

const { optimizeLineups } = await loadOptimizerCore();
const uuid = index => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const scope = { seasonEndYear: 2026, seasonPhase: 'regular' };
const stats = {
  games_played: 10, games_started: 5, minutes_played: 240,
  field_goals_made: 50, field_goals_attempted: 100,
  three_point_field_goals_made: 10, three_point_field_goals_attempted: 30,
  free_throws_made: 20, free_throws_attempted: 25,
  offensive_rebounds: 10, defensive_rebounds: 30, total_rebounds: 40,
  assists: 30, steals: 10, blocks: 5, turnovers: 15, personal_fouls: 20, points: 130,
};
const stint = (id, player = 1, overrides = {}) => ({
  id, player_id: uuid(player), season_end_year: 2026, season_phase: 'regular',
  team_code: 'MIN', is_multi_team_aggregate: false, ...stats, ...overrides,
});

// Execute the real shared browser boundary, not a reimplementation of its
// aggregation. A query-only mock makes an accidental mutation fail immediately.
export function loadSeasonReader(rows, { pageSize = 100, response } = {}) {
  const queries = [], clients = [];
  const client = { from(table) {
    const record = { table, columns: '', filters: [] }; queries.push(record);
    const query = { select(columns) { record.columns = columns; return query; } };
    for (const method of ['eq', 'in', 'gt', 'order', 'limit']) {
      query[method] = (...args) => { record.filters.push([method, ...args]); return query; };
    }
    query.then = (resolve, reject) => Promise.resolve().then(async () => {
      if (response) return response(record, queries.length);
      let data = rows.filter(row => record.filters.every(([method, key, value]) =>
        method === 'eq' ? row[key] === value : method === 'in' ? value.includes(row[key]) :
          method === 'gt' ? row[key] > value : true));
      data.sort((a, b) => a.id - b.id);
      data = data.slice(0, Math.min(pageSize, record.filters.find(f => f[0] === 'limit')[1]));
      return { data, error: null };
    }).then(resolve, reject);
    return query;
  } };
  const window = {
    DJ: {}, DJ_BACKEND_CONFIG: { enabled: true, provider: 'supabase',
      supabaseUrl: 'https://commerce-fixture.supabase.co', supabasePublishableKey: 'public-commerce-fixture',
      analyticsSupabaseUrl: 'https://nba-fixture.supabase.co', analyticsSupabasePublishableKey: 'public-nba-fixture' },
    supabase: { createClient(url, key, options) {
      clients.push({ url, key, options });
      assert.equal(url, 'https://nba-fixture.supabase.co', 'season reads must never use commerce');
      return client;
    } },
    location: { origin: 'https://site.test', href: 'https://site.test/lineup-lab/' },
    addEventListener() {}, setTimeout, clearTimeout,
  };
  const document = { scripts: [], visibilityState: 'visible', addEventListener() {},
    querySelector() { return null; }, createElement() { return { dataset: {}, addEventListener() {} }; },
    head: { appendChild() {} } };
  vm.runInNewContext(fs.readFileSync(new URL('../../supabase-client.js', import.meta.url), 'utf8'),
    { window, document, console, URL, setTimeout, clearTimeout });
  return { reader: window.DJ.remoteCatalog.listNbaPlayerSeasonEvidence, queries, clients };
}

test('sums real team rows once, ignores provider aggregates, and selects only public counts', async () => {
  const { reader, queries, clients } = loadSeasonReader([
    stint(1), stint(2, 1, { team_code: 'CHI', games_played: 20, points: 260 }),
    stint(3, 1, { team_code: 'TOT', is_multi_team_aggregate: true, points: 390 }),
  ]);
  const result = await reader({ ...scope, playerIds: [uuid(1)] });
  assert.equal(result.length, 1);
  assert.equal(result[0].games_played, 30);
  assert.equal(result[0].minutes_played, 480);
  assert.equal(result[0].points, 390);
  assert.equal(result[0].team_stint_count, 2);
  assert.equal(result[0].evidence_contract, 'imported-team-totals-v1');
  assert.equal(clients[0].options.auth.persistSession, false);
  assert.ok(queries.every(q => q.table === 'nba_player_team_season_stats'));
  assert.doesNotMatch(queries[0].columns, /source_|advanced|scout|rapm|media|\*/i);
  assert.deepEqual(Array.from(queries[0].filters.find(f => f[0] === 'eq' && f[1] === 'season_phase')), ['eq', 'season_phase', 'regular']);
});

test('all UUID batches and server-limited cursor pages are consumed without a player cap', async () => {
  const rows = Array.from({ length: 125 }, (_, i) => stint(i + 1, i + 1));
  const { reader, queries } = loadSeasonReader(rows, { pageSize: 7 });
  const result = await reader({ ...scope, playerIds: rows.map(row => row.player_id).reverse() });
  assert.equal(result.length, 125);
  assert.ok(queries.every(q => q.filters.find(f => f[0] === 'in')[2].length <= 50));
  assert.equal(new Set(result.map(row => row.player_id)).size, 125);
  assert.ok(queries.some(q => q.filters.some(f => f[0] === 'gt' && f[2] > 0)));
});

test('canonical IDs share cached and in-flight reads; force refreshes and failures retry', async () => {
  const { reader, queries } = loadSeasonReader([stint(1), stint(2, 2)]);
  await Promise.all([
    reader({ ...scope, playerIds: [uuid(2), uuid(1), uuid(1)] }),
    reader({ ...scope, playerIds: [uuid(1), uuid(2)] }),
  ]);
  assert.equal(queries.length, 2, 'one data page and one terminal page shared in-flight');
  await reader({ ...scope, playerIds: [uuid(1), uuid(2)] });
  assert.equal(queries.length, 2);
  await reader({ ...scope, playerIds: [uuid(2), uuid(1)], force: true });
  assert.equal(queries.length, 4);
  const failing = loadSeasonReader([], { response: (_record, call) => call === 1
    ? { error: { message: 'Temporary read failure' }, data: null } : { data: [], error: null } });
  await assert.rejects(failing.reader({ ...scope, playerIds: [uuid(1)] }));
  assert.equal((await failing.reader({ ...scope, playerIds: [uuid(1)] })).length, 0);
  assert.equal(failing.queries.length, 2);
});

test('invalid inputs fail before connecting; empty IDs do not query', async () => {
  const { reader, queries, clients } = loadSeasonReader([]);
  for (const options of [{ playerIds: ['not-an-id'] }, { seasonPhase: '' }, { seasonEndYear: 1 }, { playerIds: null }]) {
    await assert.rejects(reader({ ...scope, playerIds: [uuid(1)], ...options }));
  }
  assert.equal((await reader({ ...scope, playerIds: [] })).length, 0);
  assert.equal(queries.length, 0); assert.equal(clients.length, 0);
});

for (const patch of [
  { player_id: uuid(99) }, { season_end_year: 2025 }, { season_phase: 'playoffs' },
  { is_multi_team_aggregate: true }, { team_code: 'TOT' }, { id: 0 },
]) test(`mismatched source row fails closed: ${JSON.stringify(patch)}`, async () => {
  const { reader } = loadSeasonReader([], { response: () => ({ data: [stint(1, 1, patch)], error: null }) });
  await assert.rejects(reader({ ...scope, playerIds: [uuid(1)] }), /mismatched/);
});

test('duplicate row identity, duplicate team, and stuck cursor are rejected', async () => {
  for (const rows of [[stint(1), stint(1)], [stint(1), stint(2)]]) {
    const { reader } = loadSeasonReader([], { response: () => ({ data: rows, error: null }) });
    await assert.rejects(reader({ ...scope, playerIds: [uuid(1)] }), /duplicate/i);
  }
  const { reader } = loadSeasonReader([], { response: () => ({ data: [stint(1)], error: null }) });
  await assert.rejects(reader({ ...scope, playerIds: [uuid(1)] }), /out-of-order/);
});

test('missing values in any stint keep the entire metric missing, while zero stays zero', async () => {
  for (const missing of [null, undefined, '', true, false, [], {}, -1]) {
    const { reader } = loadSeasonReader([stint(1), stint(2, 1, { team_code: 'CHI', points: missing, steals: 0 })]);
    const [row] = await reader({ ...scope, playerIds: [uuid(1)] });
    assert.equal(row.points, null);
    assert.equal(row.minutes_played, 480);
    assert.equal(row.steals, 10);
  }
  const { reader } = loadSeasonReader([stint(1, 1, { minutes_played: null })]);
  assert.equal((await reader({ ...scope, playerIds: [uuid(1)] })).length, 0);
  const zeroReader = loadSeasonReader([stint(1, 1, { steals: '0', three_point_field_goals_made: 0,
    three_point_field_goals_attempted: 0 })]).reader;
  const [zero] = await zeroReader({ ...scope, playerIds: [uuid(1)] });
  assert.equal(zero.steals, 0);
  assert.equal(zero.three_point_field_goals_attempted, 0);
});

test('real shared reader -> prototype adapter -> exact solver keeps trade context separate from rates', async () => {
  const records = Array.from({ length: 8 }, (_, i) => [stint(i * 2 + 1, i + 1),
    stint(i * 2 + 2, i + 1, { team_code: 'CHI', games_played: 50, games_started: 40,
      minutes_played: 1500, field_goals_made: 360, field_goals_attempted: 760,
      three_point_field_goals_made: 100, three_point_field_goals_attempted: 260,
      free_throws_made: 180, free_throws_attempted: 220, points: 1000 })]).flat();
  const { reader } = loadSeasonReader(records);
  const evidenceRows = await reader({ ...scope, playerIds: Array.from({ length: 8 }, (_, i) => uuid(i + 1)) });
  const pool = records.filter(row => row.team_code === 'MIN').map(row => ({ ...row,
    player_name: `Trade Player ${row.id}`, player_primary_position: 'G-F-C',
    listed_position: 'G-F-C', player_age: 25, team_name: 'Minnesota Timberwolves',
    source_name: 'basketball_reference', source_url: 'https://www.basketball-reference.com/leagues/NBA_2026_totals.html',
    league_points_per_36: 18,
  }));
  const dataset = createSupabaseNbaTeamDataset(pool, { team: 'MIN', season: 2026, seasonPhase: 'regular', seasonEvidenceRows: evidenceRows });
  assert.equal(dataset.players[0].games, 10, 'team membership remains selected-team context');
  assert.equal(dataset.players[0].points, 13);
  assert.equal(dataset.players[0].analytics.seasonTotals.games, 60);
  assert.equal(dataset.players[0].analytics.seasonTotals.points, 1130);
  assert.equal(Object.keys(dataset.players[0].analytics.seasonAdvanced).length, 0);
  const result = optimizeLineups(dataset.players, { mode: 'rotation', size: 8, alternatives: 1,
    minGames: 0, minMinutes: 0, weights: { points: 1 }, sourceScope: { seasonEndYear: 2026, seasonPhase: 'regular', team: 'MIN' },
    rotationOptions: { minMinutes: 30, maxMinutes: 30, minutePlan: 'openWhatIf', scoringBasis: 'per36', rateStability: 'sampleAdjusted',
      positionMinuteRequirements: { G: 96, F: 96, C: 48 } } });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(result.diagnostics.rotationRateStabilityEvidence.evidenceByMetric.points.matchingSeasonSamples, 8);
  assert.equal(result.best.rotation.totalMinutes, 240);
  assert.equal(dataset.players[0].analytics.seasonEvidence.completeness, 'imported-rows-only');
});
