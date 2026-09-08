import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeScoutContexts,
  describeScoutOnOff,
  scoutContextDescriptor,
} from '../lib/scout-studio.mjs';
import {
  analyzeContextRows,
  analyzeGroupContextLens,
  analyzePlayerContextLens,
  contextDescriptor,
} from '../../tools/scout-studio/context-lens.js';
import {
  fixtureSource,
  rawContextMap,
  rawOnOffRow,
  rawSample,
  snapshot,
} from './fixtures/scout-studio-fixture.mjs';

const source = fixtureSource();
const roster = await source.roster('t0');

test('context descriptors keep only the published, human-readable groups', () => {
  assert.deepEqual(scoutContextDescriptor('all'), {
    key: 'all', group: 'all', label: 'All observed possessions', order: 0,
  });
  assert.equal(scoutContextDescriptor('clutch_v1').group, 'game_state');
  assert.equal(scoutContextDescriptor('clutch:unclassified').group, 'game_state');
  assert.equal(scoutContextDescriptor('secret:coefficient'), null);
  assert.equal(contextDescriptor('season:2024').label, 'Season: 2024');
  assert.equal(contextDescriptor('provider:rapm'), null);
});

test('context projection is sorted, sample-gated, and private-field safe', () => {
  const rows = describeScoutContexts({ ...rawContextMap(), 'secret:coefficient': rawSample() });
  assert.equal(rows[0].key, 'all');
  assert.ok(rows.some(row => row.key === 'season:2022'));
  assert.equal(rows.find(row => row.key === 'clutch_v1').group, 'game_state');
  assert.equal(rows.find(row => row.key === 'season:2022').status, 'observed');
  assert.doesNotMatch(JSON.stringify(rows), /private|coefficient|archivePath|rapm/);
  assert.throws(() => describeScoutContexts(rawContextMap(), { maxRows: 2 }), /bounded/);
  assert.throws(() => describeScoutContexts([]), /invalid/);
  const onOff = describeScoutOnOff(rawOnOffRow('private-player-a'));
  assert.equal(onOff.on.length, rows.length);
  assert.equal(onOff.off.length, rows.length);
  assert.doesNotMatch(JSON.stringify(onOff), /private|archivePath|rapm/);
});

test('group context analysis compares observed rows with an all-sample baseline', () => {
  const rows = describeScoutContexts(rawContextMap());
  const report = analyzeContextRows(rows);
  assert.equal(report.status, 'ready');
  assert.equal(report.baseline.netRating, 6);
  assert.equal(report.rows.find(row => row.key === 'season:2022').differenceFromAll.netRating, -1);
  assert.equal(report.rows.find(row => row.key === 'season:2025').differenceFromAll.netRating, 2);
  assert.ok(report.groups.includes('season'));
  assert.equal(analyzeGroupContextLens([]).status, 'unavailable');
  assert.equal(analyzeGroupContextLens([{ ...rows[0], status: 'insufficient_sample' }]).status, 'baseline_unavailable');
});

test('player context lens aligns on/off rows and computes descriptive differences', async () => {
  const payload = await source.playerContexts('t0', snapshot, 'p0');
  const report = analyzePlayerContextLens(roster, 'p0', payload);
  assert.equal(report.status, 'ready');
  assert.equal(report.player.name, 'Test Player 1');
  const all = report.rows.find(row => row.key === 'all');
  assert.equal(all.on.netRating, 6);
  assert.equal(all.off.netRating, 5);
  assert.equal(all.difference.netRating, 1);
  assert.equal(all.difference.defensiveRating, -1);
  assert.match(report.note, /no causal/);
  assert.doesNotMatch(JSON.stringify(report), /private|archivePath|rapm|coefficient/);
});

test('player context lens fails closed on scope, unsupported, duplicate, and low-sample rows', async () => {
  const payload = await source.playerContexts('t0', snapshot, 'p0');
  assert.throws(() => analyzePlayerContextLens(roster, 'p0', { ...payload, team: 't1' }), /does not match/);
  assert.throws(() => analyzePlayerContextLens(roster, 'p0', { ...payload, snapshot: 'stale' }), /does not match/);
  assert.throws(() => analyzePlayerContextLens(roster, 'p0', {
    ...payload, on: [...payload.on, { ...payload.on[0], key: 'provider:secret' }],
  }), /unsupported/);
  assert.throws(() => analyzePlayerContextLens(roster, 'p0', {
    ...payload, on: [...payload.on, payload.on[0]],
  }), /repeats/);
  const low = structuredClone(payload);
  low.on = low.on.map(row => row.key === 'all' ? { ...row, offensePossessions: 0 } : row);
  const lowReport = analyzePlayerContextLens(roster, 'p0', low);
  const lowAll = lowReport.rows.find(row => row.key === 'all');
  assert.equal(lowAll.on.status, 'insufficient_sample');
  assert.equal(lowAll.difference.netRating, null);
});

test('context analysis preserves missing sides and does not turn zero exposure into a rate', async () => {
  const payload = await source.playerContexts('t0', snapshot, 'p0');
  const trimmed = structuredClone(payload);
  trimmed.off = trimmed.off.filter(row => row.key !== 'season:2025');
  const report = analyzePlayerContextLens(roster, 'p0', trimmed);
  const season = report.rows.find(row => row.key === 'season:2025');
  assert.equal(season.off.status, 'unavailable');
  assert.equal(season.off.netRating, null);
  assert.equal(season.difference.netRating, null);
  const noBaseline = analyzeContextRows(report.rows.filter(row => row.key !== 'all').map(row => row.on));
  assert.equal(noBaseline.status, 'missing_baseline');
});
