import assert from 'node:assert/strict';
import test from 'node:test';
import {
  analyzeHealthReport,
  auditProSportsAnalytics,
  buildHealthSql,
  compactAuditReport,
  optionsFromArgs,
} from '../audit-pro-sports-analytics-health.mjs';

test('health options default to the requested historical range', () => {
  assert.deepEqual(optionsFromArgs([], new Date('2026-09-04T12:00:00Z')), {
    help: false,
    sports: ['mlb', 'nfl'],
    seasonStart: 1980,
    seasonEnd: 2026,
  });
  assert.throws(() => optionsFromArgs(['--sport', 'nba']), /mlb, nfl, or both/);
  assert.throws(() => optionsFromArgs(['--season-start', '2027', '--season-end', '2026']), /greater than or equal/);
});

test('health SQL stays scoped to the explicit sport project and rolls back', () => {
  const sql = buildHealthSql({ sport: 'nfl', seasonStart: 1980, seasonEnd: 2026 });
  assert.match(sql, /^\s*begin;/i);
  assert.match(sql, /public\.nfl_player_team_season_stats/i);
  assert.match(sql, /public\.mlb_players/i);
  assert.match(sql, /iuhjjwqfkohrrjqgpahh/i);
  assert.match(sql, /rollback;\s*$/i);
  assert.doesNotMatch(sql, /\bcommit\s*;/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|alter|drop|create)\b/i);
});

test('assessment separates historical gaps from current-season pending work', () => {
  const currentSeason = analyzeHealthReport({
    gaps: [{ season_year: 2026, stat_group: 'passing' }],
    integrity: { players: 1, stat_rows: 1, source_records: 1, duplicate_stat_key_groups: 0 },
  }, { currentYear: 2026 });
  assert.equal(currentSeason.status, 'current-season-pending');
  assert.equal(currentSeason.historicalGapCount, 0);
  assert.equal(currentSeason.nextAction.kind, 'current-season-source-or-cache-needed');

  const historical = analyzeHealthReport({
    gaps: [{ season_year: 2025, stat_group: 'passing' }],
    integrity: { players: 1, stat_rows: 1, source_records: 1, duplicate_stat_key_groups: 0 },
  }, { currentYear: 2026 });
  assert.equal(historical.status, 'attention');
  assert.equal(historical.nextAction.kind, 'authorized-historical-backfill-required');
});

test('assessment escalates integrity failures without confusing row counts for violations', () => {
  const report = analyzeHealthReport({
    gaps: [],
    integrity: {
      players: 13672,
      stat_rows: 134988,
      source_records: 134988,
      memberless_players: 1,
      duplicate_stat_key_groups: 0,
      stat_rows_without_source_record: 0,
    },
  }, { currentYear: 2026 });
  assert.equal(report.status, 'attention');
  assert.deepEqual(report.integrityFailures, [{ key: 'memberless_players', count: 1 }]);
});

test('combined audit has an attention status when either isolated sport needs it', async () => {
  const report = await auditProSportsAnalytics({
    sports: ['mlb', 'nfl'], seasonStart: 1980, seasonEnd: 2026,
  }, {
    now: new Date('2026-09-04T12:00:00Z'),
    query: async (sport) => ({
      gaps: sport === 'mlb' ? [] : [{ season_year: 2025, stat_group: 'passing' }],
      integrity: { players: 1, stat_rows: 1, source_records: 1, duplicate_stat_key_groups: 0 },
    }),
  });
  assert.equal(report.status, 'attention');
  assert.equal(report.sports.mlb.assessment.status, 'healthy');
  assert.equal(report.sports.nfl.assessment.status, 'attention');
});

test('compact CLI report preserves decisions but omits every covered season-group', () => {
  const compact = compactAuditReport({
    mode: 'read-only', checkedAt: '2026-09-04T00:00:00.000Z', seasonStart: 1980, seasonEnd: 2026, status: 'healthy',
    sports: {
      mlb: {
        sport: 'mlb', league_code: 'MLB', target_project_ref: 'baseball-ref',
        coverage_summary: { expected_season_groups: 94 }, coverage: [{ season_year: 1980, stat_group: 'batting' }],
        gaps: [], import_run_statuses: { completed: 94 }, integrity: {}, assessment: { status: 'healthy' },
      },
    },
  });
  assert.equal(compact.sports.mlb.coverageSummary.expected_season_groups, 94);
  assert.equal('coverage' in compact.sports.mlb, false);
});
