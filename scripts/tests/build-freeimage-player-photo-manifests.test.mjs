import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  analyticsQueryPlan,
  parseArgs,
} from '../build-freeimage-player-photo-manifests.mjs';
import {
  PRO_SPORTS_ANALYTICS_WORKDIR,
  proSportsAnalyticsTarget,
} from '../lib/pro-sports-analytics-targets.mjs';

const ROOT = process.cwd();
const SQL_FILE = path.join(ROOT, 'outputs', 'test-freeimage-query.sql');

function projectRefIn(args) {
  const index = args.indexOf('--project-ref');
  return index < 0 ? null : args[index + 1];
}

test('MLB FreeImage manifest reads explicitly target Baseball analytics', () => {
  const plan = analyticsQueryPlan(parseArgs(['--sport', 'mlb']), SQL_FILE);

  assert.equal(plan.workdir, PRO_SPORTS_ANALYTICS_WORKDIR);
  assert.equal(plan.proSportsTarget, proSportsAnalyticsTarget('mlb'));
  assert.equal(projectRefIn(plan.args), proSportsAnalyticsTarget('mlb').projectRef);
});

test('NFL FreeImage manifest reads explicitly target Football analytics', () => {
  const plan = analyticsQueryPlan(parseArgs(['--sport', 'nfl']), SQL_FILE);

  assert.equal(plan.workdir, PRO_SPORTS_ANALYTICS_WORKDIR);
  assert.equal(plan.proSportsTarget, proSportsAnalyticsTarget('nfl'));
  assert.equal(projectRefIn(plan.args), proSportsAnalyticsTarget('nfl').projectRef);
});

test('NBA FreeImage manifest keeps its existing linked-project query path', () => {
  const plan = analyticsQueryPlan(parseArgs(['--sport', 'nba']), SQL_FILE);

  assert.equal(plan.workdir, path.join(ROOT, 'supabase-analytics'));
  assert.equal(plan.proSportsTarget, null);
  assert.equal(projectRefIn(plan.args), null);
  assert.deepEqual(plan.args.slice(0, 7), [
    '--yes', 'supabase@2.115.0', 'db', 'query', '--linked', '--workdir', path.join(ROOT, 'supabase-analytics'),
  ]);
});
