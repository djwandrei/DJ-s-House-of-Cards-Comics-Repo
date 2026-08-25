import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAnalyticsTarget, optionsFromArgs } from '../check-nba-analytics-target.mjs';

test('analytics readiness parser keeps the check read-only and scoped', () => {
  assert.deepEqual(optionsFromArgs(['--scope', 'base', '--season-end', '2026']), {
    help: false,
    scope: 'base',
    seasonEndYear: 2026,
  });
  assert.throws(() => optionsFromArgs(['--scope', 'all']), /base or pbp/);
  assert.throws(() => optionsFromArgs(['--write']), /Unknown option/);
});

test('base readiness checks only target the explicitly named analytics project', async () => {
  const requests = [];
  const report = await checkAnalyticsTarget({
    projectUrl: 'https://analytics-project.supabase.co',
    expectedProjectUrl: 'https://analytics-project.supabase.co',
    serviceRoleKey: 'test-service-role',
    scope: 'base',
    seasonEndYear: 2025,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true, status: 200, text: async () => '[]' };
    },
  });
  assert.equal(report.mode, 'read-only');
  assert.equal(report.ready, true);
  assert.equal(report.checks.length, 10);
  assert.ok(requests.every((request) => request.options.method === 'GET'));
  assert.ok(requests.every((request) => request.url.startsWith('https://analytics-project.supabase.co/rest/v1/')));
});

test('PBP readiness reports failed schema checks without writing', async () => {
  const report = await checkAnalyticsTarget({
    projectUrl: 'https://analytics-project.supabase.co',
    expectedProjectUrl: 'https://analytics-project.supabase.co',
    serviceRoleKey: 'test-service-role',
    scope: 'pbp',
    seasonEndYear: 2025,
    fetchImpl: async (url) => ({
      ok: !String(url).includes('nba_game_possessions'),
      status: String(url).includes('nba_game_possessions') ? 404 : 200,
      text: async () => '[]',
    }),
  });
  assert.equal(report.ready, false);
  assert.deepEqual(report.checks.find((check) => check.name === 'nba_game_possessions'), {
    name: 'nba_game_possessions',
    method: 'GET',
    route: '/rest/v1/nba_game_possessions?select=id&limit=1',
    ok: false,
    status: 404,
    responseKind: 'array',
  });
});
