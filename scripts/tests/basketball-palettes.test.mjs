import test from 'node:test';
import assert from 'node:assert/strict';
import { palettes, paletteForTeam, themeFor, auditPalettes } from '../../tools/basketball-palettes.js';

test('all 30 teams plus DJHC have unique palette IDs', () => {
  assert.equal(palettes.length, 31);
  assert.equal(new Set(palettes.map(p => p.id)).size, 31);
});
test('all 62 palette/mode combinations meet text, control and focus thresholds', () => {
  const audit = auditPalettes();
  assert.equal(audit.length, 62);
  assert.deepEqual(audit.filter(row => !row.passed), []);
});
test('supported source aliases map explicitly; unknown historical codes keep DJHC', () => {
  for (const p of palettes) assert.equal(paletteForTeam(` ${p.id.toUpperCase()} `).id, p.id);
  for (const [source, target] of [['BRK','bkn'],['CHO','cha'],['PHO','phx']]) assert.equal(paletteForTeam(source).id, target);
  for (const source of ['', null, 'SEA', 'NJN', 'VAN', 'NOH', 'NOT_A_TEAM']) assert.equal(paletteForTeam(source).id, 'djhc');
});
test('theme derivation never mutates the seed palette', () => {
  const before = JSON.stringify(palettes);
  for (const p of palettes) { themeFor(p); themeFor(p, 'light'); }
  assert.equal(JSON.stringify(palettes), before);
});
